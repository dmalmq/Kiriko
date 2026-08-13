# Generated Network Offshoot Remediation Design

**Date:** 2026-08-12  
**Status:** Approved for implementation planning

## 1. Purpose

Remove graph branches that exist only because an unused doorway approach stub was emitted, make real cross-floor connections visually honest in the network-review overlay, report suspicious source opening geometry without changing it, and prevent ambiguous many-to-one vertical transit matches.

This design covers four independently mergeable changes:

1. lazy doorway-stub materialization;
2. advisory opening-geometry diagnostics;
3. deterministic one-to-one vertical transit matching;
4. semantic cross-floor-link presentation in the client.

It does not implement Stage 6's persistent graph findings, producer-confirmed connector associations, validation profiles, or accepted exceptions. Those remain downstream work.

## 2. Evidence and problem boundaries

A fresh synthesis of the pinned Shibuya source reproduces the stored graph exactly: 11,306 junctions and 23,044 directed paths.

The graph contains 342 true global degree-one chains. Of these, 144 tips coincide with a 1.2 m doorway stub, 83 coincide with an opening midpoint, and 115 originate in the medial skeleton. Sixty-two chains have tortuosity at least 2; 61 are doorway-stub chains. Removing openings before synthesis reduces the foldback count from 62 to 1. The renderer therefore does not manufacture the pathological topology.

The same graph contains 175 cross-floor edges. Forty have non-zero plan displacement and the maximum displacement is 8.859 m. Rendering these edges as ordinary floor paths produces visually plausible but semantically false horizontal offshoots.

The Shibuya source contains 401 openings. Fifty have arc length greater than 10 m, 20 exceed 20 m, and the maximum is 54.267 m. `opening_axis` currently reduces an entire polyline to one half-arc midpoint and a first-to-last direction. That reduction remains usable for synthesis but must surface suspicious geometry for producer review.

## 3. Design principles

- Fix topology in synthesis; never hide a routing defect only in paint.
- Preserve legitimate corridor ends; never apply a generic degree-one prune.
- Make vertical semantics explicit at the client seam instead of asking every layer to infer them.
- Treat geometry heuristics as advisory evidence, not rejection.
- Use small pure interfaces for matching and client projection so behavior is testable without a full bundle or browser.
- Preserve deterministic output and stable tie-breaking.
- Keep all user-visible copy bilingual in Japanese and English.

## 4. Doorway-stub lifecycle

### 4.1 Current failure

The medial synthesizer prunes skeleton spurs before doorway processing. Doorway emission then creates the midpoint and every geometrically valid `±1.2 m` stub. When the selected centerline target is nearer than `DOORWAY_STUB_M + DOORWAY_STUB_JUNCTION_MARGIN_M`, attachment correctly falls back to the midpoint, but the unused stub and midpoint-to-stub edge remain. No provenance-aware cleanup runs after doorway and transit attachment.

### 4.2 New module shape

