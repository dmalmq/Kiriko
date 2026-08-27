//! In-memory route-quality report: greedy-LOS retention, leftover near-wall
//! corners, stretch, and chord counts. Diagnostic only — not a KVB field.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use kiriko_route::{
    EdgeKind, Point3, Route, RouteEdge, RouteGraph, RouteProfile, TravelDirection, WalkableFloor,
    edge_allowed, route_with, smooth_route,
};

use crate::codec::BundleDocument;
use crate::network_qa::analyze_network;
use crate::synth::haversine_m;
use crate::walkable::walkable_floors;

const STRETCH_SAMPLES: usize = 50;
const STRETCH_MIN_M: f64 = 10.0;
const STRETCH_MAX_M: f64 = 40.0;
const NEAR_WALL_M: f64 = 0.6;
const LOCK_EXEMPT_M: f64 = 0.4;

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

fn absent_report() -> RouteQualityReport {
    RouteQualityReport {
        pair_count: 0,
        routed_count: 0,
        vertex_retention: None,
        length_ratio: None,
        leftover_near_wall_max: None,
        leftover_near_wall_mean: None,
        stretch_rho_max: None,
        stretch_sample_count: 0,
        chord_edges: 0,
    }
}

/// Sample same-floor pairs, route+smooth each, and aggregate LOS / leftover /
/// stretch / chord diagnostics. No graph → every count `0` and every `Option`
/// `None` (absence, not a successful empty run).
#[must_use]
pub fn evaluate_routes(document: &BundleDocument) -> RouteQualityReport {
    let Some(graph) = document.graph.as_ref() else {
        return absent_report();
    };

    let qa = analyze_network(document);
    let (stretch_rho_max, stretch_sample_count) = match qa.stretch {
        Some(s) => (Some(s.rho_max), s.sample_count),
        None => (None, 0),
    };
    let chord_edges = graph
        .edges
        .iter()
        .filter(|e| e.attrs.kind == EdgeKind::Chord)
        .count() as u32;

    let floors = walkable_floors(document);
    let profile = RouteProfile::wheelchair();
    let pairs = sample_pairs(graph);
    let pair_count = pairs.len() as u32;

    let mut samples: Vec<SmoothingSample> = Vec::new();
    for (i, j) in pairs {
        let origin = Point3 {
            lon: graph.nodes[i].lon,
            lat: graph.nodes[i].lat,
            ordinal: graph.nodes[i].ordinal,
        };
        let dest = Point3 {
            lon: graph.nodes[j].lon,
            lat: graph.nodes[j].lat,
            ordinal: graph.nodes[j].ordinal,
        };
        let Some(raw) = route_with(graph, origin, dest, &profile) else {
            continue;
        };
        let smoothed = smooth_route(raw.clone(), &floors);
        samples.push(measure_sample(&raw, &smoothed, &floors));
    }

    let routed_count = samples.len() as u32;
    if routed_count == 0 {
        return RouteQualityReport {
            pair_count,
            routed_count: 0,
            vertex_retention: None,
            length_ratio: None,
            leftover_near_wall_max: None,
            leftover_near_wall_mean: None,
            stretch_rho_max,
            stretch_sample_count,
            chord_edges,
        };
    }

    let sum_raw_v: u64 = samples.iter().map(|s| u64::from(s.raw_vertices)).sum();
    let sum_sm_v: u64 = samples.iter().map(|s| u64::from(s.smoothed_vertices)).sum();
    let sum_raw_len: f64 = samples.iter().map(|s| s.raw_length_m).sum();
    let sum_sm_len: f64 = samples.iter().map(|s| s.smoothed_length_m).sum();
    let leftover_max = samples
        .iter()
        .map(|s| s.leftover_near_wall)
        .max()
        .unwrap_or(0);
    let leftover_mean = samples
        .iter()
        .map(|s| s.leftover_near_wall as f32)
        .sum::<f32>()
        / routed_count as f32;

    RouteQualityReport {
        pair_count,
        routed_count,
        vertex_retention: Some(sum_sm_v as f32 / sum_raw_v as f32),
        length_ratio: Some((sum_sm_len / sum_raw_len) as f32),
        leftover_near_wall_max: Some(leftover_max),
        leftover_near_wall_mean: Some(leftover_mean),
        stretch_rho_max,
        stretch_sample_count,
        chord_edges,
    }
}

