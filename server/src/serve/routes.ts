import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const LATEST_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

function findPublished(
  db: Database.Database,
  tenantSlug: string,
  venueSlug: string,
  publicId: string | null,
): { hash: string; publicId: string; seq: number } | null {
  const row = db
    .prepare(
      `SELECT vr.bundle_hash AS hash, vr.public_id AS publicId, vr.seq AS seq FROM versions vr
       JOIN venues v ON v.id = vr.venue_id
       JOIN tenants t ON t.id = v.tenant_id
       WHERE t.slug = ? AND v.slug = ? AND vr.status = 'published'
         AND (? IS NULL OR vr.public_id = ?)
       ORDER BY vr.seq DESC LIMIT 1`,
    )
    .get(tenantSlug, venueSlug, publicId, publicId) as
    | { hash: string | null; publicId: string; seq: number }
    | undefined;
  return row?.hash ? { hash: row.hash, publicId: row.publicId, seq: row.seq } : null;
}

export function registerServeRoutes(app: FastifyInstance): void {
  const params = Type.Object({ tenant: Type.String(), venue: Type.String() });
  // The pin key is the permanent 64-hex public identity, never the reusable
  // numeric seq (a deleted+recreated venue can reclaim the same slug and seq).
  const pinnedParams = Type.Object({
    tenant: Type.String(),
    venue: Type.String(),
    id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  });

  function send(
    reply: FastifyReply,
    request: FastifyRequest,
    tenant: string,
    venue: string,
    publicId: string | null,
    cacheControl: string,
  ) {
    const found = findPublished(app.db, tenant, venue, publicId);
    if (!found) {
      return reply.code(404).send({ error: "not_found" });
    }
    reply.header("Kiriko-Version-Id", found.publicId);
    reply.header("Kiriko-Version-Seq", String(found.seq));
    reply.header("ETag", `"${found.hash}"`);
    reply.header("cache-control", cacheControl);
    if (request.headers["if-none-match"] === `"${found.hash}"`) {
      return reply.code(304).send();
    }
    return reply.type("application/vnd.kiriko.bundle").send(app.blobs.read(found.hash));
  }

  app.get("/v/:tenant/:venue/bundle", { schema: { params } }, async (request, reply) => {
    const { tenant, venue } = request.params as { tenant: string; venue: string };
    return send(reply, request, tenant, venue, null, LATEST_CACHE_CONTROL);
  });

  app.get(
    "/v/:tenant/:venue/bundle@:id",
    { schema: { params: pinnedParams } },
    async (request, reply) => {
      const { tenant, venue, id } = request.params as { tenant: string; venue: string; id: string };
      return send(reply, request, tenant, venue, id, PINNED_CACHE_CONTROL);
    },
  );
}
