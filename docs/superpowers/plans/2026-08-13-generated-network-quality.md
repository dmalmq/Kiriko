# Generated Network Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six generated-network quality changes — P0 offshoot remediation, persisted edge attrs, Connection-style vertical costs, query-time greedy-LOS, hallway rank, and obstacle subtraction — without breaking imported Tokyo graphs or old §5 viewers.

**Architecture:** P0 lands first from the four existing 2026-08-12 plans (topology only; no wire change). Then `RouteEdge` grows an `attrs` field that travels on an **optional KVB §12**, never a §5 version bump. Verticals become a typed Connection cost. Query-time smoothing and hallway rank / obstacle subtraction consume those attrs and the venue's own unit/detail geometry.

**Tech Stack:** Rust 2024 workspace (`kiriko-route`, `kiriko-bundle` + `netgen`, `kiriko-wasm`, `kiriko-node`), TypeScript viewer (`src/map/networkFeatures.ts`, `featureLayers.ts`, `IndoorMap.tsx`), Vitest, existing bilingual review overlay.

**Spec:**
- P0: `docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md`
- P1–P4 / P6: `docs/superpowers/specs/2026-08-13-generated-network-quality-design.md`
- Comparison: `docs/superpowers/reports/2026-08-13-indoor-network-generation-vs-kiriko.md`

## Global Constraints

- TDD. Observe each focused test fail before production code. One commit per task.
- Bilingual UI: any new user string needs ja + en. P0 vertical markers use language-neutral floor tokens; add no new copy unless a task writes the exact pair.
- Absence is never a zero: `clearance_m` is `Option<f32>` / JSON `null`, never `0.0` for "unknown".
- New `WarningCode`s must be added to `server/src/core/native.ts` **and** `src/imdf/types.ts`. This plan adds none.
- Do not bump `SECTION_VERSION` or add fields to postcard `GraphEdgeDto`. Old decoders must keep routing.
- Imported Tokyo GDB graphs stay `EdgeKind::Imported`, emit no §12, and are never re-classified or obstacle-clipped by synthesis.
- Regeneration only: published versions are unchanged until Generate routing.
- Do not replace the medial-axis spine with a lattice.
- P0 matching plan's "preserve `horiz + floor_cost`" is **superseded** by spec 2026-08-13 §4; implement P0 matching with the old weight, then overwrite the helper in Task 8.
- Skip formatters / linters / full-workspace suites until a task names them. Focused commands are in each task.
- Isolated worktree (if used) is created at execution time via `using-git-worktrees`.

## File structure

| File | Responsibility |
|---|---|
| `docs/superpowers/plans/2026-08-12-lazy-doorway-stubs.md` | P0 Task 1 (existing, execute as-is) |
| `docs/superpowers/plans/2026-08-12-opening-geometry-review-diagnostics.md` | P0 Task 2 (existing) |
| `docs/superpowers/plans/2026-08-12-one-to-one-vertical-transit-matching.md` | P0 Task 3 (existing) |
| `docs/superpowers/plans/2026-08-12-network-vertical-link-presentation.md` | P0 Task 4 (existing) |
| `core/crates/kiriko-route/src/graph.rs` | `EdgeKind`, `PathwayRank`, `VerticalKind`, `EdgeAttrs`, `RouteEdge.attrs` |
| `core/crates/kiriko-route/src/lib.rs` | Re-export new types |
| `core/crates/kiriko-route/src/build.rs` | Read `EDGE_KIND` / `PATHWAY_RANK` / `CLEARANCE_M` / `TRANSITION_CATEGORY` on import |
| `core/crates/kiriko-route/src/smooth.rs` | `WalkableFloor`, `smooth_route` (no `geo`) |
| `core/crates/kiriko-route/src/query.rs` | Unchanged A*; callers smooth after |
| `core/crates/kiriko-bundle/src/format.rs` | `SECTION_GRAPH_ATTRS = 12`, dependency on §5 |
| `core/crates/kiriko-bundle/src/sections.rs` | Encode/decode §12; zip onto `RouteEdge.attrs` |
| `core/crates/kiriko-bundle/src/codec.rs` | Emit/classify §12; `CapabilityReport.graph_attrs` |
| `core/crates/kiriko-bundle/src/clip.rs` | Copy `attrs` through clip |
| `core/crates/kiriko-bundle/src/export.rs` | Write the four GeoJSON properties |
| `core/crates/kiriko-bundle/src/walkable.rs` | `walkable_floors(&BundleDocument) -> Vec<WalkableFloor>` |
| `core/crates/kiriko-bundle/src/synth.rs` | Vertical cost helper; default attrs on hub edges |
| `core/crates/kiriko-bundle/src/synth_medial.rs` | Kind/clearance on emit; classify; obstacles |
| `core/crates/kiriko-bundle/src/transit_match.rs` | Created by P0 Task 3 |
| `core/crates/kiriko-wasm/src/lib.rs` | `route_in_document` calls `smooth_route` |
| `src/bundle/wasm.ts` | `graphAttrs` on `CapabilityReportDto` |
| `src/map/networkFeatures.ts` | Pass through export properties (P0 already projects verticals) |
| `docs/gdb-data-reference.md` | Pipeline note: §12, vertical cost, generate-network semantics |