fn measure_sample(raw: &Route, smoothed: &Route, floors: &[WalkableFloor]) -> SmoothingSample {
    let (raw_vertices, raw_length_m) = polyline_stats(raw);
    let (smoothed_vertices, smoothed_length_m) = polyline_stats(smoothed);
    let leftover_near_wall = count_leftover_near_wall(smoothed, floors);
    SmoothingSample {
        raw_vertices,
        smoothed_vertices,
        raw_length_m,
        smoothed_length_m,
        leftover_near_wall,
    }
}

fn polyline_stats(route: &Route) -> (u32, f64) {
    let mut vertices = 0u32;
    let mut length = 0.0;
    for seg in &route.segments {
        vertices += seg.coordinates.len() as u32;
        length += seg
            .coordinates
            .windows(2)
            .map(|w| haversine_m(w[0], w[1]))
            .sum::<f64>();
    }
    (vertices, length)
}

fn count_leftover_near_wall(route: &Route, floors: &[WalkableFloor]) -> u32 {
    let mut n = 0u32;
    for seg in &route.segments {
        let Some(floor) = floors.iter().find(|f| f.ordinal == seg.ordinal) else {
            continue;
        };
        for &p in &seg.coordinates {
            if near_lock(p, floor) {
                continue;
            }
            if boundary_clearance_m(p, floor) < NEAR_WALL_M {
                n += 1;
            }
        }
    }
    n
}

fn near_lock(p: [f64; 2], floor: &WalkableFloor) -> bool {
    floor
        .locks
        .iter()
        .any(|lock| haversine_m(p, *lock) < LOCK_EXEMPT_M)
}

/// Equirectangular metres at `p`'s latitude — same idea as
/// `synth_medial::boundary_clearance_m`, local copy so that helper stays private.
fn boundary_clearance_m(p: [f64; 2], floor: &WalkableFloor) -> f64 {
    let mut best = f64::INFINITY;
    for poly in &floor.polygons {
        best = best.min(ring_clearance_m(p, &poly.exterior));
        for hole in &poly.holes {
            best = best.min(ring_clearance_m(p, hole));
        }
    }
    best
}

fn ring_clearance_m(p: [f64; 2], ring: &[[f64; 2]]) -> f64 {
    if ring.len() < 2 {
        return f64::INFINITY;
    }
    let mut best = f64::INFINITY;
    for w in ring.windows(2) {
        best = best.min(point_seg_dist_m(p, w[0], w[1]));
    }
    // Unclosed rings are treated as closed (matches walkable PIP).
    if ring.first() != ring.last() {
        best = best.min(point_seg_dist_m(p, ring[ring.len() - 1], ring[0]));
    }
    best
}

fn point_seg_dist_m(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let m_per_deg_lat = 6_371_000.0 * std::f64::consts::PI / 180.0;
    let m_per_deg_lon = m_per_deg_lat * p[1].to_radians().cos();
    let proj = |q: [f64; 2]| [(q[0] - p[0]) * m_per_deg_lon, (q[1] - p[1]) * m_per_deg_lat];
    let pa = proj(a);
    let pb = proj(b);
    let dx = pb[0] - pa[0];
    let dy = pb[1] - pa[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (pa[0] * pa[0] + pa[1] * pa[1]).sqrt();
    }
    let t = ((-pa[0] * dx - pa[1] * dy) / len2).clamp(0.0, 1.0);
    let cx = pa[0] + t * dx;
    let cy = pa[1] + t * dy;
    (cx * cx + cy * cy).sqrt()
}

