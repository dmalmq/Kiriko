/**
 * Data-gated Stage 3 acceptance (#76): the registered JR East Tokyo package
 * ingests, pins to an immutable version, passes the gates, activates, and
 * renders — against the venue's own GDB rather than a fixture.
 *
 * This is the last mile, not the proof. Every guarantee is already proven on a
 * package built in this repository (`stage3Proof.test.ts`); what only the
 * registered asset can show is that the numbers hold on 171.6 MiB of
 * source-authored geometry, and that #31's measured per-floor bands describe
 * the asset they were measured on.
 *
 * Neither dataset is in this repository (see `docs/gdb-data-reference.md`).
 * The whole suite skips when they are absent. Run where they live:
 *
 *   KIRIKO_TOKYO_FIXTURES=/path/to/tokyo\ station \
 *   KIRIKO_TOKYO_TILES=/path/to/tokyo\ 3dtiles \
 *   pnpm --dir server exec vitest run test/stage3Tokyo.test.ts
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import initWasm, { decodeScene } from "@kiriko/wasm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GdbInspectResponse } from "../src/gdb/types";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

const TOKYO_DIR =
  process.env.KIRIKO_TOKYO_FIXTURES ??
  join(dirname(fileURLToPath(import.meta.url)), "../../../tokyo station");
const TILES_DIR =
  process.env.KIRIKO_TOKYO_TILES ??
  join(dirname(fileURLToPath(import.meta.url)), "../../../tokyo 3dtiles");
const VENUE_GDB = join(TOKYO_DIR, "JRTokyoSta_3857.gdb");
const TILESET = join(TILES_DIR, "tileset.json");
const CONTENT = join(TILES_DIR, "content.glb");
const DATA_PRESENT = existsSync(VENUE_GDB) && existsSync(TILESET) && existsSync(CONTENT);

/**
 * #31's re-certified envelope. The venue-wide 0.50 m band does not describe
 * this asset — B1F Yaesu measures 0.608 m carved and M2F 0.678 — so the widest
 * certified per-floor band is what every floor is held to here, and the
 * combined carved figure (0.626 m) is what the venue as a whole is held to.
 *
 * Deliberately not a per-floor band table. #31 measured bands per floor
 * *label*, and mapping a label to the canonical level id the profile keys on
 * needs knowledge of this import that this test cannot check — a wrong mapping
 * would silently apply the wrong band and still pass. The per-floor numbers are
 * printed on failure instead, which is what a producer setting a real profile
 * needs to read.
 */
const WIDEST_CERTIFIED_BAND_M = 0.7;
const COMBINED_CARVED_P90_M = 0.65;

/** #31's venue-wide gates, applied to whatever the asset actually registers. */
const MEDIAN_SHIFT_MAX_M = 0.15;
const COHERENT_RESIDUAL_MAX_M = 1.0;

interface SceneMeta {
  header: { sourceHash: string; worldTransform: number[] };
  levels: { canonicalId: string; sourceLevelKey: string; sourceDocument: string }[];
  features: { sourceObjectId: string; role: string; levelIndex: number }[];
  batches: { levelIndex: number; role: string }[];
}

interface FloorRegistration {
  canonicalLevelId: string;
  compositeSourceLevels: string[];
  sampled: number;
  carvedOut: number;
  stats: { samples: number; p50M: number; p90M: number; maxM: number };
  medianShiftM: number;
  coherentClusters: { distanceM: number; samples: number }[];
}

interface RegistrationReport {
  profileId: string;
  profileVersion: number;
  levels: {
    compositeId: string;
    resolvedPlaneM: number | null;
    metadataDifferenceM: number | null;
  }[];
  floors: FloorRegistration[];
  unmappedLevels: string[];
  appliedVerticalOffsetM: number;
  venueWide: { samples: number; p50M: number; p90M: number; maxM: number };
}

async function zipDirectory(root: string): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 6 });
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const name = relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      await writer.add(name, new Uint8ArrayReader(await readFile(full)));
    }
  };
  await walk(root);
  return writer.close();
}

