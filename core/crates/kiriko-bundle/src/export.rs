//! Export a compiled bundle's §5 routing graph back to the `net_junction` /
//! `net_path` GeoJSON feature classes used by the reference GDB networks.
//!
//! This is the inverse of the network-import path: [`kiriko_route`] builds a
//! [`RouteGraph`] from `net_junction`/`net_path` GeoJSON; here we serialize a
//! graph (real or synthesized) back to the same schema so the server can
//! package it as a File Geodatabase and the browser can render it floor by
//! floor. One function, two bindings (napi + wasm).
//!
//! Fidelity is schema/semantic, not byte-level: field names, types, geometry,
//! and connectivity match the reference; the GDB driver owns `OBJECTID` and
//! `SHAPE_Length`, so those are never emitted here.

use serde_json::{Value as Json, json};

use crate::codec::decode_bundle;
use crate::error::BundleError;
use crate::synth::haversine_m;

/// Nominal floor-to-floor height (metres) used to lift junction/path
/// coordinates to a `altitude` attribute; kept simple and constant.
const FLOOR_HEIGHT_M: f64 = 4.0;
/// Walking speed (m/s) for the derived `TRAVELTIME` cost attribute.
const WALK_SPEED_MPS: f64 = 1.4;

/// The two network feature classes as WGS84 GeoJSON `FeatureCollection` text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkGeoJson {
    pub junctions: String,
    pub paths: String,
}

/// Failure exporting a bundle's network.
#[derive(Debug, Clone, PartialEq)]
pub enum ExportError {
    /// The bundle bytes could not be decoded.
    Bundle(BundleError),
    /// The bundle carries no §5 routing graph (or an empty one).
    NoGraph,
    /// A node or edge ordinal is not an integer, so the accepted GDB
    /// floor-label grammar cannot represent it losslessly.
    FractionalOrdinal(f64),
    /// Serialization of the assembled GeoJSON failed (should not happen).
    Serialize(String),
}

