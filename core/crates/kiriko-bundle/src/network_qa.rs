//! In-memory network QA findings (KVB §11 payload, computed before encode).
//!
//! Opening coverage is omitted in v1: doorway edges do not store Opening ids.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use kiriko_route::{
    RouteEdge, RouteGraph, RouteProfile, TravelDirection, edge_allowed,
};

use crate::codec::BundleDocument;
use crate::synth::haversine_m;

const STRETCH_SAMPLES: usize = 50;
const STRETCH_MIN_M: f64 = 10.0;
const STRETCH_MAX_M: f64 = 40.0;

#[derive(Debug, Clone, PartialEq)]
pub struct NetworkFinding {
    pub code: String,
    /// 0 info, 1 warning.
    pub severity: u8,
    pub detail: String,
    pub feature_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StretchSummary {
    pub sample_count: u32,
    pub rho_max: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NetworkQa {
    pub findings: Vec<NetworkFinding>,
    pub stretch: Option<StretchSummary>,
}

#[must_use]
pub fn analyze_network(document: &BundleDocument) -> NetworkQa {
    let Some(graph) = document.graph.as_ref() else {
        return NetworkQa {
            findings: Vec::new(),
            stretch: None,
        };
    };
    let n = graph.nodes.len();
    let mut parent: Vec<usize> = (0..n).collect();
    let mut degree = vec![0u32; n];
    for e in &graph.edges {
        let u = e.from as usize;
        let v = e.to as usize;
        if u >= n || v >= n {
            continue;
        }
        degree[u] += 1;
        degree[v] += 1;
        let a = uf_find(&mut parent, u);
        let b = uf_find(&mut parent, v);
        if a != b {
            parent[a] = b;
        }
    }
    let mut component_roots = 0usize;
    if n > 0 {
        let mut seen = vec![false; n];
        for i in 0..n {
            let r = uf_find(&mut parent, i);
            if seen[r] == false {
                seen[r] = true;
                component_roots += 1;
            }
        }
    }
    let isolated = degree.iter().filter(|d| **d == 0).count();
    let mut findings = Vec::new();
    if component_roots > 1 {
        findings.push(NetworkFinding {
            code: "disconnected_component".into(),
            severity: 1,
            detail: format!("components={component_roots}"),
            feature_id: None,
        });
    }
    if isolated > 0 {
        findings.push(NetworkFinding {
            code: "isolated_node".into(),
            severity: 1,
            detail: format!("isolated={isolated}"),
            feature_id: None,
        });
    }
    findings.sort_by(|a, b| a.code.cmp(&b.code));
    NetworkQa {
        findings,
        stretch: stretch_summary(graph),
    }
}

fn uf_find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
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
        if edge_allowed(e, &profile) == false {
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

fn stretch_summary(graph: &RouteGraph) -> Option<StretchSummary> {
    let n = graph.nodes.len();
    if n < 2 {
        return None;
    }
    let adj = walking_adj(graph);
    let mut sample_count = 0u32;
    let mut rho_max = 0.0f32;
    for i in 0..n {
        if sample_count as usize >= STRETCH_SAMPLES {
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
        if candidate == false {
            continue;
        }
        let dist = dijkstra_m(&adj, i);
        for j in (i + 1)..n {
            if sample_count as usize >= STRETCH_SAMPLES {
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
            let Some(net) = dist[j] else {
                continue;
            };
            if net <= 0.0 {
                continue;
            }
            let rho = (net / eu) as f32;
            if rho > rho_max {
                rho_max = rho;
            }
            sample_count += 1;
        }
    }
    if sample_count == 0 {
        None
    } else {
        Some(StretchSummary {
            sample_count,
            rho_max,
        })
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{BundleMetadata, BundleStats, CapabilityReport};
    use kiriko_model::model::{ImdfManifest, ViewerLevel};
    use kiriko_route::RouteNode;
    use std::collections::BTreeMap;

    fn node(lon: f64, lat: f64, ordinal: f64) -> RouteNode {
        RouteNode { lon, lat, ordinal }
    }

    fn edge(from: u32, to: u32) -> RouteEdge {
        RouteEdge::new(from, to, 1.0, 0.0)
    }

    fn document_with_graph(graph: RouteGraph) -> BundleDocument {
        BundleDocument {
            metadata: BundleMetadata {
                dataset_id: "qa".into(),
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
            graph: Some(graph),
            facilities: None,
            spatial_context: None,
            scene: None,
            capabilities: CapabilityReport::default(),
        }
    }

    fn codes(qa: &NetworkQa) -> Vec<&str> {
        qa.findings.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn analyze_network_disconnected_component() {
        let g = RouteGraph {
            nodes: vec![
                node(0.0, 0.0, 0.0),
                node(0.0001, 0.0, 0.0),
                node(0.0002, 0.0, 0.0),
                node(0.0003, 0.0, 0.0),
            ],
            edges: vec![edge(0, 1), edge(2, 3)],
        };
        let qa = analyze_network(&document_with_graph(g));
        assert!(
            codes(&qa).contains(&"disconnected_component"),
            "findings = {:?}",
            qa.findings
        );
        let f = qa
            .findings
            .iter()
            .find(|f| f.code == "disconnected_component")
            .expect("disconnected finding");
        assert_eq!(f.severity, 1);
        assert_eq!(f.detail, "components=2");
        assert_eq!(f.feature_id, None);
    }

    #[test]
    fn analyze_network_isolated_node() {
        let g = RouteGraph {
            nodes: vec![node(0.0, 0.0, 0.0)],
            edges: Vec::new(),
        };
        let qa = analyze_network(&document_with_graph(g));
        assert!(
            codes(&qa).contains(&"isolated_node"),
            "findings = {:?}",
            qa.findings
        );
        let f = qa
            .findings
            .iter()
            .find(|f| f.code == "isolated_node")
            .expect("isolated finding");
        assert_eq!(f.severity, 1);
        assert_eq!(f.detail, "isolated=1");
        assert_eq!(f.feature_id, None);
    }

    /// Equirectangular metres at the equator (same sphere as `haversine_m`).
    fn lonlat_at_m(east_m: f64, north_m: f64) -> (f64, f64) {
        let m_per_deg = 6_371_000.0 * std::f64::consts::PI / 180.0;
        (east_m / m_per_deg, north_m / m_per_deg)
    }

    #[test]
    fn analyze_network_stretch_rho_max() {
        // A--20m--M--20m--B with A-B Euclidean 20 m => rho = 2.
        let (ax, ay) = lonlat_at_m(0.0, 0.0);
        let (mx, my) = lonlat_at_m(10.0, 300.0_f64.sqrt());
        let (bx, by) = lonlat_at_m(20.0, 0.0);
        let g = RouteGraph {
            nodes: vec![node(ax, ay, 0.0), node(mx, my, 0.0), node(bx, by, 0.0)],
            edges: vec![edge(0, 1), edge(1, 2)],
        };
        let qa = analyze_network(&document_with_graph(g));
        let stretch = qa.stretch.expect("stretch samples");
        assert!(stretch.sample_count > 0);
        assert!(
            (stretch.rho_max - 2.0).abs() < 0.15,
            "rho_max = {}",
            stretch.rho_max
        );
    }

    #[test]
    fn analyze_network_cross_floor_pair_is_never_sampled() {
        let (ax, ay) = lonlat_at_m(0.0, 0.0);
        let (bx, by) = lonlat_at_m(20.0, 0.0);
        let g = RouteGraph {
            nodes: vec![node(ax, ay, 0.0), node(bx, by, 1.0)],
            edges: vec![edge(0, 1)],
        };
        let qa = analyze_network(&document_with_graph(g));
        assert_eq!(qa.stretch, None);
        assert_eq!(
            codes(&qa).contains(&"disconnected_component"),
            false,
            "one component, findings = {:?}",
            qa.findings
        );
    }
}
