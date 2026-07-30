import { createHash, randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { SESSION_ROLES, type SessionRole } from "../src/auth/sessions";
import { ISSUE_ERROR_STATUS, IssueServiceError, toIssueErrorResponse } from "../src/issues/errors";
import {
  DeleteBodySchema,
  IssueApiErrorSchema,
  IssueCollectionSchema,
  IssuePatchAssignmentSchema,
  IssuePatchBodySchema,
  IssuePatchDueDateSchema,
  IssuePatchSchema,
  IssuePatchStatusSchema,
  IssueReplySchema,
  MutationResponseSchema,
  PublicVersionIdSchema,
  ReplyCreateBodySchema,
  RequestIdSchema,
  ReviewersResponseSchema,
  ReviewIssueSchema,
  RootCreateBodySchema,
} from "../src/issues/schemas";
import type { IssueErrorCode, IssueReply, NormalizedRootCreate, RootCreateBody } from "../src/issues/types";
import {
  hashReplyCreate,
  hashRootCreate,
  normalizeMarkdown,
  normalizeReplyCreate,
  normalizeRootCreate,
  validateCoordinates,
  validateDueDate,
  validateMarkdownBody,
  validateRequestId,
} from "../src/issues/validation";

function expectServiceError(fn: () => unknown, code: IssueErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(IssueServiceError);
  expect((thrown as IssueServiceError).code).toBe(code);
}

describe("session roles", () => {
  it("enumerates exactly viewer, member, and admin", () => {
    expect([...SESSION_ROLES].sort()).toEqual(["admin", "member", "viewer"]);
    // Compile-time exhaustiveness: adding or removing a role breaks this record.
    const table: Record<SessionRole, number> = { viewer: 0, member: 1, admin: 2 };
    expect(Object.keys(table)).toHaveLength(SESSION_ROLES.length);
  });
});

describe("normalizeMarkdown", () => {
  const cases: Array<[input: string, expected: string]> = [
    ["a\r\nb\rc", "a\nb\nc"],
    ["a\rb", "a\nb"],
    ["a\r\r\nb", "a\n\nb"],
    ["\r\n\r\n", "\n\n"],
    ["already\nnormalized", "already\nnormalized"],
    ["no newline", "no newline"],
  ];
  it.each(cases)("normalizes %j to %j", (input, expected) => {
    expect(normalizeMarkdown(input)).toBe(expected);
  });
});

describe("validateMarkdownBody", () => {
  it("accepts 1 and 4000 Unicode scalar values", () => {
    expect(validateMarkdownBody("a")).toBe("a");
    expect(validateMarkdownBody("b".repeat(4000))).toBe("b".repeat(4000));
  });

  it("rejects 0 and 4001 Unicode scalar values", () => {
    expectServiceError(() => validateMarkdownBody(""), "invalid_markdown");
    expectServiceError(() => validateMarkdownBody("b".repeat(4001)), "invalid_markdown");
  });

  it("counts astral characters once", () => {
    // Each emoji is two UTF-16 code units but one scalar value.
    expect(validateMarkdownBody("\u{1F600}".repeat(4000))).toBe("\u{1F600}".repeat(4000));
    expectServiceError(() => validateMarkdownBody("\u{1F600}".repeat(4001)), "invalid_markdown");
  });

  it("measures the limit after newline normalization", () => {
    // 4001 raw UTF-16 units collapse to exactly 4000 scalars after CRLF -> LF.
    const raw = `a\r\n${"b".repeat(3998)}`;
    expect(validateMarkdownBody(raw)).toBe(`a\n${"b".repeat(3998)}`);
  });

  const rejected: Array<[label: string, input: string]> = [
    ["lone high surrogate", "a\uD83Db"],
    ["lone low surrogate", "a\uDE00b"],
    ["trailing lone high surrogate", "ok\uD800"],
    ["whitespace-only spaces", "   "],
    ["whitespace-only tabs and newlines", " \t\n \t "],
    ["NUL control", "a\u0000b"],
    ["BEL control", "a\u0007b"],
    ["vertical tab", "a\u000Bb"],
    ["unit separator", "a\u001Fb"],
    ["carriage-return survivor is impossible but DEL is rejected", "a\u007Fb"],
    ["C1 padding", "a\u0080b"],
    ["C1 APC", "a\u009Fb"],
  ];
  it.each(rejected)("rejects %s", (_label, input) => {
    expectServiceError(() => validateMarkdownBody(input), "invalid_markdown");
  });

  const accepted: Array<[label: string, input: string]> = [
    ["tab", "a\tb"],
    ["line feed", "a\nb"],
    ["paired surrogates", "a\uD83D\uDE00b"],
    ["preserved leading/trailing whitespace", "  padded body  "],
  ];
  it.each(accepted)("accepts %s", (_label, input) => {
    expect(validateMarkdownBody(input)).toBe(input);
  });
});

describe("validateDueDate", () => {
  const valid = [
    "2026-01-01",
    "2026-02-28",
    "2028-02-29", // leap year divisible by 4
    "2400-02-29", // leap year divisible by 400
    "2026-04-30",
    "2026-12-31",
    "2026-01-31",
  ];
  it.each(valid)("accepts %s unchanged", (date) => {
    expect(validateDueDate(date)).toBe(date);
  });

  const invalid = [
    "2027-02-29", // not a leap year
    "2100-02-29", // divisible by 100 but not 400
    "2026-02-30",
    "2026-04-31",
    "2026-00-10",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "26-01-01",
    "2026-1-1",
    "2026/01/01",
    "2026-01-01T00:00:00Z",
    "2026-01-01 ",
    "",
  ];
  it.each(invalid)("rejects %j", (date) => {
    expectServiceError(() => validateDueDate(date), "invalid_due_date");
    expect(() => validateDueDate(date)).toThrowError("invalid_due_date");
  });
});

describe("validateCoordinates", () => {
  const valid: Array<[longitude: number, latitude: number]> = [
    [0, 0],
    [139.7671, 35.6812],
    [-180, -90],
    [180, 90],
    [-180, 90],
    [180, -90],
  ];
  it.each(valid)("accepts longitude %d latitude %d", (longitude, latitude) => {
    expect(() => validateCoordinates(longitude, latitude)).not.toThrow();
  });

  const invalid: Array<[longitude: number, latitude: number]> = [
    [180.0000001, 0],
    [-180.0000001, 0],
    [0, 90.0000001],
    [0, -90.0000001],
    [Number.NaN, 0],
    [0, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
    [0, Number.NEGATIVE_INFINITY],
  ];
  it.each(invalid)("rejects longitude %d latitude %d", (longitude, latitude) => {
    expectServiceError(() => validateCoordinates(longitude, latitude), "invalid_anchor");
  });
});

describe("validateRequestId", () => {
  it("accepts generated and fixed lowercase UUID v4 values", () => {
    const generated = randomUUID();
    expect(validateRequestId(generated)).toBe(generated);
    expect(validateRequestId("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")).toBe(
      "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    );
  });

  it("accepts standards-valid uppercase/mixed hex and canonicalizes to lowercase", () => {
    expect(validateRequestId("9F1C2D3E-4B5A-4C6D-8E7F-0A1B2C3D4E5F")).toBe(
      "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    );
    expect(validateRequestId("9f1c2D3E-4b5a-4C6D-8e7f-0A1B2c3d4e5f")).toBe(
      "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    );
    expect(validateRequestId("9F1C2D3E-4B5A-4C6D-AE7F-0A1B2C3D4E5F")).toBe(
      "9f1c2d3e-4b5a-4c6d-ae7f-0a1b2c3d4e5f",
    );
  });

  const invalid = [
    "9f1c2d3e4b5a4c6d8e7f0a1b2c3d4e5f", // no dashes
    "9f1c2d3e-4b5a-1c6d-8e7f-0a1b2c3d4e5f", // version 1
    "9F1C2D3E-4B5A-1C6D-8E7F-0A1B2C3D4E5F", // version 1 uppercase
    "9f1c2d3e-4b5a-4c6d-ce7f-0a1b2c3d4e5f", // invalid variant nibble
    "9F1C2D3E-4B5A-4C6D-CE7F-0A1B2C3D4E5F", // invalid variant nibble uppercase
    "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5", // short
    "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f0", // long
    "",
  ];
  it.each(invalid)("rejects %j", (value) => {
    expectServiceError(() => validateRequestId(value), "invalid_request");
  });
});

const BASE_ROOT: RootCreateBody = {
  requestId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  bodyMarkdown: "Fix the door label",
  anchor: { levelId: "lvl-1", longitude: 139.7671, latitude: 35.6812 },
};

describe("normalization to explicit nulls", () => {
  it("treats absent and explicit-null optional root fields identically", () => {
    const absent = normalizeRootCreate(BASE_ROOT);
    const explicit = normalizeRootCreate({
      ...BASE_ROOT,
      anchor: { ...BASE_ROOT.anchor, featureId: null },
      assigneeId: null,
      dueDate: null,
    });
    expect(absent).toEqual(explicit);
    expect(absent.featureId).toBeNull();
    expect(absent.assigneeId).toBeNull();
    expect(absent.dueDate).toBeNull();
  });

  it("newline-normalizes root and reply bodies", () => {
    expect(normalizeRootCreate({ ...BASE_ROOT, bodyMarkdown: "a\r\nb" }).bodyMarkdown).toBe("a\nb");
    expect(normalizeReplyCreate({ requestId: BASE_ROOT.requestId, bodyMarkdown: "a\rb" })).toEqual({
      bodyMarkdown: "a\nb",
      attachmentIds: [],
    });
  });
});

describe("idempotency hashing", () => {
  const root = normalizeRootCreate(BASE_ROOT);

  it("produces deterministic lowercase sha256 hex", () => {
    const first = hashRootCreate(root, 41);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRootCreate(normalizeRootCreate(BASE_ROOT), 41)).toBe(first);
  });

  it("matches the canonical sorted-key JSON encoding exactly", () => {
    const expectedRoot = createHash("sha256")
      .update(
        JSON.stringify({
          assigneeId: null,
          attachmentIds: [],
          bodyMarkdown: "Fix the door label",
          dueDate: null,
          featureId: null,
          kind: "root",
          latitude: 35.6812,
          levelId: "lvl-1",
          longitude: 139.7671,
          versionId: 41,
        }),
      )
      .digest("hex");
    expect(hashRootCreate(root, 41)).toBe(expectedRoot);

    const expectedReply = createHash("sha256")
      .update(
        JSON.stringify({
          attachmentIds: [],
          bodyMarkdown: "hello",
          kind: "reply",
          parentIssueId: "c_9",
          versionId: 41,
        }),
      )
      .digest("hex");
    expect(hashReplyCreate({ bodyMarkdown: "hello", attachmentIds: [] }, 41, "c_9")).toBe(expectedReply);
  });

  it("equates absent and null-normalized optional fields", () => {
    const explicit = normalizeRootCreate({
      ...BASE_ROOT,
      anchor: { ...BASE_ROOT.anchor, featureId: null },
      assigneeId: null,
      dueDate: null,
    });
    expect(hashRootCreate(explicit, 41)).toBe(hashRootCreate(root, 41));
  });

  const rootVariants: Array<[label: string, variant: NormalizedRootCreate, versionId: number]> = [
    ["version id", root, 42],
    ["body", { ...root, bodyMarkdown: "Fix the door label!" }, 41],
    ["level", { ...root, levelId: "lvl-2" }, 41],
    ["longitude", { ...root, longitude: 139.7672 }, 41],
    ["latitude", { ...root, latitude: 35.6813 }, 41],
    ["feature", { ...root, featureId: "unit-7" }, 41],
    ["assignee", { ...root, assigneeId: 7 }, 41],
    ["due date", { ...root, dueDate: "2026-08-01" }, 41],
  ];
  it.each(rootVariants)("root hash changes with %s", (_label, variant, versionId) => {
    expect(hashRootCreate(variant, versionId)).not.toBe(hashRootCreate(root, 41));
  });

  it("brief boundary: version id changes the root hash", () => {
    expect(hashRootCreate(root, 1)).not.toBe(hashRootCreate(root, 2));
  });

  it("reply hash changes across body, parent, version id, and kind", () => {
    const base = hashReplyCreate({ bodyMarkdown: "hello", attachmentIds: [] }, 41, "c_9");
    expect(hashReplyCreate({ bodyMarkdown: "hello!", attachmentIds: [] }, 41, "c_9")).not.toBe(base);
    expect(hashReplyCreate({ bodyMarkdown: "hello", attachmentIds: [] }, 41, "c_10")).not.toBe(base);
    expect(hashReplyCreate({ bodyMarkdown: "hello", attachmentIds: [] }, 42, "c_9")).not.toBe(base);
    // Same body and version, different kind: root and reply hashes never collide structurally.
    expect(hashRootCreate({ ...root, bodyMarkdown: "hello" }, 41)).not.toBe(base);
  });

  it("rejects non-finite values before serialization", () => {
    expectServiceError(() => hashRootCreate({ ...root, longitude: Number.NaN }, 41), "invalid_anchor");
    expectServiceError(
      () => hashRootCreate({ ...root, latitude: Number.POSITIVE_INFINITY }, 41),
      "invalid_anchor",
    );
    expectServiceError(() => hashRootCreate({ ...root, assigneeId: 1.5 }, 41), "invalid_request");
    expectServiceError(() => hashRootCreate(root, Number.NaN), "internal_error");
    expectServiceError(() => hashRootCreate(root, 1.5), "internal_error");
    expectServiceError(() => hashReplyCreate({ bodyMarkdown: "hello", attachmentIds: [] }, Number.NaN, "c_9"), "internal_error");
  });
});

describe("issue error contract", () => {
  it("maps only the approved status table", () => {
    expect(ISSUE_ERROR_STATUS).toEqual({
      invalid_request: 400,
      invalid_anchor: 400,
      invalid_due_date: 400,
      invalid_markdown: 400,
      invalid_attachment: 400,
      unauthorized: 401,
      forbidden: 403,
      quota_exceeded: 403,
      not_found: 404,
      stale_issue: 409,
      idempotency_conflict: 409,
      issue_deleted: 409,
      rate_limited: 429,
      internal_error: 500,
      sse_capacity: 503,
    });
  });

  it("serializes domain errors with their status and payload extras", () => {
    const logged: unknown[] = [];
    const error = new IssueServiceError("stale_issue", "The issue changed since you loaded it.", {
      revision: 9,
    });
    const response = toIssueErrorResponse(error, (cause) => logged.push(cause));
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "stale_issue",
      message: "The issue changed since you loaded it.",
      revision: 9,
    });
    expect(logged).toEqual([]);
  });

  it("passes field details through validation errors", () => {
    const error = new IssueServiceError("invalid_due_date", "invalid_due_date", {
      details: [{ field: "dueDate", reason: "not a calendar date" }],
    });
    const response = toIssueErrorResponse(error, () => undefined);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "invalid_due_date",
      message: "invalid_due_date",
      details: [{ field: "dueDate", reason: "not a calendar date" }],
    });
  });

  it("sanitizes unknown failures to the exact internal copy and logs the cause", () => {
    const logged: unknown[] = [];
    const cause = new Error("SQLITE_BUSY: database is locked");
    const response = toIssueErrorResponse(cause, (value) => logged.push(value));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error", message: "Could not update review issues." });
    expect(JSON.stringify(response.body)).not.toContain("SQLITE_BUSY");
    expect(logged).toEqual([cause]);
  });

  it("sanitizes internal_error service errors carrying raw detail", () => {
    const logged: unknown[] = [];
    const error = new IssueServiceError("internal_error", "napi decode panic: bad frame");
    const response = toIssueErrorResponse(error, (value) => logged.push(value));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error", message: "Could not update review issues." });
    expect(logged).toEqual([error]);
  });

  it("drops details, current, and revision from non-validation, non-stale codes", () => {
    const error = new IssueServiceError("forbidden", "You cannot change this issue.", {
      details: [{ field: "status", reason: "leaked" }],
      current: { kind: "reply", value: ISSUE_DTO.replies[0] as unknown as IssueReply },
      revision: 12,
    });
    const response = toIssueErrorResponse(error, () => undefined);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden", message: "You cannot change this issue." });
  });

  it("drops current and revision from validation codes", () => {
    const error = new IssueServiceError("invalid_markdown", "invalid_markdown", {
      details: [{ field: "bodyMarkdown", reason: "too long" }],
      current: { kind: "reply", value: ISSUE_DTO.replies[0] as unknown as IssueReply },
      revision: 3,
    });
    const response = toIssueErrorResponse(error, () => undefined);
    expect(response.body).toEqual({
      error: "invalid_markdown",
      message: "invalid_markdown",
      details: [{ field: "bodyMarkdown", reason: "too long" }],
    });
  });

  it("drops details from stale_issue while keeping current and revision", () => {
    const error = new IssueServiceError("stale_issue", "conflict", {
      details: [{ field: "expectedVersion", reason: "leaked" }],
      revision: 7,
    });
    const response = toIssueErrorResponse(error, () => undefined);
    expect(response.body).toEqual({ error: "stale_issue", message: "conflict", revision: 7 });
  });
});

