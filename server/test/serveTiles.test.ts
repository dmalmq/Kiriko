/**
 * Public tile serving (#73): caching, ranges, and reach.
 *
 * The reach tests matter most. A tile URL must grant exactly what its version
 * grants and nothing more — bytes sitting in the shared store are not a
 * capability, and a member of one version must not be fetchable through
 * another's URL even when both hold the same bytes.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import { attachPackageToVersion } from "../src/tiles/storage";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";
import { glbFixture, tilesetFixture } from "../../tests/fixtures/tileFixtures";

afterEach(cleanupTestApps);

const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";
const LATEST_CACHE_CONTROL = "public, max-age=0, must-revalidate";

function multipart(bytes: Uint8Array, filename: string, type: string) {
  const boundary = "----kirikoServeTilesBoundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function packageZip(entries: [string, Uint8Array][]): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  for (const [path, bytes] of entries) {
    await writer.add(path, new Uint8ArrayReader(bytes));
  }
  return Buffer.from(await writer.close());
}

interface Published {
  app: FastifyInstance;
  cookie: string;
  venueId: number;
  slug: string;
  versionId: number;
  publicId: string;
}

/** A venue with a genuinely published version, through the real publish path. */
async function publishVenue(name: string): Promise<Published> {
  const { app } = await makeTestApp();
  const cookie = await loginCookie(app);
  const created = await app.inject({
    method: "POST",
    url: "/api/venues",
    headers: { cookie },
    payload: { name },
  });
  const venue = created.json<{ venue: { id: number; slug: string } }>().venue;

  const upload = multipart(await buildMinimalImdfZip(), "v.zip", "application/zip");
  await app.inject({
    method: "POST",
    url: `/api/venues/${venue.id}/versions`,
    headers: { cookie, ...upload.headers },
    payload: upload.payload,
  });
  await app.queue.idle();

  const version = app.db
    .prepare(
      "SELECT id, public_id AS publicId FROM versions WHERE venue_id = ? AND status = 'published'",
    )
    .get(venue.id) as { id: number; publicId: string };
  return {
    app,
    cookie,
    venueId: venue.id,
    slug: venue.slug,
    versionId: version.id,
    publicId: version.publicId,
  };
}

interface Member {
  path: string;
  hash: string;
  byteSize: number;
  contentType: string;
}

/** Ingest a package into a venue and attach it to a version. */
async function attachPackage(
  ctx: Published,
  marker: number,
  versionId = ctx.versionId,
  contentPath = "content/model.glb",
): Promise<{ packageId: number; members: Member[]; sourceHash: string }> {
  const zip = await packageZip([
    ["tileset.json", tilesetFixture(contentPath)],
    [contentPath, glbFixture(marker)],
  ]);
  const upload = multipart(zip, "tiles.zip", "application/zip");
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/venues/${ctx.venueId}/tiles/inspect`,
    headers: { cookie: ctx.cookie, ...upload.headers },
    payload: upload.payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ packageId: number; sourceHash: string; members: Member[] }>();
  attachPackageToVersion(ctx.app.db, versionId, body.packageId);
  return { packageId: body.packageId, members: body.members, sourceHash: body.sourceHash };
}

function member(members: Member[], path: string): Member {
  const found = members.find((entry) => entry.path === path);
  expect(found, `member ${path}`).toBeDefined();
  return found!;
}

describe("pinned member serving", () => {
  it("serves a member with a hash ETag, immutable caching, and its recorded type", async () => {
    const ctx = await publishVenue("Serve Pinned");
    const { members } = await attachPackage(ctx, 1);
    const glb = member(members, "content/model.glb");

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers.etag).toBe(`"${glb.hash}"`);
    expect(response.headers["cache-control"]).toBe(PINNED_CACHE_CONTROL);
    expect(response.headers["content-type"]).toBe(glb.contentType);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["kiriko-version-id"]).toBe(ctx.publicId);
    // The bytes are the producer's, unmodified.
    expect(Buffer.from(response.rawPayload).equals(Buffer.from(glbFixture(1)))).toBe(true);

    // A conditional request revalidates rather than resending.
    const conditional = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
      headers: { "if-none-match": `"${glb.hash}"` },
    });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.headers.etag).toBe(`"${glb.hash}"`);
    expect(conditional.headers["cache-control"]).toBe(PINNED_CACHE_CONTROL);
    expect(conditional.rawPayload.length).toBe(0);
  });

  it("serves the tileset JSON so its own relative URIs resolve as published", async () => {
    const ctx = await publishVenue("Serve Tileset");
    const { members } = await attachPackage(ctx, 2);
    const tileset = member(members, "tileset.json");

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/tileset.json`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers.etag).toBe(`"${tileset.hash}"`);
    // Byte-for-byte: the content URI inside still says `content/model.glb`, and
    // it resolves against this URL to the member route beside it. Rewriting URIs
    // on the way out would break the hash the ETag promises.
    expect(Buffer.from(response.rawPayload).equals(Buffer.from(tilesetFixture("content/model.glb")))).toBe(
      true,
    );

    const sibling = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
    });
    expect(sibling.statusCode).toBe(200);
  });
});

