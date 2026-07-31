use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::graph::{meters_to_cost, RouteEdge, RouteGraph};

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
    /// Actual origin edge index that seeded this path (not candidate rank).
    origin_edge: usize,
}

impl Eq for Open {}

impl Ord for Open {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap by f, then lower origin edge index, then node index.
        other
            .f
            .total_cmp(&self.f)
            .then_with(|| self.origin_edge.cmp(&other.origin_edge))
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

/// Snap candidates evaluated per endpoint click, best first.
const SNAP_CANDIDATES: usize = 3;

/// The up-to-[`SNAP_CANDIDATES`] nearest same-floor edges by projection
/// distance (ties by edge index). When no same-floor edge exists, the single
/// nearest off-floor edge — the fallback for floors the network does not
/// cover.
fn snap_candidates(graph: &RouteGraph, p: &Point3) -> Vec<EdgeSnap> {
    let mut same: Vec<(usize, EdgeSnap, f64)> = Vec::new();
    let mut best_off: Option<(EdgeSnap, f64)> = None;
    for (i, e) in graph.edges.iter().enumerate() {
        let poly = graph.edge_polyline(e);
        let (proj, along, total) = project_point_on_polyline(&poly, p.lon, p.lat);
        let dist = haversine_m(p.lon, p.lat, proj[0], proj[1]);
        let snap = EdgeSnap {
            edge_index: i,
            projected: proj,
            along,
            total,
            ordinal: e.ordinal,
        };
        if e.ordinal == p.ordinal {
            same.push((i, snap, dist));
        } else if best_off.as_ref().is_none_or(|(_, bd)| dist < *bd) {
            best_off = Some((snap, dist));
        }
    }
    if same.is_empty() {
        return best_off.map_or_else(Vec::new, |(s, _)| vec![s]);
    }
    same.sort_by(|a, b| a.2.total_cmp(&b.2).then(a.0.cmp(&b.0)));
    same.truncate(SNAP_CANDIDATES);
    same.into_iter().map(|(_, s, _)| s).collect()
}

/// Off-network connector cost (click → projection) in routing-cost units.
fn connector_cost(p: &Point3, s: &EdgeSnap) -> f64 {
    f64::from(meters_to_cost(haversine_m(
        p.lon,
        p.lat,
        s.projected[0],
        s.projected[1],
    )))
}

/// Route from `origin` to `dest` over the graph: project both endpoints onto
/// their best same-floor edge candidates, then A* between the virtual
/// endpoints of every candidate pair (edges traversed in both directions),
/// choosing the snap pair and path with the lowest total walked cost (graph
/// + connector legs). A shared-edge pair also competes as a direct
/// junction-free walk. Returns floor-grouped corridor polylines that hug the
/// edge geometry, or `None` when the projections are disconnected.
pub fn route(graph: &RouteGraph, origin: Point3, dest: Point3) -> Option<Route> {
    // Reject non-finite endpoint coordinates with a controlled `None` — never
    // a panic or NaN-poisoned comparison (which would trap the WASM instance).
    if !endpoint_is_finite(&origin) || !endpoint_is_finite(&dest) {
        return None;
    }
    let ocands = snap_candidates(graph, &origin);
    let dcands = snap_candidates(graph, &dest);
    if ocands.is_empty() || dcands.is_empty() {
        return None;
    }

    // Direct same-edge candidates: walk straight along the one shared edge.
    // Selection key: (sel cost, origin edge index, dest edge index).
    let mut best_direct: Option<(Route, f64, usize, usize)> = None;
    for o in &ocands {
        for d in &dcands {
            if o.edge_index != d.edge_index {
                continue;
            }
            let r = same_edge_route(graph, o, d);
            let sel =
                f64::from(r.total_weight) + connector_cost(&origin, o) + connector_cost(&dest, d);
            let better = match &best_direct {
                None => true,
                Some((_, bs, bo, bd)) => {
                    sel.total_cmp(bs) == Ordering::Less
                        || (sel.total_cmp(bs) == Ordering::Equal
                            && (o.edge_index, d.edge_index) < (*bo, *bd))
                }
            };
            if better {
                best_direct = Some((r, sel, o.edge_index, d.edge_index));
            }
        }
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
        let m = haversine_m(
            graph.nodes[from].lon,
            graph.nodes[from].lat,
            graph.nodes[to].lon,
            graph.nodes[to].lat,
        );
        if m > 0.0 {
            k = k.min(f64::from(e.weight) / m);
        }
    }
    if !k.is_finite() {
        k = 0.0;
    }

    // Heuristic: lower bound toward the nearest destination projection.
    let h = |i: usize| {
        let node = &graph.nodes[i];
        dcands
            .iter()
            .map(|d| k * haversine_m(node.lon, node.lat, d.projected[0], d.projected[1]))
            .fold(f64::INFINITY, f64::min)
    };

    // Multi-source seeds: both endpoints of every origin candidate, with the
    // connector leg folded in so selection accounts for the off-network walk.
    // On equal g, keep the seed with the lower actual origin edge index.
    let mut dist = vec![f64::INFINITY; n];
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; n]; // (prev_node, edge_index)
    let mut seed_origin_edge: Vec<Option<usize>> = vec![None; n]; // node → origin edge_index
    let mut heap = BinaryHeap::new();
    for o in &ocands {
        let oe = &graph.edges[o.edge_index];
        let conn = connector_cost(&origin, o);
        let o_from_cost = f64::from(oe.weight) * o.along / o.total.max(f64::EPSILON) + conn;
        let o_to_cost =
            f64::from(oe.weight) * (o.total - o.along) / o.total.max(f64::EPSILON) + conn;
        for (node, g0) in [(oe.from as usize, o_from_cost), (oe.to as usize, o_to_cost)] {
            let better = match (dist[node], seed_origin_edge[node]) {
                (d, _) if g0 < d => true,
                (d, Some(be)) if g0 == d && o.edge_index < be => true,
                (d, None) if g0 == d => true,
                _ => false,
            };
            if better {
                dist[node] = g0;
                seed_origin_edge[node] = Some(o.edge_index);
                parent[node] = None;
                heap.push(Open {
                    f: g0 + h(node),
                    g: g0,
                    node,
                    origin_edge: o.edge_index,
                });
            }
        }
    }

