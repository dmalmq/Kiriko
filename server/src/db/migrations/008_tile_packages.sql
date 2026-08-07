-- Tile packages: the ingestion record for an uploaded 3D Tiles package, and the
-- members its URI graph references.
--
-- A package is attached to a venue, not to a version: ingestion produces an
-- inspectable record while a producer decides what to do with it, and changes no
-- published state. Binding members to versions (and the reference counting that
-- makes garbage collection safe) is a separate concern and a separate table.
--
-- Member bytes live in the shared content-addressed blob store, so two packages
-- — or two venues — that contain the same member store it once. These rows are
-- the record of what was accepted, addressed by the same hash the store uses.

CREATE TABLE tile_packages (
  id INTEGER PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  -- Content address of the uploaded package archive, retained as provenance:
  -- re-ingesting identical bytes must be recognisable as the same package.
  source_hash TEXT NOT NULL
    CHECK (length(source_hash) = 64 AND source_hash = lower(source_hash)
           AND source_hash NOT GLOB '*[^0-9a-f]*'),
  root_tileset TEXT NOT NULL CHECK (length(root_tileset) > 0),
  -- Distinct tileset asset versions, and the extensions the package declares.
  asset_versions_json TEXT NOT NULL,
  extensions_json TEXT NOT NULL,
  -- Entries the graph never references: reported for the producer, never stored.
  ignored_json TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One record per package per venue: re-uploading the same bytes updates the
  -- existing record rather than accumulating duplicates.
  UNIQUE (venue_id, source_hash)
);

CREATE INDEX tile_packages_venue_idx ON tile_packages (venue_id);

CREATE TABLE tile_package_members (
  package_id INTEGER NOT NULL REFERENCES tile_packages(id) ON DELETE CASCADE,
  -- Path inside the package; the URI graph resolves to exactly this.
  path TEXT NOT NULL CHECK (length(path) > 0),
  hash TEXT NOT NULL
    CHECK (length(hash) = 64 AND hash = lower(hash) AND hash NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_type TEXT NOT NULL
    CHECK (content_type IN ('application/json','model/gltf-binary')),
  kind TEXT NOT NULL CHECK (kind IN ('tileset','content')),
  PRIMARY KEY (package_id, path)
);

CREATE INDEX tile_package_members_hash_idx ON tile_package_members (hash);
