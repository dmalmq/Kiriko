# Opening Geometry Review Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit an advisory route-build warning for long or highly curved opening polylines while preserving the opening and the graph topology derived from it.

**Architecture:** Enrich the medial synthesizer's private opening-axis value with source identity and measured arc/chord lengths. A pure warning classifier applies fixed thresholds during feature scanning; the existing codec automatically wraps its `RouteBuildWarning` in `WarningCode::RouteBuild`.

**Tech Stack:** Rust 2024 workspace, `serde_json::Value`, `kiriko-bundle` with `netgen`, existing `RouteBuildWarning` and in-module Rust tests.

## Global Constraints

- Execute after `2026-08-12-lazy-doorway-stubs.md` so test assertions match the lazy doorway topology.
- Modify only `core/crates/kiriko-bundle/src/synth_medial.rs`; the outer warning bridge in `codec.rs` already maps every build warning to `WarningCode::RouteBuild`.
- Use subcode `synth_opening_geometry_review` exactly.
- Warn when `arc_length_m > 5.0`, or when `arc_length_m >= 2.0` and `chord_length_m / arc_length_m < 0.8`.
- Emit at most one review warning per parsed opening on a recognized level; include both reasons when both predicates hold.
- Warn even when the level has no walkable unit or floor synthesis later fails.
- Never reject, drop, shorten, or reinterpret an opening because of this diagnostic.
- Preserve first-part tie behavior for equal-length `MultiLineString` parts.
- Add no warning enum, bridge allowlist entry, dependency, or user-facing copy.
- Follow TDD and keep output deterministic.
- Design source: `docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md` §§5 and 9.1.

---

### Task 1: Measure opening geometry without changing axis selection

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:250-328`
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:858-909`
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:1109-1143`
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:1270-1470`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:3749-3783`

**Interfaces:**
- Consumes: source `BundleDocument.features`, `linestring_midpoint`, `line_verts`, and `haversine_m`.
- Produces: private `OpeningAxis` and `opening_axis(feature_id: &str, geom: &Value) -> Option<OpeningAxis>`.
- Preserves: the selected longest part, midpoint, unit direction, doorway passage-axis scoring, and public synthesis interface.

- [ ] **Step 1: Make the tied-MultiLineString test require identity and metrics**

Update `multilinestring_axis_matches_the_midpoints_part` to call `opening_axis("opening-1", &geom)` and assert fields instead of tuple destructuring:

```rust
let opening = opening_axis("opening-1", &geom).expect("axis parses");
assert_eq!(opening.feature_id, "opening-1");
assert!(
    (opening.mid[0] - 139.03125).abs() < 1e-9
        && (opening.mid[1] - 35.0).abs() < 1e-9,
    "midpoint from the first part: {:?}",
    opening.mid
);
assert!(
    opening.direction[0] > 0.99 && opening.direction[1].abs() < 0.01,
    "axis along the first part (+lon): {:?}",
    opening.direction
);
assert!(opening.arc_length_m > 0.0);
assert!((opening.chord_length_m / opening.arc_length_m - 1.0).abs() < 0.01);
```

- [ ] **Step 2: Run the metric test and verify it fails to compile**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen multilinestring_axis_matches_the_midpoints_part -- --nocapture
```

Expected: compilation fails because `OpeningAxis` and the two-argument `opening_axis` do not exist.

- [ ] **Step 3: Add fixed constants and the structured value**

Place these beside the other synthesis tolerances:

```rust
const OPENING_REVIEW_LENGTH_M: f64 = 5.0;
const OPENING_REVIEW_CURVE_MIN_M: f64 = 2.0;
const OPENING_REVIEW_CHORD_ARC_RATIO: f64 = 0.8;
```

Define:

```rust
#[derive(Clone, Debug)]
struct OpeningAxis {
    feature_id: String,
    mid: [f64; 2],
    direction: [f64; 2],
    arc_length_m: f64,
    chord_length_m: f64,
}
```

- [ ] **Step 4: Return one internally consistent longest part**

Change the function signature to:

```rust
fn opening_axis(feature_id: &str, geom: &Value) -> Option<OpeningAxis>
```

Keep `LineString` as its sole part. For `MultiLineString`, continue replacing `best` only when `len > best_len`, never on equality. Compute every output from that chosen `verts`:

