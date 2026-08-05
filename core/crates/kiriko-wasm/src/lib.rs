//! Browser WASM bindings for Kiriko venue bundle decoding.
//!
//! `decodeBundle` is synchronous and callable any time after the module's
//! single asynchronous default-export/`init()` has resolved. Decoding never
//! throws for domain (bundle-format) failures: it always resolves to a
//! structured `DecodeResponseDto` JS object, discriminated by `ok`, built
//! with `serde-wasm-bindgen` (not stringified — the venue payload crosses
//! as a real JS object).
//!
//! Publication remains native (`kiriko-node`); this crate only decodes.
//!
//! Phase Two Task 4: WASM decode adapter.

#![deny(rust_2018_idioms)]

use std::collections::BTreeMap;

use kiriko_bundle::{BundleDocument, BundleError, decode_bundle};
use kiriko_model::canonical::{Object as CanonicalObject, Value as CanonicalValue};
use kiriko_model::model::{Bounds, ImdfManifest, VenueFeature, ViewerLevel, ViewerWarning};
use kiriko_route::{Point3, Route};
use serde::Serialize;
use serde_json::Value as JsonValue;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestDto {
    version: String,
    language: String,
    rest: JsonValue,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelDto {
    id: String,
    ordinal: f64,
    label: BTreeMap<String, String>,
    short_name: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeatureDto {
    id: String,
    feature_type: String,
    level_id: Option<String>,
    geometry: Option<JsonValue>,
    center: Option<(f64, f64)>,
    labels: BTreeMap<String, String>,
    alt_labels: BTreeMap<String, String>,
    category: Option<String>,
    accessibility: Vec<String>,
    restriction: Option<String>,
    source_properties: JsonValue,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WarningDto {
    code: String,
    message: String,
    feature_id: Option<String>,
    archive_entry: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsDto {
    levels: u32,
    features: u32,
}

/// Decoded venue payload. `bounds_by_level` is `[levelId, bounds][]`, where
/// `bounds` is `[west, south, east, north]` (matches the browser's existing
/// `BoundsTuple`). `dataset_id`/`version` are the bundle's own publish
/// identity (`BundleMetadata`), not part of the IMDF content itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecodedVenueDto {
    dataset_id: String,
    version: u32,
    venue_id: String,
    manifest: ManifestDto,
    levels: Vec<LevelDto>,
    features: Vec<FeatureDto>,
    bounds_by_level: Vec<(String, (f64, f64, f64, f64))>,
    warnings: Vec<WarningDto>,
    stats: StatsDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecodeErrorDto {
    code: String,
    message: String,
}

/// Structured success/failure result of [`decode_bundle_js`]. `has_graph`
/// reports whether the decoded bundle carries a §5 network graph, so the
/// viewer can gate routing UI without attempting a route query; likewise
/// `has_facilities` reports a §7 point-facilities section.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecodeResponseDto {
    ok: bool,
    venue: Option<DecodedVenueDto>,
    error: Option<DecodeErrorDto>,
    has_graph: bool,
    has_facilities: bool,
}

fn canonical_to_json(value: &CanonicalValue) -> JsonValue {
    match value {
        CanonicalValue::Null => JsonValue::Null,
        CanonicalValue::Bool(b) => JsonValue::Bool(*b),
        // Bundle decode already validates every reachable number is finite,
        // so `from_f64` never returns `None` here; `Null` is a defensive
        // fallback only.
        CanonicalValue::Number(n) => {
            serde_json::Number::from_f64(*n).map_or(JsonValue::Null, JsonValue::Number)
        }
        CanonicalValue::String(s) => JsonValue::String(s.clone()),
        CanonicalValue::Array(items) => {
            JsonValue::Array(items.iter().map(canonical_to_json).collect())
        }
        CanonicalValue::Object(obj) => JsonValue::Object(canonical_object_to_json(obj)),
    }
}

fn canonical_object_to_json(obj: &CanonicalObject) -> serde_json::Map<String, JsonValue> {
    obj.iter()
        .map(|(k, v)| (k.clone(), canonical_to_json(v)))
        .collect()
}

fn manifest_dto(manifest: &ImdfManifest) -> ManifestDto {
    ManifestDto {
        version: manifest.version.clone(),
        language: manifest.language.clone(),
        rest: JsonValue::Object(canonical_object_to_json(&manifest.rest)),
    }
}

fn level_dto(level: &ViewerLevel) -> LevelDto {
    LevelDto {
        id: level.id.clone(),
        ordinal: level.ordinal,
        label: level.label.clone(),
        short_name: level.short_name.clone(),
    }
}

fn feature_dto(feature: &VenueFeature) -> FeatureDto {
    FeatureDto {
        id: feature.id.clone(),
        feature_type: feature.feature_type.as_str().to_string(),
        level_id: feature.level_id.clone(),
        geometry: feature.geometry.as_ref().map(canonical_to_json),
        center: feature.center,
        labels: feature.labels.clone(),
        alt_labels: feature.alt_labels.clone(),
        category: feature.category.clone(),
        accessibility: feature.accessibility.clone(),
        restriction: feature.restriction.clone(),
        source_properties: JsonValue::Object(canonical_object_to_json(&feature.source_properties)),
    }
}

fn warning_dto(warning: &ViewerWarning) -> WarningDto {
    WarningDto {
        code: warning.code.as_str().to_string(),
        message: warning.message.clone(),
        feature_id: warning.feature_id.clone(),
        archive_entry: warning.archive_entry.clone(),
    }
}

fn bounds_tuple(bounds: &Bounds) -> (f64, f64, f64, f64) {
    (bounds.west, bounds.south, bounds.east, bounds.north)
}

fn document_dto(document: BundleDocument) -> DecodedVenueDto {
    DecodedVenueDto {
        dataset_id: document.metadata.dataset_id,
        version: document.metadata.version,
        venue_id: document.venue_id,
        manifest: manifest_dto(&document.manifest),
        levels: document.levels.iter().map(level_dto).collect(),
        features: document.features.iter().map(feature_dto).collect(),
        bounds_by_level: document
            .bounds_by_level
            .iter()
            .map(|(id, bounds)| (id.clone(), bounds_tuple(bounds)))
            .collect(),
        warnings: document.warnings.iter().map(warning_dto).collect(),
        stats: StatsDto {
            levels: document.stats.levels,
            features: document.stats.features,
        },
    }
}

fn error_dto(err: &BundleError) -> DecodeErrorDto {
    DecodeErrorDto {
        code: err.code.as_str().to_string(),
        message: err.message.clone(),
    }
}

/// Serialize `response` via `serde-wasm-bindgen`, using plain JS objects
/// (not ES `Map`s) and `null` (not `undefined`) for absent optional
/// fields, matching the browser's existing `Record<string, unknown>`
/// contracts (e.g. `sourceProperties`). Every field is a finite number,
/// string, bool, or nested combination thereof, so this cannot fail in
/// practice; the fallback keeps the same `DecodeResponseDto` shape rather
/// than panicking (a WASM panic traps the module instance).
fn to_js(response: &DecodeResponseDto) -> JsValue {
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response.serialize(&serializer).unwrap_or_else(|e| {
        let fallback = DecodeResponseDto {
            ok: false,
            venue: None,
            error: Some(DecodeErrorDto {
                code: "invalid_bundle".to_string(),
                message: format!("failed to serialize decoded venue: {e}"),
            }),
            has_graph: false,
            has_facilities: false,
        };
        fallback
            .serialize(&serializer)
            .expect("fallback decode response must serialize")
    })
}

/// A decoded bundle advertises a routable graph only when it carries at least
/// one edge; a nodes-only graph never enables Directions or Network Review.
fn has_routable_graph(document: &BundleDocument) -> bool {
    document
        .graph
        .as_ref()
        .is_some_and(|graph| !graph.is_empty())
}

/// Decode `bytes` (a `kvb1` bundle) into a structured JS value shaped as
/// `{ ok, venue, error }`, where `venue`/`error` are `null` on the side
/// that does not apply. Domain failures (an unrecognized format, version,
/// or corrupted payload) never throw; only truly unexpected bridge
/// failures would (see [`to_js`]).
#[wasm_bindgen(js_name = "decodeBundle")]
pub fn decode_bundle_js(bytes: &[u8]) -> JsValue {
    let response = match decode_bundle(bytes) {
        Ok(document) => {
            let has_graph = has_routable_graph(&document);
            let has_facilities = document.facilities.is_some();
            DecodeResponseDto {
                ok: true,
                venue: Some(document_dto(document)),
                error: None,
                has_graph,
                has_facilities,
            }
        }
        Err(err) => DecodeResponseDto {
            ok: false,
            venue: None,
            error: Some(error_dto(&err)),
            has_graph: false,
            has_facilities: false,
        },
    };
    to_js(&response)
}

// -- Route query (kiriko-route-slice Task 4) --------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteSegmentDto {
    ordinal: f64,
    coordinates: Vec<[f64; 2]>,
}

/// Computed route serialized as
/// `{ segments:[{ordinal,coordinates}], totalWeight, originProjected, destProjected }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteDto {
    pub(crate) segments: Vec<RouteSegmentDto>,
    pub(crate) total_weight: f32,
    pub(crate) origin_projected: [f64; 3],
    pub(crate) dest_projected: [f64; 3],
}

impl From<Route> for RouteDto {
    fn from(route: Route) -> Self {
        RouteDto {
            segments: route
                .segments
                .into_iter()
                .map(|s| RouteSegmentDto {
                    ordinal: s.ordinal,
                    coordinates: s.coordinates,
                })
                .collect(),
            total_weight: route.total_weight,
            origin_projected: route.origin_projected,
            dest_projected: route.dest_projected,
        }
    }
}

/// Non-wasm core of [`route_bundle`]: route over the document's embedded
/// graph section. `None` when the bundle has no graph (no network was
/// compiled in) or when the snapped endpoints are disconnected.
fn route_in_document(document: &BundleDocument, origin: Point3, dest: Point3) -> Option<RouteDto> {
    let graph = document.graph.as_ref()?;
    kiriko_route::route(graph, origin, dest).map(RouteDto::from)
}

/// Route over a `kvb1` bundle's embedded network graph. `o_*`/`d_*` are the
/// origin/destination as lon/lat plus level ordinal. Returns `null` when the
/// bundle carries no graph section or no path connects the snapped
/// endpoints; otherwise `{ nodes: [{lon, lat, ordinal}], totalWeight }`,
/// serialized with the same json-compatible `serde-wasm-bindgen` serializer
/// as [`to_js`]. Bundle-format failures throw (unlike [`decode_bundle_js`],
/// which reports them structurally).
#[wasm_bindgen(js_name = "routeBundle")]
pub fn route_bundle(
    bundle: &[u8],
    o_lon: f64,
    o_lat: f64,
    o_ord: f64,
    d_lon: f64,
    d_lat: f64,
    d_ord: f64,
) -> Result<JsValue, JsError> {
    let document = decode_bundle(bundle).map_err(|e| JsError::new(&e.message))?;
    let origin = Point3 {
        lon: o_lon,
        lat: o_lat,
        ordinal: o_ord,
    };
    let dest = Point3 {
        lon: d_lon,
        lat: d_lat,
        ordinal: d_ord,
    };
    let Some(route) = route_in_document(&document, origin, dest) else {
        return Ok(JsValue::NULL);
    };
    route
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsError::new(&e.to_string()))
}

