/**
 * Combined GDB import: network extraction unit tests plus the
 * `POST /api/gdb/inspect-network` and network-aware `POST /api/gdb/publish`
 * route tests.
 *
 * gdal3.js is faked at the `../src/gdb/gdal` module boundary (the real WASM
 * runtime never sees these synthetic archives — see gdbRoutes.test.ts for why
 * crafted archives must not reach it), and `compileVenueBundle` is faked at
 * the `../src/core/native` boundary so the publish job records exactly which
 * network GeoJSON the compile step received.
 */
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractNetworkGeoJson } from "../src/gdb/network";
import { GdbSourceError } from "../src/gdb/sourceValidation";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

/** Mutable fake-GDAL/compile state, hoisted so the mock factories can close over it. */
const fake = vi.hoisted(() => ({
  ogrinfoLayers: [] as Array<Record<string, unknown>>,
  /** GeoJSON text served by the fake `ogr2ogr`, keyed by requested layer name. */
  layerOutputs: new Map<string, string>(),
  /** GeoJSON text served by the fake `getFileBytes`, keyed by ogr2ogr output name. */
  files: new Map<string, string>(),
  /** `(source, metadata)` seen by the fake `compileVenueBundle`. */
  compileCalls: [] as Array<{ source: unknown; metadata: Record<string, unknown> }>,
}));

vi.mock("../src/gdb/gdal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gdb/gdal")>();
  const fakeGdal = {
    open: async (path: string) => ({ datasets: [{ path }] }),
    ogrinfo: async () => ({ layers: fake.ogrinfoLayers }),
    ogr2ogr: async (_dataset: unknown, args: string[], outputName: string) => {
      const layerName = args[args.length - 1] ?? "";
      const content = fake.layerOutputs.get(layerName);
      if (content === undefined) {
        throw new Error(`fake gdal: no output registered for layer ${layerName}`);
      }
      fake.files.set(outputName, content);
      return { local: outputName };
    },
    getFileBytes: async (output: { local?: string }) => {
      const content = fake.files.get(String(output?.local));
      if (content === undefined) {
        throw new Error("fake gdal: unknown output file");
      }
      return new TextEncoder().encode(content);
    },
    close: async () => undefined,
    drivers: { vector: {} },
  };
  return { ...actual, getGdal: async () => fakeGdal };
});

vi.mock("../src/core/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/native")>();
  return {
    ...actual,
    compileVenueBundle: async (source: unknown, metadata: Record<string, unknown>) => {
      fake.compileCalls.push({ source, metadata });
      return {
        bundle: Buffer.from("kvb-fake-bundle"),
        stats: { levels: 1, features: 1 },
        warnings: [],
      };
    },
  };
});

function featureCollection(features: unknown[]): string {
  return JSON.stringify({ type: "FeatureCollection", features });
}

const JUNCTIONS_GEOJSON = featureCollection([
  { type: "Feature", properties: { FLOOR: "1" }, geometry: { type: "Point", coordinates: [139.0, 35.0] } },
  { type: "Feature", properties: { FLOOR: "1" }, geometry: { type: "Point", coordinates: [139.0005, 35.0] } },
  { type: "Feature", properties: { FLOOR: "2" }, geometry: { type: "Point", coordinates: [139.0, 35.0005] } },
]);

const PATHS_GEOJSON = featureCollection([
  {
    type: "Feature",
    properties: { FLOOR: "1" },
    geometry: { type: "LineString", coordinates: [[139.0, 35.0], [139.0005, 35.0]] },
  },
  {
    type: "Feature",
    properties: { FLOOR: "2" },
    geometry: { type: "LineString", coordinates: [[139.0, 35.0005], [139.0005, 35.0005]] },
  },
]);

const LEVELS_GEOJSON = featureCollection([
  {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[[139.0, 35.0], [139.001, 35.0], [139.001, 35.001], [139.0, 35.001], [139.0, 35.0]]],
    },
  },
]);

const NETWORK_LAYERS = [{ name: "net_junction" }, { name: "net_path" }];

/** Zip that passes `validateGdbArchive`: one `.gdb` root with a well-formed system catalog header. */
async function validGdbZipBytes(rootName = "net.gdb"): Promise<Uint8Array> {
  const catalog = new Uint8Array(48);
  const view = new DataView(catalog.buffer);
  view.setUint32(0, 3, true); // FileGDB header version
  view.setBigUint64(24, 48n, true); // declaredSize === entry size
  view.setBigUint64(32, 40n, true); // fieldDescriptionOffset within [40, size)
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(`${rootName}/a00000001.gdbtable`, new Uint8ArrayReader(catalog));
  await writer.add(`${rootName}/a00000001.gdbtablx`, new Uint8ArrayReader(new Uint8Array([1, 2, 3, 4])));
  return writer.close();
}

function multipartZip(bytes: Uint8Array): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----kirikoGdbNetworkBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="net.gdb.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Store bytes as a content-addressed blob exactly like the inspect endpoints do. */
function putBlob(app: FastifyInstance, bytes: Uint8Array): string {
  const { hash, size } = app.blobs.put(bytes);
  app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(hash, size);
  return hash;
}

async function createVenue(app: FastifyInstance, cookie: string, name = "Network Venue"): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return (response.json().venue as { id: number }).id;
}

