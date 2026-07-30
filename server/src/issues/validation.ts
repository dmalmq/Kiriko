import { createHash } from "node:crypto";
import {
  ATTACHMENT_ALT_MAX_SCALARS,
  ATTACHMENT_ID_PATTERN,
  parseAttachmentTokens,
} from "./attachments/tokens";
import { ATTACHMENT_MAX_PER_COMMENT } from "./attachments/limits";
import { IssueServiceError } from "./errors";
import type {
  NormalizedReplyCreate,
  NormalizedRootCreate,
  ReplyCreateBody,
  RootCreateBody,
} from "./types";

export const MARKDOWN_MIN_SCALARS = 1;
export const MARKDOWN_MAX_SCALARS = 4000;

// UUID v4: hex is case-insensitive per RFC 4122; canonical persisted form is lowercase.
export const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DUE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/** Converts CRLF and bare CR to LF. Performs no other transformation. */
export function normalizeMarkdown(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

function invalidMarkdown(reason: string): IssueServiceError {
  return new IssueServiceError("invalid_markdown", "invalid_markdown", {
    details: [{ field: "bodyMarkdown", reason }],
  });
}

/**
 * Normalizes newlines, then enforces the approved Markdown contract:
 * 1–4,000 Unicode scalar values, no unpaired surrogates, no C0/C1 controls
 * except tab and LF, and not whitespace-only. Returns the normalized body.
 */
export function validateMarkdownBody(input: string): string {
  const normalized = normalizeMarkdown(input);
  let scalars = 0;
  let whitespaceOnly = true;
  for (let i = 0; i < normalized.length; i += 1) {
    const unit = normalized.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < normalized.length ? normalized.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw invalidMarkdown("unpaired high surrogate");
      }
      i += 1;
      scalars += 1;
      whitespaceOnly = false;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw invalidMarkdown("unpaired low surrogate");
    }
    if ((unit <= 0x1f && unit !== 0x09 && unit !== 0x0a) || (unit >= 0x7f && unit <= 0x9f)) {
      throw invalidMarkdown("disallowed control character");
    }
    scalars += 1;
    if (!/\s/.test(normalized[i] as string)) {
      whitespaceOnly = false;
    }
  }
  if (scalars < MARKDOWN_MIN_SCALARS || scalars > MARKDOWN_MAX_SCALARS) {
    throw invalidMarkdown(`body must contain ${MARKDOWN_MIN_SCALARS}-${MARKDOWN_MAX_SCALARS} characters`);
  }
  if (whitespaceOnly) {
    throw invalidMarkdown("body is whitespace-only");
  }
  return normalized;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) {
    return false;
  }
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && isLeapYear ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  return day >= 1 && day <= maxDay;
}

/**
 * Validates an exact `YYYY-MM-DD` calendar date without constructing a `Date`,
 * so no time-zone or overflow coercion can accept an invalid day. Returns the
 * input unchanged.
 */
export function validateDueDate(input: string): string {
  const match = DUE_DATE_PATTERN.exec(input);
  if (match === null) {
    throw new IssueServiceError("invalid_due_date", "invalid_due_date", {
      details: [{ field: "dueDate", reason: "expected YYYY-MM-DD" }],
    });
  }
  if (!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new IssueServiceError("invalid_due_date", "invalid_due_date", {
      details: [{ field: "dueDate", reason: "not a valid calendar date" }],
    });
  }
  return input;
}

/** Rejects non-finite or out-of-WGS84 coordinates. */
export function validateCoordinates(longitude: number, latitude: number): void {
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new IssueServiceError("invalid_anchor", "invalid_anchor", {
      details: [{ field: "longitude", reason: "must be a finite value in [-180, 180]" }],
    });
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new IssueServiceError("invalid_anchor", "invalid_anchor", {
      details: [{ field: "latitude", reason: "must be a finite value in [-90, 90]" }],
    });
  }
}

/**
 * Real RFC 3339 UTC instant with a trailing `Z`: exact calendar date and
 * 00-23/00-59/00-59 clock fields, validated without `Date` coercion. Used as
 * the TypeBox/Ajv string format for every wire timestamp.
 */
export function isRfc3339UtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  if (!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return false;
  }
  return Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
}

/**
 * Validates the UUID-v4 request ID shape (any hex case, per the standard) and
 * canonicalizes to lowercase so persistence and idempotency comparison see one
 * form.
 */
export function validateRequestId(input: string): string {
  if (!REQUEST_ID_PATTERN.test(input)) {
    throw new IssueServiceError("invalid_request", "invalid_request", {
      details: [{ field: "requestId", reason: "expected a UUID v4" }],
    });
  }
  return input.toLowerCase();
}

/**
 * Canonicalizes a root create payload: newline-normalized body and absent
 * optionals rewritten to explicit `null`. Pure shape canonicalization; content
 * validation is composed separately by the mutation service.
 */
