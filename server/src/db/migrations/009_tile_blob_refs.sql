-- Tile blob references: what makes garbage collection safe.
--
-- Two tables, two different jobs.
--
-- `tile_blobs` is a *registry*: it records that a blob in the shared
-- content-addressed store holds tile content. Collection only ever considers
-- blobs listed here, so a reference class nobody remembered to check — a bundle,
-- a GDB source, a network export — cannot be deleted by a sweep that was aimed
-- at tiles. The registry outlives any one package: a package row can cascade
-- away while its bytes are still on disk, and without the registry those bytes
-- would become unrecognisable garbage instead of collectable garbage.
--
-- `version_tile_packages` is a *reference*: it binds an immutable venue version
-- to the package it renders. A published or archived version keeps its package
-- alive; discarding a draft's attachment releases it. Collection reads these
-- references rather than guessing from file age, which is the whole point — an
-- age heuristic would eventually delete a member of a venue nobody had opened
-- in a while.

CREATE TABLE tile_blobs (
  hash TEXT PRIMARY KEY
    CHECK (length(hash) = 64 AND hash = lower(hash) AND hash NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE version_tile_packages (
  -- One package per version: a version renders one tile scene (#30 section 1).
  version_id INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES tile_packages(id) ON DELETE CASCADE,
  attached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX version_tile_packages_package_idx ON version_tile_packages (package_id);
