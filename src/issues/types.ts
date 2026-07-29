export type IssueStatus = "open" | "in_review" | "closed";

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

/**
 * Server-projected attachment metadata for a live body. `previewUrl` is
 * client-only: a temporary `blob:` object URL for a staged upload that the
 * server does not serve yet (staged media is uploader-private).
 */
export interface IssueAttachmentMetadata {
  id: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  previewUrl?: string;
}

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

export type IssueReply =
  | {
      id: string;
      rowVersion: number;
      bodyMarkdown: string;
      attachments: IssueAttachmentMetadata[];
      author: ReviewerSummary;
      createdAt: string;
      updatedAt: string;
      deletedAt: null;
    }
  | {
      id: string;
      rowVersion: number;
      bodyMarkdown: null;
      attachments: [];
      author: ReviewerSummary;
      createdAt: string;
      updatedAt: string;
      deletedAt: string;
    };

interface ReviewIssueFields {
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
}

export type ReviewIssue =
  | (ReviewIssueFields & { bodyMarkdown: string; attachments: IssueAttachmentMetadata[]; deletedAt: null })
  | (ReviewIssueFields & { bodyMarkdown: null; attachments: []; deletedAt: string });

export interface IssueCollection {
  revision: number;
  issues: ReviewIssue[];
}

export interface CreateIssueInput {
  requestId: string;
  bodyMarkdown: string;
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

export interface CreateReplyInput {
  requestId: string;
  bodyMarkdown: string;
  attachmentIds?: string[];
}

export type IssuePatch =
  | { type: "body"; bodyMarkdown: string; expectedVersion: number; attachmentIds?: string[] }
  | { type: "assignment"; assigneeId: number | null; expectedVersion: number }
  | { type: "due_date"; dueDate: string | null; expectedVersion: number }
  | { type: "status"; status: IssueStatus; expectedVersion: number };

export type ReplyBodyPatch = Extract<IssuePatch, { type: "body" }>;

export interface IssueMutationResponse {
  revision: number;
  resourceId: string;
}

export interface IssueApiErrorBody {
  error: IssueErrorCode;
  message: string;
  details?: Array<{ field: string; reason: string }>;
  current?: {
    kind: "issue" | "reply";
    value: ReviewIssue | IssueReply;
  };
  revision?: number;
}

export type IssueFilter = "active" | "assigned_to_me" | "unassigned" | "closed";

export interface IssueDraft {
  requestId: string;
  anchor: IssueAnchor;
  bodyMarkdown: string;
  assigneeId: number | null;
  dueDate: string | null;
}

export interface IssueDraftPatch {
  anchor?: IssueAnchor;
  bodyMarkdown?: string;
  assigneeId?: number | null;
  dueDate?: string | null;
}

export type IssueSyncFailure =
  | ({ kind: "api"; status: number } & IssueApiErrorBody)
  | { kind: "network"; message: string };

export type IssueNotice =
  | "feature_attachment_removed"
  | "selected_issue_deleted";

export interface IssueState {
  publicVersionId: string | null;
  collection: IssueCollection | null;
  appliedRevision: number;
  highestObservedRevision: number;
  refetchInFlight: boolean;
  refetchRequested: boolean;
  filter: IssueFilter;
  selectedIssueId: string | null;
  draft: IssueDraft | null;
  draftAdmissionResourceId: string | null;
  placementActive: boolean;
  pendingMutations: number;
  conflict: Extract<IssueSyncFailure, { kind: "api" }> | null;
  error: IssueSyncFailure | null;
  errorScope: "collection" | "mutation" | null;
  reconnecting: boolean;
  stale: boolean;
  authRequired: boolean;
  notice: IssueNotice | null;
}
