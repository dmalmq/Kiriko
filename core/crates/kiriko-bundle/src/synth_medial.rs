//! Medial-axis routing-network synthesis (server-only, `netgen` feature).
//!
//! ArcGIS-Indoors-style pipeline producing real corridor centerlines:
//!   1. per floor, union walkable units into a navigable area (obstacle
//!      subtraction is available via `navigable_area` but currently unused);
//!   2. constrained-Delaunay-triangulate the navigable polygon and extract its
//!      medial axis (Chin–Snoeyink–Wang) as centerlines;
//!   3. build a graph from the centerlines, snap doorway `opening`s and transit
//!      units as junctions, bridge near-touching blobs, and stitch floors
//!      vertically (footprint overlap or centroid proximity), attaching costs.
//!
//! Gated behind `netgen` so the browser wasm build never pulls in `geo`/`spade`.

use geo::algorithm::bool_ops::BooleanOps;
use geo::algorithm::orient::{Direction, Orient};
use geo::{Coord, LineString, MultiPolygon, Polygon};
use geo::algorithm::contains::Contains;
use geo::algorithm::area::Area;
use geo::algorithm::intersects::Intersects;
use geo::Point;
use spade::{ConstrainedDelaunayTriangulation, Point2, Triangulation};
use std::collections::HashMap;

use kiriko_model::canonical::Value;
use crate::codec::BundleDocument;
use crate::synth::{haversine_m, linestring_midpoint, polygon_centroid};
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
        let centroid = [
            (a[0] + b[0] + c[0]) / 3.0,
            (a[1] + b[1] + c[1]) / 3.0,
        ];
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

fn is_walkway(category: &str) -> bool {
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
            | "unenclosedarea"
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
        .map(|p| ring_perimeter(p.exterior()) + p.interiors().iter().map(ring_perimeter).sum::<f64>())
        .sum();
    if perimeter <= 0.0 || budget == 0 {
        return Some(BASE_SPACING_DEG);
    }
    Some((perimeter / budget as f64).max(BASE_SPACING_DEG))
}

