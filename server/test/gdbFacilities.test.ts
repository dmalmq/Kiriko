/**
 * Combined GDB import: point-facility extraction unit tests plus the
 * `POST /api/gdb/inspect-facilities` and facilities-aware
 * `POST /api/gdb/publish` route tests.
 *
 * gdal3.js is faked at the `../src/gdb/gdal` module boundary (the real WASM
 * runtime never sees these synthetic archives — see gdbRoutes.test.ts for why
 * crafted archives must not reach it), and `compileVenueBundle` is faked at
 * the `../src/core/native` boundary so the publish job records exactly which
 * facilities GeoJSON the compile step received. Mirrors gdbNetwork.test.ts.
 */
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeModule from "../src/core/native";
import { extractFacilitiesGeoJson } from "../src/gdb/facilities";
import { GdbSourceError } from "../src/gdb/sourceValidation";
import {
  cleanupTestApps,
  loginCookie,
  makeTestApp,
  useInProcessGdal,
} from "./helpers";
import { resetSpawnWorkerForTests } from "../src/gdb/gdalProcess";

interface CountRow {
  n: number;
}
/** Mutable fake-GDAL/compile state, hoisted so the mock factories can close over it. */
const fake = vi.hoisted(() => ({
  ogrinfoLayers: [] as Array<Record<string, unknown>>,
  /** GeoJSON text served by the fake `ogr2ogr`, keyed by requested layer name. */
  layerOutputs: new Map<string, string>(),
  /** GeoJSON text served by the fake `getFileBytes`, keyed by ogr2ogr output name. */
  files: new Map<string, string>(),
  /** `(source, metadata)` seen by the fake `compileVenueBundle`. */
  compileCalls: [] as Array<{ source: unknown; metadata: Record<string, unknown> }>,
  /** When set, the fake `exportVenueNetwork` throws a no_graph CoreExportError. */
  exportThrowsNoGraph: false,
}));

/** Build the fake gdal instance the in-process worker runs `runGdalRequest` against. */
function makeFakeGdal() {
  return {
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
}

vi.mock("../src/core/native", async (importOriginal) => {
  const actual = await importOriginal<typeof NativeModule>();
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
    exportVenueNetwork: async () => {
      if (fake.exportThrowsNoGraph) {
        throw new actual.CoreExportError("no_graph", "bundle carries no routing graph");
      }
      return {
        junctions: '{"type":"FeatureCollection","name":"net_junction","features":[]}',
        paths: '{"type":"FeatureCollection","name":"net_path","features":[]}',
      };
    },
  };
});

vi.mock("../src/gdb/exportGdb", () => ({
  packageNetworkGdbZip: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
}));

function featureCollection(features: unknown[]): string {
  return JSON.stringify({ type: "FeatureCollection", features });
}

const FACILITIES_GEOJSON = featureCollection([
  { type: "Feature", properties: { floor: "1" }, geometry: { type: "Point", coordinates: [139.0, 35.0] } },
  { type: "Feature", properties: { floor: "2" }, geometry: { type: "Point", coordinates: [139.0005, 35.0] } },
  { type: "Feature", properties: { floor: "1" }, geometry: { type: "Point", coordinates: [139.0, 35.0005] } },
  { type: "Feature", properties: { floor: "2" }, geometry: { type: "Point", coordinates: [139.0005, 35.0005] } },
]);

const JUNCTIONS_GEOJSON = featureCollection([
  { type: "Feature", properties: { FLOOR: "1" }, geometry: { type: "Point", coordinates: [139.0, 35.0] } },
]);

