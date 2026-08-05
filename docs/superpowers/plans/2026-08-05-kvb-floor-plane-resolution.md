# KVB Floor-Plane Resolution (§8 level records) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Record where every floor's plane sits vertically — resolved scene Z as checked integer millimetres, the method that produced it (imported elevation / preserved network altitude / nominal spacing), a confidence value, and registry evidence references — inside the §8 spatial context section. Adds `LevelRecord`s to the §8 schema and a deterministic resolution pass to the compile path.

**Architecture:** Resolution is pure + deterministic and lives in a new `kiriko-bundle` module (`resolve.rs`): given the venue levels, per-level explicit elevations, per-ordinal network altitudes, and a versioned `ResolutionProfile`, it applies the precedence and returns per-level records plus the vertical normalisation offset. Canonical types extend `kiriko-model::spatial` (`LevelRecord`, `ResolutionMethod`, `SpatialContext.levels`, `RegistrationEvidence.assumption_ref`, new `EvidenceMethod` variants); postcard DTOs + validation extend `spatial_section.rs`. Network altitudes come from `kiriko-route`'s `RouteGraphBuild`, which gains `node_altitudes` (parsed from the `altitude` junction property, aligned with `node_ids`) — **`RouteGraph` and §5's byte schema are unchanged** (the #36 constraint). The compile path resolves planes, assembles registry entries, and sets `frame.vertical_normalisation_offset_mm` so the lowest resolved plane lands at scene Z 0.

**Tech Stack:** Rust (kiriko-route, kiriko-model, kiriko-bundle, postcard), cargo test, the bundle integration suite.

## Global Constraints

- TDD: no production code without a failing test first. Watch each test fail for the right reason.
- Commit per logical change, on `feat/kvb-floor-planes` (based on `feat/kvb-spatial-context`, which is #38's unmerged work — #39's real base).
- **§5's byte schema is unchanged.** `RouteNode`/`RouteGraph` untouched; altitudes ride on `RouteGraphBuild` only, which the codec never serializes.
- Determinism: identical canonical inputs compile byte-identically. `f64 → mm` is `(x * 1000.0).round()` (round half away from zero), applied once; registry append order is fixed.
- The golden fixture `minimal.kvb` changes bytes again (levels + offset in §8) — regenerate with the `compile_fixture` example, update `GOLDEN_BUNDLE_HASH` (Rust + server test).
- No TS/client surface change: the report shape is unchanged; the wasm test's capability expectation is unchanged.
- Verification gates: `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

---

### Task 1: kiriko-route `node_altitudes`

**Files:**
- Modify: `core/crates/kiriko-route/src/build.rs`
- Test: `build.rs` unit tests

**Change:** `RouteGraphBuild` gains `pub node_altitudes: Vec<Option<f64>>` (parallel to `node_ids`/`nodes`). Junction parsing reads the `altitude` property: `prop(&feature.properties, "altitude").and_then(|v| v.as_f64())` — a junction without an `altitude` property contributes `None` (a present numeric value contributes `Some`; the JSON parser already rejects non-finite numbers). `node_altitudes[i]` is the altitude of `graph.nodes[i]`.

- [x] **Step 1 (RED):** test `node_altitudes_are_parsed_and_aligned_with_nodes` — build a graph from junctions where one has `altitude: 12.5`, one has none, one has `altitude: 0`; assert `node_altitudes` = `[Some(12.5), None, Some(0.0)]` in NODEID order, aligned with `node_ids`.
- [x] **Step 2:** run — fails to compile (`node_altitudes` missing).
- [x] **Step 3 (GREEN):** add the field, parse `altitude`, collect parallel to `node_ids`.
- [x] **Step 4:** `cargo test --manifest-path core/Cargo.toml -p kiriko-route` — pass.
- [x] **Step 5:** commit `feat(kiriko-route): carry junction altitudes on the graph build`

---

### Task 2: kiriko-model §8 canonical extensions

**Files:**
- Modify: `core/crates/kiriko-model/src/spatial.rs`
- Test: unit tests in `spatial.rs`

**Schema additions (exact):**

```rust
/// How a level's floor plane was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionMethod {
    /// An explicit imported or trusted mapped elevation won.
    ImportedElevation,
    /// A preserved routing-network altitude won (validated, trustworthy).
    NetworkAltitude,
    /// Configurable nominal floor spacing was assumed.
    NominalSpacing,
}

/// One canonical level's resolved floor plane, referencing the §8 registries.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelRecord {
    pub level_id: String,
    pub ordinal: f64,
    /// Original source elevation (metres), full precision, when one exists.
    pub source_elevation_m: Option<f64>,
    /// Preserved network altitude minus imported elevation (checked integer
    /// millimetres), when both existed — never silently overwrites either.
    pub network_difference_mm: Option<i64>,
    /// Resolved floor-plane scene Z, checked integer millimetres,
    /// non-negative (offset normalised so the lowest plane is 0).
    pub resolved_scene_z_mm: i64,
    pub method: ResolutionMethod,
    /// Index into `Registries::confidence`.
    pub confidence_ref: u32,
    /// Indices into `Registries::registration_evidence`.
    pub evidence_refs: Vec<u32>,
}
```

- `SpatialContext` gains `pub levels: Vec<LevelRecord>` (order = the venue model's level order; deterministic).
- `RegistrationEvidence` gains `pub assumption_ref: Option<u32>` (→ `Registries::assumptions`).
- `EvidenceMethod` gains `ImportedElevation`, `PreservedNetworkAltitude`, `NominalSpacing`.

- [x] **Step 1 (RED):** tests — construct a `LevelRecord` with evidence refs; construct `SpatialContext` with levels; `EvidenceMethod` variants exist; `RegistrationEvidence { assumption_ref: Some(0) }` constructs.
- [x] **Step 2:** run — fails to compile.
- [x] **Step 3 (GREEN):** add the types/fields.
- [x] **Step 4:** `cargo test --manifest-path core/Cargo.toml -p kiriko-model` — pass.
- [x] **Step 5:** commit `feat(kiriko-model): level records and resolution method for §8`

---

### Task 3: spatial_section DTOs + level validation

**Files:**
- Modify: `core/crates/kiriko-bundle/src/spatial_section.rs`
- Test: unit tests in `spatial_section.rs`

**Change:** DTOs mirror `LevelRecord`/`ResolutionMethod`; `RegistrationEvidenceDto` gains `assumption_ref: Option<u32>`; `SpatialContextSectionDto` gains `levels: Vec<LevelRecordDto>`. Conversions apply `canonical_f64` to `ordinal`/`source_elevation_m`. Validation additions (both paths):

- `levels.len() ≤ MAX_REGISTRY_LEN`; `level_id` string ≤ `MAX_STRING_LEN` (empty ids rejected? — no, bounded only).
- `ordinal` finite (canonical_f64), `source_elevation_m` finite when present.
- `resolved_scene_z_mm ≥ 0` and `≤ MAX_VERTICAL_OFFSET_MM`; `network_difference_mm` `|v| ≤ MAX_VERTICAL_OFFSET_MM` when present.
- `confidence_ref < confidence.len()`; every `evidence_ref < registration_evidence.len()`; `evidence_refs.len() ≤ MAX_REGISTRY_LEN`.
- `assumption_ref < assumptions.len()` when `Some`.

- [x] **Step 1 (RED):** tests — a context with a valid level record round-trips; `resolved_scene_z_mm = -1` rejected; out-of-range `confidence_ref` rejected; out-of-range evidence ref rejected; out-of-range `assumption_ref` rejected; negative `network_difference_mm` allowed within bounds, `1_000_000_001` rejected.
- [x] **Step 2:** run — fails to compile.
- [x] **Step 3 (GREEN):** DTOs, conversions, validation.
- [x] **Step 4:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle spatial_section` — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): §8 level record DTOs with bounded validation`

---

### Task 4: resolve.rs — profile + precedence resolution

**Files:**
- Create: `core/crates/kiriko-bundle/src/resolve.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs` (`mod resolve; pub use resolve::{ResolutionProfile, resolve_level_planes, ...};` — the profile type is part of `compile_imdf_with_network`'s public signature)
- Test: unit tests in `resolve.rs`

**Interfaces (exact):**

```rust
/// Versioned resolution profile: the configurable mappings, tolerances, and
/// defaults the resolution pass applies. Never a global constant.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolutionProfile {
    pub profile_version: u32,
    /// Source-property key the explicit elevation is read from (the "trusted
    /// mapped elevation field").
    pub elevation_property_key: String,       // default "elevation"
    pub nominal_floor_spacing_m: f64,         // default 4.0
    /// A level's network altitude needs at least this many junction
    /// altitudes to be trustworthy.
    pub network_min_nodes_per_level: usize,   // default 3
    /// Max spread (max − min) of a level's junction altitudes for the
    /// network source to be trustworthy, metres.
    pub network_altitude_tolerance_m: f64,    // default 1.0
}

