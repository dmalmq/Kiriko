/**
 * `POST /api/gdb/inspect`, `POST /api/gdb/inspect-network`, and
 * `POST /api/gdb/publish`.
 *
 * Inspect stages the uploaded `.gdb.zip` as a content-addressed blob and
 * returns the OGR layer summary plus the blob hash; inspect-network does the
 * same for a routing-network archive, returning the net_junction/net_path
 * node/edge/floor summary. Publish re-opens that blob
 * by hash, converts the reviewed layers to WGS84 GeoJSON via gdal3.js,
 * synthesizes an IMDF archive, stores it as a fresh blob, inserts a
 * `source_kind='gdb'` version row pointing at the synthesized IMDF, and
 * enqueues the existing `publish_imdf` job — which then compiles the IMDF
 * through the Rust core exactly like a direct IMDF upload. When the request
 * carries `networkBlobHash`, the network blob's `net_junction`/`net_path`
 * layers are extracted to GeoJSON, stored as blobs, and referenced from the
 * job payload so the compile embeds the routing graph as bundle section 5.
 *
 * No per-session GDAL state crosses HTTP requests: both endpoints re-open the
 * blob via `/vsizip/<blob-path>`. The job queue serializes the heavy compile
 * regardless; the conversion in the publish handler is fast for typical
 * station-scale geodatabases.
 */
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireProducerSession, requireSession } from "../auth/guard";
import { inspectGdbArchive, convertGdbLayers } from "./convert";
import { extractFacilitiesGeoJson } from "./facilities";
import { GdbConversionError, normalizeGdbPlan, resolveGdbImdfWithExclusions, suggestGdbMapping } from "./mapping";
import { extractNetworkGeoJson } from "./network";
import { writeImdfZip } from "./imdfZip";
import { GdbSourceError, validateGdbArchive } from "./sourceValidation";
import { removeStagedGdb, stageGdbBlobForGdal } from "./staging";
import type {
  FacilitiesExtraction,
  FacilitiesInspectResponse,
  GdbInspectResponse,
  GdbInspection,
  GdbPublishRequest,
  NetworkExtraction,
  NetworkInspectResponse,
} from "./types";
import { newPublicVersionId } from "../venues/uploadRoute";
import { exportVenueNetwork, CoreExportError } from "../core/native";
import { packageNetworkGdbZip } from "./exportGdb";
import { storedPlanClipsToSelection } from "./plan";

const TENANT_ID = 1;


// The GDAL process queue (gdalProcess.ts) now enforces a real, cancelling
// per-operation deadline, so route-level GDAL calls no longer need an
// in-process timeout wrapper. Its returned promise also settles only after the
// worker has exited, so `removeStagedGdb` in a `finally` after the await runs
// with no live worker holding the staged file.

const GdbLayerKeySchema = Type.Object({
  databaseId: Type.String(),
  layerName: Type.String(),
});

const GdbLevelRuleSchema = Type.Union([
  Type.Object({ kind: Type.Literal("source-reference"), field: Type.String() }),
  Type.Object({ kind: Type.Literal("property"), field: Type.String() }),
  Type.Object({ kind: Type.Literal("layer-name") }),
  Type.Object({ kind: Type.Literal("fixed"), label: Type.String(), ordinal: Type.Number() }),
]);

const GdbLayerPlanSchema = Type.Object({
  key: GdbLayerKeySchema,
  included: Type.Boolean(),
  targetType: Type.Union([
    Type.Literal("level"),
    Type.Literal("unit"),
    Type.Literal("opening"),
    Type.Literal("detail"),
    Type.Literal("fixture"),
    Type.Literal("kiosk"),
    Type.Literal("amenity"),
    Type.Literal("occupant"),
    Type.Null(),
  ]),
  buildingId: Type.Union([Type.String(), Type.Null()]),
  levelRule: Type.Union([GdbLevelRuleSchema, Type.Null()]),
  idField: Type.Union([Type.String(), Type.Null()]),
  ordinalField: Type.Union([Type.String(), Type.Null()]),
  shortNameField: Type.Union([Type.String(), Type.Null()]),
  nameField: Type.Union([Type.String(), Type.Null()]),
  categoryField: Type.Union([Type.String(), Type.Null()]),
});