const PATHS_GEOJSON = featureCollection([
  {
    type: "Feature",
    properties: { FLOOR: "1" },
    geometry: { type: "LineString", coordinates: [[139.0, 35.0], [139.0005, 35.0]] },
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

const FACILITY_LAYERS = [
  { name: "Facility_Merge" },
  { name: "net_junction" },
  { name: "net_path" },
];

/** Zip that passes `validateGdbArchive`: one `.gdb` root with a well-formed system catalog header. */
async function validGdbZipBytes(rootName = "facilities.gdb"): Promise<Uint8Array> {
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
  const boundary = "----kirikoGdbFacilitiesBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="facilities.gdb.zip"\r\n` +
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

function failPublishJobInserts(app: FastifyInstance): void {
  app.db.exec(`
    CREATE TRIGGER fail_publication_job_insert
    BEFORE INSERT ON jobs
    WHEN NEW.kind = 'publish_imdf'
    BEGIN
      SELECT RAISE(ABORT, 'simulated job insert failure');
    END;
  `);
}

function countVersions(app: FastifyInstance): number {
  const row = app.db.prepare("SELECT COUNT(*) AS n FROM versions").get() as CountRow;
  return row.n;
}

async function createVenue(app: FastifyInstance, cookie: string, name = "Facility Venue"): Promise<number> {
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
  venueName: "Facility Venue",
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
  fake.ogrinfoLayers = [...FACILITY_LAYERS];
  fake.layerOutputs.clear();
  fake.files.clear();
  fake.compileCalls.length = 0;
  fake.exportThrowsNoGraph = false;
  fake.layerOutputs.set("Facility_Merge", FACILITIES_GEOJSON);
  fake.layerOutputs.set("net_junction", JUNCTIONS_GEOJSON);
  fake.layerOutputs.set("net_path", PATHS_GEOJSON);
  fake.layerOutputs.set("Levels", LEVELS_GEOJSON);
  useInProcessGdal(makeFakeGdal());
});

afterEach(() => {
  resetSpawnWorkerForTests();
});
afterEach(cleanupTestApps);

describe("extractFacilitiesGeoJson", () => {
  it("returns the facility count, sorted distinct floors, and the raw GeoJSON text", async () => {
    const result = await extractFacilitiesGeoJson("/tmp/fake-facilities.gdb.zip");

    expect(result.facilityCount).toBe(4);
    expect(result.floors).toEqual(["1", "2"]);
    expect(result.geojson).toBe(FACILITIES_GEOJSON);
  });

  it("throws GdbSourceError missing_facility_layer when the facility layer is absent", async () => {
    fake.ogrinfoLayers = [{ name: "net_junction" }, { name: "Concourse" }];

    const error = await extractFacilitiesGeoJson("/tmp/fake-facilities.gdb.zip").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GdbSourceError);
    expect((error as GdbSourceError).code).toBe("missing_facility_layer");
  });
});

describe("POST /api/gdb/inspect-facilities", () => {
  it("stages the upload and returns the facility summary", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const multipart = multipartZip(await validGdbZipBytes());

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-facilities",
      headers: { cookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      facilitiesBlobHash: string;
      facilityCount: number;
      floors: string[];
    };
    expect(body.facilitiesBlobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.facilityCount).toBe(4);
    expect(body.floors).toEqual(["1", "2"]);
    // The staged blob is content-addressed and retrievable for the later publish.
    expect(app.blobs.has(body.facilitiesBlobHash)).toBe(true);
  });

  it("rejects an archive without the facility layer as 400 missing_facility_layer", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    fake.ogrinfoLayers = [{ name: "Concourse" }, { name: "Rooms" }];
    const multipart = multipartZip(await validGdbZipBytes());

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-facilities",
      headers: { cookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "missing_facility_layer" });
  });

  it("rejects a non-geodatabase archive before GDAL", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("facilities.gdb/a00000001.gdbtable", new TextReader("not a geodatabase"));
    const multipart = multipartZip(await writer.close());

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/inspect-facilities",
      headers: { cookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_geodatabase" });
  });
});

