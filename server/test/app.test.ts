import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import { buildApp } from "../src/app";
import { BlobStore } from "../src/blobs/store";
import { openDb } from "../src/db/db";
import { migrate } from "../src/db/migrate";
import type { CompileVenueMetadata } from "../src/core/native";
import { CoreCompileError } from "../src/core/native";
import { recompileLegacyPublished } from "../src/core/recompileLegacy";
import {
  cleanupTestApps,
  loginCookie,
  makeTestApp,
  newTestPublicVersionId,
  TEST_PASSWORD,
  TEST_USER,
} from "./helpers";

afterEach(cleanupTestApps);

describe("app skeleton", () => {
  it("answers healthz and serves an OpenAPI document", async () => {
    const { app } = await makeTestApp();
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const spec = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().openapi).toMatch(/^3\./);
  });

  it("runs migrations idempotently", async () => {
    const { app, dataDir } = await makeTestApp();
    const db = openDb(dataDir);
    migrate(db); // second run must be a no-op, not an error
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tables = rows.map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["blobs", "jobs", "sessions", "tenants", "users", "venues", "versions"]),
    );
    db.close();
    await app.close();
  });
});

// -- Unit-level coverage of `recompileLegacyPublished` in isolation, using
// -- an injected fake compiler so ordering/failure assertions are exact and
// -- don't depend on real native compile timing.

function seedVenue(db: Database.Database, slug: string, name: string): number {
  const info = db.prepare("INSERT INTO venues (tenant_id, slug, name) VALUES (1, ?, ?)").run(slug, name);
  return Number(info.lastInsertRowid);
}

