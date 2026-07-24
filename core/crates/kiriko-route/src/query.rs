use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::graph::{RouteEdge, RouteGraph};

/// A query endpoint: position plus venue level ordinal.
#[derive(Debug, Clone, Copy)]
pub struct Point3 {
    pub lon: f64,
    pub lat: f64,
    pub ordinal: f64,
}

/// `true` when every coordinate of a query endpoint is finite.
fn endpoint_is_finite(p: &Point3) -> bool {
    p.lon.is_finite() && p.lat.is_finite() && p.ordinal.is_finite()
}

/// One maximal run of the route on a single floor ordinal.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteSegment {
    pub ordinal: f64,
    pub coordinates: Vec<[f64; 2]>,
}

/// A computed route: floor-grouped corridor polylines plus the two endpoints
/// projected onto the network (`[lon, lat, ordinal]`) and the total edge cost.
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub segments: Vec<RouteSegment>,
    pub total_weight: f32,
    pub origin_projected: [f64; 3],
    pub dest_projected: [f64; 3],
}

/// A route vertex tagged with the ordinal of the edge it belongs to; grouped
/// into `RouteSegment`s at the end.
struct TaggedVertex {
    coord: [f64; 2],
    ordinal: f64,
}

const EARTH_RADIUS_M: f64 = 6_371_000.0;

/// Great-circle distance in metres.
fn haversine_m(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> f64 {
    let (lat1, lat2) = (lat1.to_radians(), lat2.to_radians());
    let dlat = lat2 - lat1;
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().asin()
}

#[derive(Clone, Copy, PartialEq)]
struct Open {
    f: f64,
    g: f64,
    node: usize,
}

impl Eq for Open {}

impl Ord for Open {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap by f, ties broken by node index for determinism.
        other
            .f
            .total_cmp(&self.f)
            .then_with(|| self.node.cmp(&other.node))
    }
}

