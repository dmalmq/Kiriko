# Routing Quality Without a Dual Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve generated-route smoothness and path choice without a second generator: measure greedy-LOS and hall wander, add RDP only if corners still hug, treat one-off misses as Smart Connect, and only then add destination-anchored chords.

**Architecture:** One medial-axis spine stays authoritative. Query-time greedy-LOS remains the default smoother. A diagnostic `evaluate_routes` report (not a KVB section, not a publish gate) produces numbers that decide two later phases. Optional `smooth_route_rdp` is Rust-only and never becomes the wasm default in this plan. Optional destination chords are a second *overlay* on the existing graph (opening and transit anchors only); anonymous `shortcut_chords` and `CHORD_MIN_CLEARANCE_M = 5.0` do not change. Smart Connect is already the human picker — this plan does not re-build it.

**Tech Stack:** Rust 2024 workspace (`kiriko-route`, `kiriko-bundle`, `kiriko-wasm` only if a later gate forces a bind), existing `examples/analyze_synth.rs`, Vitest unused except where a task names it, bilingual `ui` pairs if any string is added (this plan adds none unless a task says so).

**Spec:**
- Research / sequencing: `docs/superpowers/reports/2026-08-17-routing-graph-quality-next.md`
- Generated spine (already shipped): `docs/superpowers/specs/2026-08-13-generated-network-quality-design.md`
- Smart Connect (already shipped): `docs/superpowers/specs/2026-08-18-smart-connect-network-editor-design.md`
- Shipped query-time plan (do not re-implement Phases 1–4): `docs/superpowers/plans/2026-08-17-routing-graph-quality-next.md`
- Shipped editor plan: `docs/superpowers/plans/2026-08-18-smart-connect-network-editor.md`
- Why not two generators: session discussion; do not add a lattice, UCN spine, visibility graph, or merge.

## Global Constraints

- TDD. Watch each focused test fail before production code. One commit per task.
- Do **not** generate two graphs and merge them. Do **not** replace `synth_medial`.
- Do **not** re-implement quality-next Phases 1–4 (`RouteProfile`, §13, Opening flags, §11) or Smart Connect (`propose_paths`, preview, box-select). They are in the tree.
- Do **not** regenerate Tokyo imported graphs with `synth_medial`.
- Do **not** add build-time open-space chords by lowering `CHORD_MIN_CLEARANCE_M` for anonymous skeleton pairs. Corridor-only venues must keep zero anonymous chords (`chord_needs_open_space`).
- Do **not** change `Route.total_weight` meaning. Smoothing is geometry only.
- Do **not** emit new KVB section fields. Eval stays in-memory / example. §11 stretch stays as-is.
- Do **not** switch wasm off greedy-LOS. RDP, if built, is `smooth_route_rdp` + unit tests only.
- Do **not** add `RouteProfile.zones` in this plan (still needs a producer spill/closure story).
- Absence is never success: a skipped venue or empty sample is `None` / a written “not measured”, never `0`.
- Bilingual UI: this plan adds no user-facing strings. If a later task is forced to, it must add a `ui` pair `{ ja, en }`.
- New `WarningCode`s: none. No TS allowlist change.
- Isolated worktree (if used) is created at execution time via `using-git-worktrees`.
- Skip formatters / linters / full-workspace suites unless a step names them.

## Baseline already shipped — do not re-implement

| Point | In tree |
|---|---|
| 1. Query-time smoothness | `kiriko-route/src/smooth.rs` `smooth_route` (greedy-LOS, `DOOR_LOCK_M = 0.4`, `SEGMENT_OUTSIDE_TOL_M = 0.3`). Wasm / `walkable.rs` already call it. **RDP is not shipped.** |
| 2. Route choice as costs / ranks / profiles / flags | `RouteProfile` + `route_with` + wheelchair chip; `EdgeFlags` (direction, barrier, hours, wheelchair); §13; Opening width → doorway `clearance_m`; Opening `accessibility[]` → flags; Relationship direction; hallway rank baked into synth weight (`SECONDARY_RANK_FACTOR`); Connection-style verticals; §11 findings + Review copy. |
| 3. Generation-missed shortcut = human picker | `propose_paths` + wasm `proposeNetworkPaths` + editor preview / confirm / Select this route / box-select. Confirm is add-only. |
| 4. Open-hall chords | `shortcut_chords` with `CHORD_MIN_M = 10`, `CHORD_MAX_M = 40`, `CHORD_SAVINGS_RATIO = 0.7`, `CHORD_MIN_SAVINGS_M = 15`, `CHORD_MIN_CLEARANCE_M = 5.0`, `CHORD_MAX_PER_NODE = 2`. Corridor half-width ~3 m is rejected by design. |

