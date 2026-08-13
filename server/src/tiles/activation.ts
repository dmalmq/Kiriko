/**
 * Registration, gating, and producer activation of a tile package (#74).
 *
 * Three rules shape this module.
 *
 * **A gate is an answer, not an error.** Evaluating a package always produces a
 * record; the gates say whether it may render. A blocked package stays
 * inspectable on the venue, which is the whole point of evaluating before
 * activating — a bad export is the producer's problem to see, not a reviewer's
 * to discover.
 *
 * **An evaluation belongs to the geometry it measured.** It is stored against a
 * version *and* that version's bundle hash. Republishing changes the canonical
 * data registration was measured against, so the stored numbers stop describing
 * the venue and the activation is refused rather than quietly reused.
 *
 * **Activation publishes a version.** #30 section 6: correcting or replacing
 * tiles creates a new venue version. The descriptor is compiled into that
 * version's own §9, so the renderer reads activation state from the bundle it
 * is drawing — and no bytes change under a pinned, immutably-cached URL.
 */
import type { Database } from "better-sqlite3";
import type {
  RegistrationProfileInput,
  TileActivationEvaluation,
  TileActivationGate,
} from "../core/native";

/** The version an evaluation measures against: the venue's newest published. */
export interface EvaluationTarget {
  versionId: number;
  bundleHash: string;
  seq: number;
  sourceBlobHash: string;
  sourceKind: "imdf" | "gdb";
  gdbSourceBlobHash: string | null;
  gdbPlanJson: string | null;
  networkJunctionsBlobHash: string | null;
  networkPathsBlobHash: string | null;
  facilitiesBlobHash: string | null;
  synthesized: boolean;
}

interface TargetRow {
  versionId: number;
  bundleHash: string | null;
  seq: number;
  sourceBlobHash: string;
  sourceKind: string;
  gdbSourceBlobHash: string | null;
  gdbPlanJson: string | null;
  networkJunctionsBlobHash: string | null;
  networkPathsBlobHash: string | null;
  facilitiesBlobHash: string | null;
  synthesized: number;
}

/**
 * The venue's newest published version, with the inputs a republish needs.
 *
 * Activation reuses exactly these: the new version differs from the old only by
 * the tiles descriptor, which is what makes "the same venue data, now with an
 * activated package" true rather than aspirational.
 */
