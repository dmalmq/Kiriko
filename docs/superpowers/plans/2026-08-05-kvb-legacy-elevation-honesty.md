# KVB Legacy-Bundle Provenance Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make already-published (pre-§8) venues honest about elevation: the spatial-context capability reports `absent`, and any consumer asking for elevation gets an explicit legacy/unknown answer — never a fabricated confidence or a number that looks measured.

**Architecture:** Decode-only, query-time. `kiriko-bundle` gains a public projection `level_elevations(&BundleDocument) -> Vec<LevelElevation>`: per canonical level, either the §8-backed `Resolved` record (with method/confidence/evidence) or a `LegacyUnknown` marker (no confidence field exists in the type — absence is structural, not a value). The browser module exposes the same projection as a thin `levelElevations(bundle)` binding (mirroring the `facilities` precedent; the native addon already carries the capability via inspect). The test input is the **real pre-#38 bundle**, extracted from git history (`15983d5^:tests/fixtures/minimal.kvb`, sha256 `3e1add8208…`) and committed as `tests/fixtures/legacy-minimal.kvb` — an actual already-published artifact, not a synthesised stand-in. Nothing is rewritten, migrated, or republished.

**Tech Stack:** Rust (kiriko-bundle, kiriko-wasm), the bundle integration suite, TS (wasm wrapper + test).

## Global Constraints

- TDD: no production code without a failing test first.
- Commit per logical change, on `feat/kvb-legacy-elevations` off `main`.
- The legacy bundle keeps opening exactly as today: decode succeeds, content identical, routing untouched, capability `absent` (not `invalid`).
- No confidence fabrication: `LegacyUnknown` carries no confidence field — the type cannot express a made-up value.
- The legacy fixture is the committed pre-#38 artifact; `tests/fixtures/minimal.kvb` (modern) stays untouched.
- Verification gates: `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

---

### Task 1: kiriko-bundle `level_elevations` projection

**Files:**
- Modify: `core/crates/kiriko-bundle/src/codec.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs` (export)
- Test: codec unit tests

**Interfaces (exact):**

```rust
/// The honest answer to "where is this level's floor plane?" — either the
/// §8-backed resolved plane with its evidence, or an explicit legacy/unknown
/// for a bundle published before §8 existed. `LegacyUnknown` carries no
/// confidence: absence is structural, so a confidence value can never be
/// fabricated for a legacy bundle.
#[derive(Debug, Clone, PartialEq)]
pub enum LevelElevation {
    /// The §8-backed resolved plane: method, confidence, and evidence refs.
    Resolved { level: kiriko_model::spatial::LevelRecord },
    /// No §8 spatial context: the elevation is unknown, and Kiriko says so.
    LegacyUnknown { level_id: String, ordinal: f64 },
}

