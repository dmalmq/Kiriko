import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createSession } from "../src/auth/sessions";
import { processAttachmentImage } from "../src/issues/attachments/image";
import { runIssueAttachmentJanitor } from "../src/issues/attachments/janitor";
import { IssueAttachmentRepository } from "../src/issues/attachments/repository";
import { IssueAttachmentService } from "../src/issues/attachments/service";
import { IssueAttachmentStore } from "../src/issues/attachments/store";
import {
  parseAttachmentTokens,
  parseAttachmentTokenIds,
} from "../src/issues/attachments/tokens";
import { IssueServiceError } from "../src/issues/errors";
import { IssueRepository } from "../src/issues/repository";
import { resolveAttachmentIds } from "../src/issues/validation";
import { cleanupTestApps, makeTestApp, makeTestDb } from "./helpers";

const PUBLIC_ID = "a".repeat(64);
const PUBLIC_ID_B = "b".repeat(64);
const DRAFT_ID = "d".repeat(64);
const LEVEL_ID = "b1000001-0000-4000-8000-0000000000b1";
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures");

function cookieFor(app: FastifyInstance, userId: number): string {
  return `kiriko_session=${createSession(app.db, userId, 30)}`;
}

interface SeededApp {
  app: FastifyInstance;
  memberCookie: string;
  viewerCookie: string;
}

async function seededApp(): Promise<SeededApp> {
  const { app } = await makeTestApp();
  app.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'member', 'x', 'member')").run();
  app.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'viewer', 'x', 'viewer')").run();
  app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name, created_by) VALUES (10, 1, 'station', 'Station', 1)").run();
  const bundle = app.blobs.put(readFileSync(join(FIXTURES_DIR, "minimal.kvb")));
  app.db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(bundle.hash, bundle.size);
  app.db.prepare(
    `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
     VALUES (100, 10, 1, ?, 'source-a', ?, 'published'),
            (101, 10, 2, ?, 'source-b', ?, 'published'),
            (102, 10, 3, ?, 'source-d', NULL, 'draft')`,
  ).run(PUBLIC_ID, bundle.hash, PUBLIC_ID_B, bundle.hash, DRAFT_ID);
  return { app, memberCookie: cookieFor(app, 2), viewerCookie: cookieFor(app, 3) };
}

async function pngBuffer(width = 40, height = 30): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 50, height: 20, channels: 3, background: "#993366" } })
    .jpeg()
    .toBuffer();
}

async function webpBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 24, channels: 3, background: "#669933" } })
    .webp()
    .toBuffer();
}

