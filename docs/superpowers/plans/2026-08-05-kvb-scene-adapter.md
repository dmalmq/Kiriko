# Scene-Source Adapter Contract and Typed Projections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The renderer-neutral scene-source contract both Generated and Tiles implement, with typed projections the wasm and native addon expose identically and TypeScript mirrors (#53 of #50).

**Architecture:** Projection types + the `SceneSource` trait live in `kiriko-model::scene_projection` (serde `Serialize`, the shared wire types); the Generated implementation is a thin adapter in `kiriko-bundle::scene_adapter` (`scene_projection(&BundleDocument)`), mapping §9 primitives + §8 frame/levels/registries into the projection, with capability derived from the report's §9 outcome and pick semantics that never let an unassociated source object impersonate a canonical feature. Both adapters expose `sceneProjection(bundle)`; the parity test compares them on the same bytes.

**Tech Stack:** Rust (kiriko-model, kiriko-bundle, kiriko-node, kiriko-wasm), TS (wasm wrapper + server parity test).

## Global Constraints

- TDD: no production code without a failing test first.
- Commit per logical change, on `feat/kvb-scene-adapter` off `main`.
- TypeScript receives typed projections; it never decodes section bytes, interprets source-property keys, or resolves elevation.
- Bilingual copy is renderable from the typed capability/failure states (the `ViewerWarning` division).
- Pre-existing main breakage from the #49/#56 merge is repaired in T2 (stale 9-arg calls in the stage0 tests + the fixture example; stage0/crafted fixtures regenerated for the scene emission).
- Verification gates: `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

---

### Task 1: projection types + SceneSource trait (kiriko-model)

- [x] `kiriko-model::scene_projection`: `SceneSourceKind` (Generated/Tiles), `SceneSourceIdentity`, `SceneFrameProjection`, `SceneLevelProjection` (plane, bounds, source levels), `SceneConfidenceProjection`, `SceneEvidenceProjection`, `ScenePrimitiveProjection` (role/occlusion/confidence/associations/evidence), `SceneCapabilityState` (tagged: ready/absent/invalid/unsupportedVersion/disabledByDependency), `ScenePickProjection`, `SceneProjection` (+ `pick`), and the `SceneSource` trait.
- [x] Unit tests: constructibility, pick semantics (associated → canonical object; unassociated → no impersonation; unknown → None), trait implementability.

### Task 2: Generated adapter (kiriko-bundle)

- [x] `scene_adapter.rs`: `GeneratedSceneSource` implementing `SceneSource`; `pub fn scene_projection(&BundleDocument)`; capability mapped from the report's §9 outcome; level bounds from slab geometry; confidence/locators/evidence resolved into §8 registries; `as_str` added to the scene/spatial enums.
- [x] Integration tests: identity/frame/levels/primitives/capability/pick on the compiled multi-floor fixture; absent capability for a legacy bundle.
- [x] Repaired main's stale 9-arg calls (stage0 tests + fixture example) and regenerated the stage0/crafted fixtures for the scene emission.

### Task 3: wasm + TS

- [x] wasm `sceneProjection(bundle)` binding; TS `SceneProjectionDto` mirror + wrapper; client tests (golden → ready projection with levels/bounds/roles; legacy → typed absent).

### Task 4: native binding + parity + docs

- [x] `kiriko-node` `sceneProjection(bundle)` (AsyncTask, JSON like inspectBundle).
- [x] Cross-adapter parity tests (server suite): identical typed projections for the §9 bundle and the legacy bundle on both adapters.
- [x] docs (`gdb-data-reference.md`): the adapter contract.
- [x] All five gates green.

## Self-review (plan vs. #53 acceptance)

- Rust trait with typed projection types, implementable by both sources → Task 1 (Tiles variant + trait) ✓
- Generated implementation adapts §9 + §8 (identity, frame/world, level groups/planes, roles/occlusion, associations, pick) → Task 2 ✓
- Pick returns canonical feature/level/conveyance + source object + evidence; unassociated cannot impersonate → Task 1 (pick semantics, tested) ✓
- Readiness/capability/structured failure typed → Task 1 (`SceneCapabilityState`) ✓
- wasm + native identical capabilities and equivalent typed projections → Task 4 (parity tests) ✓
- TS mirrors the projection; no bytes/keys/elevation → Task 3 (types + wrapper) ✓
- Bilingual copy renderable from typed states → Task 1 (discriminated states, no prose) ✓
