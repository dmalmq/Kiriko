# Building-Scoped GDB Import — Network Clipping & Selection UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a subset of buildings from a multi-building GDB and have the routing network and point facilities spatially clipped to just those buildings.

**Architecture:** A new `ClipRegion` in `kiriko-bundle` builds a per-ordinal polygon index from the parsed IMDF (which already contains only the selected buildings), then filters the built `RouteGraph` and `Facilities` inside `compile_imdf_with_network`. A `clipToSelection` flag rides on the persisted `GdbMappingPlan` down to `compileImdf`. The React review dialog gains the selection UX the 2026-07-23 slice scoped out.

**Tech Stack:** Rust (edition 2024, workspace at `core/`), napi-rs 3, Fastify + TypeBox, React 19 + Vitest + Testing Library.

## Global Constraints

- **Bilingual UI.** Every user-facing string needs both `ja` and `en` in the `ui` object. No exceptions.
- **Strict TypeScript, no `any`.** Both `tsc` projects must stay clean.
- **Clip buffer is 2 metres**, a named constant.
- **No new `WarningCode` variants.** Clip counts reuse `WarningCode::RouteBuild` and `WarningCode::FacilityBuild`, with detail in the message — matching how route/facility sub-codes already work (`codec.rs:130`). This deliberately avoids the four-place edit (Rust enum + `as_str`, `server/src/core/native.ts` union + `WARNING_CODES`, `src/imdf/types.ts` union) and the `bridge_error` failure mode.
- **No `geo` / `spade` dependency outside the existing `netgen` feature gate.** `kiriko-model` and `kiriko-route` are in the wasm path; geometry in this feature is hand-rolled in `kiriko-bundle`, matching `synth.rs`.
- **Default off.** With `clipToSelection` absent or false, every byte of output must be identical to today.
- **Verification commands:** `cargo test --manifest-path core/Cargo.toml --workspace`, `pnpm exec tsc --noEmit`, `pnpm --dir server exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm --dir server exec vitest run`.

## Prerequisite

The working tree carries an **uncommitted floor-ordinal fix** in `server/src/gdb/mapping.ts` (`buildFloorSynonyms` made 0-based; `resolveLevelOrdinal` demotes the source `ordinal` attribute below floor labels) and `server/test/gdbMapping.test.ts`. The clip matches nodes to the region **by ordinal**, so with the old 1-based synonyms every node would test against the wrong floor's polygons and the clip would drop nearly everything.

- [ ] **Step 0: Commit the prerequisite fix before starting Task 1**

```bash
git add server/src/gdb/mapping.ts server/test/gdbMapping.test.ts docs/gdb-data-reference.md core/crates/kiriko-bundle/src/synth.rs
git commit -m "fix(gdb): make floor ordinals 0-based and demote the source ordinal attribute"
```

Run `pnpm --dir server exec vitest run gdbMapping` first and confirm it passes. If it does not, stop and fix that before any clip work — the whole feature rests on correct ordinals.

## File Structure

**Create:**
- `core/crates/kiriko-bundle/src/clip.rs` — `ClipRegion`, `clip_graph`, `clip_facilities`. One responsibility: spatial filtering. All unit tests inline.

**Modify:**
- `core/crates/kiriko-bundle/src/lib.rs` — declare `mod clip;`
- `core/crates/kiriko-bundle/src/codec.rs:96-191` — `clip_to_venue` param, orchestration
- `core/crates/kiriko-bundle/tests/bundle.rs` — end-to-end clip test
- `core/crates/kiriko-node/src/lib.rs:54-62,69-85,173-192` — napi param passthrough
- `server/src/core/native.ts:25-49,71-79,246-278` — metadata field + positional arg
- `server/src/jobs/publish.ts:85-95,135-153` — job payload → metadata
- `server/src/gdb/types.ts` + `src/gdb/types.ts` — `clipToSelection` on the plan
- `server/src/gdb/routes.ts:89-95,535-548` — TypeBox schema + enqueue payload
- `server/src/gdb/mapping.ts:444-457` — `normalizeGdbPlan`
- `src/gallery/GdbImportDialog.tsx` — all selection UX
- `src/gallery/GdbImportDialog.test.tsx` — client tests
- `server/test/gdbMapping.test.ts` — plan normalization test
- `docs/gdb-data-reference.md` — document the clip

---

### Task 1: ClipRegion — per-ordinal polygon index

**Files:**
- Create: `core/crates/kiriko-bundle/src/clip.rs`
- Modify: `core/crates/kiriko-bundle/src/lib.rs`

**Interfaces:**
- Consumes: `kiriko_model::model::{FeatureType, VenueModel}`, `kiriko_model::canonical::Value`, `crate::synth::point_seg_dist_m`
- Produces: `pub(crate) const CLIP_BUFFER_M: f64`, `pub(crate) struct ClipRegion` with `from_venue(&VenueModel) -> ClipRegion`, `is_empty(&self) -> bool`, `contains(&self, lon: f64, lat: f64, ordinal: f64) -> bool`

- [ ] **Step 1: Declare the module**

In `core/crates/kiriko-bundle/src/lib.rs`, add alongside the existing module declarations:

```rust
mod clip;
```

- [ ] **Step 2: Write the failing tests**

Create `core/crates/kiriko-bundle/src/clip.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use kiriko_model::canonical::Value;

    /// A 0.001deg square at (139.000,35.000)-(139.001,35.001) — about 91m x 111m.
    fn square() -> Value {
        let ring = vec![
            Value::Array(vec![Value::Number(139.000), Value::Number(35.000)]),
            Value::Array(vec![Value::Number(139.001), Value::Number(35.000)]),
            Value::Array(vec![Value::Number(139.001), Value::Number(35.001)]),
            Value::Array(vec![Value::Number(139.000), Value::Number(35.001)]),
            Value::Array(vec![Value::Number(139.000), Value::Number(35.000)]),
        ];
        let mut obj = std::collections::BTreeMap::new();
        obj.insert("type".to_string(), Value::String("Polygon".to_string()));
        obj.insert(
            "coordinates".to_string(),
            Value::Array(vec![Value::Array(ring)]),
        );
        Value::Object(obj)
    }

    fn region_with_square_on_ordinal_zero() -> ClipRegion {
        let mut by_ordinal = std::collections::BTreeMap::new();
        by_ordinal.insert(ord_key(0.0), polygons_of(&square()));
        ClipRegion { by_ordinal }
    }

    #[test]
    fn contains_a_point_inside_the_polygon() {
        let region = region_with_square_on_ordinal_zero();
        assert!(region.contains(139.0005, 35.0005, 0.0));
    }

    #[test]
    fn rejects_a_point_far_outside() {
        let region = region_with_square_on_ordinal_zero();
        assert!(!region.contains(139.010, 35.010, 0.0));
    }

    #[test]
    fn accepts_a_point_just_outside_within_the_buffer() {
        let region = region_with_square_on_ordinal_zero();
        // ~1.1m north of the top edge: inside the 2m buffer band.
        assert!(region.contains(139.0005, 35.00101, 0.0));
    }

    #[test]
    fn rejects_a_point_outside_the_buffer() {
        let region = region_with_square_on_ordinal_zero();
        // ~5.5m north of the top edge: beyond the 2m buffer band.
        assert!(!region.contains(139.0005, 35.00105, 0.0));
    }

    #[test]
    fn rejects_a_point_inside_the_polygon_but_on_another_ordinal() {
        let region = region_with_square_on_ordinal_zero();
        // Same coordinates, a floor that was never imported.
        assert!(!region.contains(139.0005, 35.0005, 3.0));
    }

    #[test]
    fn an_empty_region_contains_nothing() {
        let region = ClipRegion {
            by_ordinal: std::collections::BTreeMap::new(),
        };
        assert!(region.is_empty());
        assert!(!region.contains(139.0005, 35.0005, 0.0));
    }

    #[test]
    fn treats_negative_zero_ordinal_as_zero() {
        let region = region_with_square_on_ordinal_zero();
        assert!(region.contains(139.0005, 35.0005, -0.0));
    }

    #[test]
    fn excludes_points_inside_a_hole() {
        // Outer square with an inner hole ring; even-odd crossing puts a point
        // in the hole outside the polygon.
        let outer = vec![
            [139.000, 35.000],
            [139.010, 35.000],
            [139.010, 35.010],
            [139.000, 35.010],
            [139.000, 35.000],
        ];
        let hole = vec![
            [139.004, 35.004],
            [139.006, 35.004],
            [139.006, 35.006],
            [139.004, 35.006],
            [139.004, 35.004],
        ];
        let poly = ClipPolygon::from_rings(vec![outer, hole]).unwrap();
        let mut by_ordinal = std::collections::BTreeMap::new();
        by_ordinal.insert(ord_key(0.0), vec![poly]);
        let region = ClipRegion { by_ordinal };
        assert!(region.contains(139.002, 35.002, 0.0)); // in the ring band
        assert!(!region.contains(139.005, 35.005, 0.0)); // in the hole
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle clip::`
Expected: FAIL — compile errors, `cannot find type ClipRegion`, `cannot find function ord_key`, etc.

