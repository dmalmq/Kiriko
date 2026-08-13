/**
 * Serving an activated package's render document (#75).
 *
 * The document is derived once, when the producer activates — not per request.
 * A 172 MiB package cannot be re-derived on every viewer load, and deriving it
 * at activation is also what makes the bytes immutable: they belong to the
 * version the activation produced, so a pinned URL can promise they never
 * change.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import { collectTileBlobs } from "../src/tiles/storage";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { tilesetFixture } from "../../tests/fixtures/tileFixtures";
import { corridorPackageGlb, rootTransform } from "../../tests/fixtures/tileRegistration";
import { venuePlaneFromBundle } from "./tileRegistrationFixtures";

afterEach(cleanupTestApps);

const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";
const SCENE_MAGIC = "KSC1";
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";
const LATEST_CACHE_CONTROL = "public, max-age=0, must-revalidate";

function multipart(bytes: Uint8Array, filename: string, type: string) {
  const boundary = "----kirikoTileSceneBoundary";
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
  slug: string;
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
  const venue = created.json<{ venue: { id: number; slug: string } }>().venue;
  const upload = multipart(await buildMinimalImdfZip(), "v.zip", "application/zip");
  await app.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/versions`,
    headers: { cookie, ...upload.headers },
    payload: upload.payload,
  });
  await app.queue.idle();
  const row = app.db
    .prepare(
      `SELECT bundle_hash AS bundleHash FROM versions
       WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
    )
    .get(venue.id) as { bundleHash: string };
  return { app, cookie, venueId: venue.id, slug: venue.slug, bundleHash: row.bundleHash };
}

/** Ingest, evaluate, and activate a package that registers cleanly. */
async function activatedVenue(name: string): Promise<Venue & { packageId: number }> {
  const venue = await publishedVenue(name);
  const plane = await venuePlaneFromBundle(venue.app.blobs.read(venue.bundleHash), LEVEL_B1);
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  await writer.add(
    "tileset.json",
    new Uint8ArrayReader(tilesetFixture("content/model.glb", rootTransform())),
  );
  await writer.add("content/model.glb", new Uint8ArrayReader(corridorPackageGlb(0, plane)));
  const upload = multipart(Buffer.from(await writer.close()), "tiles.zip", "application/zip");
  const ingested = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/tiles/inspect`,
    headers: { cookie: venue.cookie, ...upload.headers },
    payload: upload.payload,
  });
  expect(ingested.statusCode, ingested.body).toBe(201);
  const { packageId } = ingested.json<{ packageId: number }>();

  const evaluated = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/tiles/${packageId}/registration`,
    headers: { cookie: venue.cookie },
    payload: { capabilityProfile: "webgl2-mrt-float" },
  });
  expect(evaluated.json<{ gates: unknown[] }>().gates).toEqual([]);

  const activated = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.venueId}/tiles/${packageId}/activate`,
    headers: { cookie: venue.cookie },
    payload: { mappingConfirmed: true },
  });
  expect(activated.statusCode, activated.body).toBe(202);
  await venue.app.queue.idle();
  return { ...venue, packageId };
}

describe("tile scene serving", () => {
  it("serves the derived render document for an activated version", async () => {
    const venue = await activatedVenue("Scene");

    const response = await venue.app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/scene`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.subarray(0, 4).toString("ascii")).toBe(SCENE_MAGIC);
    expect(response.headers["content-type"]).toContain("application/vnd.kiriko.scene");
    expect(response.headers["cache-control"]).toBe(LATEST_CACHE_CONTROL);
    expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("pins the scene to a version and caches it immutably", async () => {
    const venue = await activatedVenue("Pinned");
    const latest = await venue.app.inject({ method: "GET", url: `/v/default/${venue.slug}/scene` });
    const versionId = latest.headers["kiriko-version-id"];

    const pinned = await venue.app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/scene@${String(versionId)}`,
    });

    expect(pinned.statusCode).toBe(200);
    expect(pinned.headers["cache-control"]).toBe(PINNED_CACHE_CONTROL);
    expect(pinned.rawPayload.equals(latest.rawPayload)).toBe(true);
  });

  it("revalidates with the hash ETag rather than resending the document", async () => {
    const venue = await activatedVenue("Revalidate");
    const first = await venue.app.inject({ method: "GET", url: `/v/default/${venue.slug}/scene` });

    const second = await venue.app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/scene`,
      headers: { "if-none-match": String(first.headers["etag"]) },
    });

    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
  });

  it("has no scene for a version with no activated package", async () => {
    const venue = await publishedVenue("Generated only");

    const response = await venue.app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/scene`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("no_tile_scene");
  });

  it("keeps the derived scene alive against collection", async () => {
    // The scene is tile content in the shared store. A sweep that did not know
    // about it would delete the geometry the activated version renders.
    const venue = await activatedVenue("Collected");

    const collected = collectTileBlobs(venue.app.db, venue.app.blobs);

    expect(collected.released).toBe(0);
    const response = await venue.app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/scene`,
    });
    expect(response.statusCode).toBe(200);
  });
});