impl Default for ResolutionProfile { /* the versioned default profile, v1 */ }

/// Per-level resolution inputs: the explicit elevation parsed from the level
/// feature's `source_properties[elevation_property_key]`.
pub(crate) type LevelElevations = BTreeMap<String, f64>; // level id → metres

/// Per-ordinal network junction altitudes (metres), from
/// `RouteGraphBuild.node_altitudes` grouped by node ordinal.
pub(crate) type NetworkAltitudes = BTreeMap<f64, Vec<f64>>;

pub(crate) struct ResolvedLevel {
    pub level_id: String,
    pub ordinal: f64,
    pub source_elevation_m: Option<f64>,
    pub network_altitude_m: Option<f64>,
    pub method: ResolutionMethod,
    pub scene_z_mm: i64,
    pub network_difference_mm: Option<i64>,
}

pub(crate) struct ResolutionOutcome {
    pub levels: Vec<ResolvedLevel>,          // venue.levels order
    pub normalisation_offset_mm: i64,
}

pub(crate) fn resolve_level_planes(
    levels: &[ViewerLevel],
    elevations: &LevelElevations,
    network: &NetworkAltitudes,
    profile: &ResolutionProfile,
) -> ResolutionOutcome
```

**Precedence (per level, in order):**
1. `elevations[level_id]` present → `ImportedElevation`; if a trustworthy network altitude also exists → keep both, `network_difference_mm = round((network − imported) × 1000)`, method stays `ImportedElevation`.
2. else trustworthy network altitude (`network[ordinal]` has `≥ network_min_nodes_per_level` entries and `max − min ≤ network_altitude_tolerance_m`; altitude = median of the sorted values) → `NetworkAltitude`.
3. else `NominalSpacing`: base = lowest ordinal with a non-nominal resolution, `base_elevation + spacing × (ordinal − base_ordinal)`; when no level has a non-nominal resolution, base = ordinal 0 at elevation 0 (elevation = `spacing × ordinal`).

**Normalisation:** `z_raw_mm = round(elevation_m × 1000)` per level; `offset_mm = min(z_raw_mm)` (0 when no levels); `scene_z_mm = z_raw_mm − offset_mm` (non-negative, lowest = 0).

- [x] **Step 1 (RED):** tests — all three branches on a 4-level input (imported / network / nominal / imported+network-difference), the all-nominal case, network trust rejection (too few nodes, spread too wide), median selection, custom spacing drives the nominal value, offset = min, empty levels → empty outcome with offset 0.
- [x] **Step 2:** run — fails to compile.
- [x] **Step 3 (GREEN):** implement `resolve_level_planes` + profile.
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): deterministic floor-plane resolution with a versioned profile`