## File structure

| File | Responsibility |
|---|---|
| `core/crates/kiriko-route/src/smooth.rs` | Existing greedy-LOS; Task 4 adds `smooth_route_rdp` |
| `core/crates/kiriko-route/src/lib.rs` | Re-export `smooth_route_rdp` only if Task 4 runs |
| `core/crates/kiriko-bundle/src/route_eval.rs` | In-memory route-quality report (new, Task 1) |
| `core/crates/kiriko-bundle/src/lib.rs` | `mod route_eval` + re-export `evaluate_routes` |
| `core/crates/kiriko-bundle/examples/analyze_synth.rs` | Print the report (Task 1) |
| `docs/superpowers/reports/2026-08-19-route-quality-gates.md` | Go / no-go numbers (Task 2) |
| `core/crates/kiriko-bundle/src/synth_medial.rs` | Task 5 only: destination-anchored overlay after transit attach |

Do not add a crate. Do not touch `src/app/App.tsx` in this plan.

## Spec decisions (locked here; do not re-open)

1. **Measure before changing generation or the smoother.** Tasks 3–5 are gated on Task 2’s written report. If the report is missing, later tasks do not start.
2. **Gate A (RDP):** start Task 4 only if a real generated venue (JR Takanawa or Shibuya, not Tokyo imported) still has leftover near-wall vertices after greedy-LOS on wheelchair-width routes (`min_clearance_m = 0.8`), and those leftovers are *corners the chord could legally cut* (not door locks). Write `rdp: yes` or `rdp: no` in the report.
3. **Gate B (destination chords):** start Task 5 only if the same venue still shows open-hall wander (same-floor `ρ` high *and* a named pair whose medial rings a kiosk / island) **and** Smart Connect can propose the missing diagonal (so we know the walkable geometry allows it) **and** that class is systematic (more than one pair / floor), not a single producer residual. Write `destination_chords: yes` or `no`.
4. **Smart Connect wins one-offs.** A single “A to B should cut the hall” on one floor is editor work. Do not loosen generation for it.
5. **Destination chords ≠ lowering the 5 m gate.** Anonymous skeleton pairs keep `CHORD_MIN_CLEARANCE_M = 5.0`. The new pass only considers doorway-mid and transit-centroid nodes, uses passage-width passability (`MIN_PASSAGE_M / 2 = 0.4 m`), keeps the 10–40 m / 0.7 / +15 m savings / 2-per-node caps, and treats other anchors as locks so a chord cannot skip a door.
6. **Facilities are not anchors.** Thin-to-POIs stays unsafe until facilities are true graph attachments (quality-next out of scope).
7. **Heuristic stays 2D `k * haversine`.** Do not switch to 3D.
8. **Zones, GATE-as-restriction, hours UI, editor rank widgets** stay out of this plan.

---

## Phase 0 — Measurement (always)

### Task 1: In-memory route-quality report

**Files:**
- Create: `core/crates/kiriko-bundle/src/route_eval.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs`
- Modify: `core/crates/kiriko-bundle/examples/analyze_synth.rs`

