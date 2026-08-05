//! Canonical spatial-context (§8) types and deterministic WGS84 geodesy.
//!
//! One shared local coordinate frame per immutable venue version — source-
//! neutral, anchored at the canonical venue horizontal-bounds centre — plus
//! the typed registries that later records reference instead of duplicating
//! evidence. This module holds the canonical model only; the postcard DTOs
//! and the §8 codec live in `kiriko-bundle` (the same split as
//! `kiriko_route::RouteGraph` / the bundle's graph section DTOs).
//!
//! Two numeric representations sit side by side by design. Resolved values
//! (the vertical normalisation offset, and later floor-plane scene Z) are
//! checked integer millimetres so identical inputs always compile
//! byte-identically and rounding cannot vary between runs. Source evidence
//! (anchor longitude/latitude, transform coefficients, datum constants)
//! stays canonical finite double precision so nothing measured is lost.
//! No timestamps, no source-archive hashing: both would break byte-identical
//! compilation of identical canonical inputs.

use std::collections::BTreeMap;

use crate::canonical::Value;
use crate::geometry::{BoundsAccum, visit_geometry};
use crate::model::{Bounds, VenueModel};

/// WGS84 ellipsoid semi-major axis, metres.
pub const WGS84_SEMI_MAJOR_M: f64 = 6_378_137.0;
/// WGS84 ellipsoid inverse flattening.
pub const WGS84_INVERSE_FLATTENING: f64 = 298.257_223_563;
/// Bounds on the vertical normalisation offset, checked integer millimetres
/// (±1000 km). Far beyond any real venue; rejects garbage without ever being
/// reached by a legitimate producer.
pub const MAX_VERTICAL_OFFSET_MM: i64 = 1_000_000_000;

/// The frame's declared axis convention. Local X is east, Y north, Z up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axes {
    EastNorthUp,
}

/// Declared units for resolved coordinates in this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LengthUnit {
    Millimetre,
}

/// What a [`SourceLocator`] points at inside the source data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocatorKind {
    /// An entry inside the source archive.
    ArchivePath,
    /// A source feature id (e.g. the IMDF venue feature).
    FeatureId,
    /// A source layer/collection name.
    LayerName,
}

/// What a registered [`Transform`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransformKind {
    /// A source-registration transform (profile data, versioned).
    Registration,
}

/// How an assumption entered the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssumptionKind {
    /// A configured default (e.g. nominal floor spacing).
    Nominal,
    /// Derived from other evidence (e.g. a preserved network altitude).
    Inferred,
}

/// How a piece of [`RegistrationEvidence`] was produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceMethod {
    /// Derived deterministically from the venue's own geometry.
    DerivedFromVenueGeometry,
    /// An explicit imported or trusted mapped elevation field.
    ImportedElevation,
    /// A preserved routing-network altitude.
    PreservedNetworkAltitude,
    /// A nominal spacing assumption.
    NominalSpacing,
}

/// Reliability class of a registered confidence value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidenceKind {
    Measured,
    Estimated,
    Assumed,
    Unknown,
}

/// WGS84 ellipsoid parameters of a declared datum.
#[derive(Debug, Clone, PartialEq)]
pub struct Ellipsoid {
    pub semi_major_metres: f64,
    pub inverse_flattening: f64,
}

/// A declared coordinate datum (the frame references one by index).
#[derive(Debug, Clone, PartialEq)]
pub struct Datum {
    pub name: String,
    pub ellipsoid: Ellipsoid,
}

/// A source artifact and its content hash. Hash semantics are defined by the
/// producer that registers the artifact; nothing in this module interprets
/// them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceArtifact {
    pub name: String,
    pub hash: [u8; 32],
}

/// A locator into the source data. `artifact_ref` indexes
/// [`Registries::artifacts`] when the locator resolves within a registered
/// artifact, `None` when the source object is not tracked as an artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceLocator {
    pub kind: LocatorKind,
    pub value: String,
    pub artifact_ref: Option<u32>,
}

/// A registered transform. Coefficients are canonical finite doubles; `unit`
/// states what the coefficients are expressed in.
#[derive(Debug, Clone, PartialEq)]
pub struct Transform {
    pub kind: TransformKind,
    pub coefficients: Vec<f64>,
    pub unit: LengthUnit,
    pub profile_version: u32,
}