```rust
let arc_length_m: f64 = verts
    .windows(2)
    .map(|window| haversine_m(window[0], window[1]))
    .sum();
let (Some(first), Some(last)) = (verts.first(), verts.last()) else {
    return None;
};
let mid = linestring_midpoint(geom)?;
let mx = 111_320.0 * mid[1].to_radians().cos();
let (dx, dy) = (
    (last[0] - first[0]) * mx,
    (last[1] - first[1]) * 111_320.0,
);
let chord_length_m = (dx * dx + dy * dy).sqrt();
if chord_length_m <= f64::EPSILON || arc_length_m <= f64::EPSILON {
    return None;
}
Some(OpeningAxis {
    feature_id: feature_id.to_string(),
    mid,
    direction: [dx / chord_length_m, dy / chord_length_m],
    arc_length_m,
    chord_length_m,
})
```

Use `opening.mid` and `opening.direction` at the doorway-planning callsites. Keep the full `OpeningAxis` in the floor's `openings` vector so the next task can classify it.

- [ ] **Step 5: Run the axis regression**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen multilinestring_axis_matches_the_midpoints_part -- --nocapture
```

Expected: pass; midpoint, direction, arc, and chord all come from the first tied part.

- [ ] **Step 6: Commit the measurement refactor**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "refactor(synth): retain opening geometry measurements"
```

---

### Task 2: Emit deterministic advisory warnings

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:1094-1165`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:1843-2090`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:3738-3790`

**Interfaces:**
- Consumes: `OpeningAxis`, fixed review constants, and `RouteBuildWarning { code, detail }`.
- Produces: private `opening_geometry_review(&OpeningAxis, ordinal: f64) -> Option<RouteBuildWarning>` and warnings in `RouteGraphBuild.warnings`.
- Preserves: graph nodes, graph edges, and `OpeningAxis` participation in doorway planning.

- [ ] **Step 1: Add fixtures for normal, long, curved, and no-walkway openings**

Add this test-only polyline helper beside `line`:

```rust
fn polyline(points: &[[f64; 2]]) -> Value {
    Value::Object(BTreeMap::from([
        ("type".to_string(), Value::String("LineString".to_string())),
        (
            "coordinates".to_string(),
            Value::Array(
                points
                    .iter()
                    .map(|point| {
                        Value::Array(vec![Value::Number(point[0]), Value::Number(point[1])])
                    })
                    .collect(),
            ),
        ),
    ]))
}
```

Use the existing `xy_at(139.7, 35.6)` metre-offset helper and add:

```rust
#[test]
fn normal_opening_geometry_is_silent() {
    let xy = xy_at(139.7, 35.6);
    let doc = document(
        &[("l0", 0.0)],
        vec![
            feature("w", FeatureType::Unit, "l0", Some("walkway"), rect(139.7, 35.6, 0.0004, 0.0001)),
            feature("normal", FeatureType::Opening, "l0", None, polyline(&[xy(0.0, 0.0), xy(1.2, 0.0)])),
        ],
    );
    let build = synthesize_network_medial(&doc);
    assert!(!build.warnings.iter().any(|warning| warning.code == "synth_opening_geometry_review"));
}

#[test]
fn long_opening_geometry_warns_but_still_builds() {
    let xy = xy_at(139.7, 35.6);
    let opening = polyline(&[xy(-3.0, 0.0), xy(3.0, 0.0)]);
    let doc = document(
        &[("l0", 0.0)],
        vec![
            feature("w", FeatureType::Unit, "l0", Some("walkway"), rect(139.7, 35.6, 0.0004, 0.0001)),
            feature("long-opening", FeatureType::Opening, "l0", None, opening.clone()),
        ],
    );
    let build = synthesize_network_medial(&doc);
    let warning = build.warnings.iter().find(|warning| warning.code == "synth_opening_geometry_review").expect("review warning");
    assert!(warning.detail.contains("long-opening"));
    assert!(warning.detail.contains("reason=long"));
    let mid = linestring_midpoint(&opening).expect("midpoint");
    assert!(build.graph.nodes.iter().any(|node| [node.lon, node.lat] == mid), "warned opening remains in the graph");
}