const GdbMappingPlanSchema = Type.Object({
  venueName: Type.String({ minLength: 1, maxLength: 200 }),
  buildings: Type.Array(
    Type.Object({ id: Type.String(), name: Type.String({ minLength: 1, maxLength: 200 }) }),
  ),
  layers: Type.Array(GdbLayerPlanSchema),
  clipToSelection: Type.Optional(Type.Boolean()),
});

const GdbPublishSchema = Type.Object({
  venueId: Type.Integer({ minimum: 1 }),
  blobHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  plan: GdbMappingPlanSchema,
  networkBlobHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  facilitiesBlobHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
});

const ErrorSchema = Type.Object({
  error: Type.String(),
  code: Type.String(),
  details: Type.Optional(Type.Unknown()),
});

const AuthErrorSchema = Type.Object({
  error: Type.String(),
  code: Type.String(),
  message: Type.String(),
});

interface ErrorBody {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

function errorBody(code: string, message: string, details?: Record<string, unknown>): ErrorBody {
  return details === undefined ? { error: message, code } : { error: message, code, details };
}

function isGdbSourceError(error: unknown): error is GdbSourceError {
  return error instanceof GdbSourceError;
}
function isGdbConversionError(error: unknown): error is GdbConversionError {
  return error instanceof GdbConversionError;
}

/**
 * Stage a network `.gdb.zip` blob, extract `net_junction`/`net_path` to
 * GeoJSON, store both as content-addressed blobs, and return their hashes.
 * Throws (GdbSourceError or the raw extraction error) on a bad archive.
 */
async function extractAndStoreNetwork(
  server: FastifyInstance,
  networkBlobHash: string,
): Promise<{ junctionsHash: string; pathsHash: string }> {
  const staged = stageGdbBlobForGdal(server.blobs.path(networkBlobHash), networkBlobHash);
  let network: NetworkExtraction;
  try {
    network = await extractNetworkGeoJson(staged);
  } finally {
    removeStagedGdb(staged);
  }
  const junctionsBlob = server.blobs.put(Buffer.from(network.junctions, "utf8"));
  const pathsBlob = server.blobs.put(Buffer.from(network.paths, "utf8"));
  const insertBlob = server.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)");
  insertBlob.run(junctionsBlob.hash, junctionsBlob.size);
  insertBlob.run(pathsBlob.hash, pathsBlob.size);
  return { junctionsHash: junctionsBlob.hash, pathsHash: pathsBlob.hash };
}

/**
 * Stage a facilities `.gdb.zip` blob, extract the facilities GeoJSON, store
 * it as a content-addressed blob, and return its hash. Throws on a bad archive.
 */
async function extractAndStoreFacilities(
  server: FastifyInstance,
  facilitiesBlobHash: string,
): Promise<string> {
  const staged = stageGdbBlobForGdal(server.blobs.path(facilitiesBlobHash), facilitiesBlobHash);
  let facilities: FacilitiesExtraction;
  try {
    facilities = await extractFacilitiesGeoJson(staged);
  } finally {
    removeStagedGdb(staged);
  }
  const facilitiesBlob = server.blobs.put(Buffer.from(facilities.geojson, "utf8"));
  server.db
    .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
    .run(facilitiesBlob.hash, facilitiesBlob.size);
  return facilitiesBlob.hash;
}

/**
 * Register the inspect + publish endpoints. The shared blob store and job
 * queue are reached through the Fastify server decorations installed in
 * `buildApp`.
 */
