//! Route-graph synthesis for venue datasets that carry no routing network.
//!
//! When an IMDF venue is compiled without `net_junction`/`net_path` GeoJSON,
//! [`synthesize_network`] derives a semantic connectivity graph directly from
//! the venue's own geometry: walkway and transit units become hubs, `opening`
//! doorways and shared unit boundaries stitch hubs together within a floor,
//! and transit units (elevator/escalator/stairs) are linked vertically by
//! footprint matching across adjacent floors. The result is a
//! [`kiriko_route::RouteGraphBuild`] — the same shape `build_route_graph`
//! produces from a real network — that the codec embeds as bundle section 5.
//!
//! The derivation is pure centroid / containment / boundary-proximity /
//! ordinal arithmetic; no external geometry engine is used.

// The centroid-hub synthesizer is the non-`netgen` fallback; under `netgen`
// the medial-axis synthesizer supersedes it, leaving these builders unused in
// that build (the shared geometry helpers are still used by both).
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};

use kiriko_model::canonical::Value;
use kiriko_model::model::FeatureType;
use kiriko_route::{RouteBuildWarning, RouteEdge, RouteGraph, RouteGraphBuild, RouteNode};

use crate::codec::BundleDocument;

const EARTH_RADIUS_M: f64 = 6_371_000.0;

/// Adjacency tolerance (metres): an opening links to a hub, and a transit hub
/// links to a neighbouring hub, when its point lies within this distance of
/// the hub polygon's boundary. First-pass value; widen if floors come out
/// under-connected.
const BOUNDARY_TOL_M: f64 = 3.0;
/// Maximum horizontal centroid distance (metres) for matching a transit unit
/// to the same-category transit unit on the next floor up.
const VERTICAL_MATCH_M: f64 = 5.0;
/// Maximum centroid-to-centroid length (metres) for a hub↔hub adjacency edge.
/// Two "adjacent" units whose centroids are farther apart than this are large
/// or fragmented multipolygons touching only at a distant vertex; linking their
/// centroids would inject a long straight "teleport" edge that corrupts routing
/// and renders as an obviously-wrong line. Such pairs are left to be joined by
/// openings instead.
const ADJACENCY_MAX_M: f64 = 30.0;

/// Extra metres-equivalent cost added to a vertical link by transit kind
/// (elevator cheapest, stairs dearest). Unknown kinds fall back to stairs.
fn floor_cost(category: &str) -> f64 {
    match category {
        "elevator" => 3.0,
        "escalator" => 4.0,
        _ => 5.0,
    }
}

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

