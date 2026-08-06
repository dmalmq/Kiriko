# Generated-Scene Compiler: Semantic Primitives with Provenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The native Rust compiler that turns the canonical venue model, the resolved §8 floor planes, and the routing graph's registered endpoints into §9 semantic primitives — slabs, walls, ceilings, portals, and conveyance forms, each with explicit provenance and the never-guess rule (#52 of #50, effort band L).

**Architecture:** New `kiriko-bundle::scene_compile` module with one entry `compile_scene(&BundleDocument, &mut SpatialContext, &SceneProfile) -> Option<SceneSection>`: it reads the venue features (levels/units/openings/drawings), the §8 frame + level records (authoritative scene Z), and the embedded graph (conveyance endpoints), projects lon/lat into venue-local millimetres through the §8 ENU frame, triangulates polygons (hand-rolled ear clipping — no new deps; `geo` stays netgen-optional), and appends source locators, evidence, confidence, and assumption entries into §8's registries (records reference, never duplicate). Emission order is fixed: slabs → ceilings → surfaces → walls → portals → conveyance. The compile path runs it after §8 assembly and sets `document.scene`.

**Tech Stack:** Rust (kiriko-bundle, kiriko-model), the bundle integration suite, zstd fixture tooling.

## Global Constraints

- TDD: no production code without a failing test first.
- Commit per logical change, on `feat/kvb-scene-compiler` off `main`.
- Resolved geometry is checked integer millimetres projected through the §8 ENU frame; the authoritative Z is each level's resolved plane (`resolved_scene_z_mm`) from §8.
- Never-guess rule: conveyance is always the category-specific neutral form (prism between graph-endpoint planes, or a footprint box) — never stairs, never fabricated machinery.
- Walls from unique unit-boundary edges (one wall per shared edge, min of the two units' heights); `Drawing` lines contribute walls only when corroborated by a unit boundary, otherwise ignored.
- Nominal dimensions (wall/ceiling/door height, corroboration tolerance) come from a versioned `SceneProfile`; a unit's `height` source property (metres) overrides nominal for that unit's walls and ceiling.
- The compile path emits §9 for every venue with computable scene content → **golden fixtures regenerate** (minimal, stage0, and the crafted outcomes derived from stage0); the wasm test's capability expectation gains `sceneSources: available`.
- Verification gates: `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

---

### Task 1: SceneProfile, ENU projection, triangulation

**Files:**
- Create: `core/crates/kiriko-bundle/src/scene_compile.rs` (helpers first)
- Modify: `core/crates/kiriko-bundle/src/lib.rs` (`mod scene_compile; pub use scene_compile::SceneProfile;`)
- Test: unit tests

**Interfaces (exact):**

```rust
/// Versioned scene profile: nominal dimensions and tolerances, never global
/// constants.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneProfile {
    pub profile_version: u32,          // 1
    pub wall_height_mm: i64,           // 3000
    pub ceiling_height_mm: i64,        // 3000 (unit ceilings; unit `height` overrides)
    pub door_height_mm: i64,           // 2100
    pub height_property_key: String,   // "height" (metres, finite)
    pub corroboration_tolerance_mm: i64, // 200
    pub conveyance_height_mm: i64,     // 3000 (neutral footprint box)
}

impl Default for SceneProfile { /* v1 */ }

/// Project `(lon, lat)` into the venue-local ENU frame (checked integer
/// millimetres), given the frame's anchor ECEF and basis.
pub(crate) fn project_local_mm(frame: &kiriko_model::spatial::Frame, lon: f64, lat: f64) -> [i64; 2]

