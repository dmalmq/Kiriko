//! Postcard-serializable DTOs for each bundle section, plus conversions
//! to/from the `kiriko-model` canonical venue types.
//!
//! `Serialize`/`Deserialize` live only here so the shared `kiriko-model`
//! crate stays free of a bundle-format dependency. Every DTO here mirrors a
//! `kiriko-model` type field-for-field; enums use their own serde-derived
//! discriminant type (rather than a string) so a corrupted bundle fails
//! postcard decoding instead of ever reaching a panicking string match.
//!
//! The manifest section (id 1) carries bundle metadata, the source IMDF
//! manifest, venue id, levels, bounds, warnings, and stats. The geometry
//! section (id 2) carries every non-occupant feature; the stores section
//! (id 3) carries every occupant feature. [`split_features`] and
//! [`reassemble_features`] move features between the single canonical
//! ordering `kiriko-model` produces and the two-section split, so callers
//! never see the split or a duplicated feature. [`reassemble_features`]
//! also validates that the split was honest (correct section membership,
//! canonical type order within each section, no id duplicated across
//! sections), since a hand-crafted bundle need not have gone through
//! [`split_features`] at all.
//!
//! Every `f64` reachable from a [`BundleDocument`] (level ordinals, bounds,
//! feature centers, and any number nested in feature geometry or
//! `source_properties`) is canonicalized by [`canonical_f64`] on both the
//! encode and decode path: non-finite values are rejected, and `-0.0` is
//! rewritten to `0.0` so two semantically-equivalent documents always
//! encode to identical bytes and a decoded document is always in the same
//! canonical form `kiriko-model` itself produces.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use kiriko_model::canonical::{self, Value as CanonicalValue};
use kiriko_model::model::{
    Bounds, FeatureType, ImdfManifest, VenueFeature, ViewerLevel, ViewerWarning, WarningCode,
};

use crate::codec::{BundleDocument, BundleMetadata, BundleStats};
use crate::error::{BundleError, BundleErrorCode};

/// Reject a non-finite (NaN or +/-Infinity) number, and normalize `-0.0` to
/// `0.0`. Applied to every `f64` at the codec boundary (see module docs).
fn canonical_f64(v: f64) -> Result<f64, BundleError> {
    if !v.is_finite() {
        return Err(BundleError::new(
            BundleErrorCode::InvalidBundle,
            "bundle contains a non-finite (NaN or infinite) number",
        ));
    }
    Ok(if v == 0.0 { 0.0 } else { v })
}

pub(crate) type JsonObjectDto = BTreeMap<String, JsonValueDto>;

/// Serializable mirror of `kiriko_model::canonical::Value`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) enum JsonValueDto {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValueDto>),
    Object(JsonObjectDto),
}

fn value_to_dto(value: &CanonicalValue) -> Result<JsonValueDto, BundleError> {
    Ok(match value {
        CanonicalValue::Null => JsonValueDto::Null,
        CanonicalValue::Bool(b) => JsonValueDto::Bool(*b),
        CanonicalValue::Number(n) => JsonValueDto::Number(canonical_f64(*n)?),
        CanonicalValue::String(s) => JsonValueDto::String(s.clone()),
        CanonicalValue::Array(items) => {
            JsonValueDto::Array(items.iter().map(value_to_dto).collect::<Result<_, _>>()?)
        }
        CanonicalValue::Object(map) => JsonValueDto::Object(object_to_dto(map)?),
    })
}

fn dto_to_value(dto: &JsonValueDto) -> Result<CanonicalValue, BundleError> {
    Ok(match dto {
        JsonValueDto::Null => CanonicalValue::Null,
        JsonValueDto::Bool(b) => CanonicalValue::Bool(*b),
        JsonValueDto::Number(n) => CanonicalValue::Number(canonical_f64(*n)?),
        JsonValueDto::String(s) => CanonicalValue::String(s.clone()),
        JsonValueDto::Array(items) => {
            CanonicalValue::Array(items.iter().map(dto_to_value).collect::<Result<_, _>>()?)
        }
        JsonValueDto::Object(map) => CanonicalValue::Object(dto_to_object(map)?),
    })
}

fn object_to_dto(object: &canonical::Object) -> Result<JsonObjectDto, BundleError> {
    object
        .iter()
        .map(|(k, v)| Ok((k.clone(), value_to_dto(v)?)))
        .collect()
}

fn dto_to_object(dto: &JsonObjectDto) -> Result<canonical::Object, BundleError> {
    dto.iter()
        .map(|(k, v)| Ok((k.clone(), dto_to_value(v)?)))
        .collect()
}

/// Serializable mirror of `kiriko_model::model::FeatureType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum FeatureTypeDto {
    Address,
    Amenity,
    Anchor,
    Building,
    Detail,
    Fixture,
    Footprint,
    Geofence,
    Kiosk,
    Level,
    Occupant,
    Opening,
    Relationship,
    Section,
    Unit,
    Venue,
}

impl From<FeatureType> for FeatureTypeDto {
    fn from(value: FeatureType) -> Self {
        match value {
            FeatureType::Address => Self::Address,
            FeatureType::Amenity => Self::Amenity,
            FeatureType::Anchor => Self::Anchor,
            FeatureType::Building => Self::Building,
            FeatureType::Detail => Self::Detail,
            FeatureType::Fixture => Self::Fixture,
            FeatureType::Footprint => Self::Footprint,
            FeatureType::Geofence => Self::Geofence,
            FeatureType::Kiosk => Self::Kiosk,
            FeatureType::Level => Self::Level,
            FeatureType::Occupant => Self::Occupant,
            FeatureType::Opening => Self::Opening,
            FeatureType::Relationship => Self::Relationship,
            FeatureType::Section => Self::Section,
            FeatureType::Unit => Self::Unit,
            FeatureType::Venue => Self::Venue,
        }
    }
}

