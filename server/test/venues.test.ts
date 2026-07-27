import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { deleteVenue } from "../src/venues/service";
import {
  cleanupTestApps,
  loginCookie,
  makeTestApp,
  TEST_PASSWORD,
  TEST_USER,
} from "./helpers";

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve(value?: T | PromiseLike<T>): void;
      reject(reason?: unknown): void;
    };
  }
}

afterEach(cleanupTestApps);

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures");
const LEVEL_ID = "b1000001-0000-4000-8000-0000000000b1";

function putFixtureBundle(app: FastifyInstance): string {
  const blob = app.blobs.put(readFileSync(join(FIXTURES_DIR, "minimal.kvb")));
  app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(blob.hash, blob.size);
  return blob.hash;
}

function createPayload() {
  return {
    requestId: randomUUID(),
    bodyMarkdown: "Lifecycle issue",
    anchor: { levelId: LEVEL_ID, longitude: 139.7, latitude: 35.68 },
  };
}

interface LiveResponse {
  response: IncomingMessage;
  text: string;
  ended: boolean;
  waitForText(expected: string): Promise<void>;
  waitForEnd(): Promise<void>;
  destroy(): void;
}

function connect(port: number, path: string): Promise<LiveResponse> {
  const connected = Promise.withResolvers<LiveResponse>();
  const request = get(`http://127.0.0.1:${port}${path}`, (response) => {
    response.setEncoding("utf8");
    const live: LiveResponse = {
      response,
      text: "",
      ended: false,
      waitForText(expected) {
        if (live.text.includes(expected)) return Promise.resolve();
        const waiting = Promise.withResolvers<void>();
        const onData = () => {
          if (live.text.includes(expected)) {
            cleanup();
            waiting.resolve();
          }
        };
        const onEnd = () => {
          cleanup();
          waiting.reject(new Error(`stream ended before ${expected}`));
        };
        const cleanup = () => {
          response.off("data", onData);
          response.off("end", onEnd);
        };
        response.on("data", onData);
        response.on("end", onEnd);
        return waiting.promise;
      },
      waitForEnd() {
        if (live.ended || response.destroyed) return Promise.resolve();
        const waiting = Promise.withResolvers<void>();
        response.once("end", waiting.resolve);
        response.once("error", waiting.reject);
        return waiting.promise;
      },
      destroy() {
        response.destroy();
      },
    };
    response.on("data", (chunk: string) => {
      live.text += chunk;
    });
    response.on("end", () => {
      live.ended = true;
    });
    connected.resolve(live);
  });
  request.once("error", connected.reject);
  return connected.promise;
}

