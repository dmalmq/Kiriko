# §9 Scene Sources Section: Format, Codec, and Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the declared §9 scene-sources section a real byte format, codec, and bounded validation, replacing the Stage 0 "no decoder in this build" placeholder with real capability classification — the first implementation slice of Stage 1 (#51 of #50).

**Architecture:** Canonical scene types in `kiriko-model::scene` (no serde — the `spatial` pattern); postcard DTOs + validation in a new `kiriko-bundle::scene_section` module. §9 is the first section whose references cross into another section: every primitive's level membership, confidence, source locators, and evidence resolve into the decoded §8 spatial context of the same bundle. Encode requires §8 alongside §9 (the declared dependency, producer-side); decode validates §9 against the decoded §8 and classifies it for real (available / absent / unsupported version / invalid / disabled by dependency). The compile path does not emit §9 yet (that is #52); the golden fixtures are unchanged.

**Tech Stack:** Rust (kiriko-model, kiriko-bundle, postcard), the bundle integration suite.

## Global Constraints

- TDD: no production code without a failing test first.
- Commit per logical change, on `feat/kvb-scene-sources` off `main`.
- Required sections and the §5 byte schema are unchanged; reserved ids 4 and 6 stay unused.
- §9 carries no floating-point values: resolved geometry is checked integer millimetres, and source evidence lives in §8's registries.
- The capability report's `sceneSources` field (declared in Stage 0) now reflects the real decoder; §10/§11 keep the no-decoder contract.
- Verification gates: `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

---

### Task 1: kiriko-model scene canonical types

- [x] `core/crates/kiriko-model/src/scene.rs`: `PrimitiveRole` (Surface/Wall/Ceiling/Portal/Conveyance), `OcclusionClass`, `ConveyanceKind` (SourceEvidenced/Neutral), `Mesh` (checked integer mm positions + triangle faces), `PrimitiveGeometry` (Mesh / Portal with topology relationship / Conveyance), `ScenePrimitive` (id, role, level_id, occlusion, confidence_ref, canonical_feature_id, source_locator_refs, evidence_refs, geometry), `ActivationState`, `FloorMapping`, `SourceObjectAssociation`, `ContextualClassification`, `TilesDescriptor` (hashes + activation + profile + mappings + associations + classifications — never a URL or GLB bytes), `SceneSection`.
- [x] Registered in `lib.rs`; constructibility tests.

### Task 2: scene_section DTOs + encode/decode + validation

- [x] `core/crates/kiriko-bundle/src/scene_section.rs`: DTO mirrors, enum conversions, `encode_scene_section(&SceneSection, &SpatialContext)` and `decode_scene_section(&[u8], &SpatialContext)` (postcard exact, both paths validate against §8).
- [x] Validation: primitive/descriptor count caps, string bounds, mesh position bounds (`±MAX_SCENE_COORDINATE_MM`) and face index ranges, portal refs in range + not self, role/geometry consistency, level membership in §8's level records, confidence/locator/evidence refs in §8's registry ranges, descriptor floor-mapping levels in §8's levels.
- [x] Unit tests: full round-trip + every rejection.

### Task 3: codec wiring

- [x] `BundleDocument.scene: Option<SceneSection>` (+ all construction sites).
- [x] `encode_bundle`: emits §9 when present; rejects a scene without §8.
- [x] `decode_bundle`: real §9 classification — §8 decoded → decode §9 against it; §9 present with §8 unavailable → `DisabledByDependency { requires: 8 }`; absent → `Absent`. `classify_declared_section` now covers only §10/§11.
- [x] The "no decoder" contract moves to §10/§11 tests.

### Task 4: integration tests

- [x] Scene round-trips through the bundle with capability `available`.
- [x] Encode rejects a scene without §8 and with dangling references.
- [x] An unreadable §9 version degrades alone; a present §9 whose §8 is unavailable reports disabled by dependency with its bytes never interpreted; garbage §9 reports invalid while the venue opens.

### Task 5: full verification + docs

- [x] `docs/gdb-data-reference.md`: §9 promoted from "declared" to implemented (primitives + tiles descriptor, cross-section validation, disabledByDependency).
- [x] All five gates green.

## Self-review (plan vs. #51 acceptance)

- §9 uses declared id 9; reserved 4/6 untouched; §1–3 and §5 byte-unchanged → Task 3 ✓
- Closed primitive model round-trips; portal is an explicit topology relationship → Tasks 1, 2 ✓
- Each primitive carries identity, role, level membership, occlusion, associations, evidence refs → Task 1 ✓
- Evidence refs resolve into §8's registries → Tasks 2, 3 (cross-section validation, both paths) ✓
- Tiles descriptor: hashes, activation, registration identity, mappings, associations, classifications — no URL, no GLB bytes → Task 1 ✓
- Resolved geometry checked integer mm; source evidence f64 in §8, lossless → Tasks 1, 2 ✓
- Bounded validation before availability → Task 2 ✓
- Malformed §9 → invalid, venue opens with routing intact → Task 4 ✓
- Present §9 with §8 unavailable → disabled by dependency naming §8 → Task 4 ✓
- Capability reported identically by native addon and browser module → the report field is shared (verified by the Stage 0 parity suite; scene-carrying parity arrives with #54's fixture) ✓/⚠