const PUBLISH_PLAN = {
  venueName: "Network Venue",
  buildings: [{ id: "b1", name: "Building 1" }],
  layers: [
    {
      key: { databaseId: "gdb-1", layerName: "Levels" },
      included: true,
      targetType: "level",
      buildingId: "b1",
      levelRule: { kind: "fixed", label: "1", ordinal: 1 },
      idField: null,
      ordinalField: null,
      shortNameField: null,
      nameField: null,
      categoryField: null,
    },
  ],
};

beforeEach(() => {
  fake.ogrinfoLayers = [...NETWORK_LAYERS];
  fake.layerOutputs.clear();
  fake.files.clear();
  fake.compileCalls.length = 0;
  fake.layerOutputs.set("net_junction", JUNCTIONS_GEOJSON);
  fake.layerOutputs.set("net_path", PATHS_GEOJSON);
  fake.layerOutputs.set("Levels", LEVELS_GEOJSON);
});

afterEach(cleanupTestApps);

describe("extractNetworkGeoJson", () => {
  it("returns node/edge counts, sorted distinct floors, and the raw GeoJSON text", async () => {
    const result = await extractNetworkGeoJson("/tmp/fake-network.gdb.zip");

    expect(result.nodeCount).toBe(3);
    expect(result.edgeCount).toBe(2);
    expect(result.floors).toEqual(["1", "2"]);
    expect(result.junctions).toBe(JUNCTIONS_GEOJSON);
    expect(result.paths).toBe(PATHS_GEOJSON);
  });

  it("throws GdbSourceError missing_network_layers when a network layer is absent", async () => {
    fake.ogrinfoLayers = [{ name: "net_junction" }, { name: "Concourse" }];

    const error = await extractNetworkGeoJson("/tmp/fake-network.gdb.zip").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GdbSourceError);
    expect((error as GdbSourceError).code).toBe("missing_network_layers");
  });
});

describe("POST /api/gdb/inspect-network", () => {
  it("stages the upload and returns the network summary", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const multipart = multipartZip(await validGdbZipBytes());

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-network",
      headers: { cookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      networkBlobHash: string;
      nodeCount: number;
      edgeCount: number;
      floors: string[];
    };
    expect(body.networkBlobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.nodeCount).toBe(3);
    expect(body.edgeCount).toBe(2);
    expect(body.floors).toEqual(["1", "2"]);
    // The staged blob is content-addressed and retrievable for the later publish.
    expect(app.blobs.has(body.networkBlobHash)).toBe(true);
  });

  it("rejects an archive without the network layers as 400 missing_network_layers", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    fake.ogrinfoLayers = [{ name: "Concourse" }, { name: "Rooms" }];
    const multipart = multipartZip(await validGdbZipBytes());

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-network",
      headers: { cookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "missing_network_layers" });
  });

  it("rejects a non-geodatabase archive before GDAL", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("net.gdb/a00000001.gdbtable", new TextReader("not a geodatabase"));
    const multipart = multipartZip(await writer.close());

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-network",
      headers: { cookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_geodatabase" });
  });
});

describe("POST /api/gdb/publish with networkBlobHash", () => {
  it("compiles with the extracted network GeoJSON and publishes one gdb version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, networkBlobHash, plan: PUBLISH_PLAN },
    });

    expect(response.statusCode, response.body).toBe(202);
    const accepted = response.json() as { jobId: string; versionId: number; seq: number };
    expect(accepted.seq).toBe(1);

    await app.queue.idle();

    expect(fake.compileCalls.length).toBe(1);
    const { metadata } = fake.compileCalls[0]!;
    expect(metadata["networkJunctionsGeoJson"]).toBe(JUNCTIONS_GEOJSON);
    expect(metadata["networkPathsGeoJson"]).toBe(PATHS_GEOJSON);
    expect(metadata["version"]).toBe(1);

    const version = app.db
      .prepare("SELECT status, source_kind AS sourceKind FROM versions WHERE id = ?")
      .get(accepted.versionId) as { status: string; sourceKind: string };
    expect(version.status).toBe("published");
    expect(version.sourceKind).toBe("gdb");
  });


  it("rolls back the draft version when queue job insertion fails after network extraction", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    app.db.exec(`
      CREATE TRIGGER fail_publication_job_insert
      BEFORE INSERT ON jobs
      WHEN NEW.kind = 'publish_imdf'
      BEGIN
        SELECT RAISE(ABORT, 'simulated job insert failure');
      END;
    `);

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, networkBlobHash, plan: PUBLISH_PLAN },
    });

    expect(response.statusCode).toBe(500);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }).n).toBe(0);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
  });
  it("leaves a network-less publish exactly as before", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, plan: PUBLISH_PLAN },
    });

    expect(response.statusCode, response.body).toBe(202);
    await app.queue.idle();

    expect(fake.compileCalls.length).toBe(1);
    const { metadata } = fake.compileCalls[0]!;
    expect(metadata["networkJunctionsGeoJson"]).toBeUndefined();
    expect(metadata["networkPathsGeoJson"]).toBeUndefined();
  });

  it("404s on a missing network blob and publishes nothing", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, networkBlobHash: "0".repeat(64), plan: PUBLISH_PLAN },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "network_blob_not_found" });
    expect(
      (app.db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }).n,
    ).toBe(0);
  });

  it("400s with missing_network_layers on a network archive without the layers, publishing nothing", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    fake.ogrinfoLayers = [{ name: "net_junction" }];

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, networkBlobHash, plan: PUBLISH_PLAN },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "missing_network_layers" });
    expect(
      (app.db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }).n,
    ).toBe(0);
  });
});