    // Goals: both endpoints of every destination candidate.
    let mut is_goal = vec![false; n];
    let mut goal_count = 0usize;
    for d in &dcands {
        let de = &graph.edges[d.edge_index];
        for node in [de.from as usize, de.to as usize] {
            if !is_goal[node] {
                is_goal[node] = true;
                goal_count += 1;
            }
        }
    }
    let mut settled = 0usize;
    while let Some(Open {
        g,
        node,
        origin_edge,
        ..
    }) = heap.pop()
    {
        // Stale entry: worse (g, origin_edge) than the recorded best.
        let stale = match seed_origin_edge[node] {
            Some(be) => {
                g > dist[node] || (g == dist[node] && origin_edge > be)
            }
            None => g > dist[node],
        };
        if stale {
            continue;
        }
        if is_goal[node] {
            settled += 1;
            if settled == goal_count {
                break;
            }
        }
        for &(next, ei, w) in &adj[node] {
            let ng = g + f64::from(w);
            let better = match (dist[next], seed_origin_edge[next]) {
                (d, _) if ng < d => true,
                (d, Some(be)) if ng == d && origin_edge < be => true,
                (d, None) if ng == d => true,
                _ => false,
            };
            if better {
                dist[next] = ng;
                parent[next] = Some((node, ei));
                seed_origin_edge[next] = Some(origin_edge);
                heap.push(Open {
                    f: ng + h(next),
                    g: ng,
                    node: next,
                    origin_edge,
                });
            }
        }
    }