Do not add a new crate. Do not add `geo` to wasm.

---

## Phase 0 — P0 offshoot remediation

Execute the four existing plans **in this order**. Do not re-derive their steps. Do not start Phase 1 until Task 4's focused tests are green.

### Task 1: Lazy doorway stubs

**Files:** follow `docs/superpowers/plans/2026-08-12-lazy-doorway-stubs.md`

**Interfaces:**
- Consumes: current eager `DoorwayNodes`.
- Produces: `DoorwaySide { point, node: Option<usize> }`, `materialize_doorway_side(...) -> usize`.
- Preserves: `synthesize_network_medial` signature; no `RouteEdge` field change.

- [ ] **Step 1: Execute that plan to its commit** (`fix(synth): materialize doorway stubs only when used`).
- [ ] **Step 2: Confirm the focused doorway tests named in that plan pass.**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen doorway_ -- --nocapture`

Expected: PASS.

### Task 2: Opening-geometry review diagnostics

**Files:** follow `docs/superpowers/plans/2026-08-12-opening-geometry-review-diagnostics.md`

**Interfaces:**
- Produces: `OpeningAxis { feature_id, mid, direction, arc_length_m, chord_length_m }`; advisory `synth_opening_geometry_review` on the existing `WarningCode::RouteBuild` channel.

- [ ] **Step 1: Execute that plan to its commit.**
- [ ] **Step 2: Confirm a 6 m straight opening warns `long` and does not change node/edge counts.**

### Task 3: One-to-one vertical matching

**Files:** follow `docs/superpowers/plans/2026-08-12-one-to-one-vertical-transit-matching.md`

**Interfaces:**
- Produces: `transit_match::minimum_cost_maximum_matching(&[TransitPair]) -> Vec<TransitPair>`.
- Weight in this task remains `horizontal_distance_m + floor_cost(category)` (the 2026-08-12 plan). Task 8 replaces the helper.

- [ ] **Step 1: Execute that plan to its commit.**
- [ ] **Step 2: Confirm fan-in becomes two distinct matches and `synth_transit_no_link` still fires for unmatched lowers.**

### Task 4: Vertical-link client presentation

**Files:** follow `docs/superpowers/plans/2026-08-12-network-vertical-link-presentation.md`

**Interfaces:**
- Produces: `VerticalNetworkLink` projection; no vertical LineString on the active floor.
- Still keys verticality off `HFLAG === 1` (export already sets this from ordinal mismatch). Task 6 will also set `HFLAG` from `EdgeKind::Vertical`.

- [ ] **Step 1: Execute that plan to its commit.**
- [ ] **Step 2: Confirm `src/map/networkFeatures.test.ts` vertical cases pass.**

Run: `pnpm exec vitest run src/map/networkFeatures.test.ts src/map/featureLayers.test.ts`

Expected: PASS.

---

## Phase 1 — Edge attrs + optional §12 (P6)

### Task 5: Add `EdgeAttrs` on `RouteEdge` with default-safe literals

**Files:**
- Modify: `core/crates/kiriko-route/src/graph.rs`
- Modify: `core/crates/kiriko-route/src/lib.rs`
- Modify: every in-workspace `RouteEdge { ... }` literal (compiler will list them: `build.rs`, `query.rs`, `clip.rs`, `export.rs`, `sections.rs`, `synth.rs`, `synth_medial.rs`, `kiriko-bundle/tests/bundle.rs`)

**Interfaces:**
- Consumes: current `RouteEdge { from, to, weight, ordinal, interior }`.
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EdgeKind {
    Imported = 0,
    Skeleton = 1,
    Doorway = 2,
    Stub = 3,
    Bridge = 4,
    Chord = 5,
    Vertical = 6,
    TransitAttach = 7,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PathwayRank {
    Primary = 1,
    Secondary = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum VerticalKind {
    Elevator = 1,
    Escalator = 2,
    Stairs = 3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeAttrs {
    pub kind: EdgeKind,
    pub rank: PathwayRank,
    pub clearance_m: Option<f32>,
    pub vertical: Option<VerticalKind>,
}

impl Default for EdgeAttrs { /* Imported / Primary / None / None */ }

impl EdgeAttrs {
    pub fn is_default(self) -> bool { self == Self::default() }
}

// RouteEdge gains:
pub attrs: EdgeAttrs,
```

