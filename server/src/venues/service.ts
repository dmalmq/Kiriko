import type Database from "better-sqlite3";

export interface VersionStats {
  levels: number;
  features: number;
}

export interface VenueRow {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
}

export interface VenueSummary extends VenueRow {
  latest: {
    seq: number;
    publicVersionId: string;
    status: string;
    stats: VersionStats | null;
    createdAt: string;
  } | null;
  editableMapping: boolean;
  hasNetwork: boolean;
  hasGraph: boolean;
}

/** ASCII-only slug; non-latin names fall back to "venue". */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base !== "" ? base : "venue";
}

export function createVenue(
  db: Database.Database,
  tenantId: number,
  name: string,
  userId: number,
): VenueRow {
  const base = slugify(name);
  for (let n = 1; ; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    try {
      const info = db
        .prepare("INSERT INTO venues (tenant_id, slug, name, created_by) VALUES (?, ?, ?, ?)")
        .run(tenantId, slug, name, userId);
      const row = db
        .prepare("SELECT id, slug, name, created_at AS createdAt FROM venues WHERE id = ?")
        .get(info.lastInsertRowid) as VenueRow;
      return row;
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") {
        throw error;
      }
    }
  }
}

export function listVenues(db: Database.Database, tenantId: number): VenueSummary[] {
  const venues = db
    .prepare(
      "SELECT id, slug, name, created_at AS createdAt FROM venues WHERE tenant_id = ? ORDER BY created_at DESC, id DESC",
    )
    .all(tenantId) as VenueRow[];
  const latestStmt = db.prepare(
    `SELECT seq, public_id AS publicId, status, stats_json AS statsJson, created_at AS createdAt
     FROM versions WHERE venue_id = ? AND status = 'published'
     ORDER BY seq DESC LIMIT 1`,
  );
  const gdbStmt = db.prepare(
    "SELECT 1 AS x FROM versions WHERE venue_id = ? AND gdb_source_blob_hash IS NOT NULL LIMIT 1",
  );
  const networkStmt = db.prepare(
    `SELECT net_junctions_blob_hash AS j, synthesized AS syn FROM versions
     WHERE venue_id = ? AND status = 'published' ORDER BY seq DESC LIMIT 1`,
  );
  return venues.map((venue) => {
    const net = networkStmt.get(venue.id) as { j: string | null; syn: number } | undefined;
    const hasNetwork = net?.j != null;
    const latest = latestStmt.get(venue.id) as
      | { seq: number; publicId: string; status: string; statsJson: string | null; createdAt: string }
      | undefined;
    return {
      ...venue,
      latest: latest
        ? {
            seq: latest.seq,
            publicVersionId: latest.publicId,
            status: latest.status,
            stats: latest.statsJson ? (JSON.parse(latest.statsJson) as VersionStats) : null,
            createdAt: latest.createdAt,
          }
        : null,
      editableMapping: gdbStmt.get(venue.id) !== undefined,
      hasNetwork,
      hasGraph: hasNetwork || net?.syn === 1,
    };
  });
}

export interface DeleteVenueResult {
  deleted: boolean;
  publicVersionIds: string[];
}

export function deleteVenue(
  db: Database.Database,
  tenantId: number,
  venueId: number,
): DeleteVenueResult {
  const selectPublicIds = db.prepare(
    `SELECT v.public_id AS publicVersionId
     FROM versions v
     JOIN venues venue ON venue.id = v.venue_id
     WHERE venue.id = ? AND venue.tenant_id = ?
     ORDER BY v.seq, v.id`,
  );
  const removeVenue = db.prepare("DELETE FROM venues WHERE id = ? AND tenant_id = ?");
  return db.transaction(() => {
    const rows = selectPublicIds.all(venueId, tenantId) as Array<{ publicVersionId: string }>;
    const info = removeVenue.run(venueId, tenantId);
    return {
      deleted: info.changes > 0,
      publicVersionIds: info.changes > 0 ? rows.map((row) => row.publicVersionId) : [],
    };
  })();
}
