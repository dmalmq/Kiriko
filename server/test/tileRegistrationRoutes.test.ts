/**
 * Registration, the gates, and producer activation through the real routes
 * (#74).
 *
 * Activation is the act that lets a package become a venue's primary view, so
 * these tests are about refusal as much as success: what a gate stops, what an
 * evaluation is still valid for, and what activation actually produces.
 *
 * #30 section 6 settles the shape: correcting or replacing tiles creates a new
 * venue version. Activation therefore publishes one, and the descriptor is
 * compiled into that version's own §9 rather than mutating bytes a pinned,
 * immutably-cached URL already serves.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { sceneProjection } from "@kiriko/node";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { corridorPackageGlb, rootTransform } from "../../tests/fixtures/tileRegistration";
import { venuePlaneFromBundle } from "./tileRegistrationFixtures";
import { tilesetFixture } from "../../tests/fixtures/tileFixtures";
import { evaluationTarget, findEvaluation, storeEvaluation } from "../src/tiles/activation";

afterEach(cleanupTestApps);

const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";

function multipart(bytes: Uint8Array, filename: string, type: string) {
  const boundary = "----kirikoTileRegistrationBoundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

interface Venue {
  app: FastifyInstance;
  cookie: string;
  venueId: number;
  versionId: number;
  bundleHash: string;
}

async function publishedVenue(name: string): Promise<Venue> {
  const { app } = await makeTestApp();
  const cookie = await loginCookie(app);
  const created = await app.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie },
    payload: { name },
  });
  const venue = created.json<{ venue: { id: number } }>().venue;
  const upload = multipart(await buildMinimalImdfZip(), "v.zip", "application/zip");
  await app.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/versions`,
    headers: { cookie, ...upload.headers },
    payload: upload.payload,
  });
  await app.queue.idle();
  const version = app.db
    .prepare(
      `SELECT id, bundle_hash AS bundleHash FROM versions
       WHERE venue_id = ? AND status = 'published'`,
    )
    .get(venue.id) as { id: number; bundleHash: string };
  return { app, cookie, venueId: venue.id, versionId: version.id, bundleHash: version.bundleHash };
}

/** Ingest a package whose floor covers the fixture's B1 corridor. */
async function ingestCorridor(venue: Venue, inset = 0): Promise<number> {
  const plane = await venuePlaneFromBundle(
    venue.app.blobs.read(venue.bundleHash),
    LEVEL_B1,
  );
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  await writer.add(
    "tileset.json",
    new Uint8ArrayReader(tilesetFixture("content/model.glb", rootTransform())),
  );
  await writer.add(
    "content/model.glb",
    new Uint8ArrayReader(corridorPackageGlb(inset, plane)),
  );
  const zip = Buffer.from(await writer.close());
  const upload = multipart(zip, "tiles.zip", "application/zip");
  const response = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/tiles/inspect`,
    headers: { cookie: venue.cookie, ...upload.headers },
    payload: upload.payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ packageId: number }>().packageId;
}

async function evaluate(
  venue: Venue,
  packageId: number,
  body: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
    headers: { cookie: venue.cookie },
    payload: { capabilityProfile: "webgl2-mrt-float", ...body },
  });
  return { statusCode: response.statusCode, body: response.json<Record<string, unknown>>() };
}

async function activate(
  venue: Venue,
  packageId: number,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/tiles/${packageId}/activate`,
    headers: { cookie: venue.cookie },
    payload: { mappingConfirmed: true },
  });
  return { statusCode: response.statusCode, body: response.json<Record<string, unknown>>() };
}

describe("tile registration", () => {
  it("reports residuals and the registration table for an aligned package", async () => {
    const venue = await publishedVenue("Registration");
    const packageId = await ingestCorridor(venue);

    const { statusCode, body } = await evaluate(venue, packageId);

    expect(statusCode, JSON.stringify(body)).toBe(200);
    expect(body["state"]).toBe("evaluated");
    expect(body["gates"]).toEqual([]);
    expect(body["floorMappings"]).toEqual([[LEVEL_B1, expect.any(Array)]]);
    // The route's own response schema types this; the cast names what the
    // schema already guarantees rather than re-deriving it here.
    const report = body["report"] as { floors: { canonicalLevelId: string }[] };
    expect(report.floors[0]?.canonicalLevelId).toBe(LEVEL_B1);
  });

  it("keeps the evaluation inspectable when a gate blocks it", async () => {
    const venue = await publishedVenue("Blocked");
    const packageId = await ingestCorridor(venue, 0.8);

    const { statusCode, body } = await evaluate(venue, packageId);

    expect(statusCode).toBe(200);
    const gates = body["gates"] as { code: string; subject: string }[];
    expect(gates.map((gate) => gate.code)).toEqual(["registrationOutOfBand"]);
    expect(body["state"]).toBe("evaluated");
  });

  it("stores the profile the evaluation was judged under", async () => {
    const venue = await publishedVenue("Profile");
    const packageId = await ingestCorridor(venue, 0.8);

    await evaluate(venue, packageId, { profile: { id: "tokyo", version: 3, p90MaxM: 0.9 } });

    const stored = venue.app.db
      .prepare("SELECT profile_id AS id, profile_version AS version FROM tile_activations")
      .get() as { id: string; version: number };
    expect(stored).toEqual({ id: "tokyo", version: 3 });
  });
});

