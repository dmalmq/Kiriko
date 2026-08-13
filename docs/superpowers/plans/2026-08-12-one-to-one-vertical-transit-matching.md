# One-to-One Vertical Transit Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace independent nearest-neighbor vertical linking with deterministic maximum-cardinality, minimum-displacement one-to-one matching for each adjacent-floor transit category.

**Architecture:** A new dependency-free private module solves one bipartite group from precomputed admissible pairs. Both synthesizers continue to own category/floor grouping, geometry admissibility, edge weights, and warnings; they call the shared matcher and emit only selected pairs.

**Tech Stack:** Rust 2024 workspace, `kiriko-bundle`, standard-library collections, `kiriko-route`; `geo` remains confined to the `netgen` medial synthesizer.

## Global Constraints

- Execute after the lazy-stub and opening-diagnostic plans; this plan touches the same medial synthesis file.
- Add no crate dependency. `transit_match.rs` must compile when `netgen` is disabled and therefore must not import `geo`.
- Group strictly by adjacent ordinal pair and exact category string.
- Legacy admissibility: centroid distance `<= VERTICAL_MATCH_M`.
- Medial admissibility: the same distance rule or existing `footprints_overlap`.
- Maximize pair count first; minimize total horizontal distance second.
- Equal-cost choices use ascending lower node ID, then ascending upper node ID; output must not depend on input pair order.
- A node appears at most once in one floor-pair matching. A middle-floor node may match once down and once up in separate evaluations.
- Preserve vertical edge weight: `horizontal_distance_m + floor_cost(category)`, then the existing single metres-to-cost conversion.
- Emit `synth_transit_no_link` for every unmatched lower-floor candidate; top-floor candidates remain silent.
- Keep all public KVB and route-graph types unchanged.
- Follow TDD and commit each independently testable layer.
- Design source: `docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md` §§6 and 9.1.

---

### Task 1: Build the dependency-free bipartite matcher

**Files:**
- Create: `core/crates/kiriko-bundle/src/transit_match.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs:28-32`
- Test: `core/crates/kiriko-bundle/src/transit_match.rs`

**Interfaces:**
- Consumes: an unordered slice of unique admissible lower/upper node pairs with finite non-negative distances.
- Produces:

```rust
pub(crate) struct TransitPair {
    pub lower_node_id: u32,
    pub upper_node_id: u32,
    pub horizontal_distance_m: f64,
}

pub(crate) fn minimum_cost_maximum_matching(
    admissible_pairs: &[TransitPair],
) -> Vec<TransitPair>
```

- Guarantees: pairwise-unique lower/upper IDs in output, maximum cardinality, minimum total distance, stable ID tie order, output sorted by `(lower_node_id, upper_node_id)`.

- [ ] **Step 1: Register the module and write failing contract tests**

