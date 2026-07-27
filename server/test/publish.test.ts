import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import {
  compileVenueBundle,
  CoreCompileError,
  type CompileVenueMetadata,
  type ImdfStats,
  type NativeCompileResponse,
  type ViewerWarning,
} from "../src/core/native";
import { makePublishRunner } from "../src/jobs/publish";
import { cleanupTestApps, loginCookie, makeTestApp, newTestPublicVersionId } from "./helpers";

afterEach(cleanupTestApps);

const KVB_MAGIC = Buffer.from([0x4b, 0x56, 0x42, 0x00]); // "KVB\0"
const LEVEL_1F = "b1000001-0000-4000-8000-0000000000b1";

/**
 * A minimal well-formed native envelope, matching the fake-response shape
 * `coreNative.test.ts` uses for `compileVenueBundle`'s injected native
 * function: just enough for `validateNativeResponse` to accept it.
 */
function okNativeResponse(): NativeCompileResponse {
  return {
    ok: true,
    bundle: Buffer.alloc(0),
    statsJson: JSON.stringify({ levels: 0, features: 0 }),
    warningsJson: "[]",
  };
}

function syntheticUnitId(i: number): string {
  return `f${i.toString(16).padStart(7, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

/**
 * A valid IMDF archive with `count` synthetic unit features, used only to
 * make native compile take long enough (see `coreNative.test.ts`'s "off
 * the Node.js event loop" test, ~80ms for 4000 features) that a
 * publish-plumbing regression which blocks the event loop would be
 * unmistakable.
 */
async function buildExpensiveImdfZip(count: number): Promise<Uint8Array> {
  const features = [];
  for (let i = 0; i < count; i++) {
    const lon = 139.76 + (i % 100) * 0.0001;
    const lat = 35.68 + Math.floor(i / 100) * 0.0001;
    features.push({
      id: syntheticUnitId(i),
      type: "Feature",
      feature_type: "unit",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lon, lat],
            [lon + 0.00005, lat],
            [lon + 0.00005, lat + 0.00005],
            [lon, lat + 0.00005],
            [lon, lat],
          ],
        ],
      },
      properties: {
        category: "room",
        restriction: null,
        accessibility: null,
        name: { en: `Room ${i}` },
        alt_name: null,
        display_point: { type: "Point", coordinates: [lon + 0.000025, lat + 0.000025] },
        level_id: LEVEL_1F,
      },
    });
  }
  const collection = { type: "FeatureCollection", features };
  return buildMinimalImdfZip({ replaceEntries: { "unit.geojson": JSON.stringify(collection) } });
}

async function createVenue(app: FastifyInstance, cookie: string, name = "Test Station") {
  const res = await app.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie },
    payload: { name },
  });
  return res.json().venue as { id: number; slug: string };
}

function multipartZip(bytes: Uint8Array): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----kirikoTestBoundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="venue.zip"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("upload + publish", () => {
  it("uploads an IMDF zip, publishes a compiled KVB bundle, and exposes stats", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);
    const { payload, headers } = multipartZip(await buildMinimalImdfZip());

    const upload = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/versions`,
      headers: { ...headers, cookie },
      payload,
    });
    expect(upload.statusCode).toBe(202);
    const { jobId, seq, versionId } = upload.json();
    expect(seq).toBe(1);

    await app.queue.idle();

    const job = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: { cookie } });
    expect(job.json().status).toBe("done");

    const list = await app.inject({ method: "GET", url: "/api/venues", headers: { cookie } });
    const latest = list.json().venues[0].latest;
    expect(latest.seq).toBe(1);
    expect(latest.status).toBe("published");
    expect(latest.stats).toEqual({ levels: 3, features: 27 });

    const row = app.db
      .prepare("SELECT source_blob_hash AS sourceHash, bundle_hash AS bundleHash FROM versions WHERE id = ?")
      .get(versionId) as { sourceHash: string; bundleHash: string };
    expect(row.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.bundleHash).not.toBe(row.sourceHash);
    const bundleBytes = app.blobs.read(row.bundleHash);
    expect(bundleBytes.subarray(0, 4)).toEqual(KVB_MAGIC);
  });

  it("marks a garbage upload failed with a stable structured error and keeps the venue unpublished", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);
    const { payload, headers } = multipartZip(new TextEncoder().encode("not a zip"));

    const upload = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/versions`,
      headers: { ...headers, cookie },
      payload,
    });
    expect(upload.statusCode).toBe(202);
    const { versionId } = upload.json();
    await app.queue.idle();

    const job = await app.inject({
      method: "GET",
      url: `/api/jobs/${upload.json().jobId}`,
      headers: { cookie },
    });
    expect(job.json().status).toBe("error");
    const jobError = JSON.parse(job.json().error) as { code: string; message: string };
    expect(jobError.code).toBe("unsupported_file");

    const row = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(versionId) as { status: string; bundleHash: string | null; sourceHash: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(row.bundleHash).toBeNull();
    expect(row.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(app.blobs.has(row.sourceHash)).toBe(true);
    const versionError = JSON.parse(row.error ?? "null") as { code: string; message: string };
    expect(versionError.code).toBe("unsupported_file");

    const list = await app.inject({ method: "GET", url: "/api/venues", headers: { cookie } });
    expect(list.json().venues[0].latest).toBeNull();
  });

  it("re-publishing the same version stores exactly one content-addressed bundle blob", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);
    const { payload, headers } = multipartZip(await buildMinimalImdfZip());

    const upload = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/versions`,
      headers: { ...headers, cookie },
      payload,
    });
    const { versionId } = upload.json();
    await app.queue.idle();

    const first = app.db
      .prepare("SELECT bundle_hash AS bundleHash FROM versions WHERE id = ?")
      .get(versionId) as { bundleHash: string };

    // Re-run the publish runner directly for the same version, simulating a
    // retry: identical (datasetId, seq) source must compile to identical
    // bytes, so the content-addressed blob table gains no duplicate row.
    const runner = makePublishRunner(app.db, app.blobs);
    await runner(JSON.stringify({ versionId }));

    const second = app.db
      .prepare("SELECT bundle_hash AS bundleHash FROM versions WHERE id = ?")
      .get(versionId) as { bundleHash: string };
    expect(second.bundleHash).toBe(first.bundleHash);

    const blobRows = app.db
      .prepare("SELECT COUNT(*) AS c FROM blobs WHERE hash = ?")
      .get(first.bundleHash) as { c: number };
    expect(blobRows.c).toBe(1);
  });

  it("keeps the queue responsive to other requests while a compile is in flight", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);
    const { payload, headers } = multipartZip(await buildExpensiveImdfZip(4000));

    const upload = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/versions`,
      headers: { ...headers, cookie },
      payload,
    });
    expect(upload.statusCode).toBe(202);

    let jobSettled = false;
    const idle = app.queue.idle().then(() => {
      jobSettled = true;
    });

    // Issued while the compile's native AsyncTask is still running on
    // libuv's thread pool (see coreNative.test.ts's "off the Node.js event
    // loop" test); if publish ever blocked the event loop synchronously,
    // this unrelated request could not be served until the job settled.
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(jobSettled).toBe(false);

    await idle;
    const job = await app.inject({
      method: "GET",
      url: `/api/jobs/${upload.json().jobId}`,
      headers: { cookie },
    });
    expect(job.json().status).toBe("done");
  });

  it("rolls back the draft version when queue job insertion fails", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);
    app.db.exec(`
      CREATE TRIGGER fail_publication_job_insert
      BEFORE INSERT ON jobs
      WHEN NEW.kind = 'publish_imdf'
      BEGIN
        SELECT RAISE(ABORT, 'simulated job insert failure');
      END;
    `);
    const { payload, headers } = multipartZip(await buildMinimalImdfZip());

    const upload = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/versions`,
      headers: { ...headers, cookie },
      payload,
    });

    expect(upload.statusCode).toBe(500);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE venue_id = ?").get(venue.id)).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });
});