describe("POST /api/gdb/publish with facilitiesBlobHash", () => {
  it("compiles with the extracted facilities GeoJSON and publishes one gdb version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    const facilitiesBlobHash = putBlob(app, await validGdbZipBytes("facilities.gdb"));

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, networkBlobHash, facilitiesBlobHash, plan: PUBLISH_PLAN },
    });

    expect(response.statusCode, response.body).toBe(202);
    const accepted = response.json() as { jobId: string; versionId: number; seq: number };
    expect(accepted.seq).toBe(1);

    await app.queue.idle();

    expect(fake.compileCalls.length).toBe(1);
    const { metadata } = fake.compileCalls[0]!;
    expect(metadata["facilitiesGeoJson"]).toBe(FACILITIES_GEOJSON);
    expect(metadata["networkJunctionsGeoJson"]).toBe(JUNCTIONS_GEOJSON);
    expect(metadata["networkPathsGeoJson"]).toBe(PATHS_GEOJSON);
    expect(metadata["version"]).toBe(1);

    const version = app.db
      .prepare("SELECT status, source_kind AS sourceKind FROM versions WHERE id = ?")
      .get(accepted.versionId) as { status: string; sourceKind: string };
    expect(version.status).toBe("published");
    expect(version.sourceKind).toBe("gdb");
  });

  it("leaves a facilities-less publish exactly as before", async () => {
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
    expect(metadata["facilitiesGeoJson"]).toBeUndefined();
    expect(metadata["networkJunctionsGeoJson"]).toBeUndefined();
    expect(metadata["networkPathsGeoJson"]).toBeUndefined();
  });

  it("404s on a missing facilities blob and publishes nothing", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, facilitiesBlobHash: "0".repeat(64), plan: PUBLISH_PLAN },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "facilities_blob_not_found" });
    const versionCount = app.db
      .prepare("SELECT COUNT(*) AS n FROM versions")
      .get() as CountRow;
    expect(versionCount.n).toBe(0);
  });

  it("400s with missing_facility_layer on a facilities archive without the layer, publishing nothing", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const facilitiesBlobHash = putBlob(app, await validGdbZipBytes("facilities.gdb"));
    fake.ogrinfoLayers = [{ name: "net_junction" }];

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, facilitiesBlobHash, plan: PUBLISH_PLAN },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "missing_facility_layer" });
    const versionCount = app.db
      .prepare("SELECT COUNT(*) AS n FROM versions")
      .get() as CountRow;
    expect(versionCount.n).toBe(0);
  });
});

describe("GDB publish persists reprocess inputs", () => {
  it("stores raw GDB blob, plan, and bundle-input refs on the version row", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    const facilitiesBlobHash = putBlob(app, await validGdbZipBytes("facilities.gdb"));

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, networkBlobHash, facilitiesBlobHash, plan: PUBLISH_PLAN },
    });
    expect(response.statusCode, response.body).toBe(202);
    const { versionId } = response.json() as { versionId: number };
    await app.queue.idle();

    const row = app.db
      .prepare(
        "SELECT gdb_source_blob_hash AS g, gdb_plan_json AS p, net_junctions_blob_hash AS j, net_paths_blob_hash AS t, facilities_blob_hash AS f FROM versions WHERE id = ?",
      )
      .get(versionId) as { g: string; p: string; j: string; t: string; f: string };
    expect(row.g).toBe(blobHash);
    expect(JSON.parse(row.p).layers.length).toBeGreaterThan(0);
    expect(row.j).toMatch(/^[0-9a-f]{64}$/);
    expect(row.t).toMatch(/^[0-9a-f]{64}$/);
    expect(row.f).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GDB publish carries clipToSelection through TypeBox and the job payload", () => {
  it("plan.clipToSelection: true survives validation, persistence, and the enqueued job payload", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));

    const response = await app.inject({
      method: "POST",
      url: "/api/gdb/publish",
      headers: { cookie },
      payload: { venueId, blobHash, plan: { ...PUBLISH_PLAN, clipToSelection: true } },
    });
    expect(response.statusCode, response.body).toBe(202);
    const { jobId, versionId } = response.json() as { jobId: string; versionId: number };
    await app.queue.idle();

    const version = app.db
      .prepare("SELECT gdb_plan_json AS p FROM versions WHERE id = ?")
      .get(versionId) as { p: string };
    expect(JSON.parse(version.p).clipToSelection).toBe(true);

    // The important half: proves TypeBox let the field through the route
    // AND that it landed in the job payload (enqueuePublication's third
    // argument), not silently dropped or attached to the version draft only.
    const job = app.db
      .prepare("SELECT payload_json AS p FROM jobs WHERE id = ?")
      .get(jobId) as { p: string };
    expect(JSON.parse(job.p).clipToSelection).toBe(true);

    // Confirms the chain continues past this task's boundary into the
    // publish runner (Task 4's `metadata.clipToVenue = true`).
    expect(fake.compileCalls.length).toBe(1);
    expect(fake.compileCalls[0]!.metadata["clipToVenue"]).toBe(true);
  });

  it("an omitted clipToSelection normalizes to false everywhere and behaves as before", async () => {
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
    const { jobId, versionId } = response.json() as { jobId: string; versionId: number };
    await app.queue.idle();

    const version = app.db
      .prepare("SELECT gdb_plan_json AS p, status AS status FROM versions WHERE id = ?")
      .get(versionId) as { p: string; status: string };
    expect(JSON.parse(version.p).clipToSelection).toBe(false);
    expect(version.status).toBe("published");

    const job = app.db
      .prepare("SELECT payload_json AS p FROM jobs WHERE id = ?")
      .get(jobId) as { p: string };
    expect(JSON.parse(job.p).clipToSelection).toBe(false);

    expect(fake.compileCalls.length).toBe(1);
    expect(fake.compileCalls[0]!.metadata["clipToVenue"]).toBeUndefined();
  });
});