Add `mod transit_match;` beside `mod synth;` in `lib.rs`. Create `transit_match.rs` with the interface declarations and these tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn pair(lower: u32, upper: u32, distance: f64) -> TransitPair {
        TransitPair {
            lower_node_id: lower,
            upper_node_id: upper,
            horizontal_distance_m: distance,
        }
    }

    fn ids(matches: &[TransitPair]) -> Vec<(u32, u32)> {
        matches
            .iter()
            .map(|pair| (pair.lower_node_id, pair.upper_node_id))
            .collect()
    }

    #[test]
    fn matching_avoids_nearest_neighbor_fan_in() {
        let matches = minimum_cost_maximum_matching(&[
            pair(1, 10, 1.0),
            pair(2, 10, 1.1),
            pair(2, 11, 2.0),
        ]);
        assert_eq!(ids(&matches), vec![(1, 10), (2, 11)]);
    }

    #[test]
    fn matching_minimizes_total_distance_after_cardinality() {
        let matches = minimum_cost_maximum_matching(&[
            pair(1, 10, 1.0),
            pair(1, 11, 2.0),
            pair(2, 10, 1.1),
            pair(2, 11, 100.0),
        ]);
        assert_eq!(ids(&matches), vec![(1, 11), (2, 10)]);
    }

    #[test]
    fn matching_breaks_equal_costs_by_node_ids() {
        let matches = minimum_cost_maximum_matching(&[
            pair(2, 11, 1.0),
            pair(1, 11, 1.0),
            pair(2, 10, 1.0),
            pair(1, 10, 1.0),
        ]);
        assert_eq!(ids(&matches), vec![(1, 10), (2, 11)]);
    }

    #[test]
    fn matching_is_input_order_invariant() {
        let forward = vec![
            pair(1, 10, 1.0),
            pair(1, 11, 2.0),
            pair(2, 10, 1.1),
            pair(2, 11, 100.0),
        ];
        let mut reverse = forward.clone();
        reverse.reverse();
        assert_eq!(
            minimum_cost_maximum_matching(&forward),
            minimum_cost_maximum_matching(&reverse),
        );
    }

    #[test]
    fn empty_admissible_set_has_no_matches() {
        assert!(minimum_cost_maximum_matching(&[]).is_empty());
    }
}
```

Derive `Clone`, `Debug`, and `PartialEq` for `TransitPair` so the order-invariance assertion is structural.

- [ ] **Step 2: Run the module tests and verify the empty implementation fails**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle transit_match::tests -- --nocapture
```

Expected: compilation fails until `minimum_cost_maximum_matching` has a body, or assertions fail if it temporarily returns an empty vector.

- [ ] **Step 3: Implement deterministic successive shortest augmenting paths**

Use a small residual graph and Bellman-Ford for each unit of flow; negative reverse edges make plain Dijkstra invalid. Define private residual state:

```rust
#[derive(Clone, Copy)]
struct ResidualEdge {
    to: usize,
    reverse: usize,
    capacity: u8,
    cost: f64,
    pair_index: Option<usize>,
}

fn add_edge(
    graph: &mut [Vec<ResidualEdge>],
    from: usize,
    to: usize,
    cost: f64,
    pair_index: Option<usize>,
) {
    let forward_reverse = graph[to].len();
    let backward_reverse = graph[from].len();
    graph[from].push(ResidualEdge {
        to,
        reverse: forward_reverse,
        capacity: 1,
        cost,
        pair_index,
    });
    graph[to].push(ResidualEdge {
        to: from,
        reverse: backward_reverse,
        capacity: 0,
        cost: -cost,
        pair_index: None,
    });
}
```

Mutate a residual pair through this helper:

```rust
fn augment_edge(graph: &mut [Vec<ResidualEdge>], from: usize, edge_index: usize) {
    let to = graph[from][edge_index].to;
    let reverse = graph[from][edge_index].reverse;
    graph[from][edge_index].capacity -= 1;
    graph[to][reverse].capacity += 1;
}
```

Inside `minimum_cost_maximum_matching`:

1. Filter out pairs whose distance is non-finite or negative; sort remaining pairs by lower ID, upper ID, then `distance.total_cmp`.
2. Deduplicate identical `(lower_node_id, upper_node_id)` pairs, keeping the shortest distance.
3. Build sorted unique lower and upper ID vectors.
4. Build residual nodes in fixed order: source, lowers, uppers, sink.
5. Add source→lower and upper→sink zero-cost unit edges in ID order; add lower→upper pair edges in sorted pair order.
6. Repeatedly run Bellman-Ford over nodes and adjacency in numeric order. Relax only residual edges with capacity 1. Use `candidate.total_cmp(&distance[to]).is_lt()`; on exact equality keep the predecessor already found, which came from the lower-ID/upper-ID traversal.
7. Stop when sink has no predecessor. Otherwise augment one unit along the predecessor chain.
8. A pair edge with zero residual capacity after the final flow is selected. Collect its original `TransitPair` and sort output by IDs.

The Bellman-Ford predecessor arrays are:

```rust
let mut distance = vec![f64::INFINITY; graph.len()];
let mut predecessor: Vec<Option<(usize, usize)>> = vec![None; graph.len()];
distance[source] = 0.0;
for _ in 1..graph.len() {
    let mut changed = false;
    for from in 0..graph.len() {
        if !distance[from].is_finite() {
            continue;
        }
        for (edge_index, edge) in graph[from].iter().enumerate() {
            if edge.capacity == 0 {
                continue;
            }
            let candidate = distance[from] + edge.cost;
            if candidate.total_cmp(&distance[edge.to]).is_lt() {
                distance[edge.to] = candidate;
                predecessor[edge.to] = Some((from, edge_index));
                changed = true;
            }
        }
    }
    if !changed {
        break;
    }
}
```

Do not add an arbitrary unmatched penalty: augment until no source-to-sink path, which establishes maximum cardinality; shortest augmenting paths establish minimum cost for each flow size.

- [ ] **Step 4: Run matcher tests in default and netgen builds**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle transit_match::tests -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen transit_match::tests -- --nocapture
```

Expected: all five tests pass in both feature configurations.

- [ ] **Step 5: Commit the isolated matcher**

```bash
git add core/crates/kiriko-bundle/src/lib.rs core/crates/kiriko-bundle/src/transit_match.rs
git commit -m "feat(synth): add deterministic transit matcher"
```

---

### Task 2: Adopt one-to-one matching in the legacy synthesizer

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth.rs:1-30`
- Modify: `core/crates/kiriko-bundle/src/synth.rs:563-610`
- Test: `core/crates/kiriko-bundle/src/synth.rs:829-928`

**Interfaces:**
- Consumes: `crate::transit_match::{TransitPair, minimum_cost_maximum_matching}` and existing `(node_id, centroid, category, ordinal)` records.
- Produces: one selected `RouteEdge` per match and `synth_transit_no_link` for each unmatched lower candidate.
- Preserves: legacy distance-only admissibility and the existing cost conversion.

- [ ] **Step 1: Add a failing two-by-two fan-in fixture**

Add a test that creates two stairs on each of two floors. Use metre-scale offsets through the existing polygon helper so both lower nodes prefer the same upper under independent nearest-neighbor matching, while a full two-pair assignment exists:

```rust
#[test]
fn vertical_matching_is_one_to_one_and_maximum_cardinality() {
    let d = 1.0 / 111_320.0;
    let features = vec![
        feature("l0-a", FeatureType::Unit, "L0", Some("stairs"), polygon(&square(0.0, 0.0, d))),
        feature("l0-b", FeatureType::Unit, "L0", Some("stairs"), polygon(&square(3.0 * d, 0.0, d))),
        feature("l1-a", FeatureType::Unit, "L1", Some("stairs"), polygon(&square(1.0 * d, 0.0, d))),
        feature("l1-b", FeatureType::Unit, "L1", Some("stairs"), polygon(&square(4.0 * d, 0.0, d))),
    ];
    let build = synthesize_network(&document(&[("L0", 0.0), ("L1", 1.0)], features));
    let vertical: Vec<_> = build
        .graph
        .edges
        .iter()
        .filter(|edge| {
            build.graph.nodes[edge.from as usize].ordinal
                != build.graph.nodes[edge.to as usize].ordinal
        })
        .collect();
    assert_eq!(vertical.len(), 2, "maximum-cardinality assignment links both stairs");
    let mut upper_ids: Vec<u32> = vertical.iter().map(|edge| edge.to).collect();
    upper_ids.sort_unstable();
    upper_ids.dedup();
    assert_eq!(upper_ids.len(), 2, "no upper transit node receives fan-in");
}
```