/// Deterministic ear-clipping triangulation of a simple polygon (no holes),
/// returning triangle index triples into the input ring.
pub(crate) fn triangulate_simple(ring: &[[i64; 2]]) -> Vec<[u32; 3]>
```

- [x] **Step 1 (RED):** tests — profile v1 defaults; projection: the anchor projects to (0, 0); a point exactly east/north of the anchor projects to the expected millimetres; round-trip determinism; triangulation: rectangle → 2 triangles; concave polygon → n−2 triangles; clockwise and counterclockwise rings → same triangles (deterministic).
- [x] **Step 2:** run — fails (module missing).
- [x] **Step 3 (GREEN):** implement (projection via `wgs84_ecef` + basis dot products, `round` once; ear clipping with signed-area orientation handling).
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): scene profile, ENU projection, and polygon triangulation`

---

### Task 2: slabs, ceilings, surfaces

**Files:**
- Modify: `core/crates/kiriko-bundle/src/scene_compile.rs`
- Modify: `core/crates/kiriko-bundle/tests/support/mod.rs` (multi-floor fixture gains unit + opening features; a unit with a `height` property)
- Test: unit + integration tests

**Emission rules:**
- **Slab** per level (in `document.levels` order): the level feature's polygon ring projected at the level's resolved plane Z, triangulated. Evidence: the §8 level locator (reused, index ≥ 1) + `DerivedFromVenueGeometry`; confidence Measured (1.0).
- **Ceiling** per unit: the unit's polygon ring at plane Z + unit height (unit `height` property in metres → mm, else nominal `ceiling_height_mm`); assumption ref (nominal ceiling height when nominal); confidence Assumed (0.3) when nominal, Measured when source.
- **Surface** per unit: the unit's polygon ring at plane Z; new unit locator + evidence; confidence Measured.
- Registry appends: unit locators, evidence entries, confidence entries (shared per class), assumptions (nominal wall/ceiling/door height, neutral conveyance) — appended deterministically.

- [x] **Step 1 (RED):** integration test on the extended multi-floor fixture — 4 slabs (one per level) at the resolved Z (0/4000/8000/13500 mm from #39's resolution with the custom profile), a surface + ceiling per unit, the `height`-bearing unit's ceiling at its source height, others nominal, every ref resolving.
- [x] **Step 2:** run — fails.
- [x] **Step 3 (GREEN):** implement.
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): compile slabs, ceilings, and navigable surfaces with provenance`

---

### Task 3: walls and portals

**Files:**
- Modify: `core/crates/kiriko-bundle/src/scene_compile.rs`
- Test: integration tests

**Emission rules:**
- **Walls** from unique unit-boundary edges: for each unit ring edge (projected, quantized mm), dedupe by the sorted vertex pair → one vertical quad per unique edge, from plane Z to plane Z + height, where height = min of the two adjacent units' heights (source `height` or nominal `wall_height_mm`). Corroboration: a `Drawing` line within `corroboration_tolerance_mm` of a boundary edge corroborates it (no extra geometry); a drawing line on no boundary is ignored (detail linework). Confidence Assumed (nominal height) with the nominal-wall-height assumption ref; Measured when the height is source-derived.
- **Portals** from openings: an opening line lying on a unit-boundary edge (within tolerance) → a Portal primitive connecting the two surfaces it separates (unit↔unit, or unit↔slab on the venue boundary), with the opening mesh = the doorway quad (projected opening segment width, from plane Z to plane Z + `door_height_mm`, standing on the wall plane). Confidence Assumed (nominal door height) + assumption ref.

- [x] **Step 1 (RED):** integration test — wall count equals the deduped unique boundary edges; a shared edge yields ONE wall; the opening between two units connects exactly those surfaces; an opening on the outer boundary connects unit↔slab; a crafted standalone drawing line produces no wall.
- [x] **Step 2:** run — fails.
- [x] **Step 3 (GREEN):** implement.
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): compile walls from space boundaries and portals from openings`

---

### Task 4: conveyance

**Files:**
- Modify: `core/crates/kiriko-bundle/src/scene_compile.rs`
- Test: integration tests

