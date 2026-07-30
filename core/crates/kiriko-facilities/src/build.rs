use std::collections::BTreeSet;
use std::fmt;

use geojson::{FeatureCollection, GeoJson, Value};

use crate::types::{Facilities, Facility, FacilityAnchor};

/// Non-fatal problem encountered while building facilities.
#[derive(Debug, Clone, PartialEq)]
pub struct FacilityBuildWarning {
    pub code: String,
    pub detail: String,
}

/// Fatal error: the input GeoJSON could not be parsed at all.
#[derive(Debug, Clone, PartialEq)]
pub struct FacilityBuildError {
    pub message: String,
}

impl fmt::Display for FacilityBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FacilityBuildError {}

/// Build a deterministic facility list from `Facility_Merge` GeoJSON.
///
/// Features carry `name`/`floor`/`image` properties and a Point geometry.
/// `floor` maps via [`kiriko_route::floor_to_ordinal`]; facilities on
/// unmappable floors are dropped with an `unmapped_floor` warning. `icon` is
/// the basename of `image` without extension (empty when absent).
///
/// Each facility keeps its real GDB position. `anchor` is that same position
/// used as the "Route here" destination — the A\* router snaps it to the
/// nearest node at query time — and is set only when the facility's floor
/// carries at least one route-graph node. Facilities on a floor with no
/// network get `anchor = None`, so no routing is offered there.
pub fn build_facilities(
    facilities_geojson: &str,
    graph: &kiriko_route::RouteGraph,
) -> Result<(Facilities, Vec<FacilityBuildWarning>), FacilityBuildError> {
    let collection = parse_collection(facilities_geojson)?;
    let mut warnings = Vec::new();

    // Ordinals (by bit pattern, since f64 is not `Ord`) that carry at least
    // one routing node. `floor_to_ordinal` produces both these node ordinals
    // and each facility's ordinal, so identical floors share exact bits.
    let routable_ordinals: BTreeSet<u64> =
        graph.nodes.iter().map(|n| n.ordinal.to_bits()).collect();

    let mut items = Vec::new();
    for feature in &collection.features {
        let Some(Value::Point(coords)) = feature.geometry.as_ref().map(|g| &g.value) else {
            continue;
        };
        let (Some(&lon), Some(&lat)) = (coords.first(), coords.get(1)) else {
            continue;
        };
        let name = prop(&feature.properties, "name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let floor = prop(&feature.properties, "floor")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let Some(ordinal) = kiriko_route::floor_to_ordinal(floor) else {
            warnings.push(FacilityBuildWarning {
                code: "unmapped_floor".into(),
                detail: format!("facility {name:?} floor {floor:?} has no ordinal mapping"),
            });
            continue;
        };
        let icon = prop(&feature.properties, "image")
            .and_then(|v| v.as_str())
            .map(icon_of)
            .unwrap_or_default();
        let anchor = routable_ordinals
            .contains(&ordinal.to_bits())
            .then_some(FacilityAnchor { lon, lat, ordinal });
        items.push(Facility {
            lon,
            lat,
            ordinal,
            name,
            icon,
            anchor,
        });
    }

    items.sort_by(|a, b| {
        (
            a.ordinal.to_bits(),
            a.lon.to_bits(),
            a.lat.to_bits(),
            &a.name,
        )
            .cmp(&(
                b.ordinal.to_bits(),
                b.lon.to_bits(),
                b.lat.to_bits(),
                &b.name,
            ))
    });

    Ok((Facilities { items }, warnings))
}

/// Basename
fn icon_of(image: &str) -> String {
    let base = image.rsplit(['/', '\\']).next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 => base[..i].to_string(),
        _ => base.to_string(),
    }
}

fn parse_collection(src: &str) -> Result<FeatureCollection, FacilityBuildError> {
    let geojson: GeoJson = src.parse().map_err(|e| FacilityBuildError {
        message: format!("invalid facilities GeoJSON: {e}"),
    })?;
    FeatureCollection::try_from(geojson).map_err(|e| FacilityBuildError {
        message: format!("facilities GeoJSON is not a FeatureCollection: {e}"),
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

    // Facility_Merge-shaped features: `name`/`floor`/`image`, no `nodeid1`.
    // Store A + Store B are on F1 (ordinal 0, which the graph covers);
    // Upstairs is on F2 (ordinal 1, no node); Bad has an unmappable floor.
    const FAC: &str = r#"{"type":"FeatureCollection","features":[
 {"type":"Feature","properties":{"name":"Store A","floor":"F1","image":"/marker/ticket.png"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
 {"type":"Feature","properties":{"name":"Store B","floor":"F1","image":""},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
 {"type":"Feature","properties":{"name":"Upstairs","floor":"F2","image":"/marker/escalator.png"},"geometry":{"type":"Point","coordinates":[139.002,35.0]}},
 {"type":"Feature","properties":{"name":"Bad","floor":"garbage","image":""},"geometry":{"type":"Point","coordinates":[139.0,35.0]}}]}"#;

    fn graph() -> kiriko_route::RouteGraph {
        kiriko_route::RouteGraph {
            nodes: vec![kiriko_route::RouteNode {
                lon: 139.5,
                lat: 35.5,
                ordinal: 0.0,
            }],
            edges: vec![],
        }
    }

    #[test]
    fn builds_icon_and_real_position_anchor() {
        let (f, warns) = build_facilities(FAC, &graph()).unwrap();
        assert_eq!(f.items.len(), 3); // "Bad" dropped (unmapped floor)
        let a = f.items.iter().find(|x| x.name == "Store A").unwrap();
        assert_eq!(a.icon, "ticket");
        // Anchor is the facility's OWN position, never the node's — the router
        // snaps to the nearest node at query time.
        assert_eq!(
            a.anchor,
            Some(FacilityAnchor {
                lon: 139.0,
                lat: 35.0,
                ordinal: 0.0
            })
        );
        let b = f.items.iter().find(|x| x.name == "Store B").unwrap();
        assert_eq!(b.icon, ""); // empty image -> pin fallback downstream
        assert_eq!(
            b.anchor,
            Some(FacilityAnchor {
                lon: 139.001,
                lat: 35.0,
                ordinal: 0.0
            })
        );
        assert!(warns.iter().any(|w| w.code == "unmapped_floor"));
    }

    #[test]
    fn marker_positions_are_verbatim_gdb_coordinates() {
        let (f, _) = build_facilities(FAC, &graph()).unwrap();
        let a = f.items.iter().find(|x| x.name == "Store A").unwrap();
        assert_eq!((a.lon, a.lat), (139.0, 35.0)); // not snapped to 139.5/35.5
    }

    #[test]
    fn anchor_none_on_floor_without_network() {
        let (f, _) = build_facilities(FAC, &graph()).unwrap();
        let up = f.items.iter().find(|x| x.name == "Upstairs").unwrap();
        assert_eq!(up.icon, "escalator");
        assert_eq!(up.anchor, None); // F2 (ordinal 1) has no graph node
    }

    #[test]
    fn deterministic() {
        assert_eq!(
            build_facilities(FAC, &graph()).unwrap().0,
            build_facilities(FAC, &graph()).unwrap().0
        );
    }
}