- `EdgeAttrs::default()` is `Imported` so every existing imported-graph and test literal stays semantically identical.
- Invariant helper (debug-assert in encode): `vertical.is_some() == (kind == Vertical)`.

- [ ] **Step 1: Write a failing unit test for Default and the vertical invariant**

In `graph.rs` tests:

```rust
#[test]
fn edge_attrs_default_is_imported_primary_unknown_clearance() {
    let a = EdgeAttrs::default();
    assert_eq!(a.kind, EdgeKind::Imported);
    assert_eq!(a.rank, PathwayRank::Primary);
    assert_eq!(a.clearance_m, None);
    assert_eq!(a.vertical, None);
    assert!(a.is_default());
}

#[test]
fn vertical_attrs_require_a_kind() {
    let a = EdgeAttrs {
        kind: EdgeKind::Vertical,
        rank: PathwayRank::Primary,
        clearance_m: None,
        vertical: Some(VerticalKind::Elevator),
    };
    assert!(!a.is_default());
    assert_eq!(a.vertical.is_some(), a.kind == EdgeKind::Vertical);
}
```

- [ ] **Step 2: Run the new tests — they fail to compile (`EdgeAttrs` missing)**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route edge_attrs_default -- --nocapture`

Expected: compile error, `EdgeAttrs` not found.

- [ ] **Step 3: Add the types, `RouteEdge.attrs`, re-export them, and set `attrs: EdgeAttrs::default()` on every existing literal**

Add a small constructor used by synthesis going forward:

```rust
impl RouteEdge {
    pub fn new(from: u32, to: u32, weight: f32, ordinal: f64) -> Self {
        Self {
            from,
            to,
            weight,
            ordinal,
            interior: Vec::new(),
            attrs: EdgeAttrs::default(),
        }
    }
}
```

Do not change weights, interiors, or tests' assertions in this task.

- [ ] **Step 4: Run kiriko-route + bundle tests**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-route
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
```

Expected: PASS. §5 round-trips still ignore attrs (not on the wire yet).

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-route core/crates/kiriko-bundle
git commit -m "feat(route): persist EdgeAttrs on RouteEdge with imported default"
```

### Task 6: Optional KVB §12 graph attrs

**Files:**
- Modify: `core/crates/kiriko-bundle/src/format.rs` (`SECTION_GRAPH_ATTRS = 12`; `declared_dependencies(12) = requires [5]`)
- Modify: `core/crates/kiriko-bundle/src/sections.rs` (encode/decode)
- Modify: `core/crates/kiriko-bundle/src/codec.rs` (`CapabilityReport.graph_attrs`, emit/classify)
- Modify: `core/crates/kiriko-bundle/src/clip.rs` (copy `attrs`)
- Modify: `core/crates/kiriko-bundle/src/export.rs` (GeoJSON properties)
- Modify: `core/crates/kiriko-route/src/build.rs` (read those properties)
- Modify: `src/bundle/wasm.ts` (`graphAttrs: SectionCapability`)
- Modify: `src/bundle/wasm.test.ts` (pin `graphAttrs: { state: "absent" }` on current fixtures)

**Interfaces:**
- Consumes: `RouteEdge.attrs` from Task 5.
- Produces: section id 12, version 1, postcard:

```rust
struct GraphEdgeAttrDto {
    kind: u8,
    rank: u8,
    clearance_m: Option<f32>,
    vertical: Option<u8>,
}
struct GraphAttrsSectionDto { edges: Vec<GraphEdgeAttrDto> }
```

- Encode §12 **only if** any edge has `!attrs.is_default()`.
- Decode: if §12 missing/unsupported/disabled → leave defaults. If present and `edges.len() != graph.edges.len()` or a discriminant is unknown → `SectionCapability::Invalid`; graph stays, attrs stay default.
- `HFLAG` / `passage_type` = 1 iff `kind == Vertical` **or** (legacy) endpoint ordinals differ.

- [ ] **Step 1: Write failing round-trip and default-omission tests in `sections.rs`**

```rust
#[test]
fn graph_attrs_section_round_trips_on_a_vertical_edge() {
    let mut doc = minimal_document();
    let mut edge = RouteEdge::new(0, 1, 15_000.0, 0.0);
    edge.attrs = EdgeAttrs {
        kind: EdgeKind::Vertical,
        rank: PathwayRank::Primary,
        clearance_m: None,
        vertical: Some(VerticalKind::Elevator),
    };
    doc.graph = Some(RouteGraph {
        nodes: vec![/* two nodes, ordinals 0 and 1 */],
        edges: vec![edge],
    });
    let bytes = encode_bundle(&doc).unwrap();
    let decoded = decode_bundle(&bytes).unwrap();
    assert_eq!(decoded.capabilities.graph_attrs().state_available());
    assert_eq!(
        decoded.graph.unwrap().edges[0].attrs.vertical,
        Some(VerticalKind::Elevator)
    );
}