/** Inserts a Phase One-style published row with a source-alias bundle hash. */
function seedLegacyPublishedVersion(
  db: Database.Database,
  blobs: BlobStore,
  venueId: number,
  seq: number,
  sourceBytes: Uint8Array,
): number {
  const { hash, size } = blobs.put(sourceBytes);
  db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(hash, size);
  const info = db
    .prepare(
      `INSERT INTO versions (
         venue_id, seq, public_id, source_blob_hash, bundle_hash, status, stats_json
       ) VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    )
    .run(venueId, seq, newTestPublicVersionId(), hash, hash, JSON.stringify({ levels: 1, features: 1 }));
  return Number(info.lastInsertRowid);
}

interface FakeCompileCall {
  datasetId: string;
  version: number;
}

function withTempDataDir<T>(prefix: string, fn: (dataDir: string) => Promise<T>): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  return fn(dataDir).finally(() => rmSync(dataDir, { recursive: true, force: true }));
}

describe("recompileLegacyPublished", () => {
  it("recompiles legacy rows sequentially in (venue_id, seq) order, not insertion order", () =>
    withTempDataDir("kiriko-legacy-order-", async (dataDir) => {
      const db = openDb(dataDir);
      migrate(db);
      const blobs = new BlobStore(dataDir);
      const venueA = seedVenue(db, "venue-a", "Venue A");
      const venueB = seedVenue(db, "venue-b", "Venue B");
      // Inserted out of (venue_id, seq) order on purpose: ordering must come
      // from the query, not from insertion order.
      seedLegacyPublishedVersion(db, blobs, venueB, 1, new TextEncoder().encode("venue-b-1"));
      seedLegacyPublishedVersion(db, blobs, venueA, 2, new TextEncoder().encode("venue-a-2"));
      seedLegacyPublishedVersion(db, blobs, venueA, 1, new TextEncoder().encode("venue-a-1"));

      const calls: FakeCompileCall[] = [];
      const compile = async (source: Buffer, metadata: CompileVenueMetadata) => {
        calls.push({ datasetId: metadata.datasetId, version: metadata.version });
        return {
          bundle: Buffer.from(`kvb:${metadata.datasetId}:${metadata.version}:${source.byteLength}`),
          stats: { levels: 1, features: source.byteLength },
          warnings: [],
        };
      };

      await recompileLegacyPublished(db, blobs, () => {}, compile);

      expect(calls).toEqual([
        { datasetId: "default/venue-a", version: 1 },
        { datasetId: "default/venue-a", version: 2 },
        { datasetId: "default/venue-b", version: 1 },
      ]);

      const rows = db
        .prepare("SELECT source_blob_hash AS sourceHash, bundle_hash AS bundleHash FROM versions ORDER BY id")
        .all() as { sourceHash: string; bundleHash: string }[];
      for (const row of rows) {
        expect(row.bundleHash).not.toBe(row.sourceHash);
      }
      db.close();
    }));

  it("fails closed on the first row that cannot compile: logs its exact version id and leaves it unchanged", () =>
    withTempDataDir("kiriko-legacy-fail-", async (dataDir) => {
      const db = openDb(dataDir);
      migrate(db);
      const blobs = new BlobStore(dataDir);
      const venue = seedVenue(db, "venue-fails", "Venue Fails");
      const okId = seedLegacyPublishedVersion(db, blobs, venue, 1, new TextEncoder().encode("ok-source"));
      const failId = seedLegacyPublishedVersion(db, blobs, venue, 2, new TextEncoder().encode("bad-source"));

      const failBefore = db
        .prepare("SELECT bundle_hash AS bundleHash, source_blob_hash AS sourceHash, status FROM versions WHERE id = ?")
        .get(failId);

      const compile = async (_source: Buffer, metadata: CompileVenueMetadata) => {
        if (metadata.version === 2) {
          throw new CoreCompileError("unsupported_file", "unsupported_file");
        }
        return { bundle: Buffer.from(`kvb:${metadata.version}`), stats: { levels: 1, features: 1 }, warnings: [] };
      };

      const logs: string[] = [];
      await expect(recompileLegacyPublished(db, blobs, (message) => logs.push(message), compile)).rejects.toThrow();

      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`version ${failId}`);

      const okAfter = db.prepare("SELECT bundle_hash AS bundleHash FROM versions WHERE id = ?").get(okId) as {
        bundleHash: string;
      };
      expect(okAfter.bundleHash).not.toBe("ok-source");

      const failAfter = db
        .prepare("SELECT bundle_hash AS bundleHash, source_blob_hash AS sourceHash, status FROM versions WHERE id = ?")
        .get(failId);
      expect(failAfter).toEqual(failBefore);
      db.close();
    }));

  it("does not update a replacement legacy row that reuses every numeric and bundle identity", () =>
    withTempDataDir("kiriko-legacy-stale-", async (dataDir) => {
      const db = openDb(dataDir);
      migrate(db);
      const blobs = new BlobStore(dataDir);
      const venueId = seedVenue(db, "legacy-stale", "Legacy Stale");
      const versionId = seedLegacyPublishedVersion(db, blobs, venueId, 1, new TextEncoder().encode("source"));
      const original = db
        .prepare(
          `SELECT public_id AS publicId, source_blob_hash AS sourceHash,
                  bundle_hash AS bundleHash, stats_json AS statsJson
           FROM versions WHERE id = ?`,
        )
        .get(versionId) as { publicId: string; sourceHash: string; bundleHash: string; statsJson: string };

      let resolveCompile!: (value: {
        bundle: Buffer;
        stats: { levels: number; features: number };
        warnings: [];
      }) => void;
      const deferred = new Promise<{
        bundle: Buffer;
        stats: { levels: number; features: number };
        warnings: [];
      }>((resolve) => {
        resolveCompile = resolve;
      });
      const logs: string[] = [];
      const backfill = recompileLegacyPublished(
        db,
        blobs,
        (message) => logs.push(message),
        async () => deferred,
      );

      db.prepare("DELETE FROM venues WHERE id = ?").run(venueId);
      const replacementVenueId = seedVenue(db, "legacy-stale", "Legacy Stale");
      expect(replacementVenueId).toBe(venueId);
      const replacementPublicId = newTestPublicVersionId();
      const replacement = db
        .prepare(
          `INSERT INTO versions (
             venue_id, seq, public_id, source_blob_hash, bundle_hash, status, stats_json
           ) VALUES (?, 1, ?, ?, ?, 'published', ?)`,
        )
        .run(replacementVenueId, replacementPublicId, original.sourceHash, original.bundleHash, original.statsJson);
      expect(Number(replacement.lastInsertRowid)).toBe(versionId);
      expect(replacementPublicId).not.toBe(original.publicId);

      const replacementBefore = db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId);
      resolveCompile({
        bundle: Buffer.from("replacement-guard"),
        stats: { levels: 9, features: 99 },
        warnings: [],
      });

      await expect(backfill).rejects.toThrow();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`version ${versionId}`);
      expect(db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId)).toEqual(replacementBefore);
      db.close();
    }));
});

describe("app startup: durable job recovery", () => {
  it("replays a queued publication from the same dataDir once and leaves no stranded drafts after reopen", () =>
    withTempDataDir("kiriko-queued-recovery-", async (dataDir) => {
      const config = {
        dataDir,
        sessionTtlDays: 30,
        secureCookies: false,
        issueSseMaxConnections: 512,
        issueSseMaxPerVersion: 128,
        bootstrapUser: TEST_USER,
        bootstrapPassword: TEST_PASSWORD,
      };
      let app = await buildApp(config);
      const cookie = await loginCookie(app);
      const venue = (
        await app.inject({ method: "POST", url: "/api/venues", headers: { cookie }, payload: { name: "Recovered Venue" } })
      ).json().venue as { id: number };
      const source = await buildMinimalImdfZip();
      const blob = app.blobs.put(source);
      app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(blob.hash, blob.size);
      const version = app.db
        .prepare("INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')")
        .run(venue.id, newTestPublicVersionId(), blob.hash);
      const versionId = Number(version.lastInsertRowid);
      app.db.prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('recover-me', 'publish_imdf', ?, ?)").run(
        versionId,
        JSON.stringify({ versionId }),
      );
      await app.close();

      app = await buildApp(config);
      await app.queue.idle();
      const recovered = app.db
        .prepare(
          `SELECT j.status AS jobStatus, j.updated_at AS updatedAt, v.status AS versionStatus
           FROM jobs j JOIN versions v ON v.id = j.version_id
           WHERE j.id = 'recover-me'`,
        )
        .get() as { jobStatus: string; updatedAt: string; versionStatus: string };
      expect(recovered).toMatchObject({ jobStatus: "done", versionStatus: "published" });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get()).toEqual({ n: 0 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE status = 'draft'").get()).toEqual({ n: 0 });
      await app.close();

      app = await buildApp(config);
      await app.queue.idle();
      expect(
        app.db.prepare("SELECT status, updated_at AS updatedAt FROM jobs WHERE id = 'recover-me'").get(),
      ).toEqual({ status: "done", updatedAt: recovered.updatedAt });
      await app.close();
    }));
});


// -- Integration-level coverage through the real `buildApp` wiring: proves
// -- the backfill actually runs before routes exist (a rejected `buildApp`
// -- promise never yields a listenable app) and that it is fail-closed
// -- end-to-end against a real compiled bundle and a real corrupted source.

async function publishZip(
  app: FastifyInstance,
  cookie: string,
  venueId: number,
  zip: Uint8Array,
): Promise<void> {
  const boundary = "----kirikoAppTestBoundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    Buffer.from(zip),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  await app.inject({
    method: "POST",
    url: `/api/venues/${venueId}/versions`,
    headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  await app.queue.idle();
}

describe("app startup: legacy bundle backfill", () => {
  it("recompiles an aliased row before routes accept traffic, and fails startup without mutating a row that cannot compile", () =>
    withTempDataDir("kiriko-legacy-app-", async (dataDir) => {
      const config = {
        dataDir,
        sessionTtlDays: 30,
        secureCookies: false,
        issueSseMaxConnections: 512,
        issueSseMaxPerVersion: 128,
        bootstrapUser: TEST_USER,
        bootstrapPassword: TEST_PASSWORD,
      };
      const app = await buildApp(config);
      const cookie = await loginCookie(app);

      const venueA = (
        await app.inject({ method: "POST", url: "/api/venues", headers: { cookie }, payload: { name: "Legacy A" } })
      ).json().venue as { id: number };
      const venueB = (
        await app.inject({ method: "POST", url: "/api/venues", headers: { cookie }, payload: { name: "Legacy B" } })
      ).json().venue as { id: number };

      await publishZip(app, cookie, venueA.id, await buildMinimalImdfZip());
      await publishZip(app, cookie, venueB.id, await buildMinimalImdfZip({ extraEntries: { "note.txt": "b" } }));

      // Simulate the pre-Task-5 publish runner's alias for every row.
      app.db.prepare("UPDATE versions SET bundle_hash = source_blob_hash").run();

      const before = app.db
        .prepare(
          "SELECT id, venue_id AS venueId, bundle_hash AS bundleHash, source_blob_hash AS sourceHash FROM versions ORDER BY venue_id ASC",
        )
        .all() as { id: number; venueId: number; bundleHash: string; sourceHash: string }[];
      expect(before).toHaveLength(2);
      expect(before[0]!.venueId).toBeLessThan(before[1]!.venueId);

      // Corrupt only the higher-venue_id row's retained source bytes, so
      // recompiling it fails deterministically while the first row's
      // source is still a valid archive.
      writeFileSync(app.blobs.path(before[1]!.sourceHash), "not a zip");

      await app.close();

      await expect(buildApp(config)).rejects.toThrow();

      const db = openDb(dataDir);
      const after = db
        .prepare("SELECT id, bundle_hash AS bundleHash, source_blob_hash AS sourceHash FROM versions ORDER BY venue_id ASC")
        .all() as { id: number; bundleHash: string; sourceHash: string }[];
      // Earlier venue's row was recompiled: bundle_hash now differs from source.
      expect(after[0]!.bundleHash).not.toBe(after[0]!.sourceHash);
      // Failing row is left exactly as it was before the restart attempt.
      expect(after[1]!.bundleHash).toBe(before[1]!.bundleHash);
      expect(after[1]!.bundleHash).toBe(after[1]!.sourceHash);
      db.close();
    }));
});
