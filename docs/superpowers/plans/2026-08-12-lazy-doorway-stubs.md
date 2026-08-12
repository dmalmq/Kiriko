# Lazy Doorway Stubs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize a doorway's axis stub only when a skeleton or transit attachment uses that side, eliminating synthetic out-and-back leaves without pruning legitimate corridor ends.

**Architecture:** Keep candidate stub geometry in the existing private `DoorwayNodes` record. A single idempotent helper owns node/edge creation; skeleton and transit attachment paths call it only after choosing the stub over the midpoint. No post-processing pass infers provenance from graph shape.

**Tech Stack:** Rust 2024 workspace, `kiriko-bundle` with the `netgen` feature, `kiriko-route`, existing in-module Rust tests.

## Global Constraints

- Implement only in `core/crates/kiriko-bundle/src/synth_medial.rs`; the legacy `synth.rs` path does not emit doorway stubs.
- Never add generic degree-one pruning; terminal corridors and conveyance approaches remain valid.
- Keep `DOORWAY_STUB_M = 1.2` and `DOORWAY_STUB_JUNCTION_MARGIN_M = 0.1` unchanged.
- A direct midpoint attachment must not materialize a candidate side.
- A materialized side must be reused by every later skeleton or transit consumer.
- Preserve deterministic node IDs through existing doorway-plan, attachment, transit, and side iteration order.
- Add no dependency and no user-facing copy.
- Follow TDD: observe each focused test fail before changing production behavior.
- Design source: `docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md` §§4 and 9.1.

---

### Task 1: Make doorway side materialization demand-driven

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:911-929`
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:1504-1608`
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:1702-1785`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:2684-2733`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:2808-2822`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:3032-3075`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:3200-3297`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:3344-3456`

**Interfaces:**
- Consumes: existing `RouteNode`, `RouteEdge`, `DoorwayPlan`, `haversine_m`, and deterministic floor-processing order.
- Produces: private `DoorwaySide { point: [f64; 2], node: Option<usize> }`, revised `DoorwayNodes`, and `materialize_doorway_side(...) -> usize`.
- Preserves: `synthesize_network_medial(&BundleDocument) -> RouteGraphBuild` and every public bundle interface.

- [ ] **Step 1: Replace the obsolete eager-stub assertion with a failing no-unused-stub contract**

Rename `outside_stub_side_is_dropped` to `direct_midpoint_attachment_does_not_materialize_unused_inside_stub`. Keep its thin south-wall walkway fixture, but replace the `group.len() == 2` and stub-position assertions with:

```rust
let onode = g
    .nodes
    .iter()
    .position(|n| [n.lon, n.lat] == dm)
    .expect("opening midpoint node exists");
let group = doorway_group(g, &door);
assert_eq!(
    group,
    vec![onode],
    "the near centerline attaches directly to the midpoint; no unused stub remains"
);
assert!(
    same_floor_degree(g, onode) >= 1,
    "the midpoint remains attached to the routable graph"
);
assert_eq!(component_count(g), 1);
```

Also update `opening_connected_blobs_skip_the_near_blob_bridge`: remove its statement that two stubs remain in a thin walkway. Assert the midpoint has exactly the two direct skeleton attachments and no candidate stub node:

```rust
let group = doorway_group(g, &door);
assert_eq!(group, vec![onode], "thin-walkway doorway has no useful stub");
assert_eq!(same_floor_degree(g, onode), 2, "midpoint bridges both spines directly");
```

- [ ] **Step 2: Run the focused tests and verify the eager implementation fails**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen direct_midpoint_attachment_does_not_materialize_unused_inside_stub -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen opening_connected_blobs_skip_the_near_blob_bridge -- --nocapture
```

Expected: both tests fail because the current emitter creates the valid 1.2 m candidate before it knows that the attachment lands on the midpoint.

- [ ] **Step 3: Introduce the candidate-side type and its idempotent owner**

Replace `Option<usize>` sides with:

```rust
struct DoorwaySide {
    point: [f64; 2],
    node: Option<usize>,
}

struct DoorwayNodes {
    mid: usize,
    fwd: Option<DoorwaySide>,
    bwd: Option<DoorwaySide>,
    mid_pt: [f64; 2],
    axis: [f64; 2],
}

