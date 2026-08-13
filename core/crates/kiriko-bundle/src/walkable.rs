//! Build [`kiriko_route::WalkableFloor`]s from a bundle's venue model.
//!
//! The WASM route path smooths raw A* polylines against the venue's own
//! walkable geometry (greedy-LOS string-pull, `kiriko-route` §smooth). This
//! module derives that geometry from the decoded [`BundleDocument`]: walkway
//! units become walkable polygons, and opening midpoints plus transit-unit
//! centroids become door locks that a smoothed chord must not skip — the same
//! category and geometry locks the graph synthesizer ([`crate::synth`]) uses,
//! so smoothing and the network agree on what is walkable.
//!
//! Phase 3 Task 10: smooth wasm routes against venue walkable floors.

use kiriko_model::canonical::Value;
use kiriko_model::model::FeatureType;
use kiriko_route::{Point3, Route, WalkableFloor, WalkablePolygon};

use crate::codec::BundleDocument;
use crate::synth::{linestring_midpoint, polygon_centroid};

/// Walkable-unit categories — the exact set the graph synthesizer walks.
///
/// NOTE: keep in sync with synth.rs. `unenclosedarea` is excluded on purpose:
/// it models open shop interiors, and routing must follow the real walkways
/// around them, not cut through.
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
            | "corridor"
            | "sidewalk"
    )
}

/// Transit units — their centroids become door locks, matching the hub
/// anchors the graph synthesizer uses. Kept in sync with `synth.rs`.
fn is_transit(category: &str) -> bool {
    matches!(category, "elevator" | "escalator" | "stairs")
}

/// One [`WalkableFloor`] per venue level that carries any walkable polygons
/// or locks, ordered by level ordinal. Levels with neither are omitted —
/// [`kiriko_route::smooth_route`] already treats a missing floor as identity,
/// and an empty polygon set makes nothing walkable.
pub fn walkable_floors(document: &BundleDocument) -> Vec<WalkableFloor> {
    // (ordinal, polygons, locks); ordinal-ordered, one entry per level.
    let mut floors: Vec<(f64, Vec<WalkablePolygon>, Vec<[f64; 2]>)> = Vec::new();
    for feature in &document.features {
        let Some(level_id) = feature.level_id.as_deref() else {
            continue;
        };
        let Some(ordinal) = document
            .levels
            .iter()
            .find(|l| l.id == level_id)
            .map(|l| l.ordinal)
        else {
            continue;
        };
        let Some(geometry) = feature.geometry.as_ref() else {
            continue;
        };
        let idx = match floors.iter().position(|(o, _, _)| *o == ordinal) {
            Some(i) => i,
            None => {
                floors.push((ordinal, Vec::new(), Vec::new()));
                floors.len() - 1
            }
        };
        match feature.feature_type {
            FeatureType::Unit => match feature.category.as_deref() {
                Some(cat) if is_walkway(cat) => {
                    if let Some(polygon) = walkable_polygon(geometry) {
                        floors[idx].1.push(polygon);
                    }
                }
                Some(cat) if is_transit(cat) => {
                    if let Some(lock) = polygon_centroid(geometry) {
                        floors[idx].2.push(lock);
                    }
                }
                _ => {}
            },
            FeatureType::Opening => {
                if let Some(lock) = linestring_midpoint(geometry) {
                    floors[idx].2.push(lock);
                }
            }
            _ => {}
        }
    }
    floors.sort_by(|a, b| a.0.total_cmp(&b.0));
    floors
        .into_iter()
        .filter(|(_, polygons, locks)| !polygons.is_empty() || !locks.is_empty())
        .map(|(ordinal, polygons, locks)| WalkableFloor {
            ordinal,
            polygons,
            locks,
        })
        .collect()
}