/// Same order as `network_qa::stretch_summary`: sorted node indices, same-floor,
/// Euclidean in `(10 m, 40 m]`, first 50 that connect under the walking profile.
fn sample_pairs(graph: &RouteGraph) -> Vec<(usize, usize)> {
    let n = graph.nodes.len();
    if n < 2 {
        return Vec::new();
    }
    let adj = walking_adj(graph);
    let mut pairs = Vec::new();
    for i in 0..n {
        if pairs.len() >= STRETCH_SAMPLES {
            break;
        }
        let mut candidate = false;
        for j in (i + 1)..n {
            if graph.nodes[i].ordinal != graph.nodes[j].ordinal {
                continue;
            }
            let eu = haversine_m(
                [graph.nodes[i].lon, graph.nodes[i].lat],
                [graph.nodes[j].lon, graph.nodes[j].lat],
            );
            if eu > STRETCH_MIN_M && eu <= STRETCH_MAX_M {
                candidate = true;
                break;
            }
        }
        if !candidate {
            continue;
        }
        let dist = dijkstra_m(&adj, i);
        for (j, d) in dist.iter().enumerate().skip(i + 1) {
            if pairs.len() >= STRETCH_SAMPLES {
                break;
            }
            if graph.nodes[i].ordinal != graph.nodes[j].ordinal {
                continue;
            }
            let eu = haversine_m(
                [graph.nodes[i].lon, graph.nodes[i].lat],
                [graph.nodes[j].lon, graph.nodes[j].lat],
            );
            if eu <= STRETCH_MIN_M || eu > STRETCH_MAX_M {
                continue;
            }
            let Some(net) = *d else {
                continue;
            };
            if net <= 0.0 {
                continue;
            }
            pairs.push((i, j));
        }
    }
    pairs
}

fn travel_from_to(direction: TravelDirection) -> bool {
    direction == TravelDirection::Both || direction == TravelDirection::Forward
}

fn travel_to_from(direction: TravelDirection) -> bool {
    direction == TravelDirection::Both || direction == TravelDirection::Reverse
}

fn polyline_m(graph: &RouteGraph, edge: &RouteEdge) -> f64 {
    graph
        .edge_polyline(edge)
        .windows(2)
        .map(|w| haversine_m(w[0], w[1]))
        .sum()
}

fn walking_adj(graph: &RouteGraph) -> Vec<Vec<(usize, f64)>> {
    let n = graph.nodes.len();
    let mut adj = vec![Vec::new(); n];
    let profile = RouteProfile::walking();
    for e in &graph.edges {
        if !edge_allowed(e, &profile) {
            continue;
        }
        let len = polyline_m(graph, e);
        if len <= 0.0 {
            continue;
        }
        let u = e.from as usize;
        let v = e.to as usize;
        if u >= n || v >= n {
            continue;
        }
        if travel_from_to(e.flags.direction) {
            adj[u].push((v, len));
        }
        if travel_to_from(e.flags.direction) {
            adj[v].push((u, len));
        }
    }
    adj
}

#[derive(Clone, Copy, PartialEq)]
struct Visit(f64, usize);

impl Eq for Visit {}

impl Ord for Visit {
    fn cmp(&self, other: &Self) -> Ordering {
        other.0.total_cmp(&self.0).then(self.1.cmp(&other.1))
    }
}