describe("tile activation", () => {
  it("refuses to activate a package that has not been evaluated", async () => {
    const venue = await publishedVenue("Unevaluated");
    const packageId = await ingestCorridor(venue);

    const { statusCode, body } = await activate(venue, packageId);

    expect(statusCode).toBe(409);
    expect(body["code"]).toBe("not_evaluated");
  });

  it("refuses to activate a mapping nobody confirmed", async () => {
    // The gates cannot establish that each level is on the right floor: a stack
    // offset by about a storey maps every level to its neighbour, and where
    // footprints repeat the residuals against the wrong floor measure as small as
    // against the right one. So a person asserts it — and the assertion is
    // enforced here, not only in the dialog. A guarantee that lives in a checkbox
    // is a guarantee anything with `curl` can skip.
    const venue = await publishedVenue("Unconfirmed");
    const packageId = await ingestCorridor(venue);
    await evaluate(venue, packageId);

    const response = await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/activate`,
      headers: { cookie: venue.cookie },
      payload: { mappingConfirmed: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe("mapping_unconfirmed");
    // And nothing was published on the way to refusing.
    const versions = venue.app.db
      .prepare("SELECT COUNT(*) AS count FROM versions WHERE venue_id = ?")
      .get(venue.venueId) as { count: number };
    expect(versions.count).toBe(1);
  });

  it("records who confirmed the mapping alongside the activation", async () => {
    // The question worth answering later is not whether a box was ticked but who
    // checked, and against which measurements — which this row already holds.
    const venue = await publishedVenue("Confirmed");
    const packageId = await ingestCorridor(venue);
    await evaluate(venue, packageId);

    const { statusCode } = await activate(venue, packageId);
    await venue.app.queue.idle();

    expect(statusCode).toBe(202);
    const row = venue.app.db
      .prepare(
        `SELECT mapping_confirmed_by AS by, mapping_confirmed_at AS at
         FROM tile_activations WHERE package_id = ?`,
      )
      .get(packageId) as { by: number | null; at: string | null };
    expect(row.by).not.toBeNull();
    expect(row.at).not.toBeNull();
  });

  it("refuses to activate a package a gate blocks, and says which", async () => {
    const venue = await publishedVenue("Gated");
    const packageId = await ingestCorridor(venue, 0.8);
    await evaluate(venue, packageId);

    const { statusCode, body } = await activate(venue, packageId);

    expect(statusCode).toBe(409);
    expect(body["code"]).toBe("activation_blocked");
    const details = body["details"] as { gates: { code: string }[] };
    expect(details.gates.map((gate) => gate.code)).toEqual(["registrationOutOfBand"]);
  });

  it("publishes a version whose section 9 carries the activated descriptor", async () => {
    const venue = await publishedVenue("Activated");
    const packageId = await ingestCorridor(venue);
    await evaluate(venue, packageId);

    const { statusCode, body } = await activate(venue, packageId);
    expect(statusCode, JSON.stringify(body)).toBe(202);
    await venue.app.queue.idle();

    const published = venue.app.db
      .prepare(
        `SELECT id, seq, bundle_hash AS bundleHash FROM versions
         WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
      )
      .get(venue.venueId) as { id: number; seq: number; bundleHash: string };
    expect(published.seq).toBe(2);

    const response = await sceneProjection(venue.app.blobs.read(published.bundleHash));
    expect(response.ok).toBe(true);
    const projection = JSON.parse(String(response.projectionJson)) as {
      tiles: { activationState: string; registrationProfileId: string } | null;
      levels: { levelId: string; sourceLevels: string[] }[];
    };
    expect(projection.tiles?.activationState).toBe("activated");
    expect(projection.tiles?.registrationProfileId).toBe("default@1");
    const b1 = projection.levels.find((level) => level.levelId === LEVEL_B1);
    expect(b1?.sourceLevels.length).toBe(1);

    // The new version renders the package, and the old one is untouched.
    const bound = venue.app.db
      .prepare("SELECT version_id AS versionId FROM version_tile_packages WHERE package_id = ?")
      .all(packageId) as { versionId: number }[];
    expect(bound.map((row) => row.versionId)).toEqual([published.id]);
    const previous = venue.app.db
      .prepare("SELECT bundle_hash AS bundleHash FROM versions WHERE id = ?")
      .get(venue.versionId) as { bundleHash: string };
    expect(previous.bundleHash).toBe(venue.bundleHash);
  });

  it("keeps the evaluation unactivated when publication fails", async () => {
    const venue = await publishedVenue("Activation publication failure");
    const packageId = await ingestCorridor(venue);
    await evaluate(venue, packageId);
    venue.app.db.exec(`
      CREATE TRIGGER reject_activation_publication
      BEFORE UPDATE OF status ON versions
      WHEN OLD.status = 'draft' AND NEW.status = 'published'
      BEGIN
        SELECT RAISE(ABORT, 'simulated activation publication failure');
      END;
    `);

    const { statusCode, body } = await activate(venue, packageId);
    expect(statusCode, JSON.stringify(body)).toBe(202);
    await venue.app.queue.idle();

    const evaluation = venue.app.db
      .prepare(
        `SELECT state, activated_at AS activatedAt,
                activated_version_id AS activatedVersionId,
                scene_blob_hash AS sceneBlobHash
         FROM tile_activations WHERE package_id = ?`,
      )
      .get(packageId);
    expect(evaluation).toEqual({
      state: "evaluated",
      activatedAt: null,
      activatedVersionId: null,
      sceneBlobHash: null,
    });
    const failed = venue.app.db
      .prepare("SELECT status FROM versions WHERE venue_id = ? ORDER BY seq DESC LIMIT 1")
      .get(venue.venueId);
    expect(failed).toEqual({ status: "failed" });
  });

  it("keeps an activation evaluation immutable while publication is in flight", async () => {
    const venue = await publishedVenue("Activation evaluation reservation");
    const packageId = await ingestCorridor(venue);
    await evaluate(venue, packageId);

    const activation = await activate(venue, packageId);
    expect(activation.statusCode, JSON.stringify(activation.body)).toBe(202);
    const reserved = venue.app.db
      .prepare(
        `SELECT activating_version_id AS activatingVersionId
         FROM tile_activations WHERE package_id = ?`,
      )
      .get(packageId);
    expect(reserved).toEqual({ activatingVersionId: activation.body["versionId"] });

    const original = findEvaluation(venue.app.db, packageId);
    const target = evaluationTarget(venue.app.db, venue.venueId);
    const producer = venue.app.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: number };
    expect(original).not.toBeNull();
    expect(target).not.toBeNull();
    expect(
      storeEvaluation(venue.app.db, {
        packageId,
        target: target!,
        profile: { id: "must-not-replace-reserved-evaluation", version: 99 },
        capabilityProfile: original!.capabilityProfile,
        evaluation: original!.evaluation,
        evaluatedBy: producer.id,
      }),
    ).toBe(false);

    await venue.app.queue.idle();
    const stored = venue.app.db
      .prepare(
        `SELECT profile_id AS profileId, state
         FROM tile_activations WHERE package_id = ?`,
      )
      .get(packageId);
    expect(stored).toEqual({ profileId: "default", state: "activated" });
  });

  it("retries a failed activation at a fresh version sequence", async () => {
    const venue = await publishedVenue("Activation publication retry");
    const packageId = await ingestCorridor(venue);
    await evaluate(venue, packageId);
    venue.app.db.exec(`
      CREATE TRIGGER reject_first_activation_publication
      BEFORE UPDATE OF status ON versions
      WHEN OLD.status = 'draft' AND NEW.status = 'published'
      BEGIN
        SELECT RAISE(ABORT, 'simulated activation publication failure');
      END;
    `);

    const first = await activate(venue, packageId);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(202);
    await venue.app.queue.idle();
    venue.app.db.exec("DROP TRIGGER reject_first_activation_publication");

    const retry = await activate(venue, packageId);
    expect(retry.statusCode, JSON.stringify(retry.body)).toBe(202);
    expect(retry.body["seq"]).toBe(3);
    await venue.app.queue.idle();

    const versions = venue.app.db
      .prepare(
        `SELECT seq, status FROM versions
         WHERE venue_id = ? ORDER BY seq`,
      )
      .all(venue.venueId);
    expect(versions).toEqual([
      { seq: 1, status: "published" },
      { seq: 2, status: "failed" },
      { seq: 3, status: "published" },
    ]);
  });

  it("refuses an evaluation the venue has since published past", async () => {
    // The evaluation measured against canonical data that is no longer the
    // venue's latest. Activating on it would gate a new version on numbers
    // measured against a different one.
    const venue = await publishedVenue("Stale");
    const packageId = await ingestCorridor(venue);
    await evaluate(venue, packageId);
    const upload = multipart(await buildMinimalImdfZip(), "v2.zip", "application/zip");
    await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/versions`,
      headers: { cookie: venue.cookie, ...upload.headers },
      payload: upload.payload,
    });
    await venue.app.queue.idle();

    const { statusCode, body } = await activate(venue, packageId);

    expect(statusCode).toBe(409);
    expect(body["code"]).toBe("evaluation_stale");
  });

  it("requires a producer session", async () => {
    const venue = await publishedVenue("Guarded");
    const packageId = await ingestCorridor(venue);

    const response = await venue.app.inject({
      method: "POST",
      url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
      payload: { capabilityProfile: "webgl2-mrt-float" },
    });

    expect(response.statusCode).toBe(401);
  });
});