/// Evidence that a placement (e.g. the frame anchor) was registered against
/// the source data. References registry entries rather than duplicating them.
#[derive(Debug, Clone, PartialEq)]
pub struct RegistrationEvidence {
    pub method: EvidenceMethod,
    pub source_locator_ref: u32,
    pub transform_ref: Option<u32>,
    pub confidence_ref: Option<u32>,
    /// Index into [`Registries::assumptions`] when this evidence rests on an
    /// assumption (e.g. a nominal-spacing placement).
    pub assumption_ref: Option<u32>,
    pub detail: String,
}

/// A nominal or inferred assumption recorded as evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assumption {
    pub kind: AssumptionKind,
    pub detail: String,
}

/// A registered confidence value: a finite 0..=1 number plus its reliability
/// class.
#[derive(Debug, Clone, PartialEq)]
pub struct Confidence {
    pub kind: ConfidenceKind,
    pub value: f64,
}

/// A human decision recorded as provenance (e.g. a floor-plane override).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualProvenance {
    pub actor: String,
    pub reason: String,
}

/// The one shared local frame per immutable venue version.
///
/// `world_translation` equals `ecef_origin` by construction (the compile path
/// derives both from the same anchor); the decoder validates the equality so
/// a hand-crafted inconsistent frame is rejected.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// Exact WGS84 anchor: longitude, latitude of the canonical venue
    /// horizontal-bounds centre. Source evidence, full precision.
    pub anchor: [f64; 2],
    /// The ECEF transform: the anchor's position in ECEF metres (the
    /// geodetic→ECEF conversion applied at the anchor; the coefficients are
    /// the declared datum's ellipsoid constants).
    pub ecef_origin: [f64; 3],
    /// The world-transform rotation: the ENU basis (east, north, up) as ECEF
    /// unit vectors — `p_ecef = world_translation + enu_basis_ecef · p_enu`.
    pub enu_basis_ecef: [[f64; 3]; 3],
    /// The world-transform translation, ECEF metres (== `ecef_origin`).
    pub world_translation: [f64; 3],
    /// Declared axis convention: local X east, Y north, Z up.
    pub axes: Axes,
    /// Declared units for resolved coordinates in this frame.
    pub unit: LengthUnit,
    /// Offset added to scene Z so it is normalised non-negative, checked
    /// integer millimetres. `0` until floor records (#39) resolve planes.
    pub vertical_normalisation_offset_mm: i64,
    /// Index into [`Registries::datums`] — the declared datum.
    pub datum_ref: u32,
    /// Index into [`Registries::registration_evidence`] — the evidence for
    /// the anchor placement.
    pub anchor_evidence_ref: u32,
}

/// Shared typed evidence registries. Records reference entries by index
/// rather than duplicating evidence. Empty registries are valid: producers
/// populate them as the evidence arrives (floor records #39, overrides #40).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Registries {
    pub artifacts: Vec<SourceArtifact>,
    pub locators: Vec<SourceLocator>,
    pub datums: Vec<Datum>,
    pub transforms: Vec<Transform>,
    pub registration_evidence: Vec<RegistrationEvidence>,
    pub assumptions: Vec<Assumption>,
    pub confidence: Vec<Confidence>,
    pub manual_provenance: Vec<ManualProvenance>,
}

/// How a level's floor plane was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionMethod {
    /// An explicit imported or trusted mapped elevation won the precedence.
    ImportedElevation,
    /// A preserved routing-network altitude won (validated, trustworthy).
    NetworkAltitude,
    /// Configurable nominal floor spacing was assumed.
    NominalSpacing,
}

