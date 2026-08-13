-- A queued activation owns the exact evaluation snapshot it is publishing.
-- Registration cannot replace that snapshot until publication either commits
-- the activation or fails and releases the reservation.
ALTER TABLE tile_activations
  ADD COLUMN activating_version_id INTEGER REFERENCES versions(id) ON DELETE RESTRICT;

ALTER TABLE tile_activations
  ADD COLUMN activating_by INTEGER REFERENCES users(id);

ALTER TABLE tile_activations
  ADD COLUMN activating_at TEXT;

-- Queue shutdown and startup recovery fail draft versions outside the publish
-- runner. Keep release coupled to the version transition so every failure path
-- makes the evaluation retryable.
CREATE TRIGGER release_tile_activation_on_failed_version
AFTER UPDATE OF status ON versions
WHEN NEW.status = 'failed'
BEGIN
  UPDATE tile_activations
  SET activating_version_id = NULL,
      activating_by = NULL,
      activating_at = NULL
  WHERE activating_version_id = NEW.id
    AND state = 'evaluated';
END;