    // Choose the goal minimizing (sel cost, origin edge index, dest edge index,
    // endpoint node). Candidate rank is never a semantic tie-break.
    let mut best_goal: Option<(f64, usize, usize, usize)> = None; // (sel, o_edge, d_edge, node)
    for d in &dcands {
        let de = &graph.edges[d.edge_index];
        let conn = connector_cost(&dest, d);
        let d_from_cost = f64::from(de.weight) * d.along / d.total.max(f64::EPSILON);
        let d_to_cost = f64::from(de.weight) * (d.total - d.along) / d.total.max(f64::EPSILON);
        for (node, partial) in [(de.from as usize, d_from_cost), (de.to as usize, d_to_cost)] {
            if !dist[node].is_finite() {
                continue;
            }
            let Some(o_edge) = seed_origin_edge[node] else {
                continue;
            };
            let sel = dist[node] + partial + conn;
            let key = (o_edge, d.edge_index, node);
            let better = match &best_goal {
                None => true,
                Some((bs, bo, bd, bnode)) => {
                    sel.total_cmp(bs) == Ordering::Less
                        || (sel.total_cmp(bs) == Ordering::Equal
                            && key < (*bo, *bd, *bnode))
                }
            };
            if better {
                best_goal = Some((sel, o_edge, d.edge_index, node));
            }
        }
    }

    // Assemble the winning network route, if any.
    let network_route = best_goal.map(|(sel, o_edge, d_edge, goal)| {
        let o = ocands
            .iter()
            .find(|c| c.edge_index == o_edge)
            .expect("winning origin edge is a candidate");
        let d = dcands
            .iter()
            .find(|c| c.edge_index == d_edge)
            .expect("winning dest edge is a candidate");
        let oe = &graph.edges[o.edge_index];
        let de = &graph.edges[d.edge_index];
        let mut node_path = vec![goal];
        let mut edge_path = Vec::new(); // edge used to STEP INTO each node
        let mut cur = goal;
        while let Some((prev, ei)) = parent[cur] {
            edge_path.push(ei);
            node_path.push(prev);
            cur = prev;
        }
        node_path.reverse();
        edge_path.reverse();
        debug_assert_eq!(
            seed_origin_edge[cur],
            Some(o_edge),
            "path seed origin edge matches selection"
        );
        let origin_projected = [o.projected[0], o.projected[1], o.ordinal];
        let dest_projected = [d.projected[0], d.projected[1], d.ordinal];

        let mut verts: Vec<TaggedVertex> = Vec::new();
        verts.push(TaggedVertex {
            coord: [origin_projected[0], origin_projected[1]],
            ordinal: oe.ordinal,
        });
        let first_node = node_path[0];
        for c in partial_polyline(graph, oe, o.along, first_node == oe.from as usize) {
            verts.push(TaggedVertex {
                coord: c,
                ordinal: oe.ordinal,
            });
        }
        for w in 0..edge_path.len() {
            let e = &graph.edges[edge_path[w]];
            let forward = node_path[w] == e.from as usize;
            let mut poly = graph.edge_polyline(e);
            if !forward {
                poly.reverse();
            }
            for c in poly.into_iter().skip(1) {
                verts.push(TaggedVertex {
                    coord: c,
                    ordinal: e.ordinal,
                });
            }
        }
        let last_node = *node_path.last().unwrap();
        for c in partial_polyline(graph, de, d.along, last_node == de.from as usize)
            .into_iter()
            .rev()
        {
            // partial_polyline returns projection→endpoint; we need endpoint→projection.
            verts.push(TaggedVertex {
                coord: c,
                ordinal: de.ordinal,
            });
        }
        verts.push(TaggedVertex {
            coord: [dest_projected[0], dest_projected[1]],
            ordinal: de.ordinal,
        });

        // Reported weight stays graph-only: strip the connector legs that
        // were folded into the seed/goal costs for selection.
        let graph_cost = sel - connector_cost(&origin, o) - connector_cost(&dest, d);
        (
            Route {
                segments: group_segments(verts),
                total_weight: graph_cost as f32,
                origin_projected,
                dest_projected,
            },
            sel,
            o_edge,
            d_edge,
        )
    });

