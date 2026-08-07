/**
 * Public serving for tile members (#73).
 *
 * Two surfaces, two caching policies, one access policy.
 *
 * A **pinned member** URL names a version, so its bytes can never change: it
 * carries a hash ETag and year-long immutable caching, and honours range
 * requests so a half-downloaded 200 MiB member resumes instead of restarting.
 * Member URLs are *paths*, not hashes, because a tileset's `content.uri` values
 * are relative — serving by path is what lets Kiriko serve the producer's
 * tileset JSON byte-for-byte instead of rewriting URIs on the way out.
 *
 * The **latest descriptor** is not pinned, so it revalidates exactly like the
 * latest bundle: a client asking "what should I load for this venue now?" must
 * not be told an answer that has since changed.
 *
 * Access is inherited, not restated: both surfaces resolve through
 * `findPublishedVersion`, the same query the bundle routes use, and a member is
 * reachable only through a version whose own package contains it. A hash that
 * exists in the store is not a capability.
 */
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseRange } from "./range";
import { findPublishedVersion } from "./version";

const LATEST_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

interface MemberRow {
  hash: string;
  byteSize: number;
  contentType: string;
}

/**
 * The member at `path` within the package this version renders.
 *
 * The join is the isolation: a member is reachable through a version only when
 * that version's own package contains that path. Bytes shared with another
 * venue's package are reachable through that venue's URLs, never through this
 * one's, and a member of an unpublished version is not reachable at all.
 */
function findMember(
  app: FastifyInstance,
  versionId: number,
  path: string,
): MemberRow | null {
  const row = app.db
    .prepare(
      `SELECT m.hash AS hash, m.byte_size AS byteSize, m.content_type AS contentType
       FROM tile_package_members m
       JOIN version_tile_packages vtp ON vtp.package_id = m.package_id
       WHERE vtp.version_id = ? AND m.path = ?`,
    )
    .get(versionId, path) as MemberRow | undefined;
  return row ?? null;
}

interface DescriptorRow {
  sourceHash: string;
  rootTileset: string;
  totalBytes: number;
}

function findScene(app: FastifyInstance, versionId: number): DescriptorRow | null {
  const row = app.db
    .prepare(
      `SELECT p.source_hash AS sourceHash, p.root_tileset AS rootTileset,
              p.total_bytes AS totalBytes
       FROM tile_packages p
       JOIN version_tile_packages vtp ON vtp.package_id = p.id
       WHERE vtp.version_id = ?`,
    )
    .get(versionId) as DescriptorRow | undefined;
  return row ?? null;
}

export function registerTileServeRoutes(app: FastifyInstance): void {
  const latestParams = Type.Object({ tenant: Type.String(), venue: Type.String() });
  const memberParams = Type.Object({
    tenant: Type.String(),
    venue: Type.String(),
    // The permanent public version identity, as the pinned bundle route uses.
    id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    "*": Type.String(),
  });

  /**
   * What a viewer should load for this venue right now: which version, and the
   * tileset entry point inside it. Revalidating, because the answer changes when
   * the venue publishes again.
   */
  app.get(
    "/v/:tenant/:venue/tiles",
    { schema: { params: latestParams } },
    async (request, reply) => {
      const { tenant, venue } = request.params as { tenant: string; venue: string };
      const version = findPublishedVersion(app.db, tenant, venue, null);
      if (version === null) {
        return reply.code(404).send({ error: "not_found" });
      }
      const scene = findScene(app, version.id);
      if (scene === null) {
        // A published venue with no tile scene is ordinary, not an error state —
        // but there is nothing here to serve.
        return reply.code(404).send({ error: "no_tile_scene" });
      }
      reply.header("Kiriko-Version-Id", version.publicId);
      reply.header("Kiriko-Version-Seq", String(version.seq));
      reply.header("ETag", `"${scene.sourceHash}"`);
      reply.header("cache-control", LATEST_CACHE_CONTROL);
      if (request.headers["if-none-match"] === `"${scene.sourceHash}"`) {
        return reply.code(304).send();
      }
      return reply.send({
        versionId: version.publicId,
        seq: version.seq,
        // Where the pinned member URLs live, so a client resolves the tileset's
        // own relative URIs against an address whose bytes cannot change.
        baseUrl: `/v/${tenant}/${venue}/tiles@${version.publicId}/`,
        rootTileset: scene.rootTileset,
        totalBytes: scene.totalBytes,
      });
    },
  );

  app.get(
    "/v/:tenant/:venue/tiles@:id/*",
    { schema: { params: memberParams } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { tenant, venue, id } = request.params as {
        tenant: string;
        venue: string;
        id: string;
      };
      const path = (request.params as Record<string, string>)["*"] ?? "";
      const version = findPublishedVersion(app.db, tenant, venue, id);
      if (version === null) {
        return reply.code(404).send({ error: "not_found" });
      }
      const member = findMember(app, version.id, path);
      if (member === null) {
        return reply.code(404).send({ error: "not_found" });
      }

      reply.header("Kiriko-Version-Id", version.publicId);
      reply.header("Kiriko-Version-Seq", String(version.seq));
      reply.header("ETag", `"${member.hash}"`);
      reply.header("cache-control", PINNED_CACHE_CONTROL);
      // Advertised on every response, including 304 and 416, so a resuming
      // client knows ranges are available without a probe request.
      reply.header("accept-ranges", "bytes");
      reply.type(member.contentType);
      if (request.headers["if-none-match"] === `"${member.hash}"`) {
        return reply.code(304).send();
      }

      const range = parseRange(request.headers.range, member.byteSize);
      if (range.kind === "unsatisfiable") {
        reply.header("content-range", `bytes */${member.byteSize}`);
        // The refusal is Kiriko's own message, not a slice of the member, so it
        // carries the error content type rather than the member's.
        return reply.code(416).type("application/json").send({ error: "range_not_satisfiable" });
      }
      if (range.kind === "range") {
        const length = range.end - range.start + 1;
        reply.header("content-range", `bytes ${range.start}-${range.end}/${member.byteSize}`);
        reply.header("content-length", String(length));
        return reply
          .code(206)
          .send(app.blobs.stream(member.hash, { start: range.start, end: range.end }));
      }
      reply.header("content-length", String(member.byteSize));
      return reply.send(app.blobs.stream(member.hash));
    },
  );
}