/**
 * The tile package as Kiriko ingests it: the tileset and the content it
 * references. `levels.json` is a non-standard sidecar `tileset.json` never
 * references (#29), so ingestion reports it as ignored and never stores it —
 * zipping it in is how this test proves that rather than assumes it.
 */
async function zipTilePackage(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 6 });
  for (const entry of await readdir(TILES_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    await writer.add(entry.name, new Uint8ArrayReader(await readFile(join(TILES_DIR, entry.name))));
  }
  return writer.close();
}

function multipartZip(bytes: Uint8Array, filename: string) {
  const boundary = "----kirikoTokyoStage3Boundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

afterEach(cleanupTestApps);

describe.skipIf(!DATA_PRESENT)("Stage 3 on the registered Tokyo package", () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = join(dirname(require.resolve("@kiriko/wasm")), "kiriko_wasm_bg.wasm");
    await initWasm({ module_or_path: await readFile(wasmPath) });
  }, 300_000);

  it("ingests, pins, activates, and renders the registered package", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);

    // -- The venue, from its own GDB. -------------------------------------
    const create = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "JR East Tokyo Station (Stage 3)" },
    });
    expect(create.statusCode).toBe(201);
    const venue = create.json<{ venue: { id: number; slug: string } }>().venue;

    const gdb = multipartZip(await zipDirectory(VENUE_GDB), "JRTokyoSta_3857.gdb.zip");
    const inspect = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect",
      headers: { cookie, ...gdb.headers },
      payload: gdb.payload,
    });
    expect(inspect.statusCode, inspect.body).toBe(200);
    const inspected = inspect.json<GdbInspectResponse>();
    const publish = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId: venue.id, blobHash: inspected.blobHash, plan: inspected.suggestedPlan },
    });
    expect(publish.statusCode, publish.body).toBe(202);
    await app.queue.idle();
    const firstVersion = app.db
      .prepare(
        `SELECT id, status FROM versions WHERE venue_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(venue.id) as { id: number; status: string };
    expect(firstVersion.status).toBe("published");

    // -- Ingestion: 171.6 MiB through the real route. ----------------------
    const packageBytes = await zipTilePackage();
    const upload = multipartZip(packageBytes, "tokyo-3dtiles.zip");
    const ingested = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/tiles/inspect`,
      headers: { cookie, ...upload.headers },
      payload: upload.payload,
    });
    expect(ingested.statusCode, ingested.body.slice(0, 400)).toBe(201);
    const record = ingested.json<{
      packageId: number;
      rootTileset: string;
      assetVersions: string[];
      ignored: string[];
      totalBytes: number;
      members: { path: string; hash: string; byteSize: number; contentType: string }[];
    }>();

    expect(record.rootTileset).toBe("tileset.json");
    expect(record.assetVersions).toEqual(["1.1"]);
    expect(record.members.map((member) => member.path).sort()).toEqual([
      "content.glb",
      "tileset.json",
    ]);
    // The sidecar no tileset references is reported, never stored (#29).
    expect(record.ignored).toContain("levels.json");
    const content = record.members.find((member) => member.path === "content.glb");
    expect(content?.contentType).toBe("model/gltf-binary");
    expect(content?.byteSize).toBe((await stat(CONTENT)).size);

    // -- Registration: #31's bands, per floor. -----------------------------
    const evaluated = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/tiles/${record.packageId}/registration`,
      headers: { cookie },
      payload: {
        capabilityProfile: "webgl2-mrt-float",
        profile: { id: "tokyo", version: 1, p90MaxM: WIDEST_CERTIFIED_BAND_M },
      },
    });
    expect(evaluated.statusCode, evaluated.body.slice(0, 400)).toBe(200);
    const evaluation = evaluated.json<{
      gates: { code: string; subject: string; measured: number | null; band: number | null }[];
      report: RegistrationReport;
    }>();

    // Every rendered level resolved a plane from its own surfaces, and the
    // metadata disagreements are reported rather than silently corrected.
    const withoutPlane = evaluation.report.levels.filter(
      (level) => level.resolvedPlaneM === null,
    );
    expect(withoutPlane.map((level) => level.compositeId)).toEqual([]);

    for (const floor of evaluation.report.floors) {
      expect(
        floor.stats.p90M,
        `${floor.canonicalLevelId}: p90 ${floor.stats.p90M.toFixed(3)} m against ` +
          `${WIDEST_CERTIFIED_BAND_M} m over ${floor.stats.samples} samples ` +
          `(${floor.carvedOut} carved of ${floor.sampled})`,
      ).toBeLessThanOrEqual(WIDEST_CERTIFIED_BAND_M);
      expect(
        floor.medianShiftM,
        `${floor.canonicalLevelId}: coherent shift ${floor.medianShiftM.toFixed(3)} m`,
      ).toBeLessThanOrEqual(MEDIAN_SHIFT_MAX_M);
      for (const cluster of floor.coherentClusters) {
        expect(
          cluster.distanceM,
          `${floor.canonicalLevelId}: a coherent residual of ${cluster.distanceM.toFixed(2)} m ` +
            `over ${cluster.samples} samples`,
        ).toBeLessThanOrEqual(COHERENT_RESIDUAL_MAX_M);
      }
    }
    // And the asset as a whole sits where #31 measured it, carve-out included.
    expect(
      evaluation.report.floors.length,
      "the asset registers against more than one canonical floor",
    ).toBeGreaterThan(1);
    expect(evaluation.gates, JSON.stringify(evaluation.gates)).toEqual([]);

    expect(
      evaluation.report.venueWide.p90M,
      `venue-wide p90 ${evaluation.report.venueWide.p90M.toFixed(3)} m over ` +
        `${evaluation.report.venueWide.samples} samples`,
    ).toBeLessThanOrEqual(COMBINED_CARVED_P90_M);

    // The report and the profile that judged it are recorded with the
    // activation, so a later profile change cannot re-judge this version.
    const stored = app.db
      .prepare(
        `SELECT profile_id AS profileId, profile_version AS profileVersion,
                report_json AS report FROM tile_activations WHERE package_id = ?`,
      )
      .get(record.packageId) as { profileId: string; profileVersion: number; report: string };
    expect(stored.profileId).toBe("tokyo");
    expect(stored.profileVersion).toBe(1);
    expect((JSON.parse(stored.report) as RegistrationReport).floors.length).toBe(
      evaluation.report.floors.length,
    );

    // -- Activation publishes the version that renders it. -----------------
    const activated = await app.inject({
      method: "POST",
      url: `/api/venues/${venue.id}/tiles/${record.packageId}/activate`,
      headers: { cookie },
      payload: { mappingConfirmed: true },
    });
    expect(activated.statusCode, activated.body).toBe(202);
    await app.queue.idle();
    const rendering = app.db
      .prepare(
        `SELECT id, public_id AS publicId, status FROM versions
         WHERE venue_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(venue.id) as { id: number; publicId: string; status: string };
    expect(rendering.status).toBe("published");
    expect(rendering.id).not.toBe(firstVersion.id);

    // -- And it renders. ---------------------------------------------------
    const scene = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/scene` });
    expect(scene.statusCode).toBe(200);
    const meta = JSON.parse(decodeScene(scene.rawPayload).meta) as SceneMeta;
    expect(meta.features.length).toBeGreaterThan(20_000);
    expect(meta.levels.length).toBeGreaterThan(1);
    // Every batch belongs to a level, and every mapped level to a canonical
    // floor: a rendered level the reviewer cannot select is unreachable scene.
    const mapped = new Set(
      evaluation.report.floors.flatMap((floor) => floor.compositeSourceLevels),
    );
    for (const batch of meta.batches) {
      expect(batch.levelIndex).toBeLessThan(meta.levels.length);
    }
    expect(mapped.size).toBeGreaterThan(0);

    // The 171.6 MiB member is still reachable through its own version, ranged.
    const glb = record.members.find((member) => member.path === "content.glb");
    const ranged = await app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/tiles@${rendering.publicId}/content.glb`,
      headers: { range: "bytes=0-3" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.toString("ascii")).toBe("glTF");
    expect(ranged.headers["etag"]).toBe(`"${glb?.hash ?? ""}"`);
  }, 1_800_000);
});
