/**
 * The tile-package shapes the producer surface reads (#80).
 *
 * These mirror `server/src/core/native.ts` field for field, because the routes
 * pass the Rust core's report through untouched. They are kept here rather than
 * in `api.ts` so the report's twelve interfaces do not crowd a module that
 * already carries auth, venues, issues, and GDB.
 *
 * Nothing here interprets a measurement. Every number is the core's, and the
 * dialog's job is to print it beside the band it is judged against — the
 * producer decides what it means.
 */
import type { TileActivationGate } from "./tileGates";

export type { TileActivationGate };

/** Residual distribution over the samples taken for one floor, or the venue. */
export interface ResidualStats {
  samples: number;
  p50M: number;
  p90M: number;
  maxM: number;
}

/**
 * One tile level as the package declares it, and what its surfaces resolved to.
 *
 * `resolvedPlaneM` comes from the tile geometry; `metadataElevationM` is what the
 * export claimed. They disagree in real assets — by 3.02 m repeatably at KITTE
 * (#31) — and `metadataDifferenceM` is that disagreement, kept as provenance
 * rather than silently resolved.
 */
export interface TileLevelRegistration {
  compositeId: string;
  sourceDocument: string;
  sourceLinkName: string;
  levelKey: string;
  levelName: string;
  quantizedElevationDm: number;
  metadataElevationM: number;
  /** Null when the level exposes no walkable surface to measure. */
  resolvedPlaneM: number | null;
  metadataDifferenceM: number | null;
  surfaceTriangles: number;
  sourceObjectIds: string[];
  opaqueSourceObjectIds: string[];
  /**
   * The canonical floor this level matched, and that floor's own plane.
   *
   * This pair is the one decision in the report geometry cannot settle. A stack
   * offset by roughly a storey maps every level to its neighbour, and where
   * footprints repeat — station platforms, concourses — the residuals against the
   * wrong floor measure as small as against the right one. So both planes are put
   * in front of the producer, who confirms the mapping before activating.
   */
  mappedCanonicalLevelId: string | null;
  mappedFloorPlaneM: number | null;
  /**
   * The corroboration altitude cannot supply (#81): whether this level's own
   * label names the floor it was matched to.
   *
   * `unknown` means two exports share no naming convention — the absence of a
   * check, which must never be shown as a passed one.
   */
  labelAgreement: "agrees" | "contradicts" | "unknown";
}

/** A localised cluster of residuals pointing the same way: registration, not noise. */
export interface CoherentCluster {
  eastM: number;
  northM: number;
  samples: number;
  offsetM: [number, number];
  distanceM: number;
}

export interface FloorRegistration {
  canonicalLevelId: string;
  compositeSourceLevels: string[];
  sampled: number;
  carvedOut: number;
  /** `null` when no sample survived the carve-out — never a row of zeroes. */
  stats: ResidualStats | null;
  medianOffsetM: [number, number];
  medianShiftM: number;
  coherentClusters: CoherentCluster[];
}

export interface TileRegistrationReport {
  profileId: string;
  profileVersion: number;
  levels: TileLevelRegistration[];
  floors: FloorRegistration[];
  /** Levels no canonical floor claims. #74 fails the gate rather than guessing. */
  unmappedLevels: string[];
  /** Levels with more than one candidate floor inside the match tolerance. */
  ambiguousLevels: string[];
  appliedVerticalOffsetM: number;
  /**
   * Every surviving sample across every floor; `null` when there were none.
   * Absence lives in the type so no view can print it as a clean measurement.
   */
  venueWide: ResidualStats | null;
}

/** The registration profile a producer may override, field for field. */
export interface RegistrationProfileInput {
  /** Added to tile planes before matching — a producer decision, never inferred. */
  verticalOffsetM?: number;
  /** Per-canonical-floor p90 bands: no single number describes an asset. */
  floorP90MaxM?: Record<string, number>;
}

/** One accepted member of an ingested package. */
export interface TileMember {
  path: string;
  hash: string;
  byteSize: number;
  contentType: string;
  kind: string;
  /** The store already held these bytes: a second upload of a shared asset. */
  reused: boolean;
}

/** What ingestion accepted, as `POST .../tiles/inspect` reports it. */
export interface TilePackageAccepted {
  packageId: number;
  sourceHash: string;
  rootTileset: string;
  assetVersions: string[];
  extensions: string[];
  /** Archive entries the URI graph never references: usually an export mistake. */
  ignored: string[];
  totalBytes: number;
  members: TileMember[];
}

/** A stored evaluation, as the list and the registration route report it. */
export interface TileEvaluation {
  state: "evaluated" | "activated";
  /**
   * Whether the evaluation still describes the geometry it measured. The server
   * computes it with the same comparison `activate` refuses with
   * `evaluation_stale`; the client must never re-derive it.
   */
  current: boolean;
  capabilityProfile: string | null;
  profileId: string;
  profileVersion: number;
  report: TileRegistrationReport;
  gates: TileActivationGate[];
  evaluatedAt: string;
  activatedAt: string | null;
}

/** One package of a venue, as `GET /api/venues/:id/tiles` reports it. */
export interface TilePackageListEntry {
  packageId: number;
  sourceHash: string;
  rootTileset: string;
  assetVersions: string[];
  extensions: string[];
  ignored: string[];
  totalBytes: number;
  memberCount: number;
  createdAt: string;
  /** Null until registration has run: not the same as measuring badly. */
  evaluation: TileEvaluation | null;
  /** A published version serves this package. */
  serving: boolean;
}

/** What one registration run returns. `state` is always `"evaluated"`. */
export interface TileEvaluationResult {
  state: string;
  report: TileRegistrationReport;
  floorMappings: [string, string[]][];
  gates: TileActivationGate[];
}

/** Activation is asynchronous: it publishes a version through the job queue. */
export interface TileActivationAccepted {
  jobId: string;
  versionId: number;
  seq: number;
}
