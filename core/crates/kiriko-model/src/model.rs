//! Canonical venue model types produced by [`crate::import_imdf`].
//!
//! Mirrors the TypeScript `LoadedVenue` projection (`src/imdf/types.ts`) but
//! replaces JS `Map`/`Record` iteration with `BTreeMap` and a single sorted
//! feature vector ordered by the documented IMDF feature-type order. Within
//! each collection the original source array order is preserved.

use std::collections::BTreeMap;

use crate::canonical::Object;

/// Documented canonical ordering of IMDF feature collections. Lower index =
/// earlier in the canonical feature vector.
///
/// This is a stable, source-independent ordering: regardless of ZIP record
/// order, two archives with the same set of features produce identical
/// `VenueModel::features` vectors.
pub const FEATURE_TYPE_ORDER: &[FeatureType] = &[
    FeatureType::Address,
    FeatureType::Amenity,
    FeatureType::Anchor,
    FeatureType::Building,
    FeatureType::Detail,
    FeatureType::Fixture,
    FeatureType::Footprint,
    FeatureType::Geofence,
    FeatureType::Kiosk,
    FeatureType::Level,
    FeatureType::Occupant,
    FeatureType::Opening,
    FeatureType::Relationship,
    FeatureType::Section,
    FeatureType::Unit,
    FeatureType::Venue,
];

/// IMDF feature collection name. Variant order matches `FEATURE_TYPE_ORDER`, so
/// the derived `Ord` gives canonical ordering for free.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum FeatureType {
    Address = 0,
    Amenity = 1,
    Anchor = 2,
    Building = 3,
    Detail = 4,
    Fixture = 5,
    Footprint = 6,
    Geofence = 7,
    Kiosk = 8,
    Level = 9,
    Occupant = 10,
    Opening = 11,
    Relationship = 12,
    Section = 13,
    Unit = 14,
    Venue = 15,
}

impl FeatureType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Address => "address",
            Self::Amenity => "amenity",
            Self::Anchor => "anchor",
            Self::Building => "building",
            Self::Detail => "detail",
            Self::Fixture => "fixture",
            Self::Footprint => "footprint",
            Self::Geofence => "geofence",
            Self::Kiosk => "kiosk",
            Self::Level => "level",
            Self::Occupant => "occupant",
            Self::Opening => "opening",
            Self::Relationship => "relationship",
            Self::Section => "section",
            Self::Unit => "unit",
            Self::Venue => "venue",
        }
    }

    /// Canonical ordering index (matches `FEATURE_TYPE_ORDER` position).
    #[must_use]
    pub const fn order(self) -> usize {
        self as usize
    }

    /// Parse a collection name into a `FeatureType`. Returns `None` for any
    /// unrecognized value.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "address" => Self::Address,
            "amenity" => Self::Amenity,
            "anchor" => Self::Anchor,
            "building" => Self::Building,
            "detail" => Self::Detail,
            "fixture" => Self::Fixture,
            "footprint" => Self::Footprint,
            "geofence" => Self::Geofence,
            "kiosk" => Self::Kiosk,
            "level" => Self::Level,
            "occupant" => Self::Occupant,
            "opening" => Self::Opening,
            "relationship" => Self::Relationship,
            "section" => Self::Section,
            "unit" => Self::Unit,
            "venue" => Self::Venue,
            _ => return None,
        })
    }
}

/// IMDF feature-collection filename (lowercased root name) -> feature type.
///
/// This is the map the importer uses to dispatch a root `.geojson` file to its
/// collection. Unknown names produce an `unknown_archive_entry` warning and are
/// otherwise ignored.
#[must_use]
pub fn feature_type_for_filename(name: &str) -> Option<FeatureType> {
    FeatureType::parse(match name {
        "address.geojson" => "address",
        "amenity.geojson" => "amenity",
        "anchor.geojson" => "anchor",
        "building.geojson" => "building",
        "detail.geojson" => "detail",
        "fixture.geojson" => "fixture",
        "footprint.geojson" => "footprint",
        "geofence.geojson" => "geofence",
        "kiosk.geojson" => "kiosk",
        "level.geojson" => "level",
        "occupant.geojson" => "occupant",
        "opening.geojson" => "opening",
        "relationship.geojson" => "relationship",
        "section.geojson" => "section",
        "unit.geojson" => "unit",
        "venue.geojson" => "venue",
        _ => return None,
    })
}