impl ExportError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            ExportError::Bundle(e) => e.code.as_str(),
            ExportError::NoGraph => "no_graph",
            ExportError::FractionalOrdinal(_) => "fractional_ordinal",
            ExportError::Serialize(_) => "export_serialize_failed",
        }
    }

    #[must_use]
    pub fn message(&self) -> String {
        match self {
            ExportError::Bundle(e) => e.message.clone(),
            ExportError::NoGraph => "bundle carries no routing graph to export".to_string(),
            ExportError::FractionalOrdinal(ord) => format!(
                "graph ordinal {ord} is not an integer floor and cannot be exported losslessly"
            ),
            ExportError::Serialize(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for ExportError {}

/// Inverse of [`kiriko_route::floor_to_ordinal`] for integer ordinals: `0 →
/// "F1"`, `n≥0 → "F{n+1}"`, `n<0 → "B{-n}"`. Guarantees the emitted `FLOOR`
/// label round-trips back to the same ordinal on re-import.
#[must_use]
pub fn ordinal_to_floor_label(ordinal: f64) -> String {
    let o = ordinal.round() as i64;
    if o >= 0 {
        format!("F{}", o + 1)
    } else {
        format!("B{}", -o)
    }
}

/// Decode `bundle` and serialize its §5 routing graph to `net_junction` /
/// `net_path` GeoJSON. Every undirected graph edge is emitted as a directed
/// pair (forward + reverse) cross-referenced by `PATHID`/`RPATHID`, matching
/// the reference networks. `cost` is the edge's exact canonical weight (mm,
/// preserved without rounding); each path's `FLOOR` is the edge's own ordinal;
/// `TRAVELTIME` is seconds at [`WALK_SPEED_MPS`].
pub fn export_network(bundle: &[u8]) -> Result<NetworkGeoJson, ExportError> {
    let document = decode_bundle(bundle).map_err(ExportError::Bundle)?;
    let graph = document.graph.ok_or(ExportError::NoGraph)?;
    // A routable network needs at least one edge; nodes alone are not exported.
    if graph.nodes.is_empty() || graph.edges.is_empty() {
        return Err(ExportError::NoGraph);
    }
    // Fractional ordinals have no lossless GDB floor label; reject explicitly
    // rather than silently rounding to an integer floor.
    for n in &graph.nodes {
        if n.ordinal.fract() != 0.0 {
            return Err(ExportError::FractionalOrdinal(n.ordinal));
        }
    }
    for e in &graph.edges {
        if e.ordinal.fract() != 0.0 {
            return Err(ExportError::FractionalOrdinal(e.ordinal));
        }
    }

    // Undirected degree = reference `PATH_COUNT`.
    let mut degree = vec![0u32; graph.nodes.len()];
    for e in &graph.edges {
        degree[e.from as usize] += 1;
        degree[e.to as usize] += 1;
    }

    let junction_features: Vec<Json> = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            json!({
                "type": "Feature",
                "properties": {
                    "NODEID": i,
                    "PATH_COUNT": degree[i],
                    "FLOOR": ordinal_to_floor_label(n.ordinal),
                    "BARRIER": 0,
                    "STARTTIME": -1,
                    "ENDTIME": -1,
                    "GATE": 0,
                    "NAME": Json::Null,
                    "relative_height": Json::Null,
                    "altitude": n.ordinal * FLOOR_HEIGHT_M,
                },
                "geometry": { "type": "Point", "coordinates": [n.lon, n.lat] },
            })
        })
        .collect();
    let junctions = serde_json::to_string(&json!({
        "type": "FeatureCollection",
        "name": "net_junction",
        "features": junction_features,
    }))
    .map_err(|e| ExportError::Serialize(e.to_string()))?;

    let mut path_features: Vec<Json> = Vec::with_capacity(graph.edges.len() * 2);
    let mut next_path_id: i64 = 1;
    for e in &graph.edges {
        let poly = graph.edge_polyline(e);
        let length_m: f64 = poly.windows(2).map(|w| haversine_m(w[0], w[1])).sum();
        // The stored weight is already in canonical `net_path.cost` units (mm);
        // preserve its exact finite, non-negative value (the importer reads it
        // back as f64) — never round or re-multiply by 1000.
        let cost = f64::from(e.weight);
        let travel_time = (length_m / WALK_SPEED_MPS).round() as i64;
        let from_ord = graph.nodes[e.from as usize].ordinal;
        let to_ord = graph.nodes[e.to as usize].ordinal;
        let vertical = from_ord != to_ord;
        let fwd = next_path_id;
        let rev = next_path_id + 1;
        next_path_id += 2;

        let reversed: Vec<[f64; 2]> = poly.iter().rev().copied().collect();
        path_features.push(path_feature(
            e.from,
            e.to,
            cost,
            travel_time,
            from_ord,
            to_ord,
            e.ordinal,
            vertical,
            fwd,
            rev,
            &poly,
        ));
        path_features.push(path_feature(
            e.to,
            e.from,
            cost,
            travel_time,
            to_ord,
            from_ord,
            e.ordinal,
            vertical,
            rev,
            fwd,
            &reversed,
        ));
    }
    let paths = serde_json::to_string(&json!({
        "type": "FeatureCollection",
        "name": "net_path",
        "features": path_features,
    }))
    .map_err(|e| ExportError::Serialize(e.to_string()))?;

    Ok(NetworkGeoJson { junctions, paths })
}

#[allow(clippy::too_many_arguments)]
fn path_feature(
    from: u32,
    to: u32,
    cost: f64,
    travel_time: i64,
    from_ord: f64,
    to_ord: f64,
    edge_ord: f64,
    vertical: bool,
    path_id: i64,
    reverse_path_id: i64,
    poly: &[[f64; 2]],
) -> Json {
    let coordinates: Vec<Json> = poly.iter().map(|p| json!([p[0], p[1]])).collect();
    let (ffloor, tfloor) = if vertical {
        (
            Json::String(ordinal_to_floor_label(from_ord)),
            Json::String(ordinal_to_floor_label(to_ord)),
        )
    } else {
        (Json::Null, Json::Null)
    };
    json!({
        "type": "Feature",
        "properties": {
            "FNODEID": from,
            "TNODEID": to,
            "passage_type": i64::from(vertical),
            "cost": cost,
            "TRAVELTIME": travel_time,
            "RFLAG": 0,
            "BARRIER": 0,
            "FLOOR": ordinal_to_floor_label(edge_ord),
            "PATHID": path_id,
            "RPATHID": reverse_path_id,
            "HFLAG": i64::from(vertical),
            "STARTTIME": -1,
            "ENDTIME": -1,
            "direction": Json::Null,
            "FFLOOR": ffloor,
            "TFOOLR": tfloor,
            "indoor": 1,
        },
        "geometry": { "type": "LineString", "coordinates": coordinates },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{BundleDocument, BundleMetadata, BundleStats, encode_bundle};
    use kiriko_model::model::{ImdfManifest, ViewerLevel};
    use kiriko_route::{EdgeAttrs, RouteEdge, RouteGraph, RouteNode};
    use std::collections::BTreeMap;

    fn bundle_with_graph(graph: RouteGraph) -> Vec<u8> {
        let doc = BundleDocument {
            metadata: BundleMetadata {
                dataset_id: "t/v".into(),
                version: 1,
            },
            manifest: ImdfManifest {
                version: "1.0.0".into(),
                language: "en".into(),
                rest: BTreeMap::new(),
            },
            venue_id: "v".into(),
            levels: vec![
                ViewerLevel {
                    id: "l0".into(),
                    ordinal: 0.0,
                    label: BTreeMap::new(),
                    short_name: BTreeMap::new(),
                },
                ViewerLevel {
                    id: "l1".into(),
                    ordinal: 1.0,
                    label: BTreeMap::new(),
                    short_name: BTreeMap::new(),
                },
            ],
            features: Vec::new(),
            bounds_by_level: BTreeMap::new(),
            warnings: Vec::new(),
            stats: BundleStats {
                levels: 2,
                features: 0,
            },
            graph: Some(graph),
            facilities: None,
            spatial_context: None,
            scene: None,
            capabilities: crate::codec::CapabilityReport::default(),
        };
        encode_bundle(&doc).expect("encode")
    }

    #[test]
    fn ordinal_labels_round_trip_through_floor_to_ordinal() {
        for ord in [-5.0, -1.0, 0.0, 1.0, 8.0, 35.0] {
            let label = ordinal_to_floor_label(ord);
            assert_eq!(
                kiriko_route::floor_to_ordinal(&label),
                Some(ord),
                "label {label}"
            );
        }
    }

    #[test]
    fn export_emits_junctions_and_bidirectional_paths() {
        // Two nodes on F1 joined horizontally, plus a vertical link to F2.
        let graph = RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.70,
                    lat: 35.69,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.701,
                    lat: 35.69,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.70,
                    lat: 35.69,
                    ordinal: 1.0,
                },
            ],
            edges: vec![
                RouteEdge {
                    from: 0,
                    to: 1,
                    weight: 90_000.0,
                    ordinal: 0.0,
                    interior: Vec::new(),
                    attrs: EdgeAttrs::default(),
                },
                RouteEdge {
                    from: 0,
                    to: 2,
                    weight: 5_000.0,
                    ordinal: 0.0,
                    interior: Vec::new(),
                    attrs: EdgeAttrs::default(),
                },
            ],
        };
        let bundle = bundle_with_graph(graph);
        let net = export_network(&bundle).expect("export");

        let j: Json = serde_json::from_str(&net.junctions).unwrap();
        assert_eq!(j["name"], "net_junction");
        let jf = j["features"].as_array().unwrap();
        assert_eq!(jf.len(), 3);
        assert_eq!(jf[0]["properties"]["NODEID"], 0);
        assert_eq!(jf[0]["properties"]["PATH_COUNT"], 2); // node 0 touches both edges
        assert_eq!(jf[0]["properties"]["FLOOR"], "F1");
        assert_eq!(jf[2]["properties"]["FLOOR"], "F2");

        let p: Json = serde_json::from_str(&net.paths).unwrap();
        assert_eq!(p["name"], "net_path");
        let pf = p["features"].as_array().unwrap();
        assert_eq!(pf.len(), 4, "two undirected edges → four directed paths");
        // Forward horizontal edge 0->1.
        assert_eq!(pf[0]["properties"]["FNODEID"], 0);
        assert_eq!(pf[0]["properties"]["TNODEID"], 1);
        assert_eq!(pf[0]["properties"]["cost"].as_f64(), Some(90_000.0)); // stored weight (mm) written directly, no 2nd ×1000
        assert_eq!(pf[0]["properties"]["FFLOOR"], Json::Null); // horizontal
        // Vertical edge 0->2 carries FFLOOR/TFOOLR + passage_type.
        assert_eq!(pf[2]["properties"]["FNODEID"], 0);
        assert_eq!(pf[2]["properties"]["TNODEID"], 2);
        assert_eq!(pf[2]["properties"]["passage_type"], 1);
        assert_eq!(pf[2]["properties"]["FFLOOR"], "F1");
        assert_eq!(pf[2]["properties"]["TFOOLR"], "F2");
        // Reverse partner cross-references PATHID.
        assert_eq!(
            pf[0]["properties"]["RPATHID"],
            pf[1]["properties"]["PATHID"]
        );
    }

    #[test]
    fn export_without_graph_is_no_graph_error() {
        let doc = BundleDocument {
            metadata: BundleMetadata {
                dataset_id: "t/v".into(),
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
            features: Vec::new(),
            bounds_by_level: BTreeMap::new(),
            warnings: Vec::new(),
            stats: BundleStats {
                levels: 1,
                features: 0,
            },
            graph: None,
            facilities: None,
            spatial_context: None,
            scene: None,
            capabilities: crate::codec::CapabilityReport::default(),
        };
        let bundle = encode_bundle(&doc).unwrap();
        assert_eq!(export_network(&bundle).unwrap_err().code(), "no_graph");
    }

    #[test]
    fn export_rejects_fractional_ordinal() {
        // The accepted GDB floor-label grammar has no lossless representation
        // for a fractional ordinal, so export must reject it explicitly rather
        // than silently rounding it to an integer floor.
        let graph = RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.70,
                    lat: 35.69,
                    ordinal: 0.5,
                },
                RouteNode {
                    lon: 139.701,
                    lat: 35.69,
                    ordinal: 0.5,
                },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 100.0,
                ordinal: 0.5,
                interior: Vec::new(),
                attrs: EdgeAttrs::default(),
            }],
        };
        let bundle = bundle_with_graph(graph);
        assert_eq!(
            export_network(&bundle).unwrap_err().code(),
            "fractional_ordinal"
        );
    }

    #[test]
    fn export_preserves_edge_ordinal_differing_from_node_ordinals() {
        // An edge whose own ordinal (F2 → 1) differs from BOTH endpoint node
        // ordinals (F1 → 0) must round-trip on its own FLOOR, not the from-node's.
        let g0 = RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.70,
                    lat: 35.69,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.701,
                    lat: 35.69,
                    ordinal: 0.0,
                },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 90_000.0,
                ordinal: 1.0,
                interior: Vec::new(),
                attrs: EdgeAttrs::default(),
            }],
        };
        let net1 = export_network(&bundle_with_graph(g0.clone())).expect("first export");
        let g1 = kiriko_route::build_route_graph(&net1.junctions, &net1.paths, &[0.0, 1.0])
            .expect("re-import 1")
            .graph;
        assert_eq!(g1.edges[0].ordinal, 1.0, "edge keeps its own floor");
        assert_eq!(g1, g0, "one cycle preserves the differing edge ordinal");
        let net2 = export_network(&bundle_with_graph(g1.clone())).expect("second export");
        let g2 = kiriko_route::build_route_graph(&net2.junctions, &net2.paths, &[0.0, 1.0])
            .expect("re-import 2")
            .graph;
        assert_eq!(g2, g1, "second cycle is a fixed point");
    }

    #[test]
    fn export_preserves_fractional_cost_across_round_trip() {
        // A finite non-negative fractional cost must survive the GeoJSON
        // exactly (the importer reads it as f64), never rounded to an integer.
        let g0 = RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.70,
                    lat: 35.69,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.701,
                    lat: 35.69,
                    ordinal: 0.0,
                },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 100.5,
                ordinal: 0.0,
                interior: Vec::new(),
                attrs: EdgeAttrs::default(),
            }],
        };
        let net = export_network(&bundle_with_graph(g0.clone())).expect("export");
        let g1 = kiriko_route::build_route_graph(&net.junctions, &net.paths, &[0.0, 1.0])
            .expect("re-import")
            .graph;
        assert_eq!(g1.edges.len(), 1);
        assert_eq!(
            g1.edges[0].weight, 100.5,
            "fractional cost preserved exactly"
        );
        assert_eq!(g1, g0);
    }
}