/// One canonical level's resolved floor plane, referencing the §8 registries.
///
/// The resolved value is a checked integer millimetre scene Z; the original
/// source elevation stays full-precision `f64`. Evidence and confidence are
/// referenced by registry index, never duplicated.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelRecord {
    pub level_id: String,
    pub ordinal: f64,
    /// Original source elevation (metres), full precision, when one exists.
    pub source_elevation_m: Option<f64>,
    /// Preserved network altitude minus imported elevation, checked integer
    /// millimetres, when both existed — the disagreement is recorded, never
    /// silently overwriting either value.
    pub network_difference_mm: Option<i64>,
    /// Resolved floor-plane scene Z, checked integer millimetres,
    /// non-negative (the frame's normalisation offset puts the lowest plane
    /// at 0).
    pub resolved_scene_z_mm: i64,
    /// The precedence branch that actually resolved this level.
    pub method: ResolutionMethod,
    /// Index into [`Registries::confidence`].
    pub confidence_ref: u32,
    /// Indices into [`Registries::registration_evidence`].
    pub evidence_refs: Vec<u32>,
    /// The producer's corrected plane, metres (full precision), when this
    /// level is overridden. The source elevation above stays untouched and
    /// readable — an override corrects Kiriko's interpretation, never its
    /// record of the source.
    pub override_elevation_m: Option<f64>,
    /// Index into [`Registries::manual_provenance`] — who overrode and why.
    /// Present exactly when `override_elevation_m` is: an override is never
    /// silently invented, and its absence is distinguishable from an
    /// override that happens to match the automatic value.
    pub override_ref: Option<u32>,
}

/// Section 8 (spatial context) content: the shared frame plus the evidence
/// registries behind it. `levels` holds every canonical level's resolved
/// floor plane, referencing the registries. `source_properties` preserves
/// bounded source fields Kiriko does not model, for audit and export; nothing
/// here interprets them.
#[derive(Debug, Clone, PartialEq)]
pub struct SpatialContext {
    pub frame: Frame,
    pub registries: Registries,
    pub levels: Vec<LevelRecord>,
    pub source_properties: BTreeMap<String, Value>,
}

/// WGS84 geodetic (longitude/latitude degrees, ellipsoidal height metres) to
/// ECEF metres. Deterministic: fixed constants, one evaluation order.
pub fn wgs84_ecef(lon_deg: f64, lat_deg: f64, height_m: f64) -> [f64; 3] {
    let (lon, lat) = (lon_deg.to_radians(), lat_deg.to_radians());
    let e2 = 2.0 / WGS84_INVERSE_FLATTENING - 1.0 / (WGS84_INVERSE_FLATTENING * WGS84_INVERSE_FLATTENING);
    let prime_vertical = WGS84_SEMI_MAJOR_M / (1.0 - e2 * lat.sin() * lat.sin()).sqrt();
    let (cos_lon, sin_lon, cos_lat, sin_lat) = (lon.cos(), lon.sin(), lat.cos(), lat.sin());
    [
        (prime_vertical + height_m) * cos_lat * cos_lon,
        (prime_vertical + height_m) * cos_lat * sin_lon,
        (prime_vertical * (1.0 - e2) + height_m) * sin_lat,
    ]
}

/// The ENU basis at `(lon_deg, lat_deg)`, as ECEF unit vectors. Columns are
/// `[east, north, up]`; this is the world-transform rotation mapping local
/// ENU metres to ECEF.
pub fn enu_basis_ecef(lon_deg: f64, lat_deg: f64) -> [[f64; 3]; 3] {
    let (lon, lat) = (lon_deg.to_radians(), lat_deg.to_radians());
    let (cos_lon, sin_lon, cos_lat, sin_lat) = (lon.cos(), lon.sin(), lat.cos(), lat.sin());
    [
        [-sin_lon, cos_lon, 0.0],
        [-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat],
        [cos_lat * cos_lon, cos_lat * sin_lon, sin_lat],
    ]
}