/// Nearest node in `nodes[range]` to `p` within `max_m` metres.
fn nearest_node(
    nodes: &[RouteNode],
    range: std::ops::Range<usize>,
    p: [f64; 2],
    max_m: f64,
) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for i in range {
        let d = haversine_m([nodes[i].lon, nodes[i].lat], p);
        if d <= max_m && best.is_none_or(|(_, bd)| d < bd) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

/// Union-find root with path compression (over a `parent` slice).
fn uf_find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
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
    let mut transit_all: Vec<(u32, [f64; 2], String, f64, Option<Polygon<f64>>)> = Vec::new();

    for &ord in &ordinals {
        let mut walk: Vec<&Value> = Vec::new();
        let mut openings: Vec<[f64; 2]> = Vec::new();
        let mut transit: Vec<([f64; 2], String, Option<Polygon<f64>>)> = Vec::new();
        for f in &document.features {
            let Some(level_id) = f.level_id.as_deref() else { continue };
            if level_ordinal.get(level_id).copied() != Some(ord) {
                continue;
            }
            let Some(geom) = f.geometry.as_ref() else { continue };
            match f.feature_type {
                FeatureType::Unit => {
                    let Some(category) = f.category.as_deref() else { continue };
                    if is_walkway(category) {
                        walk.push(geom);
                    } else if is_transit(category) {
                        if let Some(c) = polygon_centroid(geom) {
                            transit.push((c, category.to_string(), largest_polygon(geom)));
                        }
                    }
                }
                FeatureType::Opening => {
                    if let Some(m) = linestring_midpoint(geom) {
                        openings.push(m);
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

        // Centerline nodes + edges for this floor; union-find over the skeleton
        // marks disjoint walkable blobs so doorways can bridge them below.
        let mut blob: Vec<usize> = (0..skeleton.nodes.len()).collect();
        for &(a, b) in &skeleton.edges {
            let (ra, rb) = (uf_find(&mut blob, a), uf_find(&mut blob, b));
            if ra != rb {
                blob[ra] = rb;
            }
        }
        let base = nodes.len();
        for n in &skeleton.nodes {
            nodes.push(RouteNode { lon: n[0], lat: n[1], ordinal: ord });
        }
        for &(a, b) in &skeleton.edges {
            let (i, j) = (base + a, base + b);
            edges.push(RouteEdge {
                from: i as u32,
                to: j as u32,
                weight: haversine_m([nodes[i].lon, nodes[i].lat], [nodes[j].lon, nodes[j].lat]) as f32,
                ordinal: ord,
                interior: Vec::new(),
            });
        }
        let skeleton_range = base..nodes.len();

        // Doorways: bridge each opening to the nearest centerline node of every
        // distinct blob within range, merging areas that share the doorway.
        for op in &openings {
            let mut per_blob: HashMap<usize, (usize, f64)> = HashMap::new();
            for (local, n) in skeleton.nodes.iter().enumerate() {
                let d = haversine_m(*n, *op);
                if d <= SNAP_MAX_M {
                    let root = uf_find(&mut blob, local);
                    let entry = per_blob.entry(root).or_insert((local, d));
                    if d < entry.1 {
                        *entry = (local, d);
                    }
                }
            }
            if per_blob.is_empty() {
                warnings.push(RouteBuildWarning {
                    code: "synth_opening_no_walkway".into(),
                    detail: format!(
                        "opening ({:.6}, {:.6}) on ordinal {ord} is >{SNAP_MAX_M} m from any centerline",
                        op[0], op[1]
                    ),
                });
                continue;
            }
            let idx = nodes.len();
            nodes.push(RouteNode { lon: op[0], lat: op[1], ordinal: ord });
            for (_root, (local, d)) in per_blob {
                edges.push(RouteEdge {
                    from: idx as u32,
                    to: (base + local) as u32,
                    weight: d as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
            }
        }

        // Near-blob bridging: fuse distinct blobs that abut without a doorway.
        // Bucket skeleton nodes on an ~ADJACENCY_BRIDGE_M grid, then keep the
        // single closest cross-blob node pair per (root_a, root_b).
        let cell_deg = ADJACENCY_BRIDGE_M / 111_320.0;
        let cell = |p: [f64; 2]| ((p[0] / cell_deg).floor() as i64, (p[1] / cell_deg).floor() as i64);
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
                    let Some(cands) = buckets.get(&(cx + dx, cy + dy)) else { continue };
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
        for key in keys {
            let (li, lj, d) = bridges[&key];
            if uf_find(&mut blob, li) == uf_find(&mut blob, lj) {
                continue;
            }
            let (ra, rb) = (uf_find(&mut blob, li), uf_find(&mut blob, lj));
            blob[ra] = rb;
            edges.push(RouteEdge {
                from: (base + li) as u32,
                to: (base + lj) as u32,
                weight: d as f32,
                ordinal: ord,
                interior: Vec::new(),
            });
        }

        // Transit units: snap onto the centerline and record for vertical links.
        for (tp, category, footprint) in &transit {
            let idx = nodes.len();
            nodes.push(RouteNode { lon: tp[0], lat: tp[1], ordinal: ord });
            if let Some(near) = nearest_node(&nodes, skeleton_range.clone(), *tp, SNAP_MAX_M) {
                edges.push(RouteEdge {
                    from: idx as u32,
                    to: near as u32,
                    weight: haversine_m(*tp, [nodes[near].lon, nodes[near].lat]) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
            }
            transit_all.push((idx as u32, *tp, category.clone(), ord, footprint.clone()));
        }
    }

    // Vertical transitions: match each transit unit to the nearest same-kind
    // unit on the next consecutive floor.
    transit_all.sort_by(|a, b| a.0.cmp(&b.0));
    let next_ordinal = |o: f64| -> Option<f64> {
        let pos = ordinals.iter().position(|&x| x == o)?;
        ordinals.get(pos + 1).copied()
    };
    for (idx, pt, category, ord, footprint) in transit_all.iter() {
        let Some(next) = next_ordinal(*ord) else { continue };
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

    edges.sort_by(|a, b| (a.from, a.to, a.weight.to_bits()).cmp(&(b.from, b.to, b.weight.to_bits())));
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
        assert_eq!(nav.0.len(), 1, "overlapping walkables merge into one polygon");
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
            LineString::from(vec![(0.0, 0.0), (10.0, 0.0), (10.0, 2.0), (0.0, 2.0), (0.0, 0.0)]),
            vec![],
        )]);
        let skeleton = medial_axis(&rect, 0.5);
        assert!(!skeleton.nodes.is_empty(), "skeleton has nodes");
        assert!(!skeleton.edges.is_empty(), "skeleton has edges");
        let xs: Vec<f64> = skeleton.nodes.iter().map(|n| n[0]).collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!(max_x - min_x > 6.0, "spine spans the length: {min_x}..{max_x}");
        // Every skeleton node lies inside the rectangle.
        for n in &skeleton.nodes {
            assert!(n[0] >= -0.01 && n[0] <= 10.01 && n[1] >= -0.01 && n[1] <= 2.01, "node {n:?} in bounds");
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
            metadata: crate::codec::BundleMetadata { dataset_id: "t/v".into(), version: 1 },
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
            stats: crate::codec::BundleStats { levels: 0, features: 0 },
            graph: None,
            facilities: None,
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
            let (a, b) = (find(&mut parent, e.from as usize), find(&mut parent, e.to as usize));
            if a != b {
                parent[a] = b;
            }
        }
        (0..n).filter(|&i| find(&mut parent, i) == i).count()
    }

    #[test]
    fn near_blobs_bridge_into_one_component() {
        // Two thin walkway rectangles with parallel spines ~1.5 m apart and NO
        // opening between them: they must fuse into a single component.
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
        assert_eq!(component_count(&build.graph), 1, "near blobs fuse into one component");
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
        // Floor 0: two thin walkways joined by a doorway; a stairs unit on the
        // first walkway stacks onto floor 1's walkway. The whole graph is ONE
        // component, spans both floors, and every edge is a short indoor hop.
        let features = vec![
            feature("wa", FeatureType::Unit, "l0", Some("walkway"),
                rect(139.70000, 35.60000, 0.00040, 0.00002)),
            feature("wb", FeatureType::Unit, "l0", Some("walkway"),
                rect(139.70050, 35.60000, 0.00040, 0.00002)),
            feature("door", FeatureType::Opening, "l0", None,
                line(139.70025, 35.60000, 139.70025, 35.60002)),
            feature("s0", FeatureType::Unit, "l0", Some("stairs"),
                rect(139.70000, 35.60000, 0.00006, 0.00001)),
            feature("w1", FeatureType::Unit, "l1", Some("walkway"),
                rect(139.70000, 35.60000, 0.00040, 0.00002)),
            feature("s1", FeatureType::Unit, "l1", Some("stairs"),
                rect(139.70000, 35.60000, 0.00006, 0.00001)),
        ];
        let doc = document(&[("l0", 0.0), ("l1", 1.0)], features);
        let build = synthesize_network_medial(&doc);
        assert_eq!(component_count(&build.graph), 1, "one connected component");
        let ordinals: std::collections::BTreeSet<i64> =
            build.graph.nodes.iter().map(|n| n.ordinal as i64).collect();
        assert_eq!(ordinals.len(), 2, "both floors present");
        let max_edge = build.graph.edges.iter().fold(0.0_f32, |m, e| m.max(e.weight));
        assert!(max_edge <= 30_000.0, "no teleport edges: max {max_edge} cost units (30 m)");

        // Determinism: identical input → identical graph.
        let again = synthesize_network_medial(&doc);
        assert_eq!(build.graph, again.graph, "synthesis is deterministic");
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
        assert!(!build.graph.nodes.is_empty(), "platform is walkable → non-empty graph");
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
        assert!(build.graph.nodes.is_empty(), "non-walkable rooms → empty graph");
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
            ("coordinates".to_string(), Value::Array(vec![Value::Array(pts)])),
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
        assert!(!build.graph.nodes.is_empty(), "in-budget floor still synthesizes");
        assert_eq!(ords, std::collections::BTreeSet::from([1]), "only L1 is synthesized");

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
        assert!(skip.detail.contains('0'), "warning carries the ordinal: {}", skip.detail);
    }

    #[test]
    fn choose_spacing_rejects_over_budget_original_vertices() {
        let dense = navigable_area(
            &[&regular_polygon(139.70, 35.69, 0.0002, MAX_CDT_VERTS + 5)],
            &[],
        );
        let orig = original_vertex_count(&dense);
        assert!(orig > MAX_CDT_VERTS, "original count {orig} exceeds ceiling");
        assert!(choose_spacing(&dense, orig).is_none(), "over-budget floor is rejected");
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
        assert!(spacing >= BASE_SPACING_DEG, "spacing never below base: {spacing}");
        let densified: usize =
            big.iter().map(|p| densify_ring(p.exterior(), spacing).len()).sum();
        assert!(densified <= MAX_CDT_VERTS, "densified {densified} stays under ceiling");

        // A small area keeps the fine base spacing.
        let small = navigable_area(&[&square(139.70, 35.69, 0.0004)], &[]);
        let so = original_vertex_count(&small);
        assert_eq!(choose_spacing(&small, so), Some(BASE_SPACING_DEG));
    }
}
