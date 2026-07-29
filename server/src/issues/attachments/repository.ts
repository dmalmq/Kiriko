import type Database from "better-sqlite3";
import type { IssueAttachmentMetadata } from "../types";
import type { AttachmentContentType } from "./limits";

/**
 * Persistence for issue attachment metadata. Binary payloads live in the
 * content-addressed `IssueAttachmentStore`; this module owns the two tables
 * and every attachment lifecycle query. All multi-statement writes run in
 * better-sqlite3 transactions.
 */

export interface AttachmentBlobRow {
  hash: string;
  byteSize: number;
  contentType: AttachmentContentType;
  width: number;
  height: number;
}

interface BlobDbRow {
  hash: string;
  byte_size: number;
  content_type: AttachmentContentType;
  width: number;
  height: number;
}

export interface StagedUploadInsert {
  id: string;
  versionId: number;
  uploaderId: number;
  uploadRequestId: string;
  uploadRequestHash: string;
  original: AttachmentBlobRow;
  thumbnail: AttachmentBlobRow;
  originalName: string | null;
  now: string;
}

export interface UploadReplayRow {
  id: string;
  uploadRequestHash: string;
  metadata: IssueAttachmentMetadata;
}

export interface MediaResolution {
  originalHash: string;
  thumbnailHash: string;
  originalContentType: AttachmentContentType;
  thumbnailContentType: AttachmentContentType;
  servable: boolean;
}

function toBlobRow(row: BlobDbRow): AttachmentBlobRow {
  return {
    hash: row.hash,
    byteSize: row.byte_size,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
  };
}

export class IssueAttachmentRepository {
  constructor(private readonly db: Database.Database) {}

