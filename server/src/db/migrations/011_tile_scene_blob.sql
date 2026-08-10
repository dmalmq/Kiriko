-- The render document an activation derived.
--
-- Derived once, when the producer activates, not per request: a 172 MiB package
-- cannot be re-derived on every viewer load. The bytes also belong to the
-- version the activation produced, so deriving them once is what lets a pinned
-- URL promise they never change.
--
-- Stored in the shared content-addressed store like every other tile member,
-- and registered in `tile_blobs` so collection counts it. A derived scene that
-- collection did not know about would be swept away while a published version
-- was still rendering it.

ALTER TABLE tile_activations ADD COLUMN scene_blob_hash TEXT
  CHECK (scene_blob_hash IS NULL
         OR (length(scene_blob_hash) = 64 AND scene_blob_hash = lower(scene_blob_hash)
             AND scene_blob_hash NOT GLOB '*[^0-9a-f]*'));
