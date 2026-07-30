import { FormatRegistry, type TProperties, type TSchema, Type } from "@sinclair/typebox";
import { isRfc3339UtcTimestamp } from "./validation";

// Every request/response object schema is strict: unknown properties are
// rejected rather than stripped or ignored.
const strict = { additionalProperties: false } as const;

// Real RFC 3339 UTC instants (exact calendar and clock, trailing Z). Task 7
// must register the same predicate with Fastify's Ajv via
// `ajv.addFormat(UTC_TIMESTAMP_FORMAT, isRfc3339UtcTimestamp)`.
export const UTC_TIMESTAMP_FORMAT = "kiriko-rfc3339-utc";
if (!FormatRegistry.Has(UTC_TIMESTAMP_FORMAT)) {
  FormatRegistry.Set(UTC_TIMESTAMP_FORMAT, isRfc3339UtcTimestamp);
}

export const PublicVersionIdSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

// UUID v4 hex is case-insensitive on the wire; validateRequestId canonicalizes
// to lowercase before persistence and idempotency hashing.
export const RequestIdSchema = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});

/** Canonical lowercase attachment IDs (opaque UUIDs). */
export const AttachmentIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

export const IssueAttachmentMetadataSchema = Type.Object(
  {
    id: AttachmentIdSchema,
    contentType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
    ]),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    thumbnailWidth: Type.Integer({ minimum: 1 }),
    thumbnailHeight: Type.Integer({ minimum: 1 }),
  },
  strict,
);

export const AttachmentUploadResponseSchema = Type.Object(
  {
    id: AttachmentIdSchema,
    contentType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
    ]),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    thumbnailWidth: Type.Integer({ minimum: 1 }),
    thumbnailHeight: Type.Integer({ minimum: 1 }),
  },
  strict,
);

const DueDateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

const TimestampSchema = Type.String({ format: UTC_TIMESTAMP_FORMAT });

function nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

export const IssueStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("in_review"),
  Type.Literal("closed"),
]);

export const ReviewerSummarySchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    username: Type.String({ minLength: 1 }),
  },
  strict,
);

export const ReviewersResponseSchema = Type.Object(
  { reviewers: Type.Array(ReviewerSummarySchema) },
  strict,
);

export const IssueAnchorSchema = Type.Object(
  {
    levelId: Type.String({ minLength: 1 }),
    longitude: Type.Number({ minimum: -180, maximum: 180 }),
    latitude: Type.Number({ minimum: -90, maximum: 90 }),
    featureId: Type.Optional(Type.String({ minLength: 1 })),
  },
  strict,
);

/**
 * Tombstone correlation: live resources carry Markdown with a null
 * `deletedAt`; tombstones carry a null body with the deletion timestamp.
 * Any other combination is rejected so deleted Markdown cannot leak.
 */
function tombstoneUnion<T extends TProperties>(fields: T) {
  return Type.Union([
    Type.Object(
      {
        ...fields,
        bodyMarkdown: Type.String(),
        attachments: Type.Array(IssueAttachmentMetadataSchema),
        deletedAt: Type.Null(),
      },
      strict,
    ),
    Type.Object(
      {
        ...fields,
        bodyMarkdown: Type.Null(),
        attachments: Type.Array(IssueAttachmentMetadataSchema, { maxItems: 0 }),
        deletedAt: TimestampSchema,
      },
      strict,
    ),
  ]);
}