describe("venues", () => {
  it("requires a session", async () => {
    const { app } = await makeTestApp();
    const list = await app.inject({ method: "GET", url: "/api/venues" });
    expect(list.statusCode).toBe(401);
    const create = await app.inject({
      method: "POST",
      url: "/api/venues",
      payload: { name: "No Session" },
    });
    expect(create.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: "/api/venues/1" });
    expect(del.statusCode).toBe(401);
  });

  it("creates with slugs, lists, and deletes", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "Shinjuku Station 構内図" },
    });
    expect(created.statusCode).toBe(201);
    const venue = created.json().venue;
    expect(venue.slug).toBe("shinjuku-station");

    // Same name → suffixed slug, not a 500.
    const again = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "Shinjuku Station" },
    });
    expect(again.json().venue.slug).toBe("shinjuku-station-2");

    const list = await app.inject({ method: "GET", url: "/api/venues", headers: { cookie } });
    expect(list.json().venues).toHaveLength(2);
    expect(list.json().venues[0].latest).toBeNull();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/venues/${venue.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: "GET", url: "/api/venues", headers: { cookie } });
    expect(afterDelete.json().venues).toHaveLength(1);

    const missing = await app.inject({
      method: "DELETE",
      url: `/api/venues/${venue.id}`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("deletes a venue whose publication job still references its draft version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "Queued Publication" },
    });
    expect(created.statusCode).toBe(201);
    const venue = created.json().venue as { id: number };
    const versionId = Number(
      app.db
        .prepare(
          `INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, status)
           VALUES (?, 1, ?, ?, 'draft')`,
        )
        .run(venue.id, "f".repeat(64), "source".repeat(11).slice(0, 64)).lastInsertRowid,
    );
    app.db.prepare("INSERT INTO jobs (id, kind, version_id, payload_json) VALUES ('queued-delete', 'publish_imdf', ?, ?)").run(
      versionId,
      JSON.stringify({ versionId }),
    );

    const del = await app.inject({
      method: "DELETE",
      url: `/api/venues/${venue.id}`,
      headers: { cookie },
    });
    expect(del.statusCode, del.body).toBe(204);
    expect(
      app.db.prepare("SELECT status, version_id AS versionId FROM jobs WHERE id = 'queued-delete'").get(),
    ).toEqual({ status: "queued", versionId: null });
  });

  it("returns every permanent public version ID from the deletion transaction and rolls back together", async () => {
    const { app } = await makeTestApp();
    app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (10, 1, 'station', 'Station')").run();
    app.db.prepare(
      `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
       VALUES (100, 10, 1, ?, 'source-a', 'bundle-a', 'published'),
              (101, 10, 2, ?, 'source-b', 'bundle-b', 'published')`,
    ).run("a".repeat(64), "b".repeat(64));

    expect(deleteVenue(app.db, 1, 10)).toEqual({
      deleted: true,
      publicVersionIds: ["a".repeat(64), "b".repeat(64)],
    });
    expect(app.db.prepare("SELECT count(*) AS count FROM versions WHERE venue_id = 10").get()).toEqual({
      count: 0,
    });

    app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (11, 1, 'blocked', 'Blocked')").run();
    app.db.prepare(
      `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
       VALUES (102, 11, 1, ?, 'source-c', 'bundle-c', 'published')`,
    ).run("c".repeat(64));
    app.db
      .prepare(
        `CREATE TRIGGER reject_venue_delete BEFORE DELETE ON venues
         WHEN old.id = 11 BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
      )
      .run();

    expect(() => deleteVenue(app.db, 1, 11)).toThrowError("blocked");
    expect(app.db.prepare("SELECT public_id AS publicId FROM versions WHERE venue_id = 11").all()).toEqual([
      { publicId: "c".repeat(64) },
    ]);
  });

  it("releases exact deleted stream capacity and isolates recreated-version publications", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kiriko-venue-lifecycle-"));
    const app = await buildApp({
      dataDir,
      sessionTtlDays: 30,
      secureCookies: false,
      issueSseMaxConnections: 3,
      issueSseMaxPerVersion: 1,
      bootstrapUser: TEST_USER,
      bootstrapPassword: TEST_PASSWORD,
    });
    const live: LiveResponse[] = [];
    try {
      const cookie = await loginCookie(app);
      const bundleHash = putFixtureBundle(app);
      const publicA = "a".repeat(64);
      const publicB = "b".repeat(64);
      const publicC = "c".repeat(64);
      const publicD = "d".repeat(64);
      const publicE = "e".repeat(64);
      app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (10, 1, 'station', 'Station')").run();
      app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (11, 1, 'annex', 'Annex')").run();
      app.db.prepare(
        `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
         VALUES (100, 10, 1, ?, 'source-a', ?, 'published'),
                (101, 10, 2, ?, 'source-b', ?, 'published'),
                (102, 11, 1, ?, 'source-c', ?, 'published')`,
      ).run(publicA, bundleHash, publicB, bundleHash, publicC, bundleHash);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const streamA = await connect(port, `/api/review/versions/${publicA}/issues/events`);
      const streamB = await connect(port, `/api/review/versions/${publicB}/issues/events`);
      const streamC = await connect(port, `/api/review/versions/${publicC}/issues/events`);
      live.push(streamA, streamB, streamC);
      await Promise.all([
        streamA.waitForText('data: {"revision":0}'),
        streamB.waitForText('data: {"revision":0}'),
        streamC.waitForText('data: {"revision":0}'),
      ]);

      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/venues/10",
        headers: { cookie },
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
      await Promise.all([streamA.waitForEnd(), streamB.waitForEnd()]);
      expect(streamC.ended).toBe(false);
      expect(app.db.prepare("SELECT count(*) AS count FROM versions WHERE venue_id = 10").get()).toEqual({
        count: 0,
      });

      app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (10, 1, 'station-new', 'Station New')").run();
      app.db.prepare(
        `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
         VALUES (103, 10, 1, ?, 'source-d', ?, 'published'),
                (104, 10, 2, ?, 'source-e', ?, 'published')`,
      ).run(publicD, bundleHash, publicE, bundleHash);
      const streamD = await connect(port, `/api/review/versions/${publicD}/issues/events`);
      const streamE = await connect(port, `/api/review/versions/${publicE}/issues/events`);
      live.push(streamD, streamE);
      await Promise.all([
        streamD.waitForText('data: {"revision":0}'),
        streamE.waitForText('data: {"revision":0}'),
      ]);

      const mutationD = await app.inject({
        method: "POST",
        url: `/api/review/versions/${publicD}/issues`,
        headers: { cookie },
        payload: createPayload(),
      });
      expect(mutationD.statusCode, mutationD.body).toBe(200);
      await streamD.waitForText('data: {"revision":1}');
      await waitForImmediate();
      expect(streamC.text).not.toContain('data: {"revision":1}');
      expect(streamE.text).not.toContain('data: {"revision":1}');

      const dRevisionEvents = streamD.text.split('data: {"revision":1}').length - 1;
      const mutationC = await app.inject({
        method: "POST",
        url: `/api/review/versions/${publicC}/issues`,
        headers: { cookie },
        payload: createPayload(),
      });
      expect(mutationC.statusCode, mutationC.body).toBe(200);
      await streamC.waitForText('data: {"revision":1}');
      await waitForImmediate();
      expect(streamD.text.split('data: {"revision":1}').length - 1).toBe(dRevisionEvents);
      expect(streamE.text).not.toContain('data: {"revision":1}');
    } finally {
      for (const stream of live) stream.destroy();
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });


  it("keeps the exact stream live when venue deletion rolls back and closes it only after commit", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const publicId = "f".repeat(64);
    const bundleHash = putFixtureBundle(app);
    app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (10, 1, 'station', 'Station')").run();
    app.db.prepare(
      `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
       VALUES (100, 10, 1, ?, 'source', ?, 'published')`,
    ).run(publicId, bundleHash);
    app.db
      .prepare(
        `CREATE TRIGGER reject_live_venue_delete BEFORE DELETE ON venues
         WHEN old.id = 10 BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
      )
      .run();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const stream = await connect(port, `/api/review/versions/${publicId}/issues/events`);
    await stream.waitForText('data: {"revision":0}');

    const rolledBack = await app.inject({
      method: "DELETE",
      url: "/api/venues/10",
      headers: { cookie },
    });
    expect(rolledBack.statusCode).toBe(500);
    expect(stream.ended).toBe(false);
    expect(app.db.prepare("SELECT public_id AS publicId FROM versions WHERE id = 100").get()).toEqual({
      publicId,
    });

    const mutation = await app.inject({
      method: "POST",
      url: `/api/review/versions/${publicId}/issues`,
      headers: { cookie },
      payload: createPayload(),
    });
    expect(mutation.statusCode, mutation.body).toBe(200);
    await stream.waitForText('data: {"revision":1}');

    app.db.prepare("DROP TRIGGER reject_live_venue_delete").run();
    const committed = await app.inject({
      method: "DELETE",
      url: "/api/venues/10",
      headers: { cookie },
    });
    expect(committed.statusCode, committed.body).toBe(204);
    await stream.waitForEnd();
  });
  it("closes a live production SSE response before app.close waits for sockets", async () => {
    const { app } = await makeTestApp();
    const publicId = "e".repeat(64);
    app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (10, 1, 'station', 'Station')").run();
    app.db.prepare(
      `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
       VALUES (100, 10, 1, ?, 'source', 'bundle', 'published')`,
    ).run(publicId);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const stream = await connect(port, `/api/review/versions/${publicId}/issues/events`);
    await stream.waitForText('data: {"revision":0}');

    await expect(app.close()).resolves.toBeUndefined();
    await stream.waitForEnd();
  });
});
