use std::collections::{BTreeMap, HashMap};
use std::fmt;

use geojson::{FeatureCollection, GeoJson, Value};

use crate::floor::floor_to_ordinal;
use crate::graph::{RouteEdge, RouteGraph, RouteNode};

/// Non-fatal problem encountered while building a route graph.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteBuildWarning {
    pub code: String,
    pub detail: String,
}

/// Fatal error: the input GeoJSON could not be parsed at all.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteBuildError {
    pub message: String,
}

impl fmt::Display for RouteBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RouteBuildError {}

/// Result of [`build_route_graph`]: the graph, non-fatal warnings, and the
/// NODEID→index mapping (`node_ids[i]` is the source NODEID of `graph.nodes[i]`).
pub struct RouteGraphBuild {
    pub graph: RouteGraph,
    pub warnings: Vec<RouteBuildWarning>,
    pub node_ids: Vec<u64>,
}

/// Build a deterministic route graph from network junction and path GeoJSON.
///
/// Junctions carry `NODEID`/`FLOOR` properties and a Point geometry; paths carry
/// `FNODEID`/`TNODEID`/`cost`. Nodes on unmappable floors are dropped with an
/// `unmapped_floor` warning; edges referencing a missing node are dropped with a
/// `dangling_edge` warning. Nodes whose ordinal matches no venue level produce an
/// `unmatched_level` warning but are kept.
pub fn build_route_graph(
    junctions_geojson: &str,
    paths_geojson: &str,
    level_ordinals: &[f64],
) -> Result<RouteGraphBuild, RouteBuildError> {
    let junctions = parse_collection(junctions_geojson, "junctions")?;
    let paths = parse_collection(paths_geojson, "paths")?;
    let mut warnings = Vec::new();

    // Nodes keyed by NODEID; BTreeMap keeps iteration sorted → deterministic output.
    let mut by_id: BTreeMap<u64, RouteNode> = BTreeMap::new();
    for feature in &junctions.features {
        let (Some(id), Some(floor), Some(Value::Point(coords))) = (
            prop(&feature.properties, "NODEID").and_then(|v| v.as_u64()),
            prop(&feature.properties, "FLOOR").and_then(|v| v.as_str()),
            feature.geometry.as_ref().map(|g| &g.value),
        ) else {
            continue;
        };
        let (Some(&lon), Some(&lat)) = (coords.first(), coords.get(1)) else {
            continue;
        };
        let Some(ordinal) = floor_to_ordinal(floor) else {
            warnings.push(RouteBuildWarning {
                code: "unmapped_floor".into(),
                detail: format!("node {id} floor {floor:?} has no ordinal mapping"),
            });
            continue;
        };
        by_id.insert(id, RouteNode { lon, lat, ordinal });
    }

    let index: HashMap<u64, u32> = by_id
        .keys()
        .enumerate()
        .map(|(i, &id)| (id, i as u32))
        .collect();

    // Nodes in index order, for edge-ordinal fallback while edges are built.
    let nodes_by_idx: Vec<RouteNode> = by_id.values().cloned().collect();

    let mut edges = Vec::new();
    // A reciprocal PATHID/RPATHID pair is two directed features that are exact
    // endpoint reverses AND cross-reference each other's ids (fwd.PATHID ==
    // rev.RPATHID and vice versa); such a pair collapses to one logical
    // undirected edge, keeping the forward (smaller PATHID). Features sharing
    // the same unordered id set that are NOT exact reverses are a malformed id
    // collision, not a pair: both are preserved with a `reciprocal_conflict`
    // warning.
    //
    // `pending` indexes each recorded (not-yet-paired) edge by its exact
    // directed signature `(pathid, rpathid, from, to)`, so a candidate finds its
    // reverse partner in O(1) average by looking up `(rpathid, pathid, to,
    // from)` — never a growing per-key scan. `id_set_seen` counts logical edges
    // per unordered id set, used only to raise the malformed-collision warning
    // without scanning.
    let mut pending: HashMap<(i64, i64, u32, u32), Vec<usize>> = HashMap::new();
    let mut id_set_seen: HashMap<(i64, i64), u32> = HashMap::new();
    for feature in &paths.features {
        let (Some(from), Some(to), Some(cost)) = (
            prop(&feature.properties, "FNODEID").and_then(|v| v.as_u64()),
            prop(&feature.properties, "TNODEID").and_then(|v| v.as_u64()),
            prop(&feature.properties, "cost").and_then(|v| v.as_f64()),
        ) else {
            continue;
        };
        let (Some(&from_idx), Some(&to_idx)) = (index.get(&from), index.get(&to)) else {
            warnings.push(RouteBuildWarning {
                code: "dangling_edge".into(),
                detail: format!("edge {from}->{to} references an unknown or dropped node"),
            });
            continue;
        };
        // Every edge weight is finite and non-negative; a malformed source cost
        // is rejected here so it never enters the graph.
        let weight = cost as f32;
        if !weight.is_finite() || weight < 0.0 {
            warnings.push(RouteBuildWarning {
                code: "invalid_cost".into(),
                detail: format!("edge {from}->{to} has a non-finite or negative cost {cost}"),
            });
            continue;
        }
        // Edge ordinal: its own FLOOR, else the `from` node's ordinal.
        let ordinal = prop(&feature.properties, "FLOOR")
            .and_then(|v| v.as_str())
            .and_then(floor_to_ordinal)
            .unwrap_or(nodes_by_idx[from_idx as usize].ordinal);
        // Interior = the polyline vertices with the two endpoints stripped.
        let interior = interior_vertices(feature.geometry.as_ref().map(|g| &g.value));
        let edge = RouteEdge {
            from: from_idx,
            to: to_idx,
            weight,
            ordinal,
            interior,
        };

        // Reciprocal handling requires both PATHID and RPATHID; id-less paths
        // are always kept as-is (parallel edges and hand-authored data).
        let pathid = prop(&feature.properties, "PATHID").and_then(|v| v.as_i64());
        let rpathid = prop(&feature.properties, "RPATHID").and_then(|v| v.as_i64());
        match (pathid, rpathid) {
            (Some(p), Some(r)) => {
                // The reverse partner, if already recorded, has exactly this
                // signature (ids swapped, endpoints swapped).
                let partner = pending
                    .get_mut(&(r, p, to_idx, from_idx))
                    .and_then(Vec::pop);
                match partner {
                    Some(partner_idx) => {
                        // True reciprocal pair: keep the forward (smaller PATHID).
                        // The partner's PATHID is `r` by construction, so compare
                        // `p` against `r` directly.
                        if p < r {
                            edges[partner_idx] = edge;
                        }
                        // else: this candidate is the reverse member → drop it.
                    }
                    None => {
                        // No reverse partner. If another logical edge already
                        // carries this unordered id set, it is a malformed
                        // collision (not a pair): keep both and warn.
                        let id_set = (p.min(r), p.max(r));
                        let seen = id_set_seen.entry(id_set).or_insert(0);
                        if *seen > 0 {
                            warnings.push(RouteBuildWarning {
                                code: "reciprocal_conflict".into(),
                                detail: format!(
                                    "edge {from}->{to} shares PATHID/RPATHID set ({}, {}) with a non-reverse edge; keeping both",
                                    id_set.0, id_set.1
                                ),
                            });
                        }
                        *seen += 1;
                        pending
                            .entry((p, r, from_idx, to_idx))
                            .or_default()
                            .push(edges.len());
                        edges.push(edge);
                    }
                }
            }
            _ => edges.push(edge),
        }
    }
    edges.sort_by(|a, b| {
        (a.from, a.to, a.weight.to_bits()).cmp(&(b.from, b.to, b.weight.to_bits()))
    });

    // NODEID order matches `by_id.into_values()` (BTreeMap) → parallel to `nodes`.
    let node_ids: Vec<u64> = by_id.keys().copied().collect();
    let nodes: Vec<RouteNode> = by_id.into_values().collect();
    for node in &nodes {
        if !level_ordinals.contains(&node.ordinal) {
            warnings.push(RouteBuildWarning {
                code: "unmatched_level".into(),
                detail: format!("node ordinal {} matches no venue level", node.ordinal),
            });
        }
    }

    Ok(RouteGraphBuild {
        graph: RouteGraph { nodes, edges },
        warnings,
        node_ids,
    })
}