impl From<FeatureTypeDto> for FeatureType {
    fn from(value: FeatureTypeDto) -> Self {
        match value {
            FeatureTypeDto::Address => Self::Address,
            FeatureTypeDto::Amenity => Self::Amenity,
            FeatureTypeDto::Anchor => Self::Anchor,
            FeatureTypeDto::Building => Self::Building,
            FeatureTypeDto::Detail => Self::Detail,
            FeatureTypeDto::Fixture => Self::Fixture,
            FeatureTypeDto::Footprint => Self::Footprint,
            FeatureTypeDto::Geofence => Self::Geofence,
            FeatureTypeDto::Kiosk => Self::Kiosk,
            FeatureTypeDto::Level => Self::Level,
            FeatureTypeDto::Occupant => Self::Occupant,
            FeatureTypeDto::Opening => Self::Opening,
            FeatureTypeDto::Relationship => Self::Relationship,
            FeatureTypeDto::Section => Self::Section,
            FeatureTypeDto::Unit => Self::Unit,
            FeatureTypeDto::Venue => Self::Venue,
        }
    }
}

/// Serializable mirror of `kiriko_model::model::WarningCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum WarningCodeDto {
    MissingLocale,
    UnresolvedReference,
    MissingLevelGeometry,
    MissingDisplayPoint,
    UnknownArchiveEntry,
    RouteBuild,
    FacilityBuild,
}

impl From<WarningCode> for WarningCodeDto {
    fn from(value: WarningCode) -> Self {
        match value {
            WarningCode::MissingLocale => Self::MissingLocale,
            WarningCode::UnresolvedReference => Self::UnresolvedReference,
            WarningCode::MissingLevelGeometry => Self::MissingLevelGeometry,
            WarningCode::MissingDisplayPoint => Self::MissingDisplayPoint,
            WarningCode::UnknownArchiveEntry => Self::UnknownArchiveEntry,
            WarningCode::RouteBuild => Self::RouteBuild,
            WarningCode::FacilityBuild => Self::FacilityBuild,
        }
    }
}