function multipartUpload(
  requestId: string,
  bytes: Buffer,
  options: { filename?: string; contentType?: string; fileFirst?: boolean } = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----kirikoAttachmentBoundary";
  const requestIdPart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${requestId}\r\n`,
  );
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename ?? "shot.png"}"\r\n`
      + `Content-Type: ${options.contentType ?? "image/png"}\r\n\r\n`,
  );
  const filePart = Buffer.concat([fileHead, bytes, Buffer.from("\r\n")]);
  const tail = Buffer.from(`--${boundary}--\r\n`);
  return {
    payload: Buffer.concat(
      options.fileFirst
        ? [filePart, requestIdPart, tail]
        : [requestIdPart, filePart, tail],
    ),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

interface UploadMetadata {
  id: string;
  contentType: string;
  width: number;
  height: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
}

async function upload(
  app: FastifyInstance,
  cookie: string,
  bytes: Buffer,
  requestId: string = randomUUID(),
  publicVersionId: string = PUBLIC_ID,
): Promise<UploadMetadata> {
  const multipart = multipartUpload(requestId, bytes);
  const response = await app.inject({
    method: "POST",
    url: `/api/review/versions/${publicVersionId}/issue-attachments`,
    headers: { cookie, ...multipart.headers },
    payload: multipart.payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<UploadMetadata>();
}

async function postIssue(
  app: FastifyInstance,
  cookie: string,
  payload: Record<string, unknown>,
  publicVersionId: string = PUBLIC_ID,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/review/versions/${publicVersionId}/issues`,
    headers: { cookie },
    payload: {
      requestId: randomUUID(),
      anchor: { levelId: LEVEL_ID, longitude: 139.7, latitude: 35.68 },
      ...payload,
    },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function collection(app: FastifyInstance, publicVersionId: string = PUBLIC_ID) {
  const response = await app.inject({ method: "GET", url: `/api/review/versions/${publicVersionId}/issues` });
  expect(response.statusCode).toBe(200);
  return response.json<{ revision: number; issues: Array<Record<string, unknown>> }>();
}

function attachmentState(app: FastifyInstance, id: string): string | null {
  const row = app.db.prepare("SELECT state FROM issue_attachments WHERE id = ?").get(id) as
    | { state: string }
    | undefined;
  return row?.state ?? null;
}

afterEach(cleanupTestApps);

describe("attachment token parsing", () => {
  const idA = "11111111-2222-4333-8444-555555555555";
  const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("parses canonical attachment image tokens in document order without duplicates", () => {
    const body = `before ![first](attachment:${idA}) mid ![again](attachment:${idA})\n![second](attachment:${idB} "title")`;
    expect(parseAttachmentTokenIds(body)).toEqual([idA, idB]);
    expect(parseAttachmentTokens(body).map((token) => token.alt)).toEqual(["first", "second"]);
  });

  it("ignores tokens in code spans, code blocks, and link destinations", () => {
    const body = [
      `\`![x](attachment:${idA})\``,
      "```",
      `![x](attachment:${idA})`,
      "```",
      `[link](attachment:${idA})`,
    ].join("\n");
    expect(parseAttachmentTokenIds(body)).toEqual([]);
  });

  it("ignores non-canonical IDs and non-attachment schemes", () => {
    const upper = idA.toUpperCase();
    const body = [
      `![a](attachment:${upper})`,
      `![b](attachment:not-a-uuid)`,
      `![c](https://example.com/${idA}.png)`,
      `![d](data:image/png;base64,AAAA)`,
      `![e](attachment:${idA})`,
    ].join("\n");
    expect(parseAttachmentTokenIds(body)).toEqual([idA]);
  });

  it("resolves provided IDs by exact set equality with the parsed tokens", () => {
    const body = `![a](attachment:${idA}) and ![b](attachment:${idB})`;
    expect(resolveAttachmentIds(body, [idB, idA])).toEqual([idA, idB]);
    expect(() => resolveAttachmentIds(body, [idA])).toThrowError(IssueServiceError);
    expect(() => resolveAttachmentIds(body, [idA, idB, idA])).toThrowError(IssueServiceError);
    expect(() => resolveAttachmentIds(body, ["not-an-id", idB])).toThrowError(IssueServiceError);
    expect(resolveAttachmentIds(body, undefined)).toEqual([idA, idB]);
    expect(resolveAttachmentIds("plain text", undefined)).toEqual([]);
  });

  it("enforces the per-comment count cap and alt-text cap", () => {
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `![x](attachment:00000000-0000-4000-8000-${String(i).padStart(12, "0")})`,
    ).join("\n");
    expect(() => resolveAttachmentIds(eleven, undefined)).toThrowError(IssueServiceError);
    const longAlt = `![${"a".repeat(301)}](attachment:${idA})`;
    expect(() => resolveAttachmentIds(longAlt, undefined)).toThrowError(IssueServiceError);
  });
});

describe("image processing", () => {
  it("normalizes PNG/JPEG/WebP and strips metadata while auto-orienting", async () => {
    const rotated = await sharp({ create: { width: 40, height: 10, channels: 3, background: "#123456" } })
      .jpeg()
      .withMetadata({ orientation: 6, density: 300 })
      .toBuffer();
    const processed = await processAttachmentImage(rotated);
    expect(processed.original.contentType).toBe("image/jpeg");
    // Orientation 6 swaps dimensions; EXIF/orientation metadata is gone.
    expect([processed.original.width, processed.original.height]).toEqual([10, 40]);
    const metadata = await sharp(processed.original.bytes).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();

    for (const input of [await pngBuffer(), await webpBuffer()]) {
      const result = await processAttachmentImage(input);
      expect(result.original.width).toBeGreaterThan(0);
      expect(result.thumbnail.contentType).toBe("image/webp");
    }
  });

  it("bounds thumbnails to the maximum dimension without enlarging", async () => {
    const big = await processAttachmentImage(await pngBuffer(2000, 1000));
    expect(big.thumbnail.width).toBe(1600);
    expect(big.thumbnail.height).toBe(800);
    const small = await processAttachmentImage(await pngBuffer(100, 50));
    expect([small.thumbnail.width, small.thumbnail.height]).toEqual([100, 50]);
  });

  it("rejects SVG, GIF, arbitrary bytes, and magic/content mismatches", async () => {
    await expect(processAttachmentImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).rejects.toMatchObject({ code: "invalid_attachment" });
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000000" } }).gif().toBuffer();
    await expect(processAttachmentImage(gif)).rejects.toMatchObject({ code: "invalid_attachment" });
    await expect(processAttachmentImage(Buffer.from("not an image at all"))).rejects.toMatchObject({ code: "invalid_attachment" });
    // PNG magic over JPEG bytes is a polyglot and must not decode.
    const jpeg = await jpegBuffer();
    const polyglot = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), jpeg.subarray(4)]);
    await expect(processAttachmentImage(polyglot)).rejects.toMatchObject({ code: "invalid_attachment" });
  });

  it("enforces dimension and pixel limits before full decode", async () => {
    const wide = await pngBuffer(300, 10);
    await expect(
      processAttachmentImage(wide, { maxPixels: 40_000_000, maxDimension: 200, thumbnailMaxDimension: 1600, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ code: "invalid_attachment" });
    await expect(
      processAttachmentImage(wide, { maxPixels: 1_000, maxDimension: 12_000, thumbnailMaxDimension: 1600, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ code: "invalid_attachment" });
  });
});

