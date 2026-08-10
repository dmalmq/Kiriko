/**
 * Stage 3's end-to-end proof (#76): one package travelling the whole path, and
 * the guarantees that only hold once it has.
 *
 * The slice suites each prove their own step — ingestion refuses hostile input,
 * collection cannot delete live geometry, serving pins bytes to a version. What
 * none of them can show is that the steps compose: that the package a producer
 * uploaded is the one the gates judged, is the one an activation pinned, is the
 * one a viewer downloads, and is the one the renderer draws through the same
 * contract as the generated scene.
 *
 * Everything here runs on a package built in this repository, because the
 * registered dataset is not in it. The Tokyo acceptance (`stage3Tokyo.test.ts`)
 * is the last mile, not the proof.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { compileImdf } from "@kiriko/node";
import initWasm, { decodeScene, generatedScene } from "@kiriko/wasm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import { collectTileBlobs } from "../src/tiles/storage";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { tilesetFixture } from "../../tests/fixtures/tileFixtures";
import { corridorPackageGlb, rootTransform } from "../../tests/fixtures/tileRegistration";
import { venuePlaneFromBundle } from "./tileRegistrationFixtures";

afterEach(cleanupTestApps);

const LEVEL_B1 = "b1000001-0000-4000-8000-0000000000b1";
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The described render document, as the wasm serializes it. */
interface SceneMeta {
  header: { sourceHash: string; worldTransform: number[]; frameOriginEcef: number[] };
  levels: { canonicalId: string; sourceLevelKey: string }[];
  features: { sourceObjectId: string; canonicalId: string | null; role: string }[];
  batches: { levelIndex: number; role: string; vertexCount: number }[];
}

function multipart(bytes: Uint8Array, filename: string, type: string) {
  const boundary = "----kirikoStage3Boundary";
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
  id: number;
  slug: string;
  versionId: number;
  publicId: string;
  bundleHash: string;
}

async function publishVenue(name: string, app?: FastifyInstance): Promise<Venue> {
  const instance = app ?? (await makeTestApp()).app;
  const cookie = await loginCookie(instance);
  const created = await instance.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie },
    payload: { name },
  });
  const venue = created.json<{ venue: { id: number; slug: string } }>().venue;
  const upload = multipart(await buildMinimalImdfZip(), "v.zip", "application/zip");
  await instance.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/versions`,
    headers: { cookie, ...upload.headers },
    payload: upload.payload,
  });
  await instance.queue.idle();
  const row = instance.db
    .prepare(
      `SELECT id, public_id AS publicId, bundle_hash AS bundleHash FROM versions
       WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
    )
    .get(venue.id) as { id: number; publicId: string; bundleHash: string };
  return {
    app: instance,
    cookie,
    id: venue.id,
    slug: venue.slug,
    versionId: row.id,
    publicId: row.publicId,
    bundleHash: row.bundleHash,
  };
}

/** A package whose one floor sits on the venue's own B1 corridor. */
async function packageZip(venue: Venue, inset = 0): Promise<Buffer> {
  const plane = await venuePlaneFromBundle(venue.app.blobs.read(venue.bundleHash), LEVEL_B1);
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  await writer.add(
    "tileset.json",
    new Uint8ArrayReader(tilesetFixture("content/model.glb", rootTransform())),
  );
  await writer.add("content/model.glb", new Uint8ArrayReader(corridorPackageGlb(inset, plane)));
  return Buffer.from(await writer.close());
}

interface Member {
  path: string;
  hash: string;
  byteSize: number;
  contentType: string;
  reused: boolean;
}

async function ingest(venue: Venue, zip: Buffer): Promise<{ packageId: number; members: Member[] }> {
  const upload = multipart(zip, "tiles.zip", "application/zip");
  const response = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/tiles/inspect`,
    headers: { cookie: venue.cookie, ...upload.headers },
    payload: upload.payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ packageId: number; members: Member[] }>();
}

async function activate(venue: Venue, packageId: number): Promise<void> {
  const evaluated = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/tiles/${packageId}/registration`,
    headers: { cookie: venue.cookie },
    payload: { capabilityProfile: "webgl2-mrt-float" },
  });
  expect(evaluated.json<{ gates: unknown[] }>().gates, evaluated.body).toEqual([]);
  const activated = await venue.app.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/tiles/${packageId}/activate`,
    headers: { cookie: venue.cookie },
    payload: {},
  });
  expect(activated.statusCode, activated.body).toBe(202);
  await venue.app.queue.idle();
}

function latestVersion(venue: Venue): { id: number; publicId: string; bundleHash: string } {
  return venue.app.db
    .prepare(
      `SELECT id, public_id AS publicId, bundle_hash AS bundleHash FROM versions
       WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
    )
    .get(venue.id) as { id: number; publicId: string; bundleHash: string };
}