describe("compileVenueBundle clipToVenue bridge", () => {
  it("passes clipToVenue to the native compiler when the job payload asks for clipping", async () => {
    const calls: unknown[][] = [];
    const fakeCompile = async (...args: unknown[]) => {
      calls.push(args);
      return okNativeResponse();
    };
    await compileVenueBundle(
      Buffer.from("x"),
      { datasetId: "t/v", version: 1, clipToVenue: true },
      fakeCompile as never,
    );
    expect(calls[0]![7]).toBe(true);
  });

  it("leaves clipToVenue undefined when the job payload omits it", async () => {
    const calls: unknown[][] = [];
    const fakeCompile = async (...args: unknown[]) => {
      calls.push(args);
      return okNativeResponse();
    };
    await compileVenueBundle(Buffer.from("x"), { datasetId: "t/v", version: 1 }, fakeCompile as never);
    expect(calls[0]![7]).toBeUndefined();
  });
});

describe("publish identity race", () => {
  it("never publishes onto, or fails, a version row whose id was reused by a different row while compiling", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);

    // Insert the *only* version row directly (bypassing the upload route)
    // so the versions table starts and ends this setup with exactly one
    // row — SQLite then deterministically reuses its rowid for the next
    // insert once it (and its venue) are deleted.
    const sourceA = await buildMinimalImdfZip();
    const { hash: sourceHashA } = app.blobs.put(sourceA);
    app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(sourceHashA, sourceA.byteLength);
    const insertA = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue.id, newTestPublicVersionId(), sourceHashA);
    const versionId = Number(insertA.lastInsertRowid);

    // A deferred compile we control: resolves only once we say so, well
    // after the row has been deleted and replaced below.
    let resolveCompile!: (result: { bundle: Buffer; stats: ImdfStats; warnings: ViewerWarning[] }) => void;
    const deferred = new Promise<{ bundle: Buffer; stats: ImdfStats; warnings: ViewerWarning[] }>((resolve) => {
      resolveCompile = resolve;
    });
    const compile = async (_source: Buffer, _metadata: CompileVenueMetadata) => deferred;

    const runner = makePublishRunner(app.db, app.blobs, compile);
    const publishPromise = runner(JSON.stringify({ versionId }));

    // While the compile above is still pending: delete the venue (cascades
    // to delete its only version row) and create a brand new venue +
    // version. SQLite reuses the freed rowid since the table is empty
    // again, so the replacement deterministically gets the same id.
    app.db.prepare("DELETE FROM venues WHERE id = ?").run(venue.id);
    const venue2 = await createVenue(app, cookie, "Replacement Venue");
    const sourceB = await buildMinimalImdfZip({ extraEntries: { "note.txt": "replacement" } });
    const { hash: sourceHashB } = app.blobs.put(sourceB);
    app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(sourceHashB, sourceB.byteLength);
    const insertB = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue2.id, newTestPublicVersionId(), sourceHashB);
    const replacementId = Number(insertB.lastInsertRowid);
    expect(replacementId).toBe(versionId); // confirms the rowid was actually reused

    const replacementBefore = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(replacementId);

    // Now let the stale compile (against the *deleted* row's source)
    // resolve successfully.
    resolveCompile({
      bundle: Buffer.from([0x4b, 0x56, 0x42, 0x00, 0xde, 0xad]),
      stats: { levels: 3, features: 27 },
      warnings: [],
    });

    let caught: unknown;
    try {
      await publishPromise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const structured = JSON.parse((caught as Error).message) as { code: string; message: string };
    expect(structured.code).toBe("stale_version");

    // The replacement row (same reused id, different venue/seq/source) is
    // completely untouched: not published with the stale compile's bundle,
    // and not marked failed either.
    const replacementAfter = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(replacementId);
    expect(replacementAfter).toEqual(replacementBefore);
    expect((replacementAfter as { sourceHash: string }).sourceHash).toBe(sourceHashB);
  });

  it("treats a same-id/venue/seq/source/status replacement with a different public ID as stale", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Original Venue");

    const source = await buildMinimalImdfZip();
    const { hash: sourceHash } = app.blobs.put(source);
    app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(sourceHash, source.byteLength);
    const originalPublicId = newTestPublicVersionId();
    const insert1 = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue.id, originalPublicId, sourceHash);
    const versionId = Number(insert1.lastInsertRowid);

    let resolveCompile!: (result: { bundle: Buffer; stats: ImdfStats; warnings: ViewerWarning[] }) => void;
    const deferred = new Promise<{ bundle: Buffer; stats: ImdfStats; warnings: ViewerWarning[] }>((resolve) => {
      resolveCompile = resolve;
    });
    const compile = async (_source: Buffer, _metadata: CompileVenueMetadata) => deferred;
    const runner = makePublishRunner(app.db, app.blobs, compile);
    const publishPromise = runner(JSON.stringify({ versionId }));

    // Delete and recreate the same venue and version identity, including
    // reused numeric ids, slug, seq, source hash, and status. The permanent
    // public ID is the only mismatch between the stale compile snapshot and
    // the replacement row.
    app.db.prepare("DELETE FROM venues WHERE id = ?").run(venue.id);
    const venue2 = await createVenue(app, cookie, "Original Venue");
    expect(venue2.id).toBe(venue.id);
    expect(venue2.slug).toBe(venue.slug);
    const replacementPublicId = newTestPublicVersionId();
    const insert2 = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue2.id, replacementPublicId, sourceHash);
    const replacementId = Number(insert2.lastInsertRowid);
    expect(replacementId).toBe(versionId); // version id was reused too

    const replacementRow = app.db
      .prepare("SELECT public_id AS publicId, seq, source_blob_hash AS sourceHash, status FROM versions WHERE id = ?")
      .get(replacementId) as { publicId: string; seq: number; sourceHash: string; status: string };
    expect(replacementRow.publicId).toBe(replacementPublicId);
    expect(replacementRow.seq).toBe(1);
    expect(replacementRow.sourceHash).toBe(sourceHash);
    expect(replacementRow.status).toBe("draft");

    const replacementBefore = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(replacementId);

    resolveCompile({
      bundle: Buffer.from([0x4b, 0x56, 0x42, 0x00, 0xbe, 0xef]),
      stats: { levels: 3, features: 27 },
      warnings: [],
    });

    let caught: unknown;
    try {
      await publishPromise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const structured = JSON.parse((caught as Error).message) as { code: string; message: string };
    expect(structured.code).toBe("stale_version");

    const replacementAfter = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(replacementId);
    expect(replacementAfter).toEqual(replacementBefore);
  });

  it("reports stale_version instead of the original domain code when a genuine compile failure races a delete+recreate", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Original Venue");

    const source = await buildMinimalImdfZip();
    const { hash: sourceHash } = app.blobs.put(source);
    app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(sourceHash, source.byteLength);
    const originalPublicId = newTestPublicVersionId();
    const insert1 = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue.id, originalPublicId, sourceHash);
    const versionId = Number(insert1.lastInsertRowid);

    let rejectCompile!: (error: unknown) => void;
    const deferred = new Promise<{ bundle: Buffer; stats: ImdfStats; warnings: ViewerWarning[] }>((_resolve, reject) => {
      rejectCompile = reject;
    });
    const compile = async (_source: Buffer, _metadata: CompileVenueMetadata) => deferred;
    const runner = makePublishRunner(app.db, app.blobs, compile);
    const publishPromise = runner(JSON.stringify({ versionId }));

    app.db.prepare("DELETE FROM venues WHERE id = ?").run(venue.id);
    const venue2 = await createVenue(app, cookie, "Original Venue");
    expect(venue2.id).toBe(venue.id);
    expect(venue2.slug).toBe(venue.slug);
    const replacementPublicId = newTestPublicVersionId();
    const insert2 = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue2.id, replacementPublicId, sourceHash);
    const replacementId = Number(insert2.lastInsertRowid);
    expect(replacementId).toBe(versionId);

    const replacementRow = app.db
      .prepare("SELECT public_id AS publicId, status FROM versions WHERE id = ?")
      .get(replacementId) as { publicId: string; status: string };
    expect(replacementRow.publicId).toBe(replacementPublicId);
    expect(replacementRow.status).toBe("draft");
    const replacementBefore = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(replacementId);

    // The stale compile now genuinely fails on its own terms (a real
    // domain error) — but the row it was compiling for no longer exists,
    // so the reported job error must still be stale_version, never the
    // now-meaningless domain code.
    rejectCompile(new CoreCompileError("unsupported_file", "unsupported_file"));

    let caught: unknown;
    try {
      await publishPromise;
    } catch (error) {
      caught = error;
    }
    const structured = JSON.parse((caught as Error).message) as { code: string; message: string };
    expect(structured.code).toBe("stale_version");
    expect(structured.code).not.toBe("unsupported_file");

    const replacementAfter = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(replacementId);
    expect(replacementAfter).toEqual(replacementBefore);
  });
});