#[test]
fn default_imported_graph_does_not_emit_section_12() {
    // two-node one-edge default attrs
    let bytes = encode_bundle(&doc_with_default_graph()).unwrap();
    let decoded = decode_bundle(&bytes).unwrap();
    assert!(matches!(
        decoded.capabilities.graph_attrs(),
        SectionCapability::Absent
    ));
}

#[test]
fn length_mismatch_invalidates_attrs_not_the_graph() {
    // hand-craft §12 with 0 rows against a 1-edge §5
    let decoded = decode_bundle(&crafted).unwrap();
    assert!(decoded.graph.unwrap().edges[0].attrs.is_default());
    assert!(matches!(
        decoded.capabilities.graph_attrs(),
        SectionCapability::Invalid { .. }
    ));
}
```

Use the existing `minimal_document` / `payload_with_rows` helpers already in `sections.rs` tests. `state_available()` above is illustrative — assert with `matches!(…, SectionCapability::Available)`.

- [ ] **Step 2: Run the new tests — they fail (`SECTION_GRAPH_ATTRS` missing)**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle graph_attrs_section -- --nocapture`

Expected: FAIL compile or test not found.

- [ ] **Step 3: Implement format + encode/decode + capability + clip copy**

`declared_dependencies`:

```rust
SECTION_GRAPH_ATTRS => (&[SECTION_GRAPH], &[]),
```

`encode_bundle`: after §5, if `graph.edges.iter().any(|e| !e.attrs.is_default())`, push `(SECTION_GRAPH_ATTRS, SECTION_VERSION, encode_graph_attrs(graph))`.

`decode_bundle`: `classify_section(…, SECTION_GRAPH_ATTRS, decode_graph_attrs)`. If `Available` and length matches, write attrs onto the already-decoded graph. Never fail the bundle for §12.

- [ ] **Step 4: Export and re-import the four properties**

`export.rs` `path_feature` adds:

```json
"EDGE_KIND": "vertical",
"PATHWAY_RANK": 1,
"CLEARANCE_M": null,
"TRANSITION_CATEGORY": "elevator"
```

`build.rs` after constructing the edge:

```rust
edge.attrs = attrs_from_properties(&feature.properties);
```

`attrs_from_properties` maps the four keys; unknown / missing → `Default`. Add a focused `build.rs` test: a path with `EDGE_KIND=skeleton` and `PATHWAY_RANK=2` round-trips those attrs.

- [ ] **Step 5: Update the wasm DTO pin**

`CapabilityReportDto` gains `graphAttrs: SectionCapability`. Existing fixture assertions add `graphAttrs: { state: "absent" }`.

