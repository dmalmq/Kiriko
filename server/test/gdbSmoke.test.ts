/**
 * Mandatory end-to-end GDB HTTP smoke test against a real, self-contained
 * `.gdb.zip`.
 *
 * The archive is authored in-process by the installed gdal3.js OpenFileGDB
 * writer (`tests/fixtures/buildMinimalGdbZip`), so this needs no external
 * file and runs in the normal server suite — there is no `KIRIKO_GDB_SMOKE`
 * gate. It exercises the real HTTP flow end to end: create a venue, inspect
 * the archive, inspect its routing network, publish the reviewed plan with the
 * network blob, drain the job queue, and confirm the published version is a
 * `gdb`-sourced bundle whose compiled `kvb1` bytes carry a §5 routing graph
 * (decoded back via the native `@kiriko/node` network exporter).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildMinimalGdbZip } from "./fixtures/buildMinimalGdbZip";
import { exportVenueNetwork } from "../src/core/native";
import type { GdbInspectResponse, NetworkInspectResponse } from "../src/gdb/types";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

function multipartZip(bytes: Uint8Array): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----kirikoGdbSmokeBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="minimal.gdb.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

afterEach(cleanupTestApps);

describe("GDB endpoint smoke (self-contained gdal3.js fixture)", () => {
  let fixture: Buffer;

  beforeAll(async () => {
    // Build the compact FileGDB once via the real OpenFileGDB writer.
    fixture = await buildMinimalGdbZip();
  }, 120_000);

  it("inspects, publishes, and compiles a reviewed GDB plan with a routing graph", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie },
      payload: { name: "Minimal GDB Smoke" },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { venue: { id: number } };
    const venueId = created.venue.id;

    // Inspect the venue geometry: layers + suggested mapping plan.
    const upload = multipartZip(new Uint8Array(fixture));
    const inspect = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect",
      headers: { cookie, ...upload.headers },
      payload: upload.payload,
    });
    expect(inspect.statusCode, inspect.body).toBe(200);
    const inspected = inspect.json() as GdbInspectResponse;
    expect(inspected.blobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inspected.inspection.layers.map((l) => l.key.layerName).sort()).toEqual([
      "Facility_Merge",
      "Station_0_Floor",
      "Station_0_Space",
      "net_junction",
      "net_path",
    ]);
    const plan = inspected.suggestedPlan;
    const level = plan.layers.find((l) => l.key.layerName === "Station_0_Floor");
    const unit = plan.layers.find((l) => l.key.layerName === "Station_0_Space");
    expect(level?.targetType).toBe("level");
    expect(level?.included).toBe(true);
    expect(unit?.targetType).toBe("unit");
    expect(unit?.included).toBe(true);

    // Inspect the routing network: the reciprocal pair is two directed paths.
    const netUpload = multipartZip(new Uint8Array(fixture));
    const inspectNetwork = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-network",
      headers: { cookie, ...netUpload.headers },
      payload: netUpload.payload,
    });
    expect(inspectNetwork.statusCode, inspectNetwork.body).toBe(200);
    const network = inspectNetwork.json() as NetworkInspectResponse;
    expect(network.networkBlobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(network.nodeCount).toBe(2);
    expect(network.edgeCount).toBe(2);
    expect(network.floors).toEqual(["F1"]);

    // Publish the reviewed plan together with the network blob.
    const publish = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: {
        venueId,
        blobHash: inspected.blobHash,
        plan,
        networkBlobHash: network.networkBlobHash,
      },
    });
    expect(publish.statusCode, publish.body).toBe(202);
    const accepted = publish.json() as {
      jobId: string;
      versionId: number;
      seq: number;
      excludedLayers: Array<{ layer: string; reason: string }>;
    };
    expect(accepted.seq).toBe(1);
    expect(Array.isArray(accepted.excludedLayers)).toBe(true);

    await app.queue.idle();

    const version = app.db
      .prepare(
        `SELECT status, source_kind AS sourceKind, source_blob_hash AS sourceHash,
                bundle_hash AS bundleHash, net_junctions_blob_hash AS netJ,
                net_paths_blob_hash AS netP, stats_json AS statsJson
         FROM versions WHERE id = ?`,
      )
      .get(accepted.versionId) as {
      status: string;
      sourceKind: string;
      sourceHash: string;
      bundleHash: string | null;
      netJ: string | null;
      netP: string | null;
      statsJson: string | null;
    };
    expect(version.status).toBe("published");
    expect(version.sourceKind).toBe("gdb");
    expect(version.netJ).not.toBeNull();
    expect(version.netP).not.toBeNull();
    expect(version.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    const stats = JSON.parse(version.statsJson!) as { levels: number; features: number };
    expect(stats.levels).toBeGreaterThan(0);
    expect(stats.features).toBeGreaterThan(0);

    // The compiled bundle must carry a §5 routing graph. `exportVenueNetwork`
    // throws `CoreExportError("no_graph")` when it does not, so a non-empty
    // `net_path` FeatureCollection proves the graph survived the compile.
    const bundle = app.blobs.read(version.bundleHash!);
    const exported = await exportVenueNetwork(bundle);
    const paths = JSON.parse(exported.paths) as { features: unknown[] };
    const junctions = JSON.parse(exported.junctions) as { features: unknown[] };
    expect(paths.features.length).toBeGreaterThan(0);
    expect(junctions.features.length).toBe(2);
  }, 120_000);
});
