//! Public codec surface: compile IMDF source into a `kvb1` bundle, and
//! encode/decode a [`BundleDocument`] to/from bundle bytes.

use std::collections::{BTreeMap, HashSet};
use std::fmt::Write;

use kiriko_facilities::Facilities;
use kiriko_model::import_imdf;
use kiriko_model::model::{
    Bounds, FeatureType, ImdfManifest, VenueFeature, ViewerLevel, ViewerWarning, WarningCode,
};
use kiriko_route::RouteGraph;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::error::{BundleError, BundleErrorCode, CompileError};
use crate::format;
use crate::sections;

/// Caller-supplied identity for a compiled bundle. `dataset_id` is
/// `"<tenant>/<venue>"`; `version` is the immutable venue publish sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleMetadata {
    pub dataset_id: String,
    pub version: u32,
}

/// Bundle statistics, kept API-compatible with the Phase One gallery's
/// `stats_json` shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BundleStats {
    pub levels: u32,
    pub features: u32,
}

/// Whether one optional section's capability is available for a decoded
/// bundle, and when it is not, why.
///
/// `Absent` and the unavailable-with-reason variants are deliberately
/// distinct: a venue that simply has no graph is not the same as a venue
/// whose graph cannot be read, and callers present them differently.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SectionCapability {
    /// Present, at a version this decoder understands, and validated.
    Available,
    /// The bundle carries no directory row for this section.
    Absent,
    /// Present, but declaring a payload version this decoder cannot read.
    /// The bytes are never interpreted.
    UnsupportedVersion { declared: u16, supported: u16 },
    /// Present and readable, but its contents failed validation.
    Invalid { reason: String },
    /// Withheld because a section this one requires is unavailable.
    DisabledByDependency { requires: u16 },
}

/// Per-section availability for one decoded bundle, produced by the same
/// decode that produced the document's content so the two can never disagree
/// about the same bytes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    graph: SectionCapability,
    facilities: SectionCapability,
}

impl CapabilityReport {
    /// Availability of the routing graph section.
    pub fn graph(&self) -> SectionCapability {
        self.graph.clone()
    }

    /// Availability of the point facilities section.
    pub fn facilities(&self) -> SectionCapability {
        self.facilities.clone()
    }
}

impl Default for CapabilityReport {
    /// Every optional capability absent. The starting point for a document
    /// built before its directory has been examined.
    fn default() -> Self {
        Self {
            graph: SectionCapability::Absent,
            facilities: SectionCapability::Absent,
        }
    }
}

/// The fully decoded contents of a `kvb1` bundle: bundle metadata, the
/// source IMDF manifest, and the canonical venue model, with `features` in
/// the single canonical feature-type order (the geometry/stores section
/// split is invisible here).
#[derive(Debug, Clone, PartialEq)]
pub struct BundleDocument {
    pub metadata: BundleMetadata,
    pub manifest: ImdfManifest,
    pub venue_id: String,
    pub levels: Vec<ViewerLevel>,
    pub features: Vec<VenueFeature>,
    pub bounds_by_level: BTreeMap<String, Bounds>,
    pub warnings: Vec<ViewerWarning>,
    pub stats: BundleStats,
    /// Optional routing graph (section 5). `None` when the bundle carries
    /// no graph; an empty graph is never emitted.
    pub graph: Option<RouteGraph>,
    /// Optional point facilities (section 7). `None` when the bundle
    /// carries no facilities; empty facilities are never emitted.
    pub facilities: Option<Facilities>,
    /// Which optional-section capabilities this bundle offers, and why any
    /// unavailable one is unavailable. `graph`/`facilities` above say
    /// *whether* content is present; this says *why* when it is not.
    pub capabilities: CapabilityReport,
}

/// The result of compiling raw IMDF source bytes into a bundle.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledBundle {
    pub bytes: Vec<u8>,
    pub stats: BundleStats,
    pub warnings: Vec<ViewerWarning>,
}