/// Flatten a `MultiLineString`/`LineString` to its vertex list, then drop the
/// first and last vertices (they equal the endpoint node coordinates). Returns
/// the interior bend points, or empty for missing/degenerate geometry.
fn interior_vertices(value: Option<&Value>) -> Vec<[f64; 2]> {
    let verts: Vec<[f64; 2]> = match value {
        Some(Value::MultiLineString(lines)) => lines
            .iter()
            .flatten()
            .filter_map(|c| Some([*c.first()?, *c.get(1)?]))
            .collect(),
        Some(Value::LineString(line)) => line
            .iter()
            .filter_map(|c| Some([*c.first()?, *c.get(1)?]))
            .collect(),
        _ => Vec::new(),
    };
    if verts.len() <= 2 {
        return Vec::new();
    }
    verts[1..verts.len() - 1].to_vec()
}

fn parse_collection(src: &str, what: &str) -> Result<FeatureCollection, RouteBuildError> {
    let geojson: GeoJson = src.parse().map_err(|e| RouteBuildError {
        message: format!("invalid {what} GeoJSON: {e}"),
    })?;
    FeatureCollection::try_from(geojson).map_err(|e| RouteBuildError {
        message: format!("{what} GeoJSON is not a FeatureCollection: {e}"),
    })
}