export function registerGdbRoutes(app: FastifyInstance): void {
  app.post(
    "/api/gdb/inspect",
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: Type.Object({
            blobHash: Type.String(),
            inspection: Type.Unknown(),
            suggestedPlan: Type.Unknown(),
          }),
          400: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send(errorBody("file_required", "file_required"));
      }
      const bytes = await file.toBuffer();
      let rootName: string;
      try {
        const validated = await validateGdbArchive(bytes);
        rootName = validated.rootName;
      } catch (error) {
        if (isGdbSourceError(error)) {
          return reply
            .code(400)
            .send(errorBody(error.code, error.message, error.details));
        }
        request.log.error({ err: error }, "gdb inspect validation failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }

      const { hash, size } = request.server.blobs.put(bytes);
      request.server.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
        .run(hash, size);
      const stagedPath = stageGdbBlobForGdal(request.server.blobs.path(hash), hash);
      let inspection: GdbInspection;
      try {
        inspection = await inspectGdbArchive(stagedPath, rootName);
      } catch (error) {
        request.log.warn({ err: error }, "gdb inspect failed");
        return reply.code(400).send(
          errorBody("gdb_inspection_failed", "gdb_inspection_failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        removeStagedGdb(stagedPath);
      }
      const body: GdbInspectResponse = {
        blobHash: hash,
        inspection,
        suggestedPlan: suggestGdbMapping(inspection),
      };
      return reply.send(body);
    },
  );

  app.post(
    "/api/gdb/inspect-network",
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: Type.Object({
            networkBlobHash: Type.String(),
            nodeCount: Type.Integer(),
            edgeCount: Type.Integer(),
            floors: Type.Array(Type.String()),
          }),
          400: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send(errorBody("file_required", "file_required"));
      }
      const bytes = await file.toBuffer();
      try {
        await validateGdbArchive(bytes);
      } catch (error) {
        if (isGdbSourceError(error)) {
          return reply
            .code(400)
            .send(errorBody(error.code, error.message, error.details));
        }
        request.log.error({ err: error }, "gdb network inspect validation failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }

      const { hash, size } = request.server.blobs.put(bytes);
      request.server.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
        .run(hash, size);
      const stagedPath = stageGdbBlobForGdal(request.server.blobs.path(hash), hash);
      let network: NetworkExtraction;
      try {
        network = await extractNetworkGeoJson(stagedPath);
      } catch (error) {
        if (isGdbSourceError(error)) {
          return reply
            .code(400)
            .send(errorBody(error.code, error.message, error.details));
        }
        request.log.warn({ err: error }, "gdb network inspect failed");
        return reply.code(400).send(
          errorBody("gdb_network_extraction_failed", "gdb_network_extraction_failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        removeStagedGdb(stagedPath);
      }
      const body: NetworkInspectResponse = {
        networkBlobHash: hash,
        nodeCount: network.nodeCount,
        edgeCount: network.edgeCount,
        floors: network.floors,
      };
      return reply.send(body);
    },
  );

  app.post(
    "/api/gdb/inspect-facilities",
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: Type.Object({
            facilitiesBlobHash: Type.String(),
            facilityCount: Type.Integer(),
            floors: Type.Array(Type.String()),
          }),
          400: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send(errorBody("file_required", "file_required"));
      }
      const bytes = await file.toBuffer();
      try {
        await validateGdbArchive(bytes);
      } catch (error) {
        if (isGdbSourceError(error)) {
          return reply
            .code(400)
            .send(errorBody(error.code, error.message, error.details));
        }
        request.log.error({ err: error }, "gdb facilities inspect validation failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }

      const { hash, size } = request.server.blobs.put(bytes);
      request.server.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
        .run(hash, size);
      const stagedPath = stageGdbBlobForGdal(request.server.blobs.path(hash), hash);
      let facilities: FacilitiesExtraction;
      try {
        facilities = await extractFacilitiesGeoJson(stagedPath);
      } catch (error) {
        if (isGdbSourceError(error)) {
          return reply
            .code(400)
            .send(errorBody(error.code, error.message, error.details));
        }
        request.log.warn({ err: error }, "gdb facilities inspect failed");
        return reply.code(400).send(
          errorBody("gdb_facilities_extraction_failed", "gdb_facilities_extraction_failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        removeStagedGdb(stagedPath);
      }
      const body: FacilitiesInspectResponse = {
        facilitiesBlobHash: hash,
        facilityCount: facilities.facilityCount,
        floors: facilities.floors,
      };
      return reply.send(body);
    },
  );

  app.post(
    "/api/gdb/publish",
    {
      preHandler: requireSession,
      schema: {
        body: GdbPublishSchema,
        response: {
          202: Type.Object({
            jobId: Type.String(),
            versionId: Type.Number(),
            seq: Type.Number(),
            excludedLayers: Type.Array(
              Type.Object({ layer: Type.String(), reason: Type.String() }),
            ),
          }),
          400: ErrorSchema,
          404: Type.Object({ error: Type.String() }),
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as GdbPublishRequest;
      const { venueId, blobHash, plan, networkBlobHash, facilitiesBlobHash } = body;

      const venue = request.server.db
        .prepare("SELECT id FROM venues WHERE id = ? AND tenant_id = ?")
        .get(venueId, TENANT_ID);
      if (!venue) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (!request.server.blobs.has(blobHash)) {
        return reply.code(404).send({ error: "blob_not_found" });
      }
      if (networkBlobHash !== undefined && !request.server.blobs.has(networkBlobHash)) {
        return reply.code(404).send({ error: "network_blob_not_found" });
      }
      if (
        facilitiesBlobHash !== undefined &&
        !request.server.blobs.has(facilitiesBlobHash)
      ) {
        return reply.code(404).send({ error: "facilities_blob_not_found" });
      }

      const includedLayerNames = plan.layers
        .filter((layer) => layer.included && layer.targetType !== null)
        .map((layer) => layer.key.layerName);
      if (includedLayerNames.length === 0) {
        return reply.code(400).send(errorBody("no_included_layers", "no_included_layers"));
      }

      // Extract the optional combined-import data first so a bad network or
      // facilities archive fails the request before any conversion/publish
      // side effect (no partial publish). The extracted GeoJSON is stored as
      // content-addressed blobs and referenced from the job payload, keeping
      // the publish_imdf job path stateless.
      let networkJunctionsHash: string | undefined;
      let networkPathsHash: string | undefined;
      if (networkBlobHash !== undefined) {
        try {
          const extracted = await extractAndStoreNetwork(request.server, networkBlobHash);
          networkJunctionsHash = extracted.junctionsHash;
          networkPathsHash = extracted.pathsHash;
        } catch (error) {
          if (isGdbSourceError(error)) {
            return reply.code(400).send(errorBody(error.code, error.message, error.details));
          }
          request.log.error({ err: error }, "gdb network extract failed");
          return reply.code(400).send(
            errorBody("gdb_network_extraction_failed", "gdb_network_extraction_failed", {
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      let facilitiesGeoJsonHash: string | undefined;
      if (facilitiesBlobHash !== undefined) {
        try {
          facilitiesGeoJsonHash = await extractAndStoreFacilities(request.server, facilitiesBlobHash);
        } catch (error) {
          if (isGdbSourceError(error)) {
            return reply.code(400).send(errorBody(error.code, error.message, error.details));
          }
          request.log.error({ err: error }, "gdb facilities extract failed");
          return reply.code(400).send(
            errorBody("gdb_facilities_extraction_failed", "gdb_facilities_extraction_failed", {
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      let conversion;
      const stagedPath = stageGdbBlobForGdal(
        request.server.blobs.path(blobHash),
        blobHash,
      );
      try {
        conversion = await convertGdbLayers(stagedPath, includedLayerNames);
      } catch (error) {
        request.log.error({ err: error }, "gdb convert failed");
        return reply.code(400).send(
          errorBody("gdb_conversion_failed", "gdb_conversion_failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        removeStagedGdb(stagedPath);
      }

      let archive;
      let excludedLayers: Array<{ layer: string; reason: string }> = [];
      try {
        const resolved = resolveGdbImdfWithExclusions(conversion, plan);
        archive = resolved.archive;
        excludedLayers = resolved.excludedLayers;
      } catch (error) {
        if (isGdbConversionError(error)) {
          return reply.code(400).send(
            errorBody("gdb_conversion_failed", "gdb_conversion_failed", {
              reason: error.reason,
              ...error.details,
            }),
          );
        }
        request.log.error({ err: error }, "gdb imdf build failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }

      const imdfBytes = await writeImdfZip(archive);
      const { hash: imdfHash, size: imdfSize } = request.server.blobs.put(imdfBytes);

      const db = request.server.db;
      db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(
        imdfHash,
        imdfSize,
      );
      // Reprocess rule: supplied inputs override; omitted inputs inherit the
      // venue's latest published version so re-publishing never silently drops
      // routing/facilities. New venues have no prior → inherit nothing.
      const prior = db
        .prepare(
          `SELECT net_junctions_blob_hash AS j, net_paths_blob_hash AS t, facilities_blob_hash AS f
             FROM versions WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
        )
        .get(venueId) as { j: string | null; t: string | null; f: string | null } | undefined;
      if (networkBlobHash === undefined && prior) {
        networkJunctionsHash = prior.j ?? undefined;
        networkPathsHash = prior.t ?? undefined;
      }
      if (facilitiesBlobHash === undefined && prior) {
        facilitiesGeoJsonHash = prior.f ?? undefined;
      }
      const nextSeq =
        ((db.prepare("SELECT MAX(seq) AS m FROM versions WHERE venue_id = ?").get(venueId) as {
          m: number | null;
        }).m ?? 0) + 1;
      const accepted = request.server.queue.enqueuePublication(
        "publish_imdf",
        {
          venueId,
          seq: nextSeq,
          publicId: newPublicVersionId(),
          sourceBlobHash: imdfHash,
          sourceKind: "gdb",
          gdbSourceBlobHash: blobHash,
          gdbPlanJson: JSON.stringify(normalizeGdbPlan(plan)),
          networkJunctionsBlobHash: networkJunctionsHash ?? null,
          networkPathsBlobHash: networkPathsHash ?? null,
          facilitiesBlobHash: facilitiesGeoJsonHash ?? null,
        },
        {
          networkJunctionsHash,
          networkPathsHash,
          facilitiesGeoJsonHash,
          clipToSelection: plan.clipToSelection === true,
        },
      );
      const { jobId, versionId } = accepted;
      return reply.code(202).send({ jobId, versionId, seq: nextSeq, excludedLayers });
    },
  );

  app.post(
    "/api/gdb/augment",
    {
      preHandler: requireSession,
      schema: {
        body: Type.Object({
          venueId: Type.Integer({ minimum: 1 }),
          networkBlobHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
          facilitiesBlobHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
        }),
        response: {
          202: Type.Object({ jobId: Type.String(), versionId: Type.Number(), seq: Type.Number() }),
          400: ErrorSchema,
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { venueId, networkBlobHash, facilitiesBlobHash } = request.body as {
        venueId: number;
        networkBlobHash?: string;
        facilitiesBlobHash?: string;
      };
      const db = request.server.db;
      const venue = db
        .prepare("SELECT id FROM venues WHERE id = ? AND tenant_id = ?")
        .get(venueId, TENANT_ID);
      if (!venue) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (networkBlobHash === undefined && facilitiesBlobHash === undefined) {
        return reply.code(400).send(errorBody("no_augment_data", "no_augment_data"));
      }
      if (networkBlobHash !== undefined && !request.server.blobs.has(networkBlobHash)) {
        return reply.code(404).send({ error: "network_blob_not_found" });
      }
      if (facilitiesBlobHash !== undefined && !request.server.blobs.has(facilitiesBlobHash)) {
        return reply.code(404).send({ error: "facilities_blob_not_found" });
      }
      const base = db
        .prepare(
          `SELECT source_blob_hash AS s, source_kind AS k, gdb_source_blob_hash AS g, gdb_plan_json AS p,
                  net_junctions_blob_hash AS j, net_paths_blob_hash AS t, facilities_blob_hash AS f
             FROM versions WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
        )
        .get(venueId) as
        | { s: string; k: string; g: string | null; p: string | null; j: string | null; t: string | null; f: string | null }
        | undefined;
      if (!base) {
        return reply.code(404).send({ error: "no_base_version" });
      }

      let networkJunctionsHash = base.j ?? undefined;
      let networkPathsHash = base.t ?? undefined;
      if (networkBlobHash !== undefined) {
        try {
          const extracted = await extractAndStoreNetwork(request.server, networkBlobHash);
          networkJunctionsHash = extracted.junctionsHash;
          networkPathsHash = extracted.pathsHash;
        } catch (error) {
          if (isGdbSourceError(error)) {
            return reply.code(400).send(errorBody(error.code, error.message, error.details));
          }
          request.log.error({ err: error }, "gdb augment network extract failed");
          return reply.code(400).send(
            errorBody("gdb_network_extraction_failed", "gdb_network_extraction_failed", {
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      let facilitiesGeoJsonHash = base.f ?? undefined;
      if (facilitiesBlobHash !== undefined) {
        try {
          facilitiesGeoJsonHash = await extractAndStoreFacilities(request.server, facilitiesBlobHash);
        } catch (error) {
          if (isGdbSourceError(error)) {
            return reply.code(400).send(errorBody(error.code, error.message, error.details));
          }
          request.log.error({ err: error }, "gdb augment facilities extract failed");
          return reply.code(400).send(
            errorBody("gdb_facilities_extraction_failed", "gdb_facilities_extraction_failed", {
              detail: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      const maxRow = db
        .prepare("SELECT MAX(seq) AS m FROM versions WHERE venue_id = ?")
        .get(venueId) as { m: number | null };
      const nextSeq = (maxRow.m ?? 0) + 1;
      const accepted = request.server.queue.enqueuePublication(
        "publish_imdf",
        {
          venueId,
          seq: nextSeq,
          publicId: newPublicVersionId(),
          sourceBlobHash: base.s,
          sourceKind: base.k === "gdb" ? "gdb" : "imdf",
          gdbSourceBlobHash: base.g,
          gdbPlanJson: base.p,
          networkJunctionsBlobHash: networkJunctionsHash ?? null,
          networkPathsBlobHash: networkPathsHash ?? null,
          facilitiesBlobHash: facilitiesGeoJsonHash ?? null,
        },
        {
          networkJunctionsHash,
          networkPathsHash,
          facilitiesGeoJsonHash,
          // Add-data has no clip checkbox of its own — the network/facility GDB
          // being attached here is exactly the case the venue's original clip
          // choice was made for (a full-site network with no building field).
          // Lift that choice out of the stored plan into the payload, or the
          // whole site's graph gets embedded unclipped while the version row
          // still claims `clipToSelection: true`.
          clipToSelection: storedPlanClipsToSelection(base.p),
        },
      );
      const { jobId, versionId } = accepted;
      return reply.code(202).send({ jobId, versionId, seq: nextSeq });
    },
  );

  app.post(
    "/api/gdb/generate-network",
    {
      preHandler: requireSession,
      schema: {
        body: Type.Object({
          venueId: Type.Integer({ minimum: 1 }),
        }),
        response: {
          202: Type.Object({ jobId: Type.String(), versionId: Type.Number(), seq: Type.Number() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { venueId } = request.body as { venueId: number };
      const db = request.server.db;
      const venue = db
        .prepare("SELECT id FROM venues WHERE id = ? AND tenant_id = ?")
        .get(venueId, TENANT_ID);
      if (!venue) {
        return reply.code(404).send({ error: "not_found" });
      }
      // Reuse the latest published IMDF; synthesis derives the graph from it.
      // Facilities (§7) carry forward; the real network hashes deliberately do
      // not (synthesis replaces them, so the new row leaves them NULL).
      const base = db
        .prepare(
          `SELECT source_blob_hash AS s, source_kind AS k, gdb_source_blob_hash AS g, gdb_plan_json AS p,
                  facilities_blob_hash AS f
             FROM versions WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
        )
        .get(venueId) as
        | { s: string; k: string; g: string | null; p: string | null; f: string | null }
        | undefined;
      if (!base) {
        return reply.code(404).send({ error: "no_base_version" });
      }

      const maxRow = db
        .prepare("SELECT MAX(seq) AS m FROM versions WHERE venue_id = ?")
        .get(venueId) as { m: number | null };
      const nextSeq = (maxRow.m ?? 0) + 1;
      const accepted = request.server.queue.enqueuePublication(
        "publish_imdf",
        {
          venueId,
          seq: nextSeq,
          publicId: newPublicVersionId(),
          sourceBlobHash: base.s,
          sourceKind: base.k === "gdb" ? "gdb" : "imdf",
          gdbSourceBlobHash: base.g,
          gdbPlanJson: base.p,
          facilitiesBlobHash: base.f ?? null,
          synthesized: true,
        },
        {
          facilitiesGeoJsonHash: base.f ?? undefined,
          synthesizeNetwork: true,
          // DECISION: forward the venue's stored clip choice.
          //
          // For the *graph* this is very nearly a no-op: synthesis derives the
          // network from the venue's own level/unit geometry, and `ClipRegion`
          // is built from those same polygons, so a synthesized node is inside
          // the region by construction.
          //
          // The deciding factor is §7. `facilities_blob_hash` points at the
          // *raw, unclipped* extraction from the facility GDB — clipping
          // happens at compile time in `codec.rs`, not when the blob is
          // stored. Carrying that blob forward without the flag would rebuild
          // §7 over the whole site and silently widen the venue's facilities
          // relative to the version being regenerated from.
          clipToSelection: storedPlanClipsToSelection(base.p),
        },
      );
      const { jobId, versionId } = accepted;
      return reply.code(202).send({ jobId, versionId, seq: nextSeq });
    },
  );

  app.post(
    "/api/gdb/export-network",
    {
      preHandler: requireSession,
      schema: {
        body: Type.Object({ venueId: Type.Integer({ minimum: 1 }) }),
        response: {
          400: ErrorSchema,
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { venueId } = request.body as { venueId: number };
      const db = request.server.db;
      const venue = db
        .prepare("SELECT slug FROM venues WHERE id = ? AND tenant_id = ?")
        .get(venueId, TENANT_ID) as { slug: string } | undefined;
      if (!venue) {
        return reply.code(404).send({ error: "not_found" });
      }
      const version = db
        .prepare(
          `SELECT bundle_hash AS h FROM versions
             WHERE venue_id = ? AND status = 'published' AND bundle_hash IS NOT NULL
             ORDER BY seq DESC LIMIT 1`,
        )
        .get(venueId) as { h: string } | undefined;
      if (!version || !request.server.blobs.has(version.h)) {
        return reply.code(404).send({ error: "no_base_version" });
      }
      let network: { junctions: string; paths: string };
      try {
        network = await exportVenueNetwork(request.server.blobs.read(version.h));
      } catch (error) {
        if (error instanceof CoreExportError && error.code === "no_graph") {
          return reply.code(404).send({ error: "no_graph" });
        }
        request.log.error({ err: error }, "network export failed");
        return reply.code(400).send(
          errorBody("gdb_export_failed", "gdb_export_failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      let zip: Uint8Array;
      try {
        zip = await packageNetworkGdbZip(network.junctions, network.paths);
      } catch (error) {
        request.log.error({ err: error }, "gdb export packaging failed");
        return reply.code(400).send(
          errorBody("gdb_export_failed", "gdb_export_failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return reply
        .header("content-disposition", `attachment; filename="${venue.slug}-network.gdb.zip"`)
        .type("application/zip")
        .send(Buffer.from(zip));
    },
  );

  app.post(
    "/api/gdb/import-network",
    {
      preHandler: requireProducerSession,
      // Edited graphs can be large; raise the body limit for this route only.
      bodyLimit: 64 * 1024 * 1024,
      schema: {
        body: Type.Object({
          slug: Type.String({ minLength: 1 }),
          publicVersionId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          junctions: Type.String(),
          paths: Type.String(),
        }),
        response: {
          401: AuthErrorSchema,
          403: AuthErrorSchema,
          202: Type.Object({ jobId: Type.String(), versionId: Type.Number(), seq: Type.Number(), publicVersionId: Type.String({ pattern: "^[0-9a-f]{64}$" }) }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { slug, publicVersionId, junctions, paths } = request.body as {
        slug: string;
        publicVersionId: string;
        junctions: string;
        paths: string;
      };
      const db = request.server.db;
      const venue = db
        .prepare("SELECT id FROM venues WHERE slug = ? AND tenant_id = ?")
        .get(slug, TENANT_ID) as { id: number } | undefined;
      if (!venue) {
        return reply.code(404).send({ error: "not_found" });
      }
      const venueId = venue.id;
      // Base the edited graph on the EXACT admitted published version identity,
      // not mutable latest: a concurrent publish must not silently reparent the
      // save onto a different source/facilities set. Cross-venue or unknown
      // identities never match (filtered by venue_id + public_id).
      const base = db
        .prepare(
          `SELECT source_blob_hash AS s, source_kind AS k, gdb_source_blob_hash AS g, gdb_plan_json AS p,
                  facilities_blob_hash AS f
             FROM versions WHERE venue_id = ? AND public_id = ? AND status = 'published' LIMIT 1`,
        )
        .get(venueId, publicVersionId) as
        | { s: string; k: string; g: string | null; p: string | null; f: string | null }
        | undefined;
      if (!base) {
        return reply.code(404).send({ error: "no_base_version" });
      }

      const junctionsBlob = request.server.blobs.put(Buffer.from(junctions, "utf8"));
      const pathsBlob = request.server.blobs.put(Buffer.from(paths, "utf8"));
      const insertBlob = db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)");
      insertBlob.run(junctionsBlob.hash, junctionsBlob.size);
      insertBlob.run(pathsBlob.hash, pathsBlob.size);

      const maxRow = db
        .prepare("SELECT MAX(seq) AS m FROM versions WHERE venue_id = ?")
        .get(venueId) as { m: number | null };
      const nextSeq = (maxRow.m ?? 0) + 1;
      const createdPublicVersionId = newPublicVersionId();
      const accepted = request.server.queue.enqueuePublication(
        "publish_imdf",
        {
          venueId,
          seq: nextSeq,
          publicId: createdPublicVersionId,
          sourceBlobHash: base.s,
          sourceKind: base.k === "gdb" ? "gdb" : "imdf",
          gdbSourceBlobHash: base.g,
          gdbPlanJson: base.p,
          networkJunctionsBlobHash: junctionsBlob.hash,
          networkPathsBlobHash: pathsBlob.hash,
          facilitiesBlobHash: base.f ?? null,
        },
        {
          networkJunctionsHash: junctionsBlob.hash,
          networkPathsHash: pathsBlob.hash,
          facilitiesGeoJsonHash: base.f ?? undefined,
          // DECISION: forward the venue's stored clip choice.
          //
          // The competing view — "a hand-edited graph should be taken as-is" —
          // loses on two counts. First, `clipToSelection` is a single flag
          // covering both §5 and §7, and §7 here is rebuilt from the *raw,
          // unclipped* `facilities_blob_hash`; dropping the flag would widen
          // the venue's facilities back to the whole site behind the editor's
          // back. Second, the graph being re-imported was exported from this
          // venue's own already-clipped bundle (`/api/gdb/export-network`
          // reads §5), so re-clipping is near-idempotent: the only nodes it
          // can drop are ones placed more than `CLIP_BUFFER_M` outside every
          // level/unit polygon of the venue — exactly the out-of-venue
          // geometry the flag exists to remove. A clipped venue stays clipped
          // across a graph edit.
          clipToSelection: storedPlanClipsToSelection(base.p),
        },
      );
      const { jobId, versionId } = accepted;
      return reply.code(202).send({ jobId, versionId, seq: nextSeq, publicVersionId: createdPublicVersionId });
    },
  );

  app.get(
    "/api/venues/:id/gdb-mapping",
    {
      preHandler: requireSession,
      schema: {
        params: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
        response: {
          200: Type.Object({
            blobHash: Type.String(),
            inspection: Type.Unknown(),
            plan: Type.Unknown(),
          }),
          400: ErrorSchema,
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const db = request.server.db;
      const venue = db
        .prepare("SELECT id FROM venues WHERE id = ? AND tenant_id = ?")
        .get(id, TENANT_ID);
      if (!venue) {
        return reply.code(404).send({ error: "not_found" });
      }
      const row = db
        .prepare(
          `SELECT gdb_source_blob_hash AS g, gdb_plan_json AS p
             FROM versions WHERE venue_id = ? AND gdb_source_blob_hash IS NOT NULL
             ORDER BY seq DESC LIMIT 1`,
        )
        .get(id) as { g: string; p: string } | undefined;
      if (!row || !request.server.blobs.has(row.g)) {
        return reply.code(404).send({ error: "no_editable_mapping" });
      }
      let rootName: string;
      try {
        const validated = await validateGdbArchive(request.server.blobs.read(row.g));
        rootName = validated.rootName;
      } catch (error) {
        request.log.error({ err: error }, "gdb mapping validation failed");
        return reply.code(404).send({ error: "no_editable_mapping" });
      }
      const stagedPath = stageGdbBlobForGdal(request.server.blobs.path(row.g), row.g);
      let inspection: GdbInspection;
      try {
        inspection = await inspectGdbArchive(stagedPath, rootName);
      } catch (error) {
        request.log.warn({ err: error }, "gdb mapping inspect failed");
        return reply.code(400).send(
          errorBody("gdb_inspection_failed", "gdb_inspection_failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        removeStagedGdb(stagedPath);
      }
      return reply.send({ blobHash: row.g, inspection, plan: normalizeGdbPlan(JSON.parse(row.p)) });
    },
  );
}