// -- Facilities query (point-facility-poi Task 5) ---------------------------

/// Route-graph anchor of a facility, `{lon, lat, ordinal}`; serialized as
/// `null` when the facility has no anchor.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FacilityAnchorDto {
    lon: f64,
    lat: f64,
    ordinal: f64,
}

/// A point facility: `{lon, lat, ordinal, name, icon, anchor}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FacilityDto {
    lon: f64,
    lat: f64,
    ordinal: f64,
    name: String,
    icon: String,
    anchor: Option<FacilityAnchorDto>,
}

impl From<&kiriko_facilities::Facility> for FacilityDto {
    fn from(facility: &kiriko_facilities::Facility) -> Self {
        FacilityDto {
            lon: facility.lon,
            lat: facility.lat,
            ordinal: facility.ordinal,
            name: facility.name.clone(),
            icon: facility.icon.clone(),
            anchor: facility.anchor.map(|a| FacilityAnchorDto {
                lon: a.lon,
                lat: a.lat,
                ordinal: a.ordinal,
            }),
        }
    }
}

/// Non-wasm core of [`facilities_js`]: the document's embedded facilities
/// section as DTOs. Empty when the bundle carries no §7 facilities section.
fn facilities_in_document(document: &BundleDocument) -> Vec<FacilityDto> {
    document
        .facilities
        .as_ref()
        .map(|f| f.items.iter().map(FacilityDto::from).collect())
        .unwrap_or_default()
}

