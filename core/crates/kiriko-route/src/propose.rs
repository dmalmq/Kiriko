//! Walkable path proposals for the network editor's Smart Connect preview.
//!
//! [`propose_paths`] returns the current graph route (when A* connects the
//! pair) plus up to two new same-floor walkable candidates: along-network
//! and shorter. New geometry is grid A* on the floor's walkable union, then
//! greedy-LOS. Distinctness hides a new polyline that matches Current or the
//! other new candidate; Current is never hidden.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::f64::consts::PI;

use crate::geo_math::{EARTH_RADIUS_M, haversine_m, point_seg_dist_m};
use crate::graph::RouteGraph;
use crate::query::{Point3, Route, RouteProfile, route_node_path, route_with};
use crate::smooth::{WalkableFloor, chord_ok, smooth_route, walkable};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathCandidateKind {
    Current,
    AlongNetwork,
    Shorter,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PathCandidate {
    pub kind: PathCandidateKind,
    pub coordinates: Vec<[f64; 2]>,
    pub node_ids: Option<Vec<u64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PathProposal {
    pub from_id: u64,
    pub to_id: u64,
    pub candidates: Vec<PathCandidate>,
}

const GRID_CELL_M: f64 = 1.0;
const NEAR_GRAPH_M: f64 = 2.0;
const OFF_GRAPH_COST: f64 = 3.0;
const MAX_EXPANSIONS: usize = 50_000;
const MAX_RADIUS_M: f64 = 400.0;
const HAUSDORFF_M: f64 = 4.0;
const LENGTH_RATIO_LO: f64 = 0.95;
const LENGTH_RATIO_HI: f64 = 1.05;
const SAMPLE_M: f64 = 1.0;

/// Propose the current route and up to two new walkable paths between
/// `from_id` and `to_id`. Unknown ids yield empty `candidates`.
pub fn propose_paths(
    graph: &RouteGraph,
    node_ids: &[u64],
    floors: &[WalkableFloor],
    from_id: u64,
    to_id: u64,
    profile: &RouteProfile,
) -> PathProposal {
    let mut candidates = Vec::new();
    let Some(from_idx) = node_ids.iter().position(|&id| id == from_id) else {
        return PathProposal {
            from_id,
            to_id,
            candidates,
        };
    };
    let Some(to_idx) = node_ids.iter().position(|&id| id == to_id) else {
        return PathProposal {
            from_id,
            to_id,
            candidates,
        };
    };
    if from_idx >= graph.nodes.len() || to_idx >= graph.nodes.len() {
        return PathProposal {
            from_id,
            to_id,
            candidates,
        };
    }

    let from = &graph.nodes[from_idx];
    let to = &graph.nodes[to_idx];
    let origin = Point3 {
        lon: from.lon,
        lat: from.lat,
        ordinal: from.ordinal,
    };
    let dest = Point3 {
        lon: to.lon,
        lat: to.lat,
        ordinal: to.ordinal,
    };

    if let Some(raw) = route_with(graph, origin, dest, profile) {
        let mapped = route_node_path(graph, origin, dest, profile).map(|idxs| {
            idxs.into_iter()
                .filter_map(|i| node_ids.get(i).copied())
                .collect()
        });
        candidates.push(PathCandidate {
            kind: PathCandidateKind::Current,
            coordinates: flatten_route(&smooth_route(raw, floors)),
            node_ids: mapped,
        });
    }

    let Some(floor) = floors
        .iter()
        .find(|f| f.ordinal == from.ordinal && !f.polygons.is_empty())
    else {
        return PathProposal {
            from_id,
            to_id,
            candidates,
        };
    };
    if from.ordinal != to.ordinal {
        return PathProposal {
            from_id,
            to_id,
            candidates,
        };
    }

    let current_coords = candidates
        .iter()
        .find(|c| c.kind == PathCandidateKind::Current)
        .map(|c| c.coordinates.clone());

    if let Some(along) = grid_path(graph, floor, origin, dest, true) {
        let pulled = greedy_los(along, floor);
        if pulled_is_walkable(&pulled, floor)
            && follows_network(&pulled, graph, from.ordinal)
            && current_coords
                .as_deref()
                .is_none_or(|cur| !indistinct(cur, &pulled))
        {
            candidates.push(PathCandidate {
                kind: PathCandidateKind::AlongNetwork,
                coordinates: pulled,
                node_ids: None,
            });
        }
    }

    if let Some(shorter) = grid_path(graph, floor, origin, dest, false) {
        let pulled = greedy_los(shorter, floor);
        let vs_current = current_coords
            .as_deref()
            .is_none_or(|cur| !indistinct(cur, &pulled));
        let vs_other_new = candidates
            .iter()
            .find(|c| c.kind != PathCandidateKind::Current)
            .is_none_or(|c| !indistinct(&c.coordinates, &pulled));
        if pulled_is_walkable(&pulled, floor) && vs_current && vs_other_new {
            candidates.push(PathCandidate {
                kind: PathCandidateKind::Shorter,
                coordinates: pulled,
                node_ids: None,
            });
        }
    }

    PathProposal {
        from_id,
        to_id,
        candidates,
    }
}

/// `true` when the straight chord `a`→`b` stays inside `floor`.
pub fn walkable_chord(floor: &WalkableFloor, a: [f64; 2], b: [f64; 2]) -> bool {
    chord_ok(&[a, b], 0, 1, floor)
}

/// `true` when B should be hidden as a near-duplicate of A.
fn indistinct(a: &[[f64; 2]], b: &[[f64; 2]]) -> bool {
    let (la, lb) = (polyline_len_m(a), polyline_len_m(b));
    if la <= 0.0 || lb <= 0.0 {
        return false;
    }
    let ratio = la / lb;
    (LENGTH_RATIO_LO..=LENGTH_RATIO_HI).contains(&ratio) && hausdorff_m(a, b) < HAUSDORFF_M
}

fn flatten_route(route: &Route) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for seg in &route.segments {
        for &c in &seg.coordinates {
            if out.last() != Some(&c) {
                out.push(c);
            }
        }
    }
    out
}

/// `true` when most 1 m samples stay within [`NEAR_GRAPH_M`] of a same-floor
/// edge. Empty same-floor geometry (disconnected islands) counts as along.
fn follows_network(coords: &[[f64; 2]], graph: &RouteGraph, ordinal: f64) -> bool {
    let polys: Vec<Vec<[f64; 2]>> = graph
        .edges
        .iter()
        .filter(|e| e.ordinal == ordinal)
        .map(|e| graph.edge_polyline(e))
        .collect();
    if polys.is_empty() {
        return true;
    }
    let samples = sample_polyline(coords, SAMPLE_M);
    if samples.is_empty() {
        return false;
    }
    let near = samples
        .iter()
        .filter(|p| {
            polys.iter().any(|poly| {
                poly.windows(2)
                    .any(|w| point_seg_dist_m(**p, w[0], w[1]) < NEAR_GRAPH_M)
            })
        })
        .count();
    near * 4 >= samples.len() * 3
}

fn pulled_is_walkable(coords: &[[f64; 2]], floor: &WalkableFloor) -> bool {
    coords.windows(2).all(|w| walkable_chord(floor, w[0], w[1]))
}

fn greedy_los(coords: Vec<[f64; 2]>, floor: &WalkableFloor) -> Vec<[f64; 2]> {
    if coords.len() < 2 {
        return coords;
    }
    let mut out = Vec::with_capacity(coords.len());
    out.push(coords[0]);
    let mut i = 0;
    while i + 1 < coords.len() {
        let mut next = i + 1;
        for j in (i + 2..coords.len()).rev() {
            if chord_ok(&coords, i, j, floor) {
                next = j;
                break;
            }
        }
        out.push(coords[next]);
        i = next;
    }
    out
}

fn polyline_len_m(coords: &[[f64; 2]]) -> f64 {
    coords
        .windows(2)
        .map(|w| haversine_m(w[0][0], w[0][1], w[1][0], w[1][1]))
        .sum()
}

fn sample_polyline(coords: &[[f64; 2]], max_step_m: f64) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for w in coords.windows(2) {
        let (a, b) = (w[0], w[1]);
        let len = haversine_m(a[0], a[1], b[0], b[1]);
        let steps = (len / max_step_m).ceil().max(1.0) as usize;
        for s in 0..steps {
            let t = s as f64 / steps as f64;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    if let Some(&last) = coords.last() {
        out.push(last);
    }
    out
}

fn hausdorff_m(a: &[[f64; 2]], b: &[[f64; 2]]) -> f64 {
    let sa = sample_polyline(a, SAMPLE_M);
    let sb = sample_polyline(b, SAMPLE_M);
    let directed = |p: &[[f64; 2]], q: &[[f64; 2]]| -> f64 {
        p.iter()
            .map(|pi| {
                q.iter()
                    .map(|qj| haversine_m(pi[0], pi[1], qj[0], qj[1]))
                    .fold(f64::INFINITY, f64::min)
            })
            .fold(0.0_f64, f64::max)
    };
    directed(&sa, &sb).max(directed(&sb, &sa))
}

struct LocalFrame {
    origin_lon: f64,
    origin_lat: f64,
    m_per_deg_lon: f64,
    m_per_deg_lat: f64,
}

impl LocalFrame {
    fn new(lon: f64, lat: f64) -> Self {
        let m_per_deg_lat = EARTH_RADIUS_M * PI / 180.0;
        let m_per_deg_lon = m_per_deg_lat * lat.to_radians().cos();
        Self {
            origin_lon: lon,
            origin_lat: lat,
            m_per_deg_lon,
            m_per_deg_lat,
        }
    }

    fn to_xy(&self, lon: f64, lat: f64) -> (f64, f64) {
        (
            (lon - self.origin_lon) * self.m_per_deg_lon,
            (lat - self.origin_lat) * self.m_per_deg_lat,
        )
    }

    fn to_ll(&self, x: f64, y: f64) -> [f64; 2] {
        [
            self.origin_lon + x / self.m_per_deg_lon,
            self.origin_lat + y / self.m_per_deg_lat,
        ]
    }
}

#[derive(Clone, Copy, PartialEq)]
struct CellOpen {
    f: f64,
    g: f64,
    i: i32,
    j: i32,
}

impl Eq for CellOpen {}

impl Ord for CellOpen {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .f
            .total_cmp(&self.f)
            .then_with(|| other.g.total_cmp(&self.g))
            .then_with(|| self.i.cmp(&other.i))
            .then_with(|| self.j.cmp(&other.j))
    }
}

impl PartialOrd for CellOpen {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Grid A* in local metres at `from.lat`. `along_network` applies the 1×/3×
/// near-graph cost; otherwise every walkable step costs `step_m`.
fn grid_path(
    graph: &RouteGraph,
    floor: &WalkableFloor,
    from: Point3,
    to: Point3,
    along_network: bool,
) -> Option<Vec<[f64; 2]>> {
    let frame = LocalFrame::new(from.lon, from.lat);
    let (tx, ty) = frame.to_xy(to.lon, to.lat);
    let dest_i = tx.round() as i32;
    let dest_j = ty.round() as i32;
    let dest_ll = [to.lon, to.lat];

    let same_floor: Vec<Vec<[f64; 2]>> = graph
        .edges
        .iter()
        .filter(|e| e.ordinal == from.ordinal)
        .map(|e| graph.edge_polyline(e))
        .collect();

    let cell_ll = |i: i32, j: i32| -> [f64; 2] {
        if i == 0 && j == 0 {
            [from.lon, from.lat]
        } else if i == dest_i && j == dest_j {
            dest_ll
        } else {
            frame.to_ll(f64::from(i) * GRID_CELL_M, f64::from(j) * GRID_CELL_M)
        }
    };

    let blocked = |i: i32, j: i32| -> bool {
        if (i == 0 && j == 0) || (i == dest_i && j == dest_j) {
            return false;
        }
        !walkable(cell_ll(i, j), floor)
    };

    if dest_i == 0 && dest_j == 0 {
        return Some(vec![[from.lon, from.lat], dest_ll]);
    }

    let step_cost = |i: i32, j: i32, di: i32, dj: i32| -> f64 {
        let step_m = ((f64::from(di)).hypot(f64::from(dj))) * GRID_CELL_M;
        if !along_network {
            return step_m;
        }
        let center = cell_ll(i + di, j + dj);
        let near = same_floor.iter().any(|poly| {
            poly.windows(2)
                .any(|w| point_seg_dist_m(center, w[0], w[1]) < NEAR_GRAPH_M)
        });
        step_m * if near { 1.0 } else { OFF_GRAPH_COST }
    };

    let mut dist: HashMap<(i32, i32), f64> = HashMap::new();
    let mut parent: HashMap<(i32, i32), (i32, i32)> = HashMap::new();
    let mut heap = BinaryHeap::new();
    dist.insert((0, 0), 0.0);
    heap.push(CellOpen {
        f: haversine_m(from.lon, from.lat, to.lon, to.lat),
        g: 0.0,
        i: 0,
        j: 0,
    });

    let mut expansions = 0usize;
    while let Some(CellOpen { g, i, j, .. }) = heap.pop() {
        if dist.get(&(i, j)).is_some_and(|&best| g > best) {
            continue;
        }
        if i == dest_i && j == dest_j {
            let mut path = vec![cell_ll(i, j)];
            let mut cur = (i, j);
            while let Some(&prev) = parent.get(&cur) {
                path.push(cell_ll(prev.0, prev.1));
                cur = prev;
            }
            path.reverse();
            return Some(path);
        }
        let from_origin = (f64::from(i) * GRID_CELL_M).hypot(f64::from(j) * GRID_CELL_M);
        if from_origin > MAX_RADIUS_M {
            continue;
        }
        expansions += 1;
        if expansions > MAX_EXPANSIONS {
            break;
        }
        for di in -1..=1 {
            for dj in -1..=1 {
                if di == 0 && dj == 0 {
                    continue;
                }
                let (ni, nj) = (i + di, j + dj);
                if blocked(ni, nj) {
                    continue;
                }
                if !walkable_chord(floor, cell_ll(i, j), cell_ll(ni, nj)) {
                    continue;
                }
                let ng = g + step_cost(i, j, di, dj);
                if dist.get(&(ni, nj)).is_none_or(|&best| ng < best) {
                    dist.insert((ni, nj), ng);
                    parent.insert((ni, nj), (i, j));
                    let center = cell_ll(ni, nj);
                    heap.push(CellOpen {
                        f: ng + haversine_m(center[0], center[1], to.lon, to.lat),
                        g: ng,
                        i: ni,
                        j: nj,
                    });
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{RouteEdge, RouteGraph, RouteNode};
    use crate::query::RouteProfile;
    use crate::smooth::{WalkableFloor, WalkablePolygon};

    /// 1° of latitude ≈ 111_194.93 m; 1° of longitude ≈ 91_083.5 m at 35°N.
    const M_PER_DEG_LAT: f64 = 111_194.93;
    const M_PER_DEG_LON: f64 = 91_083.5;

    fn pt(x: f64, y: f64) -> [f64; 2] {
        [139.0 + x / M_PER_DEG_LON, 35.0 + y / M_PER_DEG_LAT]
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<[f64; 2]> {
        let (hw, hh) = (w / 2.0, h / 2.0);
        vec![
            pt(x - hw, y - hh),
            pt(x + hw, y - hh),
            pt(x + hw, y + hh),
            pt(x - hw, y + hh),
            pt(x - hw, y - hh),
        ]
    }

    fn hall() -> WalkableFloor {
        WalkableFloor {
            ordinal: 0.0,
            polygons: vec![WalkablePolygon {
                exterior: rect(0.0, 0.0, 20.0, 4.0),
                holes: vec![],
            }],
            locks: vec![],
        }
    }

    fn hall_with_hole() -> WalkableFloor {
        WalkableFloor {
            ordinal: 0.0,
            polygons: vec![WalkablePolygon {
                exterior: rect(0.0, 0.0, 20.0, 4.0),
                holes: vec![rect(0.0, 0.0, 2.0, 2.0)],
            }],
            locks: vec![],
        }
    }

    fn node(x: f64, y: f64, ordinal: f64) -> RouteNode {
        let [lon, lat] = pt(x, y);
        RouteNode { lon, lat, ordinal }
    }

    fn edge(from: u32, to: u32, weight: f32, ordinal: f64) -> RouteEdge {
        RouteEdge::new(from, to, weight, ordinal)
    }

    fn corridor_graph() -> RouteGraph {
        RouteGraph {
            nodes: vec![
                node(-8.0, 0.0, 0.0),
                node(0.0, 0.0, 0.0),
                node(8.0, 0.0, 0.0),
            ],
            edges: vec![edge(0, 1, 8.0, 0.0), edge(1, 2, 8.0, 0.0)],
        }
    }

    fn polyline_samples_walkable(coords: &[[f64; 2]], floor: &WalkableFloor) -> bool {
        coords.windows(2).all(|w| {
            let (a, b) = (w[0], w[1]);
            let len = haversine_m(a[0], a[1], b[0], b[1]);
            let steps = (len / 0.5).ceil().max(1.0) as usize;
            (0..=steps).all(|s| {
                let t = s as f64 / steps as f64;
                walkable([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], floor)
            })
        })
    }

    #[test]
    fn connected_corridor_emits_current_and_hides_along_when_it_matches() {
        let out = propose_paths(
            &corridor_graph(),
            &[10, 11, 12],
            &[hall()],
            10,
            12,
            &RouteProfile::walking(),
        );
        assert!(
            out.candidates
                .iter()
                .any(|c| c.kind == PathCandidateKind::Current
                    && c.node_ids.as_deref() == Some(&[10, 11, 12][..]))
        );
        assert!(
            !out.candidates
                .iter()
                .any(|c| c.kind == PathCandidateKind::AlongNetwork)
        );
    }

    #[test]
    fn open_hall_emits_shorter_when_the_graph_goes_the_long_way() {
        // Graph: A south, around a detour, to B. Walkable is a wide 40×20 m hall
        // so the uniform grid path is a near-straight diagonal, Hausdorff >> 4 m.
        let graph = RouteGraph {
            nodes: vec![
                node(-16.0, -8.0, 0.0),
                node(16.0, -8.0, 0.0),
                node(16.0, 8.0, 0.0),
            ],
            edges: vec![edge(0, 1, 32.0, 0.0), edge(1, 2, 16.0, 0.0)],
        };
        // Lock at the detour corner so Current's greedy-LOS cannot pull the
        // L-shaped graph route onto the diagonal the shorter search finds.
        let floor = WalkableFloor {
            ordinal: 0.0,
            polygons: vec![WalkablePolygon {
                exterior: rect(0.0, 0.0, 40.0, 20.0),
                holes: vec![],
            }],
            locks: vec![pt(16.0, -8.0)],
        };
        let out = propose_paths(
            &graph,
            &[10, 11, 12],
            &[floor],
            10,
            12,
            &RouteProfile::walking(),
        );
        assert!(
            out.candidates
                .iter()
                .any(|c| c.kind == PathCandidateKind::Current)
        );
        let graph_l = [pt(-16.0, -8.0), pt(16.0, -8.0), pt(16.0, 8.0)];
        let shorter = out
            .candidates
            .iter()
            .find(|c| c.kind == PathCandidateKind::Shorter)
            .expect("open hall must emit a shorter diagonal");
        assert!(hausdorff_m(&shorter.coordinates, &graph_l) > HAUSDORFF_M);
    }

    #[test]
    fn disconnected_islands_with_walkable_gap_have_no_current_and_a_joiner() {
        let graph = RouteGraph {
            nodes: vec![node(-8.0, 0.0, 0.0), node(8.0, 0.0, 0.0)],
            edges: vec![],
        };
        let floor = hall();
        let out = propose_paths(
            &graph,
            &[10, 11],
            std::slice::from_ref(&floor),
            10,
            11,
            &RouteProfile::walking(),
        );
        assert!(
            !out.candidates
                .iter()
                .any(|c| c.kind == PathCandidateKind::Current)
        );
        let joiner = out
            .candidates
            .iter()
            .find(|c| {
                c.kind == PathCandidateKind::AlongNetwork || c.kind == PathCandidateKind::Shorter
            })
            .expect("a walkable joiner");
        assert!(joiner.coordinates.len() >= 2);
        assert!(
            polyline_samples_walkable(&joiner.coordinates, &floor),
            "every sample of the joiner must stay walkable"
        );
    }

    #[test]
    fn wall_between_disconnected_nodes_yields_no_candidates() {
        let graph = RouteGraph {
            nodes: vec![node(-10.0, 0.0, 0.0), node(10.0, 0.0, 0.0)],
            edges: vec![],
        };
        let floor = WalkableFloor {
            ordinal: 0.0,
            polygons: vec![
                WalkablePolygon {
                    exterior: rect(-10.0, 0.0, 6.0, 6.0),
                    holes: vec![],
                },
                WalkablePolygon {
                    exterior: rect(10.0, 0.0, 6.0, 6.0),
                    holes: vec![],
                },
            ],
            locks: vec![],
        };
        assert!(
            propose_paths(
                &graph,
                &[10, 11],
                &[floor],
                10,
                11,
                &RouteProfile::walking(),
            )
            .candidates
            .is_empty()
        );
    }

    #[test]
    fn through_hole_is_never_emitted() {
        let graph = RouteGraph {
            nodes: vec![node(-8.0, 0.0, 0.0), node(8.0, 0.0, 0.0)],
            edges: vec![],
        };
        // 20×10 m hall, 2×2 m kiosk: enough clearance that the 1 m grid
        // can go around, while a through-kiosk chord is still illegal.
        let floor = WalkableFloor {
            ordinal: 0.0,
            polygons: vec![WalkablePolygon {
                exterior: rect(0.0, 0.0, 20.0, 10.0),
                holes: vec![rect(0.0, 0.0, 2.0, 2.0)],
            }],
            locks: vec![],
        };
        let out = propose_paths(
            &graph,
            &[10, 11],
            std::slice::from_ref(&floor),
            10,
            11,
            &RouteProfile::walking(),
        );
        let news: Vec<_> = out
            .candidates
            .iter()
            .filter(|c| c.kind != PathCandidateKind::Current)
            .collect();
        assert!(
            !news.is_empty(),
            "a walkable path around the hole must exist"
        );
        for c in news {
            assert!(
                polyline_samples_walkable(&c.coordinates, &floor),
                "a new polyline must never chord through the kiosk"
            );
        }
    }

    #[test]
    fn empty_floors_keep_current_and_drop_new() {
        let out = propose_paths(
            &corridor_graph(),
            &[10, 11, 12],
            &[],
            10,
            12,
            &RouteProfile::walking(),
        );
        assert_eq!(out.candidates.len(), 1);
        assert_eq!(out.candidates[0].kind, PathCandidateKind::Current);
    }

    #[test]
    fn walkable_chord_is_false_across_a_hole() {
        let floor = hall_with_hole();
        assert!(!walkable_chord(&floor, pt(-8.0, 0.0), pt(8.0, 0.0)));
        assert!(walkable_chord(&floor, pt(-8.0, 0.0), pt(-4.0, 0.0)));
    }

    #[test]
    fn distinctness_drops_a_near_duplicate() {
        let a = vec![pt(0.0, 0.0), pt(10.0, 0.0)];
        let b = vec![pt(0.0, 1.0), pt(10.0, 1.0)];
        assert!(indistinct(&a, &b));
        let far = vec![pt(0.0, 0.0), pt(10.0, 8.0)];
        assert!(!indistinct(&a, &far));
    }
}
