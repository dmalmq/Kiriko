-- Who confirmed the floor mapping, and when.
--
-- The registration gates cannot prove a mapping correct. A stack offset by about
-- a storey maps every level to its neighbour, and where footprints repeat — the
-- stacked platforms and repeated concourses of a station — the residuals against
-- the wrong floor measure as small as against the right one. That case is
-- undecidable from geometry, which is why #74 makes the datum a producer decision
-- rather than an inference.
--
-- So the last step is a person asserting the mapping is right, and this is where
-- that assertion is kept. It is recorded rather than merely required because the
-- question worth answering later is not "was a box ticked" but "who checked, and
-- against which measurements" — the row already holds the report and the profile
-- they were looking at.
--
-- Nullable: activations recorded before this column existed were never confirmed,
-- and backfilling a name would invent provenance.

ALTER TABLE tile_activations ADD COLUMN mapping_confirmed_at TEXT;
ALTER TABLE tile_activations ADD COLUMN mapping_confirmed_by INTEGER REFERENCES users(id);