- [ ] **Step 6: Run focused tests**

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle graph_attrs -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-route
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
pnpm exec vitest run src/bundle/wasm.test.ts
```

Expected: PASS. Golden `tests/fixtures/stage0.kvb` still decodes; its graph (if any) has default attrs and `graphAttrs: absent`.

- [ ] **Step 7: Commit**

```bash
git add core/crates/kiriko-bundle core/crates/kiriko-route src/bundle
git commit -m "feat(bundle): optional §12 graph attrs without bumping §5"
```

### Task 7: Tag synthesizer edges with kind and clearance

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (every `edges.push`)
- Modify: `core/crates/kiriko-bundle/src/synth.rs` (hub / opening / vertical pushes)

**Interfaces:**
- Consumes: Task 5 constructor + Task 6 wire.
- Produces: generated edges that actually populate §12.

| Emit site | `kind` | `clearance_m` | `vertical` |
|---|---|---|---|
| skeleton segment | `Skeleton` | midpoint `boundary_clearance_m` | None |
| midpoint↔stub | `Stub` | None | None |
| stub/mid → centerline | `Doorway` | None | None |
| near-blob bridge | `Bridge` | midpoint clearance | None |
| shortcut chord | `Chord` | None (open-space already gated) | None |
| transit centroid → door | `TransitAttach` | None | None |
| cross-floor pair | `Vertical` | None | Elevator/Escalator/Stairs |
| `synth.rs` opening↔hub / hub↔hub | `Doorway` / `Skeleton` | None | None |
| `synth.rs` vertical | `Vertical` | None | from category |

- [ ] **Step 1: Write a failing medial test that a corridor edge is `Skeleton` with some clearance**

Use the existing two-walkway + opening fixture (`doorway` tests). After `synthesize_network_medial`:

```rust
assert!(
    build.graph.edges.iter().any(|e| e.attrs.kind == EdgeKind::Skeleton
        && e.attrs.clearance_m.is_some_and(|c| c > 0.0)),
    "centerline edges carry measured clearance"
);
assert!(
    build.graph.edges.iter().any(|e| e.attrs.kind == EdgeKind::Vertical),
    "stacked transit is typed Vertical"
);
```

Pick a fixture that already asserts a vertical exists (`synthesis_is_deterministic` / transit tests).

- [ ] **Step 2: Run it — FAIL because every edge is still `Imported`**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen skeleton_edges_carry_kind -- --nocapture`

- [ ] **Step 3: Set `attrs` at each `edges.push`. Do not change weights yet.**

- [ ] **Step 4: Re-run the test and the existing doorway / transit / determinism tests**

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen doorway_
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen synthesis_is_deterministic
```

Expected: PASS. Determinism still holds (attrs are a pure function of the same geometry).

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs core/crates/kiriko-bundle/src/synth.rs
git commit -m "feat(synth): tag generated edges with kind and clearance"
```

---

## Phase 2 — P2 Connection-style vertical cost

### Task 8: Replace `horiz + {3,4,5}` with entry + per-floor cost

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth.rs` (`floor_cost` → `vertical_cost_m`)
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (same helper, delete local `floor_cost`)
- Test: existing vertical-weight assertions in both files

**Interfaces:**
- Consumes: P0 matcher output `(lower, upper, horizontal_distance_m)` — **ignore the distance for weight**.
- Produces:

```rust
pub(crate) fn vertical_cost_m(kind: VerticalKind, lower_ord: f64, upper_ord: f64) -> f64 {
    let floors = (upper_ord - lower_ord).abs();
    let (entry, per_floor) = match kind {
        VerticalKind::Elevator => (15.0, 1.0),
        VerticalKind::Escalator => (0.0, 4.0),
        VerticalKind::Stairs => (0.0, 10.0),
    };
    entry + floors * per_floor
}
```

Put the function in `synth.rs` (already compiled without `netgen`) and call it from `synth_medial.rs`. Category `"elevator"|"escalator"|_` → the enum.

Then the existing single `meters_to_cost` loop. Stacked elevator one floor: weight = `meters_to_cost(16.0)`. Stairs one floor: `meters_to_cost(10.0)`.

- [ ] **Step 1: Change the existing vertical-weight assertion to the new numbers and watch it fail**

In `synth.rs` / `synth_medial.rs` tests that currently check `d + floor_cost`:

```rust
let vertical = build.graph.edges.iter()
    .find(|e| e.attrs.kind == EdgeKind::Vertical)
    .expect("vertical");
assert_eq!(vertical.weight, meters_to_cost(16.0)); // elevator, Δord = 1
```

If the current test only checks `edges.len()`, add this assert.

- [ ] **Step 2: Run — FAIL (weight is still `horiz + 3`)**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen vertical -- --nocapture`

- [ ] **Step 3: Implement `vertical_cost_m` and use it at both synthesizers' vertical emit sites. Do not add `horizontal_distance_m`.**

- [ ] **Step 4: Add a same-kind two-floor stairs case: `meters_to_cost(20.0)` (`0 + 2×10`).**