/// Exterior ring plus holes of a `Polygon`, or of the largest part of a
/// `MultiPolygon` (the same part choice as [`polygon_centroid`]). `None` for
/// other geometry or an empty exterior ring.
fn walkable_polygon(geometry: &Value) -> Option<WalkablePolygon> {
    let obj = geometry.as_object()?;
    let coords = obj.get("coordinates")?;
    let rings_of = |part: &Value| -> Vec<Vec<[f64; 2]>> {
        part.as_array()
            .map(|rings| rings.iter().map(ring_coords).collect())
            .unwrap_or_default()
    };
    let (exterior, holes) = match obj.get("type")?.as_str()? {
        "Polygon" => split_rings(rings_of(coords))?,
        "MultiPolygon" => {
            let mut best: Option<(f64, Vec<Vec<[f64; 2]>>)> = None;
            for part in coords.as_array()? {
                let rings = rings_of(part);
                let Some((exterior, _)) = split_rings(rings.clone()) else {
                    continue;
                };
                let area = ring_area_abs(&exterior);
                if best.as_ref().is_none_or(|(ba, _)| area > *ba) {
                    best = Some((area, rings));
                }
            }
            split_rings(best?.1)?
        }
        _ => return None,
    };
    Some(WalkablePolygon { exterior, holes })
}

