import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ATTACHMENT_MAX_COMMENT_AGGREGATE_BYTES,
  ATTACHMENT_MAX_PER_COMMENT,
} from "./attachments/limits";
import { IssueServiceError } from "./errors";
import type { IssueCurrentResource } from "./errors";
import type {
  IssueAttachmentMetadata,
  IssueCollection,
  IssueReply,
  IssueStatus,
  NormalizedIssuePatch,
  NormalizedReplyCreate,
  NormalizedReplyPatch,
  NormalizedRootCreate,
  ReviewerSummary,
  ReviewIssue,
} from "./types";

export interface PublishedReviewVersion {
  versionId: number;
  publicVersionId: string;
  bundleHash: string;
}

export interface IssueMutationContext {
  kind: "issue";
  issueId: string;
  versionId: number;
  publicVersionId: string;
  authorId: number;
  status: IssueStatus;
  assigneeId: number | null;
  rowVersion: number;
  deletedAt: string | null;
}

export interface ReplyMutationContext {
  kind: "reply";
  replyId: string;
  parentIssueId: string;
  versionId: number;
  publicVersionId: string;
  authorId: number;
  rowVersion: number;
  deletedAt: string | null;
  parentDeletedAt: string | null;
}

export interface RepositoryMutationSuccess {
  type: "ok";
  revision: number;
  versionId: number;
  publicVersionId: string;
  resourceId: string;
  replayed: boolean;
}

export interface RepositoryMutationStale {
  type: "stale";
  revision: number;
  versionId: number;
  publicVersionId: string;
  resourceId: string;
  replayed: false;
  current: IssueCurrentResource;
}

export type RepositoryMutationResult = RepositoryMutationSuccess | RepositoryMutationStale;

export interface CreateRootCommand {
  version: PublishedReviewVersion;
  authorId: number;
  requestId: string;
  requestHash: string;
  input: NormalizedRootCreate;
  now: string;
}

export interface CreateReplyCommand {
  version: PublishedReviewVersion;
  parentIssueId: string;
  authorId: number;
  requestId: string;
  requestHash: string;
  input: NormalizedReplyCreate;
  now: string;
}

export interface PatchIssueCommand {
  issueId: string;
  patch: NormalizedIssuePatch;
  now: string;
}

export interface PatchReplyCommand {
  replyId: string;
  patch: NormalizedReplyPatch;
  now: string;
}

export interface DeleteIssueCommand {
  issueId: string;
  expectedVersion: number;
  now: string;
}

export interface DeleteReplyCommand {
  replyId: string;
  expectedVersion: number;
  now: string;
}

interface PublishedVersionRow {
  id: number;
  publicVersionId: string;
  bundleHash: string;
}

interface ReplayRow {
  resourceId: string;
  requestHash: string;
  versionId: number;
  publicVersionId: string;
  revision: number;
}

interface IssueContextRow {
  issueId: string;
  versionId: number;
  publicVersionId: string;
  authorId: number;
  status: IssueStatus;
  assigneeId: number | null;
  rowVersion: number;
  deletedAt: string | null;
}

interface ReplyContextRow {
  replyId: string;
  parentIssueId: string;
  versionId: number;
  publicVersionId: string;
  authorId: number;
  rowVersion: number;
  deletedAt: string | null;
  parentDeletedAt: string | null;
}