describe("GDB publish inherits prior bundle inputs when omitted", () => {
  it("a re-publish without network reuses the prior published version's routing", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));

    const first = await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId, blobHash, networkBlobHash, plan: PUBLISH_PLAN },
    });
    expect(first.statusCode, first.body).toBe(202);
    await app.queue.idle();
    const v1 = (first.json() as { versionId: number }).versionId;
    const v1Refs = app.db
      .prepare("SELECT net_junctions_blob_hash AS j, net_paths_blob_hash AS t FROM versions WHERE id = ?")
      .get(v1) as { j: string; t: string };

    fake.compileCalls.length = 0;
    const second = await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId, blobHash, plan: PUBLISH_PLAN },
    });
    expect(second.statusCode, second.body).toBe(202);
    await app.queue.idle();
    const v2 = (second.json() as { versionId: number }).versionId;

    const v2Refs = app.db
      .prepare("SELECT net_junctions_blob_hash AS j, net_paths_blob_hash AS t FROM versions WHERE id = ?")
      .get(v2) as { j: string; t: string };
    expect(v2Refs.j).toBe(v1Refs.j);
    expect(v2Refs.t).toBe(v1Refs.t);
    expect(fake.compileCalls[0]!.metadata["networkJunctionsGeoJson"]).toBe(JUNCTIONS_GEOJSON);
  });
});