    // Prefer lower sel cost; on exact tie the network route wins (Task 2 / 1a:
    // traces real junctions). Direct same-edge only wins when strictly cheaper.
    match (network_route, best_direct) {
        (Some((net, nsel, _, _)), Some((direct, dsel, _, _))) => {
            Some(if dsel < nsel { direct } else { net })
        }
        (Some((net, _, _, _)), None) => Some(net),
        (None, Some((direct, _, _, _))) => Some(direct),
        (None, None) => None,
    }
}

/// Direct walk along a single shared edge between two projections (no
/// junctions). `o` and `d` must reference the same edge.
fn same_edge_route(graph: &RouteGraph, o: &EdgeSnap, d: &EdgeSnap) -> Route {
    let e = &graph.edges[o.edge_index];
    let poly = graph.edge_polyline(e);
    let (lo, hi) = (o.along.min(d.along), o.along.max(d.along));
    let mut coords = vec![[o.projected[0], o.projected[1]]];
    let mut acc = 0.0;
    for w in poly.windows(2) {
        acc += haversine_m(w[0][0], w[0][1], w[1][0], w[1][1]);
        if acc > lo && acc < hi {
            coords.push(w[1]);
        }
    }
    coords.push([d.projected[0], d.projected[1]]);
    if o.along > d.along {
        coords.reverse();
    }
    let weight = (e.weight as f64 * (hi - lo) / o.total.max(f64::EPSILON)) as f32;
    Route {
        segments: group_segments(
            coords
                .into_iter()
                .map(|c| TaggedVertex {
                    coord: c,
                    ordinal: e.ordinal,
                })
                .collect(),
        ),
        total_weight: weight,
        origin_projected: [o.projected[0], o.projected[1], o.ordinal],
        dest_projected: [d.projected[0], d.projected[1], d.ordinal],
    }
}