#[test]
fn curved_opening_geometry_warns_with_ratio() {
    let xy = xy_at(139.7, 35.6);
    let opening = polyline(&[xy(0.0, 0.0), xy(1.0, 0.0), xy(1.0, 1.0), xy(0.0, 1.0)]);
    let doc = document(&[("l0", 0.0)], vec![feature("curved-opening", FeatureType::Opening, "l0", None, opening)]);
    let build = synthesize_network_medial(&doc);
    let warning = build.warnings.iter().find(|warning| warning.code == "synth_opening_geometry_review").expect("review warning without walkway");
    assert!(warning.detail.contains("curved-opening"));
    assert!(warning.detail.contains("reason=curved"));
    assert!(build.graph.nodes.is_empty(), "diagnostic does not require a synthesized floor");
}
```

- [ ] **Step 2: Run the warning tests and verify they fail**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen opening_geometry_ -- --nocapture
```

Expected: the normal test passes, while long and curved tests fail because no review warnings exist.

- [ ] **Step 3: Add the pure classifier with exact detail fields**

Implement:

```rust
fn opening_geometry_review(opening: &OpeningAxis, ordinal: f64) -> Option<RouteBuildWarning> {
    let ratio = opening.chord_length_m / opening.arc_length_m;
    let long = opening.arc_length_m > OPENING_REVIEW_LENGTH_M;
    let curved = opening.arc_length_m >= OPENING_REVIEW_CURVE_MIN_M
        && ratio < OPENING_REVIEW_CHORD_ARC_RATIO;
    if !long && !curved {
        return None;
    }
    let reason = match (long, curved) {
        (true, true) => "long,curved",
        (true, false) => "long",
        (false, true) => "curved",
        (false, false) => unreachable!(),
    };
    Some(RouteBuildWarning {
        code: "synth_opening_geometry_review".into(),
        detail: format!(
            "opening {} on ordinal {} requires review: arc_m={:.3} chord_m={:.3} chord_arc_ratio={:.3} reason={}",
            opening.feature_id,
            ordinal,
            opening.arc_length_m,
            opening.chord_length_m,
            ratio,
            reason,
        ),
    })
}
```

The decimal precision is part of the deterministic diagnostic contract.

- [ ] **Step 4: Emit during feature scanning, before walkability exits**

In the `FeatureType::Opening` branch:

```rust
if let Some(opening) = opening_axis(&f.id, geom) {
    if let Some(warning) = opening_geometry_review(&opening, ord) {
        warnings.push(warning);
    }
    openings.push(opening);
}
```

This code must run before `if walk.is_empty() { continue; }`. Do not filter the `openings` vector based on warning status.

- [ ] **Step 5: Assert a combined reason is emitted once**

Add a classifier-level test using a hand-built `OpeningAxis`:

```rust
#[test]
fn long_and_curved_opening_emits_one_combined_warning() {
    let opening = OpeningAxis {
        feature_id: "both".into(),
        mid: [139.7, 35.6],
        direction: [1.0, 0.0],
        arc_length_m: 8.0,
        chord_length_m: 4.0,
    };
    let warning = opening_geometry_review(&opening, 2.0).expect("warning");
    assert_eq!(warning.code, "synth_opening_geometry_review");
    assert!(warning.detail.contains("reason=long,curved"));
}
```

- [ ] **Step 6: Run focused and complete Rust gates**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen opening_geometry_ -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen multilinestring_axis_matches_the_midpoints_part -- --nocapture
cargo fmt --manifest-path core/Cargo.toml --all
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
cargo test --manifest-path core/Cargo.toml --workspace
```

Expected: all pass. The no-walkway curved fixture emits exactly one review warning and no graph; the long fixture emits a warning and retains its midpoint node.

- [ ] **Step 7: Compile Shibuya and inspect warning shape**

Run:

```bash
node .diag/compile-synthetic-network.mjs .diag/shibuya-source.zip .diag/shibuya-opening-review.kvb
```

Expected: compilation succeeds. Inspect the reported warnings and confirm every review line starts with `synth_opening_geometry_review`, names a source feature, includes ordinal/arc/chord/ratio/reason, and remains under the outer `route_build` warning channel. Delete the generated KVB and do not commit `.diag` outputs.

- [ ] **Step 8: Commit the warning behavior**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "feat(synth): flag suspicious opening geometry"
```