describe("POST /api/gdb/augment", () => {
  async function publishBase(
    app: FastifyInstance,
    cookie: string,
  ): Promise<{ venueId: number; baseImdf: string }> {
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const r = await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId, blobHash, plan: PUBLISH_PLAN },
    });
    expect(r.statusCode, r.body).toBe(202);
    await app.queue.idle();
    const vid = (r.json() as { versionId: number }).versionId;
    const row = app.db.prepare("SELECT source_blob_hash AS s FROM versions WHERE id = ?").get(vid) as { s: string };
    return { venueId, baseImdf: row.s };
  }

  it("adds routing to an existing dataset as a new version reusing the base IMDF", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const { venueId, baseImdf } = await publishBase(app, cookie);
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    fake.compileCalls.length = 0;

    const res = await app.inject({
      method: "POST", url: "/api/gdb/augment", headers: { cookie },
      payload: { venueId, networkBlobHash },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { versionId, seq } = res.json() as { versionId: number; seq: number };
    expect(seq).toBe(2);
    await app.queue.idle();

    const row = app.db
      .prepare("SELECT source_blob_hash AS s, net_junctions_blob_hash AS j FROM versions WHERE id = ?")
      .get(versionId) as { s: string; j: string };
    expect(row.s).toBe(baseImdf);
    expect(row.j).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.compileCalls[0]!.metadata["networkJunctionsGeoJson"]).toBe(JUNCTIONS_GEOJSON);
  });

  it("carries forward prior facilities when only routing is added", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const facilitiesBlobHash = putBlob(app, await validGdbZipBytes("facilities.gdb"));
    await app.inject({ method: "POST", url: "/api/gdb/publish", headers: { cookie }, payload: { venueId, blobHash, facilitiesBlobHash, plan: PUBLISH_PLAN } });
    await app.queue.idle();
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    fake.compileCalls.length = 0;

    const res = await app.inject({ method: "POST", url: "/api/gdb/augment", headers: { cookie }, payload: { venueId, networkBlobHash } });
    expect(res.statusCode, res.body).toBe(202);
    await app.queue.idle();
    expect(fake.compileCalls[0]!.metadata["facilitiesGeoJson"]).toBe(FACILITIES_GEOJSON);
    expect(fake.compileCalls[0]!.metadata["networkJunctionsGeoJson"]).toBe(JUNCTIONS_GEOJSON);
  });


  it("rolls back the draft version when queue job insertion fails", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const { venueId } = await publishBase(app, cookie);
    const before = countVersions(app);
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    failPublishJobInserts(app);

    const res = await app.inject({
      method: "POST", url: "/api/gdb/augment", headers: { cookie },
      payload: { venueId, networkBlobHash },
    });

    expect(res.statusCode).toBe(500);
    expect(countVersions(app)).toBe(before);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE status = 'draft'").get()).toEqual({ n: 0 });
  });

  it("400 when neither network nor facilities is provided", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const { venueId } = await publishBase(app, cookie);
    const res = await app.inject({ method: "POST", url: "/api/gdb/augment", headers: { cookie }, payload: { venueId } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "no_augment_data" });
  });

  it("404 when the venue has no published base version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    const res = await app.inject({ method: "POST", url: "/api/gdb/augment", headers: { cookie }, payload: { venueId, networkBlobHash } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_base_version" });
  });
});

describe("GET /api/venues/:id/gdb-mapping", () => {
  it("returns the stored raw-GDB inspection and plan for a gdb dataset", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    await app.inject({ method: "POST", url: "/api/gdb/publish", headers: { cookie }, payload: { venueId, blobHash, plan: PUBLISH_PLAN } });
    await app.queue.idle();

    const res = await app.inject({ method: "GET", url: `/api/venues/${venueId}/gdb-mapping`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { blobHash: string; inspection: unknown; plan: { layers: unknown[] } };
    expect(body.blobHash).toBe(blobHash);
    expect(Array.isArray(body.plan.layers)).toBe(true);
    expect(body.inspection).toBeTruthy();
  });

  it("404 no_editable_mapping when the venue has no gdb version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const res = await app.inject({ method: "GET", url: `/api/venues/${venueId}/gdb-mapping`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_editable_mapping" });
  });
});

describe("venue listing editableMapping", () => {
  it("marks a gdb dataset as editableMapping in the venue listing", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId, blobHash, plan: PUBLISH_PLAN },
    });
    await app.queue.idle();
    const res = await app.inject({ method: "GET", url: "/api/venues", headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { venues: Array<{ id: number; editableMapping: boolean }> };
    const v = body.venues.find((x) => x.id === venueId);
    expect(v?.editableMapping).toBe(true);
  });
});