/// Import `source` (a raw IMDF `.zip`) with `kiriko-model`, then encode the
/// canonical venue model as a `kvb1` bundle. Equivalent to
/// [`compile_imdf_with_network`] without network or facilities GeoJSON.
pub fn compile_imdf(
    source: &[u8],
    metadata: BundleMetadata,
) -> Result<CompiledBundle, CompileError> {
    compile_imdf_with_network(source, metadata, None, None, None, false, false)
}

/// Import `source` (a raw IMDF `.zip`) with `kiriko-model`, optionally build
/// a route graph from network junction/path GeoJSON, then encode the
/// canonical venue model as a `kvb1` bundle.
///
/// When both `junctions_geojson` and `paths_geojson` are `Some`,
/// [`kiriko_route::build_route_graph`] builds the graph against the venue's
/// level ordinals; a non-empty graph is embedded as section 5 and the build
/// warnings fold into the compile warning channel (code `route_build`). A
/// malformed network is fatal ([`CompileError::Route`]). When no network is
/// supplied but `synthesize_network` is set, [`crate::synth::synthesize_network`]
/// derives a graph from the venue's own geometry instead (its warnings also
/// fold in under `route_build`); otherwise no graph is embedded.
///
/// When `facilities_geojson` is `Some`,
/// [`kiriko_facilities::build_facilities`] builds the point-facility list
/// against the route graph (or an empty graph when no network was supplied,
/// which leaves every anchor unset and warns once); non-empty facilities are
/// embedded as section 7 and the build warnings fold into the compile
/// warning channel (code `facility_build`). Malformed facilities GeoJSON is
/// fatal ([`CompileError::Facility`]).
pub fn compile_imdf_with_network(
    source: &[u8],
    metadata: BundleMetadata,
    junctions_geojson: Option<&str>,
    paths_geojson: Option<&str>,
    facilities_geojson: Option<&str>,
    synthesize_network: bool,
    clip_to_venue: bool,
) -> Result<CompiledBundle, CompileError> {
    let venue = import_imdf(source)?;
    // Built before `document` consumes `venue`. `None` when clipping is off, so
    // an unclipped compile does no extra geometry work at all.
    let clip_region = if clip_to_venue {
        Some(crate::clip::ClipRegion::from_venue(&venue))
    } else {
        None
    };
    let stats = BundleStats {
        levels: venue.levels.len() as u32,
        features: venue.features.len() as u32,
    };
    let mut document = BundleDocument {
        metadata,
        manifest: venue.manifest,
        venue_id: venue.venue_id,
        levels: venue.levels,
        features: venue.features,
        bounds_by_level: venue.bounds_by_level,
        warnings: venue.warnings,
        stats,
        graph: None,
        facilities: None,
        capabilities: CapabilityReport::default(),
    };

    // Clipping was requested but the imported venue carries no level/unit
    // polygons to clip against: every node/facility would be dropped below,
    // silently. Warn once up front so that isn't mistaken for a bug.
    if clip_region
        .as_ref()
        .is_some_and(crate::clip::ClipRegion::is_empty)
    {
        document.warnings.push(ViewerWarning {
            code: WarningCode::RouteBuild,
            message: "clip_region_empty: the imported venue has no level or unit polygons to clip \
                      against; building or synthesizing a network with clipping enabled will drop \
                      everything"
                .to_string(),
            feature_id: None,
            archive_entry: None,
        });
    }

    if let (Some(junctions), Some(paths)) = (junctions_geojson, paths_geojson) {
        let ordinals: Vec<f64> = document.levels.iter().map(|l| l.ordinal).collect();
        let build = kiriko_route::build_route_graph(junctions, paths, &ordinals)?;
        document
            .warnings
            .extend(build.warnings.into_iter().map(|w| ViewerWarning {
                code: WarningCode::RouteBuild,
                message: format!("{}: {}", w.code, w.detail),
                feature_id: None,
                archive_entry: None,
            }));
        let graph = if let Some(region) = &clip_region {
            let (clipped, dropped_nodes, dropped_edges) =
                crate::clip::clip_graph(&build.graph, region);
            if dropped_nodes > 0 || dropped_edges > 0 {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::RouteBuild,
                    message: format!(
                        "network_clipped: dropped {dropped_nodes} nodes and {dropped_edges} edges outside the imported venue"
                    ),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            if clipped.is_empty() {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::RouteBuild,
                    message:
                        "network_clip_empty: clipping removed every routable edge; no routing graph was embedded"
                            .to_string(),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            clipped
        } else {
            build.graph
        };
        if !graph.is_empty() {
            document.graph = Some(graph);
        }
    } else if synthesize_network {
        #[cfg(feature = "netgen")]
        let build = crate::synth_medial::synthesize_network_medial(&document);
        #[cfg(not(feature = "netgen"))]
        let build = crate::synth::synthesize_network(&document);
        document
            .warnings
            .extend(build.warnings.into_iter().map(|w| ViewerWarning {
                code: WarningCode::RouteBuild,
                message: format!("{}: {}", w.code, w.detail),
                feature_id: None,
                archive_entry: None,
            }));
        let graph = if let Some(region) = &clip_region {
            let (clipped, dropped_nodes, dropped_edges) =
                crate::clip::clip_graph(&build.graph, region);
            if dropped_nodes > 0 || dropped_edges > 0 {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::RouteBuild,
                    message: format!(
                        "network_clipped: dropped {dropped_nodes} nodes and {dropped_edges} edges outside the imported venue"
                    ),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            if clipped.is_empty() {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::RouteBuild,
                    message:
                        "network_clip_empty: clipping removed every routable edge; no routing graph was embedded"
                            .to_string(),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            clipped
        } else {
            build.graph
        };
        if !graph.is_empty() {
            document.graph = Some(graph);
        }
    }

    if let Some(facilities_geojson) = facilities_geojson {
        if document.graph.is_none() {
            document.warnings.push(ViewerWarning {
                code: WarningCode::FacilityBuild,
                message: "facilities GeoJSON built with no route graph: all \
                          facility anchors are unset"
                    .to_string(),
                feature_id: None,
                archive_entry: None,
            });
        }
        let empty_graph = RouteGraph {
            nodes: Vec::new(),
            edges: Vec::new(),
        };
        let graph = document.graph.as_ref().unwrap_or(&empty_graph);
        let (facilities, build_warnings) =
            kiriko_facilities::build_facilities(facilities_geojson, graph)?;
        document
            .warnings
            .extend(build_warnings.into_iter().map(|w| ViewerWarning {
                code: WarningCode::FacilityBuild,
                message: format!("{}: {}", w.code, w.detail),
                feature_id: None,
                archive_entry: None,
            }));
        let facilities = if let Some(region) = &clip_region {
            let (clipped, dropped) = crate::clip::clip_facilities(&facilities, region);
            if dropped > 0 {
                document.warnings.push(ViewerWarning {
                    code: WarningCode::FacilityBuild,
                    message: format!(
                        "facilities_clipped: dropped {dropped} facilities outside the imported venue"
                    ),
                    feature_id: None,
                    archive_entry: None,
                });
            }
            clipped
        } else {
            facilities
        };
        if !facilities.items.is_empty() {
            document.facilities = Some(facilities);
        }
    }

    let bytes = encode_bundle(&document)?;
    Ok(CompiledBundle {
        bytes,
        stats: document.stats,
        warnings: document.warnings,
    })
}

fn postcard_encode_err(context: &str) -> impl Fn(postcard::Error) -> BundleError + '_ {
    move |e| BundleError::new(BundleErrorCode::InvalidBundle, format!("{context}: {e}"))
}

/// Deserialize exactly one postcard value from `bytes` and require that no
/// bytes are left over. Plain `postcard::from_bytes` silently ignores a
/// trailing remainder, which would let a corrupted bundle pad a section with
/// garbage after a validly-encoded prefix and still decode "successfully".
pub(crate) fn postcard_take_exact<'a, T: Deserialize<'a>>(
    bytes: &'a [u8],
    context: &str,
) -> Result<T, BundleError> {
    let (value, remainder) = postcard::take_from_bytes(bytes)
        .map_err(|e| BundleError::new(BundleErrorCode::InvalidBundle, format!("{context}: {e}")))?;
    if !remainder.is_empty() {
        return Err(BundleError::new(
            BundleErrorCode::InvalidBundle,
            format!(
                "{context}: {} trailing byte(s) after the section value",
                remainder.len()
            ),
        ));
    }
    Ok(value)
}

/// Encode a [`BundleDocument`] as `kvb1` bundle bytes. `document.features`
/// is split into the geometry (non-occupant) and stores (occupant) sections;
/// no section is duplicated and no empty style/graph/beacon section is
/// emitted. The optional graph section (id 5) is emitted only when
/// `document.graph` is `Some` and non-empty; the optional facilities
/// section (id 7) only when `document.facilities` is `Some` and non-empty.
/// Every `f64` reachable from
/// `document` is validated as finite and `-0.0` is normalized to `0.0`
/// (see `sections::canonical_f64`).
pub fn encode_bundle(document: &BundleDocument) -> Result<Vec<u8>, BundleError> {
    let manifest_dto = sections::manifest_to_dto(document)?;
    let (geometry, stores) = sections::split_features(&document.features);

    let manifest_bytes = postcard::to_allocvec(&manifest_dto)
        .map_err(postcard_encode_err("encode manifest section"))?;
    let geometry_bytes = postcard::to_allocvec(&sections::feature_dtos(&geometry)?)
        .map_err(postcard_encode_err("encode geometry section"))?;
    let stores_bytes = postcard::to_allocvec(&sections::feature_dtos(&stores)?)
        .map_err(postcard_encode_err("encode stores section"))?;

    let mut section_list = vec![
        (
            format::SECTION_MANIFEST,
            format::SECTION_VERSION,
            manifest_bytes,
        ),
        (
            format::SECTION_GEOMETRY,
            format::SECTION_VERSION,
            geometry_bytes,
        ),
        (
            format::SECTION_STORES,
            format::SECTION_VERSION,
            stores_bytes,
        ),
    ];
    // Section id 5 sorts after 1-3, so appending keeps the directory
    // id-ascending as `build_payload` requires.
    if let Some(graph) = &document.graph
        && !graph.is_empty()
    {
        section_list.push((
            format::SECTION_GRAPH,
            format::SECTION_VERSION,
            sections::encode_graph(graph)?,
        ));
    }
    // Section id 7 sorts after 5, so appending keeps the directory
    // id-ascending as `build_payload` requires.
    if let Some(facilities) = &document.facilities
        && !facilities.items.is_empty()
    {
        section_list.push((
            format::SECTION_FACILITIES,
            format::SECTION_VERSION,
            sections::encode_facilities(facilities)?,
        ));
    }

    let payload = format::build_payload(&section_list);

    format::encode_payload(&payload)
}

/// Decode `kvb1` bundle bytes into a [`BundleDocument`]. Verifies the
/// envelope, decompresses and integrity-checks the payload, validates the
/// section directory, decodes each section requiring no trailing bytes,
/// validates every reachable `f64` is finite (normalizing `-0.0`), validates
/// geometry/stores section membership and canonical ordering, and
/// reassembles the split back into the single canonical feature order.
pub fn decode_bundle(bytes: &[u8]) -> Result<BundleDocument, BundleError> {
    let payload = format::decode_payload(bytes)?;
    let directory = format::parse_directory(&payload)?;

    let manifest_bytes = directory
        .section(&payload, format::SECTION_MANIFEST)
        .expect("presence checked by parse_directory");
    let geometry_bytes = directory
        .section(&payload, format::SECTION_GEOMETRY)
        .expect("presence checked by parse_directory");
    let stores_bytes = directory
        .section(&payload, format::SECTION_STORES)
        .expect("presence checked by parse_directory");

    let manifest_dto: sections::ManifestSection =
        postcard_take_exact(manifest_bytes, "decode manifest section")?;
    let geometry_dtos: Vec<sections::FeatureDto> =
        postcard_take_exact(geometry_bytes, "decode geometry section")?;
    let stores_dtos: Vec<sections::FeatureDto> =
        postcard_take_exact(stores_bytes, "decode stores section")?;

    let features = sections::reassemble_features(
        sections::features_from_dtos(&geometry_dtos)?,
        sections::features_from_dtos(&stores_dtos)?,
    )?;

    let mut document = sections::manifest_into_document(manifest_dto, features)?;

    // Both sections are optional, and neither can fail the bundle. Absent stays
    // `None`, so bundles written before either section existed still decode; an
    // unreadable one is reported unavailable and its bytes are never
    // interpreted.
    let (graph, graph_capability) = classify_section(
        &directory,
        &payload,
        format::SECTION_GRAPH,
        sections::decode_graph,
    );
    let (facilities, facilities_capability) = classify_section(
        &directory,
        &payload,
        format::SECTION_FACILITIES,
        sections::decode_facilities,
    );
    document.graph = graph;
    document.facilities = facilities;
    document.capabilities = CapabilityReport {
        graph: graph_capability,
        facilities: facilities_capability,
    };
    Ok(document)
}

/// Decode one optional section and classify its availability in the same pass,
/// which is what keeps a bundle's content and its capability report from ever
/// disagreeing about the same bytes.
///
/// `decode` runs only when the row is present at a supported version, so bytes
/// whose layout this decoder cannot vouch for are never interpreted.
fn classify_section<T>(
    directory: &format::Directory,
    payload: &[u8],
    id: u16,
    decode: impl FnOnce(&[u8]) -> Result<T, BundleError>,
) -> (Option<T>, SectionCapability) {
    match directory.declared_version(id) {
        None => (None, SectionCapability::Absent),
        Some(declared) if declared != format::SECTION_VERSION => (
            None,
            SectionCapability::UnsupportedVersion {
                declared,
                supported: format::SECTION_VERSION,
            },
        ),
        Some(_) => {
            let bytes = directory
                .section(payload, id)
                .expect("a row at a supported version yields bytes");
            match decode(bytes) {
                Ok(value) => (Some(value), SectionCapability::Available),
                Err(err) => (None, SectionCapability::Invalid { reason: err.message }),
            }
        }
    }
}

/// A pure anchor-level projection of a decoded bundle: the whole-file
/// content hash, the level rows, and each feature's level relationship.
///
/// `bundle_hash` is the lowercase SHA-256 of the complete bundle bytes
/// (envelope included) — the same value `blobs` content-addresses — not the
/// envelope's payload digest. `level_ids` and `feature_levels` preserve the
/// canonical decoded order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInspection {
    pub bundle_hash: String,
    pub level_ids: Vec<String>,
    pub feature_levels: Vec<(String, Option<String>)>,
}

/// Decode `bytes` once via [`decode_bundle`] and project its level/feature
/// relationships, validating the semantic invariants the codec itself does
/// not enforce: level row IDs are unique, level rows and
/// [`FeatureType::Level`] features correspond exactly, and every non-null
/// `feature.level_id` references an existing level row. A
/// [`FeatureType::Level`] feature maps to its own ID; every other feature
/// maps to its `level_id` (null when level-independent).
pub fn inspect_bundle(bytes: &[u8]) -> Result<BundleInspection, BundleError> {
    let document = decode_bundle(bytes)?;

    let mut level_ids = Vec::with_capacity(document.levels.len());
    let mut level_rows: HashSet<&str> = HashSet::with_capacity(document.levels.len());
    for level in &document.levels {
        if !level_rows.insert(level.id.as_str()) {
            return Err(BundleError::new(
                BundleErrorCode::InvalidBundle,
                format!("duplicate level row id {:?}", level.id),
            ));
        }
        level_ids.push(level.id.clone());
    }

    let mut level_features: HashSet<&str> = HashSet::with_capacity(document.levels.len());
    let mut feature_levels = Vec::with_capacity(document.features.len());
    for feature in &document.features {
        // Every non-null level reference must resolve, regardless of the
        // feature's own type — a Level feature self-maps below, but a
        // dangling `level_id` it carries is still a broken relationship.
        if let Some(level_id) = &feature.level_id
            && !level_rows.contains(level_id.as_str())
        {
            return Err(BundleError::new(
                BundleErrorCode::InvalidBundle,
                format!(
                    "feature {:?} references unknown level {:?}",
                    feature.id, level_id
                ),
            ));
        }
        let level = if feature.feature_type == FeatureType::Level {
            if !level_rows.contains(feature.id.as_str()) {
                return Err(BundleError::new(
                    BundleErrorCode::InvalidBundle,
                    format!("level feature {:?} has no level row", feature.id),
                ));
            }
            level_features.insert(feature.id.as_str());
            Some(feature.id.clone())
        } else {
            feature.level_id.clone()
        };
        feature_levels.push((feature.id.clone(), level));
    }

    for level_id in &level_ids {
        if !level_features.contains(level_id.as_str()) {
            return Err(BundleError::new(
                BundleErrorCode::InvalidBundle,
                format!("level row {level_id:?} has no level feature"),
            ));
        }
    }

    let digest = Sha256::digest(bytes);
    let mut bundle_hash = String::with_capacity(64);
    for byte in digest {
        write!(bundle_hash, "{byte:02x}").expect("writing to a String cannot fail");
    }

    Ok(BundleInspection {
        bundle_hash,
        level_ids,
        feature_levels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kiriko_model::canonical::Value as CanonicalValue;
    use kiriko_model::model::FeatureType;

    #[test]
    fn encode_bundle_rejects_nan_in_every_reachable_float_family() {
        let base =
            |features: Vec<VenueFeature>, ordinal: f64, bounds: Option<Bounds>| BundleDocument {
                metadata: BundleMetadata {
                    dataset_id: "test".to_string(),
                    version: 1,
                },
                manifest: ImdfManifest {
                    version: "1.0.0".to_string(),
                    language: "en".to_string(),
                    rest: BTreeMap::new(),
                },
                venue_id: "venue-1".to_string(),
                levels: vec![ViewerLevel {
                    id: "level-1".to_string(),
                    ordinal,
                    label: BTreeMap::new(),
                    short_name: BTreeMap::new(),
                }],
                features,
                bounds_by_level: bounds
                    .map(|b| ("level-1".to_string(), b))
                    .into_iter()
                    .collect(),
                warnings: Vec::new(),
                stats: BundleStats {
                    levels: 1,
                    features: 0,
                },
                graph: None,
                facilities: None,
                capabilities: CapabilityReport::default(),
            };

        // Level ordinal.
        assert_eq!(
            encode_bundle(&base(Vec::new(), f64::NAN, None))
                .unwrap_err()
                .code,
            BundleErrorCode::InvalidBundle
        );

        // Bounds.
        let bad_bounds = Bounds {
            west: f64::INFINITY,
            south: 0.0,
            east: 1.0,
            north: 1.0,
        };
        assert_eq!(
            encode_bundle(&base(Vec::new(), 0.0, Some(bad_bounds)))
                .unwrap_err()
                .code,
            BundleErrorCode::InvalidBundle
        );

        // Feature center.
        let mut center_feature = VenueFeature {
            id: "f1".to_string(),
            feature_type: FeatureType::Address,
            level_id: None,
            geometry: None,
            center: Some((f64::NAN, 0.0)),
            labels: BTreeMap::new(),
            alt_labels: BTreeMap::new(),
            category: None,
            accessibility: Vec::new(),
            restriction: None,
            source_properties: BTreeMap::new(),
        };
        assert_eq!(
            encode_bundle(&base(vec![center_feature.clone()], 0.0, None))
                .unwrap_err()
                .code,
            BundleErrorCode::InvalidBundle
        );

        // Geometry coordinate, nested inside an array.
        center_feature.center = None;
        center_feature.geometry = Some(CanonicalValue::Array(vec![
            CanonicalValue::Number(f64::NAN),
            CanonicalValue::Number(35.0),
        ]));
        assert_eq!(
            encode_bundle(&base(vec![center_feature.clone()], 0.0, None))
                .unwrap_err()
                .code,
            BundleErrorCode::InvalidBundle
        );

        // source_properties value, nested inside an object.
        center_feature.geometry = None;
        center_feature.source_properties.insert(
            "weight".to_string(),
            CanonicalValue::Number(f64::NEG_INFINITY),
        );
        assert_eq!(
            encode_bundle(&base(vec![center_feature], 0.0, None))
                .unwrap_err()
                .code,
            BundleErrorCode::InvalidBundle
        );
    }

    /// A minimal, encodable document: one level, no features, no optional
    /// sections.
    fn minimal_document() -> BundleDocument {
        BundleDocument {
            metadata: BundleMetadata {
                dataset_id: "test".to_string(),
                version: 1,
            },
            manifest: ImdfManifest {
                version: "1.0.0".to_string(),
                language: "en".to_string(),
                rest: BTreeMap::new(),
            },
            venue_id: "venue-1".to_string(),
            levels: vec![ViewerLevel {
                id: "level-1".to_string(),
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
            capabilities: CapabilityReport::default(),
        }
    }

    /// Re-encode `bundle` carrying one extra section, so the decode path for a
    /// malformed optional section can be exercised through `decode_bundle`.
    fn bundle_with_extra_section(bundle: &[u8], id: u16, version: u16, bytes: Vec<u8>) -> Vec<u8> {
        let payload = format::decode_payload(bundle).expect("payload decodes");
        let directory = format::parse_directory(&payload).expect("directory parses");
        let mut sections: Vec<(u16, u16, Vec<u8>)> = [
            format::SECTION_MANIFEST,
            format::SECTION_GEOMETRY,
            format::SECTION_STORES,
        ]
        .into_iter()
        .map(|required| {
            let bytes = directory
                .section(&payload, required)
                .expect("required section present");
            (required, format::SECTION_VERSION, bytes.to_vec())
        })
        .collect();
        sections.push((id, version, bytes));
        sections.sort_by_key(|(id, _, _)| *id);
        format::encode_payload(&format::build_payload(&sections)).expect("payload encodes")
    }

    #[test]
    fn a_malformed_optional_section_is_invalid_rather_than_fatal() {
        let bundle = encode_bundle(&minimal_document()).expect("minimal document encodes");
        let corrupted = bundle_with_extra_section(
            &bundle,
            format::SECTION_GRAPH,
            format::SECTION_VERSION,
            vec![0xFF; 8],
        );

        let document = decode_bundle(&corrupted)
            .expect("a malformed optional section must not fail the whole bundle");

        assert!(
            document.graph.is_none(),
            "unreadable graph bytes must never be interpreted"
        );
        assert!(
            matches!(
                document.capabilities.graph(),
                SectionCapability::Invalid { .. }
            ),
            "a present-but-unreadable section is invalid, not absent: {:?}",
            document.capabilities.graph()
        );
        assert_eq!(
            document.levels.len(),
            1,
            "the venue's own content must survive one unreadable optional section"
        );
    }
}
