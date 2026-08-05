import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalImdfZip } from "../../tests/fixtures/buildMinimalImdfZip";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

afterEach(cleanupTestApps);

const KVB_MAGIC = Buffer.from([0x4b, 0x56, 0x42, 0x00]); // "KVB\0"
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]); // "PK"
const LATEST_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

async function createVenue(app: FastifyInstance, cookie: string, name: string) {
  const res = await app.inject({ method: "POST", url: "/api/venues", headers: { cookie }, payload: { name } });
  return res.json().venue as { id: number; slug: string };
}

function multipartZip(bytes: Uint8Array): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----kirikoServeBoundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v.zip"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Uploads `bytes` as the venue's next version and waits for publish to settle (published or failed). */
async function uploadAndWait(app: FastifyInstance, cookie: string, venueId: number, bytes: Uint8Array): Promise<void> {
  const { payload, headers } = multipartZip(bytes);
  await app.inject({
    method: "POST",
    url: `/api/venues/${venueId}/versions`,
    headers: { ...headers, cookie },
    payload,
  });
  await app.queue.idle();
}

describe("bundle route: publication-state semantics", () => {
  const ABSENT_ID = "0".repeat(64);

  it("404s for an unknown venue", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/v/default/nope/bundle" });
    expect(res.statusCode).toBe(404);
  });

  it("404s for latest and pinned when the venue has no published version (only a failed attempt)", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Never Published");
    await uploadAndWait(app, cookie, venue.id, new TextEncoder().encode("not a zip"));

    const latest = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle` });
    expect(latest.statusCode).toBe(404);
    const pinned = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${ABSENT_ID}` });
    expect(pinned.statusCode).toBe(404);
  });

  it("selects the highest published seq as latest and pins by permanent public identity", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Latest Selection");
    await uploadAndWait(app, cookie, venue.id, await buildMinimalImdfZip()); // seq 1: published
    await uploadAndWait(app, cookie, venue.id, new TextEncoder().encode("not a zip")); // seq 2: failed

    const latest = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle` });
    expect(latest.statusCode).toBe(200);
    const publicId = latest.headers["kiriko-version-id"] as string;
    const pinned = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${publicId}` });
    expect(pinned.statusCode).toBe(200);
    expect(latest.headers["etag"]).toBe(pinned.headers["etag"]); // latest is seq 1, the only published one

    const unknown = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${ABSENT_ID}` });
    expect(unknown.statusCode).toBe(404); // no published version carries this identity
  });

  it("returns exact content-type/cache-control for latest and pinned, honors If-None-Match with 304, 404s an unknown identity, 400s a malformed one", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Header Matrix");
    await uploadAndWait(app, cookie, venue.id, await buildMinimalImdfZip());

    const latest = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle` });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers["content-type"]).toBe("application/vnd.kiriko.bundle");
    expect(latest.headers["cache-control"]).toBe(LATEST_CACHE_CONTROL);
    const latestEtag = latest.headers["etag"] as string;
    expect(latestEtag).toMatch(/^"[0-9a-f]{64}"$/);
    const publicId = latest.headers["kiriko-version-id"] as string;
    expect(publicId).toMatch(/^[0-9a-f]{64}$/);
    const latestCached = await app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/bundle`,
      headers: { "if-none-match": latestEtag },
    });
    expect(latestCached.statusCode).toBe(304);
    expect(latestCached.headers["kiriko-version-id"]).toBe(publicId);

    const pinned = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${publicId}` });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.headers["content-type"]).toBe("application/vnd.kiriko.bundle");
    expect(pinned.headers["cache-control"]).toBe(PINNED_CACHE_CONTROL);
    const pinnedEtag = pinned.headers["etag"] as string;
    expect(pinnedEtag).toBe(latestEtag); // only one published version, so latest === this identity
    expect(pinned.headers["kiriko-version-id"]).toBe(publicId);
    const pinnedCached = await app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/bundle@${publicId}`,
      headers: { "if-none-match": pinnedEtag },
    });
    expect(pinnedCached.statusCode).toBe(304);
    expect(pinnedCached.headers["kiriko-version-id"]).toBe(publicId);

    const unknown = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${ABSENT_ID}` });
    expect(unknown.statusCode).toBe(404);
    const malformed = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@not-hex` });
    expect(malformed.statusCode).toBe(400);
  });

  it("emits a stable Kiriko-Version-Seq header on latest, pinned, and 304 responses", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Seq Header");
    await uploadAndWait(app, cookie, venue.id, await buildMinimalImdfZip()); // seq 1: published
    await uploadAndWait(app, cookie, venue.id, await buildMinimalImdfZip()); // seq 2: published

    const idForSeq = (seq: number): string => {
      const row = app.db
        .prepare("SELECT public_id AS p FROM versions WHERE venue_id = ? AND seq = ?")
        .get(venue.id, seq) as { p: string };
      return row.p;
    };

    const latest = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle` });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers["kiriko-version-seq"]).toBe("2");
    expect(latest.headers["kiriko-version-id"]).toBe(idForSeq(2));

    const pinned1 = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${idForSeq(1)}` });
    expect(pinned1.statusCode).toBe(200);
    expect(pinned1.headers["kiriko-version-seq"]).toBe("1");

    const pinned2 = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${idForSeq(2)}` });
    expect(pinned2.statusCode).toBe(200);
    expect(pinned2.headers["kiriko-version-seq"]).toBe("2");

    const latestEtag = latest.headers["etag"] as string;
    const cached = await app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/bundle`,
      headers: { "if-none-match": latestEtag },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers["kiriko-version-seq"]).toBe("2");
  });

  it("gives a recreated venue a distinct pinned identity; the deleted identity's URL 404s (immutable URLs never name new bytes)", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Recreated Identity");
    const zip = await buildMinimalImdfZip();
    await uploadAndWait(app, cookie, venue.id, zip);

    const original = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle` });
    const deletedPublicId = original.headers["kiriko-version-id"] as string;
    expect(deletedPublicId).toMatch(/^[0-9a-f]{64}$/);
    // The original identity's pinned URL resolves while it exists.
    const beforeDelete = await app.inject({
      method: "GET",
      url: `/v/default/${venue.slug}/bundle@${deletedPublicId}`,
    });
    expect(beforeDelete.statusCode).toBe(200);
    const deletedRow = app.db
      .prepare("SELECT id FROM versions WHERE venue_id = ?")
      .get(venue.id) as { id: number };
    const deletedVersionId = deletedRow.id;

    app.db.prepare("DELETE FROM venues WHERE id = ?").run(venue.id);
    const replacementVenue = await createVenue(app, cookie, "Recreated Identity");
    // Same slug, and the numeric row id is reclaimed. Asserted field by field
    // rather than with `toEqual(venue)`: `createVenue` casts the response to
    // `{ id, slug }` but the runtime object also carries `createdAt`, so
    // whole-object equality compared a second-resolution timestamp and failed
    // whenever the two creations straddled a second boundary.
    expect(replacementVenue.id).toBe(venue.id);
    expect(replacementVenue.slug).toBe(venue.slug);
    await uploadAndWait(app, cookie, replacementVenue.id, zip);
    const replacementRow = app.db
      .prepare("SELECT id FROM versions WHERE venue_id = ?")
      .get(replacementVenue.id) as { id: number };
    const replacementVersionId = replacementRow.id;
    expect(replacementVersionId).toBe(deletedVersionId); // reused numeric row id

    const recreated = await app.inject({
      method: "GET",
      url: `/v/default/${replacementVenue.slug}/bundle`,
    });
    expect(recreated.statusCode).toBe(200);
    const newPublicId = recreated.headers["kiriko-version-id"] as string;
    expect(newPublicId).toMatch(/^[0-9a-f]{64}$/);
    expect(newPublicId).not.toBe(deletedPublicId); // distinct permanent identity

    // The deleted identity's immutable URL must never resolve to the new bytes.
    const stalePin = await app.inject({
      method: "GET",
      url: `/v/default/${replacementVenue.slug}/bundle@${deletedPublicId}`,
    });
    expect(stalePin.statusCode).toBe(404);
    // The new identity has its own resolvable pinned URL.
    const newPin = await app.inject({
      method: "GET",
      url: `/v/default/${replacementVenue.slug}/bundle@${newPublicId}`,
    });
    expect(newPin.statusCode).toBe(200);
  });
});