describe("POST /api/gdb/generate-network", () => {
  async function publishBaseWithFacilities(app: FastifyInstance, cookie: string): Promise<number> {
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const facilitiesBlobHash = putBlob(app, await validGdbZipBytes("facilities.gdb"));
    const r = await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId, blobHash, facilitiesBlobHash, plan: PUBLISH_PLAN },
    });
    expect(r.statusCode, r.body).toBe(202);
    await app.queue.idle();
    return venueId;
  }

  it("synthesizes routing as a new version reusing the base IMDF and carrying facilities", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await publishBaseWithFacilities(app, cookie);
    const base = app.db
      .prepare("SELECT source_blob_hash AS s, facilities_blob_hash AS f FROM versions WHERE venue_id = ? ORDER BY seq DESC LIMIT 1")
      .get(venueId) as { s: string; f: string };
    fake.compileCalls.length = 0;

    const res = await app.inject({
      method: "POST", url: "/api/gdb/generate-network", headers: { cookie },
      payload: { venueId },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { versionId, seq } = res.json() as { versionId: number; seq: number };
    expect(seq).toBe(2);
    await app.queue.idle();

    const row = app.db
      .prepare("SELECT source_blob_hash AS s, net_junctions_blob_hash AS j, net_paths_blob_hash AS t, facilities_blob_hash AS f FROM versions WHERE id = ?")
      .get(versionId) as { s: string; j: string | null; t: string | null; f: string | null };
    expect(row.s).toBe(base.s);
    expect(row.j).toBeNull();
    expect(row.t).toBeNull();
    expect(row.f).toBe(base.f);
    expect(fake.compileCalls[0]!.metadata["synthesizeNetwork"]).toBe(true);
    expect(fake.compileCalls[0]!.metadata["networkJunctionsGeoJson"]).toBeUndefined();
    expect(fake.compileCalls[0]!.metadata["facilitiesGeoJson"]).toBe(FACILITIES_GEOJSON);
  });


  it("rolls back the draft version when queue job insertion fails", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await publishBaseWithFacilities(app, cookie);
    const before = countVersions(app);
    failPublishJobInserts(app);

    const res = await app.inject({
      method: "POST", url: "/api/gdb/generate-network", headers: { cookie },
      payload: { venueId },
    });

    expect(res.statusCode).toBe(500);
    expect(countVersions(app)).toBe(before);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE status = 'draft'").get()).toEqual({ n: 0 });
  });

  it("404 no_base_version when the venue has no published version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const res = await app.inject({
      method: "POST", url: "/api/gdb/generate-network", headers: { cookie },
      payload: { venueId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_base_version" });
  });

  it("fails with no_routable_network when synthesis produces no graph", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await publishBaseWithFacilities(app, cookie);
    fake.exportThrowsNoGraph = true; // simulate an empty synthesized graph
    fake.compileCalls.length = 0;

    const res = await app.inject({
      method: "POST", url: "/api/gdb/generate-network", headers: { cookie },
      payload: { venueId },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { versionId: number };
    await app.queue.idle();

    const row = app.db
      .prepare("SELECT status, error FROM versions WHERE id = ?")
      .get(body.versionId) as { status: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.error!).code).toBe("no_routable_network");
  });
});