impl PartialOrd for Open {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A click projected onto one edge's polyline.
#[derive(Debug, Clone, Copy)]
struct EdgeSnap {
    edge_index: usize,
    projected: [f64; 2],
    /// Arc length (metres) from the edge's `from` endpoint to the projection.
    along: f64,
    /// Total arc length (metres) of the edge polyline.
    total: f64,
    ordinal: f64,
}

/// Project `(px,py)` onto a polyline. Returns `(projected, along, total)` where
/// `along`/`total` are cumulative great-circle arc lengths in metres.
fn project_point_on_polyline(poly: &[[f64; 2]], px: f64, py: f64) -> ([f64; 2], f64, f64) {
    let mut best = ([px, py], 0.0, f64::INFINITY); // (proj, along, dist)
    let mut acc = 0.0;
    let mut total = 0.0;
    for w in poly.windows(2) {
        let (a, b) = (w[0], w[1]);
        let seg = haversine_m(a[0], a[1], b[0], b[1]);
        // Parameterize on the lon/lat plane (small spans → adequate), clamp t.
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        let t = if len2 <= f64::EPSILON {
            0.0
        } else {
            (((px - a[0]) * dx + (py - a[1]) * dy) / len2).clamp(0.0, 1.0)
        };
        let proj = [a[0] + t * dx, a[1] + t * dy];
        let dist = haversine_m(px, py, proj[0], proj[1]);
        if dist < best.2 {
            best = (proj, acc + t * seg, dist);
        }
        acc += seg;
        total = acc;
    }
    (best.0, best.1, total)
}

/// Nearest edge projection to `p`; same-ordinal edges beat closer off-floor
/// edges. `None` only when the graph has no edges.
fn snap_to_edge(graph: &RouteGraph, p: &Point3) -> Option<EdgeSnap> {
    let mut best: Option<(EdgeSnap, bool, f64)> = None; // (snap, same_floor, dist)
    for (i, e) in graph.edges.iter().enumerate() {
        let poly = graph.edge_polyline(e);
        let (proj, along, total) = project_point_on_polyline(&poly, p.lon, p.lat);
        let dist = haversine_m(p.lon, p.lat, proj[0], proj[1]);
        let same = e.ordinal == p.ordinal;
        let better = match &best {
            None => true,
            Some((_, bsame, bdist)) => {
                // Prefer same-floor; within the same class, prefer nearer.
                (same, -dist).partial_cmp(&(*bsame, -*bdist)).unwrap()
                    == std::cmp::Ordering::Greater
            }
        };
        if better {
            best = Some((
                EdgeSnap { edge_index: i, projected: proj, along, total, ordinal: e.ordinal },
                same,
                dist,
            ));
        }
    }
    best.map(|(s, _, _)| s)
}

/// Route from `origin` to `dest` over the graph: project both endpoints onto
/// their nearest edge, then A* between the four virtual endpoints (edges
/// traversed in both directions). Returns floor-grouped corridor polylines
/// that hug the edge geometry, or `None` when the projections are
/// disconnected.
pub fn route(graph: &RouteGraph, origin: Point3, dest: Point3) -> Option<Route> {
    // Reject non-finite endpoint coordinates with a controlled `None` — never a
    // panic or NaN-poisoned comparison (which would trap the WASM instance).
    if !endpoint_is_finite(&origin) || !endpoint_is_finite(&dest) {
        return None;
    }
    let o = snap_to_edge(graph, &origin)?;
    let d = snap_to_edge(graph, &dest)?;
    let origin_projected = [o.projected[0], o.projected[1], o.ordinal];
    let dest_projected = [d.projected[0], d.projected[1], d.ordinal];

    // Same-edge shortcut: walk straight along the one edge between projections.
    if o.edge_index == d.edge_index {
        let e = &graph.edges[o.edge_index];
        let poly = graph.edge_polyline(e);
        let (lo, hi) = (o.along.min(d.along), o.along.max(d.along));
        let mut coords = vec![[origin_projected[0], origin_projected[1]]];
        // Interior polyline vertices whose arc-length falls strictly between.
        let mut acc = 0.0;
        for w in poly.windows(2) {
            acc += haversine_m(w[0][0], w[0][1], w[1][0], w[1][1]);
            if acc > lo && acc < hi {
                coords.push(w[1]);
            }
        }
        coords.push([dest_projected[0], dest_projected[1]]);
        if o.along > d.along {
            coords.reverse();
        }
        let weight = (e.weight as f64 * (hi - lo) / o.total.max(f64::EPSILON)) as f32;
        return Some(Route {
            segments: group_segments(
                coords
                    .into_iter()
                    .map(|c| TaggedVertex { coord: c, ordinal: e.ordinal })
                    .collect(),
            ),
            total_weight: weight,
            origin_projected,
            dest_projected,
        });
    }

    let n = graph.nodes.len();
    let mut adj: Vec<Vec<(usize, usize, f32)>> = vec![Vec::new(); n]; // (next, edge_index, weight)
    let mut k = f64::INFINITY;
    for (ei, e) in graph.edges.iter().enumerate() {
        let (from, to) = (e.from as usize, e.to as usize);
        if from >= n || to >= n {
            continue;
        }
        adj[from].push((to, ei, e.weight));
        adj[to].push((from, ei, e.weight));
        let m = haversine_m(graph.nodes[from].lon, graph.nodes[from].lat, graph.nodes[to].lon, graph.nodes[to].lat);
        if m > 0.0 {
            k = k.min(f64::from(e.weight) / m);
        }
    }
    if !k.is_finite() {
        k = 0.0;
    }
    // Partial-edge costs from each projection to that edge's endpoints.
    let oe = &graph.edges[o.edge_index];
    let de = &graph.edges[d.edge_index];
    let o_from_cost = f64::from(oe.weight) * o.along / o.total.max(f64::EPSILON);
    let o_to_cost = f64::from(oe.weight) * (o.total - o.along) / o.total.max(f64::EPSILON);
    let d_from_cost = f64::from(de.weight) * d.along / d.total.max(f64::EPSILON);
    let d_to_cost = f64::from(de.weight) * (d.total - d.along) / d.total.max(f64::EPSILON);

    // Heuristic toward the destination projection point.
    let h = |i: usize| {
        let node = &graph.nodes[i];
        k * haversine_m(node.lon, node.lat, dest_projected[0], dest_projected[1])
    };

    let mut dist = vec![f64::INFINITY; n];
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; n]; // (prev_node, edge_index)
    let seed = [(oe.from as usize, o_from_cost), (oe.to as usize, o_to_cost)];
    let mut heap = BinaryHeap::new();
    for (node, g0) in seed {
        if g0 < dist[node] {
            dist[node] = g0;
            heap.push(Open { f: g0 + h(node), g: g0, node });
        }
    }
    let (dp, dq) = (de.from as usize, de.to as usize);
    // Run until both destination endpoints are finalized or the heap empties.
    let mut settled_p = false;
    let mut settled_q = false;
    while let Some(Open { g, node, .. }) = heap.pop() {
        if g > dist[node] {
            continue;
        }
        if node == dp {
            settled_p = true;
        }
        if node == dq {
            settled_q = true;
        }
        if settled_p && settled_q {
            break;
        }
        for &(next, ei, w) in &adj[node] {
            let ng = g + f64::from(w);
            if ng < dist[next] {
                dist[next] = ng;
                parent[next] = Some((node, ei));
                heap.push(Open { f: ng + h(next), g: ng, node: next });
            }
        }
    }

