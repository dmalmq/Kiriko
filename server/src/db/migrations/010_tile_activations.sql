-- Tile activations: the evidence behind letting a package become a venue's
-- primary view, and the record that it happened.
--
-- An evaluation is measured against one version's canonical data, so it is
-- stored against that version *and* its bundle hash. Republishing a venue
-- changes the geometry registration was measured against, and a stale
-- evaluation must not be able to gate a version it never saw — the hash is what
-- makes that checkable rather than assumed.
--
-- The profile is stored, not referenced. #30 section 6 makes a published
-- activation's profile and report immutable, and a profile that lived somewhere
-- editable would let a later change retroactively re-judge a version that is
-- already serving.
--
-- What the renderer reads is §9 in the activated version's own bundle. These
-- rows are the producer's record of how it got there: the report, the gates,
-- and who decided.

CREATE TABLE tile_activations (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES tile_packages(id) ON DELETE CASCADE,
  -- The version whose canonical venue data the evaluation measured against.
  evaluated_version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  -- That version's bundle bytes. A different hash means different geometry.
  evaluated_bundle_hash TEXT NOT NULL
    CHECK (length(evaluated_bundle_hash) = 64
           AND evaluated_bundle_hash = lower(evaluated_bundle_hash)
           AND evaluated_bundle_hash NOT GLOB '*[^0-9a-f]*'),
  -- The versioned registration profile, stored whole.
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0),
  profile_version INTEGER NOT NULL CHECK (profile_version >= 0),
  profile_json TEXT NOT NULL,
  -- The capability profile this activation is recorded against (#26).
  capability_profile TEXT,
  report_json TEXT NOT NULL,
  -- Every gate that blocked. Empty means the package may be activated.
  gates_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'evaluated' CHECK (state IN ('evaluated', 'activated')),
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  evaluated_by INTEGER NOT NULL REFERENCES users(id),
  activated_at TEXT,
  activated_by INTEGER REFERENCES users(id),
  -- The immutable version the activation produced: the one that renders it.
  activated_version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL,
  -- Re-evaluating a package against the same version replaces its evaluation
  -- rather than accumulating them.
  UNIQUE (package_id, evaluated_version_id),
  -- An activation names the version it produced, and only an activation does.
  CHECK ((state = 'activated') = (activated_version_id IS NOT NULL)),
  CHECK ((state = 'activated') = (activated_at IS NOT NULL)),
  CHECK ((state = 'activated') = (activated_by IS NOT NULL))
);

CREATE INDEX tile_activations_package_idx ON tile_activations (package_id);