`DoorwayNodes` remains private to `synth_medial.rs`, but represents candidate sides rather than eagerly emitted nodes:

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
```

A private helper materializes a side on demand:

```rust
fn materialize_doorway_side(
    side: &mut DoorwaySide,
    mid_idx: usize,
    mid: [f64; 2],
    ordinal: f64,
    nodes: &mut Vec<RouteNode>,
    edges: &mut Vec<RouteEdge>,
) -> usize
```

The first skeleton or transit consumer creates the node and midpoint edge. Further consumers reuse the same node. Direct midpoint attachment never materializes a candidate side.

### 4.3 Invariants

- Every materialized stub has at least one consumer beyond its midpoint edge.
- A direct midpoint attachment emits no unused stub on that side.
- Skeleton and transit attachments reuse the same side node.
- A two-sided doorway retains both sides only when both are used.
- Midpoint and attach-target behavior are otherwise unchanged.
- Component count and all legitimate skeleton leaves are unchanged.
- Node and edge ordering remains deterministic because doorway plans, planned skeleton attachments, transit units, and side selection all use stable iteration orders; a side node is assigned its ID at its first deterministic consumer.

The legacy non-`netgen` synthesizer does not emit doorway axis stubs and requires no stub-lifecycle change.

## 5. Opening-geometry review diagnostics

### 5.1 Structured opening input

Replace the anonymous `(midpoint, direction)` tuple used by the medial synthesizer with:

```rust
struct OpeningAxis {
    feature_id: String,
    mid: [f64; 2],
    direction: [f64; 2],
    arc_length_m: f64,
    chord_length_m: f64,
}
```

`opening_axis(feature_id, geometry)` returns this record for the longest part of a `LineString` or `MultiLineString`, preserving the current first-tied-part behavior.

### 5.2 Warning rule

Emit one `RouteBuildWarning` with code `synth_opening_geometry_review` when either condition holds:

- `arc_length_m > 5.0`; or
- `arc_length_m >= 2.0` and `chord_length_m / arc_length_m < 0.8`.

The detail includes:

- opening feature ID;
- floor ordinal;
- arc length in metres;
- chord length in metres;
- chord/arc ratio;
- triggered reason: `long` or `curved` (both when both apply).

The warning uses the existing outer `WarningCode::RouteBuild` channel. No TypeScript warning-code allowlist expansion is required. It is advisory: the opening remains in synthesis and produces the same topology it would have produced without the warning.

Warnings are emitted while scanning parsed openings on recognized levels, even when that level has no walkable unit from which to build a graph. Each source opening therefore produces at most one review warning, and warning presence does not depend on whether floor synthesis later succeeds.

Thresholds are constants beside the other synthesis tolerances:

```rust
const OPENING_REVIEW_LENGTH_M: f64 = 5.0;
const OPENING_REVIEW_CURVE_MIN_M: f64 = 2.0;
const OPENING_REVIEW_CHORD_ARC_RATIO: f64 = 0.8;
```

## 6. One-to-one vertical transit matching

### 6.1 Seam and interface

Create `core/crates/kiriko-bundle/src/transit_match.rs`. It is an unconditional, private pure module shared by `synth.rs` and `synth_medial.rs`. It has no `geo` dependency, so the non-`netgen` build remains valid.

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

Each synthesizer continues to own floor/category grouping, candidate lookup, warning text, and edge construction. For one adjacent-floor/category group it passes every admissible pair to this module. The legacy synthesizer admits pairs by centroid distance. The medial synthesizer admits pairs by centroid distance or footprint overlap. This keeps optional `geo` types behind the existing `netgen` boundary and gives the matching algorithm one narrow interface.

### 6.2 Matching policy

For each adjacent ordinal pair and exact transit category:

1. The caller builds admissible lower/upper pairs. A legacy pair is admissible when centroid distance is at most `VERTICAL_MATCH_M`. A medial pair is also admissible when both footprints exist and overlap.
2. The matcher chooses a matching that maximizes the number of pairs.
3. Among maximum-cardinality matchings, it minimizes the sum of horizontal centroid distances, compared with `f64::total_cmp`.
4. It processes lower nodes and admissible edges in ascending node-ID order and uses `(lower_node_id, upper_node_id)` for every equal-cost augmenting-path choice. This stable traversal is the deterministic tie-break contract.

A node can match at most once within one adjacent-floor pair. A middle-floor node may independently match once downward and once upward because those are different floor-pair evaluations.

The implementation uses a deterministic minimum-cost maximum-cardinality bipartite matcher with no new crate dependency. Transit groups are small, so algorithmic clarity and exact tie behavior matter more than optimizing for venue-scale graph node count.

### 6.3 Output and warnings

Both synthesizers translate matches into the existing vertical `RouteEdge` form. Weight remains `horizontal_distance_m + floor_cost(category)`, converted to canonical cost once with every other edge.

Every lower-floor transit candidate not selected for an adjacent upper floor emits the existing `synth_transit_no_link` warning. An upper-floor candidate with no lower match is not independently warned by that pair; it is evaluated as a lower candidate for its next floor when one exists. Top-floor candidates remain silent.

## 7. Client vertical-link presentation

### 7.1 Parsed semantics

`NetworkFeature` keeps the raw exporter properties. Add typed parsing helpers rather than casting at each layer:

```typescript
export interface VerticalNetworkLink {
  kind: "vertical-link";
  pathId: number;
  reversePathId: number;
  endpointNodeId: number;
  targetNodeId: number;
  activeFloor: string;
  targetFloor: string;
  targetDirection: "up" | "down";
  passageType: number;
  coordinate: GeoJSON.Position;
  selected: boolean;
}
```

A path is vertical only when `HFLAG === 1`, `PATHID`, `RPATHID`, `FNODEID`, and `TNODEID` are numeric, both floor fields are strings, and its endpoint IDs resolve to parsed junctions. The current exporter uses `passage_type: 1` only as a vertical-link flag; it does not preserve stairs/escalator/elevator category. Malformed vertical metadata is omitted from the active-floor projection rather than rendered as a horizontal path.

### 7.2 Projection rules

`buildNetworkFeatures()` deduplicates reciprocal path rows using canonical `(min(PATHID, RPATHID), max(PATHID, RPATHID))` identity.

For the active floor:

- horizontal paths continue to emit `kind: "path"` line features;
- vertical links emit exactly one `kind: "vertical-link"` point at the endpoint belonging to the active floor;
- no vertical LineString is emitted;
- the point carries `PATHID`, `RPATHID`, endpoint/target node IDs, `targetFloor`, `targetDirection`, `passageType`, and `selected`.

The same logical link can appear as a point on either endpoint floor, but never twice on one floor.

### 7.3 Layers and interaction

Add dedicated constants and layers:

- `LAYER_NETWORK_VERTICAL_LINK_HIT` — transparent 12 px circle hit target, translated `[12, -12]` screen pixels from the endpoint;
- `LAYER_NETWORK_VERTICAL_LINK` — 5 px magenta circle marker with the same translation;
- `LAYER_NETWORK_VERTICAL_LINK_SELECTED` — 8 px Ai Indigo selected marker with a white ring and the same translation;
- `LAYER_NETWORK_VERTICAL_LINK_LABEL` — compact `↑ F3` / `↓ F1` symbol offset to the translated marker, derived from `targetDirection` and `targetFloor`.

The marker deliberately uses no conveyance-category icon: the graph/export contract does not preserve that category. It communicates only the facts the data supports—this is a cross-floor link, its direction, and its target floor. The target-floor token is already language-neutral floor data, so this change introduces no new localized user string or external icon dependency.

`IndoorMap` queries the junction hit layer first, the translated vertical-link hit layer second, and the path hit layer third. The endpoint itself therefore remains a junction target while the offset marker selects the connection. A vertical marker reports the same canonical path identity as a horizontal connection, so delete and selection tools continue to edit the underlying logical connection.

## 8. Delivery sequence

Four logical changes, each independently reviewable and releasable:

1. **Lazy doorway stubs** — correct pathological graph topology.
2. **Opening diagnostics** — surface questionable source geometry without changing topology.
3. **One-to-one vertical matching** — remove fan-in and stabilize semantic links.
4. **Vertical-link client presentation** — stop presenting semantic links as horizontal paths.

The first three are Rust changes. The fourth consumes the existing exported vertical metadata and can land after the matcher without requiring a bundle-format change.

## 9. Test strategy

### 9.1 Rust synthesis

Add focused tests in `synth_medial.rs`:

- a direct midpoint attachment does not materialize the unused side;
- a used skeleton side is materialized once;
- a transit consumer reuses the already materialized side;
- a two-sided doorway materializes both used sides;
- the previous 2.4 m foldback fixture has no global degree-one stub and unchanged component count.

Add opening-axis and warning tests:

- normal 1.2 m doorway is silent;
- straight 6 m opening emits `long`;
- curved 3 m opening with ratio below 0.8 emits `curved`;
- a warning does not change nodes or edges;
- tied `MultiLineString` selection remains binary-deterministic.

Add `transit_match.rs` tests:

- nearest fan-in becomes two distinct matches when a maximum-cardinality matching exists;
- maximum cardinality wins over a lower-distance partial matching;
- minimum total displacement wins among equal-cardinality matchings;
- equal-cost choices resolve by lower node ID, then upper node ID;
- output is invariant under input ordering.

Keep integration assertions in both `synth.rs` and `synth_medial.rs` for edge weights and `synth_transit_no_link` warnings.
Keep medial-synthesis integration assertions that footprint overlap admits a pair beyond the distance threshold. Keep integration assertions in both synthesizers that a middle-floor candidate may match once downward and once upward.

### 9.2 Client

Add `networkFeatures.test.ts` cases:

- reciprocal vertical rows produce one point on the active floor;
- no vertical LineString is produced;
- switching floors moves the point to the other endpoint and changes `targetFloor` to the opposite floor;
- horizontal paths remain unchanged;
- malformed vertical metadata is omitted;
- selected identity works regardless of reciprocal row order.

Add `featureLayers.test.ts` assertions for vertical hit, visible, and selected layers.

Add `IndoorMap.test.tsx` cases for vertical-marker selection and junction precedence. Extend the existing `deleteConnection` unit test in `networkFeatures.test.ts` with a vertical reciprocal pair to prove that the marker's canonical identity deletes the underlying connection.

### 9.3 Dataset acceptance

When `.diag/shibuya-source.zip` is locally available:

1. compile with the current native addon;
2. export the graph;
3. run the deterministic offshoot detector on all floors;
4. compare against the established baseline.

Acceptance:

- doorway-derived foldbacks fall from 61 to 0;
- the one non-doorway foldback remains for producer review;
- true skeleton corridor ends are not generically removed;
- vertical target fan-in falls from 6 duplicate targets to 0;
- the client emits no vertical plan-view lines.

The dataset and diagnostic scripts remain local evidence and are not committed as product fixtures.

## 10. Verification gates

Run:

```bash
cargo test --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen
cargo test --manifest-path core/Cargo.toml --workspace
pnpm exec vitest run src/map/networkFeatures.test.ts src/map/featureLayers.test.ts src/map/IndoorMap.test.tsx
pnpm exec tsc --noEmit
pnpm --dir server exec tsc --noEmit
pnpm exec vitest run
pnpm --dir server exec vitest run
pnpm build
```

Smoke-test the network-review view in a browser with a generated multi-floor venue:

- ordinary corridor paths remain magenta lines;
- cross-floor connections render as endpoint markers, not diagonal lines;
- selecting and deleting a vertical marker targets the expected logical connection;
- switching floors moves the same link to the other endpoint with the correct target-floor label.

## 11. Rejected alternatives

### Overlay-only suppression

Rejected because the bad doorway edge would remain routable and exportable.

### Generic post-synthesis leaf pruning

Rejected because legitimate dead-end corridors and terminal conveyance approaches are degree-one graph structures.

### Eager stubs followed by geometric cleanup

Rejected because cleanup would need to infer provenance from topology and coordinates. Lazy materialization keeps ownership local and makes the invalid state unrepresentable.

### Independent nearest-neighbor vertical matching

Rejected because it permits many-to-one fan-in and cannot guarantee maximum connector coverage.

### Persisting diagnostics in KVB §11 now

Rejected as premature. The opening heuristic is an import/build advisory. Durable findings, confirmed associations, profile versioning, and exception lifecycle belong to the already-decided Stage 6 model.