- [ ] **Step 2: Run the fixture and verify current nearest-neighbor fan-in**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle vertical_matching_is_one_to_one_and_maximum_cardinality -- --nocapture
```

Expected: fail because both lower stairs select the same nearest upper node.

- [ ] **Step 3: Replace the legacy nearest-neighbor loop**

Import the matcher and `BTreeSet`. Iterate with `for ordinal_pair in ordinals.windows(2)`, then bind `let lower_ordinal = ordinal_pair[0]; let upper_ordinal = ordinal_pair[1];`. Collect lower categories into a sorted `BTreeSet<String>`. For each category:

```rust
let lower: Vec<_> = transit_all
    .iter()
    .filter(|(_, _, candidate_category, ordinal)| {
        *ordinal == lower_ordinal && candidate_category == &category
    })
    .collect();
let upper: Vec<_> = transit_all
    .iter()
    .filter(|(_, _, candidate_category, ordinal)| {
        *ordinal == upper_ordinal && candidate_category == &category
    })
    .collect();
let admissible: Vec<TransitPair> = lower
    .iter()
    .flat_map(|(lower_id, lower_point, _, _)| {
        upper.iter().filter_map(|(upper_id, upper_point, _, _)| {
            let distance = haversine_m(*lower_point, *upper_point);
            (distance <= VERTICAL_MATCH_M).then_some(TransitPair {
                lower_node_id: *lower_id,
                upper_node_id: *upper_id,
                horizontal_distance_m: distance,
            })
        })
    })
    .collect();
let matches = minimum_cost_maximum_matching(&admissible);
```

Emit results and warnings with:

```rust
let matched_lower: BTreeSet<u32> =
    matches.iter().map(|pair| pair.lower_node_id).collect();
for pair in matches {
    edges.push(RouteEdge {
        from: pair.lower_node_id,
        to: pair.upper_node_id,
        weight: (pair.horizontal_distance_m + floor_cost(&category)) as f32,
        ordinal: lower_ordinal,
        interior: Vec::new(),
    });
}
for candidate in &lower {
    let lower_id = candidate.0;
    if !matched_lower.contains(&lower_id) {
        warnings.push(RouteBuildWarning {
            code: "synth_transit_no_link".into(),
            detail: format!(
                "transit node {lower_id} ({category}) on ordinal {lower_ordinal} has no match on ordinal {upper_ordinal}"
            ),
        });
    }
}
```

Categories that exist only on the upper floor are not processed, and the top ordinal is not a lower member of any `windows(2)` pair, so neither case emits an extra warning.

- [ ] **Step 4: Add middle-floor and unmatched-warning regressions**

Add:

```rust
#[test]
fn middle_floor_transit_matches_once_down_and_once_up() {
    let features = ["L0", "L1", "L2"]
        .into_iter()
        .map(|level| feature(level, FeatureType::Unit, level, Some("elevator"), polygon(&square(0.0, 0.0, 0.00001))))
        .collect();
    let build = synthesize_network(&document(&[("L0", 0.0), ("L1", 1.0), ("L2", 2.0)], features));
    let vertical = build.graph.edges.iter().filter(|edge| {
        build.graph.nodes[edge.from as usize].ordinal != build.graph.nodes[edge.to as usize].ordinal
    }).count();
    assert_eq!(vertical, 2);
}

#[test]
fn unmatched_lower_transit_emits_existing_warning() {
    let build = synthesize_network(&document(
        &[("L0", 0.0), ("L1", 1.0)],
        vec![feature("stairs", FeatureType::Unit, "L0", Some("stairs"), polygon(&square(0.0, 0.0, 0.00001)))],
    ));
    assert!(build.warnings.iter().any(|warning| warning.code == "synth_transit_no_link"));
}
```

- [ ] **Step 5: Run legacy synthesis tests**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle vertical_matching_ -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle middle_floor_transit_matches_once_down_and_once_up -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle unmatched_lower_transit_emits_existing_warning -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle stairs_stacked_across_floors_get_a_vertical_edge -- --nocapture
```

Expected: pass; the existing 5000-cost assertion remains unchanged.

- [ ] **Step 6: Commit the legacy adoption**

```bash
git add core/crates/kiriko-bundle/src/synth.rs
git commit -m "fix(synth): match vertical transit one to one"
```

---

