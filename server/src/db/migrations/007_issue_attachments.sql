-- Issue attachments: immutable, content-addressed normalized image blobs plus
-- per-comment attachment rows. Attachments are server-side only (never in KVB,
-- export, or carry-forward) and cascade with their version/venue.

CREATE TABLE issue_attachment_blobs (
  hash TEXT PRIMARY KEY
    CHECK (length(hash) = 64 AND hash = lower(hash) AND hash NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE issue_attachments (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id) AND id NOT GLOB '*[^0-9a-f-]*'),
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  upload_request_id TEXT NOT NULL,
  upload_request_hash TEXT NOT NULL
    CHECK (length(upload_request_hash) = 64 AND upload_request_hash = lower(upload_request_hash)
      AND upload_request_hash NOT GLOB '*[^0-9a-f]*'),
  comment_id TEXT,
  original_hash TEXT NOT NULL REFERENCES issue_attachment_blobs(hash),
  thumbnail_hash TEXT NOT NULL REFERENCES issue_attachment_blobs(hash),
  input_byte_size INTEGER NOT NULL CHECK (input_byte_size > 0),
  original_name TEXT,
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged','attached','detached')),
  created_at TEXT NOT NULL,
  attached_at TEXT,
  detached_at TEXT,
  UNIQUE (uploader_id, upload_request_id),
  CHECK (state <> 'attached' OR comment_id IS NOT NULL),
  FOREIGN KEY (comment_id, version_id) REFERENCES comments(id, version_id)
);

CREATE INDEX idx_issue_attachments_comment
  ON issue_attachments(comment_id, version_id) WHERE state = 'attached';
CREATE INDEX idx_issue_attachments_state_created
  ON issue_attachments(state, created_at);