**Emission rules (never-guess):**
- Per vertical graph edge (junctions on different ordinals): a Conveyance primitive (kind Neutral) — the prism connecting the two level planes at the two junctions' projected XY. Evidence: `net_junction` locator (reused or appended) + graph-derived evidence; assumption ref (neutral conveyance form); confidence Assumed.
- Per transit-category unit (category contains stair/escalator/elevator/ramp/lift/transit): a Conveyance primitive (kind Neutral) — the footprint extruded from plane Z to plane Z + `conveyance_height_mm`. Same provenance class.

- [x] **Step 1 (RED):** integration test — a vertical edge yields a prism whose base vertices sit on the two resolved planes; a transit-category unit yields the footprint box; a network without vertical edges yields no graph conveyance; every conveyance is kind Neutral (never stairs geometry).
- [x] **Step 2:** run — fails.
- [x] **Step 3 (GREEN):** implement.
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): compile neutral conveyance forms from graph endpoints and transit footprints`

---

### Task 5: compile wiring, determinism, round-trip, goldens

**Files:**
- Modify: `core/crates/kiriko-bundle/src/codec.rs` (`compile_imdf_with_network` gains `scene_profile: Option<&SceneProfile>`; runs `compile_scene` after §8 assembly), all callers (napi `None`, tests, example)
- Modify: `core/crates/kiriko-bundle/tests/bundle.rs`, `tests/fixtures/*` (regenerate minimal + stage0 + crafted), `src/bundle/wasm.test.ts` (capability expectation: `sceneSources: available`), `server/test/coreNative.test.ts` (hash)
- Test: integration tests

**Flow in `compile_imdf_with_network`:** after `build_spatial_context` yields `Some(spatial)`: `document.scene = scene_compile::compile_scene(&document, spatial, scene_profile)`; then `document.spatial_context = Some(spatial)`. Determinism: the scene derives from canonical inputs only.

- [x] **Step 1 (RED):** a compiled bundle now carries `scene_sources: Available` and a non-empty scene; scene round-trips through the §9 codec; compile-twice + reversed-order byte-identical.
- [x] **Step 2 (GREEN):** implement + regenerate fixtures (minimal, stage0, crafted outcomes) + update hashes + wasm capability expectation.
- [x] **Step 3:** full workspace + both tsc + both vitest — pass.
- [x] **Step 4:** commit `feat(kiriko-bundle): compile emits the generated scene into §9` (with the fixture regeneration).

---

### Task 6: data-gated Tokyo + full verification + docs

- [x] **Step 1:** `server/test/stage1Tokyo.test.ts` (gated like #42's): the registered JR East dataset's published bundle carries a scene with all primitive classes; skips when `KIRIKO_TOKYO_FIXTURES` is absent.
- [x] **Step 2:** docs — `docs/gdb-data-reference.md` §9 entry gains the compiler rules; plan checkboxes.
- [x] **Step 3:** all five gates.
- [x] **Step 4:** commit `test(server): data-gated Stage 1 Tokyo scene acceptance + docs`.

---

### Self-review (plan vs. #52 acceptance)

- Multi-floor fixture generates every primitive class → Tasks 2–4 (fixture extended with units/openings; conveyance from the vertical edge) ✓
- Never-guess rule → Task 4 (always the neutral form, tested) ✓
- Provenance: evidence refs into §8, nominal geometry identifiable as assumed → Tasks 2–4 (Assumed confidence + assumption refs) ✓
- Source dimensions where present, else versioned-profile nominal → Tasks 2–3 (`height` property + `SceneProfile`) ✓
- Source readable alongside resolved placement → source locators on every primitive ✓
- Venue-local checked integer mm from §8 planes → Task 1 (projection) + Tasks 2–4 ✓
- Identical inputs byte-identical → Task 5 ✓
- Lands in §9 via #51's codec + round-trips → Task 5 ✓
- JR Tokyo data-gated → Task 6 ✓
