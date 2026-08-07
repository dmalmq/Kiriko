import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerTileServeRoutes } from "./tiles";
import { findPublishedVersion } from "./version";

const LATEST_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

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
    const found = findPublishedVersion(app.db, tenant, venue, publicId);
    // A version published before bundles existed has nothing to send here; the
    // shared resolver reports the version, and this route decides what it needs.
    if (found === null || found.bundleHash === null) {
      return reply.code(404).send({ error: "not_found" });
    }
    const hash = found.bundleHash;
    reply.header("Kiriko-Version-Id", found.publicId);
    reply.header("Kiriko-Version-Seq", String(found.seq));
    reply.header("ETag", `"${hash}"`);
    reply.header("cache-control", cacheControl);
    if (request.headers["if-none-match"] === `"${hash}"`) {
      return reply.code(304).send();
    }
    return reply.type("application/vnd.kiriko.bundle").send(app.blobs.read(hash));
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

  // Tile members share this URL space and this access policy.
  registerTileServeRoutes(app);
}