describe("archive routes", () => {
  it("404s for latest and pinned archive URLs", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Private Sources");
    await uploadAndWait(app, cookie, venue.id, await buildMinimalImdfZip());

    const latest = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/archive` });
    expect(latest.statusCode).toBe(404);

    const pinned = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/archive@1` });
    expect(pinned.statusCode).toBe(404);
  });
});

describe("bundle serving: byte content", () => {
  it("serves each pinned version as distinct KVB bytes, never ZIP magic, and latest matches the highest published seq", async () => {
    const { app } = await makeTestApp();
    const cookie = await loginCookie(app);
    const venue = await createVenue(app, cookie, "Bundle Bytes");
    await uploadAndWait(app, cookie, venue.id, await buildMinimalImdfZip());
    await uploadAndWait(app, cookie, venue.id, await buildMinimalImdfZip({ extraEntries: { "note.txt": "v2" } }));

    const idForSeq = (seq: number): string => {
      const row = app.db
        .prepare("SELECT public_id AS p FROM versions WHERE venue_id = ? AND seq = ?")
        .get(venue.id, seq) as { p: string };
      return row.p;
    };
    const pinned1 = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${idForSeq(1)}` });
    const pinned2 = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle@${idForSeq(2)}` });
    expect(Buffer.from(pinned1.rawPayload.subarray(0, 4))).toEqual(KVB_MAGIC);
    expect(Buffer.from(pinned2.rawPayload.subarray(0, 4))).toEqual(KVB_MAGIC);
    expect(Buffer.from(pinned1.rawPayload.subarray(0, 2))).not.toEqual(ZIP_MAGIC);
    expect(pinned1.rawPayload).not.toEqual(pinned2.rawPayload); // distinct dataset/version embedded per bundle

    const latest = await app.inject({ method: "GET", url: `/v/default/${venue.slug}/bundle` });
    expect(latest.rawPayload).toEqual(pinned2.rawPayload); // seq 2 is the latest published
  });
});
