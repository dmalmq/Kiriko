//! Diagnostic: run medial-axis network synthesis over a real IMDF archive and
//! report how doorway `opening`s and transit units (elevator/escalator/stairs)
//! attach to the centerline graph.
//!
//! ```bash
//! cargo run --manifest-path core/Cargo.toml -p kiriko-bundle --features netgen \
//!   --example analyze_synth -- path/to/venue.imdf.zip
//! ```

use std::collections::BTreeMap;
use std::fs;

use kiriko_bundle::{BundleMetadata, compile_imdf_with_network, decode_bundle};
use kiriko_model::canonical::Value;
use kiriko_model::model::FeatureType;

const EARTH_RADIUS_M: f64 = 6_371_008.8;

fn haversine_m(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (lat1, lat2) = (a[1].to_radians(), b[1].to_radians());
    let dlat = lat2 - lat1;
    let dlon = (b[0] - a[0]).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

fn coord_pair(v: &Value) -> Option<[f64; 2]> {
    let arr = v.as_array()?;
    Some([arr.first()?.as_f64()?, arr.get(1)?.as_f64()?])
}

fn ring_coords(v: &Value) -> Vec<[f64; 2]> {
    match v.as_array() {
        Some(a) => a.iter().filter_map(coord_pair).collect(),
        None => Vec::new(),
    }
}

/// All rings (exteriors + holes) of a Polygon/MultiPolygon.
fn all_rings(geom: &Value) -> Vec<Vec<[f64; 2]>> {
    let Some(obj) = geom.as_object() else {
        return Vec::new();
    };
    let Some(coords) = obj.get("coordinates") else {
        return Vec::new();
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("Polygon") => coords
            .as_array()
            .map(|a| a.iter().map(ring_coords).collect())
            .unwrap_or_default(),
        Some("MultiPolygon") => {
            let mut out = Vec::new();
            if let Some(polys) = coords.as_array() {
                for p in polys {
                    if let Some(rings) = p.as_array() {
                        out.extend(rings.iter().map(ring_coords));
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

fn point_seg_dist_m(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
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
    let t = ((-pa[0] * dx - pa[1] * dy) / len2).clamp(0.0, 1.0);
    let cx = pa[0] + t * dx;
    let cy = pa[1] + t * dy;
    (cx * cx + cy * cy).sqrt()
}

fn point_boundary_dist_m(p: [f64; 2], geom: &Value) -> f64 {
    let mut best = f64::INFINITY;
    for ring in all_rings(geom) {
        for w in ring.windows(2) {
            let d = point_seg_dist_m(p, w[0], w[1]);
            if d < best {
                best = d;
            }
        }
    }
    best
}

fn ring_centroid(ring: &[[f64; 2]]) -> [f64; 2] {
    let n = ring.len();
    if n == 0 {
        return [0.0, 0.0];
    }
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
        let (sx, sy) = ring
            .iter()
            .fold((0.0, 0.0), |(sx, sy), &[x, y]| (sx + x, sy + y));
        return [sx / n as f64, sy / n as f64];
    }
    [ox + cx / (3.0 * area2), oy + cy / (3.0 * area2)]
}

fn polygon_centroid(geom: &Value) -> Option<[f64; 2]> {
    let rings = all_rings(geom);
    rings
        .first()
        .filter(|r| !r.is_empty())
        .map(|r| ring_centroid(r))
}

fn linestring_midpoint(geom: &Value) -> Option<[f64; 2]> {
    let obj = geom.as_object()?;
    let coords = obj.get("coordinates")?;
    let verts: Vec<[f64; 2]> = match obj.get("type")?.as_str()? {
        "LineString" => ring_coords(coords),
        "MultiLineString" => coords
            .as_array()?
            .iter()
            .map(ring_coords)
            .max_by(|a, b| {
                let la: f64 = a.windows(2).map(|w| haversine_m(w[0], w[1])).sum();
                let lb: f64 = b.windows(2).map(|w| haversine_m(w[0], w[1])).sum();
                la.total_cmp(&lb)
            })
            .unwrap_or_default(),
        _ => return None,
    };
    if verts.is_empty() {
        return None;
    }
    let total: f64 = verts.windows(2).map(|w| haversine_m(w[0], w[1])).sum();
    if total <= 0.0 {
        return Some(verts[0]);
    }
    let target = total / 2.0;
    let mut acc = 0.0;
    for w in verts.windows(2) {
        let seg = haversine_m(w[0], w[1]);
        if acc + seg >= target {
            let t = if seg > 0.0 { (target - acc) / seg } else { 0.0 };
            return Some([
                w[0][0] + (w[1][0] - w[0][0]) * t,
                w[0][1] + (w[1][1] - w[0][1]) * t,
            ]);
        }
        acc += seg;
    }
    verts.last().copied()
}

fn is_transit(category: &str) -> bool {
    matches!(category, "elevator" | "escalator" | "stairs")
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Skeleton,
    Opening,
    Transit,
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: analyze_synth <imdf.zip|bundle.kvb> [--dump ordinal out.json]");
    let source = fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    // A raw `kvb1` bundle decodes directly; anything else is an IMDF zip that
    // is compiled with synthesis first (before/after comparisons).
    let doc = if source.starts_with(b"KVB") {
        decode_bundle(&source).expect("decode bundle")
    } else {
        let compiled = compile_imdf_with_network(
            &source,
            BundleMetadata {
                dataset_id: "diag".into(),
                version: 1,
            },
            None,
            None,
            None,
            true,
            false,
            None,
            &[],
            None,
        )
        .expect("compile with synthesis");
        decode_bundle(&compiled.bytes).expect("decode")
    };
    let graph = doc.graph.as_ref().expect("synthesized graph present");

    // level_id -> ordinal
    let level_ordinal: BTreeMap<&str, f64> = doc
        .levels
        .iter()
        .map(|l| (l.id.as_str(), l.ordinal))
        .collect();

    // Collect opening midpoints and transit units per ordinal.
    let mut openings: Vec<(f64, [f64; 2])> = Vec::new(); // (ordinal, midpoint)
    let mut transits: Vec<(f64, [f64; 2], String, Value)> = Vec::new(); // (ordinal, centroid, category, geom)
    for f in &doc.features {
        let Some(level_id) = f.level_id.as_deref() else {
            continue;
        };
        let Some(&ord) = level_ordinal.get(level_id) else {
            continue;
        };
        let Some(geom) = f.geometry.as_ref() else {
            continue;
        };
        match f.feature_type {
            FeatureType::Opening => {
                if let Some(m) = linestring_midpoint(geom) {
                    openings.push((ord, m));
                }
            }
            FeatureType::Unit => {
                if let Some(cat) = f.category.as_deref()
                    && is_transit(cat)
                    && let Some(c) = polygon_centroid(geom)
                {
                    transits.push((ord, c, cat.to_string(), geom.clone()));
                }
            }
            _ => {}
        }
    }

    // Classify graph nodes by exact position match.
    let kinds: Vec<Kind> = graph
        .nodes
        .iter()
        .map(|n| {
            let p = [n.lon, n.lat];
            if openings.iter().any(|(o, m)| *o == n.ordinal && *m == p) {
                Kind::Opening
            } else if transits
                .iter()
                .any(|(o, c, _, _)| *o == n.ordinal && *c == p)
            {
                Kind::Transit
            } else {
                Kind::Skeleton
            }
        })
        .collect();

    let n_open = kinds.iter().filter(|&&k| k == Kind::Opening).count();
    let n_transit = kinds.iter().filter(|&&k| k == Kind::Transit).count();
    let n_skel = kinds.iter().filter(|&&k| k == Kind::Skeleton).count();
    println!(
        "nodes: {} total | skeleton {n_skel} opening {n_open} transit {n_transit}",
        graph.nodes.len()
    );
    println!(
        "features: {} openings, {} transit units",
        openings.len(),
        transits.len()
    );
    println!("edges: {}", graph.edges.len());

    // Adjacency.
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); graph.nodes.len()];
    for e in &graph.edges {
        adj[e.from as usize].push(e.to as usize);
        adj[e.to as usize].push(e.from as usize);
    }

    // --- Complaint 1: transit attaches at centroid, not via the opening ---
    let mut t_with_opening = 0usize;
    let mut t_without_opening = 0usize;
    let mut t_parallel = 0usize; // opening ALSO connects into the same skeleton neighbourhood
    let mut t_edge_kinds: BTreeMap<String, usize> = BTreeMap::new();
    for (ord, centroid, cat, geom) in &transits {
        // openings belonging to this transit unit: midpoint within 1.5 m of its boundary
        let belonging: Vec<[f64; 2]> = openings
            .iter()
            .filter(|(o, _)| o == ord)
            .map(|(_, m)| *m)
            .filter(|m| point_boundary_dist_m(*m, geom) <= 1.5)
            .collect();
        if belonging.is_empty() {
            t_without_opening += 1;
        } else {
            t_with_opening += 1;
        }
        // find this transit's graph node (by exact centroid match on same ordinal)
        let node_idx = graph
            .nodes
            .iter()
            .position(|n| n.ordinal == *ord && [n.lon, n.lat] == *centroid)
            .expect("transit node exists");
        for &nb in &adj[node_idx] {
            let same_floor = graph.nodes[nb].ordinal == *ord;
            if same_floor {
                *t_edge_kinds
                    .entry(format!("{cat}->{:?}", kinds[nb]))
                    .or_default() += 1;
            }
        }
        // parallel path: a belonging opening has its own node with a skeleton edge
        // AND the transit centroid has a direct skeleton edge
        let t_has_skel_edge = adj[node_idx].iter().any(|&nb| kinds[nb] == Kind::Skeleton);
        if t_has_skel_edge && !belonging.is_empty() {
            t_parallel += 1;
        }
    }
    println!(
        "\n[complaint 1] transit units: {t_with_opening} with opening on boundary, {t_without_opening} without"
    );
    println!("[complaint 1] transit->centroid edge targets (same floor): {t_edge_kinds:?}");
    println!(
        "[complaint 1] transit units with BOTH a boundary opening and a direct centroid->skeleton edge (parallel attach): {t_parallel}"
    );

    // --- Complaint 2: multiple connections ---
    // Edge-kind breakdown.
    let mut kind_pairs: BTreeMap<String, usize> = BTreeMap::new();
    let name = |k: Kind| match k {
        Kind::Skeleton => "skel",
        Kind::Opening => "open",
        Kind::Transit => "trans",
    };
    for e in &graph.edges {
        let (a, b) = (kinds[e.from as usize], kinds[e.to as usize]);
        let cross = graph.nodes[e.from as usize].ordinal != graph.nodes[e.to as usize].ordinal;
        let mut pair = [name(a), name(b)];
        pair.sort();
        *kind_pairs
            .entry(format!(
                "{}{}",
                pair.join("-"),
                if cross { " (vertical)" } else { "" }
            ))
            .or_default() += 1;
    }
    println!("\nedge kinds: {kind_pairs:?}");

    // whole-graph connectivity
    let mut parent: Vec<usize> = (0..graph.nodes.len()).collect();
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
    let comps: std::collections::BTreeSet<usize> = (0..graph.nodes.len())
        .map(|i| find(&mut parent, i))
        .collect();
    println!("connected components (whole venue): {}", comps.len());

    // opening degree split by neighbor kind
    let mut skel_deg_hist: BTreeMap<usize, usize> = BTreeMap::new();
    let mut trans_deg_hist: BTreeMap<usize, usize> = BTreeMap::new();
    for (i, &k) in kinds.iter().enumerate() {
        if k != Kind::Opening {
            continue;
        }
        let skel = adj[i]
            .iter()
            .filter(|&&nb| kinds[nb] == Kind::Skeleton)
            .count();
        let trans = adj[i]
            .iter()
            .filter(|&&nb| kinds[nb] == Kind::Transit)
            .count();
        *skel_deg_hist.entry(skel).or_default() += 1;
        *trans_deg_hist.entry(trans).or_default() += 1;
    }
    println!("opening->skeleton degree histogram: {skel_deg_hist:?}");
    println!("opening->transit  degree histogram: {trans_deg_hist:?}");

    // spike analysis: skeleton leaf nodes (degree 1) and their edge lengths
    let mut leaf_hist: BTreeMap<String, usize> = BTreeMap::new();
    let mut leaf_total = 0usize;
    for (i, &k) in kinds.iter().enumerate() {
        if k != Kind::Skeleton {
            continue;
        }
        let same_floor: Vec<usize> = adj[i]
            .iter()
            .filter(|&&nb| graph.nodes[nb].ordinal == graph.nodes[i].ordinal)
            .copied()
            .collect();
        if same_floor.len() == 1 {
            leaf_total += 1;
            let nb = same_floor[0];
            let d = haversine_m(
                [graph.nodes[i].lon, graph.nodes[i].lat],
                [graph.nodes[nb].lon, graph.nodes[nb].lat],
            );
            let bucket = if d < 0.5 {
                "<0.5m"
            } else if d < 1.0 {
                "0.5-1m"
            } else if d < 2.0 {
                "1-2m"
            } else if d < 4.0 {
                "2-4m"
            } else {
                ">=4m"
            };
            *leaf_hist.entry(bucket.to_string()).or_default() += 1;
        }
    }
    println!("skeleton leaf edges: {leaf_total} by length: {leaf_hist:?}");

    // duplicate doorway nodes: pairs of opening nodes <2 m apart on same floor
    let opening_nodes: Vec<usize> = kinds
        .iter()
        .enumerate()
        .filter(|&(_, &k)| k == Kind::Opening)
        .map(|(i, _)| i)
        .collect();
    let mut dup_pairs = 0usize;
    for (ai, &a) in opening_nodes.iter().enumerate() {
        for &b in &opening_nodes[ai + 1..] {
            let (na, nb) = (&graph.nodes[a], &graph.nodes[b]);
            if na.ordinal != nb.ordinal {
                continue;
            }
            if haversine_m([na.lon, na.lat], [nb.lon, nb.lat]) < 2.0 {
                dup_pairs += 1;
            }
        }
    }
    println!(
        "[complaint 2] opening-node pairs closer than 2 m on one floor (duplicate doorways): {dup_pairs}"
    );

    // Optional per-floor dump for external plotting: --dump <ordinal> <out.json>
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 5 && args[2] == "--dump" {
        let ord: f64 = args[3].parse().expect("ordinal");
        let mut js = String::from("{\"nodes\":[");
        for (i, n) in graph.nodes.iter().enumerate() {
            if n.ordinal != ord {
                continue;
            }
            js.push_str(&format!(
                "[{},{},\"{}\",{}],",
                n.lon,
                n.lat,
                name(kinds[i]),
                i
            ));
        }
        js.pop();
        js.push_str("],\"edges\":[");
        for e in &graph.edges {
            let (a, b) = (e.from as usize, e.to as usize);
            if graph.nodes[a].ordinal != ord && graph.nodes[b].ordinal != ord {
                continue;
            }
            js.push_str(&format!(
                "[{},{},\"{}-{}\"],",
                a,
                b,
                name(kinds[a]),
                name(kinds[b])
            ));
        }
        js.pop();
        js.push_str("]}");
        fs::write(&args[4], js).expect("write dump");
        println!("dumped ordinal {ord} to {}", args[4]);
    }

    // duplicate doorway nodes: pairs of opening nodes <2 m apart on same floor
    // per-ordinal summary
    let mut per_ord: BTreeMap<i64, (usize, usize, usize)> = BTreeMap::new();
    for (i, n) in graph.nodes.iter().enumerate() {
        let e = per_ord.entry(n.ordinal as i64).or_default();
        match kinds[i] {
            Kind::Skeleton => e.0 += 1,
            Kind::Opening => e.1 += 1,
            Kind::Transit => e.2 += 1,
        }
    }
    println!("\nper ordinal (skeleton/opening/transit):");
    for (ord, (s, o, t)) in per_ord {
        println!("  ord {ord}: {s}/{o}/{t}");
    }
}