/// Vertices of `edge`'s polyline from the projection (at arc-length `along`) to
/// the endpoint indicated by `to_from` (`true` = the edge's `from` endpoint),
/// EXCLUDING the projection point itself (the caller already emitted it) and
/// INCLUDING the endpoint node.
fn partial_polyline(
    graph: &RouteGraph,
    edge: &RouteEdge,
    along: f64,
    to_from: bool,
) -> Vec<[f64; 2]> {
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
                if let Some(seg) = segments.last()
                    && let Some(&junction) = seg.coordinates.last()
                {
                    coordinates.push(junction);
                }
                coordinates.push(v.coord);
                segments.push(RouteSegment {
                    ordinal: v.ordinal,
                    coordinates,
                });
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
                RouteNode {
                    lon: 139.0,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.002,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.003,
                    lat: 35.0,
                    ordinal: 0.0,
                },
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: 100.0,
                    ordinal: 0.0,
                    interior: vec![[139.001, 35.001]],
                },
                RouteEdge {
                    from: 1,
                    to: 2,
                    weight: 100.0,
                    ordinal: 0.0,
                    interior: vec![],
                },
            ],
        };
        let r = route(
            &graph,
            Point3 {
                lon: 139.0,
                lat: 35.0,
                ordinal: 0.0,
            },
            Point3 {
                lon: 139.003,
                lat: 35.0,
                ordinal: 0.0,
            },
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
                RouteNode {
                    lon: 139.0,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.002,
                    lat: 35.0,
                    ordinal: 0.0,
                },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 100.0,
                ordinal: 0.0,
                interior: vec![],
            }],
        };
        // Both clicks land mid-edge (same edge) → straight slice between them.
        let r = route(
            &graph,
            Point3 {
                lon: 139.0005,
                lat: 35.0002,
                ordinal: 0.0,
            },
            Point3 {
                lon: 139.0015,
                lat: 35.0002,
                ordinal: 0.0,
            },
        )
        .expect("same-edge route");
        let first = r.origin_projected;
        assert!((first[0] - 139.0005).abs() < 1e-3);
        assert_eq!(
            r.segments[0].coordinates.first().map(|c| c[0]),
            Some(r.origin_projected[0])
        );
        assert_eq!(
            r.segments[0].coordinates.last().map(|c| c[0]),
            Some(r.dest_projected[0])
        );
    }

    #[test]
    fn route_splits_segments_at_floor_change() {
        let graph = RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.0,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.001,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.001,
                    lat: 35.0,
                    ordinal: 1.0,
                },
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: 100.0,
                    ordinal: 0.0,
                    interior: vec![],
                },
                RouteEdge {
                    from: 1,
                    to: 2,
                    weight: 5000.0,
                    ordinal: 1.0,
                    interior: vec![],
                },
            ],
        };
        let r = route(
            &graph,
            Point3 {
                lon: 139.0,
                lat: 35.0,
                ordinal: 0.0,
            },
            Point3 {
                lon: 139.001,
                lat: 35.0,
                ordinal: 1.0,
            },
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
                RouteNode {
                    lon: 139.0,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.002,
                    lat: 35.0,
                    ordinal: 0.0,
                },
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
        let cands = snap_candidates(
            &g,
            &Point3 { lon: 139.001, lat: 35.0009, ordinal: 0.0 },
        );
        let s = cands.first().expect("snaps to the only edge");
        assert_eq!(s.edge_index, 0);
        assert!((s.projected[0] - 139.001).abs() < 1e-4);
        assert!(s.along > 0.0 && s.along < s.total);
    }

    #[test]
    fn snap_prefers_same_ordinal_edge() {
        let mut g = geom_graph();
        g.nodes.push(RouteNode { lon: 139.001, lat: 35.0, ordinal: -1.0 });
        g.nodes.push(RouteNode { lon: 139.0011, lat: 35.0, ordinal: -1.0 });
        g.edges.push(RouteEdge { from: 2, to: 3, weight: 10.0, ordinal: -1.0, interior: vec![] });
        let cands = snap_candidates(&g, &Point3 { lon: 139.001, lat: 35.0, ordinal: 0.0 });
        assert_eq!(g.edges[cands[0].edge_index].ordinal, 0.0);
        assert!(
            cands.iter().all(|s| g.edges[s.edge_index].ordinal == 0.0),
            "off-floor edges are never same-floor candidates"
        );
    }

    #[test]
    fn second_nearest_edge_wins_when_route_is_shorter() {
        // Corridor 0→1 along y=35 (weight 182_000 ≈ 182 m). A high-cost dead-end
        // spur 0→2 climbs north. The origin click sits right next to the spur
        // (nearest by projection) but the corridor is the far better entry:
        // the spur forces a long backtrack through node 0 plus the whole
        // corridor, so connector-aware multi-candidate selection prefers the
        // second-nearest edge. Spur weight is inflated vs geometric length so
        // the same-edge spur shortcut cannot undercut the corridor path via a
        // long destination connector.
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.0005, lat: 35.001, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge { from: 0, to: 1, weight: 182_000.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 0, to: 2, weight: 600_000.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let r = route(
            &graph,
            Point3 { lon: 139.0005, lat: 35.0009, ordinal: 0.0 },
            Point3 { lon: 139.002, lat: 35.0, ordinal: 0.0 },
        )
        .expect("endpoints route");
        assert_eq!(
            r.origin_projected[1], 35.0,
            "origin snapped to the corridor, not the nearer spur"
        );
        assert!(
            r.total_weight < 150_000.0,
            "corridor entry is cheaper overall: {}",
            r.total_weight
        );
    }

    #[test]
    fn multi_candidate_route_is_deterministic() {
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.0005, lat: 35.001, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge { from: 0, to: 1, weight: 182_000.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 0, to: 2, weight: 600_000.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let o = Point3 { lon: 139.0005, lat: 35.0009, ordinal: 0.0 };
        let d = Point3 { lon: 139.002, lat: 35.0, ordinal: 0.0 };
        assert_eq!(route(&graph, o, d), route(&graph, o, d));
    }

    /// Build two parallel E–W edges and tune weights so both same-edge walks
    /// share an identical connector-inclusive selection cost, while the origin
    /// (and dest) click is nearer the higher-index edge. Used by the equal-cost
    /// edge-index tie-break regressions.
    fn equal_cost_parallel_graph(
        nearer_edge: usize,
    ) -> (RouteGraph, Point3, Point3, [f64; 2], [f64; 2]) {
        assert!(nearer_edge == 0 || nearer_edge == 1);
        let y0 = 35.0;
        let y1 = 35.001;
        // Origin/dest slightly closer to y1 so edge 1 ranks first by snap distance.
        let origin = Point3 {
            lon: 139.001,
            lat: 35.0008,
            ordinal: 0.0,
        };
        let dest = Point3 {
            lon: 139.0015,
            lat: 35.0008,
            ordinal: 0.0,
        };
        let mut graph = RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.0,
                    lat: y0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.002,
                    lat: y0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.0,
                    lat: y1,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.002,
                    lat: y1,
                    ordinal: 0.0,
                },
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: 200_000.0,
                    ordinal: 0.0,
                    interior: vec![],
                },
                RouteEdge {
                    from: 2,
                    to: 3,
                    weight: 200_000.0, // tuned below
                    ordinal: 0.0,
                    interior: vec![],
                },
            ],
        };

        let oc = snap_candidates(&graph, &origin);
        let dc = snap_candidates(&graph, &dest);
        assert_eq!(oc[0].edge_index, 1, "nearer origin snap is edge 1");
        assert_eq!(dc[0].edge_index, 1, "nearer dest snap is edge 1");
        let o0 = *oc.iter().find(|s| s.edge_index == 0).unwrap();
        let o1 = *oc.iter().find(|s| s.edge_index == 1).unwrap();
        let d0 = *dc.iter().find(|s| s.edge_index == 0).unwrap();
        let d1 = *dc.iter().find(|s| s.edge_index == 1).unwrap();

        // same_edge_route weight: (e.weight as f64 * (hi-lo) / total) as f32
        // selection: f64::from(weight) + connectors
        let r0 = same_edge_route(&graph, &o0, &d0);
        let sel0 = f64::from(r0.total_weight)
            + connector_cost(&origin, &o0)
            + connector_cost(&dest, &d0);
        let hi_lo = (o1.along - d1.along).abs();
        let total = o1.total.max(f64::EPSILON);
        let need_tw = sel0 - connector_cost(&origin, &o1) - connector_cost(&dest, &d1);
        let base = (need_tw * total / hi_lo.max(f64::EPSILON)) as f32;
        let mut found = None;
        for i in -2_000_000i32..2_000_001 {
            let w = f32::from_bits(base.to_bits().wrapping_add_signed(i));
            if !w.is_finite() || w <= 0.0 {
                continue;
            }
            graph.edges[1].weight = w;
            let r1 = same_edge_route(&graph, &o1, &d1);
            let sel1 = f64::from(r1.total_weight)
                + connector_cost(&origin, &o1)
                + connector_cost(&dest, &d1);
            if sel1 == sel0 {
                found = Some(w);
                break;
            }
        }
        graph.edges[1].weight = found.expect("bit-identical parallel same-edge selection cost");

        // Sanity: both same-edge selection costs match; edge 0 is the lower index.
        let r0 = same_edge_route(&graph, &o0, &d0);
        let r1 = same_edge_route(&graph, &o1, &d1);
        let sel0 = f64::from(r0.total_weight)
            + connector_cost(&origin, &o0)
            + connector_cost(&dest, &d0);
        let sel1 = f64::from(r1.total_weight)
            + connector_cost(&origin, &o1)
            + connector_cost(&dest, &d1);
        assert_eq!(sel0, sel1, "fixture selection costs must tie");
        let _ = nearer_edge;
        (
            graph,
            origin,
            dest,
            o0.projected,
            d0.projected, // lower-index projections
        )
    }

    #[test]
    fn equal_cost_prefers_lower_origin_edge_index() {
        let (graph, origin, dest, o_proj, _) = equal_cost_parallel_graph(1);
        let r = route(&graph, origin, dest).expect("equal-cost parallel route");
        assert!(
            (r.origin_projected[0] - o_proj[0]).abs() < 1e-12
                && (r.origin_projected[1] - o_proj[1]).abs() < 1e-12,
            "lower origin edge index wins equal-cost tie: got {:?} want {:?}",
            r.origin_projected,
            o_proj
        );
    }

    #[test]
    fn equal_cost_prefers_lower_destination_edge_index() {
        let (graph, origin, dest, _, d_proj) = equal_cost_parallel_graph(1);
        let r = route(&graph, origin, dest).expect("equal-cost parallel route");
        assert!(
            (r.dest_projected[0] - d_proj[0]).abs() < 1e-12
                && (r.dest_projected[1] - d_proj[1]).abs() < 1e-12,
            "lower dest edge index wins equal-cost tie: got {:?} want {:?}",
            r.dest_projected,
            d_proj
        );
    }

    #[test]
    fn snap_falls_back_to_off_floor_edge_when_no_same_floor() {
        let g = geom_graph();
        let cands = snap_candidates(
            &g,
            &Point3 { lon: 139.001, lat: 35.0009, ordinal: 5.0 },
        );
        assert_eq!(cands.len(), 1, "single off-floor fallback candidate");
        assert_eq!(cands[0].edge_index, 0);
    }

    #[test]
    fn route_rejects_non_finite_endpoints() {
        let graph = RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.0,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.001,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.002,
                    lat: 35.0,
                    ordinal: 0.0,
                },
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: 100.0,
                    ordinal: 0.0,
                    interior: vec![],
                },
                RouteEdge {
                    from: 1,
                    to: 2,
                    weight: 100.0,
                    ordinal: 0.0,
                    interior: vec![],
                },
            ],
        };
        let ok = Point3 {
            lon: 139.0,
            lat: 35.0,
            ordinal: 0.0,
        };
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            // A controlled `None` — never a panic — for any non-finite coord.
            assert!(route(&graph, Point3 { lon: bad, ..ok }, ok).is_none());
            assert!(route(&graph, ok, Point3 { lat: bad, ..ok }).is_none());
            assert!(route(&graph, ok, Point3 { ordinal: bad, ..ok }).is_none());
        }
    }

    #[test]
    fn network_detour_beats_same_edge_walk() {
        // U-shaped edge 0→1 (weight 6000): bottom corners at (139,35) and
        // (139.002,35), up 0.002 and across. Both clicks sit ON the U's arms
        // near the bottom, so they snap to the U edge. The 0→2→1 shortcut
        // (1000+1000) is far cheaper than walking the whole U.
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0005, ordinal: 0.0 },
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: 6000.0,
                    ordinal: 0.0,
                    interior: vec![[139.0, 35.002], [139.002, 35.002]],
                },
                RouteEdge { from: 0, to: 2, weight: 1000.0, ordinal: 0.0, interior: vec![] },
                RouteEdge { from: 2, to: 1, weight: 1000.0, ordinal: 0.0, interior: vec![] },
            ],
        };
        let r = route(
            &graph,
            Point3 { lon: 139.0, lat: 35.0002, ordinal: 0.0 },
            Point3 { lon: 139.002, lat: 35.0002, ordinal: 0.0 },
        )
        .expect("endpoints route");
        assert!(
            r.total_weight < 3000.0,
            "network detour beats the same-edge U walk: {}",
            r.total_weight
        );
        let coords: Vec<[f64; 2]> = r.segments.iter().flat_map(|s| s.coordinates.clone()).collect();
        assert!(
            coords.contains(&[139.001, 35.0005]),
            "route passes through the shortcut junction"
        );
    }
}