describe("attachment upload API", () => {
  it("accepts a PNG upload and stages normalized media with an opaque ID", async () => {
    const { app, memberCookie } = await seededApp();
    const metadata = await upload(app, memberCookie, await pngBuffer());
    expect(metadata.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata).toMatchObject({ contentType: "image/png", width: 40, height: 30 });
    expect(attachmentState(app, metadata.id)).toBe("staged");
    expect(
      (app.db.prepare("SELECT input_byte_size AS size FROM issue_attachments WHERE id = ?")
        .get(metadata.id) as { size: number }).size,
    ).toBe((await pngBuffer()).byteLength);
    const rows = app.db.prepare("SELECT COUNT(*) AS n FROM issue_attachment_blobs").get() as { n: number };
    expect(rows.n).toBe(2);
    // Staged media is never served.
    for (const kind of ["content", "thumbnail"]) {
      const response = await app.inject({ method: "GET", url: `/api/issue-attachments/${metadata.id}/${kind}` });
      expect(response.statusCode).toBe(404);
    }
  });

  it("accepts requestId after the file part", async () => {
    const { app, memberCookie } = await seededApp();
    const requestId = randomUUID();
    const multipart = multipartUpload(requestId, await pngBuffer(), { fileFirst: true });
    const response = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issue-attachments`,
      headers: { cookie: memberCookie, ...multipart.headers },
      payload: multipart.payload,
    });

    expect(response.statusCode, response.body).toBe(200);
    const metadata = response.json<UploadMetadata>();
    expect(attachmentState(app, metadata.id)).toBe("staged");
  });

  it("requires authentication and a published version for uploads", async () => {
    const { app, memberCookie } = await seededApp();
    const png = await pngBuffer();
    const anonymous = multipartUpload(randomUUID(), png);
    const anonResponse = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issue-attachments`,
      headers: anonymous.headers,
      payload: anonymous.payload,
    });
    expect(anonResponse.statusCode).toBe(401);

    for (const versionId of [DRAFT_ID, "f".repeat(64)]) {
      const multipart = multipartUpload(randomUUID(), png);
      const response = await app.inject({
        method: "POST",
        url: `/api/review/versions/${versionId}/issue-attachments`,
        headers: { cookie: memberCookie, ...multipart.headers },
        payload: multipart.payload,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("replays an identical retry and conflicts on different content under one request ID", async () => {
    const { app, memberCookie } = await seededApp();
    const requestId = randomUUID();
    const png = await pngBuffer();
    const first = await upload(app, memberCookie, png, requestId);
    const replay = await upload(app, memberCookie, png, requestId);
    expect(replay.id).toBe(first.id);
    expect(
      (app.db.prepare("SELECT COUNT(*) AS n FROM issue_attachments").get() as { n: number }).n,
    ).toBe(1);

    const conflict = multipartUpload(requestId, await jpegBuffer());
    const response = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issue-attachments`,
      headers: { cookie: memberCookie, ...conflict.headers },
      payload: conflict.payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "idempotency_conflict" });
  });

  it("rejects SVG, oversize files, and malformed multipart opaquely", async () => {
    const { app, memberCookie } = await seededApp();
    const svg = multipartUpload(randomUUID(), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), {
      filename: "x.svg",
      contentType: "image/svg+xml",
    });
    const svgResponse = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issue-attachments`,
      headers: { cookie: memberCookie, ...svg.headers },
      payload: svg.payload,
    });
    expect(svgResponse.statusCode).toBe(400);
    expect(svgResponse.json()).toMatchObject({ error: "invalid_attachment" });

    const oversize = multipartUpload(randomUUID(), Buffer.alloc(10 * 1024 * 1024 + 1, 7));
    const oversizeResponse = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issue-attachments`,
      headers: { cookie: memberCookie, ...oversize.headers },
      payload: oversize.payload,
    });
    expect(oversizeResponse.statusCode).toBe(400);
    expect(oversizeResponse.json()).toMatchObject({ error: "invalid_attachment" });
    expect(oversizeResponse.body).not.toMatch(/data\/|issue-attachments\/sha256/);
  });

  it("enforces the version storage quota and per-user upload rate limit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kiriko-attach-quota-"));
    const app = await buildApp({
      dataDir,
      sessionTtlDays: 30,
      secureCookies: false,
      issueSseMaxConnections: 16,
      issueSseMaxPerVersion: 4,
      issueAttachmentVersionQuotaBytes: 1,
      issueAttachmentUploadRateMax: 2,
      bootstrapUser: "quota-admin",
      bootstrapPassword: "quota-password",
    });
    try {
      const db = app.db;
      db.prepare("INSERT INTO venues (id, tenant_id, slug, name, created_by) VALUES (10, 1, 's', 'S', 1)").run();
      const bundle = app.blobs.put(readFileSync(join(FIXTURES_DIR, "minimal.kvb")));
      db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(bundle.hash, bundle.size);
      db.prepare(
        `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
         VALUES (100, 10, 1, ?, 'source-a', ?, 'published')`,
      ).run(PUBLIC_ID, bundle.hash);
      const cookie = cookieFor(app, 1);

      const store = new IssueAttachmentStore(dataDir);
      const service = new IssueAttachmentService({
        db,
        store,
        versions: new IssueRepository(db),
        versionQuotaBytes: 1,
        uploadRateMax: 2,
        uploadRateWindowMs: 60_000,
        processingConcurrency: 1,
      });
      const user = { id: 1, username: "quota-admin", role: "admin" } as const;
      const png = await pngBuffer();
      await expect(
        service.upload(user, PUBLIC_ID, randomUUID(), null, png),
      ).rejects.toMatchObject({ code: "quota_exceeded" });
      expect(store.list()).toEqual([]);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM issue_attachment_blobs").get() as { n: number }).n,
      ).toBe(0);

      const generous = new IssueAttachmentService({
        db,
        store,
        versions: new IssueRepository(db),
        versionQuotaBytes: 512 * 1024 * 1024,
        uploadRateMax: 2,
        uploadRateWindowMs: 60_000,
        processingConcurrency: 1,
      });
      const retained = await generous.upload(user, PUBLIC_ID, randomUUID(), null, png);
      db.prepare("UPDATE issue_attachments SET state = 'detached' WHERE id = ?").run(retained.id);
      const governedBytes = (db.prepare(
        `SELECT o.byte_size + t.byte_size AS total
         FROM issue_attachments a
         JOIN issue_attachment_blobs o ON o.hash = a.original_hash
         JOIN issue_attachment_blobs t ON t.hash = a.thumbnail_hash
         WHERE a.id = ?`,
      ).get(retained.id) as { total: number }).total;
      expect(new IssueAttachmentRepository(db).versionAttachmentBytes(100)).toBe(governedBytes);
      const referencedHashes = store.list();
      expect(referencedHashes.length).toBeGreaterThan(0);
      const restrictive = new IssueAttachmentService({
        db,
        store,
        versions: new IssueRepository(db),
        versionQuotaBytes: 1,
        uploadRateMax: 2,
        uploadRateWindowMs: 60_000,
        processingConcurrency: 1,
      });
      await expect(
        restrictive.upload(user, PUBLIC_ID, randomUUID(), null, png),
      ).rejects.toMatchObject({ code: "quota_exceeded" });
      expect(referencedHashes.every((hash) => store.has(hash))).toBe(true);

      await generous.upload(user, PUBLIC_ID, randomUUID(), null, png);
      await expect(
        generous.upload(user, PUBLIC_ID, randomUUID(), null, png),
      ).rejects.toMatchObject({ code: "rate_limited" });

      // The route maps the same limits into the wire envelope.
      const multipart = multipartUpload(randomUUID(), png);
      const response = await app.inject({
        method: "POST",
        url: `/api/review/versions/${PUBLIC_ID}/issue-attachments`,
        headers: { cookie, ...multipart.headers },
        payload: multipart.payload,
      });
      expect([403, 429]).toContain(response.statusCode);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("cancels only the uploader's own staged uploads", async () => {
    const { app, memberCookie, viewerCookie } = await seededApp();
    const staged = await upload(app, memberCookie, await pngBuffer());
    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/issue-attachments/${staged.id}`,
      headers: { cookie: viewerCookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(attachmentState(app, staged.id)).toBe("staged");

    const own = await app.inject({
      method: "DELETE",
      url: `/api/issue-attachments/${staged.id}`,
      headers: { cookie: memberCookie },
    });
    expect(own.statusCode).toBe(204);
    expect(attachmentState(app, staged.id)).toBeNull();
    // Blob rows and files were garbage-collected with the last reference.
    expect(
      (app.db.prepare("SELECT COUNT(*) AS n FROM issue_attachment_blobs").get() as { n: number }).n,
    ).toBe(0);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/issue-attachments/${staged.id}`,
      headers: { cookie: memberCookie },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("attachment binding and media reads", () => {
  it("creates an issue with attachments and serves normalized media publicly", async () => {
    const { app, memberCookie } = await seededApp();
    const staged = await upload(app, memberCookie, await jpegBuffer());
    const bodyMarkdown = `Gate is blocked. ![Gate photo](attachment:${staged.id})`;
    const created = await postIssue(app, memberCookie, {
      bodyMarkdown,
      attachmentIds: [staged.id],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(attachmentState(app, staged.id)).toBe("attached");

    const data = await collection(app);
    const issue = data.issues[0] as { attachments: UploadMetadata[] };
    expect(issue.attachments).toHaveLength(1);
    expect(issue.attachments[0]).toMatchObject({
      id: staged.id,
      contentType: "image/jpeg",
      width: 50,
      height: 20,
    });

    // Anonymous readers get the normalized original and WebP thumbnail.
    for (const [kind, type] of [["content", "image/jpeg"], ["thumbnail", "image/webp"]] as const) {
      const response = await app.inject({ method: "GET", url: `/api/issue-attachments/${staged.id}/${kind}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(type);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
      expect(response.rawPayload.byteLength).toBeGreaterThan(0);
    }
  });

  it("returns the opaque not-found response when attached media is missing", async () => {
    const { app, memberCookie } = await seededApp();
    const staged = await upload(app, memberCookie, await pngBuffer());
    const created = await postIssue(app, memberCookie, {
      bodyMarkdown: `![a](attachment:${staged.id})`,
      attachmentIds: [staged.id],
    });
    expect(created.status).toBe(200);
    const row = app.db.prepare(
      "SELECT original_hash AS hash FROM issue_attachments WHERE id = ?",
    ).get(staged.id) as { hash: string };
    unlinkSync(new IssueAttachmentStore(app.config.dataDir).path(row.hash));

    const missing = await app.inject({
      method: "GET",
      url: `/api/issue-attachments/${staged.id}/content`,
    });
    const unknown = await app.inject({
      method: "GET",
      url: `/api/issue-attachments/${randomUUID()}/content`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe(unknown.body);
  });

  it("rejects mismatched, foreign, and cross-version attachment references opaquely", async () => {
    const { app, memberCookie, viewerCookie } = await seededApp();
    const mine = await upload(app, memberCookie, await pngBuffer());
    const foreign = await upload(app, viewerCookie, await pngBuffer());
    const otherVersion = await upload(app, memberCookie, await pngBuffer(), randomUUID(), PUBLIC_ID_B);

    // Provided IDs must equal the parsed tokens.
    const mismatch = await postIssue(app, memberCookie, {
      bodyMarkdown: `![a](attachment:${mine.id})`,
      attachmentIds: [],
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ error: "invalid_attachment" });

    // A foreign staged ID cannot be bound even when named in the body.
    const stolen = await postIssue(app, memberCookie, {
      bodyMarkdown: `![a](attachment:${foreign.id})`,
      attachmentIds: [foreign.id],
    });
    expect(stolen.status).toBe(400);
    expect(stolen.body).toMatchObject({ error: "invalid_attachment" });
    expect(attachmentState(app, foreign.id)).toBe("staged");

    // Staged on another version cannot be bound here.
    const cross = await postIssue(app, memberCookie, {
      bodyMarkdown: `![a](attachment:${otherVersion.id})`,
      attachmentIds: [otherVersion.id],
    });
    expect(cross.status).toBe(400);
    expect(attachmentState(app, otherVersion.id)).toBe("staged");

    // The failed creates left no comment behind.
    expect((await collection(app)).issues).toHaveLength(0);
  });

  it("binds and detaches transactionally with body edits", async () => {
    const { app, memberCookie, viewerCookie } = await seededApp();
    const first = await upload(app, memberCookie, await pngBuffer());
    const created = await postIssue(app, memberCookie, {
      bodyMarkdown: `See ![a](attachment:${first.id})`,
      attachmentIds: [first.id],
    });
    const issueId = created.body["resourceId"] as string;

    // A patch mixing one own staged ID with one foreign ID fails wholesale:
    // body, row version, and staging are all unchanged.
    const second = await upload(app, memberCookie, await pngBuffer());
    const foreign = await upload(app, viewerCookie, await pngBuffer());
    const badPatch = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issueId}`,
      headers: { cookie: memberCookie },
      payload: {
        type: "body",
        bodyMarkdown: `![a](attachment:${first.id}) ![b](attachment:${second.id}) ![c](attachment:${foreign.id})`,
        attachmentIds: [first.id, second.id, foreign.id],
        expectedVersion: 1,
      },
    });
    expect(badPatch.statusCode).toBe(400);
    expect(attachmentState(app, second.id)).toBe("staged");
    expect(attachmentState(app, first.id)).toBe("attached");
    let data = await collection(app);
    expect((data.issues[0] as { rowVersion: number }).rowVersion).toBe(1);

    // A valid patch attaches the new ID; removing the first detaches it and
    // revokes its media immediately.
    const goodPatch = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issueId}`,
      headers: { cookie: memberCookie },
      payload: {
        type: "body",
        bodyMarkdown: `updated ![b](attachment:${second.id})`,
        attachmentIds: [second.id],
        expectedVersion: 1,
      },
    });
    expect(goodPatch.statusCode).toBe(200);
    expect(attachmentState(app, second.id)).toBe("attached");
    expect(attachmentState(app, first.id)).toBe("detached");
    const revoked = await app.inject({ method: "GET", url: `/api/issue-attachments/${first.id}/content` });
    expect(revoked.statusCode).toBe(404);
    const kept = await app.inject({ method: "GET", url: `/api/issue-attachments/${second.id}/content` });
    expect(kept.statusCode).toBe(200);

    // Undoing the removal re-attaches the detached ID (conflict recovery).
    const undo = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issueId}`,
      headers: { cookie: memberCookie },
      payload: {
        type: "body",
        bodyMarkdown: `![a](attachment:${first.id}) ![b](attachment:${second.id})`,
        attachmentIds: [first.id, second.id],
        expectedVersion: 2,
      },
    });
    expect(undo.statusCode).toBe(200);
    expect(attachmentState(app, first.id)).toBe("attached");

    // A stale patch touches nothing, including staging.
    const third = await upload(app, memberCookie, await pngBuffer());
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issueId}`,
      headers: { cookie: memberCookie },
      payload: {
        type: "body",
        bodyMarkdown: `![a](attachment:${third.id})`,
        attachmentIds: [third.id],
        expectedVersion: 1,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(attachmentState(app, third.id)).toBe("staged");
    data = await collection(app);
    expect((data.issues[0] as { rowVersion: number }).rowVersion).toBe(3);
  });

  it("enforces the aggregate limit using admitted input bytes", async () => {
    const { app, memberCookie } = await seededApp();
    const staged = await Promise.all([
      upload(app, memberCookie, await pngBuffer()),
      upload(app, memberCookie, await pngBuffer(), randomUUID()),
      upload(app, memberCookie, await pngBuffer(), randomUUID()),
    ]);
    app.db.prepare("UPDATE issue_attachments SET input_byte_size = ? WHERE id = ?")
      .run(9 * 1024 * 1024, staged[0]?.id);
    app.db.prepare("UPDATE issue_attachments SET input_byte_size = ? WHERE id = ?")
      .run(9 * 1024 * 1024, staged[1]?.id);
    app.db.prepare("UPDATE issue_attachments SET input_byte_size = ? WHERE id = ?")
      .run(9 * 1024 * 1024, staged[2]?.id);
    const bodyMarkdown = staged.map((item) => `![a](attachment:${item.id})`).join(" ");
    const response = await postIssue(app, memberCookie, {
      bodyMarkdown,
      attachmentIds: staged.map((item) => item.id),
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_attachment" });
    expect(staged.map((item) => attachmentState(app, item.id))).toEqual([
      "staged",
      "staged",
      "staged",
    ]);
  });

  it("creates replies with attachments and keeps reply media live under a deleted root", async () => {
    const { app, memberCookie } = await seededApp();
    const created = await postIssue(app, memberCookie, { bodyMarkdown: "root" });
    const issueId = created.body["resourceId"] as string;
    const staged = await upload(app, memberCookie, await pngBuffer());
    const reply = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/replies`,
      headers: { cookie: memberCookie },
      payload: {
        requestId: randomUUID(),
        bodyMarkdown: `with photo ![p](attachment:${staged.id})`,
        attachmentIds: [staged.id],
      },
    });
    expect(reply.statusCode).toBe(200);
    const replyId = reply.json().resourceId as string;

    const data = await collection(app);
    const issue = data.issues[0] as { replies: Array<{ id: string; attachments: UploadMetadata[] }> };
    expect(issue.replies[0]?.attachments[0]?.id).toBe(staged.id);

    // Deleting the root tombstones it but the live reply keeps its media.
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/issues/${issueId}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 1 },
    });
    expect(deleted.statusCode).toBe(200);
    const media = await app.inject({ method: "GET", url: `/api/issue-attachments/${staged.id}/content` });
    expect(media.statusCode).toBe(200);

    // Deleting the reply revokes its media immediately.
    const deletedReply = await app.inject({
      method: "DELETE",
      url: `/api/replies/${replyId}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 1 },
    });
    expect(deletedReply.statusCode).toBe(200);
    const revoked = await app.inject({ method: "GET", url: `/api/issue-attachments/${staged.id}/content` });
    expect(revoked.statusCode).toBe(404);
    const after = await collection(app);
    const tombstoned = after.issues[0] as { attachments: unknown[]; replies: Array<{ attachments: unknown[] }> };
    expect(tombstoned.attachments).toEqual([]);
    expect(tombstoned.replies[0]?.attachments).toEqual([]);
  });

  it("revokes root media on tombstone and on version unpublish", async () => {
    const { app, memberCookie } = await seededApp();
    const staged = await upload(app, memberCookie, await pngBuffer());
    const created = await postIssue(app, memberCookie, {
      bodyMarkdown: `![a](attachment:${staged.id})`,
      attachmentIds: [staged.id],
    });
    const issueId = created.body["resourceId"] as string;
    const live = await app.inject({ method: "GET", url: `/api/issue-attachments/${staged.id}/content` });
    expect(live.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/issues/${issueId}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 1 },
    });
    expect(deleted.statusCode).toBe(200);
    const revoked = await app.inject({ method: "GET", url: `/api/issue-attachments/${staged.id}/content` });
    expect(revoked.statusCode).toBe(404);

    // Unpublishing the version revokes remaining (reply-less) media lookups.
    const second = await upload(app, memberCookie, await pngBuffer());
    const other = await postIssue(app, memberCookie, {
      bodyMarkdown: `![b](attachment:${second.id})`,
      attachmentIds: [second.id],
    });
    expect(other.status).toBe(200);
    app.db.prepare("UPDATE versions SET status = 'archived' WHERE id = 100").run();
    const unpublished = await app.inject({ method: "GET", url: `/api/issue-attachments/${second.id}/content` });
    expect(unpublished.statusCode).toBe(404);
  });

  it("shares attachment idempotency across create replay", async () => {
    const { app, memberCookie } = await seededApp();
    const staged = await upload(app, memberCookie, await pngBuffer());
    const requestId = randomUUID();
    const payload = {
      requestId,
      bodyMarkdown: `![a](attachment:${staged.id})`,
      attachmentIds: [staged.id],
    };
    const first = await postIssue(app, memberCookie, payload);
    const replay = await postIssue(app, memberCookie, payload);
    expect(replay.status).toBe(200);
    expect(replay.body["resourceId"]).toBe(first.body["resourceId"]);
    expect((await collection(app)).issues).toHaveLength(1);
  });
});