- [ ] **Step 5: Run synthesizer tests**

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/crates/kiriko-bundle/src/synth.rs core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "feat(synth): cost verticals as entry plus per-floor metres"
```

---

## Phase 3 — P1 query-time greedy-LOS

### Task 9: `smooth_route` in `kiriko-route` (no `geo`)

**Files:**
- Create: `core/crates/kiriko-route/src/smooth.rs`
- Modify: `core/crates/kiriko-route/src/lib.rs` (`mod smooth; pub use smooth::{WalkableFloor, WalkablePolygon, smooth_route};`)

**Interfaces:**
- Consumes: `Route` from `route()`.
- Produces:

```rust
pub struct WalkablePolygon {
    pub exterior: Vec<[f64; 2]>,
    pub holes: Vec<Vec<[f64; 2]>>,
}

pub struct WalkableFloor {
    pub ordinal: f64,
    pub polygons: Vec<WalkablePolygon>,
    pub locks: Vec<[f64; 2]>,
}

pub fn smooth_route(route: Route, floors: &[WalkableFloor]) -> Route
```

Rules (spec §5): per segment, greedy farthest visible vertex; sample chord ≤ 0.5 m; `SEGMENT_OUTSIDE_TOL_M = 0.3`; do not skip a lock within `DOOR_LOCK_M = 0.4` m of an intermediate vertex; do not merge segments; `total_weight` unchanged. Empty `floors` → identity.

Reuse `haversine_m` already in `query.rs` by moving it to `graph.rs` (or a tiny `geo_math.rs` in this crate) so smooth and query share one function. Do not import `geo`.

- [ ] **Step 1: Write failing tests in `smooth.rs`**

```rust
fn hall() -> WalkableFloor {
    // 20 m × 4 m hall along lon, no holes
    WalkableFloor {
        ordinal: 0.0,
        polygons: vec![WalkablePolygon {
            exterior: rect(/* ... */),
            holes: vec![],
        }],
        locks: vec![],
    }
}

#[test]
fn empty_floors_is_identity() {
    let r = jagged_route();
    assert_eq!(smooth_route(r.clone(), &[]), r);
}

#[test]
fn pulls_a_sawtooth_to_the_chord_inside_a_hall() {
    let r = route_with_three_colinear_plus_one_detour();
    let out = smooth_route(r.clone(), &[hall()]);
    assert!(out.segments[0].coordinates.len() < r.segments[0].coordinates.len());
    assert_eq!(out.total_weight, r.total_weight);
}

#[test]
fn does_not_skip_a_door_lock() {
    let door = [/* midpoint of an opening on the path */];
    let mut floor = hall();
    floor.locks.push(door);
    let out = smooth_route(route_through(door), &[floor]);
    assert!(out.segments[0].coordinates.iter().any(|c| haversine_m(*c, door) < 0.4));
}

#[test]
fn does_not_cross_a_hole() {
    // hall with a kiosk hole; a chord through the hole is illegal
    let out = smooth_route(route_around_kiosk(), &[hall_with_hole()]);
    assert!(chord_misses_hole(&out));
}
```

- [ ] **Step 2: Run — FAIL (`smooth_route` missing)**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route smooth_ -- --nocapture`

- [ ] **Step 3: Implement PIP + sampled segment test + greedy scan**

Point-in-polygon: even-odd on the exterior, subtract holes. "Inside" includes `tol_m` via distance-to-boundary (copy the numeric idea from `synth.rs::point_boundary_dist_m` / `point_seg_dist_m` — reimplement in this crate, do not depend on bundle).

- [ ] **Step 4: Run the smooth tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-route
git commit -m "feat(route): greedy-LOS string-pull against walkable floors"
```

### Task 10: Build `WalkableFloor`s from the venue and call them from wasm

**Files:**
- Create: `core/crates/kiriko-bundle/src/walkable.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs` (`mod walkable;`)
- Modify: `core/crates/kiriko-wasm/src/lib.rs` (`route_in_document`)
- Test: `core/crates/kiriko-bundle/src/walkable.rs`
- Test: existing `routeBundle` worker tests stay green (smoothing is a no-op without walkways)

**Interfaces:**
- Consumes: `BundleDocument` units + openings + transit units; `is_walkway` category list (duplicate the match list in `walkable.rs` with the same comment: keep in sync with `synth.rs`).
- Produces: `Vec<WalkableFloor>` for `smooth_route`.
- `route_in_document`:

```rust
let raw = kiriko_route::route(graph, origin, dest)?;
let floors = crate::walkable::walkable_floors(document);
Some(RouteDto::from(kiriko_route::smooth_route(raw, &floors)))
```

Native compile path does not need to call this (routing is client-side). Add a `pub fn route_smoothed(document, origin, dest)` on the bundle crate for tests.

Locks: opening midpoints (`linestring_midpoint`) and transit centroids on that ordinal.

- [ ] **Step 1: Failing test — a two-unit corridor with a sawtooth graph path loses interior vertices after `route_smoothed`**

Build a tiny `BundleDocument` (same helper `synth.rs` tests use) with one walkway rectangle and a hand-built graph that zigzags inside it. Assert smoothed coordinate count < raw.

- [ ] **Step 2: Run — FAIL (`walkable_floors` missing)**

- [ ] **Step 3: Implement `walkable_floors` + wire wasm**

- [ ] **Step 4: Run**

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle walkable
cargo test --manifest-path core/Cargo.toml -p kiriko-wasm
pnpm exec vitest run src/bundle/bundle.worker.test.ts
```