describe("range requests", () => {
  it("returns 206 with the exact bytes and Content-Range for a single range", async () => {
    const ctx = await publishVenue("Serve Range");
    const { members } = await attachPackage(ctx, 3);
    const glb = member(members, "content/model.glb");
    const whole = Buffer.from(glbFixture(3));

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
      headers: { range: "bytes=4-19" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 4-19/${glb.byteSize}`);
    expect(response.headers["content-length"]).toBe("16");
    expect(Buffer.from(response.rawPayload).equals(whole.subarray(4, 20))).toBe(true);
  });

  it("resumes from an offset to the end of the member", async () => {
    const ctx = await publishVenue("Serve Resume");
    const { members } = await attachPackage(ctx, 4);
    const glb = member(members, "content/model.glb");
    const whole = Buffer.from(glbFixture(4));
    const offset = Math.floor(glb.byteSize / 2);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
      headers: { range: `bytes=${offset}-` },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(
      `bytes ${offset}-${glb.byteSize - 1}/${glb.byteSize}`,
    );
    expect(Buffer.from(response.rawPayload).equals(whole.subarray(offset))).toBe(true);
    // A resumed download reassembles into the original bytes.
    const head = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
      headers: { range: `bytes=0-${offset - 1}` },
    });
    expect(head.statusCode).toBe(206);
    expect(
      Buffer.concat([Buffer.from(head.rawPayload), Buffer.from(response.rawPayload)]).equals(whole),
    ).toBe(true);
  });

  it("returns 416 with the real size for a range past the end", async () => {
    const ctx = await publishVenue("Serve Unsatisfiable");
    const { members } = await attachPackage(ctx, 5);
    const glb = member(members, "content/model.glb");

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
      headers: { range: `bytes=${glb.byteSize}-${glb.byteSize + 100}` },
    });
    expect(response.statusCode).toBe(416);
    // The size tells a confused client what it should have asked for.
    expect(response.headers["content-range"]).toBe(`bytes */${glb.byteSize}`);
    expect(response.headers["accept-ranges"]).toBe("bytes");
  });

  it("answers HEAD with the size and range support, so a client can plan a resume", async () => {
    const ctx = await publishVenue("Serve Head");
    const { members } = await attachPackage(ctx, 15);
    const glb = member(members, "content/model.glb");

    const response = await ctx.app.inject({
      method: "HEAD",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-length"]).toBe(String(glb.byteSize));
    expect(response.headers.etag).toBe(`"${glb.hash}"`);
    expect(response.rawPayload.length).toBe(0);
  });

  it("sends the whole member when no range is asked for", async () => {
    const ctx = await publishVenue("Serve Whole");
    const { members } = await attachPackage(ctx, 6);
    const glb = member(members, "content/model.glb");

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-length"]).toBe(String(glb.byteSize));
    expect(response.headers["content-range"]).toBeUndefined();
    expect(response.rawPayload.length).toBe(glb.byteSize);
  });
});

describe("reach", () => {
  it("does not serve members of a version that is not published", async () => {
    const ctx = await publishVenue("Serve Draft");
    // A second version, left in draft, with its own package.
    const draft = ctx.app.db
      .prepare(
        `INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, status)
         VALUES (?, 2, ?, ?, 'draft')`,
      )
      .run(ctx.venueId, "d".repeat(64), "0".repeat(64));
    const draftId = Number(draft.lastInsertRowid);
    const { members } = await attachPackage(ctx, 7, draftId, "content/draft.glb");

    // The bytes exist and the URL names the draft's own identity — and it is
    // still not public, because serving inherits the version's policy.
    expect(ctx.app.blobs.has(member(members, "content/draft.glb").hash)).toBe(true);
    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${"d".repeat(64)}/content/draft.glb`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not serve a member through a version whose package lacks it", async () => {
    const ctx = await publishVenue("Serve Isolation");
    // Two published versions, each with its own package and its own member path.
    await attachPackage(ctx, 8, ctx.versionId, "content/first.glb");
    const second = ctx.app.db
      .prepare(
        `INSERT INTO versions (venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
         VALUES (?, 2, ?, ?, ?, 'published')`,
      )
      .run(ctx.venueId, "e".repeat(64), "0".repeat(64), "1".repeat(64));
    const secondId = Number(second.lastInsertRowid);
    const other = await attachPackage(ctx, 9, secondId, "content/second.glb");

    // Each version serves its own member.
    const own = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${"e".repeat(64)}/content/second.glb`,
    });
    expect(own.statusCode).toBe(200);

    // And not the other's, though the bytes are in the same store and the
    // requester knows the exact path.
    const across = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/second.glb`,
    });
    expect(across.statusCode).toBe(404);
    expect(ctx.app.blobs.has(member(other.members, "content/second.glb").hash)).toBe(true);
  });

  it("does not reach across venues", async () => {
    const ctx = await publishVenue("Serve Venue A");
    const { members } = await attachPackage(ctx, 10);
    const glb = member(members, "content/model.glb");

    const otherVenue = await ctx.app.inject({
      method: "POST",
      url: "/api/venues",
      headers: { cookie: ctx.cookie },
      payload: { name: "Serve Venue B" },
    });
    const other = otherVenue.json<{ venue: { slug: string } }>().venue;

    // The other venue's slug with this version's identity resolves to nothing:
    // the resolver joins venue and version, so neither half alone is a key.
    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${other.slug}/tiles@${ctx.publicId}/content/model.glb`,
    });
    expect(response.statusCode).toBe(404);
    expect(ctx.app.blobs.has(glb.hash)).toBe(true);
  });

  it("rejects a malformed version identity before touching the database", async () => {
    const ctx = await publishVenue("Serve Malformed");
    await attachPackage(ctx, 11);
    const response = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@not-a-hash/content/model.glb`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("latest scene descriptor", () => {
  it("revalidates rather than caching immutably, and points at pinned URLs", async () => {
    const ctx = await publishVenue("Serve Descriptor");
    const { sourceHash } = await attachPackage(ctx, 12);

    const response = await ctx.app.inject({ method: "GET", url: `/v/default/${ctx.slug}/tiles` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe(LATEST_CACHE_CONTROL);
    expect(response.headers.etag).toBe(`"${sourceHash}"`);
    const body = response.json<{
      versionId: string;
      rootTileset: string;
      baseUrl: string;
      totalBytes: number;
    }>();
    expect(body.versionId).toBe(ctx.publicId);
    expect(body.rootTileset).toBe("tileset.json");
    expect(body.baseUrl).toBe(`/v/default/${ctx.slug}/tiles@${ctx.publicId}/`);
    expect(body.totalBytes).toBeGreaterThan(0);

    // The descriptor's own URL is what a client follows to the pinned bytes.
    const followed = await ctx.app.inject({
      method: "GET",
      url: `${body.baseUrl}${body.rootTileset}`,
    });
    expect(followed.statusCode).toBe(200);
    expect(followed.headers["cache-control"]).toBe(PINNED_CACHE_CONTROL);

    const conditional = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles`,
      headers: { "if-none-match": `"${sourceHash}"` },
    });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.headers["cache-control"]).toBe(LATEST_CACHE_CONTROL);
  });

  it("404s a published venue with no tile scene, and an unknown venue", async () => {
    const ctx = await publishVenue("Serve No Scene");
    const none = await ctx.app.inject({ method: "GET", url: `/v/default/${ctx.slug}/tiles` });
    expect(none.statusCode).toBe(404);
    expect(none.json<{ error: string }>().error).toBe("no_tile_scene");

    const unknown = await ctx.app.inject({ method: "GET", url: "/v/default/nope/tiles" });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("storage and bundle coexistence", () => {
  it("serves members from the single stored copy, adding none", async () => {
    const ctx = await publishVenue("Serve No Copy");
    const { members } = await attachPackage(ctx, 13);
    const glb = member(members, "content/model.glb");

    const before = ctx.app.db.prepare("SELECT COUNT(*) AS count FROM blobs").get() as {
      count: number;
    };
    for (const range of [undefined, "bytes=0-9", "bytes=-4"]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
        ...(range === undefined ? {} : { headers: { range } }),
      });
      expect(response.statusCode === 200 || response.statusCode === 206).toBe(true);
    }
    const after = ctx.app.db.prepare("SELECT COUNT(*) AS count FROM blobs").get() as {
      count: number;
    };
    // Serving reads in place: no derived copy, no cache entry, no extra blob.
    expect(after.count).toBe(before.count);
    expect(ctx.app.blobs.has(glb.hash)).toBe(true);
  });

  it("still serves the version's bundle beside its members", async () => {
    const ctx = await publishVenue("Serve Both");
    const { members } = await attachPackage(ctx, 14);
    const glb = member(members, "content/model.glb");

    const bundle = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/bundle@${ctx.publicId}`,
    });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers["content-type"]).toBe("application/vnd.kiriko.bundle");
    expect(bundle.headers["cache-control"]).toBe(PINNED_CACHE_CONTROL);

    const memberResponse = await ctx.app.inject({
      method: "GET",
      url: `/v/default/${ctx.slug}/tiles@${ctx.publicId}/content/model.glb`,
    });
    // Same version, same policy, different assets — and different ETags, so a
    // cache cannot confuse one for the other.
    expect(memberResponse.statusCode).toBe(200);
    expect(memberResponse.headers.etag).toBe(`"${glb.hash}"`);
    expect(memberResponse.headers.etag).not.toBe(bundle.headers.etag);
  });
});