---

### Task 5: wire resolution into the compile path + registry assembly

**Files:**
- Modify: `core/crates/kiriko-bundle/src/spatial_section.rs` (`build_spatial_context` gains resolution inputs and assembles level records + registries)
- Modify: `core/crates/kiriko-bundle/src/codec.rs` (`compile_imdf_with_network` 8th param, elevation extraction, network aggregation, resolve → context)
- Modify: `core/crates/kiriko-bundle/src/synth.rs`, `synth_medial.rs` (`RouteGraphBuild` construction gains `node_altitudes: vec![None; n]`)
- Modify: `core/crates/kiriko-node/src/lib.rs` (compile wrapper passes `None`)
- Test: `tests/bundle.rs` + codec unit tests

**Compile flow (in `compile_imdf_with_network`, after the network/synth block, before encode):**

```rust
let resolution_profile = resolution_profile.unwrap_or(&ResolutionProfile::default());
let elevations = extract_level_elevations(&venue.features, &resolution_profile.elevation_property_key);
let network_altitudes = build.node_altitudes_grouped_by_ordinal(&document.levels, build_alts); // None when no graph build
let outcome = resolve_level_planes(&venue.levels, &elevations, &network_altitudes, resolution_profile);
let spatial_context = crate::spatial_section::build_spatial_context(&venue, &outcome, resolution_profile);
```

`build_spatial_context` (now takes `&ResolutionOutcome` + `&ResolutionProfile`) keeps the #38 anchor/basis/datum/anchor-evidence assembly, sets `frame.vertical_normalisation_offset_mm = outcome.normalisation_offset_mm`, and appends deterministically: a shared `net_junction` locator (`LayerName`) when any level used the network source; a shared nominal assumption (`AssumptionKind::Nominal`, detail `"nominal_floor_spacing_m=… (profile vN)"`) when any level used nominal; then per level (venue.levels order): a level locator (`FeatureId`), evidence entry(ies) (imported → `ImportedElevation` + level locator; network → `PreservedNetworkAltitude` + net_junction locator + detail `"median of N junction altitudes"`; nominal → `NominalSpacing` + level locator + assumption_ref), and shared-per-method confidence entries (`ImportedElevation → (Measured, 1.0)`, `NetworkAltitude → (Estimated, 0.7)`, `NominalSpacing → (Assumed, 0.3)`). `LevelRecord` refs point at those indices.