export function evaluationTarget(db: Database, venueId: number): EvaluationTarget | null {
  const row = db
    .prepare(
      `SELECT id AS versionId, bundle_hash AS bundleHash, seq AS seq,
              source_blob_hash AS sourceBlobHash, source_kind AS sourceKind,
              gdb_source_blob_hash AS gdbSourceBlobHash, gdb_plan_json AS gdbPlanJson,
              net_junctions_blob_hash AS networkJunctionsBlobHash,
              net_paths_blob_hash AS networkPathsBlobHash,
              facilities_blob_hash AS facilitiesBlobHash,
              synthesized AS synthesized
       FROM versions
       WHERE venue_id = ? AND status = 'published' AND bundle_hash IS NOT NULL
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(venueId) as TargetRow | undefined;
  if (row === undefined || row.bundleHash === null) {
    return null;
  }
  return {
    versionId: row.versionId,
    bundleHash: row.bundleHash,
    seq: row.seq,
    sourceBlobHash: row.sourceBlobHash,
    sourceKind: row.sourceKind === "gdb" ? "gdb" : "imdf",
    gdbSourceBlobHash: row.gdbSourceBlobHash,
    gdbPlanJson: row.gdbPlanJson,
    networkJunctionsBlobHash: row.networkJunctionsBlobHash,
    networkPathsBlobHash: row.networkPathsBlobHash,
    facilitiesBlobHash: row.facilitiesBlobHash,
    synthesized: row.synthesized === 1,
  };
}

export interface StoredEvaluation {
  id: number;
  packageId: number;
  evaluatedVersionId: number;
  evaluatedBundleHash: string;
  profileId: string;
  profileVersion: number;
  capabilityProfile: string | null;
  evaluation: TileActivationEvaluation;
  state: "evaluated" | "activated";
  evaluatedAt: string;
  /** Null exactly while `state` is `evaluated`; the table's own CHECK enforces it. */
  activatedAt: string | null;
}

interface EvaluationRow {
  id: number;
  packageId: number;
  evaluatedVersionId: number;
  evaluatedBundleHash: string;
  profileId: string;
  profileVersion: number;
  capabilityProfile: string | null;
  profileJson: string;
  reportJson: string;
  gatesJson: string;
  state: string;
  evaluatedAt: string;
  activatedAt: string | null;
}

/**
 * Record an evaluation, replacing any earlier one for the same package and
 * version. Re-evaluating is how a producer checks a corrected profile, so it
 * overwrites rather than accumulating rows nobody can choose between.
 */
export function storeEvaluation(
  db: Database,
  input: {
    packageId: number;
    target: EvaluationTarget;
    profile: RegistrationProfileInput;
    capabilityProfile: string | null;
    evaluation: TileActivationEvaluation;
    evaluatedBy: number;
  },
): boolean {
  const result = db.prepare(
    `INSERT INTO tile_activations
       (package_id, evaluated_version_id, evaluated_bundle_hash, profile_id, profile_version,
        profile_json, capability_profile, report_json, gates_json, state, evaluated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'evaluated', ?)
     ON CONFLICT (package_id, evaluated_version_id) DO UPDATE SET
       evaluated_bundle_hash = excluded.evaluated_bundle_hash,
       profile_id = excluded.profile_id,
       profile_version = excluded.profile_version,
       profile_json = excluded.profile_json,
       capability_profile = excluded.capability_profile,
       report_json = excluded.report_json,
       gates_json = excluded.gates_json,
       state = 'evaluated',
       evaluated_at = datetime('now'),
       evaluated_by = excluded.evaluated_by,
       activated_at = NULL,
       activated_by = NULL,
       activated_version_id = NULL
     WHERE tile_activations.state = 'evaluated'
       AND tile_activations.activating_version_id IS NULL`,
  ).run(
    input.packageId,
    input.target.versionId,
    input.target.bundleHash,
    input.evaluation.report.profileId,
    input.evaluation.report.profileVersion,
    JSON.stringify(input.profile),
    input.capabilityProfile,
    JSON.stringify(input.evaluation.report),
    JSON.stringify(input.evaluation.gates),
    input.evaluatedBy,
  );
  return result.changes === 1;
}

/** The newest evaluation of this package, whichever version it measured. */
export function findEvaluation(db: Database, packageId: number): StoredEvaluation | null {
  const row = db
    .prepare(
      `SELECT id, package_id AS packageId, evaluated_version_id AS evaluatedVersionId,
              evaluated_bundle_hash AS evaluatedBundleHash, profile_id AS profileId,
              profile_version AS profileVersion, capability_profile AS capabilityProfile,
              profile_json AS profileJson, report_json AS reportJson, gates_json AS gatesJson,
              state, evaluated_at AS evaluatedAt, activated_at AS activatedAt
       FROM tile_activations
       WHERE package_id = ?
       ORDER BY evaluated_version_id DESC LIMIT 1`,
    )
    .get(packageId) as EvaluationRow | undefined;
  if (row === undefined) {
    return null;
  }
  const report = JSON.parse(row.reportJson) as TileActivationEvaluation["report"];
  const gates = JSON.parse(row.gatesJson) as TileActivationGate[];
  return {
    id: row.id,
    packageId: row.packageId,
    evaluatedVersionId: row.evaluatedVersionId,
    evaluatedBundleHash: row.evaluatedBundleHash,
    profileId: row.profileId,
    profileVersion: row.profileVersion,
    capabilityProfile: row.capabilityProfile,
    state: row.state === "activated" ? "activated" : "evaluated",
    evaluatedAt: row.evaluatedAt,
    activatedAt: row.activatedAt,
    evaluation: {
      report,
      gates,
      floorMappings: report.floors.map((floor) => [
        floor.canonicalLevelId,
        floor.compositeSourceLevels,
      ]),
    },
  };
}

/**
 * Reserve the immutable evaluation snapshot for the publication version that
 * will consume it. Called inside the version/job enqueue transaction.
 */
export function reserveActivation(
  db: Database,
  evaluationId: number,
  activatingVersionId: number,
  activatingBy: number,
): boolean {
  const result = db.prepare(
    `UPDATE tile_activations
     SET activating_version_id = ?, activating_by = ?, activating_at = datetime('now')
     WHERE id = ? AND state = 'evaluated' AND activating_version_id IS NULL`,
  ).run(activatingVersionId, activatingBy, evaluationId);
  return result.changes === 1;
}

/** Release a failed publication without touching the evaluation evidence. */
export function releaseActivation(
  db: Database,
  evaluationId: number,
  activatingVersionId: number,
): boolean {
  const result = db.prepare(
    `UPDATE tile_activations
     SET activating_version_id = NULL, activating_by = NULL, activating_at = NULL
     WHERE id = ? AND state = 'evaluated' AND activating_version_id = ?`,
  ).run(evaluationId, activatingVersionId);
  return result.changes === 1;
}

/**
 * Bind an evaluation to the immutable version its activation produced, and to
 * the render document derived for it.
 *
 * One statement, because a version bound to a package with no derived scene
 * would serve tiles nothing can draw.
 */
export function markActivated(
  db: Database,
  evaluationId: number,
  activatedVersionId: number,
  activatedBy: number,
  sceneBlobHash: string,
): void {
  const result = db.prepare(
    `UPDATE tile_activations
     SET state = 'activated', activated_at = datetime('now'),
         activated_by = ?, activated_version_id = ?, scene_blob_hash = ?,
         activating_version_id = NULL, activating_by = NULL, activating_at = NULL,
         -- The same act and the same person: activating *is* asserting the
         -- mapping, and the route refuses without the assertion. Stored so the
         -- later question is "who checked, against which report" rather than
         -- "was a box ticked".
         mapping_confirmed_at = datetime('now'), mapping_confirmed_by = ?
     WHERE id = ? AND state = 'evaluated' AND activating_version_id = ?`,
  ).run(activatedBy, activatedVersionId, sceneBlobHash, activatedBy, evaluationId, activatedVersionId);
  if (result.changes !== 1) {
    throw new Error("tile activation reservation was lost");
  }
}

/**
 * The §9 descriptor an activation compiles into its version.
 *
 * The profile identity is `id@version`: a published activation is judged by the
 * profile it was activated under, and a bare id would let a later revision of
 * the same profile claim credit for numbers it never produced.
 */
export function descriptorFor(
  evaluation: StoredEvaluation,
  packageHash: string,
  manifestHash: string,
): string {
  return JSON.stringify({
    packageHash,
    manifestHash,
    activationState: "activated",
    registrationProfileId: `${evaluation.profileId}@${evaluation.profileVersion}`,
    floorMappings: evaluation.evaluation.floorMappings.map(
      ([canonicalLevelId, compositeSourceLevels]) => ({
        canonicalLevelId,
        compositeSourceLevels,
      }),
    ),
    sourceObjectAssociations: [],
    contextualClassifications: [],
  });
}
