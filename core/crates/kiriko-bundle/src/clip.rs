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
    ///
    /// This is a difference of degree, not kind: GDB import also synthesizes a
    /// bounding rectangle for any level with no source level feature
    /// (`resolveOrCreateLevel` in `server/src/gdb/mapping.ts`), and those are
    /// indexed here like any other level. That can over-include (keep a
    /// neighbour's nodes) but never corrupts. Left as-is pending real-dataset
    /// measurement — see the outstanding-verification bullet in
    /// `docs/gdb-data-reference.md`.
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

/// Drop graph nodes outside `region`, then drop every edge that lost an
/// endpoint and remap the survivors onto the compacted node indices.
///
/// Returns `(clipped graph, dropped node count, dropped edge count)`.
pub(crate) fn clip_graph(
    graph: &kiriko_route::RouteGraph,
    region: &ClipRegion,
) -> (kiriko_route::RouteGraph, u32, u32) {
    use kiriko_route::{EdgeAttrs, RouteEdge, RouteGraph};

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
            attrs: EdgeAttrs::default(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use kiriko_facilities::{Facilities, Facility};
    use kiriko_model::canonical::Value;
    use kiriko_route::{EdgeAttrs, RouteEdge, RouteGraph, RouteNode};

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
            attrs: EdgeAttrs::default(),
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
}
