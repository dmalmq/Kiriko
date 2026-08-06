# Stage 1 Proof: Golden Scene Fixture, Determinism, and Cross-Adapter Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Close out Stage 1 with the frozen scene fixture, the compatibility/determinism assertions that pin the promise, and the stage's data-gated acceptance (#54 of #50) — scheduled last so the golden is cut once against the final shape.

**Architecture:** The generated-scene golden (`stage0.kvb`, cut at #53 against the final shape; `minimal.kvb` likewise) is already committed, sha256-pinned, and recompile-exact — #51–#53 shipped those tests. The missing §9-specific proof is the strip test: deriving the §9-less equivalent from the frozen bytes and asserting content + routing equality and the typed absent capability. Cross-adapter parity per outcome and the data-gated Tokyo acceptance already exist. The libm determinism fix from #53 makes the golden platform-stable, so CI's Linux run reproduces the committed bytes.

**Tech Stack:** Rust (kiriko-bundle, kiriko-route), the bundle integration suite, server test (data-gated).

## Global Constraints

- TDD: no production code without a failing test first.
- Commit per logical change, on `feat/kvb-stage1-proof` off `main`.
- The fixtures are frozen and platform-stable (libm geodesy): a test must fail if the bytes drift or if the compile becomes platform-dependent.
- The §9-less equivalent is derived by stripping the §9 row (the same `rebuild_payload`/`wrap_payload_for_test` infra as #42); nothing is rewritten or republished.
- Verification gates, run locally exactly as CI does: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, wasm32 `cargo check`, both tsc, both vitest, `pnpm build`, and the node binding require check.

---

### Task 1: §9 compatibility + routing proof (Rust)

- [x] `stage1_fixture_decodes_identically_without_the_scene_and_still_routes` — strip §9 from `stage0.kvb`: every field identical except the scene + `sceneSources` (absent, never invalid); §8 untouched; routing over the fixture and the §9-less equivalent produces the identical `Route`.
- [x] `crafted_fixtures_report_the_scene_capability_outcome_per_bundle` — the frozen matrix: `stage0.kvb` → available, `legacy-minimal.kvb` → absent, `stage0-unsupported/invalid/disabled` → `DisabledByDependency { requires: 8 }` with the scene bytes never interpreted.

### Task 2: docs + verification

- [x] docs (`gdb-data-reference.md`): the Stage 1 verification surface.
- [x] All five gates + the acceptance sequence locally (fmt, clippy, workspace, wasm check, tsc, vitest, build, node check).
- [x] CI green (the acceptance run on Linux — the golden must reproduce there).

## Self-review (plan vs. #54 acceptance)

- Golden scene fixture committed, sha-pinned, recompile-exact → #51/#53 (`stage0_fixture_is_frozen_and_reproducible`, `golden_fixture_matches_committed_bytes_and_checksum`) ✓
- Required sections + graph + §8 decode identically without §9, routing identical → Task 1 (the strip test) ✓
- §9 available on the fixture; absent on the §9-less equivalent → Task 1 ✓
- Byte-identical compiles → `the_full_pipeline_compiles_byte_identically`, `the_scene_compiles_byte_identically_with_the_network_pipeline` ✓
- Cross-adapter parity per outcome (capabilities + scene projections) → #42's `crossAdapter.test.ts` (five outcome fixtures, six report fields) + #53's scene-projection parity ✓
- Multi-floor fixture passes (all primitive classes, never-guess) → #52's scene tests ✓
- Registered Tokyo dataset generates a scene (data-gated) → `stage1Tokyo.test.ts` ✓
- No observable change to 2D/inspection/routing, verified → Task 1 (content equality) + #41 legacy tests ✓
- Full verification set → Task 2 ✓
