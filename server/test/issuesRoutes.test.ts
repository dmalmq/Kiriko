import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createSession } from "../src/auth/sessions";
import { cleanupTestApps, loginCookie, makeTestApp } from "./helpers";

const PUBLIC_ID = "a".repeat(64);
const DRAFT_ID = "d".repeat(64);
const UNKNOWN_ID = "f".repeat(64);
const LEVEL_ID = "b1000001-0000-4000-8000-0000000000b1";
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures");
const NO_STORE = "no-store";

interface SseFrameState {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
}

async function readSseFrame(state: SseFrameState): Promise<string> {
  while (true) {
    const end = state.buffer.indexOf("\n\n");
    if (end >= 0) {
      const frame = state.buffer.slice(0, end + 2);
      state.buffer = state.buffer.slice(end + 2);
      return frame;
    }
    const chunk = await state.reader.read();
    if (chunk.done) {
      throw new Error(`SSE stream ended with an incomplete frame: ${JSON.stringify(state.buffer)}`);
    }
    state.buffer += state.decoder.decode(chunk.value, { stream: true });
  }
}

interface SeededApp {
  app: FastifyInstance;
  adminCookie: string;
  memberCookie: string;
  viewerCookie: string;
}

function cookieFor(app: FastifyInstance, userId: number): string {
  return `kiriko_session=${createSession(app.db, userId, 30)}`;
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
            (101, 10, 2, ?, 'source-d', NULL, 'draft')`,
  ).run(PUBLIC_ID, bundle.hash, DRAFT_ID);
  return {
    app,
    adminCookie: await loginCookie(app),
    memberCookie: cookieFor(app, 2),
    viewerCookie: cookieFor(app, 3),
  };
}

function rootPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    bodyMarkdown: "Broken escalator",
    anchor: { levelId: LEVEL_ID, longitude: 139.7, latitude: 35.68 },
    ...overrides,
  };
}

async function createIssue(app: FastifyInstance, cookie: string, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: `/api/review/versions/${PUBLIC_ID}/issues`,
    headers: { cookie },
    payload: rootPayload(overrides),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ revision: number; resourceId: string }>();
}

function expectNoStore(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe(NO_STORE);
}

afterEach(cleanupTestApps);

describe("issue REST routes", () => {
  it("serves the exact empty published collection publicly with no-store", async () => {
    const { app } = await seededApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 0, issues: [] });
    expectNoStore(response);
  });

  it("keeps unpublished, unknown, and malformed public IDs opaque", async () => {
    const { app } = await seededApp();
    const expected = { error: "not_found", message: "The review issue was not found." };
    for (const publicId of [DRAFT_ID, UNKNOWN_ID]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/review/versions/${publicId}/issues`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(expected);
      expectNoStore(response);
    }

    const malformed = await app.inject({
      method: "GET",
      url: "/api/review/versions/not-a-public-id/issues",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: "invalid_request",
      message: "The request is invalid.",
      details: [{ field: "publicVersionId", reason: 'must match pattern "^[0-9a-f]{64}$"' }],
    });
    expectNoStore(malformed);
    const malformedSse = await app.inject({
      method: "GET",
      url: "/api/review/versions/not-a-public-id/issues/events",
    });
    expect(malformedSse.statusCode).toBe(400);
    expect(malformedSse.json()).toEqual(malformed.json());
    expectNoStore(malformedSse);
  });

  it("requires authentication for reviewers and returns only public reviewer fields", async () => {
    const { app, memberCookie } = await seededApp();
    const unauthorized = await app.inject({ method: "GET", url: "/api/reviewers" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({
      error: "unauthorized",
      message: "Authentication is required.",
    });
    expectNoStore(unauthorized);

    const response = await app.inject({
      method: "GET",
      url: "/api/reviewers",
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      reviewers: [
        { id: 2, username: "member" },
        { id: 1, username: "test" },
        { id: 3, username: "viewer" },
      ],
    });
    expect(JSON.stringify(response.json())).not.toMatch(/password|role|hash/i);
    expectNoStore(response);
  });

  it("creates and replays a root with the exact mutation wire projection", async () => {
    const { app, memberCookie } = await seededApp();
    const payload = rootPayload();
    const first = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie },
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(first.json()).toEqual({ revision: 1, resourceId: expect.any(String) });
    expect(replay.json()).toEqual(first.json());
    expect(Object.keys(first.json()).sort()).toEqual(["resourceId", "revision"]);
    expectNoStore(first);
    expectNoStore(replay);

    const collection = await app.inject({
      method: "GET",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
    });
    expect(collection.json().revision).toBe(1);
    expect(collection.json().issues).toHaveLength(1);
  });

  it("creates a reply, supports all patch operations, and exposes exact public DTOs", async () => {
    const { app, memberCookie, adminCookie } = await seededApp();
    const issue = await createIssue(app, memberCookie);
    const reply = await app.inject({
      method: "POST",
      url: `/api/issues/${issue.resourceId}/replies`,
      headers: { cookie: memberCookie },
      payload: { requestId: randomUUID(), bodyMarkdown: "Investigating" },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json()).toEqual({ revision: 2, resourceId: expect.any(String) });
    expectNoStore(reply);
    const replyId = reply.json().resourceId as string;

    const operations = [
      { type: "body", bodyMarkdown: "Escalator is stopped", expectedVersion: 1 },
      { type: "assignment", assigneeId: 2, expectedVersion: 2 },
      { type: "due_date", dueDate: "2026-08-01", expectedVersion: 3 },
      { type: "status", status: "in_review", expectedVersion: 4 },
    ];
    for (const [index, payload] of operations.entries()) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/issues/${issue.resourceId}`,
        headers: { cookie: index < 2 ? memberCookie : adminCookie },
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ revision: index + 3, resourceId: issue.resourceId });
      expectNoStore(response);
    }

    const patchedReply = await app.inject({
      method: "PATCH",
      url: `/api/replies/${replyId}`,
      headers: { cookie: memberCookie },
      payload: { type: "body", bodyMarkdown: "Repair scheduled", expectedVersion: 1 },
    });
    expect(patchedReply.statusCode, patchedReply.body).toBe(200);
    expect(patchedReply.json()).toEqual({ revision: 7, resourceId: replyId });
    expectNoStore(patchedReply);

    const collection = await app.inject({
      method: "GET",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
    });
    expect(collection.statusCode, collection.body).toBe(200);
    expect(collection.json()).toEqual({
      revision: 7,
      issues: [
        {
          id: issue.resourceId,
          pinNumber: 1,
          rowVersion: 5,
          anchor: { levelId: LEVEL_ID, longitude: 139.7, latitude: 35.68 },
          status: "in_review",
          author: { id: 2, username: "member" },
          assignee: { id: 2, username: "member" },
          dueDate: "2026-08-01",
          bodyMarkdown: "Escalator is stopped",
          attachments: [],
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
          updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
          deletedAt: null,
          replies: [
            {
              id: replyId,
              rowVersion: 2,
              author: { id: 2, username: "member" },
              bodyMarkdown: "Repair scheduled",
              attachments: [],
              createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
              updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
              deletedAt: null,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(collection.json())).not.toMatch(/versionId|publicVersionId|authorId|assigneeId|requestId|hash|replayed/);
    expectNoStore(collection);
  });

  it("returns tombstones without deleted bodies for both delete routes", async () => {
    const { app, memberCookie } = await seededApp();
    const issue = await createIssue(app, memberCookie);
    const reply = await app.inject({
      method: "POST",
      url: `/api/issues/${issue.resourceId}/replies`,
      headers: { cookie: memberCookie },
      payload: { requestId: randomUUID(), bodyMarkdown: "private reply" },
    });
    const replyId = reply.json().resourceId as string;

    const deletedReply = await app.inject({
      method: "DELETE",
      url: `/api/replies/${replyId}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 1 },
    });
    expect(deletedReply.statusCode, deletedReply.body).toBe(200);
    expect(deletedReply.json()).toEqual({ revision: 3, resourceId: replyId });
    expectNoStore(deletedReply);

    const deletedIssue = await app.inject({
      method: "DELETE",
      url: `/api/issues/${issue.resourceId}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 1 },
    });
    expect(deletedIssue.statusCode, deletedIssue.body).toBe(200);
    expect(deletedIssue.json()).toEqual({ revision: 4, resourceId: issue.resourceId });
    expectNoStore(deletedIssue);

    const collection = await app.inject({
      method: "GET",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
    });
    const wire = collection.json();
    expect(wire.issues[0].bodyMarkdown).toBeNull();
    expect(wire.issues[0].deletedAt).toMatch(/Z$/);
    expect(wire.issues[0].replies[0].bodyMarkdown).toBeNull();
    expect(wire.issues[0].replies[0].deletedAt).toMatch(/Z$/);
    expect(collection.body).not.toContain("private reply");
    expect(collection.body).not.toContain("Broken escalator");
  });

  it("returns exact 401 and 403 envelopes for guarded mutations", async () => {
    const { app, memberCookie, viewerCookie } = await seededApp();
    const unauthorized = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      payload: rootPayload(),
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ error: "unauthorized", message: "Authentication is required." });
    expectNoStore(unauthorized);

    const issue = await createIssue(app, memberCookie);
    const forbidden = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.resourceId}`,
      headers: { cookie: viewerCookie },
      payload: { type: "status", status: "closed", expectedVersion: 1 },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: "forbidden", message: "You cannot change this review issue." });
    expectNoStore(forbidden);
  });

  it("maps all four 400 categories and rejects strict request extras", async () => {
    const { app, memberCookie } = await seededApp();
    const cases = [
      {
        payload: rootPayload({ requestId: "not-a-v4" }),
        code: "invalid_request",
      },
      {
        payload: rootPayload({ anchor: { levelId: "missing", longitude: 0, latitude: 0 } }),
        code: "invalid_anchor",
      },
      {
        payload: rootPayload({ dueDate: "2026-02-30" }),
        code: "invalid_due_date",
      },
      {
        payload: rootPayload({ bodyMarkdown: "" }),
        code: "invalid_markdown",
      },
      {
        payload: { ...rootPayload(), extra: true },
        code: "invalid_request",
      },
    ];
    for (const testCase of cases) {
      const response = await app.inject({
        method: "POST",
        url: `/api/review/versions/${PUBLIC_ID}/issues`,
        headers: { cookie: memberCookie },
        payload: testCase.payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe(testCase.code);
      expect(response.json().message).toBeTypeOf("string");
      expectNoStore(response);
    }

    const malformedJson = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: "{\"requestId\":",
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toEqual({
      error: "invalid_request",
      message: "The request is invalid.",
      details: [{ field: "body", reason: "must be valid JSON" }],
    });
    expectNoStore(malformedJson);

    const oversizedBody = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: JSON.stringify(rootPayload({ bodyMarkdown: "x".repeat(1_100_000) })),
    });
    expect(oversizedBody.statusCode).toBe(400);
    expect(oversizedBody.json()).toEqual({
      error: "invalid_request",
      message: "The request is invalid.",
    });
    expect(oversizedBody.body).not.toMatch(/limit|size|bytes|stack/i);
    expectNoStore(oversizedBody);

    const unsupportedMedia = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie, "content-type": "application/xml" },
      payload: "<issue />",
    });
    expect(unsupportedMedia.statusCode).toBe(400);
    expect(unsupportedMedia.json()).toEqual({
      error: "invalid_request",
      message: "The request is invalid.",
    });
    expect(unsupportedMedia.body).not.toMatch(/media|xml|parser|stack/i);
    expectNoStore(unsupportedMedia);

    const invalidLength = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie, "content-length": "20" },
      payload: rootPayload(),
    });
    expect(invalidLength.statusCode).toBe(400);
    expect(invalidLength.json()).toEqual({
      error: "invalid_request",
      message: "The request is invalid.",
    });
    expect(invalidLength.body).not.toMatch(/length|size|bytes|stack/i);
    expectNoStore(invalidLength);
  });

  it("returns the three exact 409 conflict shapes including stale current", async () => {
    const { app, memberCookie } = await seededApp();
    const issue = await createIssue(app, memberCookie);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.resourceId}`,
      headers: { cookie: memberCookie },
      payload: { type: "body", bodyMarkdown: "stale edit", expectedVersion: 99 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: "stale_issue",
      message: "The issue changed since you loaded it.",
      revision: 1,
      current: { kind: "issue", value: { id: issue.resourceId, rowVersion: 1 } },
    });
    expect(Object.keys(stale.json()).sort()).toEqual(["current", "error", "message", "revision"]);
    expectNoStore(stale);

    const requestId = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: `/api/issues/${issue.resourceId}/replies`,
      headers: { cookie: memberCookie },
      payload: { requestId, bodyMarkdown: "one" },
    });
    expect(first.statusCode).toBe(200);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/issues/${issue.resourceId}/replies`,
      headers: { cookie: memberCookie },
      payload: { requestId, bodyMarkdown: "different" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: "idempotency_conflict",
      message: "This request ID was already used for a different create request.",
    });
    expectNoStore(conflict);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/issues/${issue.resourceId}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 1 },
    });
    expect(deleted.statusCode).toBe(200);
    const deletedAgain = await app.inject({
      method: "DELETE",
      url: `/api/issues/${issue.resourceId}`,
      headers: { cookie: memberCookie },
      payload: { expectedVersion: 2 },
    });
    expect(deletedAgain.statusCode).toBe(409);
    expect(deletedAgain.json()).toEqual({
      error: "issue_deleted",
      message: "This review issue has been deleted.",
    });
    expectNoStore(deletedAgain);
  });

  it("uses identical opaque not-found responses for issue and reply IDs", async () => {
    const { app, memberCookie } = await seededApp();
    const expected = { error: "not_found", message: "The review issue was not found." };
    const requests = [
      { method: "PATCH", url: "/api/issues/not-an-id", payload: { type: "body", bodyMarkdown: "x", expectedVersion: 1 } },
      { method: "PATCH", url: "/api/replies/not-an-id", payload: { type: "body", bodyMarkdown: "x", expectedVersion: 1 } },
    ] as const;
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: { cookie: memberCookie } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(expected);
      expectNoStore(response);
    }
  });

  it("sanitizes unexpected storage/native failures as internal_error", async () => {
    const { app, memberCookie } = await seededApp();
    app.db.prepare("UPDATE versions SET bundle_hash = ? WHERE id = 100").run("0".repeat(64));
    const response = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie },
      payload: rootPayload(),
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "internal_error",
      message: "Could not update review issues.",
    });
    expect(response.body).not.toMatch(/ENOENT|blob|native|stack/i);
    expectNoStore(response);
  });

  it("shares one production repository, hub, and service between public SSE and REST mutations", async () => {
    const { app, memberCookie } = await seededApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const stream = await fetch(
      `http://127.0.0.1:${port}/api/review/versions/${PUBLIC_ID}/issues/events`,
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const frames: SseFrameState = {
      reader: stream.body!.getReader(),
      decoder: new TextDecoder(),
      buffer: "",
    };
    expect(await readSseFrame(frames)).toBe('event: revision\ndata: {"revision":0}\n\n');

    const payload = rootPayload();
    const mutation = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie },
      payload,
    });
    expect(mutation.json()).toEqual({ revision: 1, resourceId: expect.any(String) });
    expect(await readSseFrame(frames)).toBe('event: revision\ndata: {"revision":1}\n\n');

    const replay = await app.inject({
      method: "POST",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
      headers: { cookie: memberCookie },
      payload,
    });
    expect(replay.json()).toEqual(mutation.json());
    const collection = await app.inject({
      method: "GET",
      url: `/api/review/versions/${PUBLIC_ID}/issues`,
    });
    expect(collection.json().revision).toBe(1);
    await frames.reader.cancel();
  });

  it("enforces production SSE capacity with the exact 503 envelope and releases it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kiriko-capacity-test-"));
    const app = await buildApp({
      dataDir,
      sessionTtlDays: 30,
      secureCookies: false,
      issueSseMaxConnections: 1,
      issueSseMaxPerVersion: 1,
      bootstrapUser: "capacity",
      bootstrapPassword: "capacity-password",
    });
    try {
      app.db.prepare("INSERT INTO venues (id, tenant_id, slug, name) VALUES (10, 1, 'station', 'Station')").run();
      app.db.prepare(
        `INSERT INTO versions (id, venue_id, seq, public_id, source_blob_hash, bundle_hash, status)
         VALUES (100, 10, 1, ?, 'source', 'bundle', 'published')`,
      ).run(PUBLIC_ID);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/api/review/versions/${PUBLIC_ID}/issues/events`;
      const first = await fetch(url);
      const firstReader = first.body!.getReader();
      await firstReader.read();

      const rejected = await fetch(url);
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("retry-after")).toBe("15");
      expect(rejected.headers.get("cache-control")).toBe("no-store");
      expect(await rejected.json()).toEqual({
        error: "sse_capacity",
        message: "Too many issue event streams are open.",
      });

      await firstReader.cancel();
      const replacement = await fetch(url);
      expect(replacement.status).toBe(200);
      await replacement.body!.cancel();
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("publishes exact response status schemas for all nine issue routes", async () => {
    const { app } = await seededApp();
    const response = await app.inject({ method: "GET", url: "/api/openapi.json" });
    const document = response.json<{
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    }>();
    const expected: Record<string, Record<string, string[]>> = {
      [`/api/review/versions/{publicVersionId}/issues`]: {
        get: ["200", "400", "404", "500"],
        post: ["200", "400", "401", "403", "404", "409", "500"],
      },
      [`/api/review/versions/{publicVersionId}/issues/events`]: {
        get: ["400", "404", "500", "503"],
      },
      "/api/reviewers": { get: ["200", "401", "500"] },
      "/api/issues/{issueId}/replies": {
        post: ["200", "400", "401", "403", "404", "409", "500"],
      },
      "/api/issues/{issueId}": {
        patch: ["200", "400", "401", "403", "404", "409", "500"],
        delete: ["200", "400", "401", "403", "404", "409", "500"],
      },
      "/api/replies/{replyId}": {
        patch: ["200", "400", "401", "403", "404", "409", "500"],
        delete: ["200", "400", "401", "403", "404", "409", "500"],
      },
    };
    for (const [path, methods] of Object.entries(expected)) {
      for (const [method, statuses] of Object.entries(methods)) {
        expect(Object.keys(document.paths[path]![method]!.responses).sort()).toEqual(statuses);
      }
    }
  });
});