- [ ] **Step 4: Write the implementation**

Prepend to `core/crates/kiriko-bundle/src/clip.rs`, above the test module:

```rust
//! Spatial clipping of routing/facility data to the imported venue.
//!
//! When a GDB import selects a subset of a multi-building dataset, the network
//! and point-facility GDBs still describe the whole site — they carry no
//! building field, only floor labels and coordinates. This module builds a
//! per-ordinal polygon index from the venue that was actually imported and
//! drops anything outside it.
//!
//! Geometry is hand-rolled here for the same reason as in [`crate::synth`]: the
//! `geo` crate is gated behind the `netgen` feature so the browser wasm build
//! never pulls in computational-geometry dependencies.

use std::collections::BTreeMap;

use kiriko_model::canonical::Value;
use kiriko_model::model::{FeatureType, VenueModel};

use crate::synth::point_seg_dist_m;

/// Tolerance band outside a polygon that still counts as inside.
///
/// Network nodes sit on corridor centrelines digitized independently of the
/// venue polygons, so a node can land a metre outside the unit it belongs to.
pub(crate) const CLIP_BUFFER_M: f64 = 2.0;

/// Approximate metres per degree of latitude — bbox padding only, never for
/// the containment decision itself (that uses real metre distances).
const M_PER_DEG_LAT: f64 = 111_320.0;

/// One polygon (exterior ring plus any holes) with its bounding box.
pub(crate) struct ClipPolygon {
    rings: Vec<Vec<[f64; 2]>>,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

impl ClipPolygon {
    /// Build from already-extracted rings. Returns `None` when no ring has
    /// enough vertices to bound an area.
    pub(crate) fn from_rings(rings: Vec<Vec<[f64; 2]>>) -> Option<Self> {
        let mut west = f64::INFINITY;
        let mut south = f64::INFINITY;
        let mut east = f64::NEG_INFINITY;
        let mut north = f64::NEG_INFINITY;
        let mut usable = false;
        for ring in &rings {
            if ring.len() < 3 {
                continue;
            }
            usable = true;
            for point in ring {
                west = west.min(point[0]);
                east = east.max(point[0]);
                south = south.min(point[1]);
                north = north.max(point[1]);
            }
        }
        if !usable {
            return None;
        }
        Some(Self {
            rings,
            west,
            south,
            east,
            north,
        })
    }

    /// Even-odd ray cast across every ring, which gives holes for free: a point
    /// inside a hole crosses that ring too, making the crossing count even.
    fn contains_point(&self, p: [f64; 2]) -> bool {
        let mut inside = false;
        for ring in &self.rings {
            if ring.len() < 3 {
                continue;
            }
            let mut j = ring.len() - 1;
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[j]);
                if (a[1] > p[1]) != (b[1] > p[1]) {
                    let t = (p[1] - a[1]) / (b[1] - a[1]);
                    if p[0] < a[0] + t * (b[0] - a[0]) {
                        inside = !inside;
                    }
                }
                j = i;
            }
        }
        inside
    }

    /// Shortest distance in metres from `p` to any ring segment.
    fn boundary_distance_m(&self, p: [f64; 2]) -> f64 {
        let mut best = f64::INFINITY;
        for ring in &self.rings {
            for pair in ring.windows(2) {
                best = best.min(point_seg_dist_m(p, pair[0], pair[1]));
            }
        }
        best
    }
}

/// Collapse `-0.0` to `+0.0` so both key the same bucket, then key by bits —
/// the same exact-f64-keying convention `kiriko-facilities` uses for ordinals.
pub(crate) fn ord_key(ordinal: f64) -> u64 {
    (ordinal + 0.0).to_bits()
}

/// Read a `[lon, lat]` coordinate pair.
fn coord_pair(value: &Value) -> Option<[f64; 2]> {
    let pair = value.as_array()?;
    Some([pair.first()?.as_f64()?, pair.get(1)?.as_f64()?])
}

/// Read one ring: an array of coordinate pairs.
fn ring(value: &Value) -> Vec<[f64; 2]> {
    value
        .as_array()
        .map(|points| points.iter().filter_map(coord_pair).collect())
        .unwrap_or_default()
}

/// Decompose a GeoJSON geometry into clip polygons. `Polygon` yields one,
/// `MultiPolygon` yields one per member; every other type yields none.
pub(crate) fn polygons_of(geometry: &Value) -> Vec<ClipPolygon> {
    let Some(object) = geometry.as_object() else {
        return Vec::new();
    };
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(coordinates) = object.get("coordinates").and_then(Value::as_array) else {
        return Vec::new();
    };
    match kind {
        "Polygon" => ClipPolygon::from_rings(coordinates.iter().map(ring).collect())
            .into_iter()
            .collect(),
        "MultiPolygon" => coordinates
            .iter()
            .filter_map(|polygon| {
                let rings = polygon.as_array()?.iter().map(ring).collect();
                ClipPolygon::from_rings(rings)
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Polygons of the imported venue, bucketed by level ordinal.
pub(crate) struct ClipRegion {
    by_ordinal: BTreeMap<u64, Vec<ClipPolygon>>,
}

impl ClipRegion {
    /// Index every level and unit polygon in the imported venue.
    ///
    /// A level feature carries its own ordinal via its id; a unit carries it
    /// via `level_id`. Building polygons are deliberately not used — they are
    /// synthesized bounding rectangles, and for adjacent structures like Tokyo
    /// Station's they overlap heavily enough to leak a neighbour's nodes.
    pub(crate) fn from_venue(venue: &VenueModel) -> Self {
        let mut ordinal_by_level: BTreeMap<&str, f64> = BTreeMap::new();
        for level in &venue.levels {
            ordinal_by_level.insert(level.id.as_str(), level.ordinal);
        }
        let mut by_ordinal: BTreeMap<u64, Vec<ClipPolygon>> = BTreeMap::new();
        for feature in &venue.features {
            let ordinal = match feature.feature_type {
                FeatureType::Level => ordinal_by_level.get(feature.id.as_str()).copied(),
                FeatureType::Unit => feature
                    .level_id
                    .as_deref()
                    .and_then(|id| ordinal_by_level.get(id).copied()),
                _ => None,
            };
            let (Some(ordinal), Some(geometry)) = (ordinal, feature.geometry.as_ref()) else {
                continue;
            };
            let polygons = polygons_of(geometry);
            if polygons.is_empty() {
                continue;
            }
            by_ordinal
                .entry(ord_key(ordinal))
                .or_default()
                .extend(polygons);
        }
        Self { by_ordinal }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.by_ordinal.is_empty()
    }

    /// True when the point is inside — or within [`CLIP_BUFFER_M`] of — any
    /// polygon on its own ordinal.
    pub(crate) fn contains(&self, lon: f64, lat: f64, ordinal: f64) -> bool {
        let Some(polygons) = self.by_ordinal.get(&ord_key(ordinal)) else {
            return false;
        };
        let p = [lon, lat];
        let pad_lat = CLIP_BUFFER_M / M_PER_DEG_LAT;
        let pad_lon = pad_lat / lat.to_radians().cos().abs().max(1e-9);
        for polygon in polygons {
            if lon < polygon.west - pad_lon
                || lon > polygon.east + pad_lon
                || lat < polygon.south - pad_lat
                || lat > polygon.north + pad_lat
            {
                continue;
            }
            if polygon.contains_point(p) {
                return true;
            }
            if polygon.boundary_distance_m(p) <= CLIP_BUFFER_M {
                return true;
            }
        }
        false
    }
}
```

