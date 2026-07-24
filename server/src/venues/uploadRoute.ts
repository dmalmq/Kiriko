import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/guard";

const TENANT_ID = 1;

/** The Rust importer is authoritative for every decompressed limit; this
 * only bounds the raw multipart upload before it reaches that pipeline. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function newPublicVersionId(): string {
  return randomBytes(32).toString("hex");
}

export function registerUploadRoute(app: FastifyInstance): void {
  app.post(
    "/api/venues/:id/versions",
    {
      preHandler: requireSession,
      schema: {
        params: Type.Object({ id: Type.Integer() }),
        response: {
          202: Type.Object({ jobId: Type.String(), versionId: Type.Number(), seq: Type.Number() }),
          400: Type.Object({ error: Type.String() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const venue = request.server.db
        .prepare("SELECT id FROM venues WHERE id = ? AND tenant_id = ?")
        .get(id, TENANT_ID);
      if (!venue) {
        return reply.code(404).send({ error: "not_found" });
      }
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: "file_required" });
      }
      const bytes = await file.toBuffer();
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return reply.code(400).send({ error: "file_too_large" });
      }
      const { hash, size } = request.server.blobs.put(bytes);
      request.server.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)")
        .run(hash, size);

      const db = request.server.db;
      const nextSeq =
        ((db.prepare("SELECT MAX(seq) AS m FROM versions WHERE venue_id = ?").get(id) as {
          m: number | null;
        }).m ?? 0) + 1;
      const accepted = request.server.queue.enqueuePublication(
        "publish_imdf",
        {
          venueId: id,
          seq: nextSeq,
          publicId: newPublicVersionId(),
          sourceBlobHash: hash,
          sourceKind: "imdf",
        },
      );
      const { jobId, versionId } = accepted;
      return reply.code(202).send({ jobId, versionId, seq: nextSeq });
    },
  );
}