describe("POST /api/gdb/import-network", () => {
  async function publishBase(
    app: FastifyInstance,
    cookie: string,
    name: string,
  ): Promise<{ venueId: number; slug: string; publicVersionId: string }> {
    const venueId = await createVenue(app, cookie, name);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const r = await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId, blobHash, plan: PUBLISH_PLAN },
    });
    expect(r.statusCode).toBe(202);
    await app.queue.idle();
    const venueRow = app.db.prepare("SELECT slug FROM venues WHERE id = ?").get(venueId) as { slug: string };
    const pubRow = app.db
      .prepare(
        "SELECT public_id AS p FROM versions WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1",
      )
      .get(venueId) as { p: string };
    return { venueId, slug: venueRow.slug, publicVersionId: pubRow.p };
  }

  const EMPTY_JUNCTIONS = JSON.stringify({ type: "FeatureCollection", name: "net_junction", features: [] });
  const EMPTY_PATHS = JSON.stringify({ type: "FeatureCollection", name: "net_path", features: [] });
  const ABSENT_ID = "0".repeat(64);

  it("publishes an edited graph as a new real-network version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const { slug, publicVersionId } = await publishBase(app, cookie, "Editable Venue");

    fake.compileCalls.length = 0;
    const res = await app.inject({
      method: "POST", url: "/api/gdb/import-network", headers: { cookie },
      payload: { slug, publicVersionId, junctions: EMPTY_JUNCTIONS, paths: EMPTY_PATHS },
    });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { jobId: string; versionId: number; seq: number; publicVersionId: string };
    await app.queue.idle();

    const row = app.db
      .prepare("SELECT public_id AS p, net_junctions_blob_hash AS j, synthesized AS syn FROM versions WHERE id = ?")
      .get(body.versionId) as { p: string; j: string | null; syn: number };
    expect(body.publicVersionId).toMatch(/^[0-9a-f]{64}$/);
    expect(row.p).toBe(body.publicVersionId);
    expect(row.j).not.toBeNull();
    expect(row.syn).toBe(0);
    expect(fake.compileCalls[0]!.metadata["networkJunctionsGeoJson"]).toBe(EMPTY_JUNCTIONS);
    expect(fake.compileCalls[0]!.metadata["synthesizeNetwork"]).toBeUndefined();
  });


  it("rolls back the draft version when queue job insertion fails", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const { slug, publicVersionId } = await publishBase(app, cookie, "Atomic Import Venue");
    const before = countVersions(app);
    failPublishJobInserts(app);

    const res = await app.inject({
      method: "POST", url: "/api/gdb/import-network", headers: { cookie },
      payload: { slug, publicVersionId, junctions: EMPTY_JUNCTIONS, paths: EMPTY_PATHS },
    });

    expect(res.statusCode).toBe(500);
    expect(countVersions(app)).toBe(before);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE status = 'draft'").get()).toEqual({ n: 0 });
  });
  it("bases the edited graph on the admitted version identity, not mutable latest", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const { venueId, slug, publicVersionId: v1Id } = await publishBase(app, cookie, "Pinned Base");
    // v2 augments the base with facilities and becomes the new latest.
    const facilitiesBlobHash = putBlob(app, await validGdbZipBytes("facilities.gdb"));
    const aug = await app.inject({
      method: "POST", url: "/api/gdb/augment", headers: { cookie },
      payload: { venueId, facilitiesBlobHash },
    });
    expect(aug.statusCode, aug.body).toBe(202);
    await app.queue.idle();
    const v1 = app.db.prepare("SELECT facilities_blob_hash AS f FROM versions WHERE public_id = ?").get(v1Id) as {
      f: string | null;
    };
    expect(v1.f).toBeNull(); // the admitted base carries no facilities

    const res = await app.inject({
      method: "POST", url: "/api/gdb/import-network", headers: { cookie },
      payload: { slug, publicVersionId: v1Id, junctions: EMPTY_JUNCTIONS, paths: EMPTY_PATHS },
    });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { versionId: number };
    await app.queue.idle();
    const edited = app.db
      .prepare("SELECT facilities_blob_hash AS f, net_junctions_blob_hash AS j FROM versions WHERE id = ?")
      .get(body.versionId) as { f: string | null; j: string | null };
    expect(edited.j).not.toBeNull(); // the edited graph is stored
    expect(edited.f).toBeNull(); // carries v1's (absent) facilities, never latest v2's
  });

  it("404s an unknown or cross-venue base identity", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const { slug } = await publishBase(app, cookie, "Venue A");
    const { publicVersionId: venueBId } = await publishBase(app, cookie, "Venue B");

    const crossVenue = await app.inject({
      method: "POST", url: "/api/gdb/import-network", headers: { cookie },
      payload: { slug, publicVersionId: venueBId, junctions: EMPTY_JUNCTIONS, paths: EMPTY_PATHS },
    });
    expect(crossVenue.statusCode).toBe(404);
    expect(crossVenue.json()).toMatchObject({ error: "no_base_version" });

    const unknown = await app.inject({
      method: "POST", url: "/api/gdb/import-network", headers: { cookie },
      payload: { slug, publicVersionId: ABSENT_ID, junctions: EMPTY_JUNCTIONS, paths: EMPTY_PATHS },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "no_base_version" });
  });

  it("404 no_base_version when the venue has no published version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie, "Bare Venue");
    const row = app.db.prepare("SELECT slug FROM venues WHERE id = ?").get(venueId) as { slug: string };
    const res = await app.inject({
      method: "POST", url: "/api/gdb/import-network", headers: { cookie },
      payload: { slug: row.slug, publicVersionId: ABSENT_ID, junctions: "{}", paths: "{}" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_base_version" });
  });
});

