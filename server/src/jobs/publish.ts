import type Database from "better-sqlite3";
import type { BlobStore } from "../blobs/store";
import { compileVenueBundle, CoreCompileError, CoreExportError, exportVenueNetwork, type CompileVenueMetadata } from "../core/native";
import { attachPackageToVersion } from "../tiles/storage";
import { markActivated } from "../tiles/activation";

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

class ShutdownAbortError extends Error {
  constructor() {
    super("publication job aborted by shutdown");
    this.name = "ShutdownAbortError";
  }
}

function throwIfShutdownAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ShutdownAbortError();
  }
}

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
): (payloadJson: string, signal?: AbortSignal) => Promise<{ versionId: number }> {
  return async (payloadJson: string, signal = new AbortController().signal): Promise<{ versionId: number }> => {
    const {
      versionId,
      networkJunctionsHash,
      networkPathsHash,
      facilitiesGeoJsonHash,
      synthesizeNetwork,
      clipToSelection,
      tilesDescriptorJson,
      tilePackageId,
      tileActivationEvaluationId,
      tileActivatedBy,
      tileSceneBlobHash,
    } = JSON.parse(payloadJson) as {
      versionId: number;
      networkJunctionsHash?: string;
      networkPathsHash?: string;
      facilitiesGeoJsonHash?: string;
      synthesizeNetwork?: boolean;
      clipToSelection?: boolean;
      tilesDescriptorJson?: string;
      tilePackageId?: number;
      tileActivationEvaluationId?: number;
      tileActivatedBy?: number;
      tileSceneBlobHash?: string;
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
      throwIfShutdownAborted(signal);
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
      // A building-scoped GDB import asks the compiler to drop network nodes
      // and facilities outside the buildings that were actually imported.
      if (clipToSelection === true) {
        metadata.clipToVenue = true;
      }
      // An activation publishes a version that differs from its predecessor by
      // exactly this: the §9 descriptor naming the package it renders.
      if (tilesDescriptorJson !== undefined) {
        metadata.tilesDescriptorJson = tilesDescriptorJson;
      }
      throwIfShutdownAborted(signal);
      const { bundle, stats } = await compile(source, metadata);
      throwIfShutdownAborted(signal);
      if (synthesizeNetwork === true) {
        try {
          await exportVenueNetwork(bundle);
        } catch (error) {
          if (error instanceof CoreExportError) {
            if (error.code === "no_graph") {
              throw new NoRoutableNetworkError("synthesized graph is empty");
            }
            if (error.code === "fractional_ordinal") {
              // The synthesized graph is present and routable; only GDB export
              // cannot label fractional IMDF ordinals such as mezzanines.
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }
      throwIfShutdownAborted(signal);
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
        if (result.changes === 1 && tilePackageId !== undefined) {
          // Bound in the same transaction that publishes: a version whose §9
          // names a package must reference it, or collection would be free to
          // delete the geometry it is about to serve.
          attachPackageToVersion(db, versionId, tilePackageId);
          if (
            tileActivationEvaluationId === undefined
            || tileActivatedBy === undefined
            || tileSceneBlobHash === undefined
          ) {
            throw new Error("tile activation metadata is incomplete");
          }
          // Activation becomes historical fact only when the version serving
          // it becomes public. A failed or interrupted compilation leaves the
          // evaluation available for a clean retry.
          markActivated(
            db,
            tileActivationEvaluationId,
            versionId,
            tileActivatedBy,
            tileSceneBlobHash,
          );
        }
        return result.changes === 1;
      })();
      if (!published) {
        throw new StaleVersionError(version.id);
      }
      return { versionId };
    } catch (error) {
      if (error instanceof ShutdownAbortError) {
        throw error;
      }
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