/// Axis-aligned bounds: `(west, south, east, north)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// Viewer-facing warning code. String values match `ViewerWarningCode` in
/// `src/imdf/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WarningCode {
    MissingLocale,
    UnresolvedReference,
    MissingLevelGeometry,
    MissingDisplayPoint,
    UnknownArchiveEntry,
    /// Non-fatal problem building the optional routing graph from network
    /// GeoJSON (e.g. an unmappable floor label or a dangling edge). The
    /// specific route code (`unmapped_floor`, `dangling_edge`,
    /// `unmatched_level`) is embedded in the warning message.
    RouteBuild,
    /// Non-fatal problem building the optional facilities section from
    /// point-facility GeoJSON (e.g. an unmappable floor label, an
    /// unresolved route-graph anchor, or facilities supplied without a
    /// routing network). The specific facility code (`unmapped_floor`,
    /// `unresolved_anchor`) is embedded in the warning message.
    FacilityBuild,
    /// Non-fatal problem applying a producer floor-plane override (e.g. an
    /// override naming a level the venue does not have). The specific
    /// override detail (`unknown_level`) is embedded in the warning message.
    FloorOverride,
}

impl WarningCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MissingLocale => "missing_locale",
            Self::UnresolvedReference => "unresolved_reference",
            Self::MissingLevelGeometry => "missing_level_geometry",
            Self::MissingDisplayPoint => "missing_display_point",
            Self::UnknownArchiveEntry => "unknown_archive_entry",
            Self::RouteBuild => "route_build",
            Self::FacilityBuild => "facility_build",
            Self::FloorOverride => "floor_override",
        }
    }
}

/// A single warning produced during normalization.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewerWarning {
    pub code: WarningCode,
    pub message: String,
    pub feature_id: Option<String>,
    pub archive_entry: Option<String>,
}

/// IMDF manifest after normalization. `version` is always `1.0.0`; pre-release
/// suffixes are stripped by the importer. `rest` holds every other canonical
/// manifest field (sorted keys, `-0.0` normalized).
#[derive(Debug, Clone, PartialEq)]
pub struct ImdfManifest {
    pub version: String,
    pub language: String,
    pub rest: Object,
}

/// Aggregated level row. `ordinal` preserves the full finite IEEE-754 domain
/// the browser accepts (fractional, negative, or beyond `i32` range) rather
/// than truncating to an integer; only non-finite/non-numeric values default
/// to `0.0`. Matches `normalizeVenue.ts`'s `ordinalRaw` handling exactly.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewerLevel {
    pub id: String,
    pub ordinal: f64,
    pub label: BTreeMap<String, String>,
    pub short_name: BTreeMap<String, String>,
}

/// A normalized IMDF feature. `source_properties` is the recursively
/// canonicalized `properties` object (sorted keys, `-0.0` normalized).
#[derive(Debug, Clone, PartialEq)]
pub struct VenueFeature {
    pub id: String,
    pub feature_type: FeatureType,
    pub level_id: Option<String>,
    pub geometry: Option<crate::canonical::Value>,
    pub center: Option<(f64, f64)>,
    pub labels: BTreeMap<String, String>,
    pub alt_labels: BTreeMap<String, String>,
    pub category: Option<String>,
    pub accessibility: Vec<String>,
    pub restriction: Option<String>,
    pub source_properties: Object,
}

/// Canonical venue model: the output of [`crate::import_imdf`].
#[derive(Debug, Clone, PartialEq)]
pub struct VenueModel {
    pub manifest: ImdfManifest,
    pub venue_id: String,
    pub levels: Vec<ViewerLevel>,
    pub features: Vec<VenueFeature>,
    pub bounds_by_level: BTreeMap<String, Bounds>,
    pub warnings: Vec<ViewerWarning>,
}