impl PartialOrd for Visit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn dijkstra_m(adj: &[Vec<(usize, f64)>], src: usize) -> Vec<Option<f64>> {
    let n = adj.len();
    let mut dist = vec![None; n];
    let mut heap = BinaryHeap::new();
    dist[src] = Some(0.0);
    heap.push(Visit(0.0, src));
    while let Some(Visit(d, u)) = heap.pop() {
        if dist[u].is_some_and(|best| d > best + 1e-12) {
            continue;
        }
        for &(v, w) in &adj[u] {
            let nd = d + w;
            let better = match dist[v] {
                None => true,
                Some(prev) => nd + 1e-12 < prev,
            };
            if better {
                dist[v] = Some(nd);
                heap.push(Visit(nd, v));
            }
        }
    }
    dist
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use kiriko_model::canonical::Value;
    use kiriko_model::model::{FeatureType, ImdfManifest, VenueFeature, ViewerLevel};
    use kiriko_route::{EdgeAttrs, EdgeKind, RouteEdge, RouteGraph, RouteNode, meters_to_cost};

    use super::*;
    use crate::codec::{BundleDocument, BundleMetadata, BundleStats, CapabilityReport};

    /// Equirectangular metres at the equator (same sphere as `haversine_m`).
    fn lonlat_at_m(east_m: f64, north_m: f64) -> (f64, f64) {
        let m_per_deg = 6_371_000.0 * std::f64::consts::PI / 180.0;
        (east_m / m_per_deg, north_m / m_per_deg)
    }

    fn node(east_m: f64, north_m: f64, ordinal: f64) -> RouteNode {
        let (lon, lat) = lonlat_at_m(east_m, north_m);
        RouteNode { lon, lat, ordinal }
    }

    fn num(n: f64) -> Value {
        Value::Number(n)
    }

    fn position(lon: f64, lat: f64) -> Value {
        Value::Array(vec![num(lon), num(lat)])
    }

    fn geo(kind: &str, coordinates: Value) -> Value {
        Value::Object(BTreeMap::from([
            ("type".to_string(), Value::String(kind.to_string())),
            ("coordinates".to_string(), coordinates),
        ]))
    }

    fn polygon_ring(points_m: &[[f64; 2]]) -> Value {
        let ring: Vec<Value> = points_m
            .iter()
            .map(|p| {
                let (lon, lat) = lonlat_at_m(p[0], p[1]);
                position(lon, lat)
            })
            .collect();
        geo("Polygon", Value::Array(vec![Value::Array(ring)]))
    }

    fn linestring_m(points_m: &[[f64; 2]]) -> Value {
        let pts: Vec<Value> = points_m
            .iter()
            .map(|p| {
                let (lon, lat) = lonlat_at_m(p[0], p[1]);
                position(lon, lat)
            })
            .collect();
        geo("LineString", Value::Array(pts))
    }

    fn feature(
        id: &str,
        feature_type: FeatureType,
        level_id: &str,
        category: Option<&str>,
        geometry: Value,
    ) -> VenueFeature {
        VenueFeature {
            id: id.to_string(),
            feature_type,
            level_id: Some(level_id.to_string()),
            geometry: Some(geometry),
            center: None,
            labels: BTreeMap::new(),
            alt_labels: BTreeMap::new(),
            category: category.map(str::to_string),
            accessibility: Vec::new(),
            restriction: None,
            source_properties: BTreeMap::new(),
        }
    }

    fn base_document(features: Vec<VenueFeature>, graph: Option<RouteGraph>) -> BundleDocument {
        BundleDocument {
            metadata: BundleMetadata {
                dataset_id: "route_eval".into(),
                version: 1,
            },
            manifest: ImdfManifest {
                version: "1.0.0".into(),
                language: "en".into(),
                rest: BTreeMap::new(),
            },
            venue_id: "v".into(),
            levels: vec![ViewerLevel {
                id: "l0".into(),
                ordinal: 0.0,
                label: BTreeMap::new(),
                short_name: BTreeMap::new(),
            }],
            features,
            bounds_by_level: BTreeMap::new(),
            warnings: Vec::new(),
            stats: BundleStats {
                levels: 1,
                features: 0,
            },
            graph,
            facilities: None,
            spatial_context: None,
            scene: None,
            network_qa: None,
            capabilities: CapabilityReport::default(),
        }
    }

