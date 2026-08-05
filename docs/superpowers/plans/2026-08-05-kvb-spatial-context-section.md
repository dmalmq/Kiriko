# KVB Spatial Context Section (§8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the §8 spatial-context section (one WGS84 local ENU frame per venue version + shared typed evidence registries) to the `kvb1` codec, wire it through the capability model from #37, and ship the section-dependency mechanism (§§9–11 → §8) proven end to end.

**Architecture:** Canonical §8 types + WGS84→ECEF geodesy live in `kiriko-model` (new `spatial.rs`, no serde — matching the `RouteGraph`/`Facilities` pattern). Postcard-serializable DTOs, validation, and encode/decode live in a new `kiriko-bundle` module (`spatial_section.rs`). The codec's `CapabilityReport` gains `spatialContext` plus the three declared future sections (`sceneSources`, `canonicalGraph`, `networkQa`); a code-level dependency table in `format.rs` declares §§9–11 → §8 and gates availability. The compile path derives the frame anchor from the venue-feature geometry bounds centre and emits §8 whenever an anchor is computable. `disabledByDependency` is proven end-to-end with hand-crafted bundles (the `wrap_payload_for_test` infra from #37).

**Tech Stack:** Rust (kiriko-model, kiriko-bundle, postcard, zstd, serde), TS (wasm client + server bridge tests), vitest, cargo.

## Global Constraints

- TDD: no production code without a failing test first (repo convention, superpowers:test-driven-development). Watch each test fail for the right reason.
- Commit per logical change, on branch `feat/kvb-spatial-context` off `main`.
- Strict TS, no `any`. Bilingual strings: Rust emits a discriminated state plus numbers, never prose (the one string, `invalid.reason`, is diagnostic detail — same division as `ViewerWarning`).
- No new `WarningCode` variants → no bridge-allowlist change (AGENTS.md rule not triggered).
- Reserved section ids 4 and 6 stay unused and unemitted.
- Required-section strictness is preserved: an unsupported version on §1–3 is still a hard failure.
- Determinism: identical canonical inputs must compile byte-identically. **Never hash the raw source zip** (reversed record order would change the bytes).
- All identifiers, numeric ranges, collection counts, ordering, and references validated deterministically *before* availability is offered.
- Verification gates (run at the end and after each task where noted): `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

---

### Task 1: kiriko-model spatial canonical types + geodesy

**Files:**
- Create: `core/crates/kiriko-model/src/spatial.rs`
- Modify: `core/crates/kiriko-model/src/lib.rs` (`mod spatial; pub use spatial::{...};`)
- Test: unit tests inside `spatial.rs`

**Interfaces:**
- Produces (consumed by Task 2+): `Axes`, `LengthUnit`, `LocatorKind`, `TransformKind`, `AssumptionKind`, `EvidenceMethod`, `ConfidenceKind`, `Ellipsoid`, `Datum`, `SourceArtifact`, `SourceLocator`, `RegistrationEvidence`, `Transform`, `Assumption`, `Confidence`, `ManualProvenance`, `Frame`, `Registries`, `SpatialContext`; `WGS84_SEMI_MAJOR_M`, `WGS84_INVERSE_FLATTENING`, `wgs84_ecef(lon_deg, lat_deg, height_m) -> [f64; 3]`, `enu_basis_ecef(lon_deg, lat_deg) -> [[f64; 3]; 3]`, `venue_horizontal_bounds(&VenueModel) -> Option<Bounds>`.

**Schema (exact):**

```rust
//! Canonical spatial-context (§8) types and deterministic WGS84 geodesy.
//! No serde here — postcard DTOs live in kiriko-bundle (same as RouteGraph).

use std::collections::BTreeMap;
use crate::canonical::Value;
use crate::model::{Bounds, VenueModel};