describe("Stage 3: the whole tile path", () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = join(dirname(require.resolve("@kiriko/wasm")), "kiriko_wasm_bg.wasm");
    await initWasm({ module_or_path: await readFile(wasmPath) });
  }, 300_000);

  it("carries one package from upload to a rendered scene", async () => {
    const venue = await publishVenue("Stage 3 path");
    const { packageId, members } = await ingest(venue, await packageZip(venue));

    await activate(venue, packageId);
    const activated = latestVersion(venue);

    // Pinned to an immutable version: the activation published a new one, and
    // the version that was current when the package was evaluated is untouched.
    expect(activated.id).not.toBe(venue.versionId);
    expect(
      venue.app.db
        .prepare("SELECT bundle_hash AS hash FROM versions WHERE id = ?")
        .get(venue.versionId),
    ).toEqual({ hash: venue.bundleHash });
    expect(
      venue.app.db
        .prepare("SELECT version_id AS id FROM version_tile_packages WHERE package_id = ?")
        .all(packageId),
    ).toEqual([{ id: activated.id }]);

    // The gates' verdict and the profile they applied are recorded with it.
    const record = venue.app.db
      .prepare(
        `SELECT state, gates_json AS gates, profile_id AS profileId,
                profile_version AS profileVersion, scene_blob_hash AS sceneHash
         FROM tile_activations WHERE package_id = ?`,
      )
      .get(packageId) as {
      state: string;
      gates: string;
      profileId: string;
      profileVersion: number;
      sceneHash: string;
    };
    expect(record.state).toBe("activated");
    expect(JSON.parse(record.gates)).toEqual([]);
    expect(`${record.profileId}@${record.profileVersion}`).toBe("default@1");

    // And it renders: the served document decodes through the same reader the
    // generated scene does, describing the venue's own floor.
    const served = await venue.app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/scene`,
    });
    expect(served.statusCode).toBe(200);
    const tiles = JSON.parse(decodeScene(served.rawPayload).meta) as SceneMeta;
    const generated = JSON.parse(
      generatedScene(venue.app.blobs.read(activated.bundleHash)).meta,
    ) as SceneMeta;

    expect(tiles.levels.map((level) => level.canonicalId)).toContain(LEVEL_B1);
    expect(tiles.header.worldTransform).toEqual(generated.header.worldTransform);
    expect(tiles.header.frameOriginEcef).toEqual(generated.header.frameOriginEcef);
    expect(tiles.features.length).toBeGreaterThan(0);
    expect(tiles.batches.length).toBeGreaterThan(0);
    // Identity is the one thing that differs, and it names the package.
    expect(tiles.header.sourceHash).not.toBe(generated.header.sourceHash);
    // The member paths the record accepted are exactly what was stored.
    expect(members.map((member) => member.path).sort()).toEqual([
      "content/model.glb",
      "tileset.json",
    ]);
  });

  it("stores every member once and releases them only when nothing needs them", async () => {
    const venue = await publishVenue("Stage 3 storage");
    const zip = await packageZip(venue);
    const { packageId, members } = await ingest(venue, zip);

    // Re-ingesting the same bytes costs nothing: the store is content-addressed
    // and the record is rewritten rather than duplicated.
    const again = await ingest(venue, zip);
    expect(again.packageId).toBe(packageId);
    expect(again.members.every((member) => member.reused)).toBe(true);
    for (const member of members) {
      expect(
        venue.app.db
          .prepare("SELECT COUNT(*) AS n FROM tile_package_members WHERE hash = ?")
          .get(member.hash),
      ).toEqual({ n: 1 });
    }

    await activate(venue, packageId);
    const sceneHash = (
      venue.app.db
        .prepare("SELECT scene_blob_hash AS hash FROM tile_activations WHERE package_id = ?")
        .get(packageId) as { hash: string }
    ).hash;

    // A referenced package survives a sweep, derived document included.
    expect(collectTileBlobs(venue.app.db, venue.app.blobs).released).toBe(0);
    for (const hash of [...members.map((member) => member.hash), sceneHash]) {
      expect(venue.app.blobs.has(hash), `blob ${hash} survives`).toBe(true);
    }

    // Deleting the venue drops the last reference, and only then are the bytes
    // released — collection reads references, never age.
    const deleted = await venue.app.inject({
      method: "DELETE",
      url: `/api/venues/${venue.id}`,
      headers: { cookie: venue.cookie },
    });
    expect(deleted.statusCode).toBeLessThan(300);
    for (const hash of [...members.map((member) => member.hash), sceneHash]) {
      expect(venue.app.blobs.has(hash), `blob ${hash} released`).toBe(false);
    }
  });

  it("serves the members that version pins, and only through that version", async () => {
    const venue = await publishVenue("Stage 3 serving");
    const { packageId, members } = await ingest(venue, await packageZip(venue));
    await activate(venue, packageId);
    const activated = latestVersion(venue);
    const glb = members.find((member) => member.path === "content/model.glb");
    if (glb === undefined) {
      throw new Error("the package has no content member");
    }
    const pinned = `/v/default/${venue.slug}/tiles@${activated.publicId}/content/model.glb`;

    const response = await venue.app.inject({ method: "GET", url: pinned });
    expect(response.statusCode).toBe(200);
    expect(response.headers["etag"]).toBe(`"${glb.hash}"`);
    expect(response.headers["cache-control"]).toBe(PINNED_CACHE_CONTROL);
    expect(response.headers["content-type"]).toContain("model/gltf-binary");
    expect(response.headers["accept-ranges"]).toBe("bytes");

    const ranged = await venue.app.inject({
      method: "GET",
      url: pinned,
      headers: { range: "bytes=0-15" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.length).toBe(16);
    expect(ranged.rawPayload).toEqual(response.rawPayload.subarray(0, 16));

    // Another venue's URL does not reach it, even though both venues exist in
    // the same store: a hash is not a capability.
    const other = await publishVenue("Stage 3 neighbour", venue.app);
    const crossed = await venue.app.inject({
      method: "GET",
      url: `/v/default/${other.slug}/tiles@${activated.publicId}/content/model.glb`,
    });
    expect(crossed.statusCode).toBe(404);
  });

  it("leaves a venue with no package exactly as it was", async () => {
    // The control. Everything above adds a storage class, a route, and a
    // section — none of it may reach a venue that never attached a package.
    const withPackage = await publishVenue("Stage 3 with tiles");
    const { packageId } = await ingest(withPackage, await packageZip(withPackage));
    await activate(withPackage, packageId);

    const plain = await publishVenue("Stage 3 plain", withPackage.app);

    // Bundle bytes: byte-identical to compiling the same source with no
    // descriptor at all. Compared against a fresh compile rather than against
    // another venue — dataset identity is part of the input, so two venues
    // never share bytes and comparing them would prove nothing.
    const compiled = await compileImdf(
      Buffer.from(await buildMinimalImdfZip()),
      `default/${plain.slug}`,
      1,
    );
    if (compiled.ok !== true || compiled.bundle === undefined) {
      throw new Error("the control compile failed");
    }
    expect(createHash("sha256").update(compiled.bundle).digest("hex")).toBe(plain.bundleHash);

    // Serving: no tile descriptor, no members, no scene.
    for (const path of ["tiles", "scene"]) {
      const response = await withPackage.app.inject({
        method: "GET",
        url: `/v/default/${plain.slug}/${path}`,
      });
      expect(response.statusCode, path).toBe(404);
    }

    // Rendering: the generated scene still compiles and carries no descriptor.
    const described = JSON.parse(
      generatedScene(withPackage.app.blobs.read(plain.bundleHash)).meta,
    ) as SceneMeta;
    expect(described.levels.map((level) => level.canonicalId)).toContain(LEVEL_B1);
    expect(described.levels.every((level) => level.sourceLevelKey === "")).toBe(true);
  });
});