fn prop<'a>(
    properties: &'a Option<serde_json::Map<String, serde_json::Value>>,
    key: &str,
) -> Option<&'a serde_json::Value> {
    properties.as_ref()?.get(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JUNCTIONS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
      {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
      {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F2"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}}]}"#;
    const PATHS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}},
      {"type":"Feature","properties":{"FNODEID":2,"TNODEID":3,"cost":5000},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.001,35.0]]]}},
      {"type":"Feature","properties":{"FNODEID":2,"TNODEID":99,"cost":10},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.002,35.0]]]}}]}"#;

    #[test]
    fn builds_graph_dropping_dangling_edges() {
        let b = build_route_graph(JUNCTIONS, PATHS, &[0.0, 1.0]).unwrap();
        assert_eq!(b.graph.nodes.len(), 3);
        assert_eq!(b.graph.edges.len(), 2); // edge to NODEID 99 dropped
        assert!(b.warnings.iter().any(|w| w.code == "dangling_edge"));
    }

    #[test]
    fn drops_unmappable_floor_nodes() {
        let j = JUNCTIONS.replace("\"F2\"", "\"garbage\"");
        let b = build_route_graph(&j, PATHS, &[0.0, 1.0]).unwrap();
        assert_eq!(b.graph.nodes.len(), 2);
        assert!(b.warnings.iter().any(|w| w.code == "unmapped_floor"));
    }

    #[test]
    fn deterministic_output() {
        let a = build_route_graph(JUNCTIONS, PATHS, &[0.0, 1.0]).unwrap().graph;
        let b = build_route_graph(JUNCTIONS, PATHS, &[0.0, 1.0]).unwrap().graph;
        assert_eq!(a, b);
    }

    #[test]
    fn keeps_edge_interior_vertices_and_ordinal() {
        const J: &str = r#"{"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
          {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.002,35.0]}}]}"#;
        // A curved edge: endpoints match the nodes, one interior bend point.
        const P: &str = r#"{"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":200,"FLOOR":"F1"},
           "geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0005],[139.002,35.0]]]}}]}"#;
        let b = build_route_graph(J, P, &[0.0]).unwrap();
        assert_eq!(b.graph.edges.len(), 1);
        let e = &b.graph.edges[0];
        assert_eq!(e.ordinal, 0.0);
        assert_eq!(e.interior, vec![[139.001, 35.0005]]); // endpoints stripped
        assert_eq!(
            b.graph.edge_polyline(e),
            vec![[139.0, 35.0], [139.001, 35.0005], [139.002, 35.0]]
        );
    }

    #[test]
    fn straight_edge_has_empty_interior() {
        let b = build_route_graph(JUNCTIONS, PATHS, &[0.0, 1.0]).unwrap();
        assert!(b.graph.edges.iter().all(|e| e.interior.is_empty()));
    }

    #[test]
    fn returns_node_ids_parallel_to_nodes() {
        let b = build_route_graph(JUNCTIONS, PATHS, &[0.0, 1.0]).unwrap();
        assert_eq!(b.node_ids.len(), b.graph.nodes.len());
        // NODEID 1 maps to the node at its index
        let idx = b.node_ids.iter().position(|&id| id == 1).unwrap();
        assert!((b.graph.nodes[idx].lon - 139.0).abs() < 1e-9);
    }

    #[test]
    fn drops_edges_with_negative_cost() {
        const P: &str = r#"{"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":-5},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}}]}"#;
        let b = build_route_graph(JUNCTIONS, P, &[0.0, 1.0]).unwrap();
        assert!(b.graph.edges.is_empty(), "a negative-cost edge must not enter the graph");
        assert!(b.warnings.iter().any(|w| w.code == "invalid_cost"));
    }

    #[test]
    fn canonicalizes_reciprocal_pairs_and_preserves_parallel_edges() {
        const J: &str = r#"{"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
          {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}}]}"#;
        // Two logical undirected edges between nodes 1 and 2, each written as a
        // reciprocal PATHID/RPATHID pair. Canonicalization keeps exactly one
        // edge per reciprocal pair (2 total), while the two distinct pairs
        // (different PATHIDs, different costs) survive as parallel edges.
        const P: &str = r#"{"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":100,"PATHID":1,"RPATHID":2},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}},
          {"type":"Feature","properties":{"FNODEID":2,"TNODEID":1,"cost":100,"PATHID":2,"RPATHID":1},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.0,35.0]]]}},
          {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":200,"PATHID":3,"RPATHID":4},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}},
          {"type":"Feature","properties":{"FNODEID":2,"TNODEID":1,"cost":200,"PATHID":4,"RPATHID":3},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.0,35.0]]]}}]}"#;
        let b = build_route_graph(J, P, &[0.0]).unwrap();
        assert_eq!(b.graph.edges.len(), 2, "two reciprocal pairs → two logical edges");
        let mut costs: Vec<f32> = b.graph.edges.iter().map(|e| e.weight).collect();
        costs.sort_by(f32::total_cmp);
        assert_eq!(costs, vec![100.0, 200.0]);
        // Every kept edge is the canonical forward (0->1, smaller PATHID) direction.
        assert!(b.graph.edges.iter().all(|e| (e.from, e.to) == (0, 1)));
    }

    #[test]
    fn does_not_collapse_a_non_reverse_edge_sharing_the_id_set() {
        const J: &str = r#"{"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
          {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
          {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.002,35.0]}}]}"#;
        // Two edges share the unordered id set {1,2} but are NOT reverses of
        // each other: 1->2 (PATHID 1/RPATHID 2) and 1->3 (PATHID 2/RPATHID 1).
        // The second must be preserved, never collapsed into the first.
        const P: &str = r#"{"type":"FeatureCollection","features":[
          {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":100,"PATHID":1,"RPATHID":2},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}},
          {"type":"Feature","properties":{"FNODEID":1,"TNODEID":3,"cost":200,"PATHID":2,"RPATHID":1},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.002,35.0]]]}}]}"#;
        let b = build_route_graph(J, P, &[0.0]).unwrap();
        assert_eq!(b.graph.edges.len(), 2, "distinct non-reverse edges must both survive");
        let mut pairs: Vec<(u32, u32)> = b.graph.edges.iter().map(|e| (e.from, e.to)).collect();
        pairs.sort_unstable();
        assert_eq!(pairs, vec![(0, 1), (0, 2)]);
        assert!(b.warnings.iter().any(|w| w.code == "reciprocal_conflict"));
    }

    #[test]
    fn many_non_reverse_id_collisions_are_all_preserved_without_scanning() {
        // A large batch of distinct edges 1->k that all share the unordered id
        // set {1,2} yet are never reverses of one another. Every edge must
        // survive, and the dedupe must resolve each in O(1) average (no growing
        // per-id bucket scan) — verified structurally by the signature index,
        // asserted here semantically at scale.
        const N: usize = 300;
        let mut jf = String::from(r#"{"type":"FeatureCollection","features":["#);
        for k in 1..=(N + 1) {
            if k > 1 {
                jf.push(',');
            }
            jf.push_str(&format!(
                r#"{{"type":"Feature","properties":{{"NODEID":{k},"FLOOR":"F1"}},"geometry":{{"type":"Point","coordinates":[139.0,35.0]}}}}"#
            ));
        }
        jf.push_str("]}");
        let mut pf = String::from(r#"{"type":"FeatureCollection","features":["#);
        for k in 2..=(N + 1) {
            if k > 2 {
                pf.push(',');
            }
            // Every path reuses PATHID 1 / RPATHID 2 (a malformed id set) but has
            // a distinct target, so none is the reverse of any other.
            pf.push_str(&format!(
                r#"{{"type":"Feature","properties":{{"FNODEID":1,"TNODEID":{k},"cost":100,"PATHID":1,"RPATHID":2}},"geometry":{{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.0,35.0]]]}}}}"#
            ));
        }
        pf.push_str("]}");
        let b = build_route_graph(&jf, &pf, &[0.0]).unwrap();
        assert_eq!(b.graph.edges.len(), N, "all distinct non-reverse edges survive");
        let conflicts = b
            .warnings
            .iter()
            .filter(|w| w.code == "reciprocal_conflict")
            .count();
        assert_eq!(conflicts, N - 1, "each collision after the first is reported once");
    }
}
