//! Medial-axis routing-network synthesis (server-only, `netgen` feature).
//!
//! ArcGIS-Indoors-style pipeline producing real corridor centerlines:
//!   1. per floor, union walkable units into a navigable area (obstacle
//!      subtraction is available via `navigable_area` but currently unused);
//!   2. constrained-Delaunay-triangulate the navigable polygon and extract its
//!      medial axis (Chin–Snoeyink–Wang) as centerlines;
//!   3. build a graph from the centerlines, snap doorway `opening`s on as
//!      junctions (unioning the blobs they connect so nothing duplicates a
//!      doorway path), attach transit units THROUGH their boundary openings,
//!      bridge near-touching blobs, and stitch floors vertically (footprint
//!      overlap or centroid proximity), attaching costs.
//!
//! Gated behind `netgen` so the browser wasm build never pulls in `geo`/`spade`.

use geo::Point;
use geo::algorithm::area::Area;
use geo::algorithm::bool_ops::BooleanOps;
use geo::algorithm::contains::Contains;
use geo::algorithm::intersects::Intersects;
use geo::algorithm::orient::{Direction, Orient};
use geo::{Coord, LineString, MultiPolygon, Polygon};
use spade::{ConstrainedDelaunayTriangulation, Point2, Triangulation};
use std::cmp::Ordering;
use std::collections::HashMap;

use crate::codec::BundleDocument;
use crate::synth::{haversine_m, linestring_midpoint, point_boundary_dist_m, polygon_centroid};
use kiriko_model::canonical::Value;
use kiriko_model::model::FeatureType;
use kiriko_route::{RouteBuildWarning, RouteEdge, RouteGraph, RouteGraphBuild, RouteNode};

/// Convert one canonical GeoJSON ring (`[[lon,lat],…]`) to a geo `LineString`.
/// `None` for a ring with fewer than 4 positions (not a valid closed ring).
fn ring_to_linestring(ring: &Value) -> Option<LineString<f64>> {
    let arr = ring.as_array()?;
    let coords: Vec<Coord<f64>> = arr
        .iter()
        .filter_map(|p| {
            let pair = p.as_array()?;
            Some(Coord {
                x: pair.first()?.as_f64()?,
                y: pair.get(1)?.as_f64()?,
            })
        })
        .collect();
    (coords.len() >= 4).then(|| LineString::new(coords))
}

/// Build a consistently-oriented geo `Polygon` from a canonical ring array
/// (exterior first, then holes).
fn polygon_from_rings(rings: &[Value]) -> Option<Polygon<f64>> {
    let exterior = ring_to_linestring(rings.first()?)?;
    let holes: Vec<LineString<f64>> = rings[1..].iter().filter_map(ring_to_linestring).collect();
    Some(Polygon::new(exterior, holes).orient(Direction::Default))
}