- [ ] **Step 5: Make `point_seg_dist_m` reachable**

`point_seg_dist_m` is `pub(crate)` in `core/crates/kiriko-bundle/src/synth.rs:224`, so a sibling module can use it — no change needed. If the compiler reports it as unreachable because `synth` is declared with a narrower visibility in `lib.rs`, widen the module declaration to `pub(crate) mod synth;` and nothing else.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle clip::`
Expected: PASS, 8 tests.

If `accepts_a_point_just_outside_within_the_buffer` or `rejects_a_point_outside_the_buffer` fails, check the metre maths rather than loosening the assertion: 0.00001deg of latitude is about 1.11m, so 35.00101 is ~1.1m outside and 35.00105 is ~5.5m outside.

- [ ] **Step 7: Commit**

```bash
git add core/crates/kiriko-bundle/src/clip.rs core/crates/kiriko-bundle/src/lib.rs
git commit -m "feat(bundle): add ClipRegion, a per-ordinal polygon index for the imported venue"
```

---

### Task 2: Clip the route graph and facilities

**Files:**
- Modify: `core/crates/kiriko-bundle/src/clip.rs`

**Interfaces:**
- Consumes: `ClipRegion` from Task 1; `kiriko_route::{RouteEdge, RouteGraph, RouteNode}`; `kiriko_facilities::Facilities`
- Produces: `pub(crate) fn clip_graph(graph: &RouteGraph, region: &ClipRegion) -> (RouteGraph, u32, u32)` returning `(clipped, dropped_nodes, dropped_edges)`; `pub(crate) fn clip_facilities(facilities: &Facilities, region: &ClipRegion) -> (Facilities, u32)` returning `(clipped, dropped)`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `mod tests` block in `core/crates/kiriko-bundle/src/clip.rs`:

```rust
    use kiriko_facilities::{Facilities, Facility};
    use kiriko_route::{RouteEdge, RouteGraph, RouteNode};

    fn node(lon: f64, lat: f64) -> RouteNode {
        RouteNode {
            lon,
            lat,
            ordinal: 0.0,
        }
    }

    fn edge(from: u32, to: u32) -> RouteEdge {
        RouteEdge {
            from,
            to,
            weight: 100.0,
            ordinal: 0.0,
            interior: Vec::new(),
        }
    }

    #[test]
    fn drops_nodes_outside_the_region_and_remaps_edge_indices() {
        let region = region_with_square_on_ordinal_zero();
        // Node 0 is outside; nodes 1 and 2 are inside and must become 0 and 1.
        let graph = RouteGraph {
            nodes: vec![
                node(139.020, 35.020),
                node(139.0004, 35.0004),
                node(139.0006, 35.0006),
            ],
            edges: vec![edge(1, 2)],
        };
        let (clipped, dropped_nodes, dropped_edges) = clip_graph(&graph, &region);
        assert_eq!(dropped_nodes, 1);
        assert_eq!(dropped_edges, 0);
        assert_eq!(clipped.nodes.len(), 2);
        assert_eq!(clipped.edges.len(), 1);
        assert_eq!((clipped.edges[0].from, clipped.edges[0].to), (0, 1));
    }

    #[test]
    fn drops_an_edge_when_either_endpoint_is_clipped() {
        let region = region_with_square_on_ordinal_zero();
        let graph = RouteGraph {
            nodes: vec![node(139.0005, 35.0005), node(139.020, 35.020)],
            edges: vec![edge(0, 1)],
        };
        let (clipped, dropped_nodes, dropped_edges) = clip_graph(&graph, &region);
        assert_eq!(dropped_nodes, 1);
        assert_eq!(dropped_edges, 1);
        assert!(clipped.edges.is_empty());
        assert_eq!(clipped.nodes.len(), 1);
    }

    #[test]
    fn preserves_edge_weight_ordinal_and_interior() {
        let region = region_with_square_on_ordinal_zero();
        let mut kept = edge(0, 1);
        kept.interior = vec![[139.0005, 35.0007]];
        let graph = RouteGraph {
            nodes: vec![node(139.0004, 35.0004), node(139.0006, 35.0006)],
            edges: vec![kept],
        };
        let (clipped, _, _) = clip_graph(&graph, &region);
        assert_eq!(clipped.edges[0].weight, 100.0);
        assert_eq!(clipped.edges[0].ordinal, 0.0);
        assert_eq!(clipped.edges[0].interior, vec![[139.0005, 35.0007]]);
    }

    #[test]
    fn clipping_an_empty_region_drops_everything() {
        let region = ClipRegion {
            by_ordinal: std::collections::BTreeMap::new(),
        };
        let graph = RouteGraph {
            nodes: vec![node(139.0005, 35.0005)],
            edges: vec![edge(0, 0)],
        };
        let (clipped, dropped_nodes, dropped_edges) = clip_graph(&graph, &region);
        assert_eq!((dropped_nodes, dropped_edges), (1, 1));
        assert!(clipped.nodes.is_empty());
        assert!(clipped.edges.is_empty());
    }

    #[test]
    fn keeps_only_facilities_inside_the_region() {
        let region = region_with_square_on_ordinal_zero();
        let facilities = Facilities {
            items: vec![
                Facility {
                    lon: 139.0005,
                    lat: 35.0005,
                    ordinal: 0.0,
                    name: "Inside".to_string(),
                    icon: "ticket".to_string(),
                    anchor: None,
                },
                Facility {
                    lon: 139.020,
                    lat: 35.020,
                    ordinal: 0.0,
                    name: "Outside".to_string(),
                    icon: "ticket".to_string(),
                    anchor: None,
                },
                Facility {
                    lon: 139.0005,
                    lat: 35.0005,
                    ordinal: 4.0,
                    name: "Wrong floor".to_string(),
                    icon: "ticket".to_string(),
                    anchor: None,
                },
            ],
        };
        let (clipped, dropped) = clip_facilities(&facilities, &region);
        assert_eq!(dropped, 2);
        assert_eq!(clipped.items.len(), 1);
        assert_eq!(clipped.items[0].name, "Inside");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle clip::`
Expected: FAIL — `cannot find function clip_graph`, `cannot find function clip_facilities`.

- [ ] **Step 3: Write the implementation**

Append to `core/crates/kiriko-bundle/src/clip.rs`, above the test module:

```rust
/// Drop graph nodes outside `region`, then drop every edge that lost an
/// endpoint and remap the survivors onto the compacted node indices.
///
/// Returns `(clipped graph, dropped node count, dropped edge count)`.
pub(crate) fn clip_graph(
    graph: &kiriko_route::RouteGraph,
    region: &ClipRegion,
) -> (kiriko_route::RouteGraph, u32, u32) {
    use kiriko_route::{RouteEdge, RouteGraph};

    let mut remap: Vec<Option<u32>> = Vec::with_capacity(graph.nodes.len());
    let mut nodes = Vec::new();
    for node in &graph.nodes {
        if region.contains(node.lon, node.lat, node.ordinal) {
            remap.push(Some(
                u32::try_from(nodes.len()).expect("node count exceeds u32"),
            ));
            nodes.push(node.clone());
        } else {
            remap.push(None);
        }
    }
    let dropped_nodes = u32::try_from(graph.nodes.len() - nodes.len()).unwrap_or(u32::MAX);

    let mut edges = Vec::new();
    for edge in &graph.edges {
        let (Some(from), Some(to)) = (
            remap.get(edge.from as usize).copied().flatten(),
            remap.get(edge.to as usize).copied().flatten(),
        ) else {
            continue;
        };
        edges.push(RouteEdge {
            from,
            to,
            weight: edge.weight,
            ordinal: edge.ordinal,
            interior: edge.interior.clone(),
        });
    }
    let dropped_edges = u32::try_from(graph.edges.len() - edges.len()).unwrap_or(u32::MAX);

    (RouteGraph { nodes, edges }, dropped_nodes, dropped_edges)
}

/// Drop facilities outside `region`. Returns `(clipped, dropped count)`.
pub(crate) fn clip_facilities(
    facilities: &kiriko_facilities::Facilities,
    region: &ClipRegion,
) -> (kiriko_facilities::Facilities, u32) {
    let items: Vec<_> = facilities
        .items
        .iter()
        .filter(|item| region.contains(item.lon, item.lat, item.ordinal))
        .cloned()
        .collect();
    let dropped = u32::try_from(facilities.items.len() - items.len()).unwrap_or(u32::MAX);
    (kiriko_facilities::Facilities { items }, dropped)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle clip::`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add core/crates/kiriko-bundle/src/clip.rs
git commit -m "feat(bundle): clip the route graph and facilities to a ClipRegion"
```

---

### Task 3: Wire clipping into the compile path

**Files:**
- Modify: `core/crates/kiriko-bundle/src/codec.rs:96-191`
- Modify: `core/crates/kiriko-bundle/tests/bundle.rs`
- Modify: `core/crates/kiriko-node/src/lib.rs:54-62,69-85,173-192`

**Interfaces:**
- Consumes: `clip_graph`, `clip_facilities`, `ClipRegion` from Tasks 1–2
- Produces: `compile_imdf_with_network(source, metadata, junctions, paths, facilities, synthesize_network, clip_to_venue: bool)` — an eighth positional parameter on the napi `compile_imdf`, `clip_to_venue: Option<bool>`

- [ ] **Step 1: Write the failing end-to-end test**

Add to `core/crates/kiriko-bundle/tests/bundle.rs`. Read the existing tests in that file first and reuse their IMDF fixture builder (`tests/support/mod.rs`'s `ZipBuilder`) and their `compile_imdf_with_network` call shape — match the fixture helper names already in the file rather than inventing new ones.

```rust
#[test]
fn clipping_drops_network_nodes_outside_the_venue() {
    // Same fixture the existing network test uses, plus one junction placed
    // far outside every level/unit polygon.
    let source = venue_with_one_level_and_unit();
    const JUNCTIONS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0005,35.0005]}},
      {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0006,35.0006]}},
      {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.900,35.900]}}]}"#;
    const PATHS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":200,"FLOOR":"F1"},
       "geometry":{"type":"LineString","coordinates":[[139.0005,35.0005],[139.0006,35.0006]]}},
      {"type":"Feature","properties":{"FNODEID":2,"TNODEID":3,"cost":200,"FLOOR":"F1"},
       "geometry":{"type":"LineString","coordinates":[[139.0006,35.0006],[139.900,35.900]]}}]}"#;

    let metadata = BundleMetadata {
        dataset_id: "t/v".to_string(),
        version: 1,
    };
    let unclipped = compile_imdf_with_network(
        &source,
        metadata.clone(),
        Some(JUNCTIONS),
        Some(PATHS),
        None,
        false,
        false,
    )
    .unwrap();
    let clipped = compile_imdf_with_network(
        &source,
        metadata,
        Some(JUNCTIONS),
        Some(PATHS),
        None,
        false,
        true,
    )
    .unwrap();

    // The clipped bundle must be strictly smaller and carry a RouteBuild
    // warning naming the drop.
    assert!(clipped.bytes.len() < unclipped.bytes.len());
    assert!(
        clipped
            .warnings
            .iter()
            .any(|w| w.message.contains("clipped")),
        "expected a clip warning, got {:?}",
        clipped.warnings
    );
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-bundle clipping_drops`
Expected: FAIL — `this function takes 6 arguments but 7 arguments were supplied`.

- [ ] **Step 3: Add the parameter and orchestration in `codec.rs`**

Change the signature at `core/crates/kiriko-bundle/src/codec.rs:96` to add a seventh parameter:

```rust
pub fn compile_imdf_with_network(
    source: &[u8],
    metadata: BundleMetadata,
    junctions_geojson: Option<&str>,
    paths_geojson: Option<&str>,
    facilities_geojson: Option<&str>,
    synthesize_network: bool,
    clip_to_venue: bool,
) -> Result<CompiledBundle, CompileError> {
```

Immediately after `let venue = import_imdf(source)?;` (currently line 104), and **before** `document` is constructed from `venue` — the region must be built while `venue` is still whole:

```rust
    // Built before `document` consumes `venue`. `None` when clipping is off, so
    // an unclipped compile does no extra geometry work at all.
    let clip_region = if clip_to_venue {
        Some(crate::clip::ClipRegion::from_venue(&venue))
    } else {
        None
    };
```

In the network branch (currently lines 122–135), after `build.graph` is available and before the `if !build.graph.is_empty()` embed, insert:

```rust
        let graph = if let Some(region) = &clip_region {
            let (clipped, dropped_nodes, dropped_edges) =
                crate::clip::clip_graph(&build.graph, region);
            if dropped_nodes > 0 || dropped_edges > 0 {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::RouteBuild,
                    message: format!(
                        "network_clipped: dropped {dropped_nodes} nodes and {dropped_edges} edges outside the imported venue"
                    ),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            if clipped.is_empty() {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::RouteBuild,
                    message:
                        "network_clip_empty: clipping removed every routable edge; no routing graph was embedded"
                            .to_string(),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            clipped
        } else {
            build.graph
        };
```

Then use `graph` in place of `build.graph` for the existing `if !graph.is_empty() { document.graph = Some(graph); }` embed. Leave the existing `RouteBuild` warning fold over `build.warnings` exactly as it is.

Apply the same substitution in the `synthesize_network` branch (lines 136–152) so a synthesized graph is clipped too.

In the facilities branch (lines 154–183), after `build_facilities` returns and before the `if !facilities.items.is_empty()` embed:

```rust
        let facilities = if let Some(region) = &clip_region {
            let (clipped, dropped) = crate::clip::clip_facilities(&facilities, region);
            if dropped > 0 {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::FacilityBuild,
                    message: format!(
                        "facilities_clipped: dropped {dropped} facilities outside the imported venue"
                    ),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            clipped
        } else {
            facilities
        };
```

The facilities branch already receives whichever graph was embedded, so anchors are derived from the clipped graph with no further change.

- [ ] **Step 4: Update the other call sites**

`core/crates/kiriko-node/src/lib.rs`:

Add the field to `CompileTask` (line 54–62):
```rust
    clip_to_venue: Option<bool>,
```

Add the parameter to `compile_imdf` (line 173–192) as the **last** parameter, and pass it into the struct literal:
```rust
    clip_to_venue: Option<bool>,
```

In `Task::compute` (lines 69–85), pass it through as the seventh argument:
```rust
            self.clip_to_venue.unwrap_or(false),
```

Then run `cargo test --manifest-path core/Cargo.toml --workspace` and fix every remaining arity error the compiler reports — there may be call sites in `kiriko-wasm` or in other tests. Add `false` for the new argument at each, preserving today's behaviour.

- [ ] **Step 5: Run the full workspace suite**

Run: `cargo test --manifest-path core/Cargo.toml --workspace`
Expected: PASS, including the new `clipping_drops_network_nodes_outside_the_venue`.

- [ ] **Step 6: Commit**

```bash
git add core/crates/kiriko-bundle/src/codec.rs core/crates/kiriko-bundle/tests/bundle.rs core/crates/kiriko-node/src/lib.rs
git commit -m "feat(bundle): clip network and facilities to the imported venue when requested"
```

---

### Task 4: Thread `clipToVenue` through the Node bridge

**Files:**
- Modify: `server/src/core/native.ts:25-49,71-79,246-278`
- Modify: `server/src/jobs/publish.ts:85-95,135-153`
- Test: `server/test/publish.test.ts`

**Interfaces:**
- Consumes: the eighth napi parameter from Task 3
- Produces: `CompileVenueMetadata.clipToVenue?: boolean`; job payload field `clipToSelection?: boolean`

- [ ] **Step 1: Write the failing test**

Add to `server/test/publish.test.ts`, matching the file's existing fake-native-compile pattern (read the neighbouring tests and reuse their harness):

```ts
it("passes clipToVenue to the native compiler when the job payload asks for clipping", async () => {
  const calls: unknown[][] = [];
  const fakeCompile = async (...args: unknown[]) => {
    calls.push(args);
    return okNativeResponse();
  };
  await compileVenueBundle(
    Buffer.from("x"),
    { datasetId: "t/v", version: 1, clipToVenue: true },
    fakeCompile as never,
  );
  expect(calls[0]![7]).toBe(true);
});

it("leaves clipToVenue undefined when the job payload omits it", async () => {
  const calls: unknown[][] = [];
  const fakeCompile = async (...args: unknown[]) => {
    calls.push(args);
    return okNativeResponse();
  };
  await compileVenueBundle(
    Buffer.from("x"),
    { datasetId: "t/v", version: 1 },
    fakeCompile as never,
  );
  expect(calls[0]![7]).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir server exec vitest run publish`
Expected: FAIL — `clipToVenue` is not assignable to `CompileVenueMetadata`.

- [ ] **Step 3: Add the metadata field**

In `server/src/core/native.ts`, inside `CompileVenueMetadata` (after `synthesizeNetwork`):

```ts
  /**
   * When `true`, the compiler drops network nodes and facilities that fall
   * outside the imported venue's level/unit polygons. Set by a GDB import that
   * selected a subset of a multi-building dataset, where the network and
   * facility GDBs still describe the whole site.
   */
  clipToVenue?: boolean;
```

Extend `NativeCompileFn` (lines 71–79) with an eighth optional parameter:

```ts
  clipToVenue?: boolean,
```

And pass it as the eighth argument in `compileVenueBundle` (lines 246–278), after `metadata.synthesizeNetwork`:

```ts
        metadata.clipToVenue,
```

- [ ] **Step 4: Thread the job payload**

In `server/src/jobs/publish.ts`, add to the destructured payload type (lines 85–95):

```ts
        clipToSelection?: boolean;
```

and to the destructuring itself. Then after the `synthesizeNetwork` block (lines 151–153):

```ts
      // A building-scoped GDB import asks the compiler to drop network nodes
      // and facilities outside the buildings that were actually imported.
      if (clipToSelection === true) {
        metadata.clipToVenue = true;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir server exec vitest run publish && pnpm --dir server exec tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Rebuild the native addon and confirm the real bridge matches**

Run: `pnpm core:build`
Expected: builds clean. This regenerates `@kiriko/node` with the 8-arg `compileImdf`; without it the server calls an addon whose signature still has 7 parameters and silently ignores clipping.

- [ ] **Step 7: Commit**

```bash
git add server/src/core/native.ts server/src/jobs/publish.ts server/test/publish.test.ts
git commit -m "feat(core): thread clipToVenue through the native compile bridge"
```

---

### Task 5: Carry `clipToSelection` on the mapping plan

**Files:**
- Modify: `server/src/gdb/types.ts`, `src/gdb/types.ts`
- Modify: `server/src/gdb/routes.ts:89-95,535-548`
- Modify: `server/src/gdb/mapping.ts:444-457`
- Test: `server/test/gdbMapping.test.ts`

**Interfaces:**
- Consumes: the job payload field from Task 4
- Produces: `GdbMappingPlan.clipToSelection?: boolean` in both type copies, accepted by TypeBox, normalized to a strict boolean, forwarded to the job payload

- [ ] **Step 1: Write the failing test**

Add to `server/test/gdbMapping.test.ts`, in the existing `normalizeGdbPlan` describe block:

```ts
it("normalizes clipToSelection to a strict boolean", () => {
  const base: GdbMappingPlan = {
    venueName: "Station",
    buildings: [{ id: "b1", name: "Station" }],
    layers: [],
  };
  expect(normalizeGdbPlan(base).clipToSelection).toBe(false);
  expect(normalizeGdbPlan({ ...base, clipToSelection: true }).clipToSelection).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir server exec vitest run gdbMapping`
Expected: FAIL — `clipToSelection` does not exist on `GdbMappingPlan`.

- [ ] **Step 3: Add the field to both type copies**

In **both** `server/src/gdb/types.ts` and `src/gdb/types.ts`, extend `GdbMappingPlan`:

```ts
export interface GdbMappingPlan {
  venueName: string;
  buildings: GdbBuildingPlan[];
  layers: GdbLayerPlan[];
  /**
   * Drop routing nodes and facilities outside the selected buildings'
   * geometry. Lives on the plan rather than the publish request so it is
   * persisted in `versions.gdb_plan_json` and survives re-edit, augment, and
   * generate-network with no migration.
   */
  clipToSelection?: boolean;
}
```

- [ ] **Step 4: Accept it in the TypeBox schema**

In `server/src/gdb/routes.ts:89-95`, add to `GdbMappingPlanSchema`:

```ts
  clipToSelection: Type.Optional(Type.Boolean()),
```

Without this, Fastify strips the field before the route ever sees it.

- [ ] **Step 5: Normalize it**

In `server/src/gdb/mapping.ts:444-457`, add to the object `normalizeGdbPlan` returns, before `layers`:

```ts
    clipToSelection: plan.clipToSelection === true,
```

- [ ] **Step 6: Forward it to the job**

In `server/src/gdb/routes.ts`, inside the `enqueuePublication` call's second argument (currently lines 549–553), add:

```ts
          clipToSelection: plan.clipToSelection === true,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --dir server exec vitest run gdbMapping && pnpm --dir server exec tsc --noEmit && pnpm exec tsc --noEmit`
Expected: PASS, both typechecks clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/gdb/types.ts src/gdb/types.ts server/src/gdb/routes.ts server/src/gdb/mapping.ts server/test/gdbMapping.test.ts
git commit -m "feat(gdb): carry clipToSelection on the persisted mapping plan"
```

---

### Task 6: Clip checkbox in the review dialog

**Files:**
- Modify: `src/gallery/GdbImportDialog.tsx`
- Test: `src/gallery/GdbImportDialog.test.tsx`

**Interfaces:**
- Consumes: `GdbMappingPlan.clipToSelection` from Task 5
- Produces: a `clipToSelection` checkbox; `setBuildingIncluded` auto-ticks it on the first deselection

- [ ] **Step 1: Write the failing tests**

Add to `src/gallery/GdbImportDialog.test.tsx`. Note the module-level `plan` fixture has one building `b1` with one included layer; add a second building for the deselect tests:

```ts
const twoBuildingPlan: GdbMappingPlan = {
  venueName: "Station",
  buildings: [
    { id: "b1", name: "North" },
    { id: "b2", name: "South" },
  ],
  layers: [
    { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
    { key: { databaseId: "gdb-1", layerName: "South_1_Floor" }, included: true, targetType: "level", buildingId: "b2", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
  ],
};

const twoBuildingInspection: GdbInspection = {
  sourceName: "Station.gdb",
  databases: [{ id: "gdb-1", name: "Station.gdb" }],
  layers: [
    { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
    { key: { databaseId: "gdb-1", layerName: "South_1_Floor" }, databaseName: "Station.gdb", featureCount: 5, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
  ],
  warnings: [],
};

it("leaves clipping off when every building stays selected", () => {
  const onImport = vi.fn();
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  expect(onImport.mock.calls[0]![0].clipToSelection).toBe(false);
});

it("auto-enables clipping the first time a building is deselected", () => {
  const onImport = vi.fn();
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
  fireEvent.click(screen.getByLabelText(/include south/i));
  expect((screen.getByLabelText(/clip routing/i) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  expect(onImport.mock.calls[0]![0].clipToSelection).toBe(true);
});

it("respects a manual clip choice over the auto-enable", () => {
  const onImport = vi.fn();
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
  // Turn clipping on then off by hand; a later deselection must not re-enable it.
  fireEvent.click(screen.getByLabelText(/clip routing/i));
  fireEvent.click(screen.getByLabelText(/clip routing/i));
  fireEvent.click(screen.getByLabelText(/include south/i));
  expect((screen.getByLabelText(/clip routing/i) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  expect(onImport.mock.calls[0]![0].clipToSelection).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run GdbImportDialog`
Expected: FAIL — `Unable to find a label with the text of: /clip routing/i`.

- [ ] **Step 3: Add the localized strings**

In the `ui` object in `src/gallery/GdbImportDialog.tsx`, after `addFacilities`:

```ts
  clipToSelection: {
    ja: "ルーティングと地点施設を選択した建物で切り取る",
    en: "Clip routing and POIs to selected buildings",
  },
```

- [ ] **Step 4: Add the state and handler**

After the `const [page, setPage] = useState(0);` line:

```ts
  // Once the user touches the clip checkbox their choice is final; deselecting
  // another building must not silently flip it back.
  const [clipTouched, setClipTouched] = useState(false);
```

Replace `setBuildingIncluded` with a version that auto-enables clipping on the first deselection:

```ts
  function setBuildingIncluded(buildingId: string, include: boolean): void {
    setPlan((current) => ({
      ...current,
      // Excluding a building leaves the network GDB — which has no building
      // field — still describing the whole site, so clipping becomes the
      // sensible default until the user says otherwise.
      clipToSelection: !include && !clipTouched ? true : current.clipToSelection,
      layers: current.layers.map((row) =>
        row.buildingId === buildingId ? { ...row, included: include } : row,
      ),
    }));
  }
```

- [ ] **Step 5: Render the checkbox**

In Region 3, next to the network/facilities controls, add:

```tsx
          <label className="gdb-dialog__field">
            <input
              type="checkbox"
              className="gdb-dialog__checkbox"
              aria-label={ui.clipToSelection[locale]}
              checked={plan.clipToSelection === true}
              onChange={(event) => {
                setClipTouched(true);
                setPlan((current) => ({ ...current, clipToSelection: event.target.checked }));
              }}
            />
            <span>{ui.clipToSelection[locale]}</span>
          </label>
```

- [ ] **Step 6: Normalize the submitted value**

In `pruneUnusedBuildings` (around line 262), make the flag explicit so the server always receives a boolean:

```ts
  return { ...plan, layers, buildings, clipToSelection: plan.clipToSelection === true };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run GdbImportDialog && pnpm exec tsc --noEmit`
Expected: PASS, 16 tests.

- [ ] **Step 8: Commit**

```bash
git add src/gallery/GdbImportDialog.tsx src/gallery/GdbImportDialog.test.tsx
git commit -m "feat(gallery): add a clip-to-selection checkbox that auto-enables on deselect"
```

---

### Task 7: Tri-state building checkbox and suggested-inclusion restore

**Files:**
- Modify: `src/gallery/GdbImportDialog.tsx`
- Test: `src/gallery/GdbImportDialog.test.tsx`

**Interfaces:**
- Consumes: `setBuildingIncluded` from Task 6
- Produces: a `suggestedIncluded` lookup captured from `initialPlan`; a tri-state checkbox per building

- [ ] **Step 1: Write the failing tests**

Add to `src/gallery/GdbImportDialog.test.tsx`:

```ts
const partialPlan: GdbMappingPlan = {
  venueName: "Station",
  buildings: [{ id: "b1", name: "North" }],
  layers: [
    { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
    { key: { databaseId: "gdb-1", layerName: "North_1_to_2_detail" }, included: false, targetType: "detail", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: null, ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
  ],
};

const partialInspection: GdbInspection = {
  sourceName: "Station.gdb",
  databases: [{ id: "gdb-1", name: "Station.gdb" }],
  layers: [
    { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
    { key: { databaseId: "gdb-1", layerName: "North_1_to_2_detail" }, databaseName: "Station.gdb", featureCount: 2, geometryFamily: "line", fields: [{ name: "id", type: "String" }] },
  ],
  warnings: [],
};

it("renders a partially included building as indeterminate", () => {
  render(<GdbImportDialog inspection={partialInspection} initialPlan={partialPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  const box = screen.getByLabelText(/include north/i) as HTMLInputElement;
  expect(box.indeterminate).toBe(true);
  expect(box.checked).toBe(false);
});

it("restores the suggested inclusion instead of blanket-including on re-tick", () => {
  const onImport = vi.fn();
  render(<GdbImportDialog inspection={partialInspection} initialPlan={partialPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
  const box = screen.getByLabelText(/include north/i);
  fireEvent.click(box); // -> all excluded
  fireEvent.click(box); // -> restore suggestion, NOT all included
  fireEvent.click(screen.getByRole("button", { name: /import/i }));
  const submitted = onImport.mock.calls[0]![0] as GdbMappingPlan;
  expect(submitted.layers.find((l) => l.key.layerName === "North_1_Floor")!.included).toBe(true);
  // The cross-floor layer was excluded by the server heuristic and must stay so.
  expect(submitted.layers.find((l) => l.key.layerName === "North_1_to_2_detail")!.included).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run GdbImportDialog`
Expected: FAIL — `indeterminate` is `false`; the re-tick test shows the cross-floor layer included.

- [ ] **Step 3: Capture the suggested inclusion**

After the `descriptorByKey` memo in `src/gallery/GdbImportDialog.tsx`:

```ts
  // The server's suggestion, frozen at mount. Re-ticking a building restores
  // this rather than blanket-including, so heuristic exclusions (zero-feature
  // layers, `_to_` cross-floor layers) do not come back as junk.
  const suggestedIncluded = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const row of initialPlan.layers) {
      map.set(gdbLayerKeyString(row.key), row.included);
    }
    return map;
  }, [initialPlan]);
```

- [ ] **Step 4: Use it when re-including**

Change the `layers` mapping inside `setBuildingIncluded` (from Task 6) to:

```ts
      layers: current.layers.map((row) =>
        row.buildingId === buildingId
          ? {
              ...row,
              included: include
                ? (suggestedIncluded.get(gdbLayerKeyString(row.key)) ?? false)
                : false,
            }
          : row,
      ),
```

- [ ] **Step 5: Make the checkbox tri-state**

Replace the `assigned` computation and the checkbox in the buildings list (currently lines 485–494) with:

```tsx
              const rows = plan.layers.filter((l) => l.buildingId === building.id);
              const includedCount = rows.filter((l) => l.included).length;
              const assigned = includedCount > 0;
              const allIncluded = rows.length > 0 && includedCount === rows.length;
              return (
                <li key={building.id} className="gdb-dialog__building-row">
                  <input
                    type="checkbox"
                    className="gdb-dialog__checkbox"
                    aria-label={`${ui.includeBuilding[locale]} ${building.name || building.id}`}
                    checked={allIncluded}
                    ref={(node) => {
                      if (node) node.indeterminate = assigned && !allIncluded;
                    }}
                    onChange={(event) => setBuildingIncluded(building.id, event.target.checked)}
                  />
```

Leave the Delete button's `disabled={assigned}` exactly as it is — a partially included building must still be undeletable.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run GdbImportDialog && pnpm exec tsc --noEmit`
Expected: PASS, 18 tests.

- [ ] **Step 7: Commit**

```bash
git add src/gallery/GdbImportDialog.tsx src/gallery/GdbImportDialog.test.tsx
git commit -m "feat(gallery): tri-state building checkbox that restores the suggested inclusion"
```

---

### Task 8: Per-building counts, building filter, and the unassigned group

**Files:**
- Modify: `src/gallery/GdbImportDialog.tsx`
- Test: `src/gallery/GdbImportDialog.test.tsx`

**Interfaces:**
- Consumes: `descriptorByKey`, `setBuildingIncluded` from Tasks 6–7
- Produces: a `buildingFilter` state driving the layer table; an unassigned pseudo-group row

- [ ] **Step 1: Write the failing tests**

```ts
it("shows included and total layer counts per building", () => {
  render(<GdbImportDialog inspection={partialInspection} initialPlan={partialPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  expect(screen.getByText("1 / 2 layers, 3 features")).toBeTruthy();
});

it("filters the layer table to one building", () => {
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText(/filter by building/i), { target: { value: "b2" } });
  expect(screen.queryByText("North_1_Floor")).toBeNull();
  expect(screen.getByText("South_1_Floor")).toBeTruthy();
});

it("groups layers with no building into an unassigned row", () => {
  const withOrphan: GdbMappingPlan = {
    ...twoBuildingPlan,
    layers: [
      ...twoBuildingPlan.layers,
      { key: { databaseId: "gdb-1", layerName: "road_edge" }, included: false, targetType: null, buildingId: null, levelRule: null, idField: null, ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
    ],
  };
  const inspectionWithOrphan: GdbInspection = {
    ...twoBuildingInspection,
    layers: [
      ...twoBuildingInspection.layers,
      { key: { databaseId: "gdb-1", layerName: "road_edge" }, databaseName: "Station.gdb", featureCount: 9, geometryFamily: "line", fields: [] },
    ],
  };
  render(<GdbImportDialog inspection={inspectionWithOrphan} initialPlan={withOrphan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  expect(screen.getByLabelText(/include unassigned/i)).toBeTruthy();
  expect(screen.getByText("0 / 1 layers, 9 features")).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run GdbImportDialog`
Expected: FAIL — no counts text, no building filter, no unassigned row.

- [ ] **Step 3: Add the localized strings**

```ts
  filterByBuilding: { ja: "建物で絞り込み", en: "Filter by building" },
  allBuildings: { ja: "すべての建物", en: "All buildings" },
  unassigned: { ja: "未割り当て / 屋外", en: "Unassigned / outdoor" },
```

and a counts formatter beside `summaryText`:

```ts
const buildingCountsText = {
  ja: (included: number, total: number, features: number) =>
    `${included} / ${total} レイヤー、${features} 地物`,
  en: (included: number, total: number, features: number) =>
    `${included} / ${total} layers, ${features} features`,
};
```

- [ ] **Step 4: Add a shared group helper and the counts**

Above the `return (`:

```ts
  /** Layers of one building, or of the unassigned bucket when `id` is null. */
  function rowsForBuilding(id: string | null): GdbLayerPlan[] {
    return plan.layers.filter((row) => row.buildingId === id);
  }

  function groupCounts(id: string | null): { included: number; total: number; features: number } {
    const rows = rowsForBuilding(id);
    return {
      included: rows.filter((row) => row.included).length,
      total: rows.length,
      features: rows.reduce(
        (sum, row) => sum + (descriptorByKey.get(gdbLayerKeyString(row.key))?.featureCount ?? 0),
        0,
      ),
    };
  }
```

Render the counts inside each building `<li>`, after the name input:

```tsx
                  <span className="gdb-dialog__counts">
                    {(() => {
                      const counts = groupCounts(building.id);
                      return buildingCountsText[locale](counts.included, counts.total, counts.features);
                    })()}
                  </span>
```

- [ ] **Step 5: Add the unassigned group row**

Immediately after the `plan.buildings.map(...)` block closes, still inside the `<ul>`:

```tsx
            {plan.layers.some((row) => row.buildingId === null) && (
              <li className="gdb-dialog__building-row">
                <input
                  type="checkbox"
                  className="gdb-dialog__checkbox"
                  aria-label={`${ui.includeBuilding[locale]} ${ui.unassigned[locale]}`}
                  checked={
                    rowsForBuilding(null).length > 0 &&
                    rowsForBuilding(null).every((row) => row.included)
                  }
                  ref={(node) => {
                    if (node) {
                      const counts = groupCounts(null);
                      node.indeterminate = counts.included > 0 && counts.included < counts.total;
                    }
                  }}
                  onChange={(event) => setBuildingIncluded(null, event.target.checked)}
                />
                <span>{ui.unassigned[locale]}</span>
                <span className="gdb-dialog__counts">
                  {(() => {
                    const counts = groupCounts(null);
                    return buildingCountsText[locale](counts.included, counts.total, counts.features);
                  })()}
                </span>
              </li>
            )}
```

Widen `setBuildingIncluded`'s parameter to `buildingId: string | null` — the existing `row.buildingId === buildingId` comparison then handles the null bucket with no further change.

- [ ] **Step 6: Add the building filter**

Add state beside `filter`:

```ts
  const [buildingFilter, setBuildingFilter] = useState<string>("");
```

Render the select above the layer table, next to the existing search input:

```tsx
          <select
            className="gdb-dialog__select"
            aria-label={ui.filterByBuilding[locale]}
            value={buildingFilter}
            onChange={(event) => {
              setBuildingFilter(event.target.value);
              setPage(0);
            }}
          >
            <option value="">{ui.allBuildings[locale]}</option>
            {plan.buildings.map((building) => (
              <option key={building.id} value={building.id}>
                {building.name || building.id}
              </option>
            ))}
            <option value="__unassigned">{ui.unassigned[locale]}</option>
          </select>
```

Extend the `filtered` memo to apply it, and add `buildingFilter` to its dependency array:

```ts
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return plan.layers.filter((row) => {
      if (buildingFilter === "__unassigned" && row.buildingId !== null) return false;
      if (buildingFilter !== "" && buildingFilter !== "__unassigned" && row.buildingId !== buildingFilter) {
        return false;
      }
      if (!needle) return true;
      const descriptor = descriptorByKey.get(gdbLayerKeyString(row.key));
      return (
        row.key.layerName.toLowerCase().includes(needle) ||
        (descriptor?.databaseName.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [filter, buildingFilter, plan.layers, descriptorByKey]);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run GdbImportDialog && pnpm exec tsc --noEmit`
Expected: PASS, 21 tests.

- [ ] **Step 8: Commit**

```bash
git add src/gallery/GdbImportDialog.tsx src/gallery/GdbImportDialog.test.tsx
git commit -m "feat(gallery): per-building counts, building filter, and unassigned layer group"
```

---

### Task 9: Venue name suggestion for a single-building selection

**Files:**
- Modify: `src/gallery/GdbImportDialog.tsx`
- Test: `src/gallery/GdbImportDialog.test.tsx`

**Interfaces:**
- Consumes: `setBuildingIncluded` from Tasks 6–8
- Produces: a `venueNameTouched` state gating the prefill

- [ ] **Step 1: Write the failing tests**

```ts
it("suggests the building name when exactly one building is selected", () => {
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  fireEvent.click(screen.getByLabelText(/include south/i));
  expect((screen.getByLabelText(/venue name/i) as HTMLInputElement).value).toBe("North");
});

it("never overwrites a hand-edited venue name", () => {
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText(/venue name/i), { target: { value: "My Venue" } });
  fireEvent.click(screen.getByLabelText(/include south/i));
  expect((screen.getByLabelText(/venue name/i) as HTMLInputElement).value).toBe("My Venue");
});

it("leaves the venue name alone when several buildings remain selected", () => {
  render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
  expect((screen.getByLabelText(/venue name/i) as HTMLInputElement).value).toBe("Station");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run GdbImportDialog`
Expected: FAIL — the first test reads `"Station"`, not `"North"`.

- [ ] **Step 3: Track manual edits**

Add state beside `clipTouched`:

```ts
  // The venue name auto-fills from a single-building selection until the user
  // types; after that their text is never overwritten.
  const [venueNameTouched, setVenueNameTouched] = useState(false);
```

Set it in the venue name input's `onChange`, before the existing `setPlan`:

```ts
                setVenueNameTouched(true);
```

- [ ] **Step 4: Prefill on selection change**

Inside `setBuildingIncluded`, wrap the returned plan so the name follows a single selection. Replace the `setPlan((current) => ({ ... }))` body with:

```ts
    setPlan((current) => {
      const layers = current.layers.map((row) =>
        row.buildingId === buildingId
          ? {
              ...row,
              included: include
                ? (suggestedIncluded.get(gdbLayerKeyString(row.key)) ?? false)
                : false,
            }
          : row,
      );
      const selected = current.buildings.filter((b) =>
        layers.some((row) => row.included && row.buildingId === b.id),
      );
      const venueName =
        !venueNameTouched && !venueNameLocked && selected.length === 1 && selected[0]!.name
          ? selected[0]!.name
          : current.venueName;
      return {
        ...current,
        venueName,
        clipToSelection: !include && !clipTouched ? true : current.clipToSelection,
        layers,
      };
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run GdbImportDialog && pnpm exec tsc --noEmit`
Expected: PASS, 24 tests.

- [ ] **Step 6: Commit**

```bash
git add src/gallery/GdbImportDialog.tsx src/gallery/GdbImportDialog.test.tsx
git commit -m "feat(gallery): suggest the venue name from a single-building selection"
```

---

### Task 10: Verify against the real Tokyo GDB and document

**Files:**
- Modify: `docs/gdb-data-reference.md`

This is the verification step the spec commits to: confirm which unprefixed layers actually reach publish, and that clipping behaves on real data rather than fixtures.

- [ ] **Step 1: Run the full verification suite**

```bash
cargo test --manifest-path core/Cargo.toml --workspace
pnpm exec tsc --noEmit
pnpm --dir server exec tsc --noEmit
pnpm exec vitest run
pnpm --dir server exec vitest run
```

Expected: all green. Record any failure and fix it before continuing — do not proceed on a red suite.

- [ ] **Step 2: Import the real dataset with one building selected**

Start the stack (`pnpm dev:server`, then `pnpm dev`), import the Tokyo venue GDB, and in the review dialog select a single building. Attach the network GDB and the point-facility GDB. Publish.

Record from the review dialog and the resulting version:
- which layers appear in the **Unassigned / outdoor** group, and which of those have a non-null target type (only those can reach publish);
- the `network_clipped` and `facilities_clipped` warning counts;
- whether the published venue routes correctly within the selected building.

- [ ] **Step 3: Act on what you find**

If any unprefixed **outdoor** layer (rail centerlines `軌道の中心線_*`, road edges `道路縁`/`道路構成線`, `Free_shuttle_bus_*ルート`) has a non-null target type and is included by default, exclude it by name pattern in `suggestLayerPlan` in `server/src/gdb/mapping.ts`, and add a `suggestGdbMapping` test in `server/test/gdbMapping.test.ts` asserting the exclusion. If none does — the expected outcome — change no defaults.

If the clip drops nodes that visibly should have been kept, raise `CLIP_BUFFER_M` in `core/crates/kiriko-bundle/src/clip.rs` and note the value and the reason. Do not silence the warning.

- [ ] **Step 4: Document the feature**

Add to `docs/gdb-data-reference.md`, in the **Kiriko pipeline** section after the combined-GDB-import bullets:

```markdown
**Building-scoped import.** The review dialog groups layers by the building
prefix and lets you include or exclude a whole building. Selecting a subset
imports one venue containing just those buildings; to split a GDB into several
venues, re-run the import per building (the blob is cached by hash, so there is
no re-upload).

Because the network and point-facility GDBs carry no building field, a subset
import can also **clip** them: `clipToSelection` on the mapping plan sets
`clipToVenue` on the compile, and `kiriko-bundle`'s `ClipRegion`
(`core/crates/kiriko-bundle/src/clip.rs`) drops network nodes and facilities
that fall outside the imported venue's level/unit polygons on their own
ordinal, within a 2 m buffer. An edge survives only if both endpoints do. Drop
counts surface as `route_build` / `facility_build` warnings whose message
starts `network_clipped:` / `facilities_clipped:`. The flag rides on the
persisted plan, so it survives re-edit, augment, and generate-network.

**The clip depends on correct ordinals.** It matches nodes to polygons by
ordinal, so `buildFloorSynonyms`/`parseFloorToken` and
`kiriko_route::floor_to_ordinal` must stay aligned — an off-by-one there tests
every node against the wrong floor.
```

Also update the **Known follow-ups** section: remove nothing, but note that one-shot fan-out to N venues was deliberately deferred.

- [ ] **Step 5: Commit**

```bash
git add docs/gdb-data-reference.md
git commit -m "docs(gdb): document building-scoped import and network clipping"
```

---

## Self-Review

**Spec coverage:**
- Clipping in Rust → Tasks 1–3
- `clipToSelection` on the plan, persisted, no migration → Task 5
- Threading to `compileImdf` → Tasks 3–4
- Clip checkbox, auto-tick on deselect → Task 6
- Tri-state checkbox → Task 7
- Re-tick restores suggested inclusion → Task 7
- Per-building counts → Task 8
- Building filter on the layer table → Task 8
- Unassigned / outdoor group → Task 8
- Venue name suggestion → Task 9
- Verification against the real Tokyo GDB → Task 10
- Bilingual strings → Tasks 6, 8 (and the Global Constraints)
- Empty clip omits section 5 with a warning → Task 3, Step 3
- Ordinal-fix prerequisite → Step 0

**Deviation from the spec, deliberate and noted in Global Constraints:** the spec's reference to new `network_clipped` / `facilities_clipped` `WarningCode` variants is implemented as message prefixes on the existing `RouteBuild` / `FacilityBuild` codes. This matches how route and facility sub-codes already work and removes the four-place-edit `bridge_error` footgun. Behaviour the user sees — a warning naming the drop counts — is unchanged.

**Type consistency:** `clipToSelection` (plan, client + server + TypeBox) → `clipToSelection` (job payload) → `clipToVenue` (`CompileVenueMetadata`) → `clip_to_venue` (Rust). The rename at the bridge is intentional and consistent with `synthesizeNetwork`/`synthesize_network`. `setBuildingIncluded(buildingId: string | null, include: boolean)` is widened in Task 8 and used with that signature in Tasks 8–9. `groupCounts` / `rowsForBuilding` are defined once in Task 8 and reused in the same task only.