/// Per-level elevation answers in canonical level order. A bundle with §8
/// yields `Resolved` for every level its records cover (a level the records
/// miss — only possible in a hand-crafted bundle — falls back to
/// `LegacyUnknown`); a bundle without §8 yields `LegacyUnknown` for every
/// level. Pure projection: decodes nothing, stores nothing, rewrites nothing.
pub fn level_elevations(document: &BundleDocument) -> Vec<LevelElevation>
```

- [x] **Step 1 (RED):** unit tests — a document with §8 yields all `Resolved` in level order matching the records; a document without §8 yields all `LegacyUnknown` with the level ids/ordinals; a §8 whose records miss one level yields `LegacyUnknown` for it.
- [x] **Step 2:** run — fails (`LevelElevation`/`level_elevations` missing).
- [x] **Step 3 (GREEN):** implement (lookup by exact level id, fall back to LegacyUnknown).
- [x] **Step 4:** run — pass.
- [x] **Step 5:** commit `feat(kiriko-bundle): level elevation projection with legacy/unknown answers`

---

### Task 2: real legacy fixture + integration proof

**Files:**
- Create: `tests/fixtures/legacy-minimal.kvb` (extracted from `15983d5^`), `tests/fixtures/legacy-minimal.kvb.sha256`
- Modify: `core/crates/kiriko-bundle/tests/bundle.rs`
- Test: integration tests

**Fixture provenance:** `git show 15983d5^:tests/fixtures/minimal.kvb` — the golden bundle committed and shipped before #38 merged (sha256 `3e1add8208f77c98fdddf5253c98bb18f533e5b3bf3d35d92ac444525080e136`). It is the actual Phase Two publish artifact, not a synthesised stand-in.

**Integration tests:**
1. `a_legacy_bundle_reports_spatial_context_absent_and_still_opens` — decode `legacy-minimal.kvb`: `capabilities.spatial_context() == Absent` (not `Invalid`), `spatial_context.is_none()`, `graph()`/`facilities()` absent, venue content intact (venue_id, 3 levels at ordinals [1, 0, −1], 27 features, 5 warnings — the same values the modern golden asserts).
2. `legacy_content_is_unchanged_from_the_modern_decode` — decode the legacy fixture and the modern golden; assert their `manifest`/`levels`/`features`/`bounds_by_level`/`warnings`/`stats` are equal (the only difference is §8: `spatial_context` None vs Some and the capability).
3. `legacy_elevations_are_explicitly_unknown_without_confidence` — `level_elevations` on the legacy decode: every answer is `LegacyUnknown` with the right id/ordinal, and none carries a confidence (structural: match on the variant, not a field check).
4. `modern_elevations_are_resolved` — `level_elevations` on the modern golden: every answer is `Resolved` and matches the §8 records.

- [x] **Step 1 (RED):** extract + commit the fixture, write the four tests — run: tests 1–3 fail (projection missing or wrong for the legacy bytes).
- [x] **Step 2 (GREEN):** implementation is Task 1's; fix what the tests expose.
- [x] **Step 3:** `cargo test --manifest-path core/Cargo.toml --workspace` — pass.
- [x] **Step 4:** commit `test(kiriko-bundle): prove legacy provenance honesty on the real pre-§8 bundle`

---

### Task 3: wasm `levelElevations` binding + TS wrapper

**Files:**
- Modify: `core/crates/kiriko-wasm/src/lib.rs`
- Modify: `src/bundle/wasm.ts`, `src/bundle/wasm.test.ts`
- Test: wasm integration test + client vitest

**Binding (mirrors `facilities`, returns a JSON-compatible projection):**

```rust
/// Per-level elevation answers as `{ levelId, ordinal, state }`, where
/// `state` is `"resolved"` (with `resolvedSceneZMm` and `method`) or
/// `"legacyUnknown"`. A legacy bundle answers `legacyUnknown` for every
/// level — a reviewer sees "we do not know this", never a confidence.
#[wasm_bindgen(js_name = "levelElevations")]
pub fn level_elevations_js(bundle: &[u8]) -> Result<JsValue, JsError>
```

TS: `LevelElevationDto` union (`{ levelId, ordinal, state: "resolved", resolvedSceneZMm, method } | { levelId, ordinal, state: "legacyUnknown" }`) + `levelElevations(bytes)` wrapper. Client tests: the legacy fixture → all `legacyUnknown` (real wasm); the modern golden → all `resolved`.

- [x] **Step 1 (RED):** wasm test + TS test first — fail (binding missing).
- [x] **Step 2 (GREEN):** implement binding + wrapper; rebuild wasm.
- [x] **Step 3:** `pnpm exec vitest run src/bundle/wasm.test.ts` + both `tsc` — pass.
- [x] **Step 4:** commit `feat(client): level elevation projection for legacy and resolved bundles`

---

### Task 4: full verification + docs

- [x] **Step 1:** docs — `docs/gdb-data-reference.md`: §8 entry gains the legacy contract (absent capability; `level_elevations` answers `LegacyUnknown`; no fabricated confidence; decode-only, nothing rewritten).
- [x] **Step 2:** mark this plan's checkboxes; run all five gates.
- [x] **Step 3:** commit `docs: record the legacy-bundle elevation contract in the KVB layout`.

---

### Self-review (plan vs. #41 acceptance)

- No-§8 bundle reports absent, not invalid → #38 already; asserted in Task 2 test 1 ✓
- 2D viewing / feature inspection / routing unchanged → Task 2 test 2 (content equality) + graph absent ✓
- Elevation derived with legacy/unknown provenance → Tasks 1, 3 (`LegacyUnknown` / `legacyUnknown`) ✓
- No confidence fabricated → Task 1 (type has no confidence field) + Task 2 test 3 ✓
- Legacy elevation distinguishable from evidence-backed → Task 1 (two variants), Tasks 2/3 (both asserted) ✓
- Real pre-work bundle as input → Task 2 (committed `3e1add8208…` artifact) ✓
- Nothing rewritten/migrated/republished → Tasks 1–3 (decode + query only; fixture is a new file, the original untouched) ✓