/// Great-circle distance between two `[lon, lat]` positions in metres.
pub(crate) fn haversine_m(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (lat1, lat2) = (a[1].to_radians(), b[1].to_radians());
    let dlat = lat2 - lat1;
    let dlon = (b[0] - a[0]).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

/// Read a GeoJSON position (`[lon, lat, ...]`) as `[lon, lat]`.
fn coord_pair(v: &Value) -> Option<[f64; 2]> {
    let arr = v.as_array()?;
    Some([arr.first()?.as_f64()?, arr.get(1)?.as_f64()?])
}

/// Flatten a GeoJSON ring (array of positions) to `[lon, lat]` vertices,
/// dropping any non-position entries.
fn ring_coords(v: &Value) -> Vec<[f64; 2]> {
    match v.as_array() {
        Some(a) => a.iter().filter_map(coord_pair).collect(),
        None => Vec::new(),
    }
}

/// Total great-circle length of a polyline in metres.
fn polyline_length(verts: &[[f64; 2]]) -> f64 {
    verts.windows(2).map(|w| haversine_m(w[0], w[1])).sum()
}

/// Twice the absolute shoelace area of a ring (planar, in degree² units).
/// Used only to compare `MultiPolygon` parts, so the unit is irrelevant.
fn ring_area_abs(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut area2 = 0.0;
    for i in 0..n {
        let [x0, y0] = ring[i];
        let [x1, y1] = ring[(i + 1) % n];
        area2 += x0 * y1 - x1 * y0;
    }
    (area2 / 2.0).abs()
}

/// Area-weighted (shoelace) centroid of a polygon ring. A degenerate
/// (zero-area / collinear) ring falls back to the arithmetic mean of its
/// vertices.
pub(crate) fn ring_centroid(ring: &[[f64; 2]]) -> [f64; 2] {
    let n = ring.len();
    if n == 0 {
        return [0.0, 0.0];
    }
    // Work relative to the first vertex: absolute WGS84 coordinates (lon ~140)
    // otherwise lose precision in the shoelace products for the tiny (few-m²)
    // unit polygons this runs on — throwing the centroid kilometres off.
    let [ox, oy] = ring[0];
    let mut area2 = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..n {
        let [x0, y0] = ring[i];
        let [x1, y1] = ring[(i + 1) % n];
        let (x0, y0) = (x0 - ox, y0 - oy);
        let (x1, y1) = (x1 - ox, y1 - oy);
        let cross = x0 * y1 - x1 * y0;
        area2 += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    if area2.abs() < 1e-14 {
        let mut sx = 0.0;
        let mut sy = 0.0;
        for &[x, y] in ring {
            sx += x;
            sy += y;
        }
        return [sx / n as f64, sy / n as f64];
    }
    [ox + cx / (3.0 * area2), oy + cy / (3.0 * area2)]
}

/// Centroid of a `Polygon` (exterior ring) or `MultiPolygon` (largest-area
/// part's exterior ring). `None` for any other geometry or an empty ring.
pub(crate) fn polygon_centroid(geom: &Value) -> Option<[f64; 2]> {
    let obj = geom.as_object()?;
    let coords = obj.get("coordinates")?;
    match obj.get("type")?.as_str()? {
        "Polygon" => {
            let ext = ring_coords(coords.as_array()?.first()?);
            (!ext.is_empty()).then(|| ring_centroid(&ext))
        }
        "MultiPolygon" => {
            let mut best: Option<(f64, Vec<[f64; 2]>)> = None;
            for poly in coords.as_array()? {
                let Some(first) = poly.as_array().and_then(<[Value]>::first) else {
                    continue;
                };
                let ext = ring_coords(first);
                if ext.is_empty() {
                    continue;
                }
                let area = ring_area_abs(&ext);
                if best.as_ref().is_none_or(|(ba, _)| area > *ba) {
                    best = Some((area, ext));
                }
            }
            best.map(|(_, ext)| ring_centroid(&ext))
        }
        _ => None,
    }
}

/// Quantize a coordinate to a ~1 cm grid so units that share a boundary can be
/// matched by exact (snapped) vertices.
fn quantize(x: f64) -> i64 {
    (x * 1.0e7).round() as i64
}

/// Exterior-ring vertices of a `Polygon` (or every part of a `MultiPolygon`),
/// used to detect units that share a boundary. Empty for other geometry.
fn exterior_ring_vertices(geom: &Value) -> Vec<[f64; 2]> {
    let Some(obj) = geom.as_object() else { return Vec::new() };
    let Some(coords) = obj.get("coordinates") else { return Vec::new() };
    match obj.get("type").and_then(Value::as_str) {
        Some("Polygon") => coords
            .as_array()
            .and_then(<[Value]>::first)
            .map(ring_coords)
            .unwrap_or_default(),
        Some("MultiPolygon") => {
            let mut out = Vec::new();
            if let Some(polys) = coords.as_array() {
                for poly in polys {
                    if let Some(first) = poly.as_array().and_then(<[Value]>::first) {
                        out.extend(ring_coords(first));
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

/// Minimum distance (metres, equirectangular at `p`'s latitude) from `p` to
/// segment `a`–`b`.
pub(crate) fn point_seg_dist_m(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let m_per_deg_lat = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
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
    // Project the origin (p in local metres) onto the segment, clamped.
    let t = ((-pa[0] * dx - pa[1] * dy) / len2).clamp(0.0, 1.0);
    let cx = pa[0] + t * dx;
    let cy = pa[1] + t * dy;
    (cx * cx + cy * cy).sqrt()
}

fn accumulate_ring_dist(p: [f64; 2], ring: &[[f64; 2]], best: &mut f64) {
    for w in ring.windows(2) {
        let d = point_seg_dist_m(p, w[0], w[1]);
        if d < *best {
            *best = d;
        }
    }
}

/// Minimum distance (metres) from `p` to any edge of any ring (exterior +
/// holes) of a `Polygon`/`MultiPolygon`. `None` for non-polygon geometry.
pub(crate) fn point_boundary_dist_m(p: [f64; 2], geom: &Value) -> Option<f64> {
    let obj = geom.as_object()?;
    let coords = obj.get("coordinates")?;
    let mut best = f64::INFINITY;
    match obj.get("type")?.as_str()? {
        "Polygon" => {
            for r in coords.as_array()? {
                accumulate_ring_dist(p, &ring_coords(r), &mut best);
            }
        }
        "MultiPolygon" => {
            for poly in coords.as_array()? {
                let Some(rings) = poly.as_array() else { continue };
                for r in rings {
                    accumulate_ring_dist(p, &ring_coords(r), &mut best);
                }
            }
        }
        _ => return None,
    }
    best.is_finite().then_some(best)
}

/// For a `LineString`/`MultiLineString`, the vertex nearest the half-length
/// point along the polyline (`MultiLineString` uses its longest part).
/// Falls back to the first vertex; `None` for other geometry or no vertices.
pub(crate) fn linestring_midpoint(geom: &Value) -> Option<[f64; 2]> {
    let obj = geom.as_object()?;
    let coords = obj.get("coordinates")?;
    let verts: Vec<[f64; 2]> = match obj.get("type")?.as_str()? {
        "LineString" => ring_coords(coords),
        "MultiLineString" => {
            let mut best: Vec<[f64; 2]> = Vec::new();
            let mut best_len = -1.0;
            for part in coords.as_array()? {
                let vs = ring_coords(part);
                let len = polyline_length(&vs);
                if len > best_len {
                    best_len = len;
                    best = vs;
                }
            }
            best
        }
        _ => return None,
    };
    if verts.is_empty() {
        return None;
    }
    let total = polyline_length(&verts);
    if total <= 0.0 {
        return Some(verts[0]);
    }
    let target = total / 2.0;
    let mut acc = 0.0;
    let mut best_idx = 0;
    let mut best_diff = target; // vertex 0 sits at arc length 0.
    for i in 1..verts.len() {
        acc += haversine_m(verts[i - 1], verts[i]);
        let diff = (acc - target).abs();
        if diff < best_diff {
            best_diff = diff;
            best_idx = i;
        }
    }
    Some(verts[best_idx])
}

/// A node-bearing unit on one floor: a walkway or a transit unit. `transit`
/// carries the transit category (`None` for a walkway).
struct Hub<'a> {
    pt: [f64; 2],
    geom: &'a Value,
    transit: Option<&'a str>,
}

/// Kind tag used only to keep a level's node vector deterministically sorted.
enum Tag {
    Hub(usize),
    Opening(usize),
}

/// Synthesize a routing graph from a parsed venue model that carries no
/// network. Walkway and transit units become hubs joined within a floor by
/// shared `opening` doorways and shared unit boundaries; transit units are
/// matched vertically across adjacent floors. Returns the
/// graph (empty when nothing could be derived), non-fatal warnings, and a
/// `0..n` node-id mapping (there are no source NODEIDs).
pub fn synthesize_network(document: &BundleDocument) -> RouteGraphBuild {
    // level_id → ordinal; features referencing an unknown level are skipped.
    let level_ordinal: BTreeMap<&str, f64> = document
        .levels
        .iter()
        .map(|l| (l.id.as_str(), l.ordinal))
        .collect();

    // Ascending, de-duplicated ordinals — the floor-processing order.
    let mut ordinals: Vec<f64> = document.levels.iter().map(|l| l.ordinal).collect();
    ordinals.sort_by(f64::total_cmp);
    ordinals.dedup();

    let mut nodes: Vec<RouteNode> = Vec::new();
    let mut edges: Vec<RouteEdge> = Vec::new();
    let mut warnings: Vec<RouteBuildWarning> = Vec::new();
    // Transit nodes across every floor: (node index, centroid, category, ordinal).
    let mut transit_all: Vec<(u32, [f64; 2], String, f64)> = Vec::new();

    for &ord in &ordinals {
        // Node-bearing units on this floor: walkways and transit units. Each
        // gets a hub node at its centroid; `transit` tags the transit kind.
        let mut hubs: Vec<Hub<'_>> = Vec::new();
        let mut openings: Vec<[f64; 2]> = Vec::new();

        for f in &document.features {
            let Some(level_id) = f.level_id.as_deref() else { continue };
            if level_ordinal.get(level_id).copied() != Some(ord) {
                continue;
            }
            let Some(geom) = f.geometry.as_ref() else { continue };
            match f.feature_type {
                FeatureType::Unit => {
                    let Some(category) = f.category.as_deref() else { continue };
                    let transit = is_transit(category);
                    if (transit || is_walkway(category))
                        && let Some(pt) = polygon_centroid(geom)
                    {
                        hubs.push(Hub {
                            pt,
                            geom,
                            transit: transit.then_some(category),
                        });
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

        // Keep only openings adjacent to at least one hub; record adjacencies
        // (indices into `hubs`). Openings are the standard IMDF connectivity
        // signal, joining walkways and transit units through their doorways.
        let mut kept_openings: Vec<([f64; 2], Vec<usize>)> = Vec::new();
        for &op in &openings {
            let adj: Vec<usize> = hubs
                .iter()
                .enumerate()
                .filter(|(_, h)| {
                    point_boundary_dist_m(op, h.geom).is_some_and(|d| d <= BOUNDARY_TOL_M)
                })
                .map(|(i, _)| i)
                .collect();
            if adj.is_empty() {
                warnings.push(RouteBuildWarning {
                    code: "synth_opening_no_walkway".into(),
                    detail: format!(
                        "opening at ({:.6}, {:.6}) on ordinal {ord} has no adjacent hub",
                        op[0], op[1]
                    ),
                });
            } else {
                kept_openings.push((op, adj));
            }
        }

        // Assign global node indices in a deterministic (lon, lat, kind) order.
        let mut combined: Vec<([f64; 2], u8, Tag)> = Vec::new();
        for (i, h) in hubs.iter().enumerate() {
            combined.push((h.pt, 0, Tag::Hub(i)));
        }
        for (i, (pt, _)) in kept_openings.iter().enumerate() {
            combined.push((*pt, 1, Tag::Opening(i)));
        }
        combined.sort_by(|a, b| {
            a.0[0]
                .total_cmp(&b.0[0])
                .then(a.0[1].total_cmp(&b.0[1]))
                .then(a.1.cmp(&b.1))
        });

        let base = nodes.len() as u32;
        let mut hub_idx = vec![0u32; hubs.len()];
        let mut opening_idx = vec![0u32; kept_openings.len()];
        for (i, (pt, _, tag)) in combined.iter().enumerate() {
            let gidx = base + i as u32;
            nodes.push(RouteNode {
                lon: pt[0],
                lat: pt[1],
                ordinal: ord,
            });
            match tag {
                Tag::Hub(k) => hub_idx[*k] = gidx,
                Tag::Opening(k) => opening_idx[*k] = gidx,
            }
        }

        // Horizontal: each opening links to every adjacent hub.
        for (k, (op, adj)) in kept_openings.iter().enumerate() {
            for &h in adj {
                edges.push(RouteEdge {
                    from: opening_idx[k],
                    to: hub_idx[h],
                    weight: haversine_m(*op, hubs[h].pt) as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
            }
        }

        // Horizontal: link two hubs that share a boundary. Openings model door
        // portals; this captures walkable adjacency between units that abut
        // without a modelled door — chiefly tiled walkway polygons that would
        // otherwise fragment a floor. Each pair is linked at most once.
        let mut linked: HashSet<(u32, u32)> = HashSet::new();

        // (a) Shared-boundary adjacency: two hubs sharing >=2 snapped exterior
        //     vertices abut along an edge and are mutually walkable.
        let mut vertex_hubs: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for (i, h) in hubs.iter().enumerate() {
            let mut seen: HashSet<(i64, i64)> = HashSet::new();
            for v in exterior_ring_vertices(h.geom) {
                let key = (quantize(v[0]), quantize(v[1]));
                if seen.insert(key) {
                    vertex_hubs.entry(key).or_default().push(i);
                }
            }
        }
        let mut shared: HashMap<(usize, usize), u32> = HashMap::new();
        for owners in vertex_hubs.values() {
            for a in 0..owners.len() {
                for b in (a + 1)..owners.len() {
                    let key = (owners[a].min(owners[b]), owners[a].max(owners[b]));
                    *shared.entry(key).or_default() += 1;
                }
            }
        }
        for (&(i, j), &count) in &shared {
            if count < 2 {
                continue;
            }
            let weight = haversine_m(hubs[i].pt, hubs[j].pt);
            if weight > ADJACENCY_MAX_M {
                continue;
            }
            let (a, b) = (hub_idx[i].min(hub_idx[j]), hub_idx[i].max(hub_idx[j]));
            if a != b && linked.insert((a, b)) {
                edges.push(RouteEdge {
                    from: a,
                    to: b,
                    weight: weight as f32,
                    ordinal: ord,
                    interior: Vec::new(),
                });
            }
        }

        // (b) Transit fallback: a transit unit's small footprint sitting within
        //     tolerance of another hub's boundary joins it even when the two do
        //     not share snapped vertices.
        for (i, h) in hubs.iter().enumerate() {
            if h.transit.is_none() {
                continue;
            }
            for (j, other) in hubs.iter().enumerate() {
                if i == j {
                    continue;
                }
                let weight = haversine_m(h.pt, other.pt);
                if weight <= ADJACENCY_MAX_M
                    && point_boundary_dist_m(h.pt, other.geom).is_some_and(|d| d <= BOUNDARY_TOL_M)
                {
                    let (a, b) = (hub_idx[i].min(hub_idx[j]), hub_idx[i].max(hub_idx[j]));
                    if a != b && linked.insert((a, b)) {
                        edges.push(RouteEdge {
                            from: a,
                            to: b,
                            weight: weight as f32,
                            ordinal: ord,
                            interior: Vec::new(),
                        });
                    }
                }
            }
        }

        // Record transit hubs for the vertical-linking pass.
        for (i, h) in hubs.iter().enumerate() {
            if let Some(category) = h.transit {
                transit_all.push((hub_idx[i], h.pt, category.to_string(), ord));
            }
        }
    }

    // Vertical: match each transit node to the nearest same-category node on
    // the next consecutive ordinal. Iterate in node-index order for stability.
    transit_all.sort_by(|a, b| a.0.cmp(&b.0));
    let next_ordinal = |ord: f64| -> Option<f64> {
        let pos = ordinals.iter().position(|&o| o == ord)?;
        ordinals.get(pos + 1).copied()
    };
    for &(idx, pt, ref category, ord) in &transit_all {
        // Top floor (no ordinal above) has nothing to match: not a warning.
        let Some(next) = next_ordinal(ord) else { continue };
        let mut best: Option<(u32, f64)> = None;
        for &(cidx, cpt, ref ccat, cord) in &transit_all {
            if cord != next || ccat != category {
                continue;
            }
            let d = haversine_m(pt, cpt);
            if d <= VERTICAL_MATCH_M
                && best.is_none_or(|(bidx, bd)| d < bd || (d == bd && cidx < bidx))
            {
                best = Some((cidx, d));
            }
        }
        match best {
            Some((cidx, d)) => edges.push(RouteEdge {
                from: idx,
                to: cidx,
                weight: (d + floor_cost(category)) as f32,
                ordinal: ord,
                interior: Vec::new(),
            }),
            None => warnings.push(RouteBuildWarning {
                code: "synth_transit_no_link".into(),
                detail: format!(
                    "transit node {idx} ({category}) on ordinal {ord} has no match on ordinal {next}"
                ),
            }),
        }
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
    use crate::codec::{BundleMetadata, BundleStats};
    use kiriko_model::model::{ImdfManifest, VenueFeature, ViewerLevel};

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

    fn polygon(ring: &[[f64; 2]]) -> Value {
        let ring_val = Value::Array(ring.iter().map(|p| position(p[0], p[1])).collect());
        geo("Polygon", Value::Array(vec![ring_val]))
    }

    fn linestring(pts: &[[f64; 2]]) -> Value {
        geo(
            "LineString",
            Value::Array(pts.iter().map(|p| position(p[0], p[1])).collect()),
        )
    }

    /// Axis-aligned closed square ring of side `s` centered at `(cx, cy)`.
    fn square(cx: f64, cy: f64, s: f64) -> Vec<[f64; 2]> {
        let h = s / 2.0;
        vec![
            [cx - h, cy - h],
            [cx + h, cy - h],
            [cx + h, cy + h],
            [cx - h, cy + h],
            [cx - h, cy - h],
        ]
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

    fn document(levels: &[(&str, f64)], features: Vec<VenueFeature>) -> BundleDocument {
        BundleDocument {
            metadata: BundleMetadata {
                dataset_id: "t/v".to_string(),
                version: 1,
            },
            manifest: ImdfManifest {
                version: "1.0.0".to_string(),
                language: "en".to_string(),
                rest: BTreeMap::new(),
            },
            venue_id: "v".to_string(),
            levels: levels
                .iter()
                .map(|(id, ordinal)| ViewerLevel {
                    id: (*id).to_string(),
                    ordinal: *ordinal,
                    label: BTreeMap::new(),
                    short_name: BTreeMap::new(),
                })
                .collect(),
            features,
            bounds_by_level: BTreeMap::new(),
            warnings: Vec::new(),
            stats: BundleStats {
                levels: 0,
                features: 0,
            },
            graph: None,
            facilities: None,
        }
    }

    #[test]
    fn polygon_centroid_of_unit_square() {
        let poly = polygon(&[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [0.0, 0.0]]);
        let c = polygon_centroid(&poly).unwrap();
        assert!((c[0] - 1.0).abs() < 1e-9, "cx = {}", c[0]);
        assert!((c[1] - 1.0).abs() < 1e-9, "cy = {}", c[1]);
    }

    #[test]
    fn point_on_segment_has_zero_distance_and_offset_matches_metres() {
        // On the segment → ~0.
        let on = point_seg_dist_m([0.0005, 0.0], [0.0, 0.0], [0.001, 0.0]);
        assert!(on < 1e-6, "on-segment distance = {on}");
        // 0.0001° north of the segment ≈ 11.12 m (equirectangular).
        let off = point_seg_dist_m([0.0005, 0.0001], [0.0, 0.0], [0.001, 0.0]);
        assert!((off - 11.12).abs() < 0.1, "off-segment distance = {off}");
    }

    #[test]
    fn midpoint_of_three_vertex_line_is_middle_vertex() {
        let line = linestring(&[[0.0, 0.0], [0.0, 0.001], [0.0, 0.002]]);
        let m = linestring_midpoint(&line).unwrap();
        assert_eq!(m, [0.0, 0.001]);
    }

    #[test]
    fn opening_connects_two_walkways_and_rooms_are_not_nodes() {
        // Walkway square east of x=0; rooms (ignored) west; opening on x=0 edge.
        let features = vec![
            feature("room-a", FeatureType::Unit, "L0", Some("room"), polygon(&square(-0.0005, 0.0005, 0.0009))),
            feature("room-b", FeatureType::Unit, "L0", Some("room"), polygon(&square(0.0005, 0.0015, 0.0009))),
            feature("walk", FeatureType::Unit, "L0", Some("walkway"), polygon(&square(0.0005, 0.0005, 0.001))),
            feature(
                "op",
                FeatureType::Opening,
                "L0",
                None,
                linestring(&[[0.0, 0.0003], [0.0, 0.0005], [0.0, 0.0007]]),
            ),
        ];
        let build = synthesize_network(&document(&[("L0", 0.0)], features));
        // Only the walkway hub and the opening are nodes (rooms excluded).
        assert_eq!(build.graph.nodes.len(), 2, "nodes = {:?}", build.graph.nodes);
        assert_eq!(build.graph.edges.len(), 1, "edges = {:?}", build.graph.edges);
        let e = &build.graph.edges[0];
        assert!((e.from, e.to) == (0, 1) || (e.from, e.to) == (1, 0));
        assert_eq!(e.ordinal, 0.0);
        assert!(e.weight > 0.0);
        assert!(build.warnings.is_empty(), "warnings = {:?}", build.warnings);
        assert_eq!(build.node_ids, vec![0, 1]);
    }

    #[test]
    fn stairs_stacked_across_floors_get_a_vertical_edge() {
        let features = vec![
            feature("s0", FeatureType::Unit, "L0", Some("stairs"), polygon(&square(0.001, 0.001, 0.0004))),
            feature("s1", FeatureType::Unit, "L1", Some("stairs"), polygon(&square(0.001, 0.001, 0.0004))),
        ];
        let build = synthesize_network(&document(&[("L0", 0.0), ("L1", 1.0)], features));
        assert_eq!(build.graph.nodes.len(), 2);
        assert_eq!(build.graph.edges.len(), 1, "edges = {:?}", build.graph.edges);
        let e = &build.graph.edges[0];
        // Coincident footprints → vertical weight ≈ stairs floor cost (5.0).
        assert!((e.weight - 5.0).abs() < 1e-3, "weight = {}", e.weight);
        assert_eq!(e.ordinal, 0.0);
    }

    #[test]
    fn opening_with_no_walkway_is_dropped_with_a_warning() {
        let features = vec![
            feature("walk", FeatureType::Unit, "L0", Some("walkway"), polygon(&square(0.0, 0.0, 0.001))),
            feature("op", FeatureType::Opening, "L0", None, linestring(&[[1.0, 1.0], [1.0, 1.001]])),
        ];
        let build = synthesize_network(&document(&[("L0", 0.0)], features));
        assert_eq!(build.graph.nodes.len(), 1, "only the walkway hub is a node");
        assert!(build.graph.edges.is_empty());
        assert_eq!(build.warnings.len(), 1);
        assert_eq!(build.warnings[0].code, "synth_opening_no_walkway");
    }

    #[test]
    fn synthesis_is_deterministic() {
        let build_doc = || {
            document(
                &[("L0", 0.0), ("L1", 1.0)],
                vec![
                    feature("walk0", FeatureType::Unit, "L0", Some("walkway"), polygon(&square(0.0005, 0.0005, 0.001))),
                    feature("op0", FeatureType::Opening, "L0", None, linestring(&[[0.0, 0.0004], [0.0, 0.0006]])),
                    feature("st0", FeatureType::Unit, "L0", Some("stairs"), polygon(&square(0.001, 0.001, 0.0004))),
                    feature("st1", FeatureType::Unit, "L1", Some("stairs"), polygon(&square(0.001, 0.001, 0.0004))),
                ],
            )
        };
        let a = synthesize_network(&build_doc());
        let b = synthesize_network(&build_doc());
        assert_eq!(a.graph, b.graph);
        assert_eq!(a.node_ids, b.node_ids);
    }
}
