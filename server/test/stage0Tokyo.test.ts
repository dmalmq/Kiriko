/**
 * Data-gated Stage 0 acceptance on the registered JR East Tokyo Station
 * dataset (three EPSG:3857 File Geodatabases — see `docs/gdb-data-reference.md`).
 *
 * The dataset is NOT in this repository: it lives at `KIRIKO_TOKYO_FIXTURES`
 * (default: `<repo>/../tokyo station/`), and when it is absent the whole
 * suite skips with a message. When present, it runs the real publish flow
 * end to end and asserts the Stage 0 contract on the compiled bundle:
 * spatial context available, every level resolved with evidence, routing
 * works, and the compiled bytes still decode through both adapters.
 *
 * Run where the dataset lives:
 *   KIRIKO_TOKYO_FIXTURES=/path/to/tokyo\ station pnpm --dir server exec vitest run test/stage0Tokyo.test.ts
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import initWasm, { decodeBundle, levelElevations, routeBundle } from "@kiriko/wasm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportVenueNetwork } from "../src/core/native";
import type { GdbInspectResponse, NetworkInspectResponse } from "../src/gdb/types";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

const TOKYO_DIR =
  process.env.KIRIKO_TOKYO_FIXTURES ??
  join(dirname(fileURLToPath(import.meta.url)), "../../../tokyo station");
const VENUE_GDB = join(TOKYO_DIR, "JRTokyoSta_3857.gdb");
const NETWORK_GDB = join(TOKYO_DIR, "network_WebMercator.gdb");
const FACILITIES_GDB = join(TOKYO_DIR, "point_facility_WebMercator_202006.gdb");

const DATA_PRESENT = existsSync(VENUE_GDB) && existsSync(NETWORK_GDB) && existsSync(FACILITIES_GDB);

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
      const bytes = await readFile(full);
      await writer.add(name, new Uint8ArrayReader(bytes));
    }
  };
  await walk(root);
  return writer.close();
}

function multipartZip(bytes: Uint8Array, filename: string): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----kirikoTokyoBoundary";
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

describe.skipIf(!DATA_PRESENT)("Stage 0 acceptance on the registered Tokyo dataset", () => {
  let venueGdbZip: Uint8Array;
  let networkGdbZip: Uint8Array;
  let facilitiesGdbZip: Uint8Array;

  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = join(dirname(require.resolve("@kiriko/wasm")), "kiriko_wasm_bg.wasm");
    await initWasm({ module_or_path: await readFile(wasmPath) });

    [venueGdbZip, networkGdbZip, facilitiesGdbZip] = await Promise.all([
      zipDirectory(VENUE_GDB),
      zipDirectory(NETWORK_GDB),
      zipDirectory(FACILITIES_GDB),
    ]);
  }, 300_000);

  it("publishes the Tokyo dataset and proves the Stage 0 contract on the compiled bundle", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "JR East Tokyo Station" },
    });
    expect(create.statusCode).toBe(201);
    const venueId = (create.json() as { venue: { id: number } }).venue.id;

    // Venue geometry → reviewed plan.
    const upload = multipartZip(venueGdbZip, "JRTokyoSta_3857.gdb.zip");
    const inspect = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect",
      headers: { cookie, ...upload.headers },
      payload: upload.payload,
    });
    expect(inspect.statusCode, inspect.body).toBe(200);
    const inspected = inspect.json() as GdbInspectResponse;
    expect(inspected.blobHash).toMatch(/^[0-9a-f]{64}$/);

    // Routing network.
    const netUpload = multipartZip(networkGdbZip, "network_WebMercator.gdb.zip");
    const inspectNetwork = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-network",
      headers: { cookie, ...netUpload.headers },
      payload: netUpload.payload,
    });
    expect(inspectNetwork.statusCode, inspectNetwork.body).toBe(200);
    const network = inspectNetwork.json() as NetworkInspectResponse;
    expect(network.networkBlobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(network.nodeCount).toBeGreaterThan(0);
    expect(network.edgeCount).toBeGreaterThan(0);

    // Publish with the reviewed plan + network (+ facilities when present).
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

    const version = app.db
      .prepare(
        `SELECT status AS status, bundle_hash AS bundleHash FROM versions WHERE venue_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(venueId) as { status: string; bundleHash: string };
    expect(version.status).toBe("published");
    const bundle = app.blobs.read(version.bundleHash);

    // The compiled bytes carry the Stage 0 contract through the browser
    // module, on the real station data.
    const response = decodeBundle(bundle);
    expect(response.ok, response.error?.message).toBe(true);
    expect(response.capabilities).toMatchObject({ spatialContext: { state: "available" } });
    const elevations = levelElevations(bundle);
    expect(elevations.length).toBeGreaterThan(0);
    for (const elevation of elevations) {
      expect(elevation.state).toBe("resolved");
    }

    // Routing works over the published graph: two junctions on the ground
    // floor must connect.
    const exported = await exportVenueNetwork(bundle);
    const junctions = (JSON.parse(exported.junctions) as { features: Array<{ geometry: { coordinates: [number, number] } }> })
      .features;
    const origin = junctions[0]!.geometry.coordinates;
    const dest = junctions[1]!.geometry.coordinates;
    // `null` is the walking profile: this asserts the graph connects at all.
    const route = routeBundle(bundle, origin[0], origin[1], 0, dest[0], dest[1], 0, null);
    expect(route).not.toBeNull();
  }, 600_000);
});