Expected: PASS. Worker contract unchanged (`type: "routed"`).

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-bundle/src/walkable.rs core/crates/kiriko-bundle/src/lib.rs core/crates/kiriko-wasm/src/lib.rs
git commit -m "feat(route): smooth wasm routes against venue walkable floors"
```

---

## Phase 4 — P3 hallway rank

### Task 11: Secondary-rank edges that sit in non-walkway units

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (post-emit, pre-`meters_to_cost`)
- Test: new fixture in `synth_medial.rs` tests

**Interfaces:**
- Consumes: floor's unit polygons + already-tagged horizontal edges.
- Produces: `rank = Secondary` and `weight *= 3.0` on `Skeleton` / `Bridge` / `Chord` midpoints that fall inside a non-walkway, non-transit unit. Doorway / stub / transit-attach / vertical never classified.
- Factor applied on **metres**, before the global `meters_to_cost` loop.

- [ ] **Step 1: Write a failing fixture**

One walkway rectangle, one `room` rectangle sharing a long edge, an opening between them, and a skeleton that (because the room is **not** in `navigable_area`) should not enter the room — so also add a **forced** case: include the room in walkables temporarily? No. P3 ranks edges whose midpoint is in a non-walkway unit. The medial axis is built only from walkways, so a skeleton midpoint is almost never inside a room.

To make the test real: build a walkway that **overlaps** a `room` polygon (sloppy IMDF, which happens on GDB conversion). Midpoint of the overlapping skeleton segment sits in the room → secondary.

```rust
#[test]
fn skeleton_through_a_room_is_secondary_and_tripled() {
    // walkway and room overlap on the east half
    let build = synthesize_network_medial(&doc);
    let secondary: Vec<_> = build.graph.edges.iter()
        .filter(|e| e.attrs.rank == PathwayRank::Secondary)
        .collect();
    assert!(!secondary.is_empty());
    // compare against metres-to-cost of 3× the haversine of endpoints
    for e in secondary {
        let metres = haversine_m(
            [build.graph.nodes[e.from as usize].lon, build.graph.nodes[e.from as usize].lat],
            [build.graph.nodes[e.to as usize].lon, build.graph.nodes[e.to as usize].lat],
        );
        assert!((e.weight - meters_to_cost(metres * 3.0)).abs() < 1.0);
        assert!(matches!(e.attrs.kind, EdgeKind::Skeleton | EdgeKind::Bridge | EdgeKind::Chord));
    }
}
```

- [ ] **Step 2: Run — FAIL (no secondary edges)**

- [ ] **Step 3: After each floor's horizontal emit (after chords and transit attaches, before the floor loop ends), classify. Verticals are added after all floors — they never see this pass.**

PIP: use `geo::Contains` on the unit polygon (this file already has `netgen` / `geo`). Midpoint of `from`/`to` (ignore interior; generated edges are straight).

- [ ] **Step 4: Assert doorway edges in the same fixture stay Primary.**

- [ ] **Step 5: Run medial tests**

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen skeleton_through_a_room
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen doorway_
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "feat(synth): rank room-crossing centerlines secondary"
```

---

## Phase 5 — P4 obstacles

### Task 12: Subtract non-walkable units, fixtures, kiosks, and buffered details

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs` (`navigable_area(&walk, &obstacles)`, obstacle collection, line buffer)
- Test: new fixtures in the same file

**Interfaces:**
- Consumes: per-floor `FeatureType::Unit` (not walkway, not transit), `Fixture`, `Kiosk` polygons; `Detail` lines.
- Produces: those geometries as the second argument to existing `navigable_area`.
- `OBSTACLE_BUFFER_M = 0.4`. Stadium buffer: for each detail segment, a rectangle of half-width 0.4 m in the local metre frame at the segment midpoint's latitude, plus disc end-caps, converted back to lon/lat rings. Degenerate segments skipped.
- No new crate. `MIN_PASSAGE_M` prune stays.

- [ ] **Step 1: Write two failing tests**

```rust
#[test]
fn fixture_hole_breaks_a_centerline_that_used_to_cross_it() {
    // wide walkway, rectangular fixture in the middle
    let build = synthesize_network_medial(&doc);
    assert!(
        !build.graph.edges.iter().any(|e| segment_crosses_fixture(e, &build.graph)),
        "no edge chords through the fixture"
    );
}

