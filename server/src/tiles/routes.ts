/**
 * Tile-package ingestion endpoint (#71).
 *
 * A producer uploads a 3D Tiles package to a venue. The archive's URI graph is
 * resolved and validated in Rust (`ingestTilePackage`), which refuses anything
 * that escapes the package or cannot be decoded; this route then stores the
 * accepted members in the shared content-addressed blob store and records what
 * was accepted.
 *
 * Ingestion changes no published state. It attaches an inspectable record to the
 * venue, and a producer decides separately whether the package is worth
 * activating — which is where the registration gates live (#74).
 *
 * The member bytes are extracted here rather than being returned across the
 * native boundary: the validator already told us exactly which paths the graph
 * references, and moving a 172 MiB package's bytes back through FFI to store
 * them would double its peak memory for no gain.
 */
import { Type } from "@sinclair/typebox";
import { BlobReader, ZipReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { requireProducerSession } from "../auth/guard";
import {
  CoreTileActivationError,
  CoreTilePackageError,
  CoreTileSceneError,
  deriveTileScene,
  evaluateTileActivation,
  ingestTilePackage,
  type RegistrationProfileInput,
  type TileActivationEvaluation,
  type TilePackageRecord,
} from "../core/native";
import { storedPlanClipsToSelection } from "../gdb/plan";
import { newPublicVersionId } from "../venues/uploadRoute";
import {
  descriptorFor,
  evaluationTarget,
  findEvaluation,
  storeEvaluation,
} from "./activation";
import { collectTileBlobs, discardPackage, registerTileBlob } from "./storage";

const ErrorSchema = Type.Object({
  error: Type.String(),
  code: Type.String(),
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
});

function errorBody(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): { error: string; code: string; message: string; details?: Record<string, unknown> } {
  return details === undefined
    ? { error: code, code, message }
    : { error: code, code, message, details };
}

/**
 * Read exactly the members the validator accepted out of the archive. Paths come
 * from the validated record, so this reads what was checked rather than
 * re-deciding what the package contains.
 */
async function readAcceptedMembers(
  archive: Buffer,
  record: TilePackageRecord,
): Promise<Map<string, Uint8Array>> {
  const wanted = new Map(record.members.map((member) => [member.path, member.sha256]));
  const bytesByPath = new Map<string, Uint8Array>();
  const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(archive)])));
  try {
    for (const entry of await reader.getEntries()) {
      const path = entry.filename.replaceAll("\\", "/");
      if (!wanted.has(path) || entry.directory || entry.getData === undefined) {
        continue;
      }
      bytesByPath.set(path, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await reader.close();
  }
  return bytesByPath;
}

export function registerTileRoutes(app: FastifyInstance): void {
  app.get(
    "/api/venues/:venueId/tiles",
    {
      preHandler: requireProducerSession,
      schema: {
        params: Type.Object({ venueId: Type.String() }),
        response: {
          200: Type.Object({
            packages: Type.Array(
              Type.Object({
                packageId: Type.Number(),
                sourceHash: Type.String(),
                rootTileset: Type.String(),
                assetVersions: Type.Array(Type.String()),
                extensions: Type.Array(Type.String()),
                ignored: Type.Array(Type.String()),
                totalBytes: Type.Number(),
                memberCount: Type.Number(),
                createdAt: Type.String(),
                /** Null until registration has run; not the same as measuring badly. */
                evaluation: Type.Union([
                  Type.Object({
                    state: Type.String(),
                    /** False once the venue has published since: other geometry. */
                    current: Type.Boolean(),
                    capabilityProfile: Type.Union([Type.String(), Type.Null()]),
                    profileId: Type.String(),
                    profileVersion: Type.Number(),
                    report: Type.Unknown(),
                    gates: Type.Array(
                      Type.Object({
                        code: Type.String(),
                        subject: Type.String(),
                        measured: Type.Union([Type.Number(), Type.Null()]),
                        band: Type.Union([Type.Number(), Type.Null()]),
                      }),
                    ),
                    evaluatedAt: Type.String(),
                    activatedAt: Type.Union([Type.String(), Type.Null()]),
                  }),
                  Type.Null(),
                ]),
                /** A published version serves this package. */
                serving: Type.Boolean(),
              }),
            ),
          }),
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { venueId } = request.params as { venueId: string };
      const venue = request.server.db
        .prepare("SELECT id FROM venues WHERE id = ?")
        .get(Number(venueId));
      if (venue === undefined) {
        return reply.code(404).send(errorBody("venue_not_found", "venue_not_found"));
      }

      // What a new evaluation would be measured against. Comparing each stored
      // evaluation to it here is what keeps `current` the server's answer: the
      // same comparison `activate` refuses with `evaluation_stale`, so a client
      // never has to re-derive when an activation is still allowed.
      const target = evaluationTarget(request.server.db, Number(venueId));
      const rows = request.server.db
        .prepare(
          `SELECT p.id AS packageId, p.source_hash AS sourceHash, p.root_tileset AS rootTileset,
                  p.asset_versions_json AS assetVersionsJson, p.extensions_json AS extensionsJson,
                  p.ignored_json AS ignoredJson, p.total_bytes AS totalBytes,
                  p.created_at AS createdAt,
                  (SELECT COUNT(*) FROM tile_package_members m WHERE m.package_id = p.id)
                    AS memberCount,
                  EXISTS (
                    SELECT 1
                    FROM version_tile_packages vtp
                    WHERE vtp.package_id = p.id
                      AND vtp.version_id = (
                        SELECT id FROM versions
                        WHERE venue_id = p.venue_id AND status = 'published'
                        ORDER BY seq DESC LIMIT 1
                      )
                  ) AS serving
           FROM tile_packages p
           WHERE p.venue_id = ?
           ORDER BY p.id DESC`,
        )
        .all(Number(venueId)) as {
        packageId: number;
        sourceHash: string;
        rootTileset: string;
        assetVersionsJson: string;
        extensionsJson: string;
        ignoredJson: string;
        totalBytes: number;
        createdAt: string;
        memberCount: number;
        serving: number;
      }[];

      return reply.code(200).send({
        packages: rows.map((row) => {
          const stored = findEvaluation(request.server.db, row.packageId);
          return {
            packageId: row.packageId,
            sourceHash: row.sourceHash,
            rootTileset: row.rootTileset,
            assetVersions: JSON.parse(row.assetVersionsJson) as string[],
            extensions: JSON.parse(row.extensionsJson) as string[],
            ignored: JSON.parse(row.ignoredJson) as string[],
            totalBytes: row.totalBytes,
            memberCount: row.memberCount,
            createdAt: row.createdAt,
            evaluation:
              stored === null
                ? null
                : {
                    state: stored.state,
                    current:
                      target !== null
                      && stored.evaluatedVersionId === target.versionId
                      && stored.evaluatedBundleHash === target.bundleHash,
                    capabilityProfile: stored.capabilityProfile,
                    profileId: stored.profileId,
                    profileVersion: stored.profileVersion,
                    report: stored.evaluation.report,
                    gates: stored.evaluation.gates,
                    evaluatedAt: stored.evaluatedAt,
                    activatedAt: stored.activatedAt,
                  },
            serving: row.serving === 1,
          };
        }),
      });
    },
  );

  app.post(
    "/api/venues/:venueId/tiles/inspect",
    {
      preHandler: requireProducerSession,
      schema: {
        params: Type.Object({ venueId: Type.String() }),
        response: {
          201: Type.Object({
            packageId: Type.Number(),
            sourceHash: Type.String(),
            rootTileset: Type.String(),
            assetVersions: Type.Array(Type.String()),
            extensions: Type.Array(Type.String()),
            ignored: Type.Array(Type.String()),
            totalBytes: Type.Number(),
            members: Type.Array(
              Type.Object({
                path: Type.String(),
                hash: Type.String(),
                byteSize: Type.Number(),
                contentType: Type.String(),
                kind: Type.String(),
                /** Whether the store already held these bytes. */
                reused: Type.Boolean(),
              }),
            ),
          }),
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { venueId } = request.params as { venueId: string };
      const venue = request.server.db
        .prepare("SELECT id FROM venues WHERE id = ?")
        .get(Number(venueId));
      if (venue === undefined) {
        return reply.code(404).send(errorBody("venue_not_found", "venue_not_found"));
      }

      const file = await request.file();
      if (!file) {
        return reply.code(400).send(errorBody("file_required", "file_required"));
      }
      const archive = await file.toBuffer();

      let record: TilePackageRecord;
      try {
        record = await ingestTilePackage(archive);
      } catch (error) {
        if (error instanceof CoreTilePackageError) {
          // A refused package is the producer's problem to fix, and the typed
          // code is what lets the UI say which part of their export to look at.
          const status = error.code === "bridge_error" ? 500 : 400;
          return reply.code(status).send(errorBody(error.code, error.message, error.details));
        }
        request.log.error({ err: error }, "tile package ingestion failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }

      let memberBytes: Map<string, Uint8Array>;
      try {
        memberBytes = await readAcceptedMembers(archive, record);
      } catch (error) {
        request.log.error({ err: error }, "tile package member extraction failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }

      const stored: {
        path: string;
        hash: string;
        byteSize: number;
        contentType: string;
        kind: string;
        reused: boolean;
      }[] = [];
      for (const member of record.members) {
        const bytes = memberBytes.get(member.path);
        if (bytes === undefined) {
          request.log.error({ path: member.path }, "accepted member missing from archive");
          return reply.code(500).send(errorBody("internal_error", "internal_error"));
        }
        // The store already deduplicates by content address; `reused` reports it
        // so a producer can see that a re-upload cost nothing.
        const reused = request.server.blobs.has(member.sha256);
        const put = request.server.blobs.put(bytes);
        if (put.hash !== member.sha256) {
          // The bytes stored must be the bytes validated, or the record would
          // describe content nobody checked.
          request.log.error(
            { path: member.path, expected: member.sha256, actual: put.hash },
            "member hash disagreed with the validated record",
          );
          return reply.code(500).send(errorBody("internal_error", "internal_error"));
        }
        request.server.db
          .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
          .run(put.hash, put.size);
        stored.push({
          path: member.path,
          hash: member.sha256,
          byteSize: member.byteSize,
          contentType: member.contentType,
          kind: member.kind,
          reused,
        });
      }

      // The archive itself is kept as provenance: what the producer uploaded,
      // addressed by its own hash.
      const source = request.server.blobs.put(archive);
      request.server.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
        .run(source.hash, source.size);

      const packageId = request.server.db.transaction(() => {
        // Registration happens *here*, with the rows that reference it. A blob is
        // marked as collectable tile content only in the same transaction that
        // records what needs it, so no committed state ever says "tile content,
        // referenced by nothing" — which a sweep in another process would read as
        // garbage and delete out from under this upload.
        for (const member of stored) {
          registerTileBlob(request.server.db, member.hash, member.byteSize);
        }
        registerTileBlob(request.server.db, source.hash, source.size);
        const existing = request.server.db
          .prepare("SELECT id FROM tile_packages WHERE venue_id = ? AND source_hash = ?")
          .get(Number(venueId), record.sourceHash);
        if (existing !== undefined && existing !== null && typeof existing === "object" && "id" in existing) {
          const id = Number(existing.id);
          // Re-ingesting identical bytes is idempotent: the record is rewritten
          // from the same validation rather than accumulating duplicates.
          request.server.db
            .prepare("DELETE FROM tile_package_members WHERE package_id = ?")
            .run(id);
          insertMembers(request.server, id, stored);
          return id;
        }
        const inserted = request.server.db
          .prepare(
            `INSERT INTO tile_packages
               (venue_id, source_hash, root_tileset, asset_versions_json, extensions_json,
                ignored_json, total_bytes, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            Number(venueId),
            record.sourceHash,
            record.rootTileset,
            JSON.stringify(record.assetVersions),
            JSON.stringify(record.extensions),
            JSON.stringify(record.ignored),
            record.totalBytes,
            request.user.id,
          );
        const id = Number(inserted.lastInsertRowid);
        insertMembers(request.server, id, stored);
        return id;
      })();

      return reply.code(201).send({
        packageId,
        sourceHash: record.sourceHash,
        rootTileset: record.rootTileset,
        assetVersions: record.assetVersions,
        extensions: record.extensions,
        ignored: record.ignored,
        totalBytes: record.totalBytes,
        members: stored,
      });
    },
  );

  app.delete(
    "/api/venues/:venueId/tiles/:packageId",
    {
      preHandler: requireProducerSession,
      schema: {
        params: Type.Object({ venueId: Type.String(), packageId: Type.String() }),
        response: {
          200: Type.Object({
            /** Blobs released by the sweep this discard triggered. */
            released: Type.Number(),
            bytes: Type.Number(),
          }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { venueId, packageId } = request.params as { venueId: string; packageId: string };
      const record = request.server.db
        .prepare("SELECT id FROM tile_packages WHERE id = ? AND venue_id = ?")
        .get(Number(packageId), Number(venueId));
      if (record === undefined) {
        return reply.code(404).send(errorBody("package_not_found", "package_not_found"));
      }
      // A version's scene is immutable, so a referenced package is not the
      // producer's to drop — they would be deleting geometry a viewer is
      // serving. Reported as a conflict rather than thrown.
      if (!discardPackage(request.server.db, Number(packageId))) {
        return reply.code(409).send(errorBody("package_in_use", "package_in_use"));
      }
      const collected = collectTileBlobs(request.server.db, request.server.blobs);
      return reply.code(200).send({ released: collected.released, bytes: collected.bytes });
    },
  );

  app.post(
    "/api/venues/:venueId/tiles/:packageId/registration",
    {
      preHandler: requireProducerSession,
      schema: {
        params: Type.Object({ venueId: Type.String(), packageId: Type.String() }),
        body: Type.Object({
          /** The device/renderer capability profile this activation is judged against (#26). */
          capabilityProfile: Type.Optional(Type.String()),
          /** Source objects the producer classified as contextual, with an occlusion policy. */
          contextualSourceObjects: Type.Optional(Type.Array(Type.String())),
          /** Versioned registration profile; omitted fields keep the default profile's bands. */
          profile: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        response: {
          200: Type.Object({
            state: Type.String(),
            report: Type.Unknown(),
            floorMappings: Type.Array(Type.Unknown()),
            gates: Type.Array(
              Type.Object({
                code: Type.String(),
                subject: Type.String(),
                measured: Type.Union([Type.Number(), Type.Null()]),
                band: Type.Union([Type.Number(), Type.Null()]),
              }),
            ),
          }),
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { venueId, packageId } = request.params as { venueId: string; packageId: string };
      const body = request.body as {
        capabilityProfile?: string;
        contextualSourceObjects?: string[];
        profile?: RegistrationProfileInput;
      };
      const pkg = findPackage(request.server, Number(venueId), Number(packageId));
      if (pkg === null) {
        return reply.code(404).send(errorBody("package_not_found", "package_not_found"));
      }
      const target = evaluationTarget(request.server.db, Number(venueId));
      if (target === null) {
        // Registration is measured against the venue's own canonical data.
        // There is none to measure against until something is published.
        return reply.code(409).send(errorBody("no_published_version", "no_published_version"));
      }

      const profile = body.profile ?? {};
      let evaluation: TileActivationEvaluation;
      try {
        evaluation = await evaluateTileActivation(
          request.server.blobs.read(target.bundleHash),
          pkg.contents.map((member) => request.server.blobs.read(member.hash)),
          {
            assetVersion: pkg.sourceHash,
            rootTransform: readRootTransform(request.server.blobs.read(pkg.rootTilesetHash)),
            integrityVerified: pkg.integrityVerified,
            capabilityProfile: body.capabilityProfile ?? null,
            contextualSourceObjects: body.contextualSourceObjects ?? [],
            profile,
          },
        );
      } catch (error) {
        if (error instanceof CoreTileActivationError) {
          const status = error.code === "bridge_error" ? 500 : 400;
          return reply.code(status).send(errorBody(error.code, error.message));
        }
        request.log.error({ err: error }, "tile registration failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }

      storeEvaluation(request.server.db, {
        packageId: Number(packageId),
        target,
        profile,
        capabilityProfile: body.capabilityProfile ?? null,
        evaluation,
        evaluatedBy: request.user.id,
      });

      return reply.code(200).send({
        state: "evaluated",
        report: evaluation.report,
        floorMappings: evaluation.floorMappings,
        gates: evaluation.gates,
      });
    },
  );

  app.post(
    "/api/venues/:venueId/tiles/:packageId/activate",
    {
      preHandler: requireProducerSession,
      schema: {
        params: Type.Object({ venueId: Type.String(), packageId: Type.String() }),
        body: Type.Object({
          /**
           * The producer asserts the level→floor mapping is right. Required
           * because no gate can establish it: a stack offset by roughly a storey
           * maps every level to its neighbour, and where footprints repeat the
           * residuals against the wrong floor are as small as against the right
           * one. Enforced here rather than only in the dialog — a guarantee that
           * lives in a checkbox is a guarantee anything with `curl` can skip.
           */
          mappingConfirmed: Type.Boolean(),
        }),
        response: {
          202: Type.Object({
            jobId: Type.String(),
            versionId: Type.Number(),
            seq: Type.Number(),
          }),
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { venueId, packageId } = request.params as { venueId: string; packageId: string };
      const pkg = findPackage(request.server, Number(venueId), Number(packageId));
      if (pkg === null) {
        return reply.code(404).send(errorBody("package_not_found", "package_not_found"));
      }
      const evaluation = findEvaluation(request.server.db, Number(packageId));
      if (evaluation === null) {
        // Activation is a decision about measurements. Without them there is
        // nothing to decide on, and gating would be a formality.
        return reply.code(409).send(errorBody("not_evaluated", "not_evaluated"));
      }
      // The schema guarantees the field's presence and type; this is the value.
      const { mappingConfirmed } = request.body as { mappingConfirmed: boolean };
      if (!mappingConfirmed) {
        return reply.code(409).send(errorBody("mapping_unconfirmed", "mapping_unconfirmed"));
      }
      const target = evaluationTarget(request.server.db, Number(venueId));
      if (target === null) {
        return reply.code(409).send(errorBody("no_published_version", "no_published_version"));
      }
      if (
        evaluation.evaluatedVersionId !== target.versionId ||
        evaluation.evaluatedBundleHash !== target.bundleHash
      ) {
        // The venue has published since. The stored numbers describe geometry
        // this activation would not be applied to.
        return reply.code(409).send(errorBody("evaluation_stale", "evaluation_stale"));
      }
      if (evaluation.evaluation.gates.length > 0) {
        return reply
          .code(409)
          .send(
            errorBody("activation_blocked", "activation_blocked", {
              gates: evaluation.evaluation.gates,
            }),
          );
      }

      // Derive the render document now, from exactly the mappings this
      // activation was judged on. Doing it here rather than per request is
      // what makes the bytes belong to the version being published, and so
      // what lets the pinned URL promise they never change.
      let scene: Buffer;
      try {
        scene = await deriveTileScene(
          request.server.blobs.read(target.bundleHash),
          pkg.contents.map((member) => request.server.blobs.read(member.hash)),
          {
            assetVersion: pkg.sourceHash,
            rootTransform: readRootTransform(request.server.blobs.read(pkg.rootTilesetHash)),
            sourceHash: pkg.sourceHash,
            floorMappings: Object.fromEntries(
              evaluation.evaluation.floorMappings.flatMap(([canonical, composites]) =>
                composites.map((composite) => [composite, canonical] as const),
              ),
            ),
          },
        );
      } catch (error) {
        if (error instanceof CoreTileSceneError) {
          const status = error.code === "bridge_error" ? 500 : 400;
          return reply.code(status).send(errorBody(error.code, error.message));
        }
        request.log.error({ err: error }, "tile scene derivation failed");
        return reply.code(500).send(errorBody("internal_error", "internal_error"));
      }
      const stored = request.server.blobs.put(scene);
      request.server.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
        .run(stored.hash, stored.size);
      registerTileBlob(request.server.db, stored.hash, stored.size);

      const nextSeq = target.seq + 1;
      const accepted = request.server.queue.enqueuePublication(
        "publish_imdf",
        {
          venueId: Number(venueId),
          seq: nextSeq,
          publicId: newPublicVersionId(),
          sourceBlobHash: target.sourceBlobHash,
          sourceKind: target.sourceKind,
          gdbSourceBlobHash: target.gdbSourceBlobHash,
          gdbPlanJson: target.gdbPlanJson,
          networkJunctionsBlobHash: target.networkJunctionsBlobHash,
          networkPathsBlobHash: target.networkPathsBlobHash,
          facilitiesBlobHash: target.facilitiesBlobHash,
          synthesized: target.synthesized,
        },
        {
          // Every input is the published version's own, so the new version
          // differs by exactly the descriptor. Anything reconstructed
          // differently here would silently recompile the venue.
          networkJunctionsHash: target.networkJunctionsBlobHash ?? undefined,
          networkPathsHash: target.networkPathsBlobHash ?? undefined,
          facilitiesGeoJsonHash: target.facilitiesBlobHash ?? undefined,
          synthesizeNetwork: target.synthesized,
          clipToSelection: storedPlanClipsToSelection(target.gdbPlanJson),
          tilesDescriptorJson: descriptorFor(evaluation, pkg.sourceHash, pkg.rootTilesetHash),
          tilePackageId: Number(packageId),
          tileActivationEvaluationId: evaluation.id,
          tileActivatedBy: request.user.id,
          tileSceneBlobHash: stored.hash,
        },
      );
      return reply
        .code(202)
        .send({ jobId: accepted.jobId, versionId: accepted.versionId, seq: nextSeq });
    },
  );
}

interface PackageForRegistration {
  sourceHash: string;
  rootTilesetHash: string;
  contents: { path: string; hash: string }[];
  /** Whether every recorded member is still present in the store. */
  integrityVerified: boolean;
}

/**
 * The package's stored members, and whether the store still holds all of them.
 *
 * Integrity is proven here rather than assumed by the evaluator: the store is
 * content-addressed, so a member that is present is a member whose bytes hash
 * to what ingestion recorded, and a member that is missing is exactly the
 * "unresolved member" the activation gate refuses on.
 */
function findPackage(
  server: FastifyInstance,
  venueId: number,
  packageId: number,
): PackageForRegistration | null {
  const record = server.db
    .prepare(
      "SELECT source_hash AS sourceHash, root_tileset AS rootTileset FROM tile_packages WHERE id = ? AND venue_id = ?",
    )
    .get(packageId, venueId) as { sourceHash: string; rootTileset: string } | undefined;
  if (record === undefined) {
    return null;
  }
  const members = server.db
    .prepare(
      "SELECT path, hash, kind FROM tile_package_members WHERE package_id = ? ORDER BY path",
    )
    .all(packageId) as { path: string; hash: string; kind: string }[];
  const root = members.find((member) => member.path === record.rootTileset);
  if (root === undefined) {
    return null;
  }
  return {
    sourceHash: record.sourceHash,
    rootTilesetHash: root.hash,
    contents: members.filter((member) => member.kind === "content"),
    integrityVerified: members.every((member) => server.blobs.has(member.hash)),
  };
}

/**
 * The root tileset's `root.transform`, applied unchanged (#31).
 *
 * A tileset without one places its content at the ENU origin of the venue
 * frame, which is the glTF identity case; refusing it here would reject a
 * legitimate local-origin export.
 */
function readRootTransform(tileset: Buffer): number[] {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(tileset.toString("utf8"));
  } catch {
    return identity;
  }
  if (parsed === null || typeof parsed !== "object" || !("root" in parsed)) {
    return identity;
  }
  const { root } = parsed;
  if (root === null || typeof root !== "object" || !("transform" in root)) {
    return identity;
  }
  const { transform } = root;
  if (
    !Array.isArray(transform) ||
    transform.length !== 16 ||
    !transform.every((value): value is number => typeof value === "number" && Number.isFinite(value))
  ) {
    return identity;
  }
  return transform;
}

function insertMembers(
  server: FastifyInstance,
  packageId: number,
  members: readonly {
    path: string;
    hash: string;
    byteSize: number;
    contentType: string;
    kind: string;
  }[],
): void {
  const insert = server.db.prepare(
    `INSERT INTO tile_package_members (package_id, path, hash, byte_size, content_type, kind)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const member of members) {
    insert.run(packageId, member.path, member.hash, member.byteSize, member.contentType, member.kind);
  }
}
