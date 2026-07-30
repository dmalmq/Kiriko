import type { IssueErrorCode, IssueReply, ReviewIssue } from "./types";

export const ISSUE_ERROR_STATUS = {
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
} as const satisfies Record<IssueErrorCode, number>;

export const INTERNAL_ERROR_MESSAGE = "Could not update review issues.";

const VALIDATION_ERROR_CODES = [
  "invalid_request",
  "invalid_anchor",
  "invalid_due_date",
  "invalid_markdown",
  "invalid_attachment",
] as const;

export type IssueValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

function isValidationCode(code: IssueErrorCode): code is IssueValidationErrorCode {
  return (VALIDATION_ERROR_CODES as readonly string[]).includes(code);
}

export interface IssueErrorDetail {
  field: string;
  reason: string;
}

export interface IssueCurrentResource {
  kind: "issue" | "reply";
  value: ReviewIssue | IssueReply;
}

/**
 * Wire error envelope (spec §8.1). Extras are code-gated: `details` only on
 * 400 validation codes; `current`/`revision` only on `stale_issue`.
 */
export type IssueApiError =
  | { error: IssueValidationErrorCode; message: string; details?: IssueErrorDetail[] }
  | { error: "stale_issue"; message: string; current?: IssueCurrentResource; revision?: number }
  | {
      error: Exclude<IssueErrorCode, IssueValidationErrorCode | "stale_issue">;
      message: string;
    };

export interface IssueServiceErrorExtras {
  details?: IssueErrorDetail[];
  current?: IssueCurrentResource;
  revision?: number;
}

export class IssueServiceError extends Error {
  readonly code: IssueErrorCode;
  readonly details: IssueErrorDetail[] | undefined;
  readonly current: IssueCurrentResource | undefined;
  readonly revision: number | undefined;

  constructor(code: IssueErrorCode, message: string, extras?: IssueServiceErrorExtras) {
    super(message);
    this.name = "IssueServiceError";
    this.code = code;
    this.details = extras?.details;
    this.current = extras?.current;
    this.revision = extras?.revision;
  }

  get status(): number {
    return ISSUE_ERROR_STATUS[this.code];
  }
}

/**
 * Maps any thrown value to the wire error envelope with code-gated extras.
 * Unexpected failures and `internal_error` service errors carrying raw
 * database/blob/native detail are logged server-side and serialized only as
 * the sanitized internal copy.
 */
export function toIssueErrorResponse(
  error: unknown,
  log: (cause: unknown) => void,
): { status: number; body: IssueApiError } {
  if (error instanceof IssueServiceError && error.code !== "internal_error") {
    if (isValidationCode(error.code)) {
      const body: IssueApiError = { error: error.code, message: error.message };
      if (error.details !== undefined) {
        body.details = error.details;
      }
      return { status: error.status, body };
    }
    if (error.code === "stale_issue") {
      const body: IssueApiError = { error: error.code, message: error.message };
      if (error.current !== undefined) {
        body.current = error.current;
      }
      if (error.revision !== undefined) {
        body.revision = error.revision;
      }
      return { status: error.status, body };
    }
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  log(error);
  return {
    status: ISSUE_ERROR_STATUS.internal_error,
    body: { error: "internal_error", message: INTERNAL_ERROR_MESSAGE },
  };
}
