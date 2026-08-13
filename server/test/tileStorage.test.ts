/**
 * Tile member storage and garbage collection (#72).
 *
 * A mistake here deletes bytes a published venue serves, so these tests are
 * deliberately about what collection must *not* touch: a member two versions
 * share, a draft's attachment, an archived version's scene, and every blob class
 * that is not tile content at all.
 */
import { createHash } from "node:crypto";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachPackageToVersion,
  collectTileBlobs,
  discardPackage,
  packageIsReferenced,
} from "../src/tiles/storage";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { glbFixture, tilesetFixture } from "../../tests/fixtures/tileFixtures";

afterEach(cleanupTestApps);

async function packageZip(entries: [string, Uint8Array][]): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  for (const [path, bytes] of entries) {
    await writer.add(path, new Uint8ArrayReader(bytes));
  }
  return Buffer.from(await writer.close());
}

function multipart(bytes: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----kirikoTileStorageBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="tiles.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function makeVenue(app: FastifyInstance, cookie: string, name: string): Promise<number> {
  const created = await app.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie },
    payload: { name },
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ venue: { id: number } }>().venue.id;
}

/** Ingest a package and return its id plus the member hashes it stored. */
async function ingestPackage(
  app: FastifyInstance,
  cookie: string,
  venueId: number,
  marker: number,
): Promise<{ packageId: number; hashes: string[] }> {
  const zip = await packageZip([
    ["tileset.json", tilesetFixture("content/model.glb")],
    ["content/model.glb", glbFixture(marker)],
  ]);
  const upload = multipart(zip);
  const response = await app.inject({
    method: "POST",
    url: `/api/venues/${venueId}/tiles/inspect`,
    headers: { cookie, ...upload.headers },
    payload: upload.payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ packageId: number; members: { hash: string }[] }>();
  return { packageId: body.packageId, hashes: body.members.map((member) => member.hash) };
}

/** Insert a version row directly: publishing a real bundle is another suite's job. */
function makeVersion(app: FastifyInstance, venueId: number, seq: number, status: string): number {
  const inserted = app.db
    .prepare(
      `INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      venueId,
      seq,
      createHash("sha256").update(`${venueId}/${seq}/${status}`).digest("hex"),
      "0".repeat(64),
      status,
    );
  return Number(inserted.lastInsertRowid);
}

describe("tile member storage and collection", () => {
  it("keeps a member two versions share until both are gone", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Shared");

    // One package, two versions rendering it — the same bytes, stored once.
    const { packageId, hashes } = await ingestPackage(app, cookie, venueId, 1);
    const first = makeVersion(app, venueId, 1, "published");
    const second = makeVersion(app, venueId, 2, "published");
    attachPackageToVersion(app.db, first, packageId);
    attachPackageToVersion(app.db, second, packageId);

    // Nothing is collectable: the package record and both versions reference it.
    expect(collectTileBlobs(app.db, app.blobs).released).toBe(0);
    for (const hash of hashes) {
      expect(app.blobs.has(hash), `${hash} survives`).toBe(true);
    }

    // Dropping one version changes nothing.
    app.db.prepare("DELETE FROM versions WHERE id = ?").run(first);
    expect(packageIsReferenced(app.db, packageId)).toBe(true);
    expect(collectTileBlobs(app.db, app.blobs).released).toBe(0);
    for (const hash of hashes) {
      expect(app.blobs.has(hash)).toBe(true);
    }

    // Dropping the second leaves the package unreferenced by any version, but
    // the package record itself still holds its members.
    app.db.prepare("DELETE FROM versions WHERE id = ?").run(second);
    expect(packageIsReferenced(app.db, packageId)).toBe(false);
    expect(collectTileBlobs(app.db, app.blobs).released).toBe(0);

    // Discarding the record is what releases them.
    expect(discardPackage(app.db, packageId)).toBe(true);
    const report = collectTileBlobs(app.db, app.blobs);
    expect(report.released).toBeGreaterThan(0);
    for (const hash of hashes) {
      expect(app.blobs.has(hash), `${hash} released`).toBe(false);
    }
    expect(report.bytes).toBeGreaterThan(0);
  });

  it("refuses to discard a package a version still renders", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Referenced");

    const { packageId, hashes } = await ingestPackage(app, cookie, venueId, 2);
    const versionId = makeVersion(app, venueId, 1, "published");
    attachPackageToVersion(app.db, versionId, packageId);

    // A published version's scene is immutable: its package cannot be dropped.
    expect(discardPackage(app.db, packageId)).toBe(false);
    expect(collectTileBlobs(app.db, app.blobs).released).toBe(0);
    for (const hash of hashes) {
      expect(app.blobs.has(hash)).toBe(true);
    }
  });

  it("keeps an archived version's members", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Archived");

    const { packageId, hashes } = await ingestPackage(app, cookie, venueId, 3);
    const versionId = makeVersion(app, venueId, 1, "archived");
    attachPackageToVersion(app.db, versionId, packageId);

    // An archived version still exists, so its assets still exist (#30 §6).
    expect(collectTileBlobs(app.db, app.blobs).released).toBe(0);
    for (const hash of hashes) {
      expect(app.blobs.has(hash)).toBe(true);
    }
    expect(discardPackage(app.db, packageId)).toBe(false);
  });

  it("keeps a member referenced only by a draft, and releases it with the draft", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Draft");

    const { packageId, hashes } = await ingestPackage(app, cookie, venueId, 4);
    const draft = makeVersion(app, venueId, 1, "draft");
    attachPackageToVersion(app.db, draft, packageId);

    expect(collectTileBlobs(app.db, app.blobs).released).toBe(0);

    // Discarding the draft and then the package record releases the bytes.
    app.db.prepare("DELETE FROM versions WHERE id = ?").run(draft);
    expect(discardPackage(app.db, packageId)).toBe(true);
    expect(collectTileBlobs(app.db, app.blobs).released).toBe(hashes.length + 1);
    for (const hash of hashes) {
      expect(app.blobs.has(hash)).toBe(false);
    }
  });

  it("releases exactly the members no other venue references", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const shared = await makeVenue(app, cookie, "GC Venue A");
    const other = await makeVenue(app, cookie, "GC Venue B");

    // Both venues ingest byte-identical packages: one copy on disk, two records.
    const a = await ingestPackage(app, cookie, shared, 5);
    const b = await ingestPackage(app, cookie, other, 5);
    expect(b.hashes).toEqual(a.hashes);

    // Deleting one venue cascades its package record away. Its members are the
    // other venue's members too, so they stay; only its own archive — which
    // differs because ZIP records a modification time — is released.
    app.db.prepare("DELETE FROM venues WHERE id = ?").run(shared);
    const partial = collectTileBlobs(app.db, app.blobs);
    for (const hash of a.hashes) {
      expect(partial.hashes, `${hash} still needed by the other venue`).not.toContain(hash);
      expect(app.blobs.has(hash)).toBe(true);
    }

    // Deleting the last venue that references them releases them.
    app.db.prepare("DELETE FROM venues WHERE id = ?").run(other);
    const report = collectTileBlobs(app.db, app.blobs);
    expect(report.released).toBeGreaterThan(0);
    for (const hash of a.hashes) {
      expect(app.blobs.has(hash)).toBe(false);
    }
  });

  it("never touches a blob that is not registered tile content", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Foreign");

    // A blob from another class entirely, referenced by nothing at all: exactly
    // what an age heuristic would sweep, and exactly what collection must leave
    // alone. Bundles, GDB sources, and network exports all look like this.
    const foreign = app.blobs.put(Buffer.from("a bundle, or a GDB source, or anything else"));
    app.db
      .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
      .run(foreign.hash, foreign.size);

    const { packageId } = await ingestPackage(app, cookie, venueId, 6);
    expect(discardPackage(app.db, packageId)).toBe(true);
    const report = collectTileBlobs(app.db, app.blobs);

    expect(report.hashes).not.toContain(foreign.hash);
    expect(app.blobs.has(foreign.hash), "a non-tile blob survives a tile sweep").toBe(true);
  });

  it("keeps a member whose bytes another version needs as a bundle", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Crossclass");

    const { packageId, hashes } = await ingestPackage(app, cookie, venueId, 7);
    // Content addressing means two classes can land on the same bytes. Point a
    // version's bundle at a member hash and the sweep must leave it alone.
    const shared = hashes[0]!;
    const versionId = makeVersion(app, venueId, 1, "published");
    app.db.prepare("UPDATE versions SET bundle_hash = ? WHERE id = ?").run(shared, versionId);

    expect(discardPackage(app.db, packageId)).toBe(true);
    const report = collectTileBlobs(app.db, app.blobs);
    expect(report.hashes).not.toContain(shared);
    expect(app.blobs.has(shared)).toBe(true);
  });

  it("does not collect a blob whose registration has not happened yet", async () => {
    const { app } = await makeTestApp();
    await loginCookie(app);

    // Ingestion stores bytes before registering them. A sweep in that window
    // must be a no-op: an unregistered blob is not a candidate, which is what
    // makes collection safe to run concurrently with an upload.
    const inFlight = app.blobs.put(Buffer.from("member bytes mid-ingest"));
    app.db
      .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
      .run(inFlight.hash, inFlight.size);

    const report = collectTileBlobs(app.db, app.blobs);
    expect(report.hashes).not.toContain(inFlight.hash);
    expect(app.blobs.has(inFlight.hash)).toBe(true);
  });

  it("never leaves a registered blob with nothing referencing it", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Atomic");

    // Registration and reference commit together, so this query — "tile content
    // that nothing needs" — is the state a concurrent sweep would collect. It
    // must be empty at every commit boundary, not merely at the end of a
    // successful upload.
    const orphanedRegistrations = (): number => {
      const row = app.db
        .prepare(
          `SELECT COUNT(*) AS count FROM tile_blobs
           WHERE hash NOT IN (SELECT hash FROM tile_package_members)
             AND hash NOT IN (SELECT source_hash FROM tile_packages)`,
        )
        .get() as { count: number };
      return row.count;
    };

    await ingestPackage(app, cookie, venueId, 9);
    expect(orphanedRegistrations()).toBe(0);

    // Now make the reference-recording step fail after the bytes are stored, the
    // way a disk error or a constraint violation would. If registration were its
    // own transaction, the rows would survive the rollback and the next sweep
    // would delete a blob a retry is about to reuse.
    app.db.exec(
      `CREATE TRIGGER reject_members BEFORE INSERT ON tile_package_members
       BEGIN SELECT RAISE(ABORT, 'simulated member insert failure'); END`,
    );
    try {
      const zip = await packageZip([
        ["tileset.json", tilesetFixture("content/model.glb")],
        ["content/model.glb", glbFixture(12)],
      ]);
      const upload = multipart(zip);
      const failed = await app.inject({
        method: "POST",
        url: `/api/venues/${venueId}/tiles/inspect`,
        headers: { cookie, ...upload.headers },
        payload: upload.payload,
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      app.db.exec("DROP TRIGGER reject_members");
    }

    // The failed upload left no registration behind, so a sweep now has nothing
    // to collect and the earlier package is untouched.
    expect(orphanedRegistrations()).toBe(0);
    expect(collectTileBlobs(app.db, app.blobs).released).toBe(0);
  });

  it("discards a package through the route, and refuses while a version needs it", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Route");

    const { packageId, hashes } = await ingestPackage(app, cookie, venueId, 10);
    const versionId = makeVersion(app, venueId, 1, "published");
    attachPackageToVersion(app.db, versionId, packageId);

    const refused = await app.inject({
      method: "DELETE",
      url: `/api/venues/${venueId}/tiles/${packageId}`,
      headers: { cookie },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe("package_in_use");
    for (const hash of hashes) {
      expect(app.blobs.has(hash)).toBe(true);
    }

    // Once no version references it, discarding releases the bytes and says so.
    app.db.prepare("DELETE FROM versions WHERE id = ?").run(versionId);
    const discarded = await app.inject({
      method: "DELETE",
      url: `/api/venues/${venueId}/tiles/${packageId}`,
      headers: { cookie },
    });
    expect(discarded.statusCode, discarded.body).toBe(200);
    const report = discarded.json<{ released: number; bytes: number }>();
    expect(report.released).toBe(hashes.length + 1);
    expect(report.bytes).toBeGreaterThan(0);
    for (const hash of hashes) {
      expect(app.blobs.has(hash)).toBe(false);
    }

    // A viewer cannot discard: the route is producer-gated.
    const viewerRefused = await app.inject({
      method: "DELETE",
      url: `/api/venues/${venueId}/tiles/${packageId}`,
    });
    expect(viewerRefused.statusCode).toBe(401);
  });

  it("releases a deleted venue's members through the delete route", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Venue Delete");

    const { hashes } = await ingestPackage(app, cookie, venueId, 11);
    for (const hash of hashes) {
      expect(app.blobs.has(hash)).toBe(true);
    }

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/venues/${venueId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);

    // Deletion is when the reference goes, so it is when the bytes go: no timer
    // in between leaving a deleted venue's geometry on disk.
    for (const hash of hashes) {
      expect(app.blobs.has(hash), `${hash} released with the venue`).toBe(false);
    }
    expect(app.db.prepare("SELECT COUNT(*) AS count FROM tile_blobs").get()).toMatchObject({
      count: 0,
    });
  });

  it("reports what it released, and is idempotent", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await makeVenue(app, cookie, "GC Report");

    const { packageId, hashes } = await ingestPackage(app, cookie, venueId, 8);
    expect(discardPackage(app.db, packageId)).toBe(true);

    const first = collectTileBlobs(app.db, app.blobs);
    // Members plus the package archive itself.
    expect(first.released).toBe(hashes.length + 1);
    expect(first.hashes).toEqual([...first.hashes].sort());
    expect(first.bytes).toBeGreaterThan(0);

    // A second sweep finds nothing: the registry no longer lists them.
    const second = collectTileBlobs(app.db, app.blobs);
    expect(second).toEqual({ released: 0, bytes: 0, hashes: [] });
  });
});
