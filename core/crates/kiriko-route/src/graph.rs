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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EdgeKind {
    Imported = 0,
    Skeleton = 1,
    Doorway = 2,
    Stub = 3,
    Bridge = 4,
    Chord = 5,
    Vertical = 6,
    TransitAttach = 7,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PathwayRank {
    Primary = 1,
    Secondary = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum VerticalKind {
    Elevator = 1,
    Escalator = 2,
    Stairs = 3,
}

/// Quality attributes of a [`RouteEdge`]. `Default` is the imported-graph
/// baseline, so every existing imported/test literal stays semantically
/// identical when it sets `attrs: EdgeAttrs::default()`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeAttrs {
    pub kind: EdgeKind,
    pub rank: PathwayRank,
    pub clearance_m: Option<f32>,
    pub vertical: Option<VerticalKind>,
}

impl Default for EdgeAttrs {
    fn default() -> Self {
        Self {
            kind: EdgeKind::Imported,
            rank: PathwayRank::Primary,
            clearance_m: None,
            vertical: None,
        }
    }
}

impl EdgeAttrs {
    pub fn is_default(self) -> bool {
        self == Self::default()
    }
}

/// Stable GeoJSON wire name for an [`EdgeKind`] (`net_path.EDGE_KIND`).
/// Shared by the export and import paths so the vocabulary can never drift.
#[must_use]
pub fn kind_key(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Imported => "imported",
        EdgeKind::Skeleton => "skeleton",
        EdgeKind::Doorway => "doorway",
        EdgeKind::Stub => "stub",
        EdgeKind::Bridge => "bridge",
        EdgeKind::Chord => "chord",
        EdgeKind::Vertical => "vertical",
        EdgeKind::TransitAttach => "transit_attach",
    }
}

/// Inverse of [`kind_key`]; `None` for an unknown wire value.
#[must_use]
pub fn kind_from_key(key: &str) -> Option<EdgeKind> {
    match key {
        "imported" => Some(EdgeKind::Imported),
        "skeleton" => Some(EdgeKind::Skeleton),
        "doorway" => Some(EdgeKind::Doorway),
        "stub" => Some(EdgeKind::Stub),
        "bridge" => Some(EdgeKind::Bridge),
        "chord" => Some(EdgeKind::Chord),
        "vertical" => Some(EdgeKind::Vertical),
        "transit_attach" => Some(EdgeKind::TransitAttach),
        _ => None,
    }
}

/// Stable GeoJSON wire name for a [`VerticalKind`]
/// (`net_path.TRANSITION_CATEGORY`).
#[must_use]
pub fn vertical_key(kind: VerticalKind) -> &'static str {
    match kind {
        VerticalKind::Elevator => "elevator",
        VerticalKind::Escalator => "escalator",
        VerticalKind::Stairs => "stairs",
    }
}

/// Inverse of [`vertical_key`]; `None` for an unknown wire value.
#[must_use]
pub fn vertical_from_key(key: &str) -> Option<VerticalKind> {
    match key {
        "elevator" => Some(VerticalKind::Elevator),
        "escalator" => Some(VerticalKind::Escalator),
        "stairs" => Some(VerticalKind::Stairs),
        _ => None,
    }
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
    /// Generation-quality attributes (kind, rank, clearance, vertical).
    pub attrs: EdgeAttrs,
}

impl RouteEdge {
    /// Straight edge with default (imported) attributes; used by synthesis
    /// going forward.
    pub fn new(from: u32, to: u32, weight: f32, ordinal: f64) -> Self {
        Self {
            from,
            to,
            weight,
            ordinal,
            interior: Vec::new(),
            attrs: EdgeAttrs::default(),
        }
    }
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
            ],
            edges: Vec::new(),
        };
        assert!(
            nodes_only.is_empty(),
            "a graph with no edges is not routable"
        );

        let with_edge = RouteGraph {
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 100.0,
                ordinal: 0.0,
                interior: Vec::new(),
                attrs: EdgeAttrs::default(),
            }],
            ..nodes_only.clone()
        };
        assert!(!with_edge.is_empty(), "an edge-bearing graph is routable");
    }

    #[test]
    fn edge_attrs_default_is_imported_primary_unknown_clearance() {
        let a = EdgeAttrs::default();
        assert_eq!(a.kind, EdgeKind::Imported);
        assert_eq!(a.rank, PathwayRank::Primary);
        assert_eq!(a.clearance_m, None);
        assert_eq!(a.vertical, None);
        assert!(a.is_default());
    }

    #[test]
    fn vertical_attrs_require_a_kind() {
        let a = EdgeAttrs {
            kind: EdgeKind::Vertical,
            rank: PathwayRank::Primary,
            clearance_m: None,
            vertical: Some(VerticalKind::Elevator),
        };
        assert!(!a.is_default());
        assert_eq!(a.vertical.is_some(), a.kind == EdgeKind::Vertical);
    }
}