impl From<WarningCodeDto> for WarningCode {
    fn from(value: WarningCodeDto) -> Self {
        match value {
            WarningCodeDto::MissingLocale => Self::MissingLocale,
            WarningCodeDto::UnresolvedReference => Self::UnresolvedReference,
            WarningCodeDto::MissingLevelGeometry => Self::MissingLevelGeometry,
            WarningCodeDto::MissingDisplayPoint => Self::MissingDisplayPoint,
            WarningCodeDto::UnknownArchiveEntry => Self::UnknownArchiveEntry,
            WarningCodeDto::RouteBuild => Self::RouteBuild,
            WarningCodeDto::FacilityBuild => Self::FacilityBuild,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FeatureDto {
    pub id: String,
    pub feature_type: FeatureTypeDto,
    pub level_id: Option<String>,
    pub geometry: Option<JsonValueDto>,
    pub center: Option<(f64, f64)>,
    pub labels: BTreeMap<String, String>,
    pub alt_labels: BTreeMap<String, String>,
    pub category: Option<String>,
    pub accessibility: Vec<String>,
    pub restriction: Option<String>,
    pub source_properties: JsonObjectDto,
}

fn feature_to_dto(feature: &VenueFeature) -> Result<FeatureDto, BundleError> {
    let center = match feature.center {
        Some((x, y)) => Some((canonical_f64(x)?, canonical_f64(y)?)),
        None => None,
    };
    Ok(FeatureDto {
        id: feature.id.clone(),
        feature_type: feature.feature_type.into(),
        level_id: feature.level_id.clone(),
        geometry: feature.geometry.as_ref().map(value_to_dto).transpose()?,
        center,
        labels: feature.labels.clone(),
        alt_labels: feature.alt_labels.clone(),
        category: feature.category.clone(),
        accessibility: feature.accessibility.clone(),
        restriction: feature.restriction.clone(),
        source_properties: object_to_dto(&feature.source_properties)?,
    })
}

fn dto_to_feature(dto: &FeatureDto) -> Result<VenueFeature, BundleError> {
    let center = match dto.center {
        Some((x, y)) => Some((canonical_f64(x)?, canonical_f64(y)?)),
        None => None,
    };
    Ok(VenueFeature {
        id: dto.id.clone(),
        feature_type: dto.feature_type.into(),
        level_id: dto.level_id.clone(),
        geometry: dto.geometry.as_ref().map(dto_to_value).transpose()?,
        center,
        labels: dto.labels.clone(),
        alt_labels: dto.alt_labels.clone(),
        category: dto.category.clone(),
        accessibility: dto.accessibility.clone(),
        restriction: dto.restriction.clone(),
        source_properties: dto_to_object(&dto.source_properties)?,
    })
}

/// Split canonically-ordered features into (geometry, stores): every
/// occupant goes to `stores`, everything else to `geometry`. Relative order
/// within each output is preserved. This is the *encode*-side split;
/// [`reassemble_features`] is the decode-side inverse and separately
/// validates that a section (which need not have come from this function)
/// actually honors the split it claims to.
pub(crate) fn split_features(features: &[VenueFeature]) -> (Vec<VenueFeature>, Vec<VenueFeature>) {
    let mut geometry = Vec::new();
    let mut stores = Vec::new();
    for feature in features {
        if feature.feature_type == FeatureType::Occupant {
            stores.push(feature.clone());
        } else {
            geometry.push(feature.clone());
        }
    }
    (geometry, stores)
}

fn validate_canonical_type_order(
    features: &[VenueFeature],
    section_name: &str,
) -> Result<(), BundleError> {
    let mut last_order: Option<usize> = None;
    for feature in features {
        let order = feature.feature_type.order();
        if let Some(last) = last_order
            && order < last
        {
            return Err(BundleError::new(
                BundleErrorCode::InvalidBundle,
                format!("{section_name} section is not in canonical feature-type order"),
            ));
        }
        last_order = Some(order);
    }
    Ok(())
}

/// Reassemble the geometry and stores sections back into the single
/// canonical feature-type order `kiriko-model` produces.
///
/// A decoded bundle need not have been produced by [`split_features`] (it
/// may be hand-crafted or corrupted), so this validates the invariants
/// `split_features` would otherwise guarantee before trusting the merge:
/// every `geometry` feature is a non-occupant, every `stores` feature is an
/// occupant, each section is already in non-decreasing canonical
/// feature-type order, and no feature id repeats across the two sections
/// combined. Given valid input, both sections are individually ordered by
/// `FeatureType::order()`, so a merge on that order reproduces the exact
/// original sequence.
pub(crate) fn reassemble_features(
    geometry: Vec<VenueFeature>,
    stores: Vec<VenueFeature>,
) -> Result<Vec<VenueFeature>, BundleError> {
    for feature in &geometry {
        if feature.feature_type == FeatureType::Occupant {
            return Err(BundleError::new(
                BundleErrorCode::InvalidBundle,
                format!(
                    "occupant feature {:?} found in the geometry section",
                    feature.id
                ),
            ));
        }
    }
    for feature in &stores {
        if feature.feature_type != FeatureType::Occupant {
            return Err(BundleError::new(
                BundleErrorCode::InvalidBundle,
                format!(
                    "non-occupant feature {:?} found in the stores section",
                    feature.id
                ),
            ));
        }
    }
    validate_canonical_type_order(&geometry, "geometry")?;
    validate_canonical_type_order(&stores, "stores")?;

    let mut g = geometry.into_iter().peekable();
    let mut s = stores.into_iter().peekable();
    let mut out = Vec::new();
    loop {
        match (g.peek(), s.peek()) {
            (None, None) => break,
            (Some(_), None) => out.push(g.next().expect("peeked Some")),
            (None, Some(_)) => out.push(s.next().expect("peeked Some")),
            (Some(gf), Some(sf)) => {
                if gf.feature_type.order() <= sf.feature_type.order() {
                    out.push(g.next().expect("peeked Some"));
                } else {
                    out.push(s.next().expect("peeked Some"));
                }
            }
        }
    }

    let mut seen_ids: HashSet<&str> = HashSet::with_capacity(out.len());
    for feature in &out {
        if !seen_ids.insert(feature.id.as_str()) {
            return Err(BundleError::new(
                BundleErrorCode::InvalidBundle,
                format!("duplicate feature id {:?} across sections", feature.id),
            ));
        }
    }

    Ok(out)
}

pub(crate) fn feature_dtos(features: &[VenueFeature]) -> Result<Vec<FeatureDto>, BundleError> {
    features.iter().map(feature_to_dto).collect()
}

pub(crate) fn features_from_dtos(dtos: &[FeatureDto]) -> Result<Vec<VenueFeature>, BundleError> {
    dtos.iter().map(dto_to_feature).collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct BundleMetadataDto {
    dataset_id: String,
    version: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ImdfManifestDto {
    version: String,
    language: String,
    rest: JsonObjectDto,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct BoundsDto {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

fn bounds_to_dto(b: Bounds) -> Result<BoundsDto, BundleError> {
    Ok(BoundsDto {
        west: canonical_f64(b.west)?,
        south: canonical_f64(b.south)?,
        east: canonical_f64(b.east)?,
        north: canonical_f64(b.north)?,
    })
}

fn bounds_from_dto(b: BoundsDto) -> Result<Bounds, BundleError> {
    Ok(Bounds {
        west: canonical_f64(b.west)?,
        south: canonical_f64(b.south)?,
        east: canonical_f64(b.east)?,
        north: canonical_f64(b.north)?,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ViewerLevelDto {
    id: String,
    ordinal: f64,
    label: BTreeMap<String, String>,
    short_name: BTreeMap<String, String>,
}

fn level_to_dto(level: &ViewerLevel) -> Result<ViewerLevelDto, BundleError> {
    Ok(ViewerLevelDto {
        id: level.id.clone(),
        ordinal: canonical_f64(level.ordinal)?,
        label: level.label.clone(),
        short_name: level.short_name.clone(),
    })
}

fn level_from_dto(dto: ViewerLevelDto) -> Result<ViewerLevel, BundleError> {
    Ok(ViewerLevel {
        id: dto.id,
        ordinal: canonical_f64(dto.ordinal)?,
        label: dto.label,
        short_name: dto.short_name,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ViewerWarningDto {
    code: WarningCodeDto,
    message: String,
    feature_id: Option<String>,
    archive_entry: Option<String>,
}

fn warning_to_dto(warning: &ViewerWarning) -> ViewerWarningDto {
    ViewerWarningDto {
        code: warning.code.into(),
        message: warning.message.clone(),
        feature_id: warning.feature_id.clone(),
        archive_entry: warning.archive_entry.clone(),
    }
}

fn warning_from_dto(dto: ViewerWarningDto) -> ViewerWarning {
    ViewerWarning {
        code: dto.code.into(),
        message: dto.message,
        feature_id: dto.feature_id,
        archive_entry: dto.archive_entry,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct BundleStatsDto {
    levels: u32,
    features: u32,
}

/// Section 1 (manifest): bundle metadata, source IMDF manifest, venue id,
/// levels, bounds, warnings, and stats. Everything a `BundleDocument` needs
/// except the reassembled feature vector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ManifestSection {
    bundle: BundleMetadataDto,
    source_manifest: ImdfManifestDto,
    venue_id: String,
    levels: Vec<ViewerLevelDto>,
    bounds_by_level: BTreeMap<String, BoundsDto>,
    warnings: Vec<ViewerWarningDto>,
    stats: BundleStatsDto,
}

pub(crate) fn manifest_to_dto(document: &BundleDocument) -> Result<ManifestSection, BundleError> {
    Ok(ManifestSection {
        bundle: BundleMetadataDto {
            dataset_id: document.metadata.dataset_id.clone(),
            version: document.metadata.version,
        },
        source_manifest: ImdfManifestDto {
            version: document.manifest.version.clone(),
            language: document.manifest.language.clone(),
            rest: object_to_dto(&document.manifest.rest)?,
        },
        venue_id: document.venue_id.clone(),
        levels: document
            .levels
            .iter()
            .map(level_to_dto)
            .collect::<Result<_, _>>()?,
        bounds_by_level: document
            .bounds_by_level
            .iter()
            .map(|(id, bounds)| Ok((id.clone(), bounds_to_dto(*bounds)?)))
            .collect::<Result<_, _>>()?,
        warnings: document.warnings.iter().map(warning_to_dto).collect(),
        stats: BundleStatsDto {
            levels: document.stats.levels,
            features: document.stats.features,
        },
    })
}

pub(crate) fn manifest_into_document(
    dto: ManifestSection,
    features: Vec<VenueFeature>,
) -> Result<BundleDocument, BundleError> {
    Ok(BundleDocument {
        metadata: BundleMetadata {
            dataset_id: dto.bundle.dataset_id,
            version: dto.bundle.version,
        },
        manifest: ImdfManifest {
            version: dto.source_manifest.version,
            language: dto.source_manifest.language,
            rest: dto_to_object(&dto.source_manifest.rest)?,
        },
        venue_id: dto.venue_id,
        levels: dto
            .levels
            .into_iter()
            .map(level_from_dto)
            .collect::<Result<_, _>>()?,
        bounds_by_level: dto
            .bounds_by_level
            .into_iter()
            .map(|(id, bounds)| Ok((id, bounds_from_dto(bounds)?)))
            .collect::<Result<_, _>>()?,
        warnings: dto.warnings.into_iter().map(warning_from_dto).collect(),
        features,
        stats: BundleStats {
            levels: dto.stats.levels,
            features: dto.stats.features,
        },
        graph: None,
        facilities: None,
    })
}

/// Serializable mirror of `kiriko_route::RouteNode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct GraphNodeDto {
    lon: f64,
    lat: f64,
    ordinal: f64,
}

/// Serializable mirror of `kiriko_route::RouteEdge`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct GraphEdgeDto {
    from: u32,
    to: u32,
    weight: f32,
    ordinal: f64,
    interior: Vec<[f64; 2]>,
}

/// Section 5 (graph): the routing graph. Optional — `encode_bundle` emits
/// it only when the document carries a non-empty graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct GraphSectionDto {
    nodes: Vec<GraphNodeDto>,
    edges: Vec<GraphEdgeDto>,
}

/// Validate one graph edge: both endpoints must index an existing node and
/// the weight must be finite. Shared by the encode and decode paths so a
/// hand-crafted section is held to exactly the same rules as a freshly
/// encoded one.
fn validate_graph_edge(
    from: u32,
    to: u32,
    weight: f32,
    ordinal: f64,
    interior: &[[f64; 2]],
    node_count: usize,
) -> Result<(), BundleError> {
    if from as usize >= node_count || to as usize >= node_count {
        return Err(BundleError::new(
            BundleErrorCode::InvalidBundle,
            format!(
                "graph edge endpoint ({from}, {to}) is out of bounds for {node_count} node(s)"
            ),
        ));
    }
    if !weight.is_finite() || !ordinal.is_finite() {
        return Err(BundleError::new(
            BundleErrorCode::InvalidBundle,
            "graph edge weight and ordinal must be finite",
        ));
    }
    if weight < 0.0 {
        return Err(BundleError::new(
            BundleErrorCode::InvalidBundle,
            "graph edge weight must be non-negative",
        ));
    }
    if interior.iter().any(|c| !c[0].is_finite() || !c[1].is_finite()) {
        return Err(BundleError::new(
            BundleErrorCode::InvalidBundle,
            "graph edge interior coordinate must be finite",
        ));
    }
    Ok(())
}

pub(crate) fn encode_graph(graph: &kiriko_route::RouteGraph) -> Result<Vec<u8>, BundleError> {
    let node_count = graph.nodes.len();
    let mut nodes = Vec::with_capacity(node_count);
    for node in &graph.nodes {
        nodes.push(GraphNodeDto {
            lon: canonical_f64(node.lon)?,
            lat: canonical_f64(node.lat)?,
            ordinal: canonical_f64(node.ordinal)?,
        });
    }
    let mut edges = Vec::with_capacity(graph.edges.len());
    for edge in &graph.edges {
        validate_graph_edge(edge.from, edge.to, edge.weight, edge.ordinal, &edge.interior, node_count)?;
        let mut interior = Vec::with_capacity(edge.interior.len());
        for c in &edge.interior {
            interior.push([canonical_f64(c[0])?, canonical_f64(c[1])?]);
        }
        edges.push(GraphEdgeDto {
            from: edge.from,
            to: edge.to,
            weight: edge.weight,
            ordinal: canonical_f64(edge.ordinal)?,
            interior,
        });
    }
    postcard::to_allocvec(&GraphSectionDto { nodes, edges }).map_err(|e| {
        BundleError::new(
            BundleErrorCode::InvalidBundle,
            format!("encode graph section: {e}"),
        )
    })
}

pub(crate) fn decode_graph(bytes: &[u8]) -> Result<kiriko_route::RouteGraph, BundleError> {
    let dto: GraphSectionDto =
        crate::codec::postcard_take_exact(bytes, "decode graph section")?;
    let node_count = dto.nodes.len();
    let mut nodes = Vec::with_capacity(node_count);
    for node in &dto.nodes {
        nodes.push(kiriko_route::RouteNode {
            lon: canonical_f64(node.lon)?,
            lat: canonical_f64(node.lat)?,
            ordinal: canonical_f64(node.ordinal)?,
        });
    }
    let mut edges = Vec::with_capacity(dto.edges.len());
    for edge in &dto.edges {
        validate_graph_edge(edge.from, edge.to, edge.weight, edge.ordinal, &edge.interior, node_count)?;
        let mut interior = Vec::with_capacity(edge.interior.len());
        for c in &edge.interior {
            interior.push([canonical_f64(c[0])?, canonical_f64(c[1])?]);
        }
        edges.push(kiriko_route::RouteEdge {
            from: edge.from,
            to: edge.to,
            weight: edge.weight,
            ordinal: canonical_f64(edge.ordinal)?,
            interior,
        });
    }
    Ok(kiriko_route::RouteGraph { nodes, edges })
}

/// Serializable mirror of `kiriko_facilities::FacilityAnchor`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub(crate) struct AnchorDto {
    lon: f64,
    lat: f64,
    ordinal: f64,
}

/// Serializable mirror of `kiriko_facilities::Facility`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FacilityDto {
    lon: f64,
    lat: f64,
    ordinal: f64,
    name: String,
    icon: String,
    anchor: Option<AnchorDto>,
}

/// Section 7 (facilities): the point facilities. Optional — `encode_bundle`
/// emits it only when the document carries non-empty facilities.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FacilitiesSectionDto {
    items: Vec<FacilityDto>,
}

fn anchor_to_dto(anchor: &kiriko_facilities::FacilityAnchor) -> Result<AnchorDto, BundleError> {
    Ok(AnchorDto {
        lon: canonical_f64(anchor.lon)?,
        lat: canonical_f64(anchor.lat)?,
        ordinal: canonical_f64(anchor.ordinal)?,
    })
}

fn anchor_from_dto(dto: &AnchorDto) -> Result<kiriko_facilities::FacilityAnchor, BundleError> {
    Ok(kiriko_facilities::FacilityAnchor {
        lon: canonical_f64(dto.lon)?,
        lat: canonical_f64(dto.lat)?,
        ordinal: canonical_f64(dto.ordinal)?,
    })
}

pub(crate) fn encode_facilities(
    facilities: &kiriko_facilities::Facilities,
) -> Result<Vec<u8>, BundleError> {
    let mut items = Vec::with_capacity(facilities.items.len());
    for facility in &facilities.items {
        items.push(FacilityDto {
            lon: canonical_f64(facility.lon)?,
            lat: canonical_f64(facility.lat)?,
            ordinal: canonical_f64(facility.ordinal)?,
            name: facility.name.clone(),
            icon: facility.icon.clone(),
            anchor: facility.anchor.as_ref().map(anchor_to_dto).transpose()?,
        });
    }
    postcard::to_allocvec(&FacilitiesSectionDto { items }).map_err(|e| {
        BundleError::new(
            BundleErrorCode::InvalidBundle,
            format!("encode facilities section: {e}"),
        )
    })
}

pub(crate) fn decode_facilities(
    bytes: &[u8],
) -> Result<kiriko_facilities::Facilities, BundleError> {
    let dto: FacilitiesSectionDto =
        crate::codec::postcard_take_exact(bytes, "decode facilities section")?;
    let mut items = Vec::with_capacity(dto.items.len());
    for facility in &dto.items {
        items.push(kiriko_facilities::Facility {
            lon: canonical_f64(facility.lon)?,
            lat: canonical_f64(facility.lat)?,
            ordinal: canonical_f64(facility.ordinal)?,
            name: facility.name.clone(),
            icon: facility.icon.clone(),
            anchor: facility.anchor.as_ref().map(anchor_from_dto).transpose()?,
        });
    }
    Ok(kiriko_facilities::Facilities { items })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feature(id: &str, feature_type: FeatureType) -> VenueFeature {
        VenueFeature {
            id: id.to_string(),
            feature_type,
            level_id: None,
            geometry: None,
            center: None,
            labels: BTreeMap::new(),
            alt_labels: BTreeMap::new(),
            category: None,
            accessibility: Vec::new(),
            restriction: None,
            source_properties: BTreeMap::new(),
        }
    }

    #[test]
    fn reassemble_rejects_an_occupant_placed_in_the_geometry_section() {
        let geometry = vec![feature("f1", FeatureType::Occupant)];
        let stores = vec![feature("f2", FeatureType::Occupant)];
        let err = reassemble_features(geometry, stores)
            .expect_err("an occupant in geometry must be rejected");
        assert_eq!(err.code, BundleErrorCode::InvalidBundle);
    }

    #[test]
    fn reassemble_rejects_a_non_occupant_placed_in_the_stores_section() {
        let geometry = vec![feature("f1", FeatureType::Address)];
        let stores = vec![feature("f2", FeatureType::Address)];
        let err = reassemble_features(geometry, stores)
            .expect_err("a non-occupant in stores must be rejected");
        assert_eq!(err.code, BundleErrorCode::InvalidBundle);
    }

    #[test]
    fn reassemble_accepts_correctly_split_canonically_ordered_features() {
        let geometry = vec![
            feature("f1", FeatureType::Address),
            feature("f2", FeatureType::Venue),
        ];
        let stores = vec![feature("f3", FeatureType::Occupant)];
        let out =
            reassemble_features(geometry, stores).expect("well-formed sections must reassemble");
        let ids: Vec<&str> = out.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["f1", "f3", "f2"],
            "occupant (order 10) sorts between address (0) and venue (15)"
        );
    }

    #[test]
    fn canonical_f64_rejects_nan_and_infinity() {
        assert!(canonical_f64(f64::NAN).is_err());
        assert!(canonical_f64(f64::INFINITY).is_err());
        assert!(canonical_f64(f64::NEG_INFINITY).is_err());
    }

    #[test]
    fn canonical_f64_normalizes_negative_zero() {
        let normalized = canonical_f64(-0.0).expect("negative zero is finite");
        assert_eq!(normalized.to_bits(), 0.0f64.to_bits());
        assert!(normalized.is_sign_positive());
    }

    /// A minimal, well-formed `ManifestSection` with a hand-picked ordinal,
    /// bypassing `canonical_f64` entirely (unlike going through
    /// `manifest_to_dto`, which would itself reject a non-finite value).
    /// This is how the tests below "smuggle" a bad float straight into a
    /// section payload, to prove `decode_bundle` independently enforces the
    /// same canonicalization `encode_bundle` enforces on the way in.
    fn manifest_section_with_ordinal(ordinal: f64) -> ManifestSection {
        ManifestSection {
            bundle: BundleMetadataDto {
                dataset_id: "test".to_string(),
                version: 1,
            },
            source_manifest: ImdfManifestDto {
                version: "1.0.0".to_string(),
                language: "en".to_string(),
                rest: BTreeMap::new(),
            },
            venue_id: "venue-1".to_string(),
            levels: vec![ViewerLevelDto {
                id: "level-1".to_string(),
                ordinal,
                label: BTreeMap::new(),
                short_name: BTreeMap::new(),
            }],
            bounds_by_level: BTreeMap::new(),
            warnings: Vec::new(),
            stats: BundleStatsDto {
                levels: 1,
                features: 0,
            },
        }
    }

    fn wrap_manifest_only_bundle(manifest_bytes: Vec<u8>) -> Vec<u8> {
        let empty_features: Vec<u8> =
            postcard::to_allocvec(&Vec::<FeatureDto>::new()).expect("empty vec encodes");
        let payload = crate::format::build_payload(&[
            (
                crate::format::SECTION_MANIFEST,
                crate::format::SECTION_VERSION,
                manifest_bytes,
            ),
            (
                crate::format::SECTION_GEOMETRY,
                crate::format::SECTION_VERSION,
                empty_features.clone(),
            ),
            (
                crate::format::SECTION_STORES,
                crate::format::SECTION_VERSION,
                empty_features,
            ),
        ]);
        crate::format::encode_payload(&payload).expect("hand-built payload encodes")
    }

    #[test]
    fn decode_bundle_rejects_a_nan_smuggled_directly_into_a_section_payload() {
        let manifest_bytes = postcard::to_allocvec(&manifest_section_with_ordinal(f64::NAN))
            .expect("dto with NaN still postcard-encodes");
        let bytes = wrap_manifest_only_bundle(manifest_bytes);

        let err =
            crate::decode_bundle(&bytes).expect_err("a smuggled NaN ordinal must be rejected");
        assert_eq!(err.code, BundleErrorCode::InvalidBundle);
    }

    #[test]
    fn decode_bundle_normalizes_a_smuggled_negative_zero_ordinal() {
        let manifest_bytes = postcard::to_allocvec(&manifest_section_with_ordinal(-0.0))
            .expect("dto with -0.0 postcard-encodes");
        let bytes = wrap_manifest_only_bundle(manifest_bytes);

        let document = crate::decode_bundle(&bytes)
            .expect("a smuggled -0.0 ordinal is finite and must decode");
        assert_eq!(
            document.levels[0].ordinal.to_bits(),
            0.0f64.to_bits(),
            "decode must normalize -0.0 to +0.0"
        );
    }

    #[test]
    fn decode_bundle_rejects_trailing_bytes_after_a_postcard_section_value() {
        let mut manifest_bytes =
            postcard::to_allocvec(&manifest_section_with_ordinal(1.0)).expect("dto encodes");
        manifest_bytes.push(0xFF); // garbage padding after a valid postcard value
        let bytes = wrap_manifest_only_bundle(manifest_bytes);

        let err = crate::decode_bundle(&bytes)
            .expect_err("trailing bytes after a section value must be rejected");
        assert_eq!(err.code, BundleErrorCode::InvalidBundle);
    }

    /// A minimal, well-formed `BundleDocument` with no features and no
    /// graph, for graph-section round-trip tests.
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
            levels: Vec::new(),
            features: Vec::new(),
            bounds_by_level: BTreeMap::new(),
            warnings: Vec::new(),
            stats: BundleStats {
                levels: 0,
                features: 0,
            },
            graph: None,
            facilities: None,
        }
    }

    #[test]
    fn graph_section_round_trips() {
        use kiriko_route::{RouteEdge, RouteGraph, RouteNode};
        let mut doc = minimal_document();
        doc.graph = Some(RouteGraph {
            nodes: vec![
                RouteNode {
                    lon: 139.0,
                    lat: 35.0,
                    ordinal: 0.0,
                },
                RouteNode {
                    lon: 139.1,
                    lat: 35.1,
                    ordinal: 1.0,
                },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 12.5,
                ordinal: 0.0,
                interior: vec![],
            }],
        });
        let bytes = crate::encode_bundle(&doc).expect("a document with a graph encodes");
        let back = crate::decode_bundle(&bytes).expect("a graph bundle decodes");
        assert_eq!(back.graph, doc.graph);
    }
    #[test]
    fn graph_section_round_trips_edge_geometry() {
        use kiriko_route::{RouteEdge, RouteGraph, RouteNode};
        let mut doc = minimal_document();
        doc.graph = Some(RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.002, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![RouteEdge {
                from: 0,
                to: 1,
                weight: 12.5,
                ordinal: 0.0,
                interior: vec![[139.001, 35.001]],
            }],
        });
        let bytes = crate::encode_bundle(&doc).expect("encodes");
        let back = crate::decode_bundle(&bytes).expect("decodes");
        assert_eq!(back.graph, doc.graph);
    }


    #[test]
    fn no_graph_section_when_absent() {
        let doc = minimal_document();
        let bytes = crate::encode_bundle(&doc).expect("a graph-less document encodes");
        assert_eq!(
            crate::decode_bundle(&bytes)
                .expect("a graph-less bundle decodes")
                .graph,
            None
        );
    }

    /// Wrap a hand-built manifest and graph section into a full bundle,
    /// bypassing `encode_graph` so an invalid edge endpoint can be smuggled
    /// straight into the section payload.
    fn wrap_bundle_with_graph(manifest_bytes: Vec<u8>, graph_bytes: Vec<u8>) -> Vec<u8> {
        let empty_features: Vec<u8> =
            postcard::to_allocvec(&Vec::<FeatureDto>::new()).expect("empty vec encodes");
        let payload = crate::format::build_payload(&[
            (
                crate::format::SECTION_MANIFEST,
                crate::format::SECTION_VERSION,
                manifest_bytes,
            ),
            (
                crate::format::SECTION_GEOMETRY,
                crate::format::SECTION_VERSION,
                empty_features.clone(),
            ),
            (
                crate::format::SECTION_STORES,
                crate::format::SECTION_VERSION,
                empty_features,
            ),
            (
                crate::format::SECTION_GRAPH,
                crate::format::SECTION_VERSION,
                graph_bytes,
            ),
        ]);
        crate::format::encode_payload(&payload).expect("hand-built payload encodes")
    }

    /// Wrap a hand-built manifest and facilities section into a full bundle,
    /// bypassing `encode_facilities` so a non-finite coordinate can be
    /// smuggled straight into the section payload.
    fn wrap_bundle_with_facilities(manifest_bytes: Vec<u8>, facilities_bytes: Vec<u8>) -> Vec<u8> {
        let empty_features: Vec<u8> =
            postcard::to_allocvec(&Vec::<FeatureDto>::new()).expect("empty vec encodes");
        let payload = crate::format::build_payload(&[
            (
                crate::format::SECTION_MANIFEST,
                crate::format::SECTION_VERSION,
                manifest_bytes,
            ),
            (
                crate::format::SECTION_GEOMETRY,
                crate::format::SECTION_VERSION,
                empty_features.clone(),
            ),
            (
                crate::format::SECTION_STORES,
                crate::format::SECTION_VERSION,
                empty_features,
            ),
            (
                crate::format::SECTION_FACILITIES,
                crate::format::SECTION_VERSION,
                facilities_bytes,
            ),
        ]);
        crate::format::encode_payload(&payload).expect("hand-built payload encodes")
    }

    fn facility(
        lon: f64,
        lat: f64,
        ordinal: f64,
        name: &str,
        icon: &str,
        anchor: Option<kiriko_facilities::FacilityAnchor>,
    ) -> kiriko_facilities::Facility {
        kiriko_facilities::Facility {
            lon,
            lat,
            ordinal,
            name: name.to_string(),
            icon: icon.to_string(),
            anchor,
        }
    }

    #[test]
    fn facilities_section_round_trips() {
        let mut doc = minimal_document();
        doc.facilities = Some(kiriko_facilities::Facilities {
            items: vec![
                facility(
                    139.0,
                    35.0,
                    0.0,
                    "Gate A",
                    "gate",
                    Some(kiriko_facilities::FacilityAnchor {
                        lon: 139.0005,
                        lat: 35.0005,
                        ordinal: 0.0,
                    }),
                ),
                facility(139.1, 35.1, 1.0, "Restroom", "restroom", None),
            ],
        });
        let bytes = crate::encode_bundle(&doc).expect("a document with facilities encodes");
        let back = crate::decode_bundle(&bytes).expect("a facilities bundle decodes");
        assert_eq!(back.facilities, doc.facilities);
    }

    #[test]
    fn no_facilities_section_when_absent() {
        let doc = minimal_document();
        let bytes = crate::encode_bundle(&doc).expect("a facility-less document encodes");
        assert_eq!(
            crate::decode_bundle(&bytes)
                .expect("a facility-less bundle decodes")
                .facilities,
            None
        );
    }

    #[test]
    fn empty_facilities_are_never_emitted() {
        let mut doc = minimal_document();
        doc.facilities = Some(kiriko_facilities::Facilities { items: Vec::new() });
        let bytes = crate::encode_bundle(&doc).expect("empty facilities still encode");
        assert_eq!(
            crate::decode_bundle(&bytes)
                .expect("the bundle decodes")
                .facilities,
            None,
            "an empty facilities list must not round-trip into a section"
        );
    }

    #[test]
    fn rejects_a_facility_anchor_with_a_non_finite_coordinate() {
        let manifest_bytes =
            postcard::to_allocvec(&manifest_section_with_ordinal(1.0)).expect("dto encodes");
        let facilities_bytes = postcard::to_allocvec(&FacilitiesSectionDto {
            items: vec![FacilityDto {
                lon: 139.0,
                lat: 35.0,
                ordinal: 0.0,
                name: "Gate A".to_string(),
                icon: "gate".to_string(),
                anchor: Some(AnchorDto {
                    lon: f64::NAN,
                    lat: 35.0,
                    ordinal: 0.0,
                }),
            }],
        })
        .expect("a NaN anchor still postcard-encodes");
        let bytes = wrap_bundle_with_facilities(manifest_bytes, facilities_bytes);

        let err = crate::decode_bundle(&bytes)
            .expect_err("a non-finite anchor coordinate must be rejected");
        assert_eq!(err.code, BundleErrorCode::InvalidBundle);
    }

    #[test]
    fn graph_and_facilities_sections_coexist_in_ascending_directory_order() {
        use kiriko_route::{RouteEdge, RouteGraph, RouteNode};
        let mut doc = minimal_document();
        doc.graph = Some(RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![RouteEdge { from: 0, to: 1, weight: 100.0, ordinal: 0.0, interior: Vec::new() }],
        });
        doc.facilities = Some(kiriko_facilities::Facilities {
            items: vec![facility(139.0, 35.0, 0.0, "Gate A", "gate", None)],
        });
        let bytes = crate::encode_bundle(&doc).expect("a graph+facilities document encodes");

        let payload = crate::format::decode_payload(&bytes).expect("the envelope decodes");
        let row_count = u16::from_le_bytes(payload[0..2].try_into().unwrap()) as usize;
        let ids: Vec<u16> = (0..row_count)
            .map(|i| {
                let start = 2 + i * 20;
                u16::from_le_bytes(payload[start..start + 2].try_into().unwrap())
            })
            .collect();
        assert_eq!(ids, vec![1, 2, 3, 5, 7], "directory ids must ascend");

        let back = crate::decode_bundle(&bytes).expect("the bundle decodes");
        assert_eq!(back.graph, doc.graph);
        assert_eq!(back.facilities, doc.facilities);
    }

    #[test]
    fn rejects_graph_edge_out_of_bounds() {
        let manifest_bytes = postcard::to_allocvec(&manifest_section_with_ordinal(1.0))
            .expect("dto encodes");
        let graph_bytes = postcard::to_allocvec(&GraphSectionDto {
            nodes: vec![GraphNodeDto {
                lon: 139.0,
                lat: 35.0,
                ordinal: 0.0,
            }],
            edges: vec![GraphEdgeDto {
                from: 0,
                to: 7, // only one node exists; endpoint 7 is out of bounds
                weight: 1.0,
                ordinal: 0.0,
                interior: vec![],
            }],
        })
        .expect("an out-of-bounds edge still postcard-encodes");
        let bytes = wrap_bundle_with_graph(manifest_bytes, graph_bytes);

        let err = crate::decode_bundle(&bytes)
            .expect_err("a graph edge past the node count must be rejected");
        assert_eq!(err.code, BundleErrorCode::InvalidBundle);
    }

    #[test]
    fn rejects_negative_graph_edge_weight_on_decode() {
        let manifest_bytes = postcard::to_allocvec(&manifest_section_with_ordinal(1.0))
            .expect("dto encodes");
        let graph_bytes = postcard::to_allocvec(&GraphSectionDto {
            nodes: vec![
                GraphNodeDto { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                GraphNodeDto { lon: 139.001, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![GraphEdgeDto {
                from: 0,
                to: 1,
                weight: -1.0, // a negative routing cost is never valid
                ordinal: 0.0,
                interior: vec![],
            }],
        })
        .expect("a negative-weight edge still postcard-encodes");
        let bytes = wrap_bundle_with_graph(manifest_bytes, graph_bytes);
        let err = crate::decode_bundle(&bytes)
            .expect_err("a negative graph edge weight must be rejected on decode");
        assert_eq!(err.code, BundleErrorCode::InvalidBundle);
    }

    #[test]
    fn rejects_negative_graph_edge_weight_on_encode() {
        use kiriko_route::{RouteEdge, RouteGraph, RouteNode};
        let graph = RouteGraph {
            nodes: vec![
                RouteNode { lon: 139.0, lat: 35.0, ordinal: 0.0 },
                RouteNode { lon: 139.001, lat: 35.0, ordinal: 0.0 },
            ],
            edges: vec![RouteEdge { from: 0, to: 1, weight: -1.0, ordinal: 0.0, interior: vec![] }],
        };
        assert!(encode_graph(&graph).is_err(), "encoding a negative-weight edge must fail");
    }
}