/// Extract geo `Polygon`s from a canonical `Polygon`/`MultiPolygon` geometry.
/// Empty for any other geometry.
pub(crate) fn geo_polygons(geom: &Value) -> Vec<Polygon<f64>> {
    let Some(obj) = geom.as_object() else {
        return Vec::new();
    };
    let Some(coords) = obj.get("coordinates") else {
        return Vec::new();
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("Polygon") => coords
            .as_array()
            .and_then(polygon_from_rings)
            .into_iter()
            .collect(),
        Some("MultiPolygon") => coords
            .as_array()
            .map(|polys| {
                polys
                    .iter()
                    .filter_map(|poly| poly.as_array().and_then(polygon_from_rings))
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Dissolve `walkables` into a single navigable `MultiPolygon` and subtract the
/// union of `obstacles`. Inputs are canonical `Polygon`/`MultiPolygon`
/// geometries; degenerate shapes are skipped. Empty input → empty result.
pub(crate) fn navigable_area(walkables: &[&Value], obstacles: &[&Value]) -> MultiPolygon<f64> {
    let walk: Vec<Polygon<f64>> = walkables.iter().flat_map(|g| geo_polygons(g)).collect();
    if walk.is_empty() {
        return MultiPolygon::new(Vec::new());
    }
    let merged = union_all(&walk);

    let obs: Vec<Polygon<f64>> = obstacles.iter().flat_map(|g| geo_polygons(g)).collect();
    if obs.is_empty() {
        return merged;
    }
    merged.difference(&union_all(&obs))
}

/// Dissolve polygons into one `MultiPolygon` by folding pairwise `union`
/// (geo 0.29 has no `unary_union`). Adequate for per-floor unit counts.
fn union_all(polys: &[Polygon<f64>]) -> MultiPolygon<f64> {
    let mut acc = MultiPolygon::new(Vec::new());
    for poly in polys {
        acc = acc.union(poly);
    }
    acc
}

/// A planar skeleton graph: node positions and undirected edges (index pairs).
pub(crate) struct Skeleton {
    pub nodes: Vec<[f64; 2]>,
    pub edges: Vec<(usize, usize)>,
}

fn quantize(x: f64) -> i64 {
    (x * 1.0e8).round() as i64
}

/// Intern a skeleton node by quantized position, returning its index.
fn intern(nodes: &mut Vec<[f64; 2]>, index: &mut HashMap<(i64, i64), usize>, p: [f64; 2]) -> usize {
    let key = (quantize(p[0]), quantize(p[1]));
    if let Some(&i) = index.get(&key) {
        return i;
    }
    let i = nodes.len();
    nodes.push(p);
    index.insert(key, i);
    i
}

/// Densify a ring so no segment exceeds `spacing`, returning open (unclosed)
/// vertices. Denser boundary sampling gives the CDT enough triangles to
/// approximate the medial axis along a corridor's length, not just at corners.
fn densify_ring(ring: &LineString<f64>, spacing: f64) -> Vec<Point2<f64>> {
    let coords: Vec<Coord<f64>> = ring.coords().copied().collect();
    let n = if coords.len() >= 2 && coords.first() == coords.last() {
        coords.len() - 1
    } else {
        coords.len()
    };
    let mut out: Vec<Point2<f64>> = Vec::new();
    for i in 0..n {
        let a = coords[i];
        let b = coords[(i + 1) % n];
        out.push(Point2::new(a.x, a.y));
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let len = (dx * dx + dy * dy).sqrt();
        if spacing > 0.0 && len > spacing {
            let steps = (len / spacing).floor() as usize;
            for s in 1..steps {
                let t = s as f64 / steps as f64;
                out.push(Point2::new(a.x + dx * t, a.y + dy * t));
            }
        }
    }
    out
}

fn add_ring(
    cdt: &mut ConstrainedDelaunayTriangulation<Point2<f64>>,
    ring: &LineString<f64>,
    spacing: f64,
) {
    let pts = densify_ring(ring, spacing);
    if pts.len() >= 3 {
        let _ = cdt.add_constraint_edges(pts, true);
    }
}

/// Approximate medial axis (Chin–Snoeyink–Wang) of a navigable area, via a
/// constrained Delaunay triangulation of its rings densified at `spacing`
/// (coordinate units). Interior faces are kept by a point-in-polygon test on
/// each triangle centroid; each interior triangle contributes skeleton
/// segments joining the midpoints of its non-constraint (internal) edges,
/// meeting at the centroid for junction and terminal triangles.
pub(crate) fn medial_axis(area: &MultiPolygon<f64>, spacing: f64) -> Skeleton {
    let mut cdt = ConstrainedDelaunayTriangulation::<Point2<f64>>::new();
    for poly in area {
        add_ring(&mut cdt, poly.exterior(), spacing);
        for hole in poly.interiors() {
            add_ring(&mut cdt, hole, spacing);
        }
    }

    let mut nodes: Vec<[f64; 2]> = Vec::new();
    let mut index: HashMap<(i64, i64), usize> = HashMap::new();
    let mut edges: Vec<(usize, usize)> = Vec::new();

    for face in cdt.inner_faces() {
        let vs = face.vertices();
        let pos = |i: usize| {
            let p = vs[i].position();
            [p.x, p.y]
        };
        let (a, b, c) = (pos(0), pos(1), pos(2));
        let centroid = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0];
        // Point-in-polygon inside/outside test. O(faces × ring-vertices); the
        // caller bounds per-floor complexity (densify spacing + a vertex cap)
        // so this stays tractable at venue scale. A CDT flood-fill (O(faces))
        // is the drop-in optimization if profiling shows it dominating.
        if !area.contains(&Point::new(centroid[0], centroid[1])) {
            continue;
        }
        let mut mids: Vec<[f64; 2]> = Vec::new();
        for e in face.adjacent_edges() {
            if !e.is_constraint_edge() {
                let from = e.from().position();
                let to = e.to().position();
                mids.push([(from.x + to.x) / 2.0, (from.y + to.y) / 2.0]);
            }
        }
        match mids.len() {
            2 => {
                let n0 = intern(&mut nodes, &mut index, mids[0]);
                let n1 = intern(&mut nodes, &mut index, mids[1]);
                if n0 != n1 {
                    edges.push((n0, n1));
                }
            }
            3 => {
                let hub = intern(&mut nodes, &mut index, centroid);
                for m in &mids {
                    let n = intern(&mut nodes, &mut index, *m);
                    if hub != n {
                        edges.push((hub, n));
                    }
                }
            }
            1 => {
                let hub = intern(&mut nodes, &mut index, centroid);
                let n = intern(&mut nodes, &mut index, mids[0]);
                if hub != n {
                    edges.push((hub, n));
                }
            }
            _ => {}
        }
    }
    Skeleton { nodes, edges }
}

/// ~0.9 m boundary sampling (degrees) for the medial-axis CDT.
const BASE_SPACING_DEG: f64 = 8e-6;
/// Per-floor densified-vertex budget; coarsens spacing on huge floors so the
/// triangulation and inside-test stay tractable.
const MAX_CDT_VERTS: usize = 24_000;
/// Max distance (m) to snap a doorway/transit unit onto the centerline graph.
const SNAP_MAX_M: f64 = 12.0;
/// Max centroid distance (m) matching a transit unit to the floor above.
const VERTICAL_MATCH_M: f64 = 5.0;
/// Max skeleton-node gap (m) to fuse two distinct walkable blobs on the same
/// floor that abut without a doorway. The medial axis insets from each
/// polygon edge (~half the corridor width), so this measures spine-to-spine,
/// not polygon-to-polygon; kept short so only near-touching areas merge.
const ADJACENCY_BRIDGE_M: f64 = 2.0;
/// Max distance (m) from a transit unit's boundary for an `opening` node to
/// count as the unit's doorway; the unit then attaches through that opening
/// instead of snapping its centroid straight onto the centerline.
const TRANSIT_OPENING_SNAP_M: f64 = 1.5;
/// Minimum passable corridor width (m). Centerline edges and blob bridges
/// through narrower passages (wall–column pinches, slivers) are pruned.
const MIN_PASSAGE_M: f64 = 0.8;
/// Leaf centerline branches shorter than this (m) tip-to-junction are
/// medial-axis serration twigs, not real corridor ends — pruned whole.
const SPIKE_CHAIN_MAX_M: f64 = 3.0;
/// Longer narrowing-wedge branches below this length (m) are also visual
/// medial-axis artifacts. Longer branches stay as useful corridor coverage.
const SPIKE_WEDGE_MAX_M: f64 = 8.0;
/// A wedge tip with less than this fraction of its junction clearance narrows
/// into a boundary corner rather than continuing through a corridor.
const SPIKE_TIP_CLEARANCE_RATIO: f64 = 0.5;
/// A flat corridor end has a nearest boundary segment approximately
/// perpendicular to the branch tangent. Corner wedges do not. Allow about
/// 20 degrees of CDT/sampling noise around perpendicular.
const ENDCAP_TANGENT_DOT_MAX: f64 = 0.35;
/// Distance tolerance (m) when collecting boundary segments tied for nearest
/// to a leaf tip; corridor tips can be equidistant from side walls and endcap.
const ENDCAP_NEAREST_TOL_M: f64 = 0.1;
/// A real dead-end corridor retains roughly the same half-width immediately
/// behind its endcap. Open-room spurs widen much faster and remain prunable.
const ENDCAP_CHANNEL_CLEARANCE_RATIO: f64 = 1.5;
/// Degree-2 centerline chains with at least this much path detour are aligned
/// to their chord when that chord remains fully passable.
const WEAVE_DETOUR_RATIO: f64 = 1.15;
/// Tolerance (m) for samples to lie just OUTSIDE the walkable area when
/// validating that an attach segment stays within walkable space — covers
/// openings digitized slightly off a unit boundary. Gaps this rule rejects
/// (track strips, walls) are an order of magnitude wider.
const SEGMENT_OUTSIDE_TOL_M: f64 = 0.3;
/// Doorway stub length (m) each side of an opening's midpoint, along the
/// detected passage direction: routes cross the doorway straight through the
/// opening instead of entering at the angle of the nearest centerline node.
const DOORWAY_STUB_M: f64 = 1.2;
/// Degeneracy epsilon (m): a ray/projection hit within this of an existing
/// skeleton endpoint reuses that endpoint instead of creating a zero-length split.
const DOORWAY_SPLIT_EPS_M: f64 = 0.05;
/// Minimum extra distance (m) beyond [`DOORWAY_STUB_M`] that a planned attach
/// target must sit past the stub for the stub to remain useful; closer junctions
/// attach from the midpoint directly.
const DOORWAY_STUB_JUNCTION_MARGIN_M: f64 = 0.1;

/// Minimum interior clearance (m) for a stub-offset sample to count as "deep"
/// inside walkable space when scoring passage direction. Stricter than
/// [`SEGMENT_OUTSIDE_TOL_M`] so along-the-wall threshold stubs, which only
/// graze the boundary, do not look like real crossings.
const STUB_DEEP_M: f64 = 0.5;
/// Maximum chord length (m) considered for an open-space shortcut.
const CHORD_MAX_M: f64 = 40.0;
/// A chord is a real shortcut only when it beats the existing graph path by
/// at least this factor (chord length < ratio × graph distance).
const CHORD_SAVINGS_RATIO: f64 = 0.7;
/// Shorter chords are medial-axis noise between nearby spur tips, not real
/// open-space shortcuts (JR Takanawa F1 median chord was 2.66 m).
const CHORD_MIN_M: f64 = 10.0;
/// Absolute walking metres a chord must save. The ratio rule alone is
/// scale-free and fires on ~3 m chords whose graph path is ~10 m.
const CHORD_MIN_SAVINGS_M: f64 = 15.0;
/// Minimum boundary clearance (m) along a chord — half-width of a genuinely
/// open hall. Corridor-only venues top out near 4.7 m and must yield zero chords.
const CHORD_MIN_CLEARANCE_M: f64 = 5.0;
/// Cap on chords incident to any single node; dense skeletons otherwise grow
/// degree-7 hubs of crossing shortcuts.
const CHORD_MAX_PER_NODE: usize = 2;

/// Distance (m) from `p` to the nearest boundary ring of `area`
/// (equirectangular metres at `p`'s latitude). Inside the area this is the
/// local passage half-width; outside, the distance to the area.
fn boundary_clearance_m(p: [f64; 2], area: &MultiPolygon<f64>) -> f64 {
    use geo::algorithm::line_measures::{Distance, Euclidean};
    let mx = 111_320.0 * p[1].to_radians().cos();
    let my = 111_320.0;
    let sp = Point::new(p[0] * mx, p[1] * my);
    let scale = |ls: &LineString<f64>| -> LineString<f64> {
        LineString::new(
            ls.coords()
                .map(|c| Coord {
                    x: c.x * mx,
                    y: c.y * my,
                })
                .collect(),
        )
    };
    let mut best = f64::INFINITY;
    for poly in area {
        best = best.min(Euclidean::distance(&sp, &scale(poly.exterior())));
        for hole in poly.interiors() {
            best = best.min(Euclidean::distance(&sp, &scale(hole)));
        }
    }
    best
}

/// True when the leaf faces a flat endcap and remains inside a narrow channel
/// immediately behind it. The endcap is perpendicular to the branch tangent;
/// stable clearance supplies the side-wall evidence that distinguishes a
/// genuine dead-end corridor from an open-room spur aimed at a flat wall.
fn leaf_has_corridor_endcap(
    tip: [f64; 2],
    inward: [f64; 2],
    tip_clearance_m: f64,
    area: &MultiPolygon<f64>,
) -> bool {
    let mx = 111_320.0 * tip[1].to_radians().cos();
    let my = 111_320.0;
    let branch = [(inward[0] - tip[0]) * mx, (inward[1] - tip[1]) * my];
    let branch_len = branch[0].hypot(branch[1]);
    if branch_len <= f64::EPSILON {
        return false;
    }
    let nearest = tip_clearance_m;
    let ring_has_endcap = |ring: &LineString<f64>| {
        ring.0.windows(2).any(|segment| {
            let a = [(segment[0].x - tip[0]) * mx, (segment[0].y - tip[1]) * my];
            let edge = [
                (segment[1].x - segment[0].x) * mx,
                (segment[1].y - segment[0].y) * my,
            ];
            let edge_len_sq = edge[0] * edge[0] + edge[1] * edge[1];
            if edge_len_sq <= f64::EPSILON {
                return false;
            }
            let projection = (-(a[0] * edge[0] + a[1] * edge[1]) / edge_len_sq).clamp(0.0, 1.0);
            let offset = [a[0] + projection * edge[0], a[1] + projection * edge[1]];
            let distance = offset[0].hypot(offset[1]);
            let tangent_dot = (branch[0] * edge[0] + branch[1] * edge[1]).abs()
                / (branch_len * edge_len_sq.sqrt());
            distance <= nearest + ENDCAP_NEAREST_TOL_M && tangent_dot <= ENDCAP_TANGENT_DOT_MAX
        })
    };
    let has_flat_endcap = area.iter().any(|poly| {
        ring_has_endcap(poly.exterior()) || poly.interiors().iter().any(ring_has_endcap)
    });
    if !has_flat_endcap {
        return false;
    }
    let probe = [
        tip[0] + branch[0] / branch_len * nearest / mx,
        tip[1] + branch[1] / branch_len * nearest / my,
    ];
    boundary_clearance_m(probe, area)
        <= nearest * ENDCAP_CHANNEL_CLEARANCE_RATIO + ENDCAP_NEAREST_TOL_M
}

/// True when `p` lies inside `area` or within `tol_m` of it.
fn point_within_area(p: [f64; 2], area: &MultiPolygon<f64>, tol_m: f64) -> bool {
    area.contains(&Point::new(p[0], p[1]))
        || (tol_m > 0.0 && boundary_clearance_m(p, area) <= tol_m)
}

/// True when every interior sample of segment `a`–`b` lies within `area`
/// (or within `tol_m` of it). Used to prove an attach edge never leaves
/// walkable space (track strips, walls, other units).
fn segment_within_area(a: [f64; 2], b: [f64; 2], area: &MultiPolygon<f64>, tol_m: f64) -> bool {
    (1..10).all(|k| {
        let t = k as f64 / 10.0;
        point_within_area(
            [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
            area,
            tol_m,
        )
    })
}

/// Ray–segment intersection in the local metre frame at `origin`'s latitude.
/// Ray: `origin + t·dir` for `t ≥ 0` (`dir` unit metre vector). Segment: `a`–`b`.
/// Returns `(hit_lonlat, t_along_ray_m, s_along_segment)` when they meet with
/// `t > 0` and `s ∈ (0, 1)`; `None` if parallel/miss/endpoint-only.
fn ray_segment_hit(
    origin: [f64; 2],
    dir: [f64; 2],
    a: [f64; 2],
    b: [f64; 2],
) -> Option<([f64; 2], f64, f64)> {
    let mx = 111_320.0 * origin[1].to_radians().cos();
    let my = 111_320.0;
    // Segment endpoints in metres relative to origin.
    let ax = (a[0] - origin[0]) * mx;
    let ay = (a[1] - origin[1]) * my;
    let bx = (b[0] - origin[0]) * mx;
    let by = (b[1] - origin[1]) * my;
    let sx = bx - ax;
    let sy = by - ay;
    // Solve origin + t·dir = a + s·(b−a)  ⇒  t·dir − s·seg = a_rel.
    // 2×2: | dx  -sx | |t| = |ax|
    //      | dy  -sy | |s|   |ay|
    let det = dir[0] * (-sy) - (-sx) * dir[1];
    if det.abs() < 1e-12 {
        return None;
    }
    let t = (ax * (-sy) - (-sx) * ay) / det;
    let s = (dir[0] * ay - dir[1] * ax) / det;
    if t <= 0.0 || s <= 0.0 || s >= 1.0 {
        return None;
    }
    let hit = [origin[0] + dir[0] * t / mx, origin[1] + dir[1] * t / my];
    Some((hit, t, s))
}

/// Closest point of `p` on segment `a`–`b` in the local metre frame at `p`'s
/// latitude. Returns `(proj_lonlat, dist_m, s_along_segment)` with `s ∈ [0, 1]`.
fn project_point_to_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> ([f64; 2], f64, f64) {
    let mx = 111_320.0 * p[1].to_radians().cos();
    let my = 111_320.0;
    let ax = (a[0] - p[0]) * mx;
    let ay = (a[1] - p[1]) * my;
    let bx = (b[0] - p[0]) * mx;
    let by = (b[1] - p[1]) * my;
    let sx = bx - ax;
    let sy = by - ay;
    let denom = sx * sx + sy * sy;
    let s = if denom <= 1e-18 {
        0.0
    } else {
        // proj of (0,0)−a onto seg = −a·seg / |seg|²
        ((-ax) * sx + (-ay) * sy) / denom
    };
    let s = s.clamp(0.0, 1.0);
    let qx = ax + s * sx;
    let qy = ay + s * sy;
    let dist = (qx * qx + qy * qy).sqrt();
    let hit = [p[0] + qx / mx, p[1] + qy / my];
    (hit, dist, s)
}

/// Split skeleton edge `edge_idx` at `point`, pushing a new node (or reusing an
/// endpoint within [`DOORWAY_SPLIT_EPS_M`]). Operates on the live edge list so
/// an edge already split earlier in the same pass is handled correctly. The
/// new node inherits `blob` root from endpoint `u`. Returns the (possibly
/// pre-existing) node index of the split point.
fn split_skeleton_at(
    skeleton: &mut Skeleton,
    blob: &mut Vec<usize>,
    edge_idx: usize,
    point: [f64; 2],
) -> usize {
    let (u, v) = skeleton.edges[edge_idx];
    let pu = skeleton.nodes[u];
    let pv = skeleton.nodes[v];
    if haversine_m(point, pu) <= DOORWAY_SPLIT_EPS_M {
        return u;
    }
    if haversine_m(point, pv) <= DOORWAY_SPLIT_EPS_M {
        return v;
    }
    let p_idx = skeleton.nodes.len();
    skeleton.nodes.push(point);
    // Inherit u's component root.
    let root = uf_find(blob, u);
    blob.push(root);
    // Replace edge with (u, P); push (P, v).
    skeleton.edges[edge_idx] = (u, p_idx);
    skeleton.edges.push((p_idx, v));
    p_idx
}

/// True when every interior sample of segment `a`–`b` lies within at least
/// ONE of `areas` (e.g. the walkable union or the transit unit itself).
fn segment_within_any(a: [f64; 2], b: [f64; 2], areas: &[&MultiPolygon<f64>], tol_m: f64) -> bool {
    (1..10).all(|k| {
        let t = k as f64 / 10.0;
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        areas.iter().any(|area| point_within_area(p, area, tol_m))
    })
}

/// True when the passage along segment `a`–`b` is at least [`MIN_PASSAGE_M`]
/// wide everywhere and never leaves the walkable area — the bridge rule.
fn bridge_passable(a: [f64; 2], b: [f64; 2], area: &MultiPolygon<f64>) -> bool {
    let min_clear = MIN_PASSAGE_M / 2.0;
    (1..10).all(|k| {
        let t = k as f64 / 10.0;
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        area.contains(&Point::new(p[0], p[1])) && boundary_clearance_m(p, area) >= min_clear
    })
}

/// Stronger passability proof for centerline chords. Samples at most half a
/// minimum-passage width apart, including both endpoints, so a long chord
/// cannot skip a thin wall or hole between the fixed bridge samples.
fn centerline_chord_passable(a: [f64; 2], b: [f64; 2], area: &MultiPolygon<f64>) -> bool {
    let min_clear = MIN_PASSAGE_M / 2.0;
    let steps = (haversine_m(a, b) / min_clear).ceil().max(1.0) as usize;
    (0..=steps).all(|k| {
        let t = k as f64 / steps as f64;
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        area.contains(&Point::new(p[0], p[1])) && boundary_clearance_m(p, area) >= min_clear
    })
}

/// True when endpoints and ~1 m samples along `a`–`b` all lie in open space:
/// inside `area` with clearance ≥ [`CHORD_MIN_CLEARANCE_M`]. Rejects corridor
/// chords whose graph-path savings look real but whose half-width is only a
/// few metres (JR Takanawa F1 max clearance 4.69 m).
fn chord_in_open_space(a: [f64; 2], b: [f64; 2], area: &MultiPolygon<f64>) -> bool {
    let steps = (haversine_m(a, b) / 1.0).ceil().max(1.0) as usize;
    (0..=steps).all(|k| {
        let t = k as f64 / steps as f64;
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        area.contains(&Point::new(p[0], p[1]))
            && boundary_clearance_m(p, area) >= CHORD_MIN_CLEARANCE_M
    })
}

/// Prune useless leaf branches without truncating equal-width corridor ends.
/// Every chain shorter than `short_chain_max_m` is removed, preserving the
/// original whole-chain rule. A longer chain up to `wedge_chain_max_m` is
/// removed only when it ends at a junction and its tip clearance is below
/// `tip_clearance_ratio` of that junction's clearance — the narrowing wedge
/// created by a convex boundary corner.
fn prune_spur_leaves(
    skeleton: Skeleton,
    area: &MultiPolygon<f64>,
    short_chain_max_m: f64,
    wedge_chain_max_m: f64,
    tip_clearance_ratio: f64,
) -> Skeleton {
    let n = skeleton.nodes.len();
    let mut adj: Vec<Vec<(usize, usize, f64)>> = vec![Vec::new(); n]; // (neighbor, edge_idx, len)
    for (ei, &(a, b)) in skeleton.edges.iter().enumerate() {
        let d = haversine_m(skeleton.nodes[a], skeleton.nodes[b]);
        adj[a].push((b, ei, d));
        adj[b].push((a, ei, d));
    }
    let deg = |i: usize| adj[i].len();
    let walk_max_m = short_chain_max_m.max(wedge_chain_max_m);
    let mut remove = vec![false; skeleton.edges.len()];
    for start in 0..n {
        if deg(start) != 1 {
            continue;
        }
        // Walk tip → junction, collecting the chain.
        let mut chain: Vec<usize> = Vec::new();
        let mut total = 0.0;
        let (mut cur, mut prev) = (start, usize::MAX);
        let endpoint = loop {
            let Some(&(nb, ei, d)) = adj[cur].iter().find(|(nb, _, _)| *nb != prev) else {
                break Some(cur); // isolated node (shouldn't happen for a leaf)
            };
            chain.push(ei);
            total += d;
            if deg(nb) != 2 {
                break Some(nb); // junction or the other end of a free segment
            }
            if total >= walk_max_m || chain.len() > n {
                break None; // long real stub — keep it
            }
            prev = cur;
            cur = nb;
        };
        let Some(end) = endpoint else { continue };
        let is_short = total < short_chain_max_m;
        let is_narrowing_wedge = if deg(end) >= 3 && total < wedge_chain_max_m {
            let tip_clearance = boundary_clearance_m(skeleton.nodes[start], area);
            tip_clearance < boundary_clearance_m(skeleton.nodes[end], area) * tip_clearance_ratio
                && !leaf_has_corridor_endcap(
                    skeleton.nodes[start],
                    skeleton.nodes[adj[start][0].0],
                    tip_clearance,
                    area,
                )
        } else {
            false
        };
        if is_short || is_narrowing_wedge {
            for ei in chain {
                remove[ei] = true;
            }
        }
    }
    // Compact: drop marked edges and the nodes they orphan.
    let mut remap: Vec<Option<usize>> = vec![None; n];
    let (mut nodes, mut edges) = (Vec::new(), Vec::new());
    for (ei, &(a, b)) in skeleton.edges.iter().enumerate() {
        if remove[ei] {
            continue;
        }
        let (pa, pb) = (skeleton.nodes[a], skeleton.nodes[b]);
        let ia = *remap[a].get_or_insert_with(|| {
            nodes.push(pa);
            nodes.len() - 1
        });
        let ib = *remap[b].get_or_insert_with(|| {
            nodes.push(pb);
            nodes.len() - 1
        });
        edges.push((ia, ib));
    }
    Skeleton { nodes, edges }
}

/// Remove degree-2 sawtooth geometry without changing graph topology or node
/// density. Interior nodes are redistributed along the endpoint chord by
/// cumulative path distance, but only when the original chain is at least
/// `min_detour_ratio` longer and the entire chord remains fully passable.
/// `protected` semantic snap targets divide chains and never move.
fn straighten_degree_two_chains(
    mut skeleton: Skeleton,
    area: &MultiPolygon<f64>,
    protected: &[bool],
    min_detour_ratio: f64,
) -> Skeleton {
    debug_assert_eq!(protected.len(), skeleton.nodes.len());
    let n = skeleton.nodes.len();
    let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n]; // (neighbor, edge_idx)
    for (ei, &(a, b)) in skeleton.edges.iter().enumerate() {
        adj[a].push((b, ei));
        adj[b].push((a, ei));
    }
    let mut visited = vec![false; skeleton.edges.len()];
    for start in 0..n {
        if adj[start].len() == 2 && !protected[start] {
            continue;
        }
        for &(_, first_edge) in &adj[start] {
            if visited[first_edge] {
                continue;
            }
            let mut chain_nodes = vec![start];
            let mut step_lengths = Vec::new();
            let mut total = 0.0;
            let mut cur = start;
            let mut edge = first_edge;
            let mut complete = false;
            loop {
                if visited[edge] {
                    break;
                }
                visited[edge] = true;
                let (a, b) = skeleton.edges[edge];
                let next = if a == cur { b } else { a };
                let step = haversine_m(skeleton.nodes[cur], skeleton.nodes[next]);
                total += step;
                step_lengths.push(step);
                chain_nodes.push(next);
                if adj[next].len() != 2 || protected[next] {
                    complete = true;
                    break;
                }
                let Some(&(_, next_edge)) =
                    adj[next].iter().find(|(_, edge_idx)| *edge_idx != edge)
                else {
                    break;
                };
                cur = next;
                edge = next_edge;
                if chain_nodes.len() > n {
                    break;
                }
            }
            if !complete || chain_nodes.len() < 3 {
                continue;
            }
            let end = *chain_nodes.last().expect("complete chain has endpoint");
            if end == start {
                continue;
            }
            let (from, to) = (skeleton.nodes[start], skeleton.nodes[end]);
            let chord = haversine_m(from, to);
            if chord <= f64::EPSILON
                || total / chord < min_detour_ratio
                || !centerline_chord_passable(from, to, area)
            {
                continue;
            }
            let mut traversed = 0.0;
            for i in 1..chain_nodes.len() - 1 {
                traversed += step_lengths[i - 1];
                let t = traversed / total;
                skeleton.nodes[chain_nodes[i]] = [
                    from[0] + (to[0] - from[0]) * t,
                    from[1] + (to[1] - from[1]) * t,
                ];
            }
        }
    }
    skeleton
}

fn is_walkway(category: &str) -> bool {
    // NOTE: keep in sync with synth.rs. `unenclosedarea` is excluded on
    // purpose: it models open shop interiors, and routing must follow the
    // real walkways around them, not cut through.
    matches!(
        category,
        "walkway"
            | "walkway.island"
            | "movingwalkway"
            | "footbridge"
            | "ramp"
            | "steps"
            | "lobby"
            | "platform"
            | "corridor"
            | "sidewalk"
    )
}
fn is_transit(category: &str) -> bool {
    matches!(category, "elevator" | "escalator" | "stairs")
}
fn floor_cost(category: &str) -> f64 {
    match category {
        "elevator" => 3.0,
        "escalator" => 4.0,
        _ => 5.0,
    }
}

/// Largest-area `geo` polygon of a canonical transit-unit geometry, if any.
fn largest_polygon(geom: &Value) -> Option<Polygon<f64>> {
    geo_polygons(geom)
        .into_iter()
        .max_by(|a, b| a.unsigned_area().total_cmp(&b.unsigned_area()))
}

/// Two transit footprints connect vertically when their polygons intersect.
fn footprints_overlap(a: &Option<Polygon<f64>>, b: &Option<Polygon<f64>>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a.intersects(b))
}

fn ring_perimeter(ring: &LineString<f64>) -> f64 {
    ring.coords()
        .collect::<Vec<_>>()
        .windows(2)
        .map(|w| {
            let (dx, dy) = (w[1].x - w[0].x, w[1].y - w[0].y);
            (dx * dx + dy * dy).sqrt()
        })
        .sum()
}

/// Distinct original coordinates of one ring, excluding the duplicate closing
/// vertex. Matches [`densify_ring`], which keeps every original vertex.
fn ring_vertex_count(ring: &LineString<f64>) -> usize {
    let coords: Vec<Coord<f64>> = ring.coords().copied().collect();
    if coords.len() >= 2 && coords.first() == coords.last() {
        coords.len() - 1
    } else {
        coords.len()
    }
}

/// Total ORIGINAL ring coordinates (exterior + interiors) across the floor's
/// navigable area. These vertices are always fed to the CDT verbatim, so they
/// count against the budget before any interpolation is added.
fn original_vertex_count(area: &MultiPolygon<f64>) -> usize {
    area.iter()
        .map(|p| {
            ring_vertex_count(p.exterior())
                + p.interiors().iter().map(ring_vertex_count).sum::<usize>()
        })
        .sum()
}

/// Pick a boundary sampling spacing that keeps the DENSIFIED vertex count under
/// [`MAX_CDT_VERTS`] for this floor's navigable area, given the `original`
/// coordinates already present. Returns `None` when the original vertices alone
/// exceed the ceiling: coarsening the spacing cannot remove existing
/// coordinates, so the floor must be skipped rather than triangulated.
fn choose_spacing(area: &MultiPolygon<f64>, original: usize) -> Option<f64> {
    if original > MAX_CDT_VERTS {
        return None;
    }
    // Remaining budget for interpolated points; original vertices are already
    // spent. Never coarsen below BASE_SPACING_DEG.
    let budget = MAX_CDT_VERTS - original;
    let perimeter: f64 = area
        .iter()
        .map(|p| {
            ring_perimeter(p.exterior()) + p.interiors().iter().map(ring_perimeter).sum::<f64>()
        })
        .sum();
    if perimeter <= 0.0 || budget == 0 {
        return Some(BASE_SPACING_DEG);
    }
    Some((perimeter / budget as f64).max(BASE_SPACING_DEG))
}

/// One floor's transit unit: centroid, category, largest footprint polygon
/// (for vertical matching), and the source geometry (for doorway matching).
type TransitUnit<'a> = ([f64; 2], String, Option<Polygon<f64>>, &'a Value);

/// Cross-floor transit record accumulated while scanning ordinals.
type TransitAllEntry = (u32, [f64; 2], String, f64, Option<Polygon<f64>>);

/// Union-find root with path compression (over a `parent` slice).
fn uf_find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
}

/// Vertices of a canonical `LineString` coordinate array as `[lon, lat]`.
fn line_verts(coords: &Value) -> Vec<[f64; 2]> {
    coords
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| {
                    let pair = p.as_array()?;
                    Some([pair.first()?.as_f64()?, pair.get(1)?.as_f64()?])
                })
                .collect()
        })
        .unwrap_or_default()
}

/// An opening's midpoint plus unit LINE direction (metre frame at the
/// midpoint's latitude) from its first→last vertex of the longest part.
/// The doorway loop scores this against its normal to pick the passage
/// axis. `None` for degenerate geometry.
fn opening_axis(geom: &Value) -> Option<([f64; 2], [f64; 2])> {
    let obj = geom.as_object()?;
    let coords = obj.get("coordinates")?;
    let verts: Vec<[f64; 2]> = match obj.get("type")?.as_str()? {
        "LineString" => line_verts(coords),
        "MultiLineString" => {
            let mut best: Vec<[f64; 2]> = Vec::new();
            let mut best_len = -1.0;
            for part in coords.as_array()? {
                let vs = line_verts(part);
                let len: f64 = vs.windows(2).map(|w| haversine_m(w[0], w[1])).sum();
                if len > best_len {
                    best_len = len;
                    best = vs;
                }
            }
            best
        }
        _ => return None,
    };
    let (Some(first), Some(last)) = (verts.first(), verts.last()) else {
        return None;
    };
    let mid = linestring_midpoint(geom)?;
    let mx = 111_320.0 * mid[1].to_radians().cos();
    let (dx, dy) = ((last[0] - first[0]) * mx, (last[1] - first[1]) * 111_320.0);
    let len = (dx * dx + dy * dy).sqrt();
    if len <= f64::EPSILON {
        return None;
    }
    Some((mid, [dx / len, dy / len]))
}

/// One doorway's graph nodes: the opening midpoint plus, when walkable, the
/// two axis stubs. Attach edges land on the stub of the attaching side; a
/// side whose stub fails validation falls back to the midpoint.
struct DoorwayNodes {
    mid: usize,
    fwd: Option<usize>, // midpoint + axis·δ
    bwd: Option<usize>, // midpoint − axis·δ
    mid_pt: [f64; 2],
    axis: [f64; 2], // metre-frame unit vector
}