/// Canonical venue horizontal bounds: the Venue feature's own geometry
/// bounds; falls back to the union of `bounds_by_level` when the venue
/// feature has no usable geometry. `None` when neither exists — a venue
/// without any horizontal extent gets no frame (spatial context absent).
pub fn venue_horizontal_bounds(venue: &VenueModel) -> Option<Bounds> {
    for feature in &venue.features {
        if feature.feature_type != crate::model::FeatureType::Venue {
            continue;
        }
        if let Some(geometry) = feature.geometry.as_ref() {
            let mut accum = BoundsAccum::new();
            visit_geometry(geometry, &mut accum);
            if let Some(bounds) = accum.finish() {
                return Some(bounds);
            }
        }
    }
    let mut union = BoundsAccum::new();
    for bounds in venue.bounds_by_level.values() {
        union.add_point(bounds.west, bounds.south);
        union.add_point(bounds.east, bounds.north);
    }
    union.finish()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::canonical::Value;
    use crate::model::{Bounds, FeatureType, ImdfManifest, VenueFeature, VenueModel};

    use super::{
        Axes, LengthUnit, SpatialContext, WGS84_INVERSE_FLATTENING, WGS84_SEMI_MAJOR_M, enu_basis_ecef,
        venue_horizontal_bounds, wgs84_ecef,
    };

    #[test]
    fn wgs84_constants_are_the_standard_ellipsoid_values() {
        assert_eq!(WGS84_SEMI_MAJOR_M, 6_378_137.0);
        assert_eq!(WGS84_INVERSE_FLATTENING, 298.257_223_563);
    }

    #[test]
    fn ecef_at_the_prime_meridian_equator_is_pure_x_axis() {
        assert_eq!(wgs84_ecef(0.0, 0.0, 0.0), [6_378_137.0, 0.0, 0.0]);
    }

    #[test]
    fn ecef_is_finite_at_the_fixture_anchor() {
        let p = wgs84_ecef(139.767, 35.681, 0.0);
        assert!(p.iter().all(|c| c.is_finite()));
    }

    #[test]
    fn up_basis_column_is_the_normalized_ecef_origin_at_zero_height() {
        // At the equator the ellipsoid normal coincides with the radial
        // direction, so the equality holds exactly there. At other latitudes
        // they differ by the flattening term — the fixture anchor's basis is
        // covered by `enu_basis_is_orthonormal_and_right_handed`.
        let (lon, lat) = (139.767, 0.0);
        let origin = wgs84_ecef(lon, lat, 0.0);
        let norm = (origin[0] * origin[0] + origin[1] * origin[1] + origin[2] * origin[2]).sqrt();
        let up = enu_basis_ecef(lon, lat)[2];
        for (a, b) in up.iter().zip(origin.iter().map(|c| c / norm)) {
            assert!((a - b).abs() < 1e-9, "up {a} != normalized origin {b}");
        }
    }

    #[test]
    fn enu_basis_is_orthonormal_and_right_handed() {
        let basis = enu_basis_ecef(139.767, 35.681);
        let norm = |v: &[f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        let dot = |a: &[f64; 3], b: &[f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        for col in &basis {
            assert!((norm(col) - 1.0).abs() < 1e-9, "basis column is not a unit vector");
        }
        assert!(dot(&basis[0], &basis[1]).abs() < 1e-9, "east · north != 0");
        assert!(dot(&basis[0], &basis[2]).abs() < 1e-9, "east · up != 0");
        assert!(dot(&basis[1], &basis[2]).abs() < 1e-9, "north · up != 0");
        let cross = [
            basis[0][1] * basis[1][2] - basis[0][2] * basis[1][1],
            basis[0][2] * basis[1][0] - basis[0][0] * basis[1][2],
            basis[0][0] * basis[1][1] - basis[0][1] * basis[1][0],
        ];
        for (a, b) in cross.iter().zip(basis[2].iter()) {
            assert!((a - b).abs() < 1e-9, "east × north != up");
        }
    }

    fn polygon(ring: &[[f64; 2]]) -> Value {
        Value::Object(BTreeMap::from([
            ("type".into(), Value::String("Polygon".into())),
            (
                "coordinates".into(),
                Value::Array(vec![Value::Array(
                    ring.iter()
                        .map(|[lon, lat]| {
                            Value::Array(vec![Value::Number(*lon), Value::Number(*lat)])
                        })
                        .collect(),
                )]),
            ),
        ]))
    }

    fn venue_model(feature_geometry: Option<Value>, level_bounds: Vec<(&str, Bounds)>) -> VenueModel {
        let features = match feature_geometry {
            Some(geom) => vec![VenueFeature {
                id: "venue-1".into(),
                feature_type: FeatureType::Venue,
                level_id: None,
                geometry: Some(geom),
                center: None,
                labels: BTreeMap::new(),
                alt_labels: BTreeMap::new(),
                category: None,
                accessibility: Vec::new(),
                restriction: None,
                source_properties: BTreeMap::new(),
            }],
            None => Vec::new(),
        };
        VenueModel {
            manifest: ImdfManifest {
                version: "1.0.0".into(),
                language: "en".into(),
                rest: BTreeMap::new(),
            },
            venue_id: "v".into(),
            levels: Vec::new(),
            features,
            bounds_by_level: level_bounds
                .into_iter()
                .map(|(k, b)| (k.to_string(), b))
                .collect(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn venue_horizontal_bounds_use_the_venue_feature_geometry() {
        let geom = polygon(&[
            [139.766, 35.680],
            [139.768, 35.680],
            [139.768, 35.682],
            [139.766, 35.682],
            [139.766, 35.680],
        ]);
        let model = venue_model(Some(geom), vec![]);
        let bounds = venue_horizontal_bounds(&model).expect("venue geometry yields bounds");
        assert_eq!(
            (bounds.west, bounds.south, bounds.east, bounds.north),
            (139.766, 35.680, 139.768, 35.682)
        );
    }

    #[test]
    fn venue_horizontal_bounds_fall_back_to_the_level_bounds_union() {
        let b1 = Bounds { west: 139.0, south: 35.0, east: 139.1, north: 35.1 };
        let b2 = Bounds { west: 139.05, south: 34.95, east: 139.2, north: 35.05 };
        let model = venue_model(None, vec![("l1", b1), ("l2", b2)]);
        let bounds = venue_horizontal_bounds(&model).expect("level bounds yield a union");
        assert_eq!(
            (bounds.west, bounds.south, bounds.east, bounds.north),
            (139.0, 34.95, 139.2, 35.1)
        );
    }

    #[test]
    fn venue_horizontal_bounds_are_none_without_geometry() {
        assert_eq!(venue_horizontal_bounds(&venue_model(None, vec![])), None);
    }

    #[test]
    fn spatial_context_types_are_constructible() {
        let context = SpatialContext {
            frame: super::Frame {
                anchor: [139.767, 35.681],
                ecef_origin: [1.0, 2.0, 3.0],
                enu_basis_ecef: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                world_translation: [1.0, 2.0, 3.0],
                axes: Axes::EastNorthUp,
                unit: LengthUnit::Millimetre,
                vertical_normalisation_offset_mm: 0,
                datum_ref: 0,
                anchor_evidence_ref: 0,
            },
            registries: super::Registries::default(),
            levels: Vec::new(),
            source_properties: BTreeMap::new(),
        };
        assert_eq!(context.frame.axes, Axes::EastNorthUp);
        assert_eq!(context.frame.unit, LengthUnit::Millimetre);
        assert!(context.registries.artifacts.is_empty());
        assert!(context.levels.is_empty());
        assert!(context.source_properties.is_empty());
    }

    #[test]
    fn level_record_and_resolution_method_are_constructible() {
        use super::{LevelRecord, ResolutionMethod};
        let record = LevelRecord {
            level_id: "level-1".into(),
            ordinal: 1.5,
            source_elevation_m: Some(12.25),
            network_difference_mm: Some(-250),
            resolved_scene_z_mm: 4000,
            method: ResolutionMethod::ImportedElevation,
            confidence_ref: 0,
            evidence_refs: vec![0, 1],
            override_elevation_m: None,
            override_ref: None,
        };
        assert_eq!(record.method, ResolutionMethod::ImportedElevation);
        assert_eq!(record.resolved_scene_z_mm, 4000);
        assert_eq!(record.evidence_refs, vec![0, 1]);
        assert_eq!(ResolutionMethod::NetworkAltitude as u8, 1);
        assert_eq!(ResolutionMethod::NominalSpacing as u8, 2);
    }

    #[test]
    fn registration_evidence_carries_an_optional_assumption_reference() {
        use super::{EvidenceMethod, RegistrationEvidence};
        let evidence = RegistrationEvidence {
            method: EvidenceMethod::NominalSpacing,
            source_locator_ref: 0,
            transform_ref: None,
            confidence_ref: Some(0),
            assumption_ref: Some(2),
            detail: "nominal spacing applied".into(),
        };
        assert_eq!(evidence.assumption_ref, Some(2));
        assert!(matches!(
            evidence.method,
            EvidenceMethod::NominalSpacing | EvidenceMethod::ImportedElevation | EvidenceMethod::PreservedNetworkAltitude
        ));
    }
}
