/** Approved attachment budgets (captain decision `media-policy`). */
export const ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_COMMENT = 10;
export const ATTACHMENT_MAX_COMMENT_AGGREGATE_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_PIXELS = 40_000_000;
export const ATTACHMENT_MAX_DIMENSION = 12_000;
export const ATTACHMENT_THUMBNAIL_MAX_DIMENSION = 1_600;
export const ATTACHMENT_STAGED_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_DETACHED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Grace before media of a tombstoned comment is physically removed. */
export const ATTACHMENT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Filesystem files with no metadata row are removed after this safety age. */
export const ATTACHMENT_ORPHAN_FILE_AGE_MS = 24 * 60 * 60 * 1000;

export const ATTACHMENT_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];