describe("venue listing hasNetwork", () => {
  it("marks a network dataset hasNetwork:true and a venue-only one false", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const plainId = await createVenue(app, cookie, "Plain Venue");
    const plainBlob = putBlob(app, await validGdbZipBytes("venue.gdb"));
    await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId: plainId, blobHash: plainBlob, plan: PUBLISH_PLAN },
    });
    await app.queue.idle();

    const netId = await createVenue(app, cookie, "Network Venue");
    const netVenueBlob = putBlob(app, await validGdbZipBytes("venue.gdb"));
    await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId: netId, blobHash: netVenueBlob, plan: PUBLISH_PLAN },
    });
    await app.queue.idle();
    const networkBlobHash = putBlob(app, await validGdbZipBytes("net.gdb"));
    const aug = await app.inject({
      method: "POST", url: "/api/gdb/augment", headers: { cookie },
      payload: { venueId: netId, networkBlobHash },
    });
    expect(aug.statusCode, aug.body).toBe(202);
    await app.queue.idle();

    const res = await app.inject({ method: "GET", url: "/api/venues", headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { venues: Array<{ id: number; hasNetwork: boolean }> };
    expect(body.venues.find((v) => v.id === netId)?.hasNetwork).toBe(true);
    expect(body.venues.find((v) => v.id === plainId)?.hasNetwork).toBe(false);
  });
});

describe("POST /api/gdb/export-network", () => {
  async function publishBase(app: FastifyInstance, cookie: string): Promise<number> {
    const venueId = await createVenue(app, cookie);
    const blobHash = putBlob(app, await validGdbZipBytes("venue.gdb"));
    const r = await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId, blobHash, plan: PUBLISH_PLAN },
    });
    expect(r.statusCode, r.body).toBe(202);
    await app.queue.idle();
    return venueId;
  }

  it("streams the latest published network as an attachment .gdb.zip", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await publishBase(app, cookie);
    const res = await app.inject({
      method: "POST", url: "/api/gdb/export-network", headers: { cookie },
      payload: { venueId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(String(res.headers["content-disposition"])).toContain(".gdb.zip");
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it("404 no_base_version when the venue has no published version", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await createVenue(app, cookie);
    const res = await app.inject({
      method: "POST", url: "/api/gdb/export-network", headers: { cookie },
      payload: { venueId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_base_version" });
  });

  it("404 no_graph when the published bundle carries no routing graph", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venueId = await publishBase(app, cookie);
    fake.exportThrowsNoGraph = true;
    const res = await app.inject({
      method: "POST", url: "/api/gdb/export-network", headers: { cookie },
      payload: { venueId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "no_graph" });
  });
});

describe("venue listing hasGraph", () => {
  it("marks a synthesized dataset hasGraph:true and a plain IMDF one false", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const plainId = await createVenue(app, cookie, "Plain Venue");
    const plainBlob = putBlob(app, await validGdbZipBytes("venue.gdb"));
    await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId: plainId, blobHash: plainBlob, plan: PUBLISH_PLAN },
    });
    await app.queue.idle();

    const genId = await createVenue(app, cookie, "Generated Venue");
    const genBlob = putBlob(app, await validGdbZipBytes("venue.gdb"));
    await app.inject({
      method: "POST", url: "/api/gdb/publish", headers: { cookie },
      payload: { venueId: genId, blobHash: genBlob, plan: PUBLISH_PLAN },
    });
    await app.queue.idle();
    const gen = await app.inject({
      method: "POST", url: "/api/gdb/generate-network", headers: { cookie },
      payload: { venueId: genId },
    });
    expect(gen.statusCode, gen.body).toBe(202);
    await app.queue.idle();

    const res = await app.inject({ method: "GET", url: "/api/venues", headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { venues: Array<{ id: number; hasGraph: boolean }> };
    expect(body.venues.find((v) => v.id === genId)?.hasGraph).toBe(true);
    expect(body.venues.find((v) => v.id === plainId)?.hasGraph).toBe(false);
  });
});