describe("attachment janitor", () => {
  it("expires staged uploads after 24 hours and frees blobs and files", async () => {
    const { app, memberCookie } = await seededApp();
    const staged = await upload(app, memberCookie, await pngBuffer());
    const store = new IssueAttachmentStore(app.config.dataDir);
    const hashes = (app.db.prepare("SELECT hash FROM issue_attachment_blobs").all() as { hash: string }[])
      .map((row) => row.hash);
    expect(hashes.every((hash) => store.has(hash))).toBe(true);

    // Fresh staged rows survive a janitor pass.
    runIssueAttachmentJanitor(app.db, store, new Date());
    expect(attachmentState(app, staged.id)).toBe("staged");

    app.db
      .prepare("UPDATE issue_attachments SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), staged.id);
    const result = runIssueAttachmentJanitor(app.db, store, new Date());
    expect(result.removedAttachments).toBe(1);
    expect(attachmentState(app, staged.id)).toBeNull();
    expect(hashes.every((hash) => !store.has(hash))).toBe(true);
  });

  it("expires detached and tombstoned media after 30 days but not earlier", async () => {
    const { app, memberCookie } = await seededApp();
    const store = new IssueAttachmentStore(app.config.dataDir);
    const detached = await upload(app, memberCookie, await pngBuffer());
    const created = await postIssue(app, memberCookie, {
      bodyMarkdown: `![a](attachment:${detached.id})`,
      attachmentIds: [detached.id],
    });
    const issueId = created.body["resourceId"] as string;
    await app.inject({
      method: "PATCH",
      url: `/api/issues/${issueId}`,
      headers: { cookie: memberCookie },
      payload: { type: "body", bodyMarkdown: "text only", attachmentIds: [], expectedVersion: 1 },
    });
    expect(attachmentState(app, detached.id)).toBe("detached");

    const in29Days = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);
    runIssueAttachmentJanitor(app.db, store, in29Days);
    expect(attachmentState(app, detached.id)).toBe("detached");

    const in31Days = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    runIssueAttachmentJanitor(app.db, store, in31Days);
    expect(attachmentState(app, detached.id)).toBeNull();

    // Attached media of a tombstoned comment is removed after the same grace.
    const tombstoned = await upload(app, memberCookie, await pngBuffer());
    const second = await postIssue(app, memberCookie, {
      bodyMarkdown: `![b](attachment:${tombstoned.id})`,
      attachmentIds: [tombstoned.id],
    });
    await app.inject({
      method: "DELETE",
      url: `/api/issues/${second.body["resourceId"] as string}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 1 },
    });
    runIssueAttachmentJanitor(app.db, store, in29Days);
    expect(attachmentState(app, tombstoned.id)).toBe("attached");
    runIssueAttachmentJanitor(app.db, store, in31Days);
    expect(attachmentState(app, tombstoned.id)).toBeNull();
  });

  it("sweeps filesystem orphans after a safety age without touching live data", async () => {
    const { app, memberCookie } = await seededApp();
    const store = new IssueAttachmentStore(app.config.dataDir);
    const staged = await upload(app, memberCookie, await pngBuffer());

    // An unknown recent file is kept; an aged one is removed.
    const orphan = store.put(Buffer.from("orphan bytes"));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { utimesSync } = await import("node:fs");
    utimesSync(store.path(orphan.hash), old, old);
    runIssueAttachmentJanitor(app.db, store, new Date());
    expect(store.has(orphan.hash)).toBe(false);
    expect(attachmentState(app, staged.id)).toBe("staged");
  });

  it("enforces migration constraints", async () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'a', 'x', 'admin')").run();
    db.prepare("INSERT INTO venues (id, tenant_id, slug, name, created_by) VALUES (10, 1, 's', 'S', 1)").run();
    db.prepare(
      `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
       VALUES (100, 10, 1, ?, 's', 'b', 'published')`,
    ).run(PUBLIC_ID);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO issue_attachment_blobs (hash, byte_size, content_type, width, height, created_at)
       VALUES (?, 10, 'image/png', 1, 1, ?)`,
    ).run("a".repeat(64), now);
    const insert = db.prepare(
      `INSERT INTO issue_attachments (
         id, version_id, uploader_id, upload_request_id, upload_request_hash,
         original_hash, thumbnail_hash, input_byte_size, state, created_at
       ) VALUES (?, 100, 1, ?, ?, ?, ?, 10, ?, ?)`,
    );
    expect(() =>
      insert.run("not-a-uuid", randomUUID(), "b".repeat(64), "a".repeat(64), "a".repeat(64), "staged", now),
    ).toThrow();
    expect(() =>
      insert.run(randomUUID(), randomUUID(), "b".repeat(64), "a".repeat(64), "a".repeat(64), "bogus", now),
    ).toThrow();
    expect(() =>
      insert.run(randomUUID(), randomUUID(), "b".repeat(64), "a".repeat(64), "a".repeat(64), "attached", now),
    ).toThrow(); // attached requires a comment
    expect(() =>
      insert.run(randomUUID(), randomUUID(), "B".repeat(64), "a".repeat(64), "a".repeat(64), "staged", now),
    ).toThrow(); // non-lowercase hash
  });
});