    fn empty_document() -> BundleDocument {
        base_document(Vec::new(), None)
    }

    /// Hall containing A(0,0)–B(20,-15)–C(40,0) and chord A–C. Chord weight is
    /// inflated so wheelchair A* still takes the V; LOS then drops B.
    fn hall_with_detour_and_chord() -> BundleDocument {
        let hall = polygon_ring(&[
            [-5.0, -20.0],
            [45.0, -20.0],
            [45.0, 10.0],
            [-5.0, 10.0],
            [-5.0, -20.0],
        ]);
        // Opening on the north wall — midpoint must not sit on the V vertex.
        let opening = linestring_m(&[[10.0, 10.0], [12.0, 10.0]]);
        let features = vec![
            feature("walk0", FeatureType::Unit, "l0", Some("walkway"), hall),
            feature("door0", FeatureType::Opening, "l0", None, opening),
        ];
        let ab = meters_to_cost(25.0);
        let bc = meters_to_cost(25.0);
        let chord = meters_to_cost(10_000.0);
        let graph = RouteGraph {
            nodes: vec![
                node(0.0, 0.0, 0.0),
                node(20.0, -15.0, 0.0),
                node(40.0, 0.0, 0.0),
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: ab,
                    ordinal: 0.0,
                    interior: Vec::new(),
                    attrs: EdgeAttrs {
                        clearance_m: None,
                        ..EdgeAttrs::default()
                    },
                    flags: Default::default(),
                },
                RouteEdge {
                    from: 1,
                    to: 2,
                    weight: bc,
                    ordinal: 0.0,
                    interior: Vec::new(),
                    attrs: EdgeAttrs {
                        clearance_m: None,
                        ..EdgeAttrs::default()
                    },
                    flags: Default::default(),
                },
                RouteEdge {
                    from: 0,
                    to: 2,
                    weight: chord,
                    ordinal: 0.0,
                    interior: Vec::new(),
                    attrs: EdgeAttrs {
                        kind: EdgeKind::Chord,
                        clearance_m: None,
                        ..EdgeAttrs::default()
                    },
                    flags: Default::default(),
                },
            ],
        };
        base_document(features, Some(graph))
    }

    /// Corridor with a door lock on the path near the wall. The lock must keep
    /// the near-wall vertex from counting as leftover.
    fn corridor_with_door_lock_on_path() -> BundleDocument {
        // 40 × 4 m corridor; door path vertex at (20, 0.3) — within 0.6 m of
        // the wall, coincident with the Opening midpoint so smoothing cannot
        // drop it. Endpoints sit on the centreline (≥ 0.6 m from walls).
        let corridor =
            polygon_ring(&[[0.0, 0.0], [40.0, 0.0], [40.0, 4.0], [0.0, 4.0], [0.0, 0.0]]);
        let opening = linestring_m(&[[19.0, 0.3], [21.0, 0.3]]);
        let features = vec![
            feature("walk0", FeatureType::Unit, "l0", Some("walkway"), corridor),
            feature("door0", FeatureType::Opening, "l0", None, opening),
        ];
        let graph = RouteGraph {
            nodes: vec![
                node(2.0, 2.0, 0.0),
                node(20.0, 0.3, 0.0),
                node(38.0, 2.0, 0.0),
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: meters_to_cost(20.0),
                    ordinal: 0.0,
                    interior: Vec::new(),
                    attrs: EdgeAttrs {
                        clearance_m: None,
                        ..EdgeAttrs::default()
                    },
                    flags: Default::default(),
                },
                RouteEdge {
                    from: 1,
                    to: 2,
                    weight: meters_to_cost(20.0),
                    ordinal: 0.0,
                    interior: Vec::new(),
                    attrs: EdgeAttrs {
                        clearance_m: None,
                        ..EdgeAttrs::default()
                    },
                    flags: Default::default(),
                },
            ],
        };
        base_document(features, Some(graph))
    }

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
}