    // Pick the destination endpoint minimizing (dist + partial-to-dest).
    let cand_p = if dist[dp].is_finite() { Some((dp, dist[dp] + d_from_cost)) } else { None };
    let cand_q = if dist[dq].is_finite() { Some((dq, dist[dq] + d_to_cost)) } else { None };
    let (goal, total) = [cand_p, cand_q]
        .into_iter()
        .flatten()
        .min_by(|a, b| a.1.total_cmp(&b.1))?;

    // Reconstruct the node path goal → origin endpoint.
    let mut node_path = vec![goal];
    let mut edge_path = Vec::new(); // edge_index used to STEP INTO each node from its parent
    let mut cur = goal;
    while let Some((prev, ei)) = parent[cur] {
        edge_path.push(ei);
        node_path.push(prev);
        cur = prev;
    }
    node_path.reverse();
    edge_path.reverse();
    // `node_path[i] -> node_path[i+1]` traverses `edge_path[i]`.

    // Assemble tagged vertices: origin projection → first node partial → edge
    // polylines (oriented) → last node → dest projection partial.
    let mut verts: Vec<TaggedVertex> = Vec::new();
    verts.push(TaggedVertex { coord: [origin_projected[0], origin_projected[1]], ordinal: oe.ordinal });
    // Partial from origin projection to the first node along the origin edge.
    let first_node = node_path[0];
    for c in partial_polyline(graph, oe, o.along, first_node == oe.from as usize) {
        verts.push(TaggedVertex { coord: c, ordinal: oe.ordinal });
    }
    // Node-to-node edge polylines (skip the shared leading vertex each time).
    for w in 0..edge_path.len() {
        let e = &graph.edges[edge_path[w]];
        let forward = node_path[w] == e.from as usize;
        let mut poly = graph.edge_polyline(e);
        if !forward {
            poly.reverse();
        }
        for c in poly.into_iter().skip(1) {
            verts.push(TaggedVertex { coord: c, ordinal: e.ordinal });
        }
    }
    // Partial from the last node to the dest projection along the dest edge.
    let last_node = *node_path.last().unwrap();
    for c in partial_polyline(graph, de, d.along, last_node == de.from as usize).into_iter().rev() {
        // partial_polyline returns projection→endpoint; we need endpoint→projection.
        verts.push(TaggedVertex { coord: c, ordinal: de.ordinal });
    }
    verts.push(TaggedVertex { coord: [dest_projected[0], dest_projected[1]], ordinal: de.ordinal });

    Some(Route {
        segments: group_segments(verts),
        total_weight: total as f32,
        origin_projected,
        dest_projected,
    })
}

/// Vertices of `edge`'s polyline from the projection (at arc-length `along`) to
/// the endpoint indicated by `to_from` (`true` = the edge's `from` endpoint),
/// EXCLUDING the projection point itself (the caller already emitted it) and
/// INCLUDING the endpoint node.
fn partial_polyline(graph: &RouteGraph, edge: &RouteEdge, along: f64, to_from: bool) -> Vec<[f64; 2]> {
    let poly = graph.edge_polyline(edge);
    let mut acc = 0.0;
    let mut out: Vec<[f64; 2]> = Vec::new();
    // Collect vertices on the side of `along` toward the chosen endpoint.
    let mut cum = vec![0.0];
    for w in poly.windows(2) {
        acc += haversine_m(w[0][0], w[0][1], w[1][0], w[1][1]);
        cum.push(acc);
    }
    if to_from {
        // toward `from` (arc-length 0): vertices with cum < along, descending.
        for i in (0..poly.len()).rev() {
            if cum[i] < along {
                out.push(poly[i]);
            }
        }
    } else {
        // toward `to` (arc-length total): vertices with cum > along, ascending.
        for i in 0..poly.len() {
            if cum[i] > along {
                out.push(poly[i]);
            }
        }
    }
    out
}

