import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionUser } from "../../auth/sessions";
import { IssueServiceError } from "../errors";
import type { IssueAttachmentMetadata } from "../types";
import { validateRequestId } from "../validation";
import { ImageProcessingPool, processAttachmentImage, type ImageProcessingLimits } from "./image";
import { ATTACHMENT_MAX_FILE_BYTES } from "./limits";
import {
  IssueAttachmentRepository,
  type AttachmentBlobRow,
} from "./repository";
import { IssueAttachmentStore } from "./store";

export interface PublishedVersionPort {
  resolvePublishedVersion(publicId: string): { versionId: number } | null;
}

export interface IssueAttachmentServiceOptions {
  db: Database.Database;
  store: IssueAttachmentStore;
  versions: PublishedVersionPort;
  /** Tenant/version storage quota in bytes (captain decision media-policy). */
  versionQuotaBytes: number;
  uploadRateMax: number;
  uploadRateWindowMs: number;
  processingConcurrency: number;
  imageLimits?: ImageProcessingLimits;
  clock?: () => Date;
}

const NOT_FOUND_MESSAGE = "The review issue was not found.";

/** Simple in-memory sliding-window per-user upload rate limiter. */
class UploadRateLimiter {
  private readonly hits = new Map<number, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(userId: number, nowMs: number): boolean {
    const windowStart = nowMs - this.windowMs;
    const recent = (this.hits.get(userId) ?? []).filter((at) => at > windowStart);
    if (recent.length >= this.max) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(userId, recent);
    return true;
  }
}

/** Display-only original filename: control characters stripped, length-capped. */
function sanitizeOriginalName(name: string): string | null {
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (cleaned === "") {
    return null;
  }
  return [...cleaned].slice(0, 200).join("");
}

export class IssueAttachmentService {
  private readonly repository: IssueAttachmentRepository;
  private readonly store: IssueAttachmentStore;
  private readonly versions: PublishedVersionPort;
  private readonly versionQuotaBytes: number;
  private readonly rateLimiter: UploadRateLimiter;
  private readonly pool: ImageProcessingPool;
  private readonly imageLimits: ImageProcessingLimits | undefined;
  private readonly clock: () => Date;

