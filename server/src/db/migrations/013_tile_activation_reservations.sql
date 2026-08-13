-- A queued activation owns the exact evaluation snapshot it is publishing.
-- Registration cannot replace that snapshot until publication either commits
-- the activation or fails and releases the reservation.
ALTER TABLE tile_activations
  ADD COLUMN activating_version_id INTEGER REFERENCES versions(id) ON DELETE RESTRICT;

ALTER TABLE tile_activations
  ADD COLUMN activating_by INTEGER REFERENCES users(id);

ALTER TABLE tile_activations
  ADD COLUMN activating_at TEXT;