interface RootProjectionRow {
  id: string;
  pinNumber: number;
  rowVersion: number;
  levelId: string;
  longitude: number;
  latitude: number;
  featureId: string | null;
  bodyMarkdown: string | null;
  status: IssueStatus;
  authorId: number;
  authorUsername: string;
  assigneeId: number | null;
  assigneeUsername: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ReplyProjectionRow {
  id: string;
  parentId: string;
  rowVersion: number;
  bodyMarkdown: string | null;
  authorId: number;
  authorUsername: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface VersionIdentityRow {
  versionId: number;
  publicVersionId: string;
  deletedAt: string | null;
  rowVersion: number;
}

const NOT_FOUND_MESSAGE = "The review issue was not found.";
const DELETED_MESSAGE = "This review issue has been deleted.";
const IDEMPOTENCY_MESSAGE = "This request ID was already used for a different create request.";

function notFound(): never {
  throw new IssueServiceError("not_found", NOT_FOUND_MESSAGE);
}

function deleted(): never {
  throw new IssueServiceError("issue_deleted", DELETED_MESSAGE);
}

function invalidAttachment(): never {
  // Opaque on purpose: cross-user, cross-comment, cross-version, expired, and
  // unknown attachment IDs are indistinguishable.
  throw new IssueServiceError("invalid_attachment", "invalid_attachment", {
    details: [{ field: "attachmentIds", reason: "unknown or unavailable attachment" }],
  });
}

function publicIssue(
  row: RootProjectionRow,
  replies: IssueReply[],
  attachments: IssueAttachmentMetadata[],
): ReviewIssue {
  const anchor = row.featureId === null
    ? { levelId: row.levelId, longitude: row.longitude, latitude: row.latitude }
    : {
        levelId: row.levelId,
        longitude: row.longitude,
        latitude: row.latitude,
        featureId: row.featureId,
      };
  const assignee = row.assigneeId === null || row.assigneeUsername === null
    ? null
    : { id: row.assigneeId, username: row.assigneeUsername };
  const common = {
    id: row.id,
    pinNumber: row.pinNumber,
    rowVersion: row.rowVersion,
    anchor,
    status: row.status,
    author: { id: row.authorId, username: row.authorUsername },
    assignee,
    dueDate: row.dueDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    replies,
  };
  if (row.deletedAt === null) {
    if (row.bodyMarkdown === null) {
      throw new IssueServiceError("internal_error", "A live issue has no body.");
    }
    return { ...common, bodyMarkdown: row.bodyMarkdown, attachments, deletedAt: null };
  }
  return { ...common, bodyMarkdown: null, attachments: [], deletedAt: row.deletedAt };
}

function publicReply(row: ReplyProjectionRow, attachments: IssueAttachmentMetadata[]): IssueReply {
  const common = {
    id: row.id,
    rowVersion: row.rowVersion,
    author: { id: row.authorId, username: row.authorUsername },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.deletedAt === null) {
    if (row.bodyMarkdown === null) {
      throw new IssueServiceError("internal_error", "A live reply has no body.");
    }
    return { ...common, bodyMarkdown: row.bodyMarkdown, attachments, deletedAt: null };
  }
  return { ...common, bodyMarkdown: null, attachments: [], deletedAt: row.deletedAt };
}

export class IssueRepository {
  constructor(private readonly db: Database.Database) {}

  resolvePublishedVersion(publicId: string): PublishedReviewVersion | null {
    const row = this.db
      .prepare(
        `SELECT id, public_id AS publicVersionId, bundle_hash AS bundleHash
         FROM versions
         WHERE public_id = ? AND status = 'published' AND bundle_hash IS NOT NULL`,
      )
      .get(publicId) as PublishedVersionRow | undefined;
    return row === undefined
      ? null
      : { versionId: row.id, publicVersionId: row.publicVersionId, bundleHash: row.bundleHash };
  }

  getCollection(versionId: number): IssueCollection {
    return this.db.transaction(() => {
      this.ensureState(versionId);
      const revision = this.readRevision(versionId);
      const roots = this.db
        .prepare(
          `SELECT
             c.id,
             c.pin_number AS pinNumber,
             c.row_version AS rowVersion,
             c.level_id AS levelId,
             c.longitude,
             c.latitude,
             c.feature_id AS featureId,
             c.body_markdown AS bodyMarkdown,
             c.status,
             c.author_id AS authorId,
             author.username AS authorUsername,
             c.assignee_id AS assigneeId,
             assignee.username AS assigneeUsername,
             c.due_date AS dueDate,
             c.created_at AS createdAt,
             c.updated_at AS updatedAt,
             c.deleted_at AS deletedAt
           FROM comments c
           JOIN users author ON author.id = c.author_id
           LEFT JOIN users assignee ON assignee.id = c.assignee_id
           WHERE c.version_id = ? AND c.parent_id IS NULL
           ORDER BY c.pin_number, c.id`,
        )
        .all(versionId) as RootProjectionRow[];
      const replyRows = this.db
        .prepare(
          `SELECT
             c.id,
             c.parent_id AS parentId,
             c.row_version AS rowVersion,
             c.body_markdown AS bodyMarkdown,
             c.author_id AS authorId,
             author.username AS authorUsername,
             c.created_at AS createdAt,
             c.updated_at AS updatedAt,
             c.deleted_at AS deletedAt
           FROM comments c
           JOIN users author ON author.id = c.author_id
           WHERE c.version_id = ? AND c.parent_id IS NOT NULL
           ORDER BY c.parent_id, c.created_at, c.id`,
        )
        .all(versionId) as ReplyProjectionRow[];
      const repliesByRoot = new Map<string, IssueReply[]>();
      const attachmentsByComment = this.attachmentsForVersion(versionId);
      for (const row of replyRows) {
        const replies = repliesByRoot.get(row.parentId);
        const reply = publicReply(row, attachmentsByComment.get(row.id) ?? []);
        if (replies === undefined) {
          repliesByRoot.set(row.parentId, [reply]);
        } else {
          replies.push(reply);
        }
      }
      return {
        revision,
        issues: roots.map((root) =>
          publicIssue(
            root,
            repliesByRoot.get(root.id) ?? [],
            attachmentsByComment.get(root.id) ?? [],
          )),
      };
    })();
  }

  getCurrentRevision(versionId: number): number {
    return this.db.transaction(() => {
      this.ensureState(versionId);
      return this.readRevision(versionId);
    })();
  }

  listReviewers(): ReviewerSummary[] {
    return this.db
      .prepare("SELECT id, username FROM users ORDER BY username, id")
      .all() as ReviewerSummary[];
  }

  getIssueContext(issueId: string): IssueMutationContext | null {
    const row = this.readIssueContext(issueId);
    return row === undefined ? null : { kind: "issue", ...row };
  }

  getReplyContext(replyId: string): ReplyMutationContext | null {
    const row = this.db
      .prepare(
        `SELECT
           reply.id AS replyId,
           reply.parent_id AS parentIssueId,
           reply.version_id AS versionId,
           version.public_id AS publicVersionId,
           reply.author_id AS authorId,
           reply.row_version AS rowVersion,
           reply.deleted_at AS deletedAt,
           parent.deleted_at AS parentDeletedAt
         FROM comments reply
         JOIN comments parent
           ON parent.id = reply.parent_id AND parent.version_id = reply.version_id
         JOIN versions version ON version.id = reply.version_id
         WHERE reply.id = ?
           AND reply.parent_id IS NOT NULL
           AND parent.parent_id IS NULL
           AND version.status = 'published'
           AND version.bundle_hash IS NOT NULL`,
      )
      .get(replyId) as ReplyContextRow | undefined;
    return row === undefined ? null : { kind: "reply", ...row };
  }

  probeCreateReplay(
    authorId: number,
    requestId: string,
    requestHash: string,
  ): RepositoryMutationResult | null {
    return this.db.transaction(() => this.lookupReplay(authorId, requestId, requestHash))();
  }

  createRoot(command: CreateRootCommand): RepositoryMutationResult {
    const create = this.db.transaction(() => {
      const replay = this.lookupReplay(command.authorId, command.requestId, command.requestHash);
      if (replay !== null) {
        return replay;
      }
      this.assertVersionStillPublished(command.version);
      if (command.input.assigneeId !== null) {
        this.assertUserExists(command.input.assigneeId);
      }
      this.ensureState(command.version.versionId);
      const pin = this.db
        .prepare(
          `UPDATE comment_state
           SET next_pin_number = next_pin_number + 1
           WHERE version_id = ?
           RETURNING next_pin_number - 1 AS pinNumber`,
        )
        .get(command.version.versionId) as { pinNumber: number } | undefined;
      if (pin === undefined) {
        throw new IssueServiceError("internal_error", "Could not allocate an issue pin.");
      }
      const resourceId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO comments (
             id, version_id, author_id, create_request_id, create_request_hash,
             pin_number, level_id, longitude, latitude, feature_id, body_markdown,
             status, assignee_id, due_date, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(
          resourceId,
          command.version.versionId,
          command.authorId,
          command.requestId,
          command.requestHash,
          pin.pinNumber,
          command.input.levelId,
          command.input.longitude,
          command.input.latitude,
          command.input.featureId,
          command.input.bodyMarkdown,
          command.input.assigneeId,
          command.input.dueDate,
          command.now,
          command.now,
        );
      this.bindAttachments(
        resourceId,
        command.version.versionId,
        command.authorId,
        command.input.attachmentIds,
        command.now,
      );
      return this.success(command.version, resourceId, this.bumpRevision(command.version.versionId));
    });
    return create.immediate();
  }

  createReply(command: CreateReplyCommand): RepositoryMutationResult {
    const create = this.db.transaction(() => {
      const replay = this.lookupReplay(command.authorId, command.requestId, command.requestHash);
      if (replay !== null) {
        return replay;
      }
      this.assertVersionStillPublished(command.version);
      const parent = this.db
        .prepare(
          `SELECT deleted_at AS deletedAt
           FROM comments
           WHERE id = ? AND version_id = ? AND parent_id IS NULL`,
        )
        .get(command.parentIssueId, command.version.versionId) as { deletedAt: string | null } | undefined;
      if (parent === undefined) {
        notFound();
      }
      if (parent.deletedAt !== null) {
        deleted();
      }
      this.ensureState(command.version.versionId);
      const resourceId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO comments (
             id, version_id, parent_id, author_id, create_request_id,
             create_request_hash, body_markdown, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resourceId,
          command.version.versionId,
          command.parentIssueId,
          command.authorId,
          command.requestId,
          command.requestHash,
          command.input.bodyMarkdown,
          command.now,
          command.now,
        );
      this.bindAttachments(
        resourceId,
        command.version.versionId,
        command.authorId,
        command.input.attachmentIds,
        command.now,
      );
      return this.success(command.version, resourceId, this.bumpRevision(command.version.versionId));
    });
    return create.immediate();
  }

  patchIssue(command: PatchIssueCommand): RepositoryMutationResult {
    return this.db.transaction(() => {
      const returned = this.updateIssue(command);
      if (returned === undefined) {
        const invalidAssigneeId =
          command.patch.type === "assignment" && command.patch.assigneeId !== null
            ? command.patch.assigneeId
            : undefined;
        return this.issueMutationFailure(
          command.issueId,
          command.patch.expectedVersion,
          invalidAssigneeId,
        );
      }
      if (command.patch.type === "body") {
        this.bindAttachments(
          command.issueId,
          returned.versionId,
          returned.authorId,
          command.patch.attachmentIds,
          command.now,
        );
      }
      this.ensureState(returned.versionId);
      const version = this.readVersionIdentity(returned.versionId);
      return this.success(version, command.issueId, this.bumpRevision(returned.versionId));
    })();
  }

  patchReply(command: PatchReplyCommand): RepositoryMutationResult {
    return this.db.transaction(() => {
      const returned = this.db
        .prepare(
          `UPDATE comments
           SET body_markdown = ?, row_version = row_version + 1, updated_at = ?
           WHERE id = ? AND parent_id IS NOT NULL AND row_version = ? AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM versions
               WHERE versions.id = comments.version_id
                 AND versions.status = 'published'
                 AND versions.bundle_hash IS NOT NULL
             )
           RETURNING version_id AS versionId, author_id AS authorId`,
        )
        .get(
          command.patch.bodyMarkdown,
          command.now,
          command.replyId,
          command.patch.expectedVersion,
        ) as { versionId: number; authorId: number } | undefined;
      if (returned === undefined) {
        return this.replyMutationFailure(command.replyId);
      }
      this.bindAttachments(
        command.replyId,
        returned.versionId,
        returned.authorId,
        command.patch.attachmentIds,
        command.now,
      );
      this.ensureState(returned.versionId);
      const version = this.readVersionIdentity(returned.versionId);
      return this.success(version, command.replyId, this.bumpRevision(returned.versionId));
    })();
  }

  deleteIssue(command: DeleteIssueCommand): RepositoryMutationResult {
    return this.db.transaction(() => {
      const returned = this.db
        .prepare(
          `UPDATE comments
           SET body_markdown = NULL,
               status = 'closed',
               row_version = row_version + 1,
               updated_at = ?,
               deleted_at = ?
           WHERE id = ? AND parent_id IS NULL AND row_version = ? AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM versions
               WHERE versions.id = comments.version_id
                 AND versions.status = 'published'
                 AND versions.bundle_hash IS NOT NULL
             )
           RETURNING version_id AS versionId`,
        )
        .get(command.now, command.now, command.issueId, command.expectedVersion) as
        | { versionId: number }
        | undefined;
      if (returned === undefined) {
        return this.issueMutationFailure(command.issueId, command.expectedVersion);
      }
      this.ensureState(returned.versionId);
      const version = this.readVersionIdentity(returned.versionId);
      return this.success(version, command.issueId, this.bumpRevision(returned.versionId));
    })();
  }

  deleteReply(command: DeleteReplyCommand): RepositoryMutationResult {
    return this.db.transaction(() => {
      const returned = this.db
        .prepare(
          `UPDATE comments
           SET body_markdown = NULL,
               row_version = row_version + 1,
               updated_at = ?,
               deleted_at = ?
           WHERE id = ? AND parent_id IS NOT NULL AND row_version = ? AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM versions
               WHERE versions.id = comments.version_id
                 AND versions.status = 'published'
                 AND versions.bundle_hash IS NOT NULL
             )
           RETURNING version_id AS versionId`,
        )
        .get(command.now, command.now, command.replyId, command.expectedVersion) as
        | { versionId: number }
        | undefined;
      if (returned === undefined) {
        return this.replyMutationFailure(command.replyId);
      }
      this.ensureState(returned.versionId);
      const version = this.readVersionIdentity(returned.versionId);
      return this.success(version, command.replyId, this.bumpRevision(returned.versionId));
    })();
  }

  private ensureState(versionId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO comment_state (version_id) VALUES (?)").run(versionId);
  }

  /**
   * Attached-attachment metadata for every comment of a version, keyed by
   * comment ID. Tombstoned comments simply have no attached rows projected
   * (their media is unservable), and janitor cleanup never rewrites bodies.
   */
  private attachmentsForVersion(versionId: number): Map<string, IssueAttachmentMetadata[]> {
    const rows = this.db
      .prepare(
        `SELECT
           a.comment_id AS commentId,
           a.id,
           o.content_type AS contentType,
           o.width,
           o.height,
           t.width AS thumbnailWidth,
           t.height AS thumbnailHeight
         FROM issue_attachments a
         JOIN issue_attachment_blobs o ON o.hash = a.original_hash
         JOIN issue_attachment_blobs t ON t.hash = a.thumbnail_hash
         WHERE a.version_id = ? AND a.state = 'attached'
         ORDER BY a.attached_at, a.id`,
      )
      .all(versionId) as ({ commentId: string } & IssueAttachmentMetadata)[];
    const map = new Map<string, IssueAttachmentMetadata[]>();
    for (const { commentId, ...metadata } of rows) {
      const list = map.get(commentId);
      if (list === undefined) {
        map.set(commentId, [metadata]);
      } else {
        list.push(metadata);
      }
    }
    return map;
  }

  /**
   * Transactional attachment binding for create/body-edit. Attaches staged
   * IDs owned by the author on the exact version, detaches IDs the body no
   * longer references, and enforces count/aggregate caps — all inside the
   * caller's mutation transaction so a failure rolls the body change back.
   * Re-attaching an ID this same comment previously detached (undo-removal)
   * is allowed; every other unavailable ID is an opaque validation error.
   */
  private bindAttachments(
    commentId: string,
    versionId: number,
    authorId: number,
    ids: string[],
    now: string,
  ): void {
    if (ids.length > ATTACHMENT_MAX_PER_COMMENT) {
      throw new IssueServiceError("invalid_attachment", "invalid_attachment", {
        details: [
          { field: "attachmentIds", reason: `at most ${ATTACHMENT_MAX_PER_COMMENT} attachments per comment` },
        ],
      });
    }
    const currentRows = this.db
      .prepare(
        `SELECT id FROM issue_attachments
         WHERE comment_id = ? AND version_id = ? AND state = 'attached'`,
      )
      .all(commentId, versionId) as { id: string }[];
    const wanted = new Set(ids);
    const kept = new Set<string>();
    for (const row of currentRows) {
      if (wanted.has(row.id)) {
        kept.add(row.id);
      } else {
        this.db
          .prepare(
            `UPDATE issue_attachments
             SET state = 'detached', detached_at = ?
             WHERE id = ? AND version_id = ? AND state = 'attached'`,
          )
          .run(now, row.id, versionId);
      }
    }
    for (const id of ids) {
      if (kept.has(id)) {
        continue;
      }
      const attached = this.db
        .prepare(
          `UPDATE issue_attachments
           SET state = 'attached', comment_id = ?, attached_at = ?, detached_at = NULL
           WHERE id = ? AND version_id = ? AND uploader_id = ?
             AND (state = 'staged' OR (state = 'detached' AND comment_id = ?))`,
        )
        .run(commentId, now, id, versionId, authorId, commentId);
      if (attached.changes === 0) {
        invalidAttachment();
      }
    }
    const aggregate = this.db
      .prepare(
        `SELECT COALESCE(SUM(a.input_byte_size), 0) AS total
         FROM issue_attachments a
         WHERE a.comment_id = ? AND a.version_id = ? AND a.state = 'attached'`,
      )
      .get(commentId, versionId) as { total: number };
    if (aggregate.total > ATTACHMENT_MAX_COMMENT_AGGREGATE_BYTES) {
      throw new IssueServiceError("invalid_attachment", "invalid_attachment", {
        details: [{ field: "attachmentIds", reason: "attachments exceed the per-comment size limit" }],
      });
    }
  }

  private readRevision(versionId: number): number {
    const row = this.db
      .prepare("SELECT revision FROM comment_state WHERE version_id = ?")
      .get(versionId) as { revision: number } | undefined;
    if (row === undefined) {
      throw new IssueServiceError("internal_error", "Review issue state is missing.");
    }
    return row.revision;
  }

  private bumpRevision(versionId: number): number {
    const row = this.db
      .prepare(
        `UPDATE comment_state
         SET revision = revision + 1
         WHERE version_id = ?
         RETURNING revision`,
      )
      .get(versionId) as { revision: number } | undefined;
    if (row === undefined) {
      throw new IssueServiceError("internal_error", "Could not increment issue revision.");
    }
    return row.revision;
  }

  private lookupReplay(
    authorId: number,
    requestId: string,
    requestHash: string,
  ): RepositoryMutationResult | null {
    const row = this.db
      .prepare(
        `SELECT
           comment.id AS resourceId,
           comment.create_request_hash AS requestHash,
           comment.version_id AS versionId,
           version.public_id AS publicVersionId,
           state.revision
         FROM comments comment
         JOIN versions version ON version.id = comment.version_id
         JOIN comment_state state ON state.version_id = comment.version_id
         WHERE comment.author_id = ? AND comment.create_request_id = ?`,
      )
      .get(authorId, requestId) as ReplayRow | undefined;
    if (row === undefined) {
      return null;
    }
    if (row.requestHash !== requestHash) {
      throw new IssueServiceError("idempotency_conflict", IDEMPOTENCY_MESSAGE);
    }
    return {
      type: "ok",
      revision: row.revision,
      versionId: row.versionId,
      publicVersionId: row.publicVersionId,
      resourceId: row.resourceId,
      replayed: true,
    };
  }

  private assertVersionStillPublished(expected: PublishedReviewVersion): void {
    const row = this.db
      .prepare(
        `SELECT id
         FROM versions
         WHERE id = ?
           AND public_id = ?
           AND status = 'published'
           AND bundle_hash = ?
           AND bundle_hash IS NOT NULL`,
      )
      .get(expected.versionId, expected.publicVersionId, expected.bundleHash);
    if (row === undefined) {
      notFound();
    }
  }

  private assertUserExists(userId: number): void {
    const row = this.db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (row === undefined) {
      throw new IssueServiceError("invalid_request", "The selected assignee does not exist.", {
        details: [{ field: "assigneeId", reason: "account does not exist" }],
      });
    }
  }

  private success(
    version: PublishedReviewVersion,
    resourceId: string,
    revision: number,
  ): RepositoryMutationSuccess {
    return {
      type: "ok",
      revision,
      versionId: version.versionId,
      publicVersionId: version.publicVersionId,
      resourceId,
      replayed: false,
    };
  }

  private readIssueContext(issueId: string): IssueContextRow | undefined {
    return this.db
      .prepare(
        `SELECT
           comment.id AS issueId,
           comment.version_id AS versionId,
           version.public_id AS publicVersionId,
           comment.author_id AS authorId,
           comment.status,
           comment.assignee_id AS assigneeId,
           comment.row_version AS rowVersion,
           comment.deleted_at AS deletedAt
         FROM comments comment
         JOIN versions version ON version.id = comment.version_id
         WHERE comment.id = ?
           AND comment.parent_id IS NULL
           AND version.status = 'published'
           AND version.bundle_hash IS NOT NULL`,
      )
      .get(issueId) as IssueContextRow | undefined;
  }

  private readVersionIdentity(versionId: number): PublishedReviewVersion {
    const row = this.db
      .prepare(
        `SELECT id, public_id AS publicVersionId, bundle_hash AS bundleHash
         FROM versions
         WHERE id = ? AND status = 'published' AND bundle_hash IS NOT NULL`,
      )
      .get(versionId) as PublishedVersionRow | undefined;
    if (row === undefined) {
      notFound();
    }
    return { versionId: row.id, publicVersionId: row.publicVersionId, bundleHash: row.bundleHash };
  }

  private updateIssue(command: PatchIssueCommand): { versionId: number; authorId: number } | undefined {
    const common = `
      WHERE id = ? AND parent_id IS NULL AND row_version = ? AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM versions
          WHERE versions.id = comments.version_id
            AND versions.status = 'published'
            AND versions.bundle_hash IS NOT NULL
        )
      RETURNING version_id AS versionId, author_id AS authorId`;
    switch (command.patch.type) {
      case "body":
        return this.db
          .prepare(
            `UPDATE comments
             SET body_markdown = ?, row_version = row_version + 1, updated_at = ?
             ${common}`,
          )
          .get(
            command.patch.bodyMarkdown,
            command.now,
            command.issueId,
            command.patch.expectedVersion,
          ) as { versionId: number; authorId: number } | undefined;
      case "assignment":
        return this.db
          .prepare(
            `UPDATE comments
             SET assignee_id = ?, row_version = row_version + 1, updated_at = ?
             WHERE id = ? AND parent_id IS NULL AND row_version = ? AND deleted_at IS NULL
               AND (? IS NULL OR EXISTS (SELECT 1 FROM users WHERE users.id = ?))
               AND EXISTS (
                 SELECT 1 FROM versions
                 WHERE versions.id = comments.version_id
                   AND versions.status = 'published'
                   AND versions.bundle_hash IS NOT NULL
               )
             RETURNING version_id AS versionId, author_id AS authorId`,
          )
          .get(
            command.patch.assigneeId,
            command.now,
            command.issueId,
            command.patch.expectedVersion,
            command.patch.assigneeId,
            command.patch.assigneeId,
          ) as { versionId: number; authorId: number } | undefined;
      case "due_date":
        return this.db
          .prepare(
            `UPDATE comments
             SET due_date = ?, row_version = row_version + 1, updated_at = ?
             ${common}`,
          )
          .get(
            command.patch.dueDate,
            command.now,
            command.issueId,
            command.patch.expectedVersion,
          ) as { versionId: number; authorId: number } | undefined;
      case "status":
        return this.db
          .prepare(
            `UPDATE comments
             SET status = ?, row_version = row_version + 1, updated_at = ?
             ${common}`,
          )
          .get(
            command.patch.status,
            command.now,
            command.issueId,
            command.patch.expectedVersion,
          ) as { versionId: number; authorId: number } | undefined;
    }
  }

  private issueMutationFailure(
    issueId: string,
    expectedVersion: number,
    invalidAssigneeId?: number,
  ): RepositoryMutationStale {
    const identity = this.db
      .prepare(
        `SELECT
           comment.version_id AS versionId,
           version.public_id AS publicVersionId,
           comment.deleted_at AS deletedAt,
           comment.row_version AS rowVersion
         FROM comments comment
         JOIN versions version ON version.id = comment.version_id
         WHERE comment.id = ?
           AND comment.parent_id IS NULL
           AND version.status = 'published'
           AND version.bundle_hash IS NOT NULL`,
      )
      .get(issueId) as VersionIdentityRow | undefined;
    if (identity === undefined) {
      notFound();
    }
    if (identity.deletedAt !== null) {
      deleted();
    }
    if (identity.rowVersion === expectedVersion) {
      if (invalidAssigneeId !== undefined) {
        this.assertUserExists(invalidAssigneeId);
      }
      throw new IssueServiceError("internal_error", "The issue mutation could not be applied.");
    }
    this.ensureState(identity.versionId);
    return {
      type: "stale",
      revision: this.readRevision(identity.versionId),
      versionId: identity.versionId,
      publicVersionId: identity.publicVersionId,
      resourceId: issueId,
      replayed: false,
      current: { kind: "issue", value: this.readIssueProjection(issueId, identity.versionId) },
    };
  }

  private replyMutationFailure(replyId: string): RepositoryMutationStale {
    const identity = this.db
      .prepare(
        `SELECT
           comment.version_id AS versionId,
           version.public_id AS publicVersionId,
           comment.deleted_at AS deletedAt
         FROM comments comment
         JOIN versions version ON version.id = comment.version_id
         WHERE comment.id = ?
           AND comment.parent_id IS NOT NULL
           AND version.status = 'published'
           AND version.bundle_hash IS NOT NULL`,
      )
      .get(replyId) as VersionIdentityRow | undefined;
    if (identity === undefined) {
      notFound();
    }
    if (identity.deletedAt !== null) {
      deleted();
    }
    this.ensureState(identity.versionId);
    return {
      type: "stale",
      revision: this.readRevision(identity.versionId),
      versionId: identity.versionId,
      publicVersionId: identity.publicVersionId,
      resourceId: replyId,
      replayed: false,
      current: { kind: "reply", value: this.readReplyProjection(replyId, identity.versionId) },
    };
  }

  private readIssueProjection(issueId: string, versionId: number): ReviewIssue {
    const row = this.db
      .prepare(
        `SELECT
           c.id,
           c.pin_number AS pinNumber,
           c.row_version AS rowVersion,
           c.level_id AS levelId,
           c.longitude,
           c.latitude,
           c.feature_id AS featureId,
           c.body_markdown AS bodyMarkdown,
           c.status,
           c.author_id AS authorId,
           author.username AS authorUsername,
           c.assignee_id AS assigneeId,
           assignee.username AS assigneeUsername,
           c.due_date AS dueDate,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           c.deleted_at AS deletedAt
         FROM comments c
         JOIN users author ON author.id = c.author_id
         LEFT JOIN users assignee ON assignee.id = c.assignee_id
         WHERE c.id = ? AND c.version_id = ? AND c.parent_id IS NULL`,
      )
      .get(issueId, versionId) as RootProjectionRow | undefined;
    if (row === undefined) {
      notFound();
    }
    const replies = this.db
      .prepare(
        `SELECT
           c.id,
           c.parent_id AS parentId,
           c.row_version AS rowVersion,
           c.body_markdown AS bodyMarkdown,
           c.author_id AS authorId,
           author.username AS authorUsername,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           c.deleted_at AS deletedAt
         FROM comments c
         JOIN users author ON author.id = c.author_id
         WHERE c.parent_id = ? AND c.version_id = ?
         ORDER BY c.created_at, c.id`,
      )
      .all(issueId, versionId) as ReplyProjectionRow[];
    const attachmentsByComment = this.attachmentsForVersion(versionId);
    return publicIssue(
      row,
      replies.map((reply) => publicReply(reply, attachmentsByComment.get(reply.id) ?? [])),
      attachmentsByComment.get(row.id) ?? [],
    );
  }

  private readReplyProjection(replyId: string, versionId: number): IssueReply {
    const row = this.db
      .prepare(
        `SELECT
           c.id,
           c.parent_id AS parentId,
           c.row_version AS rowVersion,
           c.body_markdown AS bodyMarkdown,
           c.author_id AS authorId,
           author.username AS authorUsername,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           c.deleted_at AS deletedAt
         FROM comments c
         JOIN users author ON author.id = c.author_id
         WHERE c.id = ? AND c.version_id = ? AND c.parent_id IS NOT NULL`,
      )
      .get(replyId, versionId) as ReplyProjectionRow | undefined;
    if (row === undefined) {
      notFound();
    }
    return publicReply(row, this.attachmentsForVersion(versionId).get(row.id) ?? []);
  }
}