/// Collapse consecutive same-ordinal vertices into `RouteSegment` runs,
/// dropping exact-duplicate adjacent coordinates. At a floor change the
/// junction point is repeated as the first point of the new run so every
/// segment stays a drawable polyline.
fn group_segments(verts: Vec<TaggedVertex>) -> Vec<RouteSegment> {
    let mut segments: Vec<RouteSegment> = Vec::new();
    for v in verts {
        match segments.last_mut() {
            Some(seg) if seg.ordinal == v.ordinal => {
                if seg.coordinates.last() != Some(&v.coord) {
                    seg.coordinates.push(v.coord);
                }
            }
            _ => {
                let mut coordinates = Vec::new();
                if let Some(seg) = segments.last() {
                    if let Some(&junction) = seg.coordinates.last() {
                        coordinates.push(junction);
                    }
                }
                coordinates.push(v.coord);
                segments.push(RouteSegment { ordinal: v.ordinal, coordinates });
            }
        }
    }
    // A single-vertex trailing run is not drawable; keep runs with >= 2 points.
    segments.retain(|s| s.coordinates.len() >= 2);
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::*;

    #[test]
    fn route_traces_the_corridor_polyline() {
        // from(139.0) --bend(139.001,35.001)--> mid(139.002) --> to(139.003)
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.003, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge { from: 0, to: 1, weight: 100.0, ordinal: 0.0, interior: vec![[139.001, 35.001]] },
                RouteEdge { from: 1, to: 2, weight: 100.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let r = route(
            &graph,
            Point3 { lon: 139.0, lat: 35.0, ordinal: 0.0 },
            Point3 { lon: 139.003, lat: 35.0, ordinal: 0.0 },
        )
        .expect("endpoints route");
        assert_eq!(r.segments.len(), 1);
        assert_eq!(r.segments[0].ordinal, 0.0);
        // The bend vertex is present → the line hugs the corridor.
        assert!(r.segments[0].coordinates.contains(&[139.001, 35.001]));
        assert_eq!(r.segments[0].coordinates.first(), Some(&[139.0, 35.0]));
        assert_eq!(r.segments[0].coordinates.last(), Some(&[139.003, 35.0]));
    }

    #[test]
    fn route_from_mid_corridor_click_starts_at_projection() {
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![RouteEdge { from: 0, to: 1, weight: 100.0, ordinal: 0.0, interior: vec![] }],
        };
        // Both clicks land mid-edge (same edge) → straight slice between them.
        let r = route(
            &graph,
            Point3 { lon: 139.0005, lat: 35.0002, ordinal: 0.0 },
            Point3 { lon: 139.0015, lat: 35.0002, ordinal: 0.0 },
        )
        .expect("same-edge route");
        let first = r.origin_projected;
        assert!((first[0] - 139.0005).abs() < 1e-3);
        assert_eq!(r.segments[0].coordinates.first().map(|c| c[0]), Some(r.origin_projected[0]));
        assert_eq!(r.segments[0].coordinates.last().map(|c| c[0]), Some(r.dest_projected[0]));
    }

    #[test]
    fn route_splits_segments_at_floor_change() {
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0, ordinal: 1.0 },
            ],
            edges: vec![
                RouteEdge { from: 0, to: 1, weight: 100.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 1, to: 2, weight: 5000.0, ordinal: 1.0, interior: vec![] },
            ],
        };
        let r = route(
            &graph,
            Point3 { lon: 139.0, lat: 35.0, ordinal: 0.0 },
            Point3 { lon: 139.001, lat: 35.0, ordinal: 1.0 },
        )
        .expect("cross-floor route");
        let ords: Vec<f64> = r.segments.iter().map(|s| s.ordinal).collect();
        assert_eq!(ords, vec![0.0, 1.0]);
    }

    fn geom_graph() -> RouteGraph {
        // One curved edge on ordinal 0 from (139.0,35.0) to (139.002,35.0)
        // via a bend at (139.001, 35.001).
        RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 100.0,
                ordinal: 0.0,
                interior: vec![[139.001, 35.001]],
            }],
        }
    }

    #[test]
    fn snaps_click_onto_nearest_edge() {
        let g = geom_graph();
        // Click near the bend, slightly off it.
        let s = snap_to_edge(&g, &Point3 { lon: 139.001, lat: 35.0009, ordinal: 0.0 })
            .expect("snaps to the only edge");
        assert_eq!(s.edge_index, 0);
        // Projection lands at/near the bend vertex.
        assert!((s.projected[0] - 139.001).abs() < 1e-4);
        assert!(s.along > 0.0 && s.along < s.total);
    }

    #[test]
    fn snap_prefers_same_ordinal_edge() {
        let mut g = geom_graph();
        g.nodes.push(RouteNode { lon: 139.001, lat: 35.0, ordinal: -1.0 });
        g.nodes.push(RouteNode { lon: 139.0011, lat: 35.0, ordinal: -1.0 });
        g.edges.push(RouteEdge { from: 2, to: 3, weight: 10.0, ordinal: -1.0, interior: vec![] });
        // Click on ordinal 0 sitting right over the B1 edge still snaps to the F1 edge.
        let s = snap_to_edge(&g, &Point3 { lon: 139.001, lat: 35.0, ordinal: 0.0 }).unwrap();
        assert_eq!(g.edges[s.edge_index].ordinal, 0.0);
    }

    #[test]
    fn route_rejects_non_finite_endpoints() {
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge { from: 0, to: 1, weight: 100.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 1, to: 2, weight: 100.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let ok = Point3 { lon: 139.0, lat: 35.0, ordinal: 0.0 };
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            // A controlled `None` — never a panic — for any non-finite coord.
            assert!(route(&graph, Point3 { lon: bad, ..ok }, ok).is_none());
            assert!(route(&graph, ok, Point3 { lat: bad, ..ok }).is_none());
            assert!(route(&graph, ok, Point3 { ordinal: bad, ..ok }).is_none());
        }
    }

}