fn materialize_doorway_side(
    side: &mut DoorwaySide,
    mid_idx: usize,
    mid: [f64; 2],
    ordinal: f64,
    nodes: &mut Vec<RouteNode>,
    edges: &mut Vec<RouteEdge>,
) -> usize {
    if let Some(index) = side.node {
        return index;
    }
    let index = nodes.len();
    nodes.push(RouteNode {
        lon: side.point[0],
        lat: side.point[1],
        ordinal,
    });
    edges.push(RouteEdge {
        from: mid_idx as u32,
        to: index as u32,
        weight: haversine_m(mid, side.point) as f32,
        ordinal,
        interior: Vec::new(),
    });
    side.node = Some(index);
    index
}
```

The helper is the only code allowed to create a doorway side node or midpoint-to-side edge.

- [ ] **Step 4: Store valid candidate geometry without emitting it**

In the doorway emission loop, keep the midpoint creation. Replace the current `nodes.push` / `edges.push` body inside the fixed `(+axis, -axis)` loop with:

```rust
let side = DoorwaySide {
    point: pt,
    node: None,
};
if is_fwd {
    doorway.fwd = Some(side);
} else {
    doorway.bwd = Some(side);
}
```

Do not create a route node or edge in this loop.

- [ ] **Step 5: Materialize only after a skeleton attachment proves the side useful**

Change planned-attachment iteration to borrow the chosen side mutably. Compute `forward`, `far_enough`, and `segment_within_area` against `side.point` before calling the helper:

```rust
let side = if side_dot >= 0.0 {
    doorway.fwd.as_mut()
} else {
    doorway.bwd.as_mut()
};
let use_side = side.as_ref().is_some_and(|side| {
    let sign = if side_dot >= 0.0 { 1.0 } else { -1.0 };
    let along = axis[0] * (c[0] - mid[0]) * mx
        + axis[1] * (c[1] - mid[1]) * 111_320.0;
    along * sign > 0.0
        && haversine_m(c, mid) > DOORWAY_STUB_M + DOORWAY_STUB_JUNCTION_MARGIN_M
        && segment_within_area(side.point, c, &area, SEGMENT_OUTSIDE_TOL_M)
});
let (t_idx, t_pt) = if use_side {
    let side = side.expect("use_side requires a valid candidate");
    let point = side.point;
    let index = materialize_doorway_side(side, mid_idx, mid, ord, &mut nodes, &mut edges);
    (index, point)
} else {
    (mid_idx, mid)
};
```

Keep the existing attach edge creation and accepted-bridge bookkeeping after this selection.

- [ ] **Step 6: Let transit consumers reuse or materialize their side**

Change `for doorway in &doorway_nodes` to `for doorway in &mut doorway_nodes`. After the boundary-distance guard, move the existing `reachable` closure above target selection. Copy the midpoint fields before mutably borrowing a side:

```rust
let reachable = |point: [f64; 2]| {
    unit_area
        .as_ref()
        .is_some_and(|unit| segment_within_area(*tp, point, unit, SEGMENT_OUTSIDE_TOL_M))
};
let doorway_mid = doorway.mid;
let doorway_mid_pt = doorway.mid_pt;
let side = if dot >= 0.0 {
    doorway.fwd.as_mut()
} else {
    doorway.bwd.as_mut()
};
let side_point = side.as_ref().map(|side| side.point);
let target = side_point
    .filter(|point| reachable(*point))
    .map(|point| (true, point))
    .or_else(|| reachable(doorway_mid_pt).then_some((false, doorway_mid_pt)));
let Some((use_side, t_pt)) = target else {
    continue;
};
let t_idx = if use_side {
    materialize_doorway_side(
        side.expect("use_side requires a valid candidate"),
        doorway_mid,
        doorway_mid_pt,
        ord,
        &mut nodes,
        &mut edges,
    )
} else {
    doorway_mid
};
```

Then emit the transit-to-target edge exactly once. A side already used by a skeleton attachment returns its existing index.

- [ ] **Step 7: Add a direct idempotence regression for two consumers**

Add this private-helper test near `doorway_group`:

```rust
#[test]
fn doorway_side_materializes_once_for_multiple_consumers() {
    let mid = [139.7, 35.6];
    let point = [139.7, 35.6000107795];
    let mut nodes = vec![RouteNode { lon: mid[0], lat: mid[1], ordinal: 0.0 }];
    let mut edges = Vec::new();
    let mut side = DoorwaySide { point, node: None };

    let first = materialize_doorway_side(&mut side, 0, mid, 0.0, &mut nodes, &mut edges);
    let second = materialize_doorway_side(&mut side, 0, mid, 0.0, &mut nodes, &mut edges);

    assert_eq!(first, second);
    assert_eq!(nodes.len(), 2, "one midpoint plus one side node");
    assert_eq!(edges.len(), 1, "one midpoint-to-side edge");
}
```

- [ ] **Step 8: Update useful-stub tests without weakening passage-direction coverage**

Keep `doorway_attach_splits_the_centerline_in_front_of_the_door` as the wide-corridor positive case: it must still find `group.len() >= 2` and prove the attach is collinear. In `doorway_axis_crosses_a_threshold_opening`, change the walkway to `rect(139.70000, 35.60000, 0.00040, 0.00008)`, the room to `rect(139.70000, 35.59992, 0.00040, 0.00008)`, and the door latitude to `35.599960`. The resulting ~4.45 m corridor half-width puts the centerline beyond the 1.3 m cutoff. Keep its assertions for one materialized north-side stub, no south-side stub, and no along-wall stub. Do not weaken either positive case.

- [ ] **Step 9: Run the focused doorway and transit tests**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen doorway_ -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen transit_attaches_through_its_opening -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen opening_connected_blobs_skip_the_near_blob_bridge -- --nocapture
```

Expected: all pass; the thin fixtures contain midpoint-only doorway groups, the wide fixture retains its used side, and transit still attaches through the opening.

- [ ] **Step 10: Run the complete Rust gates**

Run:

```bash
cargo fmt --manifest-path core/Cargo.toml --all
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
cargo test --manifest-path core/Cargo.toml --workspace
```

Expected: formatting and every Rust test pass.

- [ ] **Step 11: Recompile the pinned Shibuya source and inspect every floor**

Run:

```bash
node .diag/compile-synthetic-network.mjs .diag/shibuya-source.zip .diag/shibuya-lazy-stubs.kvb
for floor in B3 B1 F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 F13 F14; do node .diag/network-offshoot-repro.mjs .diag/shibuya-lazy-stubs.kvb "$floor"; done
```

Expected: no floor reports an `opening_stub` foldback; the 61 doorway-derived foldbacks are gone. The one established non-doorway fallback remains available for producer review, and the graph remains connected. Delete `.diag/shibuya-lazy-stubs.kvb`; do not commit `.diag` outputs.

- [ ] **Step 12: Commit the logical change**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "fix(synth): materialize doorway stubs only when used"
```
