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
import { CoreTilePackageError, ingestTilePackage, type TilePackageRecord } from "../core/native";

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
