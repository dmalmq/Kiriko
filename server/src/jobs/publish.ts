import type Database from "better-sqlite3";
import type { BlobStore } from "../blobs/store";
import { compileVenueBundle, CoreCompileError, CoreExportError, exportVenueNetwork, type CompileVenueMetadata } from "../core/native";

/** Persisted into `versions.error` (and mirrored into `jobs.error`) verbatim as JSON. */
interface StructuredError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Thrown when the version row identified by `versionId` no longer matches
 * the identity snapshot taken before compilation started — e.g. its venue
 * was deleted (cascading the version row) and a fresh row was inserted
 * while the long `await compile` was in flight. SQLite reuses a freed
 * INTEGER PRIMARY KEY rowid once the table's max rowid row is gone, so
 * `versionId` alone is never a safe target across that await. Never a
 * genuine compile/domain failure.
 */
class StaleVersionError extends Error {
  constructor(versionId: number) {
    super(`version ${versionId} was replaced during compilation`);
    this.name = "StaleVersionError";
  }
}

/** Thrown when a synthesize request compiles a bundle with no §5 graph. */
class NoRoutableNetworkError extends Error {}

function staleVersionError(versionId: number): StructuredError {
  return { code: "stale_version", message: `version ${versionId} was replaced during compilation` };
}

function toStructuredError(error: unknown): StructuredError {
  if (error instanceof CoreCompileError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof StaleVersionError) {
    return { code: "stale_version", message: error.message };
  }
  if (error instanceof NoRoutableNetworkError) {
    return {
      code: "no_routable_network",
      message: "No routable space found. Check that walkable units (walkway, platform, etc.) are mapped.",
    };
  }
  return { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
}

interface PublishRow {
  id: number;
  venueId: number;
  seq: number;
  publicId: string;
  hash: string;
  status: string;
  tenantSlug: string;
  venueSlug: string;
}

type PublishCompileFn = typeof compileVenueBundle;

export function makePublishRunner(
  db: Database.Database,
  blobs: BlobStore,
  compile: PublishCompileFn = compileVenueBundle,
) {
  return async (payloadJson: string): Promise<{ versionId: number }> => {
    const { versionId, networkJunctionsHash, networkPathsHash, facilitiesGeoJsonHash, synthesizeNetwork } =
      JSON.parse(payloadJson) as {
        versionId: number;
        networkJunctionsHash?: string;
        networkPathsHash?: string;
        facilitiesGeoJsonHash?: string;
        synthesizeNetwork?: boolean;
      };
    const version = db
      .prepare(
        `SELECT vr.id AS id, vr.venue_id AS venueId, vr.seq AS seq, vr.public_id AS publicId,
                vr.source_blob_hash AS hash, vr.status AS status,
                t.slug AS tenantSlug, v.slug AS venueSlug
         FROM versions vr
         JOIN venues v ON v.id = vr.venue_id
         JOIN tenants t ON t.id = v.tenant_id
         WHERE vr.id = ?`,
      )
      .get(versionId) as PublishRow | undefined;
    if (!version) {
      throw new Error(`version ${versionId} not found`);
    }

    // Identity snapshot taken *before* the long `await compile`. Every
    // write below requires exactly one changed row against this permanent
    // public identity and the rest of the exact version/dataset tuple. A
    // replacement row may reuse SQLite numeric ids and all mutable values,
    // but it can never reuse `public_id`. Any mismatch means the stale
    // compile neither publishes onto nor marks failed the replacement row.
    const identityWhere = `
      id = ? AND public_id = ? AND venue_id = ? AND seq = ? AND source_blob_hash = ? AND status = ?
      AND EXISTS (
        SELECT 1 FROM venues v JOIN tenants t ON t.id = v.tenant_id
        WHERE v.id = venue_id AND v.slug = ? AND t.slug = ?
      )
    `;
    const identityParams = [
      version.id,
      version.publicId,
      version.venueId,
      version.seq,
      version.hash,
      version.status,
      version.venueSlug,
      version.tenantSlug,
    ] as const;

    try {
      const source = blobs.read(version.hash);
      const metadata: CompileVenueMetadata = {
        datasetId: `${version.tenantSlug}/${version.venueSlug}`,
        version: version.seq,
      };
      // A combined GDB import stores the extracted network/facilities
      // GeoJSON as blobs and references them from the job payload; a plain
      // publish carries no optional hashes and compiles exactly as before.
      if (networkJunctionsHash !== undefined && networkPathsHash !== undefined) {
        metadata.networkJunctionsGeoJson = blobs.read(networkJunctionsHash).toString("utf8");
        metadata.networkPathsGeoJson = blobs.read(networkPathsHash).toString("utf8");
      }
      if (facilitiesGeoJsonHash !== undefined) {
        metadata.facilitiesGeoJson = blobs.read(facilitiesGeoJsonHash).toString("utf8");
      }
      // A synthesize job carries no network hashes; instead it asks the
      // compiler to derive a routing graph from the venue's own geometry.
      if (synthesizeNetwork === true) {
        metadata.synthesizeNetwork = true;
      }
      const { bundle, stats } = await compile(source, metadata);
      if (synthesizeNetwork === true) {
        try {
          await exportVenueNetwork(bundle);
        } catch (error) {
          if (error instanceof CoreExportError && error.code === "no_graph") {
            throw new NoRoutableNetworkError("synthesized graph is empty");
          }
          throw error;
        }
      }
      // Content-addressed: safe to persist even if this row turns out to
      // be stale below — the blob then simply has no referencing row.
      const { hash: bundleHash, size } = blobs.put(bundle);
      const published = db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)").run(bundleHash, size);
        const result = db
          .prepare(
            `UPDATE versions SET status = 'published', bundle_hash = ?, stats_json = ?, error = NULL
             WHERE ${identityWhere}`,
          )
          .run(bundleHash, JSON.stringify(stats), ...identityParams);
        return result.changes === 1;
      })();
      if (!published) {
        throw new StaleVersionError(version.id);
      }
      return { versionId };
    } catch (error) {
      // Domain (invalid IMDF), bridge (native/FFI), blob-store, DB, and
      // stale-identity failures all land here. The failure write is
      // scoped by the same identity predicate as the success write, and
      // its own `changes` count is inspected too: if this exact row is
      // *also* gone by the time we try to record the failure (a genuine
      // compile error racing a concurrent delete+recreate), the row is
      // left untouched and the job is reported `stale_version` rather
      // than the original — now meaningless — compiler/domain code.
      const candidate = toStructuredError(error);
      const result = db
        .prepare(`UPDATE versions SET status = 'failed', bundle_hash = NULL, error = ? WHERE ${identityWhere}`)
        .run(JSON.stringify(candidate), ...identityParams);
      const structured = result.changes === 1 ? candidate : staleVersionError(version.id);
      throw new Error(JSON.stringify(structured));
    }
  };
}
