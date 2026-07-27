#[derive(Debug, Clone, PartialEq)]
pub struct RouteGraph {
    pub nodes: Vec<RouteNode>,
    pub edges: Vec<RouteEdge>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RouteNode {
    pub lon: f64,
    pub lat: f64,
    pub ordinal: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RouteEdge {
    pub from: u32,
    pub to: u32,
    pub weight: f32,
    /// Venue level ordinal of this edge (its `net_path.FLOOR`), used for
    /// floor-aware snapping and per-floor rendering.
    pub ordinal: f64,
    /// Bend points strictly between `from` and `to`, in `from → to` order;
    /// empty when the edge is a straight chord between its endpoints.
    pub interior: Vec<[f64; 2]>,
}

/// Routing-cost units per metre. A [`RouteEdge::weight`] is expressed in
/// canonical `net_path.cost` units (millimetre-scale source cost); a
/// geometric length in metres becomes a weight via [`meters_to_cost`],
/// applied exactly once at graph synthesis. Imported edges already carry
/// source cost and are never re-scaled.
pub const COST_UNITS_PER_METER: f64 = 1000.0;

/// Convert a geometric length in metres to canonical routing-cost units.
#[must_use]
pub fn meters_to_cost(meters: f64) -> f32 {
    (meters * COST_UNITS_PER_METER) as f32
}

impl RouteGraph {
    /// A graph is routable only when it carries at least one edge: junction
    /// nodes alone never advertise Directions or Network Review. Callers gate
    /// graph-section embedding on `!is_empty()`.
    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }

    /// Full polyline of `edge`: `[from node, …interior…, to node]`.
    pub fn edge_polyline(&self, edge: &RouteEdge) -> Vec<[f64; 2]> {
        let from = &self.nodes[edge.from as usize];
        let to = &self.nodes[edge.to as usize];
        let mut out = Vec::with_capacity(edge.interior.len() + 2);
        out.push([from.lon, from.lat]);
        out.extend_from_slice(&edge.interior);
        out.push([to.lon, to.lat]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routable_graph_requires_at_least_one_edge() {
        // Nodes alone never advertise routing: a graph with junctions but no
        // edges is empty for embedding/routing purposes.
        let nodes_only = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0, ordinal: 0.0 },
            ],
            edges: Vec::new(),
        };
        assert!(nodes_only.is_empty(), "a graph with no edges is not routable");

        let with_edge = RouteGraph {
            edges: vec![RouteEdge { from: 0, to: 1, weight: 100.0, ordinal: 0.0, interior: Vec::new() }],
            ..nodes_only.clone()
        };
        assert!(!with_edge.is_empty(), "an edge-bearing graph is routable");
    }
}
