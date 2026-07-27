ALTER TABLE jobs RENAME TO jobs_before_version_lifecycle;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  owner_id TEXT,
  lease_expires_at TEXT,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER publish_jobs_require_live_version_insert
BEFORE INSERT ON jobs
WHEN NEW.kind = 'publish_imdf'
  AND NEW.status IN ('queued', 'running')
  AND NEW.version_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'publication job requires version_id');
END;

CREATE TRIGGER publish_jobs_require_live_version_update
BEFORE UPDATE OF kind, status, version_id ON jobs
WHEN NEW.kind = 'publish_imdf'
  AND NEW.status IN ('queued', 'running')
  AND NEW.version_id IS NULL
  AND OLD.version_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'publication job requires version_id');
END;

INSERT INTO jobs (
  id, kind, version_id, status, owner_id, lease_expires_at, payload_json, result_json, error, created_at, updated_at
)
WITH parsed AS (
  SELECT
    jobs_before_version_lifecycle.*,
    CASE
      WHEN kind = 'publish_imdf' THEN CAST(json_extract(payload_json, '$.versionId') AS INTEGER)
      ELSE NULL
    END AS parsed_version_id
  FROM jobs_before_version_lifecycle
),
linked AS (
  SELECT
    parsed.*,
    EXISTS (SELECT 1 FROM versions WHERE versions.id = parsed.parsed_version_id) AS version_exists
  FROM parsed
),
normalized AS (
  SELECT
    linked.*,
    kind = 'publish_imdf'
      AND status IN ('queued', 'running')
      AND version_exists = 0 AS orphaned_live_publication
  FROM linked
)
SELECT
  id,
  kind,
  CASE
    WHEN kind = 'publish_imdf' AND version_exists = 1 THEN parsed_version_id
    ELSE NULL
  END,
  CASE
    WHEN orphaned_live_publication THEN 'error'
    ELSE status
  END,
  NULL,
  NULL,
  payload_json,
  CASE
    WHEN orphaned_live_publication THEN NULL
    ELSE result_json
  END,
  CASE
    WHEN orphaned_live_publication THEN '{"code":"orphaned_job","message":"Publication job lost its draft version before migration"}'
    ELSE error
  END,
  created_at,
  CASE
    WHEN orphaned_live_publication THEN datetime('now')
    ELSE updated_at
  END
FROM normalized;

DROP TABLE jobs_before_version_lifecycle;
CREATE INDEX jobs_status_created_idx ON jobs(status, created_at, id);
CREATE INDEX jobs_version_id_idx ON jobs(version_id);
CREATE INDEX jobs_running_lease_idx ON jobs(status, lease_expires_at);