/// List a `kvb1` bundle's embedded point facilities. Returns `[]` when the
/// bundle carries no facilities section; otherwise
/// `[{lon, lat, ordinal, name, icon, anchor}]` with `anchor`
/// `{lon, lat, ordinal}` or `null`, serialized with the same json-compatible
/// `serde-wasm-bindgen` serializer as [`to_js`]. Bundle-format failures
/// throw (unlike [`decode_bundle_js`], which reports them structurally).
#[wasm_bindgen(js_name = "facilities")]
pub fn facilities_js(bundle: &[u8]) -> Result<JsValue, JsError> {
    let document = decode_bundle(bundle).map_err(|e| JsError::new(&e.message))?;
    facilities_in_document(&document)
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Export the bundle's §5 routing graph as `{ junctions, paths }` — each a
/// `net_junction` / `net_path` GeoJSON `FeatureCollection` string (see
/// `kiriko_bundle::export_network`). Lets the viewer render the generated
/// network floor by floor. Throws on decode failure or when the bundle
/// carries no graph.
#[wasm_bindgen(js_name = "exportNetwork")]
pub fn export_network_js(bundle: &[u8]) -> Result<JsValue, JsError> {
    let network = kiriko_bundle::export_network(bundle).map_err(|e| JsError::new(&e.message()))?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NetworkDto {
        junctions: String,
        paths: String,
    }
    NetworkDto {
        junctions: network.junctions,
        paths: network.paths,
    }
    .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
    .map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Cursor, Write};
    use std::path::PathBuf;

    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    use kiriko_bundle::{BundleMetadata, compile_imdf, compile_imdf_with_network};

    use super::*;

    // Task 1 (kiriko-route) GeoJSON constants, mirrored from kiriko-bundle's
    // graph-embedding test: three junctions (two on F1/ordinal 0, one on
    // F2/ordinal 1) and three paths, one dangling to the missing NODEID 99.
    const NETWORK_JUNCTIONS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
      {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
      {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F2"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}}]}"#;
    const NETWORK_PATHS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}},
      {"type":"Feature","properties":{"FNODEID":2,"TNODEID":3,"cost":5000},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.001,35.0]]]}},
      {"type":"Feature","properties":{"FNODEID":2,"TNODEID":99,"cost":10},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.002,35.0]]]}}]}"#;

    fn build_minimal_imdf_zip() -> Vec<u8> {
        let dir =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/minimal-imdf");
        let mut names: Vec<String> = fs::read_dir(&dir)
            .expect("read fixtures dir")
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                (!name.starts_with('.')).then_some(name)
            })
            .collect();
        names.sort();
        let mut cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(&mut cursor);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6));
        for name in names {
            let data = fs::read(dir.join(&name)).expect("read fixture");
            writer.start_file(name, options).expect("start zip entry");
            writer.write_all(&data).expect("write zip entry");
        }
        writer.finish().expect("finish zip");
        cursor.into_inner()
    }

    fn metadata() -> BundleMetadata {
        BundleMetadata {
            dataset_id: "test-bundle".to_string(),
            version: 1,
        }
    }

    fn compile_with_graph() -> Vec<u8> {
        let source = build_minimal_imdf_zip();
        compile_imdf_with_network(
            &source,
            metadata(),
            Some(NETWORK_JUNCTIONS),
            Some(NETWORK_PATHS),
            None,
            false,
            false,
        )
        .expect("fixture + network compiles")
        .bytes
    }

    // Task 2 (kiriko-facilities) GeoJSON: Store A on F1, Store B on F2. Both
    // floors carry network nodes, so each facility anchors to its OWN position
    // (icon derived from `image`; the router snaps to the nearest node at
    // query time).
    const FACILITIES: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"name":"Store A","floor":"F1","image":"/marker/ticket.png"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
      {"type":"Feature","properties":{"name":"Store B","floor":"F2","image":""},"geometry":{"type":"Point","coordinates":[139.001,35.0]}}]}"#;

    fn compile_with_facilities() -> Vec<u8> {
        let source = build_minimal_imdf_zip();
        compile_imdf_with_network(
            &source,
            metadata(),
            Some(NETWORK_JUNCTIONS),
            Some(NETWORK_PATHS),
            Some(FACILITIES),
            false,
            false,
        )
        .expect("fixture + network + facilities compiles")
        .bytes
    }

    #[test]
    fn route_returns_floor_grouped_segments() {
        let bundle = compile_with_graph();
        let document = decode_bundle(&bundle).expect("bundle decodes");
        let route = route_in_document(
            &document,
            Point3 {
                lon: 139.0,
                lat: 35.0,
                ordinal: 0.0,
            },
            Point3 {
                lon: 139.001,
                lat: 35.0,
                ordinal: 0.0,
            },
        )
        .expect("node 1 to node 2 must route");
        assert!(!route.segments.is_empty());
        assert_eq!(route.segments[0].ordinal, 0.0);
        assert!(route.segments[0].coordinates.len() >= 2);
        assert_eq!(route.origin_projected.len(), 3);
        assert_eq!(route.total_weight, 100.0);
    }

    #[test]
    fn facilities_returns_items_for_bundle_with_facilities() {
        let bundle = compile_with_facilities();
        let document = decode_bundle(&bundle).expect("bundle decodes");
        assert!(document.facilities.is_some(), "hasFacilities must be true");

        let items = facilities_in_document(&document);
        assert_eq!(items.len(), 2);

        // Sorted by (ordinal, lon, lat, name): Store A (F1) before Store B (F2).
        let store_a = &items[0];
        assert_eq!(store_a.name, "Store A");
        assert_eq!(store_a.icon, "ticket");
        assert_eq!(store_a.lon, 139.0);
        assert_eq!(store_a.lat, 35.0);
        assert_eq!(store_a.ordinal, 0.0);
        let anchor = store_a
            .anchor
            .as_ref()
            .expect("F1 carries network, so Store A anchors to its own position");
        assert_eq!(anchor.lon, 139.0);
        assert_eq!(anchor.lat, 35.0);
        assert_eq!(anchor.ordinal, 0.0);

        let store_b = &items[1];
        assert_eq!(store_b.name, "Store B");
        assert_eq!(store_b.ordinal, 1.0);
        let anchor_b = store_b
            .anchor
            .as_ref()
            .expect("F2 carries a network node, so Store B anchors to its own position");
        assert_eq!(anchor_b.lon, 139.001);
        assert_eq!(anchor_b.lat, 35.0);
        assert_eq!(anchor_b.ordinal, 1.0);
    }

    #[test]
    fn facilities_empty_for_bundle_without_section() {
        let bundle = compile_with_graph();
        let document = decode_bundle(&bundle).expect("bundle decodes");
        assert!(document.facilities.is_none(), "hasFacilities must be false");
        assert!(
            facilities_in_document(&document).is_empty(),
            "a bundle with no facilities section must yield an empty list"
        );
    }

    #[test]
    fn decode_response_reports_graph_presence() {
        let with_graph = compile_with_graph();
        let document = decode_bundle(&with_graph).expect("bundle decodes");
        assert!(document.graph.is_some());

        let source = build_minimal_imdf_zip();
        let without_graph = compile_imdf(&source, metadata()).expect("fixture compiles");
        let document = decode_bundle(&without_graph.bytes).expect("bundle decodes");
        assert!(document.graph.is_none());
    }

    #[test]
    fn bundle_without_graph_returns_none() {
        let source = build_minimal_imdf_zip();
        let compiled = compile_imdf(&source, metadata()).expect("fixture compiles");
        let document = decode_bundle(&compiled.bytes).expect("bundle decodes");
        assert!(
            route_in_document(
                &document,
                Point3 {
                    lon: 139.0,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                Point3 {
                    lon: 139.001,
                    lat: 35.0,
                    ordinal: 0.0,
                },
            )
            .is_none(),
            "a bundle with no graph section must not route"
        );
    }

    #[test]
    fn route_boundary_rejects_non_finite_endpoints_without_trapping() {
        // The WASM route path must return a controlled `None` (serialized as
        // `null`) for non-finite endpoint coordinates — never a panic that
        // would trap the module instance.
        let bundle = compile_with_graph();
        let document = decode_bundle(&bundle).expect("bundle decodes");
        let ok = Point3 {
            lon: 139.0,
            lat: 35.0,
            ordinal: 0.0,
        };
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(route_in_document(&document, Point3 { lon: bad, ..ok }, ok).is_none());
            assert!(route_in_document(&document, ok, Point3 { lat: bad, ..ok }).is_none());
            assert!(route_in_document(&document, ok, Point3 { ordinal: bad, ..ok }).is_none());
        }
    }

    #[test]
    fn nodes_only_graph_is_not_advertised_as_routable() {
        use kiriko_route::{RouteGraph, RouteNode};
        let mut document = decode_bundle(&compile_with_graph()).expect("bundle decodes");
        // An edge-bearing decoded graph is routable.
        assert!(has_routable_graph(&document));
        // A decoded graph reduced to junction nodes only must NOT advertise
        // routing (has_graph gates Directions / Network Review).
        document.graph = Some(RouteGraph {
            nodes: vec![RouteNode {
                lon: 139.0,
                lat: 35.0,
                ordinal: 0.0,
            }],
            edges: Vec::new(),
        });
        assert!(
            !has_routable_graph(&document),
            "nodes alone are not routable"
        );
        document.graph = None;
        assert!(!has_routable_graph(&document));
    }
}