/// Per-opening plan produced before skeleton emit: passage axis and the
/// skeleton-local attach target chosen for each attaching blob root.
struct DoorwayPlan {
    mid: [f64; 2],
    axis: [f64; 2],
    /// `(blob_root, skeleton_local_target)` sorted by root for determinism.
    attaches: Vec<(usize, usize)>,
}

/// Min-heap entry for the bounded Dijkstra inside [`shortcut_chords`].
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

/// Open-space shortcut chords between same-component skeleton nodes: a
/// straight, fully passable segment that beats the current graph path by
/// [`CHORD_SAVINGS_RATIO`]. This is what lets a route cut diagonally across
/// an open concourse instead of following the centerline's detour. Returns
/// the added `(node_a, node_b)` pairs (skeleton-local), deterministic by
/// construction (pairs processed in sorted order).
///
/// `blob` is the **chord-eligibility** union-find (skeleton edges + accepted
/// near-blob bridges only). Doorway-only unions must not appear here: their
/// stub paths are absent from chord adjacency, so opposite-side nodes would
/// otherwise look disconnected to the savings Dijkstra and get a free chord
/// that bypasses the doorway approach.
///
/// `existing` are skeleton-local metre-weighted edges already present in the
/// floor graph but not in `skeleton.edges` (accepted near-blob bridges). They
/// seed adjacency for the savings test so those pairs are never re-emitted,
/// and so Dijkstra sees the true current path cost.
pub(crate) fn shortcut_chords(
    skeleton: &Skeleton,
    blob: &[usize],
    area: &MultiPolygon<f64>,
    existing: &[(usize, usize, f64)],
) -> Vec<(usize, usize)> {
    let n = skeleton.nodes.len();
    if n == 0 {
        return Vec::new();
    }
    // Metre-weighted adjacency: skeleton edges, accepted bridges, plus chords
    // added so far. Bridges must participate in savings without being returned.
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for &(a, b) in &skeleton.edges {
        let d = haversine_m(skeleton.nodes[a], skeleton.nodes[b]);
        adj[a].push((b, d));
        adj[b].push((a, d));
    }
    for &(a, b, d) in existing {
        adj[a].push((b, d));
        adj[b].push((a, d));
    }
    // Candidate pairs: same-blob nodes within CHORD_MAX_M, via local-metre
    // grid buckets (degree cells under-count longitude span at high latitude).
    let ref_lat = skeleton.nodes[0][1];
    let mut mx = 111_320.0 * ref_lat.to_radians().cos().abs();
    if !mx.is_finite() || mx < 1.0 {
        // Near-polar / non-finite guard: fall back to a 1 m/deg floor so
        // bucketing stays well-defined; the haversine filter is authoritative.
        mx = 1.0;
    }
    let cell = |p: [f64; 2]| {
        (
            (p[0] * mx / CHORD_MAX_M).floor() as i64,
            (p[1] * 111_320.0 / CHORD_MAX_M).floor() as i64,
        )
    };
    let mut buckets: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, np) in skeleton.nodes.iter().enumerate() {
        buckets.entry(cell(*np)).or_default().push(i);
    }
    let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
    let mut uf = blob.to_vec();
    for (i, p) in skeleton.nodes.iter().enumerate() {
        let (cx, cy) = cell(*p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(cands) = buckets.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for &j in cands {
                    if j <= i {
                        continue;
                    }
                    let d = haversine_m(*p, skeleton.nodes[j]);
                    if !(CHORD_MIN_M..=CHORD_MAX_M).contains(&d)
                        || uf_find(&mut uf, i) != uf_find(&mut uf, j)
                    {
                        continue;
                    }
                    pairs.push((i, j, d));
                }
            }
        }
    }
    pairs.sort_by_key(|a| (a.0, a.1));

    // Bounded Dijkstra: true when `dst` is reachable from `src` within `cutoff`.
    let reachable_within = |adj: &[Vec<(usize, f64)>], src: usize, dst: usize, cutoff: f64| {
        let mut dist = vec![f64::INFINITY; adj.len()];
        dist[src] = 0.0;
        let mut heap = std::collections::BinaryHeap::new();
        heap.push(Visit(0.0, src));
        while let Some(Visit(g, u)) = heap.pop() {
            if g > cutoff {
                break;
            }
            if u == dst {
                return true;
            }
            if g > dist[u] {
                continue;
            }
            for &(v, w) in &adj[u] {
                let ng = g + w;
                if ng < dist[v] {
                    dist[v] = ng;
                    heap.push(Visit(ng, v));
                }
            }
        }
        false
    };

    let mut added: Vec<(usize, usize)> = Vec::new();
    let mut chord_count = vec![0usize; n];
    for (i, j, c) in pairs {
        if chord_count[i] >= CHORD_MAX_PER_NODE || chord_count[j] >= CHORD_MAX_PER_NODE {
            continue;
        }
        // Open hall only: corridor half-widths fail CHORD_MIN_CLEARANCE_M.
        if !chord_in_open_space(skeleton.nodes[i], skeleton.nodes[j], area) {
            continue;
        }
        // Fully inside walkable space at passage width (rejects chords
        // across kiosks, walls, and track strips).
        if !centerline_chord_passable(skeleton.nodes[i], skeleton.nodes[j], area) {
            continue;
        }
        // Real shortcut: existing graph path must exceed BOTH the ratio and
        // absolute savings bounds (one Dijkstra with the tighter cutoff).
        let cutoff = (c / CHORD_SAVINGS_RATIO).max(c + CHORD_MIN_SAVINGS_M);
        if reachable_within(&adj, i, j, cutoff) {
            continue;
        }
        adj[i].push((j, c));
        adj[j].push((i, c));
        chord_count[i] += 1;
        chord_count[j] += 1;
        added.push((i, j));
    }
    added
}