export const IssueReplySchema = tombstoneUnion({
  id: Type.String({ minLength: 1 }),
  rowVersion: Type.Integer({ minimum: 1 }),
  author: ReviewerSummarySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ReviewIssueSchema = tombstoneUnion({
  id: Type.String({ minLength: 1 }),
  pinNumber: Type.Integer({ minimum: 1 }),
  rowVersion: Type.Integer({ minimum: 1 }),
  anchor: IssueAnchorSchema,
  status: IssueStatusSchema,
  author: ReviewerSummarySchema,
  assignee: nullable(ReviewerSummarySchema),
  dueDate: nullable(DueDateSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  replies: Type.Array(IssueReplySchema),
});

export const IssueCollectionSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    issues: Type.Array(ReviewIssueSchema),
  },
  strict,
);

export const RootCreateBodySchema = Type.Object(
  {
    requestId: RequestIdSchema,
    bodyMarkdown: Type.String(),
    attachmentIds: Type.Optional(Type.Array(AttachmentIdSchema, { maxItems: 10 })),
    anchor: Type.Object(
      {
        levelId: Type.String({ minLength: 1 }),
        longitude: Type.Number(),
        latitude: Type.Number(),
        featureId: Type.Optional(nullable(Type.String({ minLength: 1 }))),
      },
      strict,
    ),
    assigneeId: Type.Optional(nullable(Type.Integer({ minimum: 1 }))),
    dueDate: Type.Optional(nullable(DueDateSchema)),
  },
  strict,
);

export const ReplyCreateBodySchema = Type.Object(
  {
    requestId: RequestIdSchema,
    bodyMarkdown: Type.String(),
    attachmentIds: Type.Optional(Type.Array(AttachmentIdSchema, { maxItems: 10 })),
  },
  strict,
);

const ExpectedVersionSchema = Type.Integer({ minimum: 1 });

export const IssuePatchBodySchema = Type.Object(
  {
    type: Type.Literal("body"),
    bodyMarkdown: Type.String(),
    attachmentIds: Type.Optional(Type.Array(AttachmentIdSchema, { maxItems: 10 })),
    expectedVersion: ExpectedVersionSchema,
  },
  strict,
);

export const IssuePatchAssignmentSchema = Type.Object(
  {
    type: Type.Literal("assignment"),
    assigneeId: nullable(Type.Integer({ minimum: 1 })),
    expectedVersion: ExpectedVersionSchema,
  },
  strict,
);

export const IssuePatchDueDateSchema = Type.Object(
  {
    type: Type.Literal("due_date"),
    dueDate: nullable(DueDateSchema),
    expectedVersion: ExpectedVersionSchema,
  },
  strict,
);

export const IssuePatchStatusSchema = Type.Object(
  {
    type: Type.Literal("status"),
    status: IssueStatusSchema,
    expectedVersion: ExpectedVersionSchema,
  },
  strict,
);

export const IssuePatchSchema = Type.Union([
  IssuePatchBodySchema,
  IssuePatchAssignmentSchema,
  IssuePatchDueDateSchema,
  IssuePatchStatusSchema,
]);

// Reply patches support exactly the body discriminant.
export const ReplyPatchSchema = IssuePatchBodySchema;

export const DeleteBodySchema = Type.Object({ expectedVersion: ExpectedVersionSchema }, strict);

export const MutationResponseSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    resourceId: Type.String({ minLength: 1 }),
  },
  strict,
);

/**
 * Wire error envelope (spec §8.1) with code-gated extras: `details` only on
 * the four 400 validation codes, `current`/`revision` only on `stale_issue`,
 * and nothing but `error`/`message` everywhere else.
 */
export const IssueApiErrorSchema = Type.Union([
  Type.Object(
    {
      error: Type.Union([
        Type.Literal("invalid_request"),
        Type.Literal("invalid_anchor"),
        Type.Literal("invalid_due_date"),
        Type.Literal("invalid_markdown"),
        Type.Literal("invalid_attachment"),
      ]),
      message: Type.String(),
      details: Type.Optional(
        Type.Array(Type.Object({ field: Type.String(), reason: Type.String() }, strict)),
      ),
    },
    strict,
  ),
  Type.Object(
    {
      error: Type.Literal("stale_issue"),
      message: Type.String(),
      current: Type.Optional(
        Type.Object(
          {
            kind: Type.Union([Type.Literal("issue"), Type.Literal("reply")]),
            value: Type.Union([ReviewIssueSchema, IssueReplySchema]),
          },
          strict,
        ),
      ),
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    strict,
  ),
  Type.Object(
    {
      error: Type.Union([
        Type.Literal("unauthorized"),
        Type.Literal("forbidden"),
        Type.Literal("not_found"),
        Type.Literal("idempotency_conflict"),
        Type.Literal("issue_deleted"),
        Type.Literal("rate_limited"),
        Type.Literal("quota_exceeded"),
        Type.Literal("sse_capacity"),
        Type.Literal("internal_error"),
      ]),
      message: Type.String(),
    },
    strict,
  ),
]);