### Task 3: Adopt the matcher in medial synthesis and prove overlap behavior

**Files:**
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:1-35`
- Modify: `core/crates/kiriko-bundle/src/synth_medial.rs:1788-1819`
- Test: `core/crates/kiriko-bundle/src/synth_medial.rs:1999-2079`

**Interfaces:**
- Consumes: shared matcher, existing `TransitAllEntry`, `footprints_overlap`, `VERTICAL_MATCH_M`, and `floor_cost`.
- Produces: unique medial vertical edges plus explicit unmatched-lower warnings.
- Preserves: overlap-based switchback admission and cost conversion.

- [ ] **Step 1: Add a failing medial fan-in test**

Build this exact two-by-two fixture:

```rust
#[test]
fn medial_vertical_matching_has_no_fan_in() {
    let xy = xy_at(139.7, 35.6);
    let mut features = Vec::new();
    for (level, lower_floor) in [("L0", true), ("L1", false)] {
        features.push(feature(
            &format!("walk-{level}"),
            FeatureType::Unit,
            level,
            Some("walkway"),
            rect(139.7, 35.6, 0.00020, 0.00010),
        ));
        let offsets = if lower_floor { [0.0, 3.0] } else { [1.0, 4.0] };
        for (index, x) in offsets.into_iter().enumerate() {
            let center = xy(x, 0.0);
            features.push(feature(
                &format!("stairs-{level}-{index}"),
                FeatureType::Unit,
                level,
                Some("stairs"),
                rect(center[0], center[1], 0.000004, 0.000004),
            ));
        }
    }
    let build = synthesize_network_medial(&document(
        &[("L0", 0.0), ("L1", 1.0)],
        features,
    ));
    let vertical: Vec<_> = build
        .graph
        .edges
        .iter()
        .filter(|edge| {
            build.graph.nodes[edge.from as usize].ordinal
                != build.graph.nodes[edge.to as usize].ordinal
        })
        .collect();
    assert_eq!(vertical.len(), 2);
    let targets: BTreeSet<u32> = vertical.iter().map(|edge| edge.to).collect();
    assert_eq!(targets.len(), 2, "each upper unit is matched at most once");
}
```

- [ ] **Step 2: Run the medial fixture and verify it fails**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen medial_vertical_matching_has_no_fan_in -- --nocapture
```

Expected: fail under the independent nearest-neighbor loop.

- [ ] **Step 3: Build medial admissible pairs and call the shared matcher**

Iterate `ordinals.windows(2)`, then a sorted `BTreeSet<String>` of lower-floor categories. Destructure `TransitAllEntry`'s optional footprints and build each admissible pair with:

```rust
let distance = haversine_m(*lower_point, *upper_point);
let linkable = distance <= VERTICAL_MATCH_M
    || footprints_overlap(lower_footprint, upper_footprint);
linkable.then_some(TransitPair {
    lower_node_id: *lower_id,
    upper_node_id: *upper_id,
    horizontal_distance_m: distance,
})
```

For each group, emit results and warnings with:

```rust
let matches = minimum_cost_maximum_matching(&admissible);
let matched_lower: BTreeSet<u32> =
    matches.iter().map(|pair| pair.lower_node_id).collect();
for pair in matches {
    edges.push(RouteEdge {
        from: pair.lower_node_id,
        to: pair.upper_node_id,
        weight: (pair.horizontal_distance_m + floor_cost(&category)) as f32,
        ordinal: lower_ordinal,
        interior: Vec::new(),
    });
}
for (lower_id, _, _, _, _) in &lower {
    if !matched_lower.contains(lower_id) {
        warnings.push(RouteBuildWarning {
            code: "synth_transit_no_link".into(),
            detail: format!(
                "transit node {lower_id} ({category}) on ordinal {lower_ordinal} has no match on ordinal {upper_ordinal}"
            ),
        });
    }
}
```

Do not move `footprints_overlap` into `transit_match.rs`.

- [ ] **Step 4: Extend existing overlap and multi-floor assertions**