/// First ring is the exterior; the rest are holes.
fn split_rings(rings: Vec<Vec<[f64; 2]>>) -> Option<(Vec<[f64; 2]>, Vec<Vec<[f64; 2]>>)> {
    let mut rings = rings.into_iter();
    let exterior = rings.next().filter(|r| !r.is_empty())?;
    Some((exterior, rings.collect()))
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

/// Read a GeoJSON position (`[lon, lat, ...]`) as `[lon, lat]`.
fn coord_pair(v: &Value) -> Option<[f64; 2]> {
    let arr = v.as_array()?;
    Some([arr.first()?.as_f64()?, arr.get(1)?.as_f64()?])
}

/// Flatten a GeoJSON ring (array of positions) to `[lon, lat]` vertices,
/// dropping any non-position entries.
fn ring_coords(v: &Value) -> Vec<[f64; 2]> {
    v.as_array()
        .map(|a| a.iter().filter_map(coord_pair).collect())
        .unwrap_or_default()
}

/// Route over the document's embedded graph, then pull the polyline tight
/// against the venue's walkable floors. `None` when the document has no graph
/// or no path connects the snapped endpoints — the same contract as
/// [`kiriko_route::route`]. Exposed for tests; the WASM adapter wires the
/// same two steps itself.
pub fn route_smoothed(document: &BundleDocument, origin: Point3, dest: Point3) -> Option<Route> {
    let graph = document.graph.as_ref()?;
    let raw = kiriko_route::route(graph, origin, dest)?;
    let floors = walkable_floors(document);
    Some(kiriko_route::smooth_route(raw, &floors))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::codec::{BundleMetadata, BundleStats};
    use kiriko_model::canonical::Value;
    use kiriko_model::model::{FeatureType, ImdfManifest, VenueFeature, ViewerLevel};
    use kiriko_route::{EdgeAttrs, Point3, RouteEdge, RouteGraph, RouteNode};

    // Metre-local frame near Tokyo Station: 0.0001° lon ≈ 9.1 m and 0.0001°
    // lat ≈ 11.1 m at 35°N, so corridor-scale geometry is easy to reason about.
    const LON0: f64 = 139.0;
    const LAT0: f64 = 35.0;

    /// Metre-local → WGS84: `x` metres east, `y` metres north of `(LON0, LAT0)`.
    fn m(x: f64, y: f64) -> [f64; 2] {
        [LON0 + x * 0.0001, LAT0 + y * 0.0001]
    }

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

    /// Axis-aligned closed rectangle `w` × `h` metres with its bottom-left
    /// corner at `(x0, y0)` in the metre-local frame.
    fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<[f64; 2]> {
        vec![
            m(x0, y0),
            m(x0 + w, y0),
            m(x0 + w, y0 + h),
            m(x0, y0 + h),
            m(x0, y0),
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
            spatial_context: None,
            scene: None,
            capabilities: crate::codec::CapabilityReport::default(),
        }
    }

    /// A single-edge graph whose interior bends zigzag along the centre of a
    /// 20 × 4 m corridor (nodes 5 m outside each end), all on ordinal 0.
    fn sawtooth_graph() -> RouteGraph {
        RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: m(-5.0, 0.0)[0],
                    lat: m(-5.0, 0.0)[1],
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: m(25.0, 0.0)[0],
                    lat: m(25.0, 0.0)[1],
                    ordinal: 0.0,
                },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 100_000.0,
                ordinal: 0.0,
                interior: vec![
                    m(0.0, 0.0),
                    m(5.0, 1.5),
                    m(10.0, 0.0),
                    m(15.0, 1.5),
                    m(20.0, 0.0),
                ],
                attrs: EdgeAttrs::default(),
            }],
        }
    }

    fn endpoints() -> (Point3, Point3) {
        (
            Point3 {
                lon: m(-5.0, 0.0)[0],
                lat: m(-5.0, 0.0)[1],
                ordinal: 0.0,
            },
            Point3 {
                lon: m(25.0, 0.0)[0],
                lat: m(25.0, 0.0)[1],
                ordinal: 0.0,
            },
        )
    }

    #[test]
    fn corridor_sawtooth_loses_interior_vertices_after_route_smoothed() {
        // Two walkway rectangles forming a 20 × 4 m corridor; the graph edge
        // zigzags inside it, so the raw polyline carries the full sawtooth
        // and smoothing pulls the bends away.
        let features = vec![
            feature(
                "walk0",
                FeatureType::Unit,
                "L0",
                Some("walkway"),
                polygon(&rect(0.0, 0.0, 10.0, 4.0)),
            ),
            feature(
                "walk1",
                FeatureType::Unit,
                "L0",
                Some("walkway"),
                polygon(&rect(10.0, 0.0, 10.0, 4.0)),
            ),
        ];
        let mut doc = document(&[("L0", 0.0)], features);
        let graph = sawtooth_graph();
        doc.graph = Some(graph.clone());

        let (origin, dest) = endpoints();
        let raw = kiriko_route::route(&graph, origin, dest).expect("sawtooth edge routes");
        let raw_n = raw.segments[0].coordinates.len();
        assert!(raw_n >= 6, "raw path keeps its bends, got {raw_n}");

        let smoothed = route_smoothed(&doc, origin, dest).expect("smoothed route");
        assert!(
            smoothed.segments[0].coordinates.len() < raw_n,
            "greedy-LOS must pull the sawtooth bends away"
        );
        assert_eq!(smoothed.total_weight, raw.total_weight);
    }

    #[test]
    fn no_walkways_leaves_the_route_untouched() {
        // A room-only venue carries no walkable geometry: `walkable_floors`
        // is empty and smoothing is the identity (the existing routeBundle
        // worker contract depends on this).
        let features = vec![
            feature(
                "room0",
                FeatureType::Unit,
                "L0",
                Some("room"),
                polygon(&rect(0.0, 0.0, 20.0, 4.0)),
            ),
        ];
        let mut doc = document(&[("L0", 0.0)], features);
        let graph = sawtooth_graph();
        doc.graph = Some(graph.clone());
        assert!(
            walkable_floors(&doc).is_empty(),
            "a room-only venue has no walkable floors"
        );

        let (origin, dest) = endpoints();
        let raw = kiriko_route::route(&graph, origin, dest).expect("sawtooth edge routes");
        let smoothed = route_smoothed(&doc, origin, dest).expect("smoothed route");
        assert_eq!(smoothed, raw);
    }

    #[test]
    fn opening_midpoint_locks_its_vertex_from_being_pulled_away() {
        // One walkway rectangle plus an opening whose midpoint sits on the
        // middle sawtooth vertex: the chord that would skip that vertex must
        // be rejected, so the locked vertex survives smoothing.
        let features = vec![
            feature(
                "walk0",
                FeatureType::Unit,
                "L0",
                Some("walkway"),
                polygon(&rect(0.0, 0.0, 20.0, 4.0)),
            ),
            feature(
                "op0",
                FeatureType::Opening,
                "L0",
                None,
                linestring(&[m(5.0, 1.4), m(5.0, 1.6)]),
            ),
        ];
        let mut doc = document(&[("L0", 0.0)], features);
        let graph = sawtooth_graph();
        doc.graph = Some(graph.clone());

        let (origin, dest) = endpoints();
        let smoothed = route_smoothed(&doc, origin, dest).expect("smoothed route");
        let lock = m(5.0, 1.5);
        assert!(
            smoothed.segments[0]
                .coordinates
                .iter()
                .any(|c| haversine(c, &lock) < 0.4),
            "the vertex at the door lock must survive smoothing"
        );
    }

    /// Great-circle metres between two `[lon, lat]` points.
    fn haversine(a: &[f64; 2], b: &[f64; 2]) -> f64 {
        let (lat1, lat2) = (a[1].to_radians(), b[1].to_radians());
        let dlat = lat2 - lat1;
        let dlon = (b[0] - a[0]).to_radians();
        let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
        2.0 * 6_371_000.0 * h.sqrt().asin()
    }
}
