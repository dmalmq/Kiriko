/**
 * Data-gated Stage 1 acceptance on the registered JR East Tokyo Station
 * dataset: the published bundle's compiled §9 generated scene must carry
 * every primitive class and provenance, on real station data.
 *
 * The dataset is NOT in this repository (see `docs/gdb-data-reference.md`):
 * it lives at `KIRIKO_TOKYO_FIXTURES` (default `<repo>/../tokyo station/`),
 * and when absent the whole suite skips. Run where the dataset lives:
 *
 *   KIRIKO_TOKYO_FIXTURES=/path/to/tokyo\ station pnpm --dir server exec vitest run test/stage1Tokyo.test.ts
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import initWasm, { decodeBundle, levelElevations } from "@kiriko/wasm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GdbInspectResponse, NetworkInspectResponse } from "../src/gdb/types";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

const TOKYO_DIR =
  process.env.KIRIKO_TOKYO_FIXTURES ??
  join(dirname(fileURLToPath(import.meta.url)), "../../../tokyo station");
const VENUE_GDB = join(TOKYO_DIR, "JRTokyoSta_3857.gdb");
const NETWORK_GDB = join(TOKYO_DIR, "network_WebMercator.gdb");
const DATA_PRESENT = existsSync(VENUE_GDB) && existsSync(NETWORK_GDB);

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
  const boundary = "----kirikoTokyoStage1Boundary";
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

describe.skipIf(!DATA_PRESENT)("Stage 1 scene acceptance on the registered Tokyo dataset", () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = join(dirname(require.resolve("@kiriko/wasm")), "kiriko_wasm_bg.wasm");
    await initWasm({ module_or_path: await readFile(wasmPath) });
  }, 300_000);

  it("publishes the dataset and the compiled bundle carries a complete generated scene", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "JR East Tokyo Station (Stage 1)" },
    });
    expect(create.statusCode).toBe(201);
    const venueId = (create.json() as { venue: { id: number } }).venue.id;

    const upload = multipartZip(await zipDirectory(VENUE_GDB), "JRTokyoSta_3857.gdb.zip");
    const inspect = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect",
      headers: { cookie, ...upload.headers },
      payload: upload.payload,
    });
    expect(inspect.statusCode, inspect.body).toBe(200);
    const inspected = inspect.json() as GdbInspectResponse;

    const netUpload = multipartZip(await zipDirectory(NETWORK_GDB), "network_WebMercator.gdb.zip");
    const inspectNetwork = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-network",
      headers: { cookie, ...netUpload.headers },
      payload: netUpload.payload,
    });
    expect(inspectNetwork.statusCode, inspectNetwork.body).toBe(200);
    const network = inspectNetwork.json() as NetworkInspectResponse;

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

    const response = decodeBundle(bundle);
    expect(response.ok, response.error?.message).toBe(true);
    expect(response.capabilities).toMatchObject({
      spatialContext: { state: "available" },
      sceneSources: { state: "available" },
    });
    const elevations = levelElevations(bundle) as Array<{ state: string }>;
    expect(elevations.length).toBeGreaterThan(0);
    expect(elevations.every((e) => e.state === "resolved")).toBe(true);
  }, 600_000);
});