export function normalizeRootCreate(input: RootCreateBody): NormalizedRootCreate {
  return {
    bodyMarkdown: normalizeMarkdown(input.bodyMarkdown),
    attachmentIds: input.attachmentIds ?? [],
    levelId: input.anchor.levelId,
    longitude: input.anchor.longitude,
    latitude: input.anchor.latitude,
    featureId: input.anchor.featureId ?? null,
    assigneeId: input.assigneeId ?? null,
    dueDate: input.dueDate ?? null,
  };
}

/** Canonicalizes a reply create payload to its newline-normalized body. */
export function normalizeReplyCreate(input: ReplyCreateBody): NormalizedReplyCreate {
  return { bodyMarkdown: normalizeMarkdown(input.bodyMarkdown), attachmentIds: input.attachmentIds ?? [] };
}

/**
 * Resolves the canonical attachment ID set for a normalized body. The wire
 * field is optional for old clients; when present it must exactly equal the
 * unique canonical IDs parsed from the body (set equality, order-free), so a
 * client can never bind attachments the body does not reference or reference
 * attachments it does not bind. Also enforces the per-comment count cap and
 * the alt-text scalar cap.
 */
export function resolveAttachmentIds(
  normalizedBody: string,
  provided: string[] | undefined,
): string[] {
  const tokens = parseAttachmentTokens(normalizedBody);
  for (const token of tokens) {
    if ([...token.alt].length > ATTACHMENT_ALT_MAX_SCALARS) {
      throw new IssueServiceError("invalid_attachment", "invalid_attachment", {
        details: [{ field: "bodyMarkdown", reason: "attachment alt text is too long" }],
      });
    }
  }
  const parsed = tokens.map((token) => token.id);
  if (parsed.length > ATTACHMENT_MAX_PER_COMMENT) {
    throw new IssueServiceError("invalid_attachment", "invalid_attachment", {
      details: [
        { field: "attachmentIds", reason: `at most ${ATTACHMENT_MAX_PER_COMMENT} attachments per comment` },
      ],
    });
  }
  if (provided === undefined) {
    return [...parsed].sort();
  }
  const seen = new Set<string>();
  for (const id of provided) {
    if (!ATTACHMENT_ID_PATTERN.test(id) || seen.has(id)) {
      throw new IssueServiceError("invalid_attachment", "invalid_attachment", {
        details: [{ field: "attachmentIds", reason: "expected unique canonical attachment IDs" }],
      });
    }
    seen.add(id);
  }
  const sortedProvided = [...provided].sort();
  const sortedParsed = [...parsed].sort();
  if (
    sortedProvided.length !== sortedParsed.length
    || sortedProvided.some((id, index) => id !== sortedParsed[index])
  ) {
    throw new IssueServiceError("invalid_attachment", "invalid_attachment", {
      details: [
        { field: "attachmentIds", reason: "must equal the attachment references in bodyMarkdown" },
      ],
    });
  }
  return sortedProvided;
}

function assertResolvedVersionId(versionId: number): void {
  if (!Number.isSafeInteger(versionId)) {
    throw new IssueServiceError("internal_error", "resolved version id is not a safe integer");
  }
}

/**
 * SHA-256 of the canonical sorted-key JSON binding a root create to its exact
 * operation, payload, and server-resolved numeric version ID. Key order below
 * is bytewise-sorted; do not reorder.
 */
export function hashRootCreate(input: NormalizedRootCreate, versionId: number): string {
  assertResolvedVersionId(versionId);
  if (!Number.isFinite(input.longitude) || !Number.isFinite(input.latitude)) {
    throw new IssueServiceError("invalid_anchor", "invalid_anchor", {
      details: [{ field: "anchor", reason: "coordinates must be finite" }],
    });
  }
  if (input.assigneeId !== null && !Number.isSafeInteger(input.assigneeId)) {
    throw new IssueServiceError("invalid_request", "invalid_request", {
      details: [{ field: "assigneeId", reason: "must be an integer user id" }],
    });
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        assigneeId: input.assigneeId,
        attachmentIds: input.attachmentIds,
        bodyMarkdown: input.bodyMarkdown,
        dueDate: input.dueDate,
        featureId: input.featureId,
        kind: "root",
        latitude: input.latitude,
        levelId: input.levelId,
        longitude: input.longitude,
        versionId,
      }),
    )
    .digest("hex");
}

/**
 * SHA-256 of the canonical sorted-key JSON binding a reply create to its
 * parent root and server-resolved numeric version ID.
 */
export function hashReplyCreate(
  input: NormalizedReplyCreate,
  versionId: number,
  parentIssueId: string,
): string {
  assertResolvedVersionId(versionId);
  return createHash("sha256")
    .update(
      JSON.stringify({
        attachmentIds: input.attachmentIds,
        bodyMarkdown: input.bodyMarkdown,
        kind: "reply",
        parentIssueId,
        versionId,
      }),
    )
    .digest("hex");
}