Keep `switchback_stairs_link_by_footprint_overlap` and strengthen it to assert exactly one cross-floor edge. Add:

```rust
#[test]
fn medial_middle_floor_transit_matches_down_and_up() {
    let mut features = Vec::new();
    for level in ["L0", "L1", "L2"] {
        features.push(feature(
            &format!("walk-{level}"),
            FeatureType::Unit,
            level,
            Some("walkway"),
            square(139.7, 35.6, 0.0002),
        ));
        features.push(feature(
            &format!("elevator-{level}"),
            FeatureType::Unit,
            level,
            Some("elevator"),
            rect(139.7, 35.6, 0.00001, 0.00001),
        ));
    }
    let build = synthesize_network_medial(&document(
        &[("L0", 0.0), ("L1", 1.0), ("L2", 2.0)],
        features,
    ));
    let vertical = build
        .graph
        .edges
        .iter()
        .filter(|edge| {
            build.graph.nodes[edge.from as usize].ordinal
                != build.graph.nodes[edge.to as usize].ordinal
        })
        .count();
    assert_eq!(vertical, 2);
}
```

This proves the middle node participates once in each adjacent pair.

- [ ] **Step 5: Run focused, feature-matrix, and workspace gates**

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen medial_vertical_matching_ -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen switchback_stairs_link_by_footprint_overlap -- --nocapture
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle transit_match::tests -- --nocapture
cargo fmt --manifest-path core/Cargo.toml --all
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
cargo test --manifest-path core/Cargo.toml --workspace
```

Expected: all pass in default and netgen paths.

- [ ] **Step 6: Recompile Shibuya and confirm fan-in is gone**

Run:

```bash
node .diag/compile-synthetic-network.mjs .diag/shibuya-source.zip .diag/shibuya-one-to-one.kvb
pnpm core:build:wasm
```

Create the following temporary `.diag/check-vertical-fan-in.mjs`:

```javascript
import { readFile } from "node:fs/promises";
import initWasm, { exportNetwork } from "../core/crates/kiriko-wasm/pkg/kiriko_wasm.js";

const wasmBytes = await readFile(
  new URL("../core/crates/kiriko-wasm/pkg/kiriko_wasm_bg.wasm", import.meta.url),
);
await initWasm({ module_or_path: wasmBytes });
const bundle = new Uint8Array(await readFile(process.argv[2]));
const paths = JSON.parse(exportNetwork(bundle).paths).features;
const ordinal = (label) => {
  const match = /^([FB])(\\d+)$/.exec(label);
  if (match === null) throw new Error(`unrecognized floor ${label}`);
  return match[1] === "F" ? Number(match[2]) - 1 : -Number(match[2]);
};
const incoming = new Map();
for (const feature of paths) {
  const properties = feature.properties;
  if (
    properties.HFLAG !== 1
    || typeof properties.FFLOOR !== "string"
    || typeof properties.TFOOLR !== "string"
    || ordinal(properties.FFLOOR) >= ordinal(properties.TFOOLR)
  ) {
    continue;
  }
  const key = `${properties.FFLOOR}->${properties.TFOOLR}:${properties.TNODEID}`;
  incoming.set(key, (incoming.get(key) ?? 0) + 1);
}
const duplicates = [...incoming.entries()].filter(([, count]) => count > 1);
console.log(JSON.stringify({ verticalTargets: incoming.size, duplicates }, null, 2));
if (duplicates.length !== 0) process.exitCode = 1;
```

Run:

```bash
node .diag/check-vertical-fan-in.mjs .diag/shibuya-one-to-one.kvb
```

Expected: `duplicates` is empty; the six previously duplicated upper targets are absent. Delete the temporary script and generated KVB. Do not commit `.diag` outputs.

- [ ] **Step 7: Commit the medial adoption**

```bash
git add core/crates/kiriko-bundle/src/synth_medial.rs
git commit -m "fix(synth): prevent vertical transit fan-in"
```
