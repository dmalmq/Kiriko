#![deny(rust_2018_idioms)]

mod build;
mod floor;
mod geo_math;
mod graph;
mod query;
mod smooth;

pub use build::{RouteBuildError, RouteBuildWarning, RouteGraphBuild, build_route_graph};
pub use floor::floor_to_ordinal;
pub use graph::{
    COST_UNITS_PER_METER, EdgeAttrs, EdgeFlags, EdgeKind, PathwayRank, RouteEdge, RouteGraph,
    RouteNode, TravelDirection, VerticalKind, kind_from_key, kind_key, meters_to_cost,
    vertical_from_key, vertical_key,
};
pub use query::{Point3, Route, RouteProfile, RouteSegment, edge_allowed, route, route_with};
pub use smooth::{WalkableFloor, WalkablePolygon, smooth_route};