const ISSUE_DTO = {
  id: "c_1",
  pinNumber: 1,
  rowVersion: 2,
  anchor: { levelId: "lvl-1", longitude: 139.7671, latitude: 35.6812, featureId: "unit-7" },
  bodyMarkdown: "Fix the door label",
  attachments: [],
  status: "open",
  author: { id: 7, username: "reviewer" },
  assignee: null,
  dueDate: null,
  createdAt: "2026-07-18T01:02:03Z",
  updatedAt: "2026-07-18T01:02:03Z",
  deletedAt: null,
  replies: [
    {
      id: "c_2",
      rowVersion: 1,
      bodyMarkdown: null,
      attachments: [],
      author: { id: 8, username: "author" },
      createdAt: "2026-07-18T02:03:04.123Z",
      updatedAt: "2026-07-18T02:04:05Z",
      deletedAt: "2026-07-18T02:04:05Z",
    },
  ],
};

describe("strict TypeBox schemas", () => {
  it("accepts canonical identifiers and rejects malformed ones", () => {
    expect(Value.Check(PublicVersionIdSchema, "a".repeat(64))).toBe(true);
    expect(Value.Check(PublicVersionIdSchema, "a".repeat(63))).toBe(false);
    expect(Value.Check(PublicVersionIdSchema, "A".repeat(64))).toBe(false);
    expect(Value.Check(RequestIdSchema, "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")).toBe(true);
    expect(Value.Check(RequestIdSchema, "9F1C2D3E-4B5A-4C6D-8E7F-0A1B2C3D4E5F")).toBe(true);
    expect(Value.Check(RequestIdSchema, "9f1c2d3e-4b5a-1c6d-8e7f-0a1b2c3d4e5f")).toBe(false);
  });

  it("rejects DTOs that leak Markdown on tombstones or null bodies on live rows", () => {
    const liveReply = {
      id: "c_3",
      rowVersion: 1,
      bodyMarkdown: "still here",
      attachments: [],
      author: { id: 8, username: "author" },
      createdAt: "2026-07-18T02:03:04Z",
      updatedAt: "2026-07-18T02:03:04Z",
      deletedAt: null,
    };
    expect(Value.Check(IssueReplySchema, liveReply)).toBe(true);
    // Tombstoned reply carrying Markdown must be rejected.
    expect(
      Value.Check(IssueReplySchema, { ...liveReply, deletedAt: "2026-07-18T03:00:00Z" }),
    ).toBe(false);
    // Live reply with a null body must be rejected.
    expect(Value.Check(IssueReplySchema, { ...liveReply, bodyMarkdown: null })).toBe(false);
    // Same correlation for root issues.
    expect(
      Value.Check(ReviewIssueSchema, { ...ISSUE_DTO, deletedAt: "2026-07-18T03:00:00Z" }),
    ).toBe(false);
    expect(Value.Check(ReviewIssueSchema, { ...ISSUE_DTO, bodyMarkdown: null })).toBe(false);
    expect(
      Value.Check(ReviewIssueSchema, {
        ...ISSUE_DTO,
        bodyMarkdown: null,
        deletedAt: "2026-07-18T03:00:00Z",
      }),
    ).toBe(true);
  });

  it("correlates tombstones at the type level", () => {
    const base = {
      id: "c_9",
      rowVersion: 1,
      author: { id: 1, username: "a" },
      createdAt: "2026-07-18T00:00:00Z",
      updatedAt: "2026-07-18T00:00:00Z",
    };
    const live: IssueReply = { ...base, bodyMarkdown: "text", attachments: [], deletedAt: null };
    const deleted: IssueReply = { ...base, bodyMarkdown: null, attachments: [], deletedAt: "2026-07-18T01:00:00Z" };
    // @ts-expect-error — a tombstoned reply cannot carry Markdown
    const leaked: IssueReply = { ...base, bodyMarkdown: "leaked", attachments: [], deletedAt: "2026-07-18T01:00:00Z" };
    expect([live.deletedAt, deleted.bodyMarkdown, leaked.id]).toEqual([null, null, "c_9"]);
  });

  it("enforces real RFC 3339 UTC calendar and clock values in timestamps", () => {
    const valid = [
      "2026-07-18T01:02:03Z",
      "2026-07-18T23:59:59.999Z",
      "2028-02-29T00:00:00Z", // leap day
    ];
    for (const createdAt of valid) {
      expect(Value.Check(ReviewIssueSchema, { ...ISSUE_DTO, createdAt })).toBe(true);
    }
    const invalid = [
      "2026-13-01T00:00:00Z", // month 13
      "2026-00-01T00:00:00Z", // month 0
      "2026-07-32T00:00:00Z", // day 32
      "2026-07-00T00:00:00Z", // day 0
      "2027-02-29T00:00:00Z", // non-leap February 29
      "2026-07-18T24:00:00Z", // hour 24
      "2026-07-18T00:60:00Z", // minute 60
      "2026-07-18T00:00:60Z", // second 60
      "2026-07-18T00:00:00", // missing Z
      "2026-07-18T00:00:00+09:00", // offset instead of Z
      "2026-07-18 00:00:00Z", // space separator
    ];
    for (const createdAt of invalid) {
      expect(Value.Check(ReviewIssueSchema, { ...ISSUE_DTO, createdAt })).toBe(false);
    }
  });

  it("validates the collection DTO including tombstoned nullable bodies", () => {
    expect(Value.Check(ReviewIssueSchema, ISSUE_DTO)).toBe(true);
    expect(Value.Check(IssueCollectionSchema, { revision: 4, issues: [ISSUE_DTO] })).toBe(true);
    expect(Value.Check(IssueReplySchema, ISSUE_DTO.replies[0])).toBe(true);
  });

  const extraCases: Array<[label: string, check: () => boolean]> = [
    ["issue extra property", () => Value.Check(ReviewIssueSchema, { ...ISSUE_DTO, secret: 1 })],
    [
      "anchor extra property",
      () => Value.Check(ReviewIssueSchema, { ...ISSUE_DTO, anchor: { ...ISSUE_DTO.anchor, z: 1 } }),
    ],
    [
      "reply extra property",
      () =>
        Value.Check(IssueCollectionSchema, {
          revision: 4,
          issues: [{ ...ISSUE_DTO, replies: [{ ...ISSUE_DTO.replies[0], internal: true }] }],
        }),
    ],
    [
      "collection extra property",
      () => Value.Check(IssueCollectionSchema, { revision: 4, issues: [], extra: true }),
    ],
    [
      "reviewer extra property",
      () => Value.Check(ReviewersResponseSchema, { reviewers: [{ id: 1, username: "a", role: "admin" }] }),
    ],
    ["mutation extra property", () => Value.Check(MutationResponseSchema, { revision: 1, resourceId: "c_1", replayed: false })],
    ["delete extra property", () => Value.Check(DeleteBodySchema, { expectedVersion: 1, force: true })],
  ];
  it.each(extraCases)("rejects %s", (_label, check) => {
    expect(check()).toBe(false);
  });

  it("accepts valid create, delete, and mutation payloads", () => {
    expect(
      Value.Check(RootCreateBodySchema, {
        requestId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
        bodyMarkdown: "Fix it",
        anchor: { levelId: "lvl-1", longitude: 1, latitude: 2 },
      }),
    ).toBe(true);
    expect(
      Value.Check(RootCreateBodySchema, {
        requestId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
        bodyMarkdown: "Fix it",
        anchor: { levelId: "lvl-1", longitude: 1, latitude: 2, featureId: null },
        assigneeId: null,
        dueDate: "2026-08-01",
      }),
    ).toBe(true);
    expect(
      Value.Check(ReplyCreateBodySchema, {
        requestId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
        bodyMarkdown: "Reply",
      }),
    ).toBe(true);
    expect(Value.Check(DeleteBodySchema, { expectedVersion: 3 })).toBe(true);
    expect(Value.Check(MutationResponseSchema, { revision: 0, resourceId: "c_1" })).toBe(true);
    expect(Value.Check(ReviewersResponseSchema, { reviewers: [{ id: 1, username: "a" }] })).toBe(true);
  });

  it("rejects create payloads with extras or missing request ids", () => {
    expect(
      Value.Check(RootCreateBodySchema, {
        requestId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
        bodyMarkdown: "Fix it",
        anchor: { levelId: "lvl-1", longitude: 1, latitude: 2 },
        status: "open",
      }),
    ).toBe(false);
    expect(
      Value.Check(RootCreateBodySchema, {
        bodyMarkdown: "Fix it",
        anchor: { levelId: "lvl-1", longitude: 1, latitude: 2 },
      }),
    ).toBe(false);
    expect(Value.Check(ReplyCreateBodySchema, { requestId: randomUUID(), bodyMarkdown: "x", extra: 1 })).toBe(
      false,
    );
  });

  it("validates each patch discriminant strictly", () => {
    const body = { type: "body", bodyMarkdown: "new", expectedVersion: 1 };
    const assignment = { type: "assignment", assigneeId: null, expectedVersion: 1 };
    const dueDate = { type: "due_date", dueDate: "2026-08-01", expectedVersion: 2 };
    const status = { type: "status", status: "in_review", expectedVersion: 3 };
    expect(Value.Check(IssuePatchBodySchema, body)).toBe(true);
    expect(Value.Check(IssuePatchAssignmentSchema, assignment)).toBe(true);
    expect(Value.Check(IssuePatchDueDateSchema, { ...dueDate, dueDate: null })).toBe(true);
    expect(Value.Check(IssuePatchStatusSchema, status)).toBe(true);
    for (const patch of [body, assignment, dueDate, status]) {
      expect(Value.Check(IssuePatchSchema, patch)).toBe(true);
      expect(Value.Check(IssuePatchSchema, { ...patch, extra: 1 })).toBe(false);
    }
    expect(Value.Check(IssuePatchSchema, { type: "body", assigneeId: 1, expectedVersion: 1 })).toBe(false);
    expect(Value.Check(IssuePatchSchema, { type: "status", status: "resolved", expectedVersion: 1 })).toBe(
      false,
    );
    expect(Value.Check(IssuePatchSchema, { type: "body", bodyMarkdown: "x", expectedVersion: 0 })).toBe(false);
  });

  it("constrains the API error envelope to approved codes and shape", () => {
    expect(
      Value.Check(IssueApiErrorSchema, {
        error: "stale_issue",
        message: "conflict",
        current: { kind: "issue", value: ISSUE_DTO },
        revision: 4,
      }),
    ).toBe(true);
    expect(
      Value.Check(IssueApiErrorSchema, {
        error: "invalid_markdown",
        message: "bad body",
        details: [{ field: "bodyMarkdown", reason: "too long" }],
      }),
    ).toBe(true);
    expect(Value.Check(IssueApiErrorSchema, { error: "bogus_code", message: "nope" })).toBe(false);
    expect(Value.Check(IssueApiErrorSchema, { error: "not_found", message: "gone", stack: "trace" })).toBe(
      false,
    );
    // Extras are code-gated: details only on validation codes, current/revision only on stale_issue.
    expect(
      Value.Check(IssueApiErrorSchema, {
        error: "forbidden",
        message: "no",
        details: [{ field: "status", reason: "leak" }],
      }),
    ).toBe(false);
    expect(Value.Check(IssueApiErrorSchema, { error: "invalid_markdown", message: "bad", revision: 1 })).toBe(
      false,
    );
    expect(
      Value.Check(IssueApiErrorSchema, {
        error: "not_found",
        message: "gone",
        current: { kind: "issue", value: ISSUE_DTO },
      }),
    ).toBe(false);
    expect(Value.Check(IssueApiErrorSchema, { error: "stale_issue", message: "conflict" })).toBe(true);
    expect(
      Value.Check(IssueApiErrorSchema, {
        error: "stale_issue",
        message: "conflict",
        details: [{ field: "expectedVersion", reason: "leak" }],
      }),
    ).toBe(false);
    expect(Value.Check(IssueApiErrorSchema, { error: "unauthorized", message: "sign in" })).toBe(true);
  });
});
