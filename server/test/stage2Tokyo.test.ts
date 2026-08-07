/**
 * Data-gated Stage 2 acceptance on the registered JR East Tokyo Station
 * dataset: the compiled render document must hold the renderer's structural
 * budgets on real station data, not only on the three-floor fixture.
 *
 * The collapse floor is the reason this test exists. Merging geometry per
 * `(level, role)` is what keeps a visible floor inside eight draw calls, and on
 * a fixture with a few dozen primitives that ratio is meaningless — it only
 * becomes a property worth asserting at station scale (#26 section 4).
 *
 * The dataset is NOT in this repository (see `docs/gdb-data-reference.md`): it
 * lives at `KIRIKO_TOKYO_FIXTURES` (default `<repo>/../tokyo station/`), and
 * when absent the whole suite skips. Run where the dataset lives:
 *
 *   KIRIKO_TOKYO_FIXTURES=/path/to/tokyo\ station pnpm --dir server exec vitest run test/stage2Tokyo.test.ts
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import initWasm, { generatedScene } from "@kiriko/wasm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GdbInspectResponse, NetworkInspectResponse } from "../src/gdb/types";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

const TOKYO_DIR =
  process.env.KIRIKO_TOKYO_FIXTURES ??
  join(dirname(fileURLToPath(import.meta.url)), "../../../tokyo station");
const VENUE_GDB = join(TOKYO_DIR, "JRTokyoSta_3857.gdb");
const NETWORK_GDB = join(TOKYO_DIR, "network_WebMercator.gdb");
const DATA_PRESENT = existsSync(VENUE_GDB) && existsSync(NETWORK_GDB);

/** #26 section 4's structural budgets. */
const DRAW_CALLS_PER_LEVEL = 8;
const DRAW_CALLS_ALL_LEVELS = 320;
const MIN_PRIMITIVE_COLLAPSE = 15;
const DECODE_BUDGET_MS = 1_200;

/** The render document's described shape, as the wasm serializes it. */
interface SceneMeta {
  header: { sourceHash: string; boundsMin: [number, number, number]; boundsMax: [number, number, number] };
  levels: { canonicalId: string; resolvedPlaneZ: number }[];
  features: { sourceObjectId: string; role: string; levelIndex: number }[];
  batches: { levelIndex: number; role: string; vertexCount: number }[];
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

function multipartZip(
  bytes: Uint8Array,
  filename: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----kirikoTokyoStage2Boundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

afterEach(cleanupTestApps);

describe.skipIf(!DATA_PRESENT)("Stage 2 renderer budgets on the registered Tokyo dataset", () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = join(dirname(require.resolve("@kiriko/wasm")), "kiriko_wasm_bg.wasm");
    await initWasm({ module_or_path: await readFile(wasmPath) });
  }, 300_000);

  it("compiles a station-scale scene inside the renderer's structural budgets", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "JR East Tokyo Station (Stage 2)" },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ venue: { id: number } }>();
    const venueId = created.venue.id;

    const upload = multipartZip(await zipDirectory(VENUE_GDB), "JRTokyoSta_3857.gdb.zip");
    const inspect = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect",
      headers: { cookie, ...upload.headers },
      payload: upload.payload,
    });
    expect(inspect.statusCode, inspect.body).toBe(200);
    const inspected = inspect.json<GdbInspectResponse>();

    const netUpload = multipartZip(await zipDirectory(NETWORK_GDB), "network_WebMercator.gdb.zip");
    const inspectNetwork = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-network",
      headers: { cookie, ...netUpload.headers },
      payload: netUpload.payload,
    });
    expect(inspectNetwork.statusCode, inspectNetwork.body).toBe(200);
    const network = inspectNetwork.json<NetworkInspectResponse>();

    const publish = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: {
        venueId,
        blobHash: inspected.blobHash,
        plan: inspected.suggestedPlan,
        networkBlobHash: network.networkBlobHash,
      },
    });
    expect(publish.statusCode, publish.body).toBe(202);
    await app.queue.idle();

    const versionRow = app.db
      .prepare(
        `SELECT status AS status, bundle_hash AS bundleHash FROM versions WHERE venue_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(venueId);
    if (
      versionRow === null ||
      typeof versionRow !== "object" ||
      !("status" in versionRow) ||
      !("bundleHash" in versionRow) ||
      typeof versionRow.bundleHash !== "string"
    ) {
      throw new Error("publish left no version row to read");
    }
    expect(versionRow.status).toBe("published");
    const bundle = app.blobs.read(versionRow.bundleHash);

    // The same call the browser's bundle worker makes, on the same bytes.
    const started = performance.now();
    const described = generatedScene(bundle);
    const compileMs = performance.now() - started;
    const meta = JSON.parse(described.meta) as SceneMeta;

    // Collapse: source objects per merged batch. This is the property that makes
    // the draw-call budget reachable, and station data is where it is real.
    const collapse = meta.features.length / meta.batches.length;
    expect(
      collapse,
      `collapse ${collapse.toFixed(1)}x from ${meta.features.length} primitives into ` +
        `${meta.batches.length} batches`,
    ).toBeGreaterThanOrEqual(MIN_PRIMITIVE_COLLAPSE);

    // Draw calls: one per merged batch on the active level, and the whole venue
    // if every level were shown at once.
    const perLevel = new Map<number, number>();
    for (const batch of meta.batches) {
      perLevel.set(batch.levelIndex, (perLevel.get(batch.levelIndex) ?? 0) + 1);
    }
    expect(perLevel.size).toBeGreaterThan(1);
    for (const [levelIndex, calls] of perLevel) {
      expect(calls, `level ${levelIndex} draws in ${calls} calls`).toBeLessThanOrEqual(
        DRAW_CALLS_PER_LEVEL,
      );
    }
    expect(meta.batches.length).toBeLessThanOrEqual(DRAW_CALLS_ALL_LEVELS);

    // Compiling is the dominant part of the client's decode budget, and it runs
    // off the main thread there. Station scale must still fit inside it.
    expect(compileMs, `compile ${compileMs.toFixed(0)}ms`).toBeLessThanOrEqual(DECODE_BUDGET_MS);

    // The scene is real: every vertex is attributable, geometry is finite, and
    // the station spans multiple floors of it.
    expect(meta.features.length).toBeGreaterThan(1_000);
    for (const batch of meta.batches) {
      expect(batch.vertexCount % 3).toBe(0);
      const feature = meta.features.find((candidate) => candidate.levelIndex === batch.levelIndex);
      expect(feature, `batch on level ${batch.levelIndex} has features`).toBeDefined();
    }
    for (const axis of [0, 1, 2] as const) {
      const min = meta.header.boundsMin[axis];
      const max = meta.header.boundsMax[axis];
      expect(Number.isFinite(min)).toBe(true);
      expect(max).toBeGreaterThanOrEqual(min);
    }
    expect(meta.header.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    // The station exercises the classes the visual language styles differently.
    const roles = new Set(meta.features.map((feature) => feature.role));
    for (const expected of ["Walkable", "Context", "Structure", "Ceiling"]) {
      expect(roles.has(expected), `${expected} missing from ${[...roles].join(", ")}`).toBe(true);
    }

    console.log(
      `Tokyo scene: ${meta.features.length} primitives → ${meta.batches.length} batches ` +
        `(${collapse.toFixed(1)}x), ${meta.levels.length} levels, compile ${compileMs.toFixed(0)}ms`,
    );
  }, 900_000);
});
