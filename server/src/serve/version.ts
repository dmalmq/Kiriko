/**
 * Resolving a published version for public serving.
 *
 * Every public serving route goes through this one query, which is the whole
 * point: a tile member must be reachable exactly when its version's bundle is
 * reachable, and never otherwise. If the two routes each carried their own
 * notion of "published", a change to one would silently open or close the other.
 * Access policy is inherited here, structurally, not remembered in two places.
 */
import type Database from "better-sqlite3";

export interface PublishedVersion {
  /** Row id, for joining to version-scoped assets. */
  id: number;
  /** Bundle bytes, absent only for a version published before bundles existed. */
  bundleHash: string | null;
  /** Permanent 64-hex identity — never the reusable numeric seq. */
  publicId: string;
  seq: number;
}

/**
 * The published version of a venue: the newest, or the specific one pinned by
 * `publicId`. Returns `null` when the tenant, venue, or version does not exist,
 * or when the version is not published — a draft, archived, or failed version is
 * not public, and that single rule is what both serving routes obey.
 */
export function findPublishedVersion(
  db: Database.Database,
  tenantSlug: string,
  venueSlug: string,
  publicId: string | null,
): PublishedVersion | null {
  const row = db
    .prepare(
      `SELECT vr.id AS id, vr.bundle_hash AS bundleHash, vr.public_id AS publicId, vr.seq AS seq
       FROM versions vr
       JOIN venues v ON v.id = vr.venue_id
       JOIN tenants t ON t.id = v.tenant_id
       WHERE t.slug = ? AND v.slug = ? AND vr.status = 'published'
         AND (? IS NULL OR vr.public_id = ?)
       ORDER BY vr.seq DESC LIMIT 1`,
    )
    .get(tenantSlug, venueSlug, publicId, publicId) as
    | { id: number; bundleHash: string | null; publicId: string; seq: number }
    | undefined;
  return row ?? null;
}