**Interfaces:**
- Consumes: `BundleDocument` (`graph`, `walkable_floors(document)`), `kiriko_route::{route_with, smooth_route, RouteProfile, EdgeKind}`
- Produces:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct SmoothingSample {
    pub raw_vertices: u32,
    pub smoothed_vertices: u32,
    pub raw_length_m: f64,
    pub smoothed_length_m: f64,
    pub leftover_near_wall: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RouteQualityReport {
    pub pair_count: u32,
    pub routed_count: u32,
    pub vertex_retention: Option<f32>,
    pub length_ratio: Option<f32>,
    pub leftover_near_wall_max: Option<u32>,
    pub leftover_near_wall_mean: Option<f32>,
    pub stretch_rho_max: Option<f32>,
    pub stretch_sample_count: u32,
    pub chord_edges: u32,
}

pub fn evaluate_routes(document: &BundleDocument) -> RouteQualityReport
```

Semantics (lock these):

- If `document.graph` is `None`, return a report with every count `0` and every `Option` `None`. That is *absence*, not a successful empty graph.
- Sample up to **50** same-floor node pairs with Euclidean distance in `(10 m, 40 m]`, same selection order as `network_qa::stretch_summary` (sorted node indices, first 50 that connect). Do not invent a second sampler.
- For each pair: `route_with(..., &RouteProfile::wheelchair())` so leftover corners are judged at `min_clearance_m = 0.8`. Skip (`routed_count` does not increment) when `None`.
- `raw_*` from the unsmoothed `Route` polyline (all segments concatenated). `smoothed_*` from `smooth_route(raw, &walkable_floors(document))`.
- Polyline length = sum of haversine consecutive vertices. Do **not** use `total_weight`.
- `leftover_near_wall`: count of *smoothed* vertices whose distance to the matching floor’s walkable exterior-or-hole boundary is `< 0.6 m` **and** that are not within `0.4 m` of a `WalkableFloor.locks` point. Unknown floor → do not count (do not treat as 0 leftovers).
- Aggregates over successful routes only: `vertex_retention = sum(smoothed_vertices) / sum(raw_vertices)`, `length_ratio = sum(smoothed_length_m) / sum(raw_length_m)`. If `routed_count == 0`, those `Option`s are `None`.
- `stretch_rho_max` / `stretch_sample_count`: call the existing `analyze_network` and copy `stretch` (`None` → `stretch_rho_max = None`, `stretch_sample_count = 0`).
- `chord_edges`: count of `graph.edges` with `attrs.kind == EdgeKind::Chord`. That is a measured count of a real kind. If the graph has no §12 attrs (imported Tokyo), this is legitimately `0` because those edges are `Imported` — do not invent chords.

- [ ] **Step 1: Write the failing tests** in `route_eval.rs` `mod tests`.

Build a tiny `BundleDocument` the same way `network_qa.rs` tests do (hand `RouteGraph` + one walkway unit polygon + one Opening lock). Reuse that fixture style; do not depend on a real IMDF.

```rust
#[test]
fn evaluate_routes_without_a_graph_is_absent_not_zero_success() {
    let doc = empty_document(); // graph: None
    let r = evaluate_routes(&doc);
    assert_eq!(r.pair_count, 0);
    assert_eq!(r.routed_count, 0);
    assert_eq!(r.vertex_retention, None);
    assert_eq!(r.length_ratio, None);
    assert_eq!(r.leftover_near_wall_max, None);
    assert_eq!(r.leftover_near_wall_mean, None);
    assert_eq!(r.stretch_rho_max, None);
    assert_eq!(r.chord_edges, 0);
}

#[test]
fn evaluate_routes_counts_a_smoothed_sawtooth_and_a_chord() {
    // Same-floor nodes A(0,0) and C(40,0) with a V-detour via B(20,-15)
    // inside a 30 m-wide hall. One Chord A–C. Wheelchair must still route
    // (clearance None is allowed). After LOS the V vertex should drop.
    let doc = hall_with_detour_and_chord();
    let r = evaluate_routes(&doc);
    assert!(r.routed_count >= 1);
    assert_eq!(r.chord_edges, 1);
    let retention = r.vertex_retention.expect("routed");
    assert!(
        retention < 1.0,
        "LOS must drop the detour vertex, retention={retention}"
    );
    assert!(r.length_ratio.expect("routed") <= 1.0);
}

#[test]
fn leftover_near_wall_ignores_door_locks() {
    // A smoothed vertex sitting on an Opening midpoint must not count as
    // leftover_near_wall even if it is within 0.6 m of the wall.
    let doc = corridor_with_door_lock_on_path();
    let r = evaluate_routes(&doc);
    assert_eq!(
        r.leftover_near_wall_max,
        Some(0),
        "a lock is not a hugged corner"
    );
}
```

Implement the three fixture helpers next to the tests. `hall_with_detour_and_chord` must set `EdgeAttrs { kind: EdgeKind::Chord, ..Default::default() }` on the A–C edge and `clearance_m: None` on every edge. Walkable polygon must contain the V and the chord. Put an Opening feature whose midpoint is *not* on the V vertex for this test.

- [ ] **Step 2: Run tests — they fail because `route_eval` does not exist**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle -- evaluate_routes leftover_near_wall`

Expected: compile error (`route_eval` / `evaluate_routes` missing).

- [ ] **Step 3: Implement `evaluate_routes`**

`lib.rs`: `mod route_eval; pub use route_eval::{RouteQualityReport, SmoothingSample, evaluate_routes};`

Implementation notes:

- Import `walkable_floors` from `crate::walkable`.
- Import `analyze_network` from `crate::network_qa` for stretch. Do not duplicate Dijkstra.
- Near-wall distance: reuse the same local-metre idea as `synth_medial::boundary_clearance_m` (equirectangular at the point). If you cannot reach that private fn, copy a 15-line helper into `route_eval.rs` — do not make `boundary_clearance_m` public just for this.
- `WalkableFloor` has `polygons` with `exterior` + `holes`. Distance to boundary is min distance to any ring of the matching ordinal. No matching floor → skip that vertex (do not increment leftover).

- [ ] **Step 4: Re-run the three tests**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle -- evaluate_routes leftover_near_wall`

Expected: PASS.

- [ ] **Step 5: Print the report from `analyze_synth`**

After the example already prints attachment stats, if a graph is present call `evaluate_routes` and print one line per field. Use the word `absent` when an `Option` is `None`. Never print `0.0` for a missing ratio.

```text
route_eval pair_count=12 routed_count=12 vertex_retention=0.61 length_ratio=0.88 leftover_near_wall_max=2 leftover_near_wall_mean=0.4 stretch_rho_max=1.8 stretch_sample_count=50 chord_edges=7
```

or

```text
route_eval pair_count=0 routed_count=0 vertex_retention=absent length_ratio=absent leftover_near_wall_max=absent leftover_near_wall_mean=absent stretch_rho_max=absent stretch_sample_count=0 chord_edges=0
```

No new clap flags required; the existing `analyze_synth <imdf.zip|bundle.kvb>` entry is enough.

- [ ] **Step 6: Commit**

```text
feat(bundle): in-memory route-quality report for LOS and chords
```

---

### Task 2: Write the go / no-go report

**Files:**
- Create: `docs/superpowers/reports/2026-08-19-route-quality-gates.md`

**Interfaces:**
- Consumes: Task 1’s `analyze_synth` output on a **generated** venue (JR Takanawa or Shibuya IMDF → `synthesizeNetwork: true`, or an already-generated `.kvb`). Tokyo imported `network_WebMercator.gdb` is the wrong ceiling — do not use it to decide RDP or chords.
- Produces: the markdown file below, with real numbers or an explicit `not measured`.

- [ ] **Step 1: Run the diagnostic**

```text
cargo run --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen --example analyze_synth -- <path-to-generated-venue>
```

If the archive is not on this machine, write the report with every numeric field `not measured` and both gates `no`. Do **not** invent numbers. Do **not** treat a missing venue as `ρ = 0`.

- [ ] **Step 2: Exercise Smart Connect on any named wander pair**

In the running app (network review / editor), pick the two ends of a hall that still looks wrong after Directions + Wheelchair. Confirm whether Smart Connect offers a `shorter` candidate. Write yes/no per pair. This is evidence for Gate B, not a code change.

- [ ] **Step 3: Write the report** using this exact skeleton (fill the blanks; delete the comments):

```markdown
# Route quality gates

**Date:** 2026-08-19
**Venue:** <name or "not measured">
**Source:** generated (`synth_medial`), not Tokyo imported

## analyze_synth

| Field | Value |
|---|---|
| pair_count |  |
| routed_count |  |
| vertex_retention |  |
| length_ratio |  |
| leftover_near_wall_max |  |
| leftover_near_wall_mean |  |
| stretch_rho_max |  |
| stretch_sample_count |  |
| chord_edges |  |

## Named pairs

| Pair | What looks wrong | LOS already cuts it? | Smart Connect `shorter`? | Class |
|---|---|---|---|---|
|  |  |  |  | one-off / systematic |

## Gates

- `rdp:` yes | no
- `destination_chords:` yes | no

### rdp = yes only if
leftover_near_wall_max ≥ 2 on wheelchair routes **and** at least one leftover is a corner (not a lock) that a 0.5 m RDP would drop.

### destination_chords = yes only if
stretch_rho_max ≥ 1.6 on a concourse-scale floor **and** ≥2 named pairs in the same class **and** Smart Connect already proposes `shorter` for those pairs (walkable geometry allows the diagonal; the stored graph does not).
```

- [ ] **Step 4: Commit**

```text
docs: record RDP and destination-chord go/no-go
```

**Stop.** Read the two gate lines. If `rdp: no`, skip Phase 1 (Task 4). If `destination_chords: no`, skip Phase 2 (Task 5). If both `no`, this plan is done after Task 2. One-off pairs stay Smart Connect.

---

## Phase 1 — Optional RDP (Gate A)

Skip this entire phase when the report says `rdp: no`.

### Task 4: `smooth_route_rdp` with locked doorways

**Files:**
- Modify: `core/crates/kiriko-route/src/smooth.rs`
- Modify: `core/crates/kiriko-route/src/lib.rs`

**Interfaces:**
- Consumes: existing `Route`, `WalkableFloor`, `chord_ok`, `DOOR_LOCK_M = 0.4`
- Produces:

```rust
pub fn smooth_route_rdp(route: Route, floors: &[WalkableFloor], epsilon_m: f64) -> Route
```

Rules:

- Per `RouteSegment`, independently (same as greedy-LOS: no merge across floors).
- Lock any vertex within `DOOR_LOCK_M` of a lock on the matching floor. Locked vertices are never dropped. Endpoints of the segment are locked.
- Run Ramer–Douglas–Peucker in the local metre frame at the first vertex’s latitude (`mx = 111_320.0 * lat.to_radians().cos()`, `my = 111_320.0`). Recurse only on unlocked spans.
- After RDP, drop a kept vertex if the chord of its two surviving neighbours fails `chord_ok` (walkable + locks). If it fails, put the vertex back. This keeps RDP from cutting a kiosk that the perpendicular-distance test missed.
- `total_weight`, `origin_projected`, `dest_projected` unchanged.
- Empty `floors` → identity (same as `smooth_route`).
- `epsilon_m <= 0` or non-finite → identity.
- Do **not** call this from wasm, `walkable.rs`, or `propose.rs`.

- [ ] **Step 1: Write the failing tests** in `smooth.rs` `mod tests` (same `pt` / `hall` helpers already there).

```rust
#[test]
fn rdp_drops_a_collinear_midpoint() {
    let route = Route {
        segments: vec![RouteSegment {
            ordinal: 0.0,
            coordinates: vec![pt(-8.0, 0.0), pt(0.0, 0.2), pt(8.0, 0.0)],
        }],
        total_weight: 42.0,
        origin_projected: [139.0, 35.0, 0.0],
        dest_projected: [139.0, 35.0, 0.0],
    };
    let out = smooth_route_rdp(route, &[hall()], 0.5);
    assert_eq!(out.segments[0].coordinates.len(), 2);
    assert_eq!(out.total_weight, 42.0);
}

#[test]
fn rdp_keeps_a_doorway_locked_midpoint() {
    let mid = pt(0.0, 0.2);
    let mut floor = hall();
    floor.locks.push(mid);
    let route = Route {
        segments: vec![RouteSegment {
            ordinal: 0.0,
            coordinates: vec![pt(-8.0, 0.0), mid, pt(8.0, 0.0)],
        }],
        total_weight: 42.0,
        origin_projected: [139.0, 35.0, 0.0],
        dest_projected: [139.0, 35.0, 0.0],
    };
    let out = smooth_route_rdp(route, &[floor], 0.5);
    assert_eq!(out.segments[0].coordinates.len(), 3);
}

#[test]
fn rdp_empty_floors_is_identity() {
    let r = jagged_route();
    assert_eq!(smooth_route_rdp(r.clone(), &[], 0.5), r);
}
```

- [ ] **Step 2: Run — fail because `smooth_route_rdp` is missing**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route -- rdp_`

Expected: compile error.

- [ ] **Step 3: Implement `smooth_route_rdp`.** Re-export from `lib.rs` next to `smooth_route`. Do not change `smooth_route`.

- [ ] **Step 4: Re-run**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-route -- rdp_ smooth_`

Expected: PASS (existing greedy-LOS tests unchanged).

- [ ] **Step 5: Commit**

```text
feat(route): optional RDP smoother with locked doorways
```

Kallmann r-funnel is **not** in this task. If RDP is still wrong on the gated venue, stop and write a follow-up spike note in the gates report. Do not add build-time chords to paper over it.

---

## Phase 2 — Optional destination chords (Gate B)

Skip this entire phase when the report says `destination_chords: no`.

### Task 5: Destination-anchored chord overlay

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs`

**Interfaces:**
- Consumes: the floor’s already-emitted `nodes` / `edges` after doorway stubs, bridges, anonymous `shortcut_chords`, and transit attach
- Produces: additional `RouteEdge`s with `attrs.kind == EdgeKind::Chord` (same kind; no new discriminant) between **anchor** nodes only

```rust
fn destination_chords(
    nodes: &[RouteNode],
    edges: &[RouteEdge],
    anchors: &[usize],
    area: &MultiPolygon<f64>,
    ordinal: f64,
) -> Vec<(usize, usize)>
```

Anchor set, per floor, after transit attach:

- every node that is an endpoint of an `EdgeKind::Doorway` edge (the opening midpoint; if both ends are stubs, use the midpoint node only — the node that is also the `from`/`to` of the Doorway edge against a stub/skeleton, i.e. the mid), and
- every node that is the transit-unit end of an `EdgeKind::TransitAttach` edge (the centroid pushed just before attach).

Practical collection: after the transit loop, scan `edges` for `Doorway` and `TransitAttach` and insert the doorway mid / transit centroid indices into a sorted `BTreeSet<usize>`. For a Doorway edge `mid ↔ side`, the mid is the endpoint that is **not** a `Stub` leaf. If both ends are ambiguous, include both (the savings + lock tests still apply).

Keep every anonymous constant:

- `CHORD_MIN_M = 10.0`
- `CHORD_MAX_M = 40.0`
- `CHORD_SAVINGS_RATIO = 0.7`
- `CHORD_MIN_SAVINGS_M = 15.0`
- `CHORD_MAX_PER_NODE = 2`

Do **not** apply `CHORD_MIN_CLEARANCE_M` / `chord_in_open_space` in this pass. Do apply `centerline_chord_passable` (passage width). Same ordinal only. Same connected component on the **full** floor graph (skeleton + doorways + bridges + anonymous chords + transit attach) so we never invent a free teleport across a door that does not exist. Seed adjacency with every already-emitted same-ordinal edge’s metre length (`haversine` of endpoints, plus interior if present — interiors are rare on generated edges; if `interior` is non-empty, sum the polyline).

Other anchors are locks: a candidate chord `i→j` is rejected if any *other* anchor `k` lies within `0.4 m` of the open segment `i–j` (same `point_seg_dist_m` the smoother uses). That is the “do not skip a door” rule.

Determinism: sort anchor pairs by `(min, max)` index. Cap 2 new destination chords incident on any node (count only this pass, not anonymous chords).

Emit with:

```rust
attrs: EdgeAttrs {
    kind: EdgeKind::Chord,
    clearance_m: clearance_attr(boundary_clearance_m(midpoint, &area)),
    ..EdgeAttrs::default()
}
```

Call site: **after** the transit-attach loop, still inside the per-floor block, before verticals. Verticals stay last.

- [ ] **Step 1: Write the failing tests** in `synth_medial.rs` `mod tests`.

Keep `chord_needs_open_space` exactly as it is — it must stay PASS and still prove a 6 m corridor gets **zero** anonymous chords.

Add:

```rust
#[test]
fn destination_chords_cut_a_concourse_between_two_doors() {
    // Wide hall (clearance ≫ 5 m is fine). Two doorway-mid anchors 30 m
    // apart. Medial is a V-detour via a kiosk. Full-graph path savings
    // must beat 15 m so a destination chord lands.
    let doc = concourse_two_doors_v_detour();
    let g = synthesize_network_medial(&doc).graph;
    let chords = g
        .edges
        .iter()
        .filter(|e| e.attrs.kind == EdgeKind::Chord)
        .count();
    assert!(
        chords >= 1,
        "expected a door-to-door chord across the concourse, got {chords}"
    );
}

#[test]
fn destination_chords_do_not_skip_a_third_door() {
    // Three openings in a line. A chord from door 1 to door 3 would pass
    // within 0.4 m of door 2 and must be rejected.
    let doc = three_doors_in_a_line();
    let g = synthesize_network_medial(&doc).graph;
    let long = g.edges.iter().any(|e| {
        e.attrs.kind == EdgeKind::Chord
            && haversine_m(
                [g.nodes[e.from as usize].lon, g.nodes[e.from as usize].lat],
                [g.nodes[e.to as usize].lon, g.nodes[e.to as usize].lat],
            ) > 25.0
    });
    assert!(!long, "1→3 chord skipped the middle door");
}

#[test]
fn destination_chords_do_not_unlock_corridor_anonymous_pairs() {
    // Replay the chord_needs_open_space geometry as a full synthesize if a
    // compact IMDF fixture is easy; otherwise call destination_chords
    // directly with anchors = [] or with two corridor-side door nodes
    // whose graph path already saves < 15 m (adjacent rooms).
    let pairs = destination_chords(&nodes, &edges, &anchors, &narrow_corridor, 0.0);
    assert!(pairs.is_empty());
}
```

Build the two IMDF-style fixtures with the existing `feature()` helper in this file (walkway polygon + Opening LineStrings). If a full-document fixture is too heavy for the third test, unit-test `destination_chords` directly with hand `RouteNode`/`RouteEdge` slices — that is preferred for the corridor case.

- [ ] **Step 2: Run — fail because `destination_chords` is missing**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen -- destination_chords chord_needs_open_space`

Expected: compile error or assertion fail (`chords >= 1` is 0).

- [ ] **Step 3: Implement `destination_chords` and call it after transit attach.** Do not change `shortcut_chords`. Do not change `CHORD_MIN_CLEARANCE_M`.

- [ ] **Step 4: Re-run destination + existing chord tests**

Run:

```text
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen -- destination_chords chord_needs_open_space chords_
```

Expected: PASS. `chords_cut_a_detour_but_not_a_straight_spine`, `chords_never_cross_a_hole`, `chords_do_not_reemit_an_existing_bridge`, `chord_needs_open_space` still PASS.

- [ ] **Step 5: Commit**

```text
feat(synth): destination-anchored chords between doors and transit
```

---

## Out of scope

- Dual-graph generation, lattice, UCN-as-spine, visibility graph, IndoorGML dual, ML floorplan
- Regenerating Tokyo
- Lowering `CHORD_MIN_CLEARANCE_M` for anonymous skeleton pairs
- More build-time chords to drive `ρ` down (Aldous’s named failure)
- Switching wasm to RDP
- Kallmann r-funnel (follow-up spike only if Task 4 is insufficient)
- `RouteProfile.zones`
- `GATE` as a restriction
- Hours UI (`at_minutes`)
- Facility-anchor thinning
- Campus sidewalks, stair landings, landmarks
- Editor rank / type / one-way widgets
- New user-facing copy
- Changing the `total_weight` / `m` label

---

## Suggested execution cut lines

| After | Ship as |
|---|---|
| Task 1 | Anyone can measure LOS + chords on a generated venue |
| Task 2 | Written gates; stop if both `no` |
| Task 4 (only if `rdp: yes`) | Optional RDP exists; users still see greedy-LOS |
| Task 5 (only if `destination_chords: yes`) | Door/transit overlay; corridor anonymous chords still zero |

Stop at the first cut line that meets the current product need. Smart Connect remains the residual for everything the gates refuse.

## Spec coverage

| Requirement | Task |
|---|---|
| Smoothness is query-time; greedy-LOS stays default | Baseline + Task 4 (gated, unused by wasm) |
| RDP only if corners still hug on a real venue | Gate A, Task 2 + 4 |
| Route choice via costs / ranks / profiles / flags | Baseline (quality-next 1–4). No new work. |
| Missed shortcut = human picker | Baseline Smart Connect; Task 2 uses it as evidence |
| Loosen chords only if halls still wander | Gate B, Task 2 + 5 |
| Do not add a second spine | Global constraint; Task 5 is an overlay |
| Corridor-only venues stay chord-free (anonymous) | `chord_needs_open_space` must remain green |
| Absence is never a zero success | Task 1 empty-graph test; Task 2 `not measured` |
| Do not persist eval as a new KVB field | `route_eval` is in-memory + example |

## Self-review

- No TBD/TODO. Gate file path and report skeleton are specified. Fixture names in Task 5 are implementable from existing `feature()` / `rect_poly` helpers.
- Types: `evaluate_routes` → `RouteQualityReport` in Task 1, consumed by Task 2 as CLI output. `smooth_route_rdp` produced in Task 4, unused by later tasks (intentional). `destination_chords` produced and called in Task 5 only.
- Task numbering skips 3 so Phase numbers (1 = RDP, 2 = chords) do not collide with “point 3 = Smart Connect”. There is no Task 3.
- Quality-next Phase 6 (zones) is intentionally absent.
