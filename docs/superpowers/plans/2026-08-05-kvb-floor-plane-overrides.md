# KVB Producer Floor-Plane Override (§8 manual provenance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let a producer correct a level's resolved floor plane at compile time, marked as a manual decision with provenance, while the original source elevation survives untouched and readable.

**Architecture:** Overrides are compile input — `FloorOverride { level_id, elevation_m, actor, reason }` — applied in `resolve.rs` after automatic resolution (effective plane = override; the frame's normalisation offset and every other level stay untouched). The §8 `LevelRecord` gains `override_elevation_m: Option<f64>` (full precision) and `override_ref: Option<u32>` into the existing `manual_provenance` registry; the automatic `method`/evidence stay as the derivation trail, so a reader sees "automatic said X (method + evidence), human overrode to Y (provenance)". An unknown level id in an override is a compile warning under a new `floor_override` code (the AGENTS.md allowlist ripple: model enum, DTO, native.ts, types.ts). The golden fixture is unchanged — no overrides means byte-identical output.

**Tech Stack:** Rust (kiriko-bundle, kiriko-model), the bundle integration suite, TS (bridge allowlist + client type only).

## Global Constraints

- TDD: no production code without a failing test first.
- Commit per logical change, on `feat/kvb-floor-overrides` off `main` (both #38 and #39 are merged).
- An override never destroys the source: `source_elevation_m`, `network_difference_mm`, `method`, and evidence refs are untouched; only the effective plane changes.
- Determinism: overrides apply in input order, last duplicate wins (documented); the offset is computed from automatic planes only, so one override never shifts another level.
- Scene Z contract: automatically-resolved planes stay non-negative (offset = min); an overridden plane may be negative within `±MAX_VERTICAL_OFFSET_MM` — the frame is not recomputed (acceptance: override doesn't alter the frame).
- Validation: `override_elevation_m` finite; `override_ref` in range; both-or-neither (`override_elevation_m.is_some() == override_ref.is_some()`); when overridden, `resolved_scene_z_mm == round(override_m × 1000) − frame.vertical_normalisation_offset_mm` exactly (checked on both paths, like `world_translation == ecef_origin`).
- The golden fixture does **not** regenerate (no default behavior change) — the determinism tests prove byte-identity with and without overrides.
- Verification gates: `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

---

### Task 1: resolve.rs — `FloorOverride` + application pass

**Files:**
- Modify: `core/crates/kiriko-bundle/src/resolve.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs` (`pub use resolve::{FloorOverride, ResolutionProfile};`)
- Test: `resolve.rs` unit tests

**Interfaces (exact):**

```rust
/// A producer's manual correction of one level's resolved plane. Corrects
/// Kiriko's interpretation, never its record of the source: the original
/// source elevation stays untouched and readable.
#[derive(Debug, Clone, PartialEq)]
pub struct FloorOverride {
    pub level_id: String,
    /// The corrected resolved-plane elevation, metres (full precision).
    pub elevation_m: f64,
    pub actor: String,
    pub reason: String,
}

/// (in ResolvedLevel) the applied override, when one exists.
pub(crate) struct AppliedOverride {
    pub elevation_m: f64,
    pub actor: String,
    pub reason: String,
}
```

`ResolvedLevel` gains `pub(crate) override_: Option<AppliedOverride>`. `resolve_level_planes` gains a 4th parameter `overrides: &[FloorOverride]` and a final pass: for each override (input order, last duplicate wins), find the level by exact id; when found, set `resolved_elevation_m = override.elevation_m`, `override_ = Some(...)`; **the offset has already been computed from the automatic planes** — `scene_z_mm = round(override_m × 1000) − offset` may be negative. Levels without an override keep their automatic values. The outcome gains `pub(crate) unapplied_override_ids: Vec<String>` (override ids matching no level, in input order).

- [x] **Step 1 (RED):** unit tests — override moves only its level's plane (other levels' Z and the offset unchanged); override below the lowest plane yields negative Z; replacing = last wins; no override = automatic; unknown id lands in `unapplied_override_ids`.
- [x] **Step 2:** run — fails to compile (`FloorOverride`/field missing).
- [x] **Step 3 (GREEN):** implement.
- [x] **Step 4:** `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle resolve` — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): producer floor-plane overrides in the resolution pass`

---

### Task 2: LevelRecord schema — override value + provenance ref

**Files:**
- Modify: `core/crates/kiriko-model/src/spatial.rs` (`LevelRecord`, tests)
- Modify: `core/crates/kiriko-bundle/src/spatial_section.rs` (DTOs, conversions, validation, tests)

**Schema additions (exact):**

```rust
// LevelRecord gains:
    /// The producer's corrected plane, metres (full precision), when this
    /// level is overridden. The source elevation stays untouched above.
    pub override_elevation_m: Option<f64>,
    /// Index into `Registries::manual_provenance` — who overrode and why.
    /// Present exactly when `override_elevation_m` is.
    pub override_ref: Option<u32>,
```

**Validation additions (both paths):**
- `override_elevation_m` canonical-finite when present.
- `override_ref` in range when present.
- `override_elevation_m.is_some() == override_ref.is_some()` — an override value without provenance (or provenance without a value) is rejected: nothing is ever silently invented.
- When overridden: `resolved_scene_z_mm == (override_elevation_m * 1000.0).round() as i64 − frame.vertical_normalisation_offset_mm` exactly.
- Z bounds: automatic records stay `0..=MAX`; overridden records `|z| ≤ MAX` (negative allowed — the frame is not recomputed).

- [x] **Step 1 (RED):** tests — round-trip a level with override value + provenance; value-without-ref rejected; ref-without-value rejected; inconsistent Z rejected; negative Z accepted when overridden and rejected when automatic.
- [x] **Step 2:** run — fails.
- [x] **Step 3 (GREEN):** implement.
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): §8 level record override value and provenance reference`

---

### Task 3: `build_spatial_context` — registry assembly for overrides

**Files:**
- Modify: `core/crates/kiriko-bundle/src/spatial_section.rs`
- Test: integration tests in `tests/bundle.rs` (multi-floor fixture)

**Change:** for each level with `override_`, push a `ManualProvenance { actor, reason }` entry, set the record's `override_ref`, and set `override_elevation_m`. Deterministic append order (level order, same as the record loop). The automatic `method`, `source_elevation_m`, `network_difference_mm`, and evidence refs are untouched.

- [x] **Step 1 (RED):** integration test on the multi-floor fixture — override F2 (network-resolved 14.1 → 15.0) and B1 (imported 6.0 → 6.5): F2's Z changes, B1's `source_elevation_m` stays 6.0 and `network_difference_mm` stays 500, L1/L3 and the offset are unchanged, both records carry `override_elevation_m` + a resolving `override_ref` whose `actor`/`reason` round-trip, and the methods stay the automatic ones.
- [x] **Step 2:** run — fails (no override handling in assembly).
- [x] **Step 3 (GREEN):** implement.
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): assemble override provenance into §8 level records`

---

### Task 4: compile wiring + unknown-level warning

**Files:**
- Modify: `core/crates/kiriko-bundle/src/codec.rs` (`compile_imdf_with_network` 9th param `overrides: &[FloorOverride]`, warning for unapplied ids, pass to resolve)
- Modify: `core/crates/kiriko-model/src/model.rs` (`WarningCode::FloorOverride` + `as_str` → `"floor_override"`), `core/crates/kiriko-bundle/src/sections.rs` (`WarningCodeDto` + conversions)
- Modify: `server/src/core/native.ts` (`ViewerWarningCode` union + `WARNING_CODES`), `src/imdf/types.ts` (`ViewerWarningCode` union)
- Modify: all `compile_imdf_with_network` callers (napi wrapper `&[]`, tests `&[]`, examples `&[]`)
- Test: codec/integration tests

**Change:** overrides flow into `resolve_level_planes`; for every id in `unapplied_override_ids`, push `ViewerWarning { code: WarningCode::FloorOverride, message: "floor_override: unknown level <id>; the override was not applied", .. }`. The message format matches the existing `"<detail>: ..."` convention (`route_build`/`facility_build` prefix their specifics).

- [x] **Step 1 (RED):** tests — compile with an override for a missing level → warning code `floor_override` present, bundle still compiles; compile with a valid override → no warning, record carries it.
- [x] **Step 2:** run — fails (no param, no warning code).
- [x] **Step 3 (GREEN):** implement + update all callers.
- [x] **Step 4:** `cargo test --manifest-path core/Cargo.toml --workspace` + both `tsc` — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): floor override warnings for unknown levels across the bridge`

---

### Task 5: full verification + docs

- [x] **Step 1:** docs — `docs/gdb-data-reference.md` §8 entry: override semantics (manual provenance, source untouched, frame not recomputed, scene-Z contract for overridden planes).
- [x] **Step 2:** mark this plan's checkboxes; run all five gates. Confirm the golden fixture bytes are unchanged (determinism tests already assert this).
- [x] **Step 3:** commit `docs: record §8 floor-plane overrides in the KVB layout`.

---

### Self-review (plan vs. #40 acceptance)

- Override sets the resolved plane → Tasks 1, 3 ✓
- Source elevation preserved and readable → Task 3 (untouched `source_elevation_m`; tested) ✓
- Manual provenance, distinguishable from derived → Task 3 (`override_ref` + `ManualProvenance`; absent ≠ present) ✓
- Inspecting a level shows source / datum / resolved plane separately → record fields + frame datum (tested in Task 3) ✓
- Remove/replace returns to automatic from unchanged source → Task 1 (last wins; no override = automatic) ✓
- One level's override alters neither other levels nor the frame → Task 1 (offset from automatic planes only; tested) ✓
- Overridden levels round-trip with override + source intact → Task 2 (round-trip test) ✓
- Never silently invented; absence distinguishable → Task 2 (both-or-neither validation) ✓