- [x] **Step 1 (RED):** tests/bundle.rs — a compiled minimal bundle reports all three levels `NominalSpacing` (default profile), `resolved_scene_z_mm` non-negative with lowest 0, confidence refs/evidence refs in range, `frame.vertical_normalisation_offset_mm` = −min z_raw; a network-compiled bundle (junctions with `altitude`) resolves `NetworkAltitude` on the floor with ≥3 close altitudes.
- [x] **Step 2:** run — fails (no levels in decoded §8).
- [x] **Step 3 (GREEN):** implement extraction/aggregation/assembly + signature change; update all `compile_imdf_with_network` callers (node wrapper, example, existing tests → `None`).
- [x] **Step 4:** `cargo test --manifest-path core/Cargo.toml --workspace` — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): compile resolves floor planes into §8 with registry evidence`

---

### Task 6: deterministic multi-floor fixture + golden regen

**Files:**
- Modify: `core/crates/kiriko-bundle/tests/support/mod.rs` (`build_multi_floor_imdf_zip()` — in-memory IMDF zip: manifest, venue polygon, address, 4 levels `L3/L2/L1/B1` at ordinals 2/1/0/−1, `L1` and `B1` carrying `properties.elevation` 10.0 / 6.0; geometry copied from the minimal fixture)
- Modify: `core/crates/kiriko-bundle/tests/bundle.rs` — the three-branch test (custom profile `nominal_floor_spacing_m: 4.5`, network junctions with altitudes on `F2`/`B1`)

**Fixture expectations (custom profile, spacing 4.5, tolerance 1.0, min nodes 3):**
- `L1` (ordinal 0, elevation 10.0) → `ImportedElevation`, z = 4000.
- `L2` (ordinal 1, no elevation; 3 junctions altitude 14.0/14.1/14.2 → median 14.1) → `NetworkAltitude`, z = 8100 (14100 − 6000).
- `L3` (ordinal 2, none) → `NominalSpacing` (10.0 + 4.5×2 = 19.0) → z = 13000.
- `B1` (ordinal −1, elevation 6.0 + 3 junctions 6.5/6.5/6.6 → median 6.5) → `ImportedElevation`, `network_difference_mm = 500`, z = 0.
- offset = 6000; every level's confidence/evidence refs resolve; nominal levels' evidence carries the shared assumption ref.

Also: regenerate the golden fixture (`compile_fixture` example → new `minimal.kvb` + `.sha256`), update `GOLDEN_BUNDLE_HASH` in `tests/bundle.rs` and `server/test/coreNative.test.ts`. wasm.test.ts capability expectation is unchanged (report shape stable).

- [x] **Step 1 (RED):** the three-branch test + fixture builder; run — fails.
- [x] **Step 2 (GREEN):** implement; regenerate golden; update hashes.
- [x] **Step 3:** `cargo test --manifest-path core/Cargo.toml --workspace` — pass.
- [x] **Step 4:** commit `test(kiriko-bundle): multi-floor fixture exercises all resolution branches`

---

### Task 7: full verification + docs

- [x] **Step 1:** update `docs/gdb-data-reference.md` §KVB bundle sections — §8 now carries per-level floor-plane records (method, confidence, evidence, nominal spacing profile).
- [x] **Step 2:** mark this plan's checkboxes; run all five gates (`cargo --workspace`, both `tsc`, both vitest).
- [x] **Step 3:** commit `docs: record §8 floor-plane resolution in the KVB layout`.

---

### Self-review (plan vs. #39 acceptance)

- Level identity/ordinal/source elevation/scene Z/method/confidence/evidence refs → Tasks 2, 3 ✓
- Precedence in order → Task 4 ✓
- Deterministic multi-floor fixture, per-level branch reported → Task 6 ✓
- Nominal = identifiable as assumed → Task 4 (method + `Assumed` confidence) ✓
- Disagreement recorded as difference, nothing overwritten → Tasks 4, 6 (both values stored) ✓
- Profile data versioned, not constants → Task 4 (`ResolutionProfile.profile_version`) ✓
- Confidence/evidence inspectable per level → Task 2 (record fields) ✓
- Records reference #38 registries → Task 5 ✓
- Resolved = checked integer mm; source elevations full precision → Tasks 2, 4 (`round` once) ✓