describe("publish failure paths", () => {
  it("marks the version failed with a structured error when the retained source blob cannot be read", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);

    // A source hash the version row references but that was never
    // persisted via `blobs.put` — simulates a missing/corrupted blob.
    const missingHash = "0".repeat(64);
    const insert = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue.id, newTestPublicVersionId(), missingHash);
    const versionId = Number(insert.lastInsertRowid);

    const runner = makePublishRunner(app.db, app.blobs);
    await expect(runner(JSON.stringify({ versionId }))).rejects.toThrow();

    const row = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash, error FROM versions WHERE id = ?")
      .get(versionId) as { status: string; bundleHash: string | null; sourceHash: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(row.bundleHash).toBeNull();
    expect(row.sourceHash).toBe(missingHash);
    const structured = JSON.parse(row.error ?? "null") as { code: string; message: string };
    expect(structured.code).toBe("internal_error");
    expect(structured.message).toBeTruthy();
  });

  it("marks the version failed with a structured error when persisting the compiled bundle blob fails, preserving the source", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);

    const realPut = app.blobs.put.bind(app.blobs);
    const putSpy = vi.spyOn(app.blobs, "put");
    // First call is the upload route storing the source blob — let it
    // succeed; only the *second* call (publish persisting the compiled
    // bundle) simulates the disk-full failure.
    putSpy.mockImplementationOnce((bytes) => realPut(bytes));
    putSpy.mockImplementation(() => {
      throw new Error("simulated disk full");
    });
    const { payload, headers } = multipartZip(await buildMinimalImdfZip());
    const upload = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/versions`,
      headers: { ...headers, cookie },
      payload,
    });
    const { versionId, jobId } = upload.json();
    await app.queue.idle();
    putSpy.mockRestore();

    const job = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: { cookie } });
    expect(job.json().status).toBe("error");
    const jobError = JSON.parse(job.json().error) as { code: string; message: string };
    expect(jobError.code).toBe("internal_error");
    expect(jobError.message).toContain("simulated disk full");

    const row = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash FROM versions WHERE id = ?")
      .get(versionId) as { status: string; bundleHash: string | null; sourceHash: string };
    expect(row.status).toBe("failed");
    expect(row.bundleHash).toBeNull();
    expect(app.blobs.has(row.sourceHash)).toBe(true);
  });

  it("marks the version failed when the published-state SQLite write fails, and the failure write itself still commits", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);

    // Fires only on the transition to status='published' — the later
    // failure-marking UPDATE sets status='failed' instead, so it is
    // unaffected and must still commit.
    app.db.exec(`
      CREATE TRIGGER fail_on_publish_transition
      BEFORE UPDATE OF status ON versions
      WHEN NEW.status = 'published'
      BEGIN
        SELECT RAISE(ABORT, 'simulated publish commit failure');
      END;
    `);

    const { payload, headers } = multipartZip(await buildMinimalImdfZip());
    const upload = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/versions`,
      headers: { ...headers, cookie },
      payload,
    });
    const { versionId, jobId } = upload.json();
    await app.queue.idle();

    const job = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: { cookie } });
    expect(job.json().status).toBe("error");
    const jobError = JSON.parse(job.json().error) as { code: string; message: string };
    expect(jobError.code).toBe("internal_error");
    expect(jobError.message).toContain("simulated publish commit failure");

    const row = app.db
      .prepare("SELECT status, bundle_hash AS bundleHash, source_blob_hash AS sourceHash FROM versions WHERE id = ?")
      .get(versionId) as { status: string; bundleHash: string | null; sourceHash: string };
    expect(row.status).toBe("failed");
    expect(row.bundleHash).toBeNull();
    expect(app.blobs.has(row.sourceHash)).toBe(true);
  });

  it("skips publish and failure writes when shutdown aborts after compile returns", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie);
    const source = await buildMinimalImdfZip();
    const { hash: sourceHash } = app.blobs.put(source);
    app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(sourceHash, source.byteLength);
    const insert = app.db
      .prepare(
        "INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, source_kind) VALUES (?, 1, ?, ?, 'imdf')",
      )
      .run(venue.id, newTestPublicVersionId(), sourceHash);
    const versionId = Number(insert.lastInsertRowid);
    const controller = new AbortController();
    const compile = async (_source: Buffer, _metadata: CompileVenueMetadata) => {
      controller.abort();
      return {
        bundle: Buffer.from([0x4b, 0x56, 0x42, 0x00, 0xaa]),
        stats: { levels: 1, features: 1 },
        warnings: [],
      };
    };
    const runner = makePublishRunner(app.db, app.blobs, compile);

    await expect(runner(JSON.stringify({ versionId }), controller.signal)).rejects.toThrow(/shutdown/i);

    expect(
      app.db.prepare("SELECT status, bundle_hash AS bundleHash, error FROM versions WHERE id = ?").get(versionId),
    ).toEqual({ status: "draft", bundleHash: null, error: null });
  });
});