#[test]
fn detail_line_buffer_blocks_a_sub_metre_pinch() {
    // walkway with a detail wall leaving a 0.5 m gap (< MIN_PASSAGE after buffer)
    let build = synthesize_network_medial(&doc);
    assert!(
        build.graph.edges.is_empty() || component_count(&build.graph) > 1,
        "buffered wall pinches the passage"
    );
}
```

- [ ] **Step 2: Run — FAIL (centerline still crosses; `navigable_area(&walk, &[])`)**

- [ ] **Step 3: Collect obstacles and pass them in. Implement `buffer_detail_line(a, b) -> Option<Polygon>` next to `navigable_area`.**

Collection loop (same floor scan as walk/openings/transit):

```rust
FeatureType::Unit if !is_walkway(cat) && !is_transit(cat) => obstacles.push(geom),
FeatureType::Fixture | FeatureType::Kiosk => obstacles.push(geom),
FeatureType::Detail => { /* push each segment's stadium if Some */ }
```

- [ ] **Step 4: Run the new tests plus `unenclosedarea` existing tests (shop interiors must still not become walkable).**

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen fixture_hole
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen detail_line_buffer
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen unenclosed
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "feat(synth): subtract units, fixtures, kiosks, and buffered details"
```

---

## Phase 6 — Docs and gates

### Task 13: Reference docs + full verification

**Files:**
- Modify: `docs/gdb-data-reference.md` (KVB sections list: optional §12; generate-network notes: lazy stubs, 1-1 verticals, Connection costs, rank, obstacles; query: greedy-LOS after A*)
- Modify: `docs/superpowers/reports/2026-08-13-indoor-network-generation-vs-kiriko.md` status line only if you want "planned → implementing" — skip unless you are already there.

- [ ] **Step 1: Update `docs/gdb-data-reference.md` in the KVB section list and the Routing paragraph. Do not invent measured Tokyo numbers.**
- [ ] **Step 2: Full gates**

```bash
cargo test --manifest-path core/Cargo.toml --workspace
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
pnpm exec tsc --noEmit
pnpm --dir server exec tsc --noEmit
pnpm exec vitest run
pnpm --dir server exec vitest run
```

Expected: all pass. Rebuild native/wasm before any manual viewer check (`pnpm core:build`).

- [ ] **Step 3: Optional local Shibuya acceptance (do not commit `.diag`)**

If `.diag/shibuya-source.zip` exists, regenerate and run the offshoot detector as in the P0 stub plan. Expect 0 doorway-stub foldbacks and 0 vertical fan-in.

- [ ] **Step 4: Commit docs**

```bash
git add docs/gdb-data-reference.md
git commit -m "docs: record §12 attrs, vertical costs, and generate-network quality"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| P0 lazy stubs | 1 (existing plan) |
| P0 opening diagnostics | 2 (existing plan) |
| P0 1-1 matching | 3 (existing plan) |
| P0 vertical presentation | 4 (existing plan) |
| `EdgeAttrs` + default imported | 5 |
| §12, no §5 bump, capability | 6 |
| Kind/clearance on emit | 7 |
| Connection vertical cost | 8 |
| `smooth_route` + door locks | 9–10 |
| Hallway rank ×3 | 11 |
| Obstacle subtract + 0.4 m detail buffer | 12 |
| Docs / gates | 13 |
| No lattice, no Tokyo regen, no new WarningCode | Global constraints |

## Type consistency

- `EdgeKind` / `PathwayRank` / `VerticalKind` / `EdgeAttrs` live in `kiriko-route` and are the only names later tasks use.
- §12 id is `SECTION_GRAPH_ATTRS = 12`. TS field is `graphAttrs`.
- `vertical_cost_m(kind, lower_ord, upper_ord) -> f64` is the only vertical weight helper after Task 8.
- `smooth_route(Route, &[WalkableFloor]) -> Route` does not change `total_weight`.
- Export strings: `imported|skeleton|doorway|stub|bridge|chord|vertical|transit_attach`.
