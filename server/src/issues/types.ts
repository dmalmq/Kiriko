export type IssueStatus = "open" | "in_review" | "closed";

export const ISSUE_STATUSES = ["open", "in_review", "closed"] as const satisfies readonly IssueStatus[];

export type IssueErrorCode =
  | "invalid_request"
  | "invalid_anchor"
  | "invalid_due_date"
  | "invalid_markdown"
  | "invalid_attachment"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "stale_issue"
  | "idempotency_conflict"
  | "issue_deleted"
  | "rate_limited"
  | "quota_exceeded"
  | "sse_capacity"
  | "internal_error";

// ---------------------------------------------------------------------------
// Public wire DTOs. Repository rows never cross this boundary: tombstoned
// resources are projected with `bodyMarkdown: null` so deleted text cannot
// leak, and numeric database version IDs never appear in public shapes.
// ---------------------------------------------------------------------------

export interface ReviewerSummary {
  id: number;
  username: string;
}

export interface IssueAnchor {
  levelId: string;
  longitude: number;
  latitude: number;
  featureId?: string;
}

/**
 * Public attachment metadata for a live body. IDs are opaque; URLs are never
 * stored or projected — the client derives same-origin media URLs from `id`.
 */
export interface IssueAttachmentMetadata {
  id: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
}

/**
 * Tombstone correlation: a live resource carries its Markdown and a null
 * `deletedAt`; a tombstone carries a null body and its deletion timestamp.
 * Deleted Markdown can never appear in a public shape, and tombstones always
 * project an empty attachment list (media access is revoked on deletion).
 */
export type Tombstone<Live> =
  | (Live & { bodyMarkdown: string; attachments: IssueAttachmentMetadata[]; deletedAt: null })
  | (Live & { bodyMarkdown: null; attachments: []; deletedAt: string });

export type IssueReply = Tombstone<{
  id: string;
  rowVersion: number;
  author: ReviewerSummary;
  createdAt: string;
  updatedAt: string;
}>;

export type ReviewIssue = Tombstone<{
  id: string;
  pinNumber: number;
  rowVersion: number;
  anchor: IssueAnchor;
  status: IssueStatus;
  author: ReviewerSummary;
  assignee: ReviewerSummary | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  replies: IssueReply[];
}>;

export interface IssueCollection {
  revision: number;
  issues: ReviewIssue[];
}

// ---------------------------------------------------------------------------
// Mutation inputs (request bodies).
// ---------------------------------------------------------------------------

export interface RootCreateBody {
  requestId: string;
  bodyMarkdown: string;
  /** Canonical attachment IDs referenced by the body. Optional for old
   * clients; when present it must equal the IDs parsed from the body. */
  attachmentIds?: string[];
  anchor: {
    levelId: string;
    longitude: number;
    latitude: number;
    featureId?: string | null;
  };
  assigneeId?: number | null;
  dueDate?: string | null;
}

export interface ReplyCreateBody {
  requestId: string;
  bodyMarkdown: string;
  attachmentIds?: string[];
}

export type IssuePatch =
  | { type: "body"; bodyMarkdown: string; expectedVersion: number; attachmentIds?: string[] }
  | { type: "assignment"; assigneeId: number | null; expectedVersion: number }
  | { type: "due_date"; dueDate: string | null; expectedVersion: number }
  | { type: "status"; status: IssueStatus; expectedVersion: number };

export type ReplyPatch = Extract<IssuePatch, { type: "body" }>;

export interface DeleteBody {
  expectedVersion: number;
}

// ---------------------------------------------------------------------------
// Internal canonical forms and results. Optional creation fields are
// canonicalized to explicit `null` before idempotency hashing and storage.
// ---------------------------------------------------------------------------

export interface NormalizedRootCreate {
  bodyMarkdown: string;
  /** Sorted unique canonical IDs; part of the idempotency hash. */
  attachmentIds: string[];
  levelId: string;
  longitude: number;
  latitude: number;
  featureId: string | null;
  assigneeId: number | null;
  dueDate: string | null;
}

export interface NormalizedReplyCreate {
  bodyMarkdown: string;
  attachmentIds: string[];
}

/** Body patch after attachment-ID resolution (absent wire field → parsed). */
export type NormalizedIssuePatch =
  | { type: "body"; bodyMarkdown: string; expectedVersion: number; attachmentIds: string[] }
  | Exclude<IssuePatch, { type: "body" }>;

export type NormalizedReplyPatch = Extract<NormalizedIssuePatch, { type: "body" }>;

export interface IssueMutationResult {
  revision: number;
  versionId: number;
  publicVersionId: string;
  resourceId: string;
  replayed: boolean;
}
