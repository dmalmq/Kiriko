/**
 * Tile member storage lifecycle and garbage collection (#72, #30 section 6).
 *
 * A tile package is the first thing in Kiriko that is too big to live inside a
 * bundle, so its members live in the shared content-addressed store and are
 * *reference counted*. Getting that wrong is not a rendering bug: it deletes
 * bytes a published venue serves. So this module is built around two ideas.
 *
 * **Collection only considers blobs it can prove are tile content.** The
 * `tile_blobs` registry is the proof. A blob that is not in it — a bundle, a GDB
 * source, a network export, anything a future feature adds — is never a
 * candidate, so a reference class nobody remembered to check cannot be swept
 * away. It also removes the ingestion race for free: bytes are stored before
 * their registry row exists, and a blob that is not yet registered is not yet
 * collectable.
 *
 * **References are read, never inferred.** A member survives while a package
 * row references it, or while a version references that package. There is no age
 * heuristic anywhere, because "nobody opened this venue recently" is not the
 * same fact as "nothing references this blob".
 */
import type { Database } from "better-sqlite3";
import type { BlobStore } from "../blobs/store";

export interface TileCollectionReport {
  /** Blobs released. */
  released: number;
  /** Bytes released. */
  bytes: number;
  /** Hashes released, sorted — the record of what a sweep actually did. */
  hashes: string[];
}

/**
 * Record that a blob holds tile content. Idempotent: re-ingesting a package
 * that shares members re-registers the same hashes harmlessly.
 */
export function registerTileBlob(db: Database, hash: string, byteSize: number): void {
  db.prepare("INSERT OR IGNORE INTO tile_blobs (hash, byte_size) VALUES (?, ?)").run(
    hash,
    byteSize,
  );
}

/**
 * Bind a version to the tile package it renders. A version holds one package
 * (#30 section 1), so attaching replaces any previous binding.
 */
export function attachPackageToVersion(db: Database, versionId: number, packageId: number): void {
  db.prepare(
    `INSERT INTO version_tile_packages (version_id, package_id)
     VALUES (?, ?)
     ON CONFLICT (version_id) DO UPDATE SET package_id = excluded.package_id,
                                            attached_at = datetime('now')`,
  ).run(versionId, packageId);
}

/**
 * Whether any version still references this package. The reference class is the
 * database's own rows, which is why this is a query and not a heuristic.
 */
export function packageIsReferenced(db: Database, packageId: number): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM version_tile_packages WHERE package_id = ?")
    .get(packageId);
  return row !== undefined && row !== null && typeof row === "object" && "count" in row
    ? Number(row.count) > 0
    : false;
}

/**
 * Discard an ingested package record. Refuses while a version still references
 * it: a published version's scene is immutable, and dropping its package would
 * leave it serving nothing.
 *
 * Returns `false` when the package is still referenced, so a caller can report
 * that rather than discovering it as an exception.
 */
export function discardPackage(db: Database, packageId: number): boolean {
  if (packageIsReferenced(db, packageId)) {
    return false;
  }
  db.prepare("DELETE FROM tile_packages WHERE id = ?").run(packageId);
  return true;
}

/**
 * Hashes that something still needs. Every class that can reference a blob in
 * the shared store is listed here; a hash in any of them is off limits even if
 * the tile registry also knows about it, because content addressing means two
 * classes can legitimately land on the same bytes.
 */
function referencedHashes(db: Database): Set<string> {
  const referenced = new Set<string>();
  const collect = (sql: string): void => {
    for (const row of db.prepare(sql).all()) {
      if (row !== null && typeof row === "object" && "hash" in row && typeof row.hash === "string") {
        referenced.add(row.hash);
      }
    }
  };

  // Tile references: the package record itself, its members, and the render
  // document an activation derived from it. The derived scene is tile content
  // like any other member — a sweep that did not know about it would delete the
  // geometry a published version is rendering.
  collect("SELECT source_hash AS hash FROM tile_packages");
  collect("SELECT hash FROM tile_package_members");
  collect(
    "SELECT scene_blob_hash AS hash FROM tile_activations WHERE scene_blob_hash IS NOT NULL",
  );

  // Everything else the shared store holds for a version. A tile sweep must not
  // delete a bundle that happens to hash the same as some member.
  collect("SELECT source_blob_hash AS hash FROM versions WHERE source_blob_hash IS NOT NULL");
  collect("SELECT bundle_hash AS hash FROM versions WHERE bundle_hash IS NOT NULL");
  collect(
    "SELECT gdb_source_blob_hash AS hash FROM versions WHERE gdb_source_blob_hash IS NOT NULL",
  );
  collect(
    "SELECT net_junctions_blob_hash AS hash FROM versions WHERE net_junctions_blob_hash IS NOT NULL",
  );
  collect("SELECT net_paths_blob_hash AS hash FROM versions WHERE net_paths_blob_hash IS NOT NULL");
  collect("SELECT facilities_blob_hash AS hash FROM versions WHERE facilities_blob_hash IS NOT NULL");

  return referenced;
}

/**
 * Release tile blobs nothing references any more.
 *
 * The rows are removed in one transaction, and the files are unlinked after it
 * commits. That order is deliberate: a failed unlink leaves an unreferenced file
 * on disk, which is waste, while the other order could leave a row pointing at
 * bytes that are already gone — a venue that serves 404s instead of geometry.
 */
export function collectTileBlobs(db: Database, blobs: BlobStore): TileCollectionReport {
  const released = db.transaction((): string[] => {
    const referenced = referencedHashes(db);
    const candidates: string[] = [];
    for (const row of db.prepare("SELECT hash FROM tile_blobs ORDER BY hash").all()) {
      if (row === null || typeof row !== "object" || !("hash" in row)) {
        continue;
      }
      const { hash } = row;
      // Only registered tile content is ever a candidate, and only when no
      // reference class claims it.
      if (typeof hash === "string" && !referenced.has(hash)) {
        candidates.push(hash);
      }
    }
    const deleteTileBlob = db.prepare("DELETE FROM tile_blobs WHERE hash = ?");
    const deleteBlob = db.prepare("DELETE FROM blobs WHERE hash = ?");
    for (const hash of candidates) {
      deleteTileBlob.run(hash);
      deleteBlob.run(hash);
    }
    return candidates;
  })();

  let bytes = 0;
  for (const hash of released) {
    bytes += blobs.remove(hash);
  }
  return { released: released.length, bytes, hashes: released };
}
