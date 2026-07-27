DROP TRIGGER IF EXISTS publish_jobs_require_live_version_update;

CREATE TRIGGER publish_jobs_require_live_version_update
BEFORE UPDATE OF kind, status, version_id ON jobs
WHEN NEW.kind = 'publish_imdf'
  AND NEW.status IN ('queued', 'running')
  AND NEW.version_id IS NULL
  AND OLD.version_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'publication job requires version_id');
END;