pub const WGS84_SEMI_MAJOR_M: f64 = 6_378_137.0;
pub const WGS84_INVERSE_FLATTENING: f64 = 298.257_223_563;
/// Vertical normalisation offset bound, checked integer millimetres (±1000 km).
pub const MAX_VERTICAL_OFFSET_MM: i64 = 1_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axes { EastNorthUp }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LengthUnit { Millimetre }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocatorKind { ArchivePath, FeatureId, LayerName }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransformKind { Registration }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssumptionKind { Nominal, Inferred }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceMethod { DerivedFromVenueGeometry }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidenceKind { Measured, Estimated, Assumed, Unknown }

#[derive(Debug, Clone, PartialEq)]
pub struct Ellipsoid { pub semi_major_metres: f64, pub inverse_flattening: f64 }

#[derive(Debug, Clone, PartialEq)]
pub struct Datum { pub name: String, pub ellipsoid: Ellipsoid }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceArtifact { pub name: String, pub hash: [u8; 32] }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceLocator { pub kind: LocatorKind, pub value: String, pub artifact_ref: Option<u32> }

#[derive(Debug, Clone, PartialEq)]
pub struct Transform {
    pub kind: TransformKind,
    pub coefficients: Vec<f64>,
    pub unit: LengthUnit,
    pub profile_version: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RegistrationEvidence {
    pub method: EvidenceMethod,
    pub source_locator_ref: u32,
    pub transform_ref: Option<u32>,
    pub confidence_ref: Option<u32>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assumption { pub kind: AssumptionKind, pub detail: String }

#[derive(Debug, Clone, PartialEq)]
pub struct Confidence { pub kind: ConfidenceKind, pub value: f64 /* 0..=1, finite */ }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualProvenance { pub actor: String, pub reason: String }

/// The one shared local frame per immutable venue version. `world_translation`
/// equals `ecef_origin` by construction (compile computes both from the same
/// anchor); decode validates the equality.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub anchor: [f64; 2],
    pub ecef_origin: [f64; 3],
    pub enu_basis_ecef: [[f64; 3]; 3],
    pub world_translation: [f64; 3],
    pub axes: Axes,
    pub unit: LengthUnit,
    pub vertical_normalisation_offset_mm: i64,
    pub datum_ref: u32,
    pub anchor_evidence_ref: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Registries {
    pub artifacts: Vec<SourceArtifact>,
    pub locators: Vec<SourceLocator>,
    pub datums: Vec<Datum>,
    pub transforms: Vec<Transform>,
    pub registration_evidence: Vec<RegistrationEvidence>,
    pub assumptions: Vec<Assumption>,
    pub confidence: Vec<Confidence>,
    pub manual_provenance: Vec<ManualProvenance>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpatialContext {
    pub frame: Frame,
    pub registries: Registries,
    /// Bounded canonical source-property map: source fields Kiriko does not
    /// model, preserved for audit/export, never interpreted as semantics.
    pub source_properties: BTreeMap<String, Value>,
}
```

Geodesy functions (standard WGS84, deterministic):

```rust
/// WGS84 geodetic (lon/lat degrees, ellipsoidal height metres) to ECEF metres.
pub fn wgs84_ecef(lon_deg: f64, lat_deg: f64, height_m: f64) -> [f64; 3] {
    let (lon, lat) = (lon_deg.to_radians(), lat_deg.to_radians());
    let e2 = 2.0 / WGS84_INVERSE_FLATTENING - 1.0 / (WGS84_INVERSE_FLATTENING * WGS84_INVERSE_FLATTENING);
    let n = WGS84_SEMI_MAJOR_M / (1.0 - e2 * lat.sin() * lat.sin()).sqrt();
    let (cl, sl, cp, sp) = (lon.cos(), lon.sin(), lat.cos(), lat.sin());
    [
        (n + height_m) * cp * cl,
        (n + height_m) * cp * sl,
        (n * (1.0 - e2) + height_m) * sp,
    ]
}

/// East/north/up unit vectors at `(lon_deg, lat_deg)`, as ECEF coordinates.
/// Columns: `[east, north, up]` — the world-transform rotation from local
/// ENU (metres) to ECEF: `p_ecef = origin + R * p_enu`.
pub fn enu_basis_ecef(lon_deg: f64, lat_deg: f64) -> [[f64; 3]; 3] {
    let (lon, lat) = (lon_deg.to_radians(), lat_deg.to_radians());
    let (cl, sl, cp, sp) = (lon.cos(), lon.sin(), lat.cos(), lat.sin());
    [
        [-sl, cl, 0.0],
        [-sp * cl, -sp * sl, cp],
        [cp * cl, cp * sl, sp],
    ]
}

/// Canonical venue horizontal bounds: the Venue feature's own geometry
/// bounds; falls back to the union of `bounds_by_level` when the venue
/// feature has no usable geometry. `None` when neither exists.
pub fn venue_horizontal_bounds(venue: &VenueModel) -> Option<Bounds> { ... }
```

- [ ] **Step 1: Write the failing tests** (module `#[cfg(test)] mod tests`): WGS84 constants; `wgs84_ecef(0.0, 0.0, 0.0) == [6378137.0, 0.0, 0.0]`; ECEF at the minimal fixture anchor is finite and `up` basis column ≈ normalized ecef origin (h=0); basis columns are unit-norm and mutually orthogonal; `venue_horizontal_bounds` on a `VenueModel` with a venue polygon returns its bounds and the fallback path returns the level-bounds union; `None` when empty.
- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path core/Cargo.toml -p kiriko-model` — FAIL (module missing).
- [ ] **Step 3: Implement** the module + `pub use` in `lib.rs`.
- [ ] **Step 4: Run to verify pass** — `cargo test --manifest-path core/Cargo.toml -p kiriko-model` — PASS.
- [ ] **Step 5: Commit** — `git add core/crates/kiriko-model && git commit -m "feat(kiriko-model): spatial context canonical types and WGS84 geodesy"`

---

### Task 2: §8 postcard DTOs, encode/decode, validation

**Files:**
- Create: `core/crates/kiriko-bundle/src/spatial_section.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs` (`mod spatial_section;`)
- Test: unit tests inside `spatial_section.rs`

**Interfaces:**
- Consumes: Task 1 types (`kiriko_model::spatial::*`).
- Produces: `pub(crate) fn encode_spatial_context(&SpatialContext) -> Result<Vec<u8>, BundleError>`, `pub(crate) fn decode_spatial_context(&[u8]) -> Result<SpatialContext, BundleError>`.

**DTOs** mirror Task 1 types field-for-field with `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]` (plain derives — a corrupted discriminant fails postcard decoding, same convention as `FeatureTypeDto`). Conversions `dto_from_canonical` / `canonical_from_dto` apply `canonical_f64` to every f64 (both directions; `-0.0` normalized) and run `validate_spatial_context(&SpatialContext) -> Result<(), BundleError>`.

**Validation rules** (decode: DTO→canonical; encode: canonical→DTO, so an in-memory document can't encode garbage):

- anchor lon ∈ [-180, 180], lat ∈ [-90, 90]; every f64 finite (canonical_f64).
- `world_translation == ecef_origin` bitwise (reject a hand-crafted inconsistent frame).
- Each `enu_basis_ecef` column: unit norm within `1e-6` (deterministic; `sqrt` on finite input).
- `vertical_normalisation_offset_mm` within `±MAX_VERTICAL_OFFSET_MM`.
- Every registry length ≤ 65_536. Every string ≤ 1024 chars (UTF-8 length).
- `Confidence.value` ∈ [0, 1] finite.
- References in range: `frame.datum_ref < datums.len()`, `frame.anchor_evidence_ref < registration_evidence.len()`, `SourceLocator.artifact_ref` in range, `RegistrationEvidence.source_locator_ref` in range, `transform_ref`/`confidence_ref` in range when `Some`.
- `source_properties`: ≤ 1024 entries, each key ≤ 256 chars; every `Value` finite via `value_to_dto`-style canonicalization (reuse `sections::JsonValueDto` conversion — expose `pub(crate) fn object_from_dto`/`object_to_dto` or reuse through `crate::sections`).

- [ ] **Step 1: Write the failing tests**: round-trip a fully-populated `SpatialContext` (all eight registries non-empty) through encode→decode and assert equality; each validation rule rejects its violation (out-of-range ref, mismatched translation, non-unit basis, NaN anchor, too-long string, oversize map); `-0.0` normalizes to `0.0` in a coefficient.
- [ ] **Step 2: Run to verify failure** — module missing → compile error.
- [ ] **Step 3: Implement** DTOs, conversions, validation, `encode_spatial_context` (postcard of DTO), `decode_spatial_context` (`postcard_take_exact` + convert + validate).
- [ ] **Step 4: Run to verify pass** — `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle`.
- [ ] **Step 5: Commit** — `git commit -m "feat(kiriko-bundle): §8 spatial context encode/decode with bounded validation"`

---

### Task 3: Wire §8 + dependencies into the codec

**Files:**
- Modify: `core/crates/kiriko-bundle/src/format.rs` (section ids + dependency table)
- Modify: `core/crates/kiriko-bundle/src/codec.rs` (`BundleDocument.spatial_context`, `CapabilityReport` fields/accessors/Default, `encode_bundle`, `decode_bundle`, dependency gating, every construction site)
- Modify: `core/crates/kiriko-bundle/src/export.rs`, `sections.rs` (`manifest_into_document`), `synth.rs`, `synth_medial.rs` (construction sites)
- Test: `codec.rs` unit tests + `tests/bundle.rs`

**format.rs additions:**

```rust
pub(crate) const SECTION_SPATIAL_CONTEXT: u16 = 8;
/// Declared future sections. Their ids, versions, and dependency edges are
/// format facts; their decoders arrive in later stages (scene sources: Stage 1,
/// canonical graph: Stage 4, network QA: Stage 6). A present row for one of
/// these is never interpreted by this decoder.
pub(crate) const SECTION_SCENE_SOURCES: u16 = 9;
pub(crate) const SECTION_CANONICAL_GRAPH: u16 = 10;
pub(crate) const SECTION_NETWORK_QA: u16 = 11;

/// Declared availability edges: `(requires, references)`. `requires` gates
/// availability (an unavailable requirement disables the section);
/// `references` are informational cross-section edges recorded for future
/// validation and never gate availability.
pub(crate) fn declared_dependencies(id: u16) -> (&'static [u16], &'static [u16]) {
    match id {
        SECTION_SCENE_SOURCES | SECTION_CANONICAL_GRAPH | SECTION_NETWORK_QA => {
            (&[SECTION_SPATIAL_CONTEXT], &[])
        }
        SECTION_NETWORK_QA => (
            &[SECTION_SPATIAL_CONTEXT],
            &[SECTION_SCENE_SOURCES, SECTION_CANONICAL_GRAPH],
        ),
        _ => (&[], &[]),
    }
}
```

**codec.rs:**

```rust
// BundleDocument gains:
pub spatial_context: Option<SpatialContext>,

// CapabilityReport gains (all four accessors + Default::default() = Absent):
pub(crate) spatial_context: SectionCapability,
pub(crate) scene_sources: SectionCapability,
pub(crate) canonical_graph: SectionCapability,
pub(crate) network_qa: SectionCapability,
```

`encode_bundle`: after facilities, `if let Some(s) = &document.spatial_context { section_list.push((format::SECTION_SPATIAL_CONTEXT, format::SECTION_VERSION, spatial_section::encode_spatial_context(s)?)); }` (id 8 sorts after 7 — appending keeps id-ascending).

`decode_bundle`: classify §8 like graph/facilities (`spatial_section::decode_spatial_context`); then compute the three declared sections:

```rust
/// Capability of a declared-but-not-yet-decodable section (9/10/11): its
/// bytes are never interpreted. Absent without a row; withheld when a
/// required section is unavailable; otherwise unavailable with a diagnostic
/// (no decoder exists in this build — unreachable by any real bundle, since
/// no producer emits these ids yet; the arriving decoder replaces this).
fn classify_declared_section(
    directory: &format::Directory,
    id: u16,
    outcomes: &BTreeMap<u16, SectionCapability>,
) -> SectionCapability {
    if directory.declared_version(id).is_none() {
        return SectionCapability::Absent;
    }
    let (requires, _references) = format::declared_dependencies(id);
    for requirement in requires {
        if !matches!(outcomes.get(requirement), Some(SectionCapability::Available)) {
            return SectionCapability::DisabledByDependency { requires: *requirement };
        }
    }
    SectionCapability::Invalid {
        reason: format!("section {id} has no decoder in this build; its bytes were not interpreted"),
    }
}
```

Report assembly: `graph`/`facilities`/`spatial_context` direct outcomes; then `scene_sources`/`canonical_graph`/`network_qa` from the above (outcomes map = {8: spatial_capability}). Dependency gate applies to the present declared rows regardless of their direct version.

- [ ] **Step 1: Write the failing tests** (codec.rs unit tests): serialization pin — full report JSON string with all six keys including `{"state":"disabledByDependency","requires":8}`; `CapabilityReport::default()` has six absent outcomes.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — format.rs ids/deps, codec fields + encode + decode + gating; update every `BundleDocument { ... }` construction site (codec.rs:176 compile, codec.rs tests, export.rs:267/392, sections.rs:532, synth.rs:698, synth_medial.rs:1958, tests/bundle.rs:751/1099) with `spatial_context: None` (compile sets it in Task 4).
- [ ] **Step 4: Run to verify pass** — `cargo test --manifest-path core/Cargo.toml --workspace`.
- [ ] **Step 5: Commit** — `git commit -m "feat(kiriko-bundle): wire §8 into the codec with declared section dependencies"`

---

### Task 4: compile-path §8 production

**Files:**
- Modify: `core/crates/kiriko-bundle/src/codec.rs` (`compile_imdf_with_network`)
- Test: `tests/bundle.rs`

**Interface:** `fn build_spatial_context(venue: &VenueModel) -> Option<SpatialContext>` (module-private in codec.rs or spatial_section.rs):

```rust
fn build_spatial_context(venue: &VenueModel) -> Option<SpatialContext> {
    let bounds = kiriko_model::spatial::venue_horizontal_bounds(venue)?;
    let anchor = [
        (bounds.west + bounds.east) / 2.0,
        (bounds.south + bounds.north) / 2.0,
    ];
    let ecef_origin = kiriko_model::spatial::wgs84_ecef(anchor[0], anchor[1], 0.0);
    let basis = kiriko_model::spatial::enu_basis_ecef(anchor[0], anchor[1]);
    let venue_id = venue
        .features
        .iter()
        .find(|f| f.feature_type == FeatureType::Venue)
        .map(|f| f.id.clone())
        .expect("import guarantees exactly one venue feature");
    Some(SpatialContext {
        frame: Frame {
            anchor,
            ecef_origin,
            enu_basis_ecef: basis,
            world_translation: ecef_origin,
            axes: Axes::EastNorthUp,
            unit: LengthUnit::Millimetre,
            vertical_normalisation_offset_mm: 0, // floors (#39) normalise scene Z
            datum_ref: 0,
            anchor_evidence_ref: 0,
        },
        registries: Registries {
            artifacts: Vec::new(), // source-archive hashing deferred: raw zip hashing would break reversed-order byte identity
            locators: vec![SourceLocator { kind: LocatorKind::FeatureId, value: venue_id, artifact_ref: None }],
            datums: vec![Datum {
                name: "WGS84".into(),
                ellipsoid: Ellipsoid {
                    semi_major_metres: WGS84_SEMI_MAJOR_M,
                    inverse_flattening: WGS84_INVERSE_FLATTENING,
                },
            }],
            transforms: Vec::new(), // registration transforms arrive with floor evidence (#39)
            registration_evidence: vec![RegistrationEvidence {
                method: EvidenceMethod::DerivedFromVenueGeometry,
                source_locator_ref: 0,
                transform_ref: None,
                confidence_ref: None,
                detail: "frame anchor at the canonical venue horizontal-bounds centre".into(),
            }],
            assumptions: Vec::new(),
            confidence: Vec::new(),
            manual_provenance: Vec::new(), // overrides arrive with #40
        },
        source_properties: BTreeMap::new(),
    })
}
```

`compile_imdf_with_network` sets `document.spatial_context = build_spatial_context(&venue);` before encoding.

- [ ] **Step 1: Write the failing tests** (tests/bundle.rs): compiled minimal bundle reports `spatialContext: Available` and decodes `document.spatial_context` with anchor `[139.767, 35.681]` (fixture centre), `world_translation == ecef_origin`, datum registry `[WGS84]`, `anchor_evidence_ref` in range; compile twice + reversed-zip-order compile are byte-identical (regression: no source-archive hashing).
- [ ] **Step 2: Run to verify failure** — compile has no §8 → spatialContext absent / document.spatial_context None.
- [ ] **Step 3: Implement** `build_spatial_context` + wire into compile.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(kiriko-bundle): compile emits the §8 spatial context frame from venue bounds"`

---

### Task 5: Capability + dependency end-to-end (crafted bundles)

**Files:**
- Test: `tests/bundle.rs` (uses `decompress_payload`, `wrap_payload_for_test`, `directory_row`, `zstd_frame_bytes` — add a small `section_bytes(payload, id) -> &[u8]` helper)

**Scenarios (each a test):**

1. §8 row at version 2 → `spatialContext: UnsupportedVersion{2, 1}`; venue opens; graph/facilities outcomes unchanged.
2. §8 row pointing at garbage bytes → `spatialContext: Invalid` (reason present); venue opens; §5 graph still `Available` when the crafted bundle carries a valid graph (splice §8 into a network-compiled bundle).
3. §8 valid + §9 row (garbage bytes) → `sceneSources: DisabledByDependency{requires: 8}`; the §9 bytes are never interpreted (garbage is fine — this is the end-to-end proof #37 could not make).
4. §9 row with §8 at version 2 (unavailable) → still `DisabledByDependency` (gate wins over the section's own outcome).
5. §9 row with §8 valid → `sceneSources: Invalid` with the "no decoder in this build" reason (only reachable by hand-crafted bytes).
6. No §9 row → `sceneSources: Absent` (golden fixture covers this).
7. Crafted §8 with `datum_ref: 99` (out of range) → `spatialContext: Invalid` — the invalid cross-reference disables the capability, not the bundle.
8. Required-section strictness preserved: §2 (geometry) at version 2 → whole bundle still rejected (`UnsupportedBundleVersion`) — unchanged behavior, regression guard.

- [ ] **Step 1: Write the failing tests** (all eight; scenario 3 is the heart of the ticket).
- [ ] **Step 2: Run to verify failure** — no §8 handling yet → scenarios fail.
- [ ] **Step 3: Implement** — covered by Task 3's gating + Task 2's validation; this task only adds the tests. Fix whatever they expose.
- [ ] **Step 4: Run to verify pass** — `cargo test --manifest-path core/Cargo.toml --workspace`.
- [ ] **Step 5: Commit** — `git commit -m "test(kiriko-bundle): prove disabledByDependency end to end with crafted bundles"`

---

### Task 6: wasm + TS bridge surfaces

**Files:**
- Modify: `src/bundle/wasm.ts` (`CapabilityReportDto` + doc comments)
- Modify: `src/bundle/wasm.test.ts` (capability expectation + new full-report assertion)
- Test: `server/test/coreNative.test.ts` (`GOLDEN_BUNDLE_HASH` + native inspection carries the report)

**Notes:** the wasm crate serializes `kiriko-bundle::CapabilityReport` directly (no separate DTO) — no Rust wasm change needed. `kiriko-node` re-serializes `BundleInspection` — automatic. The TS interface must be extended to match the wire shape:

```ts
export interface CapabilityReportDto {
  graph: SectionCapability;
  facilities: SectionCapability;
  spatialContext: SectionCapability;
  sceneSources: SectionCapability;
  canonicalGraph: SectionCapability;
  networkQa: SectionCapability;
}
```

- [ ] **Step 1: Write the failing tests**: wasm.test.ts — the golden fixture's full report must equal `{ graph: absent, facilities: absent, spatialContext: available, sceneSources: absent, canonicalGraph: absent, networkQa: absent }` (real built wasm); coreNative.test.ts — `inspection.capabilities` in `inspectionJson` carries the same six outcomes for the same golden bytes (native/browser parity at #38 level).
- [ ] **Step 2: Run to verify failure** — TS type mismatch / report lacks the new keys.
- [ ] **Step 3: Implement** the TS interface extension.
- [ ] **Step 4: Run to verify pass** — `pnpm exec vitest run src/bundle/wasm.test.ts`, `pnpm --dir server exec vitest run test/coreNative.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): expose spatial context and declared-section capabilities"`

---

### Task 7: Golden fixture regeneration, docs, full verification

**Files:**
- Modify: `tests/fixtures/minimal.kvb`, `tests/fixtures/minimal.kvb.sha256` (regenerate — the compiled minimal now carries §8)
- Modify: `server/test/coreNative.test.ts` (`GOLDEN_BUNDLE_HASH` → new digest)
- Modify: `core/crates/kiriko-bundle/tests/bundle.rs` (`directory_is_sorted_fixed_width_and_required_sections_only` — now asserts ids `[1,2,3,8]`; rename to reflect §8; deliberate contract change)
- Modify: `docs/gdb-data-reference.md` (KVB bundle sections inventory: add §8, note declared ids 9–11)
- Modify: `docs/superpowers/plans/` — this plan, checkboxes marked

- [ ] **Step 1:** Update the directory test first (fails on old expectation), then regenerate the fixture: `cargo run --manifest-path core/Cargo.toml -p kiriko-bundle --example compile_fixture`; write the printed hash into `minimal.kvb.sha256`; update `GOLDEN_BUNDLE_HASH`.
- [ ] **Step 2:** Update `docs/gdb-data-reference.md` §KVB bundle sections.
- [ ] **Step 3:** Run all gates: `cargo test --manifest-path core/Cargo.toml --workspace` (expect ~250+ passed), `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.
- [ ] **Step 4:** Commit — `git commit -m "chore: regenerate golden fixture with §8 and document the KVB section layout"`.

---

### Self-review (plan vs. #38 acceptance)

- Next free section id, reserved ids untouched → Task 3/7 ✓
- Frame stores anchor/ECEF/world transforms/axes/units/offset → Tasks 1, 2, 4 ✓
- ENU axes, checked-integer mm resolved values → Tasks 1–2 (offset; floor Z lands in #39) ✓
- f64 source evidence round-trips losslessly → Tasks 1–2 (canonical_f64 finite/`-0.0` only; no rounding) ✓
- Eight registries + reference-not-duplicate → Tasks 1–2 (indices validated) ✓
- Bounded source-property maps → Task 2 (≤1024 entries, ≤256-char keys, finite values) ✓
- Bounds validation before availability → Task 2 (validation in both encode and decode paths) ✓
- Malformed/out-of-bounds §8 → invalid via capability model, venue opens → Tasks 2, 5 ✓
- §8 round-trips encode/decode unchanged → Task 2 ✓
- Native/browser report identical capabilities → Task 6 (same golden bytes, both adapters) ✓
- Dependencies declarable + enforced; §§9–11 → §8; QA→9,10 references → Task 3 ✓
- disabledByDependency proven end to end → Task 5 scenario 3 ✓
- Invalid cross-reference disables dependent capability → Task 5 scenario 7 ✓