  constructor(options: IssueAttachmentServiceOptions) {
    this.repository = new IssueAttachmentRepository(options.db);
    this.store = options.store;
    this.versions = options.versions;
    this.versionQuotaBytes = options.versionQuotaBytes;
    this.rateLimiter = new UploadRateLimiter(options.uploadRateMax, options.uploadRateWindowMs);
    this.pool = new ImageProcessingPool(options.processingConcurrency);
    this.imageLimits = options.imageLimits;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Authenticated staged upload. Idempotent on (uploader, requestId): a
   * response-loss retry with identical content returns the existing
   * attachment; different content under the same request ID conflicts.
   */
  async upload(
    user: SessionUser,
    publicVersionId: string,
    requestIdInput: string,
    originalName: string | null,
    bytes: Buffer,
  ): Promise<IssueAttachmentMetadata> {
    const requestId = validateRequestId(requestIdInput);
    const version = this.versions.resolvePublishedVersion(publicVersionId);
    if (version === null) {
      throw new IssueServiceError("not_found", NOT_FOUND_MESSAGE);
    }
    if (!this.rateLimiter.check(user.id, this.clock().getTime())) {
      throw new IssueServiceError("rate_limited", "Too many uploads. Try again later.");
    }
    if (bytes.byteLength === 0) {
      throw new IssueServiceError("invalid_attachment", "The image could not be accepted.", {
        details: [{ field: "file", reason: "file is empty" }],
      });
    }
    if (bytes.byteLength > ATTACHMENT_MAX_FILE_BYTES) {
      throw new IssueServiceError("invalid_attachment", "The image could not be accepted.", {
        details: [{ field: "file", reason: "file is too large" }],
      });
    }

    // The request hash binds raw content to the exact version, so an
    // identical retry short-circuits before any decoding work.
    const uploadRequestHash = IssueAttachmentStore.hashBytes(
      Buffer.concat([bytes, Buffer.from(`:${version.versionId}`, "utf8")]),
    );
    const existing = this.repository.findUploadByRequestId(user.id, requestId);
    if (existing !== null) {
      if (existing.uploadRequestHash !== uploadRequestHash) {
        throw new IssueServiceError(
          "idempotency_conflict",
          "This request ID was already used for a different upload.",
        );
      }
      return existing.metadata;
    }

    const processed = await this.pool.run(() =>
      processAttachmentImage(bytes, this.imageLimits),
    );

    const writtenHashes: string[] = [];
    const id = randomUUID();
    let original: AttachmentBlobRow;
    let thumbnail: AttachmentBlobRow;
    try {
      const originalPut = this.store.put(processed.original.bytes);
      writtenHashes.push(originalPut.hash);
      const thumbnailPut = this.store.put(processed.thumbnail.bytes);
      writtenHashes.push(thumbnailPut.hash);
      original = {
        hash: originalPut.hash,
        byteSize: originalPut.size,
        contentType: processed.original.contentType,
        width: processed.original.width,
        height: processed.original.height,
      };
      thumbnail = {
        hash: thumbnailPut.hash,
        byteSize: thumbnailPut.size,
        contentType: processed.thumbnail.contentType,
        width: processed.thumbnail.width,
        height: processed.thumbnail.height,
      };

      const created = this.repository.createStagedUpload({
        id,
        versionId: version.versionId,
        uploaderId: user.id,
        uploadRequestId: requestId,
        uploadRequestHash,
        original,
        thumbnail,
        inputByteSize: bytes.byteLength,
        originalName: originalName === null ? null : sanitizeOriginalName(originalName),
        now: this.clock().toISOString(),
      }, this.versionQuotaBytes);
      if (!created) {
        throw new IssueServiceError("quota_exceeded", "The attachment storage quota is exhausted.");
      }
    } catch (error) {
      this.rollbackWrittenFiles(writtenHashes);
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        const replay = this.repository.findUploadByRequestId(user.id, requestId);
        if (replay !== null) {
          if (replay.uploadRequestHash !== uploadRequestHash) {
            throw new IssueServiceError(
              "idempotency_conflict",
              "This request ID was already used for a different upload.",
            );
          }
          return replay.metadata;
        }
      }
      throw error;
    }

    return {
      id,
      contentType: original.contentType,
      width: original.width,
      height: original.height,
      thumbnailWidth: thumbnail.width,
      thumbnailHeight: thumbnail.height,
    };
  }

  /** Explicit cancel of a staged upload; anything else is an opaque 404. */
  cancelStaged(user: SessionUser, attachmentId: string): void {
    if (!this.repository.deleteStagedUpload(attachmentId, user.id)) {
      throw new IssueServiceError("not_found", NOT_FOUND_MESSAGE);
    }
    this.collectGarbage();
  }

  /**
   * Media read. Attached + live comment + currently published version yields
   * bytes; staged, detached, tombstoned, unpublished, and unknown IDs are all
   * the same opaque 404 so no state leaks.
   */
  async readMedia(
    attachmentId: string,
    kind: "content" | "thumbnail",
  ): Promise<{ bytes: Buffer; contentType: string; etag: string }> {
    const resolved = this.repository.resolveMedia(attachmentId);
    if (resolved === null || !resolved.servable) {
      throw new IssueServiceError("not_found", NOT_FOUND_MESSAGE);
    }
    const hash = kind === "content" ? resolved.originalHash : resolved.thumbnailHash;
    const contentType =
      kind === "content" ? resolved.originalContentType : resolved.thumbnailContentType;
    let bytes: Buffer;
    try {
      bytes = await this.store.readAsync(hash);
    } catch (error) {
      if (
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "ENOENT"
      ) {
        throw new IssueServiceError("not_found", NOT_FOUND_MESSAGE);
      }
      throw new IssueServiceError("internal_error", "Could not read the attachment.");
    }
    return { bytes, contentType, etag: `"${hash}"` };
  }

  private rollbackWrittenFiles(writtenHashes: string[]): void {
    for (const hash of this.repository.releaseUnreferencedBlobHashes(writtenHashes)) {
      this.store.remove(hash);
    }
  }

  /** Removes blob rows/files no attachment references (post-delete GC). */
  collectGarbage(): void {
    const hashes = this.repository.unreferencedBlobHashes();
    this.repository.deleteBlobRows(hashes);
    for (const hash of hashes) {
      this.store.remove(hash);
    }
  }
}