/// Synthesize a routing graph whose horizontal edges are true corridor
/// centerlines (medial axis of the walkable area), with doorway `opening`s and
/// transit units snapped on as junctions and transit stacked vertically across
/// floors. Returns the same [`RouteGraphBuild`] shape as the network importer.
pub fn synthesize_network_medial(document: &BundleDocument) -> RouteGraphBuild {
    let level_ordinal: std::collections::BTreeMap<&str, f64> = document
        .levels
        .iter()
        .map(|l| (l.id.as_str(), l.ordinal))
        .collect();
    let mut ordinals: Vec<f64> = document.levels.iter().map(|l| l.ordinal).collect();
    ordinals.sort_by(f64::total_cmp);
    ordinals.dedup();

    let mut nodes: Vec<RouteNode> = Vec::new();
    let mut edges: Vec<RouteEdge> = Vec::new();
    let mut warnings: Vec<RouteBuildWarning> = Vec::new();
    let mut transit_all: Vec<TransitAllEntry> = Vec::new();

    for &ord in &ordinals {
        let mut walk: Vec<&Value> = Vec::new();
        let mut openings: Vec<([f64; 2], [f64; 2])> = Vec::new();
        let mut transit: Vec<TransitUnit<'_>> = Vec::new();
        for f in &document.features {
            let Some(level_id) = f.level_id.as_deref() else {
                continue;
            };
            if level_ordinal.get(level_id).copied() != Some(ord) {
                continue;
            }
            let Some(geom) = f.geometry.as_ref() else {
                continue;
            };
            match f.feature_type {
                FeatureType::Unit => {
                    let Some(category) = f.category.as_deref() else {
                        continue;
                    };
                    if is_walkway(category) {
                        walk.push(geom);
                    } else if is_transit(category)
                        && let Some(c) = polygon_centroid(geom)
                    {
                        transit.push((c, category.to_string(), largest_polygon(geom), geom));
                    }
                }
                FeatureType::Opening => {
                    if let Some(ma) = opening_axis(geom) {
                        openings.push(ma);
                    }
                }
                _ => {}
            }
        }
        if walk.is_empty() {
            continue;
        }
        let area = navigable_area(&walk, &[]);
        if area.0.is_empty() {
            continue;
        }
        let original = original_vertex_count(&area);
        let Some(spacing) = choose_spacing(&area, original) else {
            warnings.push(RouteBuildWarning {
                code: "synth_floor_too_complex".into(),
                detail: format!(
                    "floor ordinal {ord} navigable area has {original} original ring vertices, \
                     exceeding the {MAX_CDT_VERTS}-vertex synthesis budget; skipping"
                ),
            });
            continue;
        };
        let skeleton = medial_axis(&area, spacing);
        if skeleton.nodes.is_empty() || skeleton.edges.is_empty() {
            continue;
        }

        // Prune centerline edges through sub-width passages (wall–column
        // pinches, slivers), remove short and narrowing wedge spurs, then
        // align passable degree-2 sawtooth chains without changing topology
        // or doorway snap-target density.
        let min_clear = MIN_PASSAGE_M / 2.0;
        let mut wide_edges: Vec<(usize, usize)> = Vec::new();
        for &(a, b) in &skeleton.edges {
            let (pa, pb) = (skeleton.nodes[a], skeleton.nodes[b]);
            let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
            if boundary_clearance_m(pa, &area) < min_clear
                || boundary_clearance_m(pb, &area) < min_clear
                || boundary_clearance_m(mid, &area) < min_clear
            {
                continue;
            }
            wide_edges.push((a, b));
        }
        let skeleton = prune_spur_leaves(
            Skeleton {
                nodes: skeleton.nodes,
                edges: wide_edges,
            },
            &area,
            SPIKE_CHAIN_MAX_M,
            SPIKE_WEDGE_MAX_M,
            SPIKE_TIP_CLEARANCE_RATIO,
        );
        if skeleton.nodes.is_empty() || skeleton.edges.is_empty() {
            continue;
        }

        // Establish components before geometric cleanup. Straightening keeps
        // topology unchanged, so these roots remain valid for doorway snaps.
        let mut blob: Vec<usize> = (0..skeleton.nodes.len()).collect();
        for &(a, b) in &skeleton.edges {
            let (ra, rb) = (uf_find(&mut blob, a), uf_find(&mut blob, b));
            if ra != rb {
                blob[ra] = rb;
            }
        }

        // Preserve the original nearest valid snap targets. These semantic
        // anchors split degree-2 chains, preventing visual smoothing from
        // moving a doorway or transit fallback behind a wall or out of range.
        let mut protected = vec![false; skeleton.nodes.len()];
        for &(mid, _) in &openings {
            let mut cands: Vec<(usize, usize, f64)> = skeleton
                .nodes
                .iter()
                .enumerate()
                .filter_map(|(local, n)| {
                    let d = haversine_m(*n, mid);
                    (d <= SNAP_MAX_M).then(|| (uf_find(&mut blob, local), local, d))
                })
                .collect();
            cands.sort_by(|a, b| a.2.total_cmp(&b.2).then(a.1.cmp(&b.1)));
            let mut seen_roots: HashMap<usize, ()> = HashMap::new();
            for (root, local, _) in cands {
                if seen_roots.contains_key(&root)
                    || !segment_within_area(
                        mid,
                        skeleton.nodes[local],
                        &area,
                        SEGMENT_OUTSIDE_TOL_M,
                    )
                {
                    continue;
                }
                protected[local] = true;
                seen_roots.insert(root, ());
            }
        }
        for (tp, _, footprint, _) in &transit {
            let unit_area = footprint.clone().map(|p| MultiPolygon::new(vec![p]));
            let mut areas: Vec<&MultiPolygon<f64>> = vec![&area];
            if let Some(unit) = unit_area.as_ref() {
                areas.push(unit);
            }
            let mut cands: Vec<(usize, f64)> = skeleton
                .nodes
                .iter()
                .enumerate()
                .filter_map(|(local, n)| {
                    let d = haversine_m(*n, *tp);
                    (d <= SNAP_MAX_M).then_some((local, d))
                })
                .collect();
            cands.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            if let Some((local, _)) = cands.into_iter().find(|(local, _)| {
                segment_within_any(*tp, skeleton.nodes[*local], &areas, SEGMENT_OUTSIDE_TOL_M)
            }) {
                protected[local] = true;
            }
        }
        let mut skeleton =
            straighten_degree_two_chains(skeleton, &area, &protected, WEAVE_DETOUR_RATIO);

        // Doorway PLANNING (before skeleton emit): detect passage direction,
        // discover attaching blobs, upgrade each blob's target via axis-ray →
        // projection → nearest-node, and split centerline edges so the emit
        // below naturally includes T-junction nodes. Union blob roots as we
        // go so a later opening's grouping sees prior doorway merges.
        let mut doorway_plans: Vec<DoorwayPlan> = Vec::new();
        for &(mid, line_dir) in &openings {
            // Nearest VALID node per blob: candidates in distance order, the
            // first whose segment from the opening stays within walkable
            // space. This remains the source of truth for WHICH blobs attach
            // and for the no-walkway warning; targets are upgraded below.
            let mut cands: Vec<(usize, usize, f64)> = Vec::new();
            for (local, n) in skeleton.nodes.iter().enumerate() {
                let d = haversine_m(*n, mid);
                if d <= SNAP_MAX_M {
                    let root = uf_find(&mut blob, local);
                    cands.push((root, local, d));
                }
            }
            cands.sort_by(|a, b| a.2.total_cmp(&b.2).then(a.1.cmp(&b.1)));
            let mut per_blob: HashMap<usize, (usize, f64)> = HashMap::new();
            for (root, local, d) in cands {
                if per_blob.contains_key(&root) {
                    continue;
                }
                if !segment_within_area(mid, skeleton.nodes[local], &area, SEGMENT_OUTSIDE_TOL_M) {
                    continue;
                }
                per_blob.insert(root, (local, d));
            }
            if per_blob.is_empty() {
                warnings.push(RouteBuildWarning {
                    code: "synth_opening_no_walkway".into(),
                    detail: format!(
                        "opening ({:.6}, {:.6}) on ordinal {ord} has no centerline node reachable \
                         within walkable space (>{SNAP_MAX_M} m away or blocked)",
                        mid[0], mid[1]
                    ),
                });
                continue;
            }

            // Passage direction: openings are either gap-spanning connectors
            // (axis = line) or IMDF threshold lines along a wall (axis = normal).
            // Score both candidates from deep interior samples + blob roots.
            let mx = 111_320.0 * mid[1].to_radians().cos();
            let offset_pt = |d: [f64; 2], sign: f64| {
                [
                    mid[0] + sign * d[0] * DOORWAY_STUB_M / mx,
                    mid[1] + sign * d[1] * DOORWAY_STUB_M / 111_320.0,
                ]
            };
            let mut deep_blob = |pt: [f64; 2]| -> Option<usize> {
                if !area.contains(&Point::new(pt[0], pt[1])) {
                    return None;
                }
                if boundary_clearance_m(pt, &area) < STUB_DEEP_M {
                    return None;
                }
                let mut best: Option<(f64, usize)> = None;
                for (local, n) in skeleton.nodes.iter().enumerate() {
                    let d = haversine_m(*n, pt);
                    if d > SNAP_MAX_M {
                        continue;
                    }
                    if best.map(|(bd, _)| d < bd).unwrap_or(true) {
                        best = Some((d, local));
                    }
                }
                best.map(|(_, local)| uf_find(&mut blob, local))
            };
            let mut score_dir = |d: [f64; 2]| -> u8 {
                let a = deep_blob(offset_pt(d, 1.0));
                let b = deep_blob(offset_pt(d, -1.0));
                match (a, b) {
                    (Some(ra), Some(rb)) if ra != rb => 2,
                    (Some(_), None) | (None, Some(_)) => 1,
                    _ => 0,
                }
            };
            let normal = [-line_dir[1], line_dir[0]];
            let s_line = score_dir(line_dir);
            let s_norm = score_dir(normal);
            // Tie → prefer the normal (IMDF threshold semantics: cross the line).
            let axis = if s_line > s_norm { line_dir } else { normal };

            // Upgrade each blob's attach target: axis ray → projection →
            // nearest node. Sorted by root for determinism.
            let mut attach_roots: Vec<usize> = per_blob.keys().copied().collect();
            attach_roots.sort_unstable();
            let mut attaches: Vec<(usize, usize)> = Vec::with_capacity(attach_roots.len());
            for root in attach_roots {
                let (nearest_local, _) = per_blob[&root];
                let target = {
                    // 1. Axis ray along s·p toward this blob's side.
                    let c = skeleton.nodes[nearest_local];
                    let side_dot =
                        axis[0] * (c[0] - mid[0]) * mx + axis[1] * (c[1] - mid[1]) * 111_320.0;
                    let sign = if side_dot >= 0.0 { 1.0 } else { -1.0 };
                    let dir = [sign * axis[0], sign * axis[1]];

                    // Collect edge indices belonging to this blob (live list).
                    let mut edge_idxs: Vec<usize> = (0..skeleton.edges.len())
                        .filter(|&ei| {
                            let (u, v) = skeleton.edges[ei];
                            uf_find(&mut blob, u) == root || uf_find(&mut blob, v) == root
                        })
                        .collect();
                    // Deterministic edge order.
                    edge_idxs.sort_unstable();

                    let mut best_ray: Option<(f64, usize, [f64; 2])> = None; // (t, ei, hit)
                    for &ei in &edge_idxs {
                        let (u, v) = skeleton.edges[ei];
                        // Prefer edges whose BOTH ends are in this blob; a
                        // cross-blob edge is rare after UF but skip if neither
                        // endpoint matches (defensive).
                        let ru = uf_find(&mut blob, u);
                        let rv = uf_find(&mut blob, v);
                        if ru != root && rv != root {
                            continue;
                        }
                        let Some((hit, t, _s)) =
                            ray_segment_hit(mid, dir, skeleton.nodes[u], skeleton.nodes[v])
                        else {
                            continue;
                        };
                        if t <= DOORWAY_SPLIT_EPS_M || t > SNAP_MAX_M {
                            continue;
                        }
                        if !segment_within_area(mid, hit, &area, SEGMENT_OUTSIDE_TOL_M) {
                            continue;
                        }
                        let better = match best_ray {
                            None => true,
                            Some((bt, bei, _)) => {
                                t < bt - 1e-12 || ((t - bt).abs() <= 1e-12 && ei < bei)
                            }
                        };
                        if better {
                            best_ray = Some((t, ei, hit));
                        }
                    }
                    if let Some((_, ei, hit)) = best_ray {
                        split_skeleton_at(&mut skeleton, &mut blob, ei, hit)
                    } else {
                        // 2. Perpendicular projection onto blob edges.
                        let mut best_proj: Option<(f64, usize, [f64; 2])> = None; // (dist, ei, hit)
                        for &ei in &edge_idxs {
                            let (u, v) = skeleton.edges[ei];
                            let ru = uf_find(&mut blob, u);
                            let rv = uf_find(&mut blob, v);
                            if ru != root && rv != root {
                                continue;
                            }
                            let (hit, dist, s) =
                                project_point_to_segment(mid, skeleton.nodes[u], skeleton.nodes[v]);
                            // Strictly interior projection (endpoints handled
                            // by nearest-node / degeneracy reuse).
                            if s <= 0.0 || s >= 1.0 {
                                continue;
                            }
                            if dist > SNAP_MAX_M {
                                continue;
                            }
                            if !segment_within_area(mid, hit, &area, SEGMENT_OUTSIDE_TOL_M) {
                                continue;
                            }
                            let better = match best_proj {
                                None => true,
                                Some((bd, bei, _)) => {
                                    dist < bd - 1e-12 || ((dist - bd).abs() <= 1e-12 && ei < bei)
                                }
                            };
                            if better {
                                best_proj = Some((dist, ei, hit));
                            }
                        }
                        if let Some((_, ei, hit)) = best_proj {
                            split_skeleton_at(&mut skeleton, &mut blob, ei, hit)
                        } else {
                            // 3. Nearest valid node (today's behavior).
                            nearest_local
                        }
                    }
                };
                attaches.push((root, target));
            }

            // Union attaching blob roots so a later opening sees one component.
            if attaches.len() > 1 {
                let r0 = attaches[0].0;
                for &(r, _) in &attaches[1..] {
                    let (ra, rb) = (uf_find(&mut blob, r0), uf_find(&mut blob, r));
                    if ra != rb {
                        blob[ra] = rb;
                    }
                }
            }

            doorway_plans.push(DoorwayPlan {
                mid,
                axis,
                attaches,
            });
        }

        // Emit skeleton (now including any doorway T-junction splits).
        let base = nodes.len();
        for n in &skeleton.nodes {
            nodes.push(RouteNode {
                lon: n[0],
                lat: n[1],
                ordinal: ord,
            });
        }
        for &(a, b) in &skeleton.edges {
            let (i, j) = (base + a, base + b);
            edges.push(RouteEdge {
                from: i as u32,
                to: j as u32,
                weight: haversine_m([nodes[i].lon, nodes[i].lat], [nodes[j].lon, nodes[j].lat])
                    as f32,
                ordinal: ord,
                interior: Vec::new(),
            });
        }
        let skeleton_range = base..nodes.len();

        // Chord eligibility: rebuild from the FINAL skeleton edges (post-split)
        // so split nodes participate. Doorway-only unions stay out — opposite
        // sides must not become chord-eligible via the stub path.
        let mut chord_blob: Vec<usize> = (0..skeleton.nodes.len()).collect();
        for &(a, b) in &skeleton.edges {
            let (ra, rb) = (uf_find(&mut chord_blob, a), uf_find(&mut chord_blob, b));
            if ra != rb {
                chord_blob[ra] = rb;
            }
        }

        // Doorway EMIT: midpoint, axis stubs, M↔stub edges, planned attaches.
        let mut doorway_nodes: Vec<DoorwayNodes> = Vec::new();
        for plan in &doorway_plans {
            let mid = plan.mid;
            let axis = plan.axis;
            let mx = 111_320.0 * mid[1].to_radians().cos();
            let stub_pt = |sign: f64| {
                [
                    mid[0] + sign * axis[0] * DOORWAY_STUB_M / mx,
                    mid[1] + sign * axis[1] * DOORWAY_STUB_M / 111_320.0,
                ]
            };
            let stub_valid = |pt: [f64; 2]| {
                point_within_area(pt, &area, SEGMENT_OUTSIDE_TOL_M)
                    && segment_within_area(pt, mid, &area, SEGMENT_OUTSIDE_TOL_M)
            };
            let mid_idx = nodes.len();
            nodes.push(RouteNode {
                lon: mid[0],
                lat: mid[1],
                ordinal: ord,
            });
            let mut doorway = DoorwayNodes {
                mid: mid_idx,
                fwd: None,
                bwd: None,
                mid_pt: mid,
                axis,
            };
            // Fixed stub order: +axis (fwd) then −axis (bwd).
            for (sign, is_fwd) in [(1.0_f64, true), (-1.0_f64, false)] {
                let pt = stub_pt(sign);
                if !stub_valid(pt) {
                    continue;
                }
                let idx = nodes.len();
                nodes.push(RouteNode {
                    lon: pt[0],
                    lat: pt[1],
                    ordinal: ord,
                });
                edges.push(RouteEdge {
                    from: mid_idx as u32,
                    to: idx as u32,
                    weight: haversine_m(mid, pt) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
                if is_fwd {
                    doorway.fwd = Some(idx);
                } else {
                    doorway.bwd = Some(idx);
                }
            }

            // Attach each planned blob target through the stub on ITS side,
            // falling back to M when the stub is missing, the target sits
            // nearer than the stub (junction steals the stub), or the
            // stub→target segment leaves walkable space.
            for &(_root, local) in &plan.attaches {
                let c = skeleton.nodes[local];
                let side_dot =
                    axis[0] * (c[0] - mid[0]) * mx + axis[1] * (c[1] - mid[1]) * 111_320.0;
                let stub = if side_dot >= 0.0 {
                    doorway.fwd
                } else {
                    doorway.bwd
                };
                let (t_idx, t_pt) = match stub {
                    Some(i) => {
                        let sp = [nodes[i].lon, nodes[i].lat];
                        // Stub is useful only when the attach target lies past
                        // it along the passage direction and far enough that
                        // the stub is not swallowed by a nearer junction.
                        let along =
                            axis[0] * (c[0] - mid[0]) * mx + axis[1] * (c[1] - mid[1]) * 111_320.0;
                        let sign = if side_dot >= 0.0 { 1.0 } else { -1.0 };
                        let forward = along * sign > 0.0;
                        let far_enough =
                            haversine_m(c, mid) > DOORWAY_STUB_M + DOORWAY_STUB_JUNCTION_MARGIN_M;
                        if forward && far_enough {
                            (i, sp)
                        } else {
                            (mid_idx, mid)
                        }
                    }
                    None => (mid_idx, mid),
                };
                let (t_idx, t_pt) = if t_idx != mid_idx
                    && !segment_within_area(t_pt, c, &area, SEGMENT_OUTSIDE_TOL_M)
                {
                    (mid_idx, mid)
                } else {
                    (t_idx, t_pt)
                };
                edges.push(RouteEdge {
                    from: t_idx as u32,
                    to: (base + local) as u32,
                    weight: haversine_m(t_pt, c) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
            }
            doorway_nodes.push(doorway);
        }

        // Near-blob bridging: fuse distinct blobs that abut without a doorway.
        // Bucket skeleton nodes on an ~ADJACENCY_BRIDGE_M grid, then keep the
        // single closest cross-blob node pair per (root_a, root_b).
        let cell_deg = ADJACENCY_BRIDGE_M / 111_320.0;
        let cell = |p: [f64; 2]| {
            (
                (p[0] / cell_deg).floor() as i64,
                (p[1] / cell_deg).floor() as i64,
            )
        };
        let mut buckets: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for (local, n) in skeleton.nodes.iter().enumerate() {
            buckets.entry(cell(*n)).or_default().push(local);
        }
        let mut bridges: HashMap<(usize, usize), (usize, usize, f64)> = HashMap::new();
        for (local, n) in skeleton.nodes.iter().enumerate() {
            let (cx, cy) = cell(*n);
            let root_i = uf_find(&mut blob, local);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    let Some(cands) = buckets.get(&(cx + dx, cy + dy)) else {
                        continue;
                    };
                    for &other in cands {
                        if other <= local {
                            continue;
                        }
                        let root_j = uf_find(&mut blob, other);
                        if root_i == root_j {
                            continue;
                        }
                        let d = haversine_m(*n, skeleton.nodes[other]);
                        if d > ADJACENCY_BRIDGE_M {
                            continue;
                        }
                        let key = (root_i.min(root_j), root_i.max(root_j));
                        let entry = bridges.entry(key).or_insert((local, other, d));
                        if d < entry.2 {
                            *entry = (local, other, d);
                        }
                    }
                }
            }
        }
        let mut keys: Vec<(usize, usize)> = bridges.keys().copied().collect();
        keys.sort_unstable();
        // Skeleton-local accepted bridges (metre weights) — feed the chord
        // pass so savings Dijkstra sees them and does not re-emit the pair.
        let mut accepted_bridges: Vec<(usize, usize, f64)> = Vec::new();
        for key in keys {
            let (li, lj, d) = bridges[&key];
            if uf_find(&mut blob, li) == uf_find(&mut blob, lj) {
                continue;
            }
            // A bridge is a real connection: its segment must stay inside
            // walkable space at full passage width. This rejects bridges
            // across track beds, walls, and sub-width necks alike.
            if !bridge_passable(skeleton.nodes[li], skeleton.nodes[lj], &area) {
                continue;
            }
            let (ra, rb) = (uf_find(&mut blob, li), uf_find(&mut blob, lj));
            blob[ra] = rb;
            // Bridges are in chord savings adjacency — eligibility must match.
            let (cra, crb) = (uf_find(&mut chord_blob, li), uf_find(&mut chord_blob, lj));
            if cra != crb {
                chord_blob[cra] = crb;
            }
            accepted_bridges.push((li, lj, d));
            edges.push(RouteEdge {
                from: (base + li) as u32,
                to: (base + lj) as u32,
                weight: d as f32,
                ordinal: ord,
                interior: Vec::new(),
            });
        }

        // Open-space shortcuts: straight, fully passable chords that beat the
        // centerline path through open areas (concourse diagonals). Same
        // chord-eligible component only (skeleton + bridges; not doorway-only
        // unions), so they never merge components or duplicate doorway/bridge
        // paths (the savings test rejects those).
        for (a, b) in shortcut_chords(&skeleton, &chord_blob, &area, &accepted_bridges) {
            edges.push(RouteEdge {
                from: (base + a) as u32,
                to: (base + b) as u32,
                weight: haversine_m(skeleton.nodes[a], skeleton.nodes[b]) as f32,
                ordinal: ord,
                interior: Vec::new(),
            });
        }

        // Transit units: attach through their doorway `opening`s and record
        // for vertical links. The opening must be reachable THROUGH the unit
        // itself (its real door — an opening that is merely near the boundary
        // but across a wall or track bed is not). A unit with no usable
        // doorway falls back to the nearest centerline node reachable without
        // leaving walkable space or the unit.
        for (tp, category, footprint, geom) in &transit {
            let idx = nodes.len();
            nodes.push(RouteNode {
                lon: tp[0],
                lat: tp[1],
                ordinal: ord,
            });
            let unit_area: Option<MultiPolygon<f64>> =
                footprint.clone().map(|p| MultiPolygon::new(vec![p]));
            let mut attached = false;
            for doorway in &doorway_nodes {
                let Some(boundary_d) = point_boundary_dist_m(doorway.mid_pt, geom) else {
                    continue;
                };
                if boundary_d > TRANSIT_OPENING_SNAP_M {
                    continue;
                }
                // The unit's own side of the doorway (toward its centroid).
                let dmx = 111_320.0 * doorway.mid_pt[1].to_radians().cos();
                let dot = doorway.axis[0] * (tp[0] - doorway.mid_pt[0]) * dmx
                    + doorway.axis[1] * (tp[1] - doorway.mid_pt[1]) * 111_320.0;
                let stub = if dot >= 0.0 { doorway.fwd } else { doorway.bwd };
                let (t_idx, t_pt) = match stub {
                    Some(i) => (i, [nodes[i].lon, nodes[i].lat]),
                    None => (doorway.mid, doorway.mid_pt),
                };
                // The stub must be reachable THROUGH the unit itself (its real
                // door); otherwise fall back to the midpoint under the same
                // rule, and skip the opening when neither is reachable.
                let reachable = |pt: [f64; 2]| {
                    unit_area
                        .as_ref()
                        .is_some_and(|u| segment_within_area(*tp, pt, u, SEGMENT_OUTSIDE_TOL_M))
                };
                let (t_idx, t_pt) = if reachable(t_pt) {
                    (t_idx, t_pt)
                } else if t_idx != doorway.mid && reachable(doorway.mid_pt) {
                    (doorway.mid, doorway.mid_pt)
                } else {
                    continue;
                };
                edges.push(RouteEdge {
                    from: idx as u32,
                    to: t_idx as u32,
                    weight: haversine_m(*tp, t_pt) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
                attached = true;
            }
            if !attached {
                let mut cands: Vec<(usize, f64)> = skeleton_range
                    .clone()
                    .map(|i| (i, haversine_m(*tp, [nodes[i].lon, nodes[i].lat])))
                    .filter(|(_, d)| *d <= SNAP_MAX_M)
                    .collect();
                cands.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
                let mut areas: Vec<&MultiPolygon<f64>> = vec![&area];
                if let Some(u) = unit_area.as_ref() {
                    areas.push(u);
                }
                for (near, _) in cands {
                    let p = [nodes[near].lon, nodes[near].lat];
                    if !segment_within_any(*tp, p, &areas, SEGMENT_OUTSIDE_TOL_M) {
                        continue;
                    }
                    edges.push(RouteEdge {
                        from: idx as u32,
                        to: near as u32,
                        weight: haversine_m(*tp, p) as f32,
                        ordinal: ord,
                        interior: Vec::new(),
                    });
                    break;
                }
            }
            transit_all.push((idx as u32, *tp, category.clone(), ord, footprint.clone()));
        }
    }

    // Vertical transitions: match each transit unit to the nearest same-kind
    // unit on the next consecutive floor.
    transit_all.sort_by_key(|a| a.0);
    let next_ordinal = |o: f64| -> Option<f64> {
        let pos = ordinals.iter().position(|&x| x == o)?;
        ordinals.get(pos + 1).copied()
    };
    for (idx, pt, category, ord, footprint) in transit_all.iter() {
        let Some(next) = next_ordinal(*ord) else {
            continue;
        };
        let mut best: Option<(u32, f64)> = None;
        for (cidx, cpt, ccat, cord, cfoot) in transit_all.iter() {
            if *cord != next || ccat != category {
                continue;
            }
            let d = haversine_m(*pt, *cpt);
            let linkable = d <= VERTICAL_MATCH_M || footprints_overlap(footprint, cfoot);
            if linkable && best.is_none_or(|(bi, bd)| d < bd || (d == bd && *cidx < bi)) {
                best = Some((*cidx, d));
            }
        }
        if let Some((cidx, d)) = best {
            edges.push(RouteEdge {
                from: *idx,
                to: cidx,
                weight: (d + floor_cost(category)) as f32,
                ordinal: *ord,
                interior: Vec::new(),
            });
        }
    }

    // Convert every accumulated metre weight to canonical `net_path.cost`
    // units exactly once, matching imported networks (see `synth`).
    for e in &mut edges {
        e.weight = kiriko_route::meters_to_cost(f64::from(e.weight));
    }

    edges.sort_by(|a, b| {
        (a.from, a.to, a.weight.to_bits()).cmp(&(b.from, b.to, b.weight.to_bits()))
    });
    let node_ids: Vec<u64> = (0..nodes.len() as u64).collect();
    RouteGraphBuild {
        graph: RouteGraph { nodes, edges },
        warnings,
        node_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use geo::algorithm::area::Area;
    use std::collections::BTreeMap;

    /// Canonical `Polygon` for an axis-aligned square of `size` at `(cx, cy)`.
    fn square(cx: f64, cy: f64, size: f64) -> Value {
        let h = size / 2.0;
        let ring = [
            [cx - h, cy - h],
            [cx + h, cy - h],
            [cx + h, cy + h],
            [cx - h, cy + h],
            [cx - h, cy - h],
        ];
        let coords = Value::Array(
            ring.iter()
                .map(|p| Value::Array(vec![Value::Number(p[0]), Value::Number(p[1])]))
                .collect(),
        );
        Value::Object(BTreeMap::from([
            ("type".to_string(), Value::String("Polygon".to_string())),
            ("coordinates".to_string(), Value::Array(vec![coords])),
        ]))
    }

    #[test]
    fn overlapping_walkables_dissolve_to_one_polygon() {
        let a = square(0.0, 0.0, 2.0); // covers x,y ∈ [-1, 1]
        let b = square(1.5, 0.0, 2.0); // covers x ∈ [0.5, 2.5] — overlaps a
        let nav = navigable_area(&[&a, &b], &[]);
        assert_eq!(
            nav.0.len(),
            1,
            "overlapping walkables merge into one polygon"
        );
    }

    #[test]
    fn disjoint_walkables_stay_separate() {
        let a = square(0.0, 0.0, 1.0);
        let b = square(10.0, 0.0, 1.0);
        let nav = navigable_area(&[&a, &b], &[]);
        assert_eq!(nav.0.len(), 2, "disjoint walkables stay as separate parts");
    }

    #[test]
    fn obstacle_is_subtracted_from_navigable_area() {
        let floor = square(0.0, 0.0, 4.0); // area 16
        let full = navigable_area(&[&floor], &[]).unsigned_area();
        let column = square(0.0, 0.0, 1.0); // area 1, interior
        let carved = navigable_area(&[&floor], &[&column]).unsigned_area();
        assert!((full - 16.0).abs() < 1e-9, "full area = {full}");
        assert!((carved - 15.0).abs() < 1e-6, "carved area = {carved}");
    }

    #[test]
    fn empty_input_is_empty() {
        assert_eq!(navigable_area(&[], &[]).0.len(), 0);
    }

    #[test]
    fn medial_axis_of_a_rectangle_spans_its_length() {
        // A long thin 10×2 rectangle: its medial axis is a central spine
        // running the length, so the skeleton must span most of the x-extent.
        let rect = MultiPolygon::new(vec![Polygon::new(
            LineString::from(vec![
                (0.0, 0.0),
                (10.0, 0.0),
                (10.0, 2.0),
                (0.0, 2.0),
                (0.0, 0.0),
            ]),
            vec![],
        )]);
        let skeleton = medial_axis(&rect, 0.5);
        assert!(!skeleton.nodes.is_empty(), "skeleton has nodes");
        assert!(!skeleton.edges.is_empty(), "skeleton has edges");
        let xs: Vec<f64> = skeleton.nodes.iter().map(|n| n[0]).collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!(
            max_x - min_x > 6.0,
            "spine spans the length: {min_x}..{max_x}"
        );
        // Every skeleton node lies inside the rectangle.
        for n in &skeleton.nodes {
            assert!(
                n[0] >= -0.01 && n[0] <= 10.01 && n[1] >= -0.01 && n[1] <= 2.01,
                "node {n:?} in bounds"
            );
        }
    }

    fn feature(
        id: &str,
        feature_type: FeatureType,
        level_id: &str,
        category: Option<&str>,
        geometry: Value,
    ) -> kiriko_model::model::VenueFeature {
        kiriko_model::model::VenueFeature {
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

    fn document(
        levels: &[(&str, f64)],
        features: Vec<kiriko_model::model::VenueFeature>,
    ) -> BundleDocument {
        BundleDocument {
            metadata: crate::codec::BundleMetadata {
                dataset_id: "t/v".into(),
                version: 1,
            },
            manifest: kiriko_model::model::ImdfManifest {
                version: "1.0.0".into(),
                language: "en".into(),
                rest: BTreeMap::new(),
            },
            venue_id: "v".into(),
            levels: levels
                .iter()
                .map(|(id, ordinal)| kiriko_model::model::ViewerLevel {
                    id: (*id).to_string(),
                    ordinal: *ordinal,
                    label: BTreeMap::new(),
                    short_name: BTreeMap::new(),
                })
                .collect(),
            features,
            bounds_by_level: BTreeMap::new(),
            warnings: Vec::new(),
            stats: crate::codec::BundleStats {
                levels: 0,
                features: 0,
            },
            graph: None,
            facilities: None,
            spatial_context: None,
            capabilities: crate::codec::CapabilityReport::default(),
        }
    }

    #[test]
    fn medial_synthesis_builds_a_multi_floor_centerline_graph() {
        // A walkway square on each of two floors, with a stairs unit stacked at
        // the shared centre: each floor gets centerline edges, and the stairs
        // link vertically.
        let walk_l0 = square(139.70, 35.69, 0.0004);
        let walk_l1 = square(139.70, 35.69, 0.0004);
        let stairs_l0 = square(139.70, 35.69, 0.00003);
        let stairs_l1 = square(139.70, 35.69, 0.00003);
        let doc = document(
            &[("L0", 0.0), ("L1", 1.0)],
            vec![
                feature("w0", FeatureType::Unit, "L0", Some("walkway"), walk_l0),
                feature("s0", FeatureType::Unit, "L0", Some("stairs"), stairs_l0),
                feature("w1", FeatureType::Unit, "L1", Some("walkway"), walk_l1),
                feature("s1", FeatureType::Unit, "L1", Some("stairs"), stairs_l1),
            ],
        );
        let build = synthesize_network_medial(&doc);
        assert!(!build.graph.nodes.is_empty(), "graph has centerline nodes");
        assert!(!build.graph.edges.is_empty(), "graph has centerline edges");
        let mut ords: Vec<f64> = build.graph.nodes.iter().map(|n| n.ordinal).collect();
        ords.sort_by(f64::total_cmp);
        ords.dedup();
        assert_eq!(ords, vec![0.0, 1.0], "graph spans both floors");
        let vertical = build.graph.edges.iter().any(|e| {
            build.graph.nodes[e.from as usize].ordinal != build.graph.nodes[e.to as usize].ordinal
        });
        assert!(vertical, "a vertical transit edge links the floors");
    }

    /// Canonical axis-aligned rectangle `Polygon` centered at `(cx, cy)`.
    fn rect(cx: f64, cy: f64, w: f64, h: f64) -> Value {
        let (hw, hh) = (w / 2.0, h / 2.0);
        let ring = [
            [cx - hw, cy - hh],
            [cx + hw, cy - hh],
            [cx + hw, cy + hh],
            [cx - hw, cy + hh],
            [cx - hw, cy - hh],
        ];
        let coords = Value::Array(
            ring.iter()
                .map(|p| Value::Array(vec![Value::Number(p[0]), Value::Number(p[1])]))
                .collect(),
        );
        Value::Object(BTreeMap::from([
            ("type".to_string(), Value::String("Polygon".to_string())),
            ("coordinates".to_string(), Value::Array(vec![coords])),
        ]))
    }

    #[test]
    fn switchback_stairs_link_by_footprint_overlap() {
        // Two floors; each has a walkway blob and a stairs unit whose footprint
        // OVERLAPS the floor above but whose centroid is > VERTICAL_MATCH_M away
        // (a switchback: same shaft, shifted centroid).
        let mut features = Vec::new();
        for (lvl, dx) in [("l0", 0.0), ("l1", 0.00012)] {
            features.push(feature(
                "w",
                FeatureType::Unit,
                lvl,
                Some("walkway"),
                square(139.7000, 35.6000, 0.0004),
            ));
            features.push(feature(
                "s",
                FeatureType::Unit,
                lvl,
                Some("stairs"),
                rect(139.7005 + dx, 35.6000, 0.0006, 0.0001),
            ));
        }
        let doc = document(&[("l0", 0.0), ("l1", 1.0)], features);
        let build = synthesize_network_medial(&doc);
        let vertical = build.graph.edges.iter().any(|e| {
            build.graph.nodes[e.from as usize].ordinal != build.graph.nodes[e.to as usize].ordinal
        });
        assert!(vertical, "overlapping stair footprints link the floors");
    }

    /// Number of connected components of a RouteGraph (undirected).
    fn component_count(graph: &kiriko_route::RouteGraph) -> usize {
        let n = graph.nodes.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut [usize], mut x: usize) -> usize {
            while p[x] != x {
                p[x] = p[p[x]];
                x = p[x];
            }
            x
        }
        for e in &graph.edges {
            let (a, b) = (
                find(&mut parent, e.from as usize),
                find(&mut parent, e.to as usize),
            );
            if a != b {
                parent[a] = b;
            }
        }
        (0..n).filter(|&i| find(&mut parent, i) == i).count()
    }

    #[test]
    fn narrow_gap_between_walkways_is_not_bridged() {
        // Two thin walkway rectangles whose spines are ~1.5 m apart but whose
        // POLYGONS are separated by a ~0.45 m non-walkable gap (wall, column
        // row) with NO opening: below the minimum passage width, so the graph
        // must NOT connect them.
        let features = vec![
            feature(
                "wa",
                FeatureType::Unit,
                "l0",
                Some("walkway"),
                rect(139.70000, 35.600000, 0.00040, 0.00001),
            ),
            feature(
                "wb",
                FeatureType::Unit,
                "l0",
                Some("walkway"),
                rect(139.70000, 35.600014, 0.00040, 0.00001),
            ),
        ];
        let doc = document(&[("l0", 0.0)], features);
        let build = synthesize_network_medial(&doc);
        assert_eq!(
            component_count(&build.graph),
            2,
            "sub-width gap stays disconnected"
        );
    }

    #[test]
    fn narrow_neck_walkway_is_pruned() {
        // One connected walkable area shaped like an hourglass: two 2.2 m wide
        // rooms joined by a 0.5 m neck (wall–column pinch). The neck is below
        // the minimum passage width, so the two rooms must not be routable to
        // each other through it.
        let neck = rect(139.70012, 35.60000, 0.00006, 0.0000045); // ~6.6 m long, 0.5 m wide
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature(
                    "ra",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.60000, 0.00020, 0.00002),
                ),
                feature("neck", FeatureType::Unit, "l0", Some("walkway"), neck),
                feature(
                    "rb",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70024, 35.60000, 0.00020, 0.00002),
                ),
            ],
        );
        let build = synthesize_network_medial(&doc);
        assert_eq!(component_count(&build.graph), 2, "sub-width neck is pruned");
        let crosses_neck = build.graph.edges.iter().any(|e| {
            let (a, b) = (
                &build.graph.nodes[e.from as usize],
                &build.graph.nodes[e.to as usize],
            );
            (a.lon - 139.70012) * (b.lon - 139.70012) < 0.0
        });
        assert!(!crosses_neck, "no edge crosses the pinched neck");
    }

    #[test]
    fn wide_neck_walkway_stays_connected() {
        // Same hourglass shape but with a 1.5 m neck — above the minimum
        // passage width, so the rooms stay connected.
        let neck = rect(139.70012, 35.60000, 0.00006, 0.0000135); // ~6.6 m long, 1.5 m wide
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature(
                    "ra",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.60000, 0.00020, 0.00002),
                ),
                feature("neck", FeatureType::Unit, "l0", Some("walkway"), neck),
                feature(
                    "rb",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70024, 35.60000, 0.00020, 0.00002),
                ),
            ],
        );
        let build = synthesize_network_medial(&doc);
        assert_eq!(
            component_count(&build.graph),
            1,
            "wide-enough neck stays routable"
        );
    }

    #[test]
    fn opening_does_not_snap_across_a_track_gap() {
        // Two platforms (2.2 m wide) separated by a ~9 m track strip. An
        // opening on platform B's edge facing platform A must NOT snap to
        // platform A's centerline: the segment would cross non-walkable track
        // bed, even though platform A's spine is within snap range.
        let features = vec![
            feature(
                "pa",
                FeatureType::Unit,
                "l0",
                Some("platform"),
                rect(139.70000, 35.60000, 0.00040, 0.00002),
            ),
            feature(
                "pb",
                FeatureType::Unit,
                "l0",
                Some("platform"),
                rect(139.70000, 35.60010, 0.00040, 0.00002),
            ),
            feature(
                "door",
                FeatureType::Opening,
                "l0",
                None,
                line(139.69998, 35.60009, 139.70002, 35.60009),
            ),
        ];
        let doc = document(&[("l0", 0.0)], features);
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let cross_gap = g.edges.iter().any(|e| {
            let (a, b) = (&g.nodes[e.from as usize], &g.nodes[e.to as usize]);
            (a.lat - 35.60005) * (b.lat - 35.60005) < 0.0
        });
        assert!(!cross_gap, "no edge crosses the track strip");
        assert_eq!(component_count(g), 2, "platforms stay disconnected");
    }

    #[test]
    fn transit_does_not_attach_to_a_foreign_door() {
        // A stairs unit separated from the walkway by a 1 m non-walkable
        // strip. An opening sits in the strip — close to the walkway (so it
        // gets a node) AND within doorway tolerance of the stairs boundary —
        // but it is not the stairs' door: the centroid-to-opening segment
        // leaves the stairs unit. The stairs must not attach horizontally.
        let walk = rect(139.70000, 35.60000, 0.00040, 0.00002); // y in [35.59999, 35.60001]
        let stairs = rect(139.70000, 35.599965, 0.00006, 0.00003); // y in [35.59995, 35.59998], 1 m gap
        let door = line(139.70000, 35.599980, 139.70000, 35.599990); // midpoint in the gap
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("s", FeatureType::Unit, "l0", Some("stairs"), stairs.clone()),
                feature("door", FeatureType::Opening, "l0", None, door),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let sc = polygon_centroid(&stairs).unwrap();
        let snode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == sc)
            .expect("stairs centroid node exists");
        assert_eq!(
            same_floor_degree(g, snode),
            0,
            "stairs does not attach through a foreign door or across the gap"
        );
    }

    /// Canonical two-vertex `LineString` geometry (for openings).
    fn line(x1: f64, y1: f64, x2: f64, y2: f64) -> Value {
        let coords = Value::Array(vec![
            Value::Array(vec![Value::Number(x1), Value::Number(y1)]),
            Value::Array(vec![Value::Number(x2), Value::Number(y2)]),
        ]);
        Value::Object(BTreeMap::from([
            ("type".to_string(), Value::String("LineString".to_string())),
            ("coordinates".to_string(), coords),
        ]))
    }

    #[test]
    fn synthesized_graph_is_connected_and_bounded() {
        // Floor 0: two adjacent walkways joined by a doorway in their shared
        // wall; a stairs unit on the first walkway stacks onto floor 1's
        // walkway. The whole graph is ONE component, spans both floors, and
        // every edge is a short indoor hop.
        let features = vec![
            feature(
                "wa",
                FeatureType::Unit,
                "l0",
                Some("walkway"),
                rect(139.70000, 35.60000, 0.00040, 0.00002),
            ),
            feature(
                "wb",
                FeatureType::Unit,
                "l0",
                Some("walkway"),
                rect(139.70040, 35.60000, 0.00040, 0.00002),
            ),
            feature(
                "door",
                FeatureType::Opening,
                "l0",
                None,
                line(139.70020, 35.59999, 139.70020, 35.60001),
            ),
            feature(
                "s0",
                FeatureType::Unit,
                "l0",
                Some("stairs"),
                rect(139.70000, 35.60000, 0.00006, 0.00001),
            ),
            feature(
                "w1",
                FeatureType::Unit,
                "l1",
                Some("walkway"),
                rect(139.70000, 35.60000, 0.00040, 0.00002),
            ),
            feature(
                "s1",
                FeatureType::Unit,
                "l1",
                Some("stairs"),
                rect(139.70000, 35.60000, 0.00006, 0.00001),
            ),
        ];
        let doc = document(&[("l0", 0.0), ("l1", 1.0)], features);
        let build = synthesize_network_medial(&doc);
        assert_eq!(component_count(&build.graph), 1, "one connected component");
        let ordinals: std::collections::BTreeSet<i64> =
            build.graph.nodes.iter().map(|n| n.ordinal as i64).collect();
        assert_eq!(ordinals.len(), 2, "both floors present");
        let max_edge = build
            .graph
            .edges
            .iter()
            .fold(0.0_f32, |m, e| m.max(e.weight));
        assert!(
            max_edge <= 30_000.0,
            "no teleport edges: max {max_edge} cost units (30 m)"
        );

        // Determinism: identical input → identical graph.
        let again = synthesize_network_medial(&doc);
        assert_eq!(build.graph, again.graph, "synthesis is deterministic");
    }

    #[test]
    fn unenclosedarea_is_not_routable() {
        // A floor whose ONLY unit is an unenclosedarea (open shop interior):
        // no walkable coverage, so no network at all.
        let shop_only = rect(139.70000, 35.60000, 0.00020, 0.00002);
        let doc = document(
            &[("l0", 0.0)],
            vec![feature(
                "shop",
                FeatureType::Unit,
                "l0",
                Some("unenclosedarea"),
                shop_only,
            )],
        );
        let build = synthesize_network_medial(&doc);
        assert!(
            build.graph.nodes.is_empty(),
            "unenclosedarea alone yields no network"
        );

        // Walkways loop AROUND an unenclosed shop block: the network follows
        // the walkways and no centerline node lies inside the shop.
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature(
                    "wn",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.60003, 0.00030, 0.00002),
                ),
                feature(
                    "ws",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.59997, 0.00030, 0.00002),
                ),
                feature(
                    "ww",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.69986, 35.60000, 0.00002, 0.00006),
                ),
                feature(
                    "shop",
                    FeatureType::Unit,
                    "l0",
                    Some("unenclosedarea"),
                    rect(139.70000, 35.60000, 0.00020, 0.00002),
                ),
            ],
        );
        let build = synthesize_network_medial(&doc);
        assert!(!build.graph.nodes.is_empty(), "walkways still synthesize");
        assert_eq!(
            component_count(&build.graph),
            1,
            "walkway loop stays connected"
        );
        let inside_shop = build
            .graph
            .nodes
            .iter()
            .any(|n| (n.lon - 139.70000).abs() < 0.00010 && (n.lat - 35.60000).abs() < 0.00001);
        assert!(!inside_shop, "no centerline inside the shop interior");
    }

    #[test]
    fn prune_spur_leaves_removes_short_twigs_but_keeps_real_ends() {
        // A spine with three branches: a 0.6 m twig, a kinked 3-link twig
        // (total 2.1 m), and a 3.5 m terminal branch. Short branches are
        // removed WHOLE (no remnant links); the long real end survives.
        let m = 9e-6; // ~1 m in degrees latitude
        let skeleton = Skeleton {
            nodes: vec![
                [139.70000, 35.60000],
                [139.70010, 35.60000],
                [139.70020, 35.60000],
                [139.70010, 35.60000 + 0.6 * m], // twig tip
                [139.70020, 35.60000 + 3.5 * m], // branch tip
                [139.70010, 35.60000 - 0.7 * m], // kinked twig link 1
                [139.70010, 35.60000 - 1.4 * m], // kinked twig link 2
                [139.70010, 35.60000 - 2.1 * m], // kinked twig tip
            ],
            edges: vec![(0, 1), (1, 2), (1, 3), (2, 4), (1, 5), (5, 6), (6, 7)],
        };
        let area = MultiPolygon::new(vec![Polygon::new(
            LineString::from(vec![
                (139.69, 35.59),
                (139.71, 35.59),
                (139.71, 35.61),
                (139.69, 35.61),
                (139.69, 35.59),
            ]),
            vec![],
        )]);
        let pruned = prune_spur_leaves(skeleton, &area, 3.0, 3.0, 0.5);
        assert_eq!(
            pruned.edges.len(),
            3,
            "both twigs removed whole: {:?}",
            pruned.edges
        );
        // the surviving branch is the 3.5 m real end
        let has_long_branch = pruned
            .edges
            .iter()
            .any(|&(a, b)| haversine_m(pruned.nodes[a], pruned.nodes[b]) > 3.0);
        assert!(has_long_branch, "real corridor end preserved");
        // no sub-1 m remnant link survives from the kinked twig
        let short_links = pruned
            .edges
            .iter()
            .filter(|&&(a, b)| haversine_m(pruned.nodes[a], pruned.nodes[b]) < 1.0)
            .count();
        assert_eq!(short_links, 0, "no twig remnant links");
    }

    #[test]
    fn prune_spur_leaves_removes_narrowing_wedges_but_keeps_equal_width_ends() {
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let mx = 111_320.0 * cy.to_radians().cos();
        let xy = |x_m: f64, y_m: f64| (cx + x_m / mx, cy + y_m / 111_320.0);
        let node = |x_m: f64, y_m: f64| {
            let (x, y) = xy(x_m, y_m);
            [x, y]
        };
        let area = MultiPolygon::new(vec![Polygon::new(
            LineString::from(vec![
                xy(-10.0, -5.0),
                xy(10.0, -5.0),
                xy(10.0, 5.0),
                xy(-10.0, 5.0),
                xy(-10.0, -5.0),
            ]),
            vec![],
        )]);
        let skeleton = Skeleton {
            nodes: vec![
                node(0.0, 0.0),
                node(-4.0, 0.0),
                node(4.0, 0.0),
                node(0.0, 4.5),
            ],
            edges: vec![(0, 1), (0, 2), (0, 3)],
        };

        let pruned = prune_spur_leaves(skeleton, &area, 3.0, 8.0, 0.5);

        assert_eq!(pruned.edges.len(), 2, "narrowing boundary wedge removed");
        assert!(
            pruned
                .nodes
                .iter()
                .all(|p| haversine_m(*p, node(0.0, 4.5)) > 0.1),
            "wedge tip is removed"
        );
        assert!(
            pruned
                .nodes
                .iter()
                .any(|p| haversine_m(*p, node(-4.0, 0.0)) < 0.1)
                && pruned
                    .nodes
                    .iter()
                    .any(|p| haversine_m(*p, node(4.0, 0.0)) < 0.1),
            "equal-clearance corridor ends survive"
        );
    }

    #[test]
    fn prune_spur_leaves_keeps_short_dead_end_corridor() {
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let mx = 111_320.0 * cy.to_radians().cos();
        let xy = |x_m: f64, y_m: f64| (cx + x_m / mx, cy + y_m / 111_320.0);
        let node = |x_m: f64, y_m: f64| {
            let (x, y) = xy(x_m, y_m);
            [x, y]
        };
        // A 1 m-wide, 6 m-long side corridor branches from a 4 m-wide main
        // corridor and ends at a flat wall. Its leaf clearance is 0.5 m while
        // the junction clearance is 2 m, so clearance ratio alone is unsafe.
        let area = MultiPolygon::new(vec![Polygon::new(
            LineString::from(vec![
                xy(-10.0, -2.0),
                xy(10.0, -2.0),
                xy(10.0, 2.0),
                xy(0.5, 2.0),
                xy(0.5, 8.0),
                xy(-0.5, 8.0),
                xy(-0.5, 2.0),
                xy(-10.0, 2.0),
                xy(-10.0, -2.0),
            ]),
            vec![],
        )]);
        let skeleton = Skeleton {
            nodes: vec![
                node(0.0, 0.0),
                node(-4.0, 0.0),
                node(4.0, 0.0),
                node(0.0, 4.0),
                node(0.0, 7.5),
            ],
            edges: vec![(0, 1), (0, 2), (0, 3), (3, 4)],
        };

        let pruned = prune_spur_leaves(skeleton, &area, 3.0, 8.0, 0.5);

        assert_eq!(pruned.edges.len(), 4, "flat-end corridor remains routable");
        assert!(
            pruned
                .nodes
                .iter()
                .any(|p| haversine_m(*p, node(0.0, 7.5)) < 0.1),
            "dead-end tip is preserved"
        );
    }

    #[test]
    fn straightens_passable_weaves_without_cutting_through_obstacles() {
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let mx = 111_320.0 * cy.to_radians().cos();
        let xy = |x_m: f64, y_m: f64| (cx + x_m / mx, cy + y_m / 111_320.0);
        let node = |x_m: f64, y_m: f64| {
            let (x, y) = xy(x_m, y_m);
            [x, y]
        };
        let outer = LineString::from(vec![
            xy(-10.0, -5.0),
            xy(10.0, -5.0),
            xy(10.0, 5.0),
            xy(-10.0, 5.0),
            xy(-10.0, -5.0),
        ]);
        let open_area = MultiPolygon::new(vec![Polygon::new(outer.clone(), vec![])]);
        let make_weave = || Skeleton {
            nodes: vec![
                node(-6.0, 0.0),
                node(-3.0, 1.3),
                node(0.0, -1.3),
                node(3.0, 1.3),
                node(6.0, 0.0),
            ],
            edges: vec![(0, 1), (1, 2), (2, 3), (3, 4)],
        };

        let straight = straighten_degree_two_chains(make_weave(), &open_area, &[false; 5], 1.15);
        assert_eq!(
            straight.nodes.len(),
            5,
            "snap-target node density is preserved"
        );
        assert_eq!(straight.edges.len(), 4, "chain topology is preserved");
        assert!(
            straight
                .nodes
                .iter()
                .all(|p| haversine_m(*p, [p[0], cy]) < 0.05),
            "every weave node lies on the straight chord: {:?}",
            straight.nodes
        );

        let anchored = straighten_degree_two_chains(
            make_weave(),
            &open_area,
            &[false, false, true, false, false],
            1.15,
        );
        assert!(
            haversine_m(anchored.nodes[2], node(0.0, -1.3)) < 0.05,
            "semantic snap anchor is not repositioned"
        );

        let hole = LineString::from(vec![
            xy(-2.0, -1.0),
            xy(-2.0, 1.0),
            xy(2.0, 1.0),
            xy(2.0, -1.0),
            xy(-2.0, -1.0),
        ]);
        let obstructed_area = MultiPolygon::new(vec![Polygon::new(outer, vec![hole])]);
        let around_wall = Skeleton {
            nodes: vec![
                node(-5.0, 0.0),
                node(-3.0, 2.0),
                node(0.0, 2.0),
                node(3.0, 2.0),
                node(5.0, 0.0),
            ],
            edges: vec![(0, 1), (1, 2), (2, 3), (3, 4)],
        };

        let preserved =
            straighten_degree_two_chains(around_wall, &obstructed_area, &[false; 5], 1.15);
        assert_eq!(preserved.nodes.len(), 5, "wall detour nodes remain");
        assert_eq!(preserved.edges.len(), 4, "wall detour topology remains");
        assert!(
            preserved.nodes[2][1] > cy + 1.5 / 111_320.0,
            "wall detour geometry is not flattened"
        );
    }

    /// Same-floor neighbor count of one graph node.
    fn same_floor_degree(graph: &kiriko_route::RouteGraph, node: usize) -> usize {
        let ord = graph.nodes[node].ordinal;
        graph
            .edges
            .iter()
            .filter(|e| {
                let (a, b) = (e.from as usize, e.to as usize);
                (a == node || b == node)
                    && graph.nodes[if a == node { b } else { a }].ordinal == ord
            })
            .count()
    }

    #[test]
    fn transit_attaches_through_its_opening() {
        // A walkway corridor with a stairs unit behind a doorway in its wall:
        // the stairs must be reached THROUGH the opening node, never via a
        // direct centroid-to-centerline edge.
        let walk = rect(139.70000, 35.60000, 0.00040, 0.00002);
        let stairs = rect(139.70000, 35.599975, 0.00006, 0.00003);
        let door = line(139.70000, 35.599985, 139.70000, 35.599995);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("s", FeatureType::Unit, "l0", Some("stairs"), stairs.clone()),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;

        let sc = polygon_centroid(&stairs).unwrap();
        let snode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == sc)
            .expect("stairs centroid node exists");
        let dm = linestring_midpoint(&door).unwrap();
        let onode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == dm)
            .expect("opening node exists");

        let has_edge = |a: usize, b: usize| {
            g.edges.iter().any(|e| {
                (e.from as usize == a && e.to as usize == b)
                    || (e.from as usize == b && e.to as usize == a)
            })
        };
        assert!(has_edge(snode, onode), "stairs attaches via its opening");
        let direct = g.edges.iter().any(|e| {
            let (a, b) = (e.from as usize, e.to as usize);
            (a == snode || b == snode) && a != onode && b != onode
        });
        assert!(!direct, "no direct centroid-to-centerline edge");
        assert_eq!(
            component_count(g),
            1,
            "graph stays connected through the doorway"
        );
    }

    #[test]
    fn transit_without_opening_snaps_to_centerline() {
        // A stairs unit touching the walkway with NO opening feature keeps the
        // direct centroid-to-centerline snap as a fallback.
        let walk = rect(139.70000, 35.60000, 0.00040, 0.00002);
        let stairs = rect(139.70000, 35.599975, 0.00006, 0.00003);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("s", FeatureType::Unit, "l0", Some("stairs"), stairs.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let sc = polygon_centroid(&stairs).unwrap();
        let snode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == sc)
            .expect("stairs centroid node exists");
        assert!(
            same_floor_degree(g, snode) >= 1,
            "stairs snaps onto the centerline"
        );
        assert_eq!(component_count(g), 1);
    }

    #[test]
    fn opening_connected_blobs_skip_the_near_blob_bridge() {
        // Two parallel thin walkways (spines ~1.5 m apart) joined by a doorway:
        // the opening already connects the two spines, so the near-blob
        // bridging pass must not add a second, direct skeleton-skeleton edge
        // across the same gap.
        let door = line(139.70000, 35.600004, 139.70000, 35.600010);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature(
                    "wa",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600000, 0.00040, 0.00001),
                ),
                feature(
                    "wb",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600014, 0.00040, 0.00001),
                ),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        assert_eq!(component_count(g), 1, "doorway connects the two walkways");

        let dm = linestring_midpoint(&door).unwrap();
        let onode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == dm)
            .expect("opening node exists");
        // A cross-spine skeleton edge jumps the ~1.4 m lat gap between the two
        // spines without touching the opening node.
        let cross_spine = g.edges.iter().any(|e| {
            let (a, b) = (e.from as usize, e.to as usize);
            if a == onode || b == onode {
                return false;
            }
            (g.nodes[a].lat - g.nodes[b].lat).abs() > 0.000008
        });
        assert!(
            !cross_spine,
            "no direct bridge edge duplicating the doorway path"
        );
        // Midpoint degree: two stub edges, plus direct attaches when the
        // centerline T-junction sits nearer than the stub (thin walkways
        // ~1.1 m half-width < DOORWAY_STUB_M + margin). Stubs remain for
        // geometry/transit; attach lands on M so the stub is not a detour.
        let mid_deg = same_floor_degree(g, onode);
        assert!(
            (2..=4).contains(&mid_deg),
            "midpoint keeps stub edges and at most two direct attaches, degree={mid_deg}"
        );
    }

    #[test]
    fn nearby_openings_share_one_doorway_bridge() {
        // Two doorways ~1.5 m apart in the same wall between the same two
        // walkway blobs: the first bridges the blobs; the second must attach
        // as a leaf to the already-connected component, not fan out a second
        // parallel bridge.
        let door1 = line(139.700000, 35.600004, 139.700000, 35.600010);
        let door2 = line(139.700016, 35.600004, 139.700016, 35.600010);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature(
                    "wa",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600000, 0.00040, 0.00001),
                ),
                feature(
                    "wb",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600014, 0.00040, 0.00001),
                ),
                feature("door1", FeatureType::Opening, "l0", None, door1.clone()),
                feature("door2", FeatureType::Opening, "l0", None, door2.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        assert_eq!(component_count(g), 1);

        // The doorway group (midpoint + axis stubs) of the first door bridges
        // both spines (two attach edges); the second door's group attaches as
        // a leaf (exactly one attach edge to the skeleton).
        let attach_count = |d: &Value| {
            let group = doorway_group(g, d);
            g.edges
                .iter()
                .filter(|e| group.contains(&(e.from as usize)) != group.contains(&(e.to as usize)))
                .count()
        };
        assert_eq!(attach_count(&door1), 2, "first doorway bridges both spines");
        assert_eq!(attach_count(&door2), 1, "second doorway attaches as a leaf");
    }

    #[test]
    fn platform_units_are_walkable() {
        // A floor whose only navigable unit is a platform must still synthesize
        // a centerline network.
        let features = vec![feature(
            "p",
            FeatureType::Unit,
            "l0",
            Some("platform"),
            rect(139.70000, 35.60000, 0.00060, 0.00003),
        )];
        let doc = document(&[("l0", 0.0)], features);
        let build = synthesize_network_medial(&doc);
        assert!(
            !build.graph.nodes.is_empty(),
            "platform is walkable → non-empty graph"
        );
    }

    #[test]
    fn rooms_only_yield_no_network() {
        let features = vec![feature(
            "r",
            FeatureType::Unit,
            "l0",
            Some("room"),
            square(139.70000, 35.60000, 0.00040),
        )];
        let doc = document(&[("l0", 0.0)], features);
        let build = synthesize_network_medial(&doc);
        assert!(
            build.graph.nodes.is_empty(),
            "non-walkable rooms → empty graph"
        );
    }

    /// Canonical `Polygon` approximating a circle at `(cx, cy)` with `sides`
    /// distinct vertices (plus the duplicated closing coordinate) at `radius`
    /// degrees. A many-sided polygon packs a large ORIGINAL vertex count into a
    /// small perimeter.
    fn regular_polygon(cx: f64, cy: f64, radius: f64, sides: usize) -> Value {
        use std::f64::consts::TAU;
        let mut pts: Vec<Value> = (0..sides)
            .map(|i| {
                let a = TAU * i as f64 / sides as f64;
                Value::Array(vec![
                    Value::Number(cx + radius * a.cos()),
                    Value::Number(cy + radius * a.sin()),
                ])
            })
            .collect();
        pts.push(pts[0].clone());
        Value::Object(BTreeMap::from([
            ("type".to_string(), Value::String("Polygon".to_string())),
            (
                "coordinates".to_string(),
                Value::Array(vec![Value::Array(pts)]),
            ),
        ]))
    }

    #[test]
    fn dense_ring_floor_is_skipped_before_triangulation() {
        // L0's only walkway is a tiny-perimeter polygon whose exterior ring
        // already carries more ORIGINAL coordinates than MAX_CDT_VERTS. Coarser
        // spacing cannot remove existing vertices, so the floor must be skipped
        // with a controlled warning — never fed to the CDT. L1's plain square
        // walkway (well within budget) must still synthesize.
        let dense = regular_polygon(139.70, 35.69, 0.0002, MAX_CDT_VERTS + 10);
        let plain = square(139.70, 35.69, 0.0004);
        let doc = document(
            &[("L0", 0.0), ("L1", 1.0)],
            vec![
                feature("w0", FeatureType::Unit, "L0", Some("walkway"), dense),
                feature("w1", FeatureType::Unit, "L1", Some("walkway"), plain),
            ],
        );
        let build = synthesize_network_medial(&doc);

        let ords: std::collections::BTreeSet<i64> =
            build.graph.nodes.iter().map(|n| n.ordinal as i64).collect();
        assert!(
            !build.graph.nodes.is_empty(),
            "in-budget floor still synthesizes"
        );
        assert_eq!(
            ords,
            std::collections::BTreeSet::from([1]),
            "only L1 is synthesized"
        );

        let skip = build
            .warnings
            .iter()
            .find(|w| w.code == "synth_floor_too_complex")
            .expect("dense floor emits a synth_floor_too_complex warning");
        assert!(
            skip.detail.contains(&(MAX_CDT_VERTS + 10).to_string()),
            "warning carries the original vertex count: {}",
            skip.detail
        );
        assert!(
            skip.detail.contains('0'),
            "warning carries the ordinal: {}",
            skip.detail
        );
    }

    #[test]
    fn choose_spacing_rejects_over_budget_original_vertices() {
        let dense = navigable_area(
            &[&regular_polygon(139.70, 35.69, 0.0002, MAX_CDT_VERTS + 5)],
            &[],
        );
        let orig = original_vertex_count(&dense);
        assert!(
            orig > MAX_CDT_VERTS,
            "original count {orig} exceeds ceiling"
        );
        assert!(
            choose_spacing(&dense, orig).is_none(),
            "over-budget floor is rejected"
        );
    }

    #[test]
    fn choose_spacing_keeps_densified_total_under_ceiling() {
        // A long-perimeter area with few original vertices: spacing must coarsen
        // from the remaining interpolation budget so the densified total stays
        // under the ceiling, yet never drop below BASE_SPACING_DEG.
        let big = MultiPolygon::new(vec![Polygon::new(
            LineString::from(vec![
                (0.0, 0.0),
                (0.4, 0.0),
                (0.4, 0.001),
                (0.0, 0.001),
                (0.0, 0.0),
            ]),
            vec![],
        )]);
        let orig = original_vertex_count(&big);
        let spacing = choose_spacing(&big, orig).expect("in-budget original vertices");
        assert!(
            spacing >= BASE_SPACING_DEG,
            "spacing never below base: {spacing}"
        );
        let densified: usize = big
            .iter()
            .map(|p| densify_ring(p.exterior(), spacing).len())
            .sum();
        assert!(
            densified <= MAX_CDT_VERTS,
            "densified {densified} stays under ceiling"
        );

        // A small area keeps the fine base spacing.
        let small = navigable_area(&[&square(139.70, 35.69, 0.0004)], &[]);
        let so = original_vertex_count(&small);
        assert_eq!(choose_spacing(&small, so), Some(BASE_SPACING_DEG));
    }

    /// Node indices at the doorway midpoint and (when present) its two passage
    /// stubs. Stubs may lie along the opening line or its normal — the synth
    /// picks per opening — so both candidate axes are probed.
    fn doorway_group(g: &kiriko_route::RouteGraph, door: &Value) -> Vec<usize> {
        let mid = linestring_midpoint(door).unwrap();
        let mx = 111_320.0 * mid[1].to_radians().cos();
        // Door line direction from the line's first→last vertex (test doors are 2-vertex).
        let coords = door
            .as_object()
            .and_then(|o| o.get("coordinates"))
            .and_then(Value::as_array)
            .unwrap();
        let pt = |i: usize| {
            let p = coords[i].as_array().unwrap();
            [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]
        };
        let (a, b) = (pt(0), pt(coords.len() - 1));
        let (dx, dy) = ((b[0] - a[0]) * mx, (b[1] - a[1]) * 111_320.0);
        let len = (dx * dx + dy * dy).sqrt();
        let line_dir = [dx / len, dy / len];
        let normal = [-line_dir[1], line_dir[0]];
        let stub = |dir: [f64; 2], sign: f64| {
            [
                mid[0] + sign * dir[0] * DOORWAY_STUB_M / mx,
                mid[1] + sign * dir[1] * DOORWAY_STUB_M / 111_320.0,
            ]
        };
        let want = [
            mid,
            stub(line_dir, 1.0),
            stub(line_dir, -1.0),
            stub(normal, 1.0),
            stub(normal, -1.0),
        ];
        g.nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| {
                want.iter()
                    .any(|w| (n.lon - w[0]).abs() < 1e-9 && (n.lat - w[1]).abs() < 1e-9)
            })
            .map(|(i, _)| i)
            .collect()
    }

    #[test]
    fn doorway_stubs_cross_the_passage_direction() {
        // One 36 m × 11 m walkway with a doorway drawn across its middle (line
        // along latitude). Passage is through the gate — perpendicular to the
        // opening line (score tie → prefer the normal). Stubs flank the
        // midpoint on that passage axis. The centerline attaches through a
        // stub, or directly to the midpoint when the on-axis junction sits
        // nearer than the stub (DOORWAY_STUB_M + margin).
        let walk = rect(139.70000, 35.600002, 0.00040, 0.00010);
        let door = line(139.70000, 35.599995, 139.70000, 35.600005);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        let onode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == dm)
            .expect("opening midpoint node exists");
        let group = doorway_group(g, &door);
        assert_eq!(group.len(), 3, "midpoint plus both passage stubs");
        // Midpoint degree is at least 2 (the two stubs). When the on-axis
        // split lands nearer than the stub, attach goes to M directly
        // (degree 3); otherwise attach goes through a stub (degree 2).
        let mid_deg = same_floor_degree(g, onode);
        assert!(
            mid_deg == 2 || mid_deg == 3,
            "midpoint touches stubs and at most one direct attach, degree={mid_deg}"
        );
        // Stubs are perpendicular to the N–S opening line: same lat as mid, ±δ lon.
        for &s in &group {
            if s == onode {
                continue;
            }
            assert!(
                (g.nodes[s].lat - dm[1]).abs() < 1e-9,
                "stub perpendicular to the opening line (same lat), got lon={} lat={}",
                g.nodes[s].lon,
                g.nodes[s].lat
            );
            assert!(
                (g.nodes[s].lon - dm[0]).abs() > 1e-9,
                "stub must leave the opening line, not sit on it"
            );
        }
        // The centerline attaches through a stub OR directly to M when the
        // T-junction is nearer than the stub (wide room, short approach).
        let attached_via_stub = group.iter().any(|&s| {
            s != onode
                && g.edges.iter().any(|e| {
                    let (a, b) = (e.from as usize, e.to as usize);
                    (a == s && b != onode) || (b == s && a != onode)
                })
        });
        let attached_via_mid = mid_deg == 3;
        assert!(
            attached_via_stub || attached_via_mid,
            "centerline attaches through a stub or directly to M"
        );
    }

    #[test]
    fn stub_attach_is_side_aware() {
        // Two parallel walkways joined by a doorway spanning the gap (line
        // along latitude): each blob's centerline attaches to the stub on ITS
        // side. Gap-connector geometry: line direction scores 2 (different
        // blobs deep on each side) and must keep winning over the normal.
        // ~4.8 m tall walkways with a ~0.55 m gap: ±1.2 m stubs land deep
        // (≥0.5 m clearance) inside each walkway; the midpoint sits in the
        // gap within SEGMENT_OUTSIDE_TOL_M of both sides.
        let door = line(139.70000, 35.600045, 139.70000, 35.600055);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature(
                    "wa",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600025, 0.00040, 0.000045),
                ),
                feature(
                    "wb",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600075, 0.00040, 0.000045),
                ),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        assert_eq!(component_count(g), 1, "doorway connects the two walkways");
        let dm = linestring_midpoint(&door).unwrap();
        let onode = g.nodes.iter().position(|n| [n.lon, n.lat] == dm).unwrap();
        let group = doorway_group(g, &door);
        assert_eq!(group.len(), 3);
        // Every attach edge from the doorway group to the skeleton lands on
        // the side-appropriate stub: a neighbor on the lower walkway's side
        // has lat below the midpoint, and vice versa.
        for e in &g.edges {
            let (a, b) = (e.from as usize, e.to as usize);
            let (inside, outside) = match (group.contains(&a), group.contains(&b)) {
                (true, false) => (a, b),
                (false, true) => (b, a),
                _ => continue,
            };
            assert_ne!(inside, onode, "no direct midpoint attach");
            assert_eq!(
                (g.nodes[inside].lat - dm[1]).signum(),
                (g.nodes[outside].lat - dm[1]).signum(),
                "attach lands on the stub of the same side"
            );
        }
    }

    #[test]
    fn outside_stub_side_is_dropped() {
        // A threshold opening drawn along the walkway's outer (south) wall:
        // passage is the wall normal. The stub pointing outside the walkable
        // area is dropped; the midpoint and inside stub remain.
        let walk = rect(139.70000, 35.60000, 0.00040, 0.00002);
        // E–W threshold on the south edge (along the wall).
        let door = line(139.69998, 35.599990, 139.70002, 35.599990);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        assert!(
            g.nodes.iter().any(|n| [n.lon, n.lat] == dm),
            "midpoint node exists"
        );
        let group = doorway_group(g, &door);
        assert_eq!(group.len(), 2, "only the inside stub survives");
        // Surviving stub is on the normal (N), not along the wall.
        let stub = group.into_iter().find(|&i| {
            let n = &g.nodes[i];
            (n.lon - dm[0]).abs() > 1e-12 || (n.lat - dm[1]).abs() > 1e-12
        });
        let stub = stub.expect("inside stub present");
        assert!(
            (g.nodes[stub].lon - dm[0]).abs() < 1e-9,
            "inside stub is on the wall normal (same lon)"
        );
        assert!(
            g.nodes[stub].lat > dm[1],
            "inside stub is north of the south-wall threshold"
        );
        assert_eq!(component_count(g), 1);
    }

    #[test]
    fn doorway_axis_crosses_a_threshold_opening() {
        // Walkway abutting a non-walkable room on a shared east–west wall; the
        // opening is drawn along that wall (IMDF threshold). The surviving stub
        // must sit on the walkable side, offset perpendicular to the line —
        // never along the wall into either unit.
        let walk = rect(139.70000, 35.60000, 0.00040, 0.00002);
        // Room immediately south of the walkway (non-walkable category); north
        // edge shares the walkway's south wall at lat 35.59999.
        let room = rect(139.70000, 35.59998, 0.00040, 0.00002);
        let door = line(139.69998, 35.599990, 139.70002, 35.599990);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("r", FeatureType::Unit, "l0", Some("room"), room),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        let onode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == dm)
            .expect("opening midpoint node exists");
        let group = doorway_group(g, &door);
        // Midpoint + one walkable-side stub (room side is not walkable).
        assert_eq!(
            group.len(),
            2,
            "only the walkable-side stub survives: {group:?}"
        );
        let stub_idx = group.into_iter().find(|&i| i != onode).expect("stub");
        let sn = &g.nodes[stub_idx];
        // Perpendicular to the E–W threshold → same lon, different lat.
        assert!(
            (sn.lon - dm[0]).abs() < 1e-9,
            "stub is on the wall normal, not along the wall: lon={} mid={}",
            sn.lon,
            dm[0]
        );
        assert!(
            sn.lat > dm[1],
            "stub is on the walkable (north) side, lat={} mid={}",
            sn.lat,
            dm[1]
        );
        // No stub sits along the wall (would share the midpoint's lat and differ in lon).
        let along_wall = g.nodes.iter().any(|n| {
            (n.lat - dm[1]).abs() < 1e-9
                && (n.lon - dm[0]).abs() > 1e-9
                && haversine_m([n.lon, n.lat], dm) < DOORWAY_STUB_M + 0.1
        });
        assert!(!along_wall, "no stub is placed along the wall");
    }

    /// Lateral offset (m) of `p` from the ray through `origin` along unit
    /// metre-frame direction `dir`. Zero when collinear with the door axis.
    fn lateral_offset_m(origin: [f64; 2], dir: [f64; 2], p: [f64; 2]) -> f64 {
        let mx = 111_320.0 * origin[1].to_radians().cos();
        let vx = (p[0] - origin[0]) * mx;
        let vy = (p[1] - origin[1]) * 111_320.0;
        // |v × dir| in 2d = |vx*dy - vy*dx|
        (vx * dir[1] - vy * dir[0]).abs()
    }

    /// Angle (degrees) between two undirected graph edges sharing `mid`.
    /// 0° = collinear straight-through; 180° = fold-back.
    fn approach_bend_deg(g: &kiriko_route::RouteGraph, a: usize, mid: usize, b: usize) -> f64 {
        let mx = 111_320.0 * g.nodes[mid].lat.to_radians().cos();
        let v = |from: usize, to: usize| {
            let (f, t) = (&g.nodes[from], &g.nodes[to]);
            let dx = (t.lon - f.lon) * mx;
            let dy = (t.lat - f.lat) * 111_320.0;
            let len = (dx * dx + dy * dy).sqrt();
            [dx / len, dy / len]
        };
        // Incoming attach→stub and outgoing stub→mid should be parallel.
        let u = v(a, mid);
        let w = v(mid, b);
        let dot = (u[0] * w[0] + u[1] * w[1]).clamp(-1.0, 1.0);
        dot.acos().to_degrees()
    }

    /// Skeleton attach target(s) from a doorway group (stub or mid edges that
    /// leave the group). Empty if the door has no attach.
    fn doorway_attach_targets(g: &kiriko_route::RouteGraph, group: &[usize]) -> Vec<usize> {
        let mut out = Vec::new();
        for e in &g.edges {
            let (a, b) = (e.from as usize, e.to as usize);
            let (ga, gb) = (group.contains(&a), group.contains(&b));
            if ga == gb {
                continue;
            }
            out.push(if ga { b } else { a });
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    #[test]
    fn doorway_attach_splits_the_centerline_in_front_of_the_door() {
        // Wide E–W corridor; doorway on the south wall OFFSET from center so
        // the densified medial spine has no pre-existing node on the door
        // axis. Nearest-node attach would enter diagonally from a side node;
        // axis-ray split must insert a T-junction on the centerline directly
        // in front of the door. Approach attach→(stub?)→M is collinear.
        let walk = rect(139.70000, 35.60000, 0.00080, 0.00008); // ~72 m × 9 m
        // Door between densification samples on the south wall so the nearest
        // spine node sits ~0.15 m off-axis (half the ~0.36 m sample pitch).
        let door = line(139.7000665, 35.599960, 139.7001065, 35.599960);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        let onode = g
            .nodes
            .iter()
            .position(|n| [n.lon, n.lat] == dm)
            .expect("opening midpoint");
        let group = doorway_group(g, &door);
        assert!(group.len() >= 2, "mid + inside stub");

        // Passage axis is the wall normal (north): unit metre vector [0, 1].
        let axis = [0.0_f64, 1.0];

        let targets = doorway_attach_targets(g, &group);
        assert_eq!(targets.len(), 1, "one attach target: {targets:?}");
        let front_i = targets[0];
        let front_n = &g.nodes[front_i];
        let lat_off = lateral_offset_m(dm, axis, [front_n.lon, front_n.lat]);
        assert!(
            lat_off < 0.05,
            "split sits on the door axis, lateral offset {lat_off:.3} m (target lon={} lat={})",
            front_n.lon,
            front_n.lat
        );
        assert!(front_n.lat > dm[1], "split is north of the south-wall door");
        // T-junction: original spine edge became two, plus the attach.
        assert!(
            same_floor_degree(g, front_i) >= 3,
            "split node is a T-junction, degree={}",
            same_floor_degree(g, front_i)
        );
        // The two spine neighbors of the split (excluding the doorway attach)
        // must straddle the split lon — proves an edge was split.
        let spine_nbrs: Vec<usize> = g
            .edges
            .iter()
            .filter_map(|e| {
                let (a, b) = (e.from as usize, e.to as usize);
                if a == front_i && !group.contains(&b) {
                    Some(b)
                } else if b == front_i && !group.contains(&a) {
                    Some(a)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            spine_nbrs.len() >= 2,
            "split has ≥2 spine neighbors: {spine_nbrs:?}"
        );
        let lons: Vec<f64> = spine_nbrs.iter().map(|&i| g.nodes[i].lon).collect();
        let min_lon = lons.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_lon = lons.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!(
            min_lon < front_n.lon && max_lon > front_n.lon,
            "spine neighbors straddle the split (edge was split): lons={lons:?} split={}",
            front_n.lon
        );
        // Approach is collinear with the door axis: either attach→stub→M or
        // attach→M (when the junction is nearer than the stub).
        let approach_from = {
            // Find which group node the attach edge lands on.
            let mut from = None;
            for e in &g.edges {
                let (a, b) = (e.from as usize, e.to as usize);
                if a == front_i && group.contains(&b) {
                    from = Some(b);
                    break;
                }
                if b == front_i && group.contains(&a) {
                    from = Some(a);
                    break;
                }
            }
            from.expect("attach edge from group")
        };
        if approach_from == onode {
            // Direct mid attach: attach→M direction must align with axis.
            let bend = {
                let mx = 111_320.0 * dm[1].to_radians().cos();
                let dx = (front_n.lon - dm[0]) * mx;
                let dy = (front_n.lat - dm[1]) * 111_320.0;
                let len = (dx * dx + dy * dy).sqrt();
                let u = [dx / len, dy / len];
                let dot = (u[0] * axis[0] + u[1] * axis[1]).clamp(-1.0, 1.0);
                dot.acos().to_degrees()
            };
            assert!(bend < 5.0, "attach→M along door axis, bend={bend:.2}°");
        } else {
            let bend = approach_bend_deg(g, front_i, approach_from, onode);
            assert!(bend < 5.0, "attach→stub→M collinear, bend={bend:.2}°");
        }
    }

    #[test]
    fn doorway_attach_prefers_the_axis_ray_over_a_nearer_node() {
        // Same offset-door corridor. Nearest skeleton node is off to the side;
        // attach must terminate at the on-axis split, not that nearer node.
        let walk = rect(139.70000, 35.60000, 0.00080, 0.00008);
        let door = line(139.7000665, 35.599960, 139.7001065, 35.599960);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        let group = doorway_group(g, &door);
        let targets = doorway_attach_targets(g, &group);
        assert_eq!(targets.len(), 1, "one attach target: {targets:?}");
        let target = targets[0];
        let tn = &g.nodes[target];
        let off = lateral_offset_m(dm, [0.0, 1.0], [tn.lon, tn.lat]);
        assert!(
            off < 0.05,
            "attach target must be the on-axis split (offset {off:.3} m), got lon={} lat={}",
            tn.lon,
            tn.lat
        );
        assert!(
            same_floor_degree(g, target) >= 3,
            "split node is a T-junction, degree={}",
            same_floor_degree(g, target)
        );
        // Among OTHER non-group nodes, the nearest to M is off-axis — proves
        // the fixture would have preferred a wrong node under nearest-only.
        let mut nearest_other: Option<(f64, f64)> = None; // (dist, lat_off)
        for (i, n) in g.nodes.iter().enumerate() {
            if i == target || group.contains(&i) {
                continue;
            }
            let d = haversine_m(dm, [n.lon, n.lat]);
            if d > SNAP_MAX_M {
                continue;
            }
            let lo = lateral_offset_m(dm, [0.0, 1.0], [n.lon, n.lat]);
            if nearest_other.map(|(bd, _)| d < bd).unwrap_or(true) {
                nearest_other = Some((d, lo));
            }
        }
        let (nd, nlo) = nearest_other.expect("some other skeleton node in range");
        assert!(
            nlo > 0.10,
            "precondition: nearest non-split node is off-axis (dist={nd:.2} off={nlo:.3})"
        );
    }

    #[test]
    fn doorway_attach_falls_back_to_projection_when_the_ray_misses() {
        // Mid-corridor N–S gate across an E–W walkway. Passage axis is E–W —
        // collinear with the medial spine — so the axis ray is parallel to every
        // spine edge (determinant ≈ 0) and records no hit. Projection of M onto
        // the spine must still split at the exact perpendicular foot.
        //
        // Door lon is placed mid-way between densification samples (~0.36 m
        // pitch), so under nearest-node attach the target would be a sample
        // ~0.18 m off the foot; with the projection split it lands within 1 cm.
        let walk = rect(139.70000, 35.600002, 0.00040, 0.00010); // ~36 m × 11 m
        // Mid-sample lon: spine samples include 139.7 exactly; next is
        // ~139.70000408. Foot at 139.7000018 is ~0.16 m from 139.7.
        let door_lon = 139.7000018;
        let door = line(door_lon, 35.599995, door_lon, 35.600005);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let dm = linestring_midpoint(&door).unwrap();
        let group = doorway_group(g, &door);
        assert_eq!(group.len(), 3, "mid + both stubs");
        let targets = doorway_attach_targets(g, &group);
        assert_eq!(targets.len(), 1, "one attach target: {targets:?}");
        let target = targets[0];
        let tn = &g.nodes[target];
        // Exact perpendicular foot of M on the E–W spine (corridor center lat).
        let foot = [door_lon, 35.600002];
        let d_foot = haversine_m(foot, [tn.lon, tn.lat]);
        assert!(
            d_foot < 0.01,
            "attach target must be the projection foot within 1 cm (got {d_foot:.3} m at lon={} lat={}); \
             nearest-node attach lands ~0.16 m off on a densification sample",
            tn.lon,
            tn.lat
        );
        assert!(
            same_floor_degree(g, target) >= 3,
            "projection foot is a T-junction, degree={}",
            same_floor_degree(g, target)
        );
        // Spine neighbors straddle the foot along the corridor.
        let spine_nbrs: Vec<usize> = g
            .edges
            .iter()
            .filter_map(|e| {
                let (a, b) = (e.from as usize, e.to as usize);
                if a == target && !group.contains(&b) {
                    Some(b)
                } else if b == target && !group.contains(&a) {
                    Some(a)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            spine_nbrs.len() >= 2,
            "projection split has ≥2 spine neighbors: {spine_nbrs:?}"
        );
        let lons: Vec<f64> = spine_nbrs.iter().map(|&i| g.nodes[i].lon).collect();
        let min_lon = lons.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_lon = lons.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!(
            min_lon < tn.lon && max_lon > tn.lon,
            "spine neighbors straddle the projection foot: lons={lons:?} foot={}",
            tn.lon
        );
        let _ = dm;
    }

    #[test]
    fn doorway_attach_falls_back_to_the_nearest_node_when_blocked() {
        // Two platforms separated by a track strip. Door on platform B facing
        // A: ray/projection toward A would cross non-walkable track, so attach
        // must stay on B via nearest-node fallback. No edge crosses the gap.
        let features = vec![
            feature(
                "pa",
                FeatureType::Unit,
                "l0",
                Some("platform"),
                rect(139.70000, 35.60000, 0.00040, 0.00002),
            ),
            feature(
                "pb",
                FeatureType::Unit,
                "l0",
                Some("platform"),
                rect(139.70000, 35.60010, 0.00040, 0.00002),
            ),
            feature(
                "door",
                FeatureType::Opening,
                "l0",
                None,
                line(139.69998, 35.60009, 139.70002, 35.60009),
            ),
        ];
        let door = line(139.69998, 35.60009, 139.70002, 35.60009);
        let doc = document(&[("l0", 0.0)], features);
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        let cross_gap = g.edges.iter().any(|e| {
            let (a, b) = (&g.nodes[e.from as usize], &g.nodes[e.to as usize]);
            (a.lat - 35.60005) * (b.lat - 35.60005) < 0.0
        });
        assert!(!cross_gap, "no edge crosses the track strip");
        assert_eq!(component_count(g), 2, "platforms stay disconnected");
        // Door attaches on platform B only.
        let group = doorway_group(g, &door);
        assert!(!group.is_empty(), "doorway nodes exist on platform B");
        for &i in &group {
            assert!(
                g.nodes[i].lat > 35.60005,
                "doorway node stays on platform B"
            );
        }
        // Attach target(s) also stay on B — nearest-node fallback, no split
        // across the gap.
        for e in &g.edges {
            let (a, b) = (e.from as usize, e.to as usize);
            let (ga, gb) = (group.contains(&a), group.contains(&b));
            if ga == gb {
                continue;
            }
            let outside = if ga { b } else { a };
            assert!(
                g.nodes[outside].lat > 35.60005,
                "attach target stays on platform B"
            );
        }
    }

    #[test]
    fn centerline_split_keeps_components_and_creates_t_junction() {
        // A single walkway with one wall doorway: splitting the centerline
        // must (a) leave the floor as one component and (b) actually create a
        // genuine T-junction on the spine in front of the door — degree ≥ 3,
        // both spine arms longer than 0.1 m, lateral offset under 0.05 m.
        let walk = rect(139.70000, 35.60000, 0.00080, 0.00008);
        let door = line(139.7000665, 35.599960, 139.7001065, 35.599960);
        let doc = document(
            &[("l0", 0.0)],
            vec![
                feature("w", FeatureType::Unit, "l0", Some("walkway"), walk),
                feature("door", FeatureType::Opening, "l0", None, door.clone()),
            ],
        );
        let build = synthesize_network_medial(&doc);
        let g = &build.graph;
        assert_eq!(
            component_count(g),
            1,
            "splits add nodes, never connectivity"
        );
        let dm = linestring_midpoint(&door).unwrap();
        let group = doorway_group(g, &door);
        let axis = [0.0_f64, 1.0]; // south-wall threshold → north passage
        let mut found_split = false;
        for (i, n) in g.nodes.iter().enumerate() {
            if group.contains(&i) {
                continue;
            }
            if same_floor_degree(g, i) < 3 {
                continue;
            }
            let off = lateral_offset_m(dm, axis, [n.lon, n.lat]);
            if off >= 0.05 || n.lat <= dm[1] {
                continue;
            }
            // Two non-group neighbors at >0.1 m (spine arms, not a stub nibble).
            let mut arm_lens: Vec<f64> = Vec::new();
            for e in &g.edges {
                let (a, b) = (e.from as usize, e.to as usize);
                let other = if a == i {
                    b
                } else if b == i {
                    a
                } else {
                    continue;
                };
                if group.contains(&other) {
                    continue;
                }
                arm_lens.push(haversine_m(
                    [n.lon, n.lat],
                    [g.nodes[other].lon, g.nodes[other].lat],
                ));
            }
            let long_arms = arm_lens.iter().filter(|&&d| d > 0.1).count();
            if long_arms >= 2 {
                found_split = true;
                break;
            }
        }
        assert!(
            found_split,
            "expected an on-axis spine T-junction (deg≥3, two arms >0.1 m, lateral offset <0.05 m)"
        );

        // Two-blob doorway still yields exactly one component after splits.
        let door2 = line(139.70000, 35.600045, 139.70000, 35.600055);
        let doc2 = document(
            &[("l0", 0.0)],
            vec![
                feature(
                    "wa",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600025, 0.00040, 0.000045),
                ),
                feature(
                    "wb",
                    FeatureType::Unit,
                    "l0",
                    Some("walkway"),
                    rect(139.70000, 35.600075, 0.00040, 0.000045),
                ),
                feature("door", FeatureType::Opening, "l0", None, door2),
            ],
        );
        assert_eq!(
            component_count(&synthesize_network_medial(&doc2).graph),
            1,
            "two-blob doorway still one component after splits"
        );
    }

    #[test]
    fn multilinestring_axis_matches_the_midpoints_part() {
        // Two exactly equal-length parts (binary-exact 0.0625 lon spans at
        // the same latitude) with opposite orientations: midpoint and axis
        // must both come from the FIRST part (linestring_midpoint keeps the
        // first on ties; a last-wins axis pick flips the sign).
        let geom = Value::Object(BTreeMap::from([
            (
                "type".to_string(),
                Value::String("MultiLineString".to_string()),
            ),
            (
                "coordinates".to_string(),
                Value::Array(vec![
                    Value::Array(vec![
                        Value::Array(vec![Value::Number(139.0), Value::Number(35.0)]),
                        Value::Array(vec![Value::Number(139.0625), Value::Number(35.0)]),
                    ]),
                    Value::Array(vec![
                        Value::Array(vec![Value::Number(139.1875), Value::Number(35.0)]),
                        Value::Array(vec![Value::Number(139.125), Value::Number(35.0)]),
                    ]),
                ]),
            ),
        ]));
        let (mid, axis) = opening_axis(&geom).expect("axis parses");
        assert!(
            (mid[0] - 139.03125).abs() < 1e-9 && (mid[1] - 35.0).abs() < 1e-9,
            "midpoint from the first part: {mid:?}"
        );
        assert!(
            axis[0] > 0.99 && axis[1].abs() < 0.01,
            "axis along the first part (+lon): {axis:?}"
        );
    }

    /// Metre-offset coordinate helper for chord tests (lat 35.6).
    fn xy_at(cx: f64, cy: f64) -> impl Fn(f64, f64) -> [f64; 2] {
        let mx = 111_320.0 * cy.to_radians().cos();
        move |x_m: f64, y_m: f64| [cx + x_m / mx, cy + y_m / 111_320.0]
    }

    fn rect_poly(cx: f64, cy: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> Polygon<f64> {
        let xy = xy_at(cx, cy);
        Polygon::new(
            LineString::from(vec![
                (xy(x0, y0)[0], xy(x0, y0)[1]),
                (xy(x1, y0)[0], xy(x1, y0)[1]),
                (xy(x1, y1)[0], xy(x1, y1)[1]),
                (xy(x0, y1)[0], xy(x0, y1)[1]),
                (xy(x0, y0)[0], xy(x0, y0)[1]),
            ]),
            vec![],
        )
    }

    /// Union-find parent vec with `edges` unioned in (mirrors production,
    /// where `blob` is already unioned by skeleton/doorway/bridge passes).
    fn unioned_blob(n: usize, edges: &[(usize, usize)]) -> Vec<usize> {
        let mut blob: Vec<usize> = (0..n).collect();
        for &(a, b) in edges {
            let (ra, rb) = (uf_find(&mut blob, a), uf_find(&mut blob, b));
            if ra != rb {
                blob[ra] = rb;
            }
        }
        blob
    }

    #[test]
    fn chords_cut_a_detour_but_not_a_straight_spine() {
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        // Wide open hall: clearance at the y=0 chord is ~15 m (>> 5 m gate).
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -10.0, -50.0, 70.0, 15.0)]);
        // V-detour skeleton: A(0,0) → B(20,-30) → C(40,0) → D(60,0). The A–C
        // chord (40 m) beats the 72 m graph path by >15 m absolute and the
        // 0.7 ratio; everything else is adjacent or out of range.
        let detour = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(20.0, -30.0), xy(40.0, 0.0), xy(60.0, 0.0)],
            edges: vec![(0, 1), (1, 2), (2, 3)],
        };
        let blob = unioned_blob(4, &detour.edges);
        let chords = shortcut_chords(&detour, &blob, &area, &[]);
        assert_eq!(chords, vec![(0, 2)], "A–C chord cuts the V detour");

        let straight = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(20.0, 0.0), xy(40.0, 0.0)],
            edges: vec![(0, 1), (1, 2)],
        };
        let blob = unioned_blob(3, &straight.edges);
        assert!(
            shortcut_chords(&straight, &blob, &area, &[]).is_empty(),
            "straight spine gains no chords"
        );
    }

    #[test]
    fn chords_never_cross_a_hole() {
        // Same V detour in a wide-open hall (clearance and length would
        // otherwise qualify), but a non-walkable hole blocks the A–C chord —
        // rejected by passability, not by the open-space/length gates.
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let hole = LineString::from(vec![
            (xy(10.0, -5.0)[0], xy(10.0, -5.0)[1]),
            (xy(30.0, -5.0)[0], xy(30.0, -5.0)[1]),
            (xy(30.0, 4.0)[0], xy(30.0, 4.0)[1]),
            (xy(10.0, 4.0)[0], xy(10.0, 4.0)[1]),
            (xy(10.0, -5.0)[0], xy(10.0, -5.0)[1]),
        ]);
        let mut poly = rect_poly(cx, cy, -10.0, -50.0, 70.0, 15.0);
        poly.interiors_push(hole);
        let area = MultiPolygon::new(vec![poly]);
        let detour = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(20.0, -30.0), xy(40.0, 0.0)],
            edges: vec![(0, 1), (1, 2)],
        };
        let blob = unioned_blob(3, &detour.edges);
        assert!(
            shortcut_chords(&detour, &blob, &area, &[]).is_empty(),
            "the chord across the hole is rejected"
        );
    }

    #[test]
    fn zigzag_chain_gains_shortcut_chords_with_feedback() {
        // Ten-node zigzag chain zi = (10·i, −15·(i mod 2)) (≈18 m hops) in an
        // open hall (clearance ≫ 5 m). Two-hop chords (20 m vs 36 m graph,
        // absolute savings 16 m ≥ 15 m) all qualify; three- and four-hop
        // candidates become reachable through the chords already added (the
        // savings test sees them), so only the two-hop set lands. Per-node
        // cap 2 still admits every two-hop (each internal node is an endpoint
        // of exactly two such chords).
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -15.0, -30.0, 100.0, 15.0)]);
        let nodes: Vec<[f64; 2]> = (0..10)
            .map(|i| xy(10.0 * i as f64, -15.0 * (i % 2) as f64))
            .collect();
        let edges: Vec<(usize, usize)> = (0..9).map(|i| (i, i + 1)).collect();
        let skeleton = Skeleton { nodes, edges };
        let blob = unioned_blob(10, &skeleton.edges);
        let chords = shortcut_chords(&skeleton, &blob, &area, &[]);
        assert_eq!(
            chords,
            vec![
                (0, 2),
                (1, 3),
                (2, 4),
                (3, 5),
                (4, 6),
                (5, 7),
                (6, 8),
                (7, 9),
            ],
            "exact sorted chord set, feedback-aware"
        );
        // Determinism: same input, same chords.
        let again = shortcut_chords(&skeleton, &unioned_blob(10, &skeleton.edges), &area, &[]);
        assert_eq!(chords, again);
    }

    #[test]
    fn chords_do_not_reemit_an_existing_bridge() {
        // Two disconnected skeleton components whose blob roots are already
        // unified (as after near-blob bridging). The accepted bridge is
        // supplied as an existing local edge; the chord pass must see it in
        // adjacency and exclude the pair rather than re-emit it.
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -10.0, -15.0, 40.0, 15.0)]);
        // 12 m gap (> CHORD_MIN_M) so the bare pair clears the length gate.
        let skeleton = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(12.0, 0.0)],
            edges: vec![],
        };
        // Blob already unified as if the bridge was accepted.
        let blob = unioned_blob(2, &[(0, 1)]);
        let bridge_d = haversine_m(skeleton.nodes[0], skeleton.nodes[1]);
        assert!((10.0..CHORD_MAX_M).contains(&bridge_d));
        // Without the existing edge the pair would qualify (no graph path).
        let without = shortcut_chords(&skeleton, &blob, &area, &[]);
        assert_eq!(without, vec![(0, 1)], "precondition: bare pair is a chord");
        // With the bridge seeded, savings Dijkstra rejects the pair.
        let with = shortcut_chords(&skeleton, &blob, &area, &[(0, 1, bridge_d)]);
        assert!(
            with.is_empty(),
            "accepted bridge pair must not be re-emitted as a chord: {with:?}"
        );
    }

    #[test]
    fn chords_find_pairs_at_high_latitude_metre_buckets() {
        // At lat 60°, lon m/deg ≈ half of 111_320. Old degree-grid cells of
        // size CHORD_MAX_M/111_320 put a sub-40 m east-west pair two columns
        // apart when the pair straddles two cell boundaries, so the ±1
        // neighbor scan missed them. Local-metre buckets must still surface
        // the pair.
        let cy: f64 = 60.00000;
        let old_cell_deg = CHORD_MAX_M / 111_320.0;
        // Place A near the end of a degree-grid cell and C 1.1 cells east so
        // floor(lon/cell) differs by 2 while haversine stays well under 40 m
        // (≈ 22 m at lat 60°).
        let a_lon = (10.0_f64 / old_cell_deg).floor() * old_cell_deg + old_cell_deg * 0.95;
        let c_lon = a_lon + old_cell_deg * 1.1;
        let b_lon = (a_lon + c_lon) / 2.0;
        let a = [a_lon, cy];
        let b = [b_lon, cy - 30.0 / 111_320.0];
        let c = [c_lon, cy];
        // Wide open walkable rect covering the V (metre offsets around A).
        // Clearance at the y=0 chord is ~15 m.
        let area = MultiPolygon::new(vec![rect_poly(a_lon, cy, -10.0, -50.0, 50.0, 15.0)]);
        let detour = Skeleton {
            nodes: vec![a, b, c],
            edges: vec![(0, 1), (1, 2)],
        };
        let old_ax = (a[0] / old_cell_deg).floor() as i64;
        let old_cx = (c[0] / old_cell_deg).floor() as i64;
        assert!(
            (old_cx - old_ax).abs() >= 2,
            "precondition: old degree grid separates A–C by ≥2 lon cells ({old_ax} vs {old_cx})"
        );
        let d_ac = haversine_m(a, c);
        assert!(
            d_ac < CHORD_MAX_M,
            "precondition: A–C within chord range ({d_ac})"
        );
        // Graph path A–B–C is a deep V (~60 m+), so the chord qualifies under
        // both the ratio and absolute-savings gates.
        let d_ab = haversine_m(a, b);
        let d_bc = haversine_m(b, c);
        assert!(
            d_ab + d_bc > d_ac / CHORD_SAVINGS_RATIO && d_ab + d_bc > d_ac + 15.0,
            "precondition: detour beats both savings cutoffs"
        );

        let blob = unioned_blob(3, &detour.edges);
        let chords = shortcut_chords(&detour, &blob, &area, &[]);
        assert_eq!(
            chords,
            vec![(0, 2)],
            "metre-scale buckets must find the high-latitude A–C chord"
        );
    }

    #[test]
    fn chords_skip_doorway_only_unions() {
        // Two skeleton components joined only through a doorway (no skeleton
        // edge, no near-blob bridge). Nodes sit ~20 m apart in open space so
        // a straight chord is passable and would beat any missing graph path.
        // Production `blob` is already doorway-unified; chord eligibility
        // keeps the pre-doorway roots separate. The pair must NOT become a
        // chord (that would bypass the stub-mid-stub doorway approach).
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -10.0, -15.0, 40.0, 15.0)]);
        let skeleton = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(20.0, 0.0)],
            edges: vec![],
        };
        let d = haversine_m(skeleton.nodes[0], skeleton.nodes[1]);
        assert!(d < CHORD_MAX_M && d > 0.0);
        assert!(centerline_chord_passable(
            skeleton.nodes[0],
            skeleton.nodes[1],
            &area
        ));

        // Old final-blob input (doorway-unioned): pair looks same-component
        // and disconnected in chord adjacency → free chord.
        let door_unified = unioned_blob(2, &[(0, 1)]);
        assert_eq!(
            shortcut_chords(&skeleton, &door_unified, &area, &[]),
            vec![(0, 1)],
            "precondition: doorway-unified blob would accept the cross-door chord"
        );

        // Chord-eligibility UF (skeleton only — no doorway union): suppressed.
        let chord_eligible = unioned_blob(2, &[]);
        assert!(
            shortcut_chords(&skeleton, &chord_eligible, &area, &[]).is_empty(),
            "doorway-only unions must not make opposite-side nodes chord-eligible"
        );
    }

    #[test]
    fn chord_needs_open_space() {
        // Long zigzag inside a ~6 m wide corridor (half-width ~3 m < 5 m gate).
        // Ratio and absolute savings both pass on the A–Z chord; open-space
        // clearance must still reject it.
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        // Corridor: y ∈ [-3, 3] → clearance at y=0 is 3 m.
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -5.0, -3.0, 45.0, 3.0)]);
        // Zigzag every 4 m between y=±2.5 so the spine stays inside the
        // corridor while the graph path A(0,0)→…→Z(40,0) is ~64 m against a
        // 40 m chord (beats both 0.7× and +15 m savings).
        let mut nodes = vec![xy(0.0, 0.0)];
        let mut edges = Vec::new();
        let mut x = 4.0;
        let mut sign = 1.0_f64;
        while x < 40.0 {
            let i = nodes.len();
            nodes.push(xy(x, sign * 2.5));
            edges.push((i - 1, i));
            x += 4.0;
            sign = -sign;
        }
        let z = nodes.len();
        nodes.push(xy(40.0, 0.0));
        edges.push((z - 1, z));
        let detour = Skeleton { nodes, edges };
        let d_ac = haversine_m(detour.nodes[0], detour.nodes[z]);
        let mut d_path = 0.0;
        for &(a, b) in &detour.edges {
            d_path += haversine_m(detour.nodes[a], detour.nodes[b]);
        }
        assert!(d_ac >= 10.0, "precondition: chord length {d_ac}");
        assert!(
            d_path > d_ac / CHORD_SAVINGS_RATIO && d_path > d_ac + 15.0,
            "precondition: savings would pass without clearance gate (path={d_path}, c={d_ac})"
        );
        let blob = unioned_blob(detour.nodes.len(), &detour.edges);
        assert!(
            shortcut_chords(&detour, &blob, &area, &[]).is_empty(),
            "corridor clearance ~3 m must yield no chord"
        );
    }

    #[test]
    fn chord_needs_absolute_savings() {
        // Open hall: chord c ≈ 12 m, graph path ≈ 20 m. Ratio 12/20 = 0.6 < 0.7
        // would pass the old rule, but absolute savings 8 m < 15 m must reject.
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -10.0, -20.0, 40.0, 20.0)]);
        // A(0,0) → B(6,-8) → C(12,0): hops 10 m each, path 20 m, chord 12 m.
        let detour = Skeleton {
            nodes: vec![xy(0.0, 0.0), xy(6.0, -8.0), xy(12.0, 0.0)],
            edges: vec![(0, 1), (1, 2)],
        };
        let c = haversine_m(detour.nodes[0], detour.nodes[2]);
        let path = haversine_m(detour.nodes[0], detour.nodes[1])
            + haversine_m(detour.nodes[1], detour.nodes[2]);
        assert!((c - 12.0).abs() < 0.1, "chord ≈12 m, got {c}");
        assert!((path - 20.0).abs() < 0.1, "path ≈20 m, got {path}");
        assert!(
            c < path * CHORD_SAVINGS_RATIO,
            "precondition: ratio rule alone would accept (c={c}, path={path})"
        );
        assert!(path - c < 15.0, "precondition: absolute savings below 15 m");
        let blob = unioned_blob(3, &detour.edges);
        assert!(
            shortcut_chords(&detour, &blob, &area, &[]).is_empty(),
            "absolute-savings gate must reject a 8 m gain"
        );
    }

    #[test]
    fn chord_respects_per_node_cap() {
        // Hub H at the origin with three partners A,B,C. Each H–partner chord
        // qualifies on length, clearance, and savings via a deep south
        // junction J; only two chords may attach to H.
        let (cx, cy): (f64, f64) = (139.70000, 35.60000);
        let xy = xy_at(cx, cy);
        let area = MultiPolygon::new(vec![rect_poly(cx, cy, -40.0, -40.0, 40.0, 40.0)]);
        // Nodes: H(0,0), A(25,0), B(0,25), C(-25,0), J(0,-30)
        // Edges: H–J, J–A, J–B, J–C. Chords H–A/B/C beat H–J–partner (~55 m
        // vs ~25 m).
        let skeleton = Skeleton {
            nodes: vec![
                xy(0.0, 0.0),   // H = 0
                xy(25.0, 0.0),  // A = 1
                xy(0.0, 25.0),  // B = 2
                xy(-25.0, 0.0), // C = 3
                xy(0.0, -30.0), // J = 4
            ],
            edges: vec![(0, 4), (4, 1), (4, 2), (4, 3)],
        };
        let blob = unioned_blob(5, &skeleton.edges);
        // Precondition: without a cap, all three H–partner chords qualify.
        // (Implementation will cap at 2; this test asserts the cap.)
        let chords = shortcut_chords(&skeleton, &blob, &area, &[]);
        let hub_chords: Vec<_> = chords
            .iter()
            .filter(|&&(a, b)| a == 0 || b == 0)
            .copied()
            .collect();
        assert_eq!(
            hub_chords.len(),
            2,
            "hub gains exactly 2 chords, got {chords:?}"
        );
        // Deterministic: lowest partner indices win under sorted pair order.
        assert_eq!(hub_chords, vec![(0, 1), (0, 2)]);
    }
}