// -- Scene decode (3D rendering spike Task 4) ------------------------------

/// Decoded scene split into a JSON description plus one packed payload.
/// The payload concatenates, per batch in order: positions (u16 x3), normals
/// (i16 x2), feature indices (u32). The JSON carries byte offsets so the
/// client can build typed-array views without re-parsing geometry.
#[wasm_bindgen]
pub struct DecodedScene {
    meta: String,
    payload: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedScene {
    #[wasm_bindgen(getter)]
    pub fn meta(&self) -> String {
        self.meta.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn payload(&self) -> Vec<u8> {
        self.payload.clone()
    }
}

#[wasm_bindgen(js_name = "decodeScene")]
pub fn decode_scene_js(bytes: &[u8]) -> Result<DecodedScene, JsError> {
    let document =
        kiriko_scene::decode_scene(bytes).map_err(|error| JsError::new(&format!("{error}")))?;

    let mut payload: Vec<u8> = Vec::new();
    let mut batch_meta: Vec<serde_json::Value> = Vec::with_capacity(document.batches.len());
    for batch in &document.batches {
        let positions_offset = payload.len();
        for position in &batch.positions {
            for component in position {
                payload.extend_from_slice(&component.to_le_bytes());
            }
        }
        // Pad each section to a 4-byte boundary so the client can build
        // u32-typed views from the meta offsets without re-laying the payload.
        while !payload.len().is_multiple_of(4) {
            payload.push(0);
        }
        let normals_offset = payload.len();
        for normal in &batch.normals {
            for component in normal {
                payload.extend_from_slice(&component.to_le_bytes());
            }
        }
        while !payload.len().is_multiple_of(4) {
            payload.push(0);
        }
        let features_offset = payload.len();
        for index in &batch.feature_indices {
            payload.extend_from_slice(&index.to_le_bytes());
        }
        batch_meta.push(serde_json::json!({
            "levelIndex": batch.level_index,
            "role": format!("{:?}", batch.role),
            "quantizationOrigin": batch.quantization_origin,
            "quantizationScale": batch.quantization_scale,
            "vertexCount": batch.vertex_count,
            "positionsOffset": positions_offset,
            "normalsOffset": normals_offset,
            "featureIndicesOffset": features_offset,
        }));
    }

    let meta = serde_json::json!({
        "header": {
            "formatVersion": document.header.format_version,
            "deriverVersion": document.header.deriver_version,
            "sourceHash": document.header.source_hash,
            "frameOriginEcef": document.header.frame_origin_ecef,
            "worldTransform": document.header.world_transform,
            "boundsMin": document.header.bounds_min,
            "boundsMax": document.header.bounds_max,
        },
        "levels": document.levels.iter().map(|level| serde_json::json!({
            "canonicalId": level.canonical_id,
            "sourceLevelKey": level.source_level_key,
            "sourceLevelName": level.source_level_name,
            "sourceElevationMeters": level.source_elevation_meters,
            "resolvedPlaneZ": level.resolved_plane_z,
            "quantizedElevationDm": level.quantized_elevation_dm,
        })).collect::<Vec<_>>(),
        "features": document.features.iter().map(|feature| serde_json::json!({
            "sourceObjectId": feature.source_object_id,
            "canonicalId": feature.canonical_id,
            "levelIndex": feature.level_index,
            "role": format!("{:?}", feature.role),
            "occlusion": format!("{:?}", feature.occlusion),
            "minZ": feature.min_z,
            "maxZ": feature.max_z,
        })).collect::<Vec<_>>(),
        "batches": batch_meta,
    });

    Ok(DecodedScene {
        meta: serde_json::to_string(&meta).map_err(|error| JsError::new(&format!("{error}")))?,
        payload,
    })
}