  /** Idempotent-upload lookup by the (uploader, request ID) unique key. */
  findUploadByRequestId(uploaderId: number, uploadRequestId: string): UploadReplayRow | null {
    const row = this.db
      .prepare(
        `SELECT
           a.id,
           a.upload_request_hash AS uploadRequestHash,
           o.content_type AS contentType,
           o.width,
           o.height,
           t.width AS thumbnailWidth,
           t.height AS thumbnailHeight
         FROM issue_attachments a
         JOIN issue_attachment_blobs o ON o.hash = a.original_hash
         JOIN issue_attachment_blobs t ON t.hash = a.thumbnail_hash
         WHERE a.uploader_id = ? AND a.upload_request_id = ?`,
      )
      .get(uploaderId, uploadRequestId) as
      | ({
          id: string;
          uploadRequestHash: string;
          contentType: AttachmentContentType;
          width: number;
          height: number;
          thumbnailWidth: number;
          thumbnailHeight: number;
        })
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      uploadRequestHash: row.uploadRequestHash,
      metadata: {
        id: row.id,
        contentType: row.contentType,
        width: row.width,
        height: row.height,
        thumbnailWidth: row.thumbnailWidth,
        thumbnailHeight: row.thumbnailHeight,
      },
    };
  }

  /** Total original bytes held (staged + attached) for a version, for quota. */
  versionAttachmentBytes(versionId: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(o.byte_size), 0) AS total
         FROM issue_attachments a
         JOIN issue_attachment_blobs o ON o.hash = a.original_hash
         WHERE a.version_id = ? AND a.state IN ('staged','attached')`,
      )
      .get(versionId) as { total: number };
    return row.total;
  }

  /**
   * Inserts blob metadata (content-addressed, shared hashes reused) plus the
   * staged attachment row atomically. Relies on the
   * UNIQUE(uploader_id, upload_request_id) constraint for retry safety.
   */
  createStagedUpload(insert: StagedUploadInsert): void {
    this.db.transaction(() => {
      this.insertBlob(insert.original, insert.now);
      this.insertBlob(insert.thumbnail, insert.now);
      this.db
        .prepare(
          `INSERT INTO issue_attachments (
             id, version_id, uploader_id, upload_request_id, upload_request_hash,
             original_hash, thumbnail_hash, original_name, state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)`,
        )
        .run(
          insert.id,
          insert.versionId,
          insert.uploaderId,
          insert.uploadRequestId,
          insert.uploadRequestHash,
          insert.original.hash,
          insert.thumbnail.hash,
          insert.originalName,
          insert.now,
        );
    }).immediate();
  }

  private insertBlob(blob: AttachmentBlobRow, now: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO issue_attachment_blobs
           (hash, byte_size, content_type, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(blob.hash, blob.byteSize, blob.contentType, blob.width, blob.height, now);
  }

  /**
   * Deletes a staged upload owned by `uploaderId`. Returns false when no such
   * staged row exists (unknown, foreign, or already attached/detached — all
   * indistinguishable to the caller).
   */
  deleteStagedUpload(attachmentId: string, uploaderId: number): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM issue_attachments
         WHERE id = ? AND uploader_id = ? AND state = 'staged'`,
      )
      .run(attachmentId, uploaderId);
    return result.changes > 0;
  }

  /**
   * Resolves a media read: the attachment must be attached to a live comment
   * on a currently published version. Everything else is unservable and must
   * surface as an opaque 404.
   */
  resolveMedia(attachmentId: string): MediaResolution | null {
    const row = this.db
      .prepare(
        `SELECT
           a.original_hash AS originalHash,
           a.thumbnail_hash AS thumbnailHash,
           o.content_type AS originalContentType,
           t.content_type AS thumbnailContentType,
           a.state,
           c.deleted_at AS commentDeletedAt,
           v.status AS versionStatus,
           v.bundle_hash AS bundleHash
         FROM issue_attachments a
         JOIN issue_attachment_blobs o ON o.hash = a.original_hash
         JOIN issue_attachment_blobs t ON t.hash = a.thumbnail_hash
         LEFT JOIN comments c ON c.id = a.comment_id AND c.version_id = a.version_id
         JOIN versions v ON v.id = a.version_id
         WHERE a.id = ?`,
      )
      .get(attachmentId) as
      | {
          originalHash: string;
          thumbnailHash: string;
          originalContentType: AttachmentContentType;
          thumbnailContentType: AttachmentContentType;
          state: "staged" | "attached" | "detached";
          commentDeletedAt: string | null;
          versionStatus: string;
          bundleHash: string | null;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    const servable =
      row.state === "attached"
      && row.commentDeletedAt === null
      && row.versionStatus === "published"
      && row.bundleHash !== null;
    return {
      originalHash: row.originalHash,
      thumbnailHash: row.thumbnailHash,
      originalContentType: row.originalContentType,
      thumbnailContentType: row.thumbnailContentType,
      servable,
    };
  }

  /** Janitor: staged rows created before the cutoff. */
  expiredStagedIds(createdBefore: string): string[] {
    return (
      this.db
        .prepare("SELECT id FROM issue_attachments WHERE state = 'staged' AND created_at < ?")
        .all(createdBefore) as { id: string }[]
    ).map((row) => row.id);
  }

  /** Janitor: detached rows detached before the cutoff. */
  expiredDetachedIds(detachedBefore: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM issue_attachments
           WHERE state = 'detached' AND detached_at IS NOT NULL AND detached_at < ?`,
        )
        .all(detachedBefore) as { id: string }[]
    ).map((row) => row.id);
  }

  /** Janitor: attachments of comments tombstoned before the cutoff. */
  tombstonedAttachedIds(commentDeletedBefore: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT a.id
           FROM issue_attachments a
           JOIN comments c ON c.id = a.comment_id AND c.version_id = a.version_id
           WHERE a.state = 'attached' AND c.deleted_at IS NOT NULL AND c.deleted_at < ?`,
        )
        .all(commentDeletedBefore) as { id: string }[]
    ).map((row) => row.id);
  }

  deleteAttachments(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const statement = this.db.prepare("DELETE FROM issue_attachments WHERE id = ?");
    this.db.transaction(() => {
      for (const id of ids) {
        statement.run(id);
      }
    })();
  }

  /** Blob rows no attachment references anymore (after row deletions). */
  unreferencedBlobHashes(): string[] {
    return (
      this.db
        .prepare(
          `SELECT b.hash
           FROM issue_attachment_blobs b
           WHERE NOT EXISTS (SELECT 1 FROM issue_attachments a WHERE a.original_hash = b.hash)
             AND NOT EXISTS (SELECT 1 FROM issue_attachments a WHERE a.thumbnail_hash = b.hash)`,
        )
        .all() as { hash: string }[]
    ).map((row) => row.hash);
  }

  deleteBlobRows(hashes: string[]): void {
    if (hashes.length === 0) {
      return;
    }
    const statement = this.db.prepare("DELETE FROM issue_attachment_blobs WHERE hash = ?");
    this.db.transaction(() => {
      for (const hash of hashes) {
        statement.run(hash);
      }
    })();
  }

  allBlobHashes(): Set<string> {
    const rows = this.db.prepare("SELECT hash FROM issue_attachment_blobs").all() as {
      hash: string;
    }[];
    return new Set(rows.map((row) => row.hash));
  }
}
