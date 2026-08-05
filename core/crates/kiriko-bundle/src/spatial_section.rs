//! Section 8 (spatial context) postcard DTOs, encode/decode, and bounded
//! validation.
//!
//! The canonical types live in `kiriko-model::spatial`; this module mirrors
//! them field-for-field as postcard-serializable DTOs (the same split as the
//! graph/facilities sections), so the shared model crate stays free of a
//! bundle-format dependency. Enums use their own serde-derived discriminant
//! type (rather than a string) so a corrupted section fails postcard decoding
//! instead of ever reaching a panicking string match.
//!
//! Every `f64` is canonicalized by `canonical_f64` on both paths — non-finite
//! values are rejected and `-0.0` is rewritten to `0.0` — and the resulting
//! canonical value is validated *before* availability is offered: identifiers
//! (registry indices), numeric ranges, collection counts, ordering, string
//! lengths, and cross-references are all bounded. A violation rejects the
//! section, which the capability model (codec.rs) reports as `invalid` while
//! the rest of the bundle decodes.

use std::collections::BTreeMap;

use kiriko_model::model::Bounds;
use kiriko_model::spatial::{
    Assumption, AssumptionKind, Axes, Confidence, ConfidenceKind, Datum, Ellipsoid,
    EvidenceMethod, Frame, LengthUnit, LevelRecord, LocatorKind, ManualProvenance, Registries,
    RegistrationEvidence, ResolutionMethod, SourceArtifact, SourceLocator, SpatialContext,
    Transform, TransformKind, MAX_VERTICAL_OFFSET_MM, WGS84_INVERSE_FLATTENING,
    WGS84_SEMI_MAJOR_M, enu_basis_ecef, wgs84_ecef,
};
use serde::{Deserialize, Serialize};

use crate::codec::{postcard_encode_err, postcard_take_exact};
use crate::error::{BundleError, BundleErrorCode};
use crate::resolve::{ResolutionOutcome, ResolutionProfile};
use crate::sections::{JsonObjectDto, canonical_f64, dto_to_object, object_to_dto};

/// Cap on any single registry length. Far beyond any legitimate producer;
/// bounds memory and iteration cost on decode of a hostile bundle.
pub(crate) const MAX_REGISTRY_LEN: usize = 65_536;
/// Cap on any registry string length (UTF-8 bytes).
pub(crate) const MAX_STRING_LEN: usize = 1024;
/// Cap on preserved source-property entries.
pub(crate) const MAX_SOURCE_PROPERTIES: usize = 1024;
/// Cap on a preserved source-property key length (UTF-8 bytes).
pub(crate) const MAX_SOURCE_PROPERTY_KEY_LEN: usize = 256;
/// Tolerance for the world-transform basis columns being unit vectors.
const BASIS_UNIT_TOLERANCE: f64 = 1e-6;

// -- DTO mirrors -----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum AxesDto {
    EastNorthUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum LengthUnitDto {
    Millimetre,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum LocatorKindDto {
    ArchivePath,
    FeatureId,
    LayerName,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum TransformKindDto {
    Registration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum AssumptionKindDto {
    Nominal,
    Inferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum EvidenceMethodDto {
    DerivedFromVenueGeometry,
    ImportedElevation,
    PreservedNetworkAltitude,
    NominalSpacing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum ResolutionMethodDto {
    ImportedElevation,
    NetworkAltitude,
    NominalSpacing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum ConfidenceKindDto {
    Measured,
    Estimated,
    Assumed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct EllipsoidDto {
    semi_major_metres: f64,
    inverse_flattening: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct DatumDto {
    name: String,
    ellipsoid: EllipsoidDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SourceArtifactDto {
    name: String,
    hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SourceLocatorDto {
    kind: LocatorKindDto,
    value: String,
    artifact_ref: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct TransformDto {
    kind: TransformKindDto,
    coefficients: Vec<f64>,
    unit: LengthUnitDto,
    profile_version: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct RegistrationEvidenceDto {
    method: EvidenceMethodDto,
    source_locator_ref: u32,
    transform_ref: Option<u32>,
    confidence_ref: Option<u32>,
    assumption_ref: Option<u32>,
    detail: String,
}

/// Serialized mirror of `kiriko_model::spatial::LevelRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct LevelRecordDto {
    level_id: String,
    ordinal: f64,
    source_elevation_m: Option<f64>,
    network_difference_mm: Option<i64>,
    resolved_scene_z_mm: i64,
    method: ResolutionMethodDto,
    confidence_ref: u32,
    evidence_refs: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct AssumptionDto {
    kind: AssumptionKindDto,
    detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ConfidenceDto {
    kind: ConfidenceKindDto,
    value: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ManualProvenanceDto {
    actor: String,
    reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct FrameDto {
    anchor: [f64; 2],
    ecef_origin: [f64; 3],
    enu_basis_ecef: [[f64; 3]; 3],
    world_translation: [f64; 3],
    axes: AxesDto,
    unit: LengthUnitDto,
    vertical_normalisation_offset_mm: i64,
    datum_ref: u32,
    anchor_evidence_ref: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct RegistriesDto {
    artifacts: Vec<SourceArtifactDto>,
    locators: Vec<SourceLocatorDto>,
    datums: Vec<DatumDto>,
    transforms: Vec<TransformDto>,
    registration_evidence: Vec<RegistrationEvidenceDto>,
    assumptions: Vec<AssumptionDto>,
    confidence: Vec<ConfidenceDto>,
    manual_provenance: Vec<ManualProvenanceDto>,
}

/// Section 8 payload. Optional — `encode_bundle` emits it only when the
/// document carries a spatial context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SpatialContextSectionDto {
    frame: FrameDto,
    registries: RegistriesDto,
    levels: Vec<LevelRecordDto>,
    source_properties: JsonObjectDto,
}

// -- Enum conversions ------------------------------------------------------

impl From<&Axes> for AxesDto {
    fn from(value: &Axes) -> Self {
        match value {
            Axes::EastNorthUp => Self::EastNorthUp,
        }
    }
}

impl From<AxesDto> for Axes {
    fn from(value: AxesDto) -> Self {
        match value {
            AxesDto::EastNorthUp => Self::EastNorthUp,
        }
    }
}

impl From<&LengthUnit> for LengthUnitDto {
    fn from(value: &LengthUnit) -> Self {
        match value {
            LengthUnit::Millimetre => Self::Millimetre,
        }
    }
}

impl From<LengthUnitDto> for LengthUnit {
    fn from(value: LengthUnitDto) -> Self {
        match value {
            LengthUnitDto::Millimetre => Self::Millimetre,
        }
    }
}

impl From<&LocatorKind> for LocatorKindDto {
    fn from(value: &LocatorKind) -> Self {
        match value {
            LocatorKind::ArchivePath => Self::ArchivePath,
            LocatorKind::FeatureId => Self::FeatureId,
            LocatorKind::LayerName => Self::LayerName,
        }
    }
}

impl From<LocatorKindDto> for LocatorKind {
    fn from(value: LocatorKindDto) -> Self {
        match value {
            LocatorKindDto::ArchivePath => Self::ArchivePath,
            LocatorKindDto::FeatureId => Self::FeatureId,
            LocatorKindDto::LayerName => Self::LayerName,
        }
    }
}

impl From<&TransformKind> for TransformKindDto {
    fn from(value: &TransformKind) -> Self {
        match value {
            TransformKind::Registration => Self::Registration,
        }
    }
}

impl From<TransformKindDto> for TransformKind {
    fn from(value: TransformKindDto) -> Self {
        match value {
            TransformKindDto::Registration => Self::Registration,
        }
    }
}

impl From<&AssumptionKind> for AssumptionKindDto {
    fn from(value: &AssumptionKind) -> Self {
        match value {
            AssumptionKind::Nominal => Self::Nominal,
            AssumptionKind::Inferred => Self::Inferred,
        }
    }
}

impl From<AssumptionKindDto> for AssumptionKind {
    fn from(value: AssumptionKindDto) -> Self {
        match value {
            AssumptionKindDto::Nominal => Self::Nominal,
            AssumptionKindDto::Inferred => Self::Inferred,
        }
    }
}

impl From<&EvidenceMethod> for EvidenceMethodDto {
    fn from(value: &EvidenceMethod) -> Self {
        match value {
            EvidenceMethod::DerivedFromVenueGeometry => Self::DerivedFromVenueGeometry,
            EvidenceMethod::ImportedElevation => Self::ImportedElevation,
            EvidenceMethod::PreservedNetworkAltitude => Self::PreservedNetworkAltitude,
            EvidenceMethod::NominalSpacing => Self::NominalSpacing,
        }
    }
}

impl From<EvidenceMethodDto> for EvidenceMethod {
    fn from(value: EvidenceMethodDto) -> Self {
        match value {
            EvidenceMethodDto::DerivedFromVenueGeometry => Self::DerivedFromVenueGeometry,
            EvidenceMethodDto::ImportedElevation => Self::ImportedElevation,
            EvidenceMethodDto::PreservedNetworkAltitude => Self::PreservedNetworkAltitude,
            EvidenceMethodDto::NominalSpacing => Self::NominalSpacing,
        }
    }
}

impl From<&ResolutionMethod> for ResolutionMethodDto {
    fn from(value: &ResolutionMethod) -> Self {
        match value {
            ResolutionMethod::ImportedElevation => Self::ImportedElevation,
            ResolutionMethod::NetworkAltitude => Self::NetworkAltitude,
            ResolutionMethod::NominalSpacing => Self::NominalSpacing,
        }
    }
}

impl From<ResolutionMethodDto> for ResolutionMethod {
    fn from(value: ResolutionMethodDto) -> Self {
        match value {
            ResolutionMethodDto::ImportedElevation => Self::ImportedElevation,
            ResolutionMethodDto::NetworkAltitude => Self::NetworkAltitude,
            ResolutionMethodDto::NominalSpacing => Self::NominalSpacing,
        }
    }
}

impl From<&ConfidenceKind> for ConfidenceKindDto {
    fn from(value: &ConfidenceKind) -> Self {
        match value {
            ConfidenceKind::Measured => Self::Measured,
            ConfidenceKind::Estimated => Self::Estimated,
            ConfidenceKind::Assumed => Self::Assumed,
            ConfidenceKind::Unknown => Self::Unknown,
        }
    }
}

impl From<ConfidenceKindDto> for ConfidenceKind {
    fn from(value: ConfidenceKindDto) -> Self {
        match value {
            ConfidenceKindDto::Measured => Self::Measured,
            ConfidenceKindDto::Estimated => Self::Estimated,
            ConfidenceKindDto::Assumed => Self::Assumed,
            ConfidenceKindDto::Unknown => Self::Unknown,
        }
    }
}

// -- Canonical <-> DTO conversions -----------------------------------------

fn ellipsoid_to_dto(ellipsoid: &Ellipsoid) -> Result<EllipsoidDto, BundleError> {
    Ok(EllipsoidDto {
        semi_major_metres: canonical_f64(ellipsoid.semi_major_metres)?,
        inverse_flattening: canonical_f64(ellipsoid.inverse_flattening)?,
    })
}

fn ellipsoid_from_dto(dto: &EllipsoidDto) -> Result<Ellipsoid, BundleError> {
    Ok(Ellipsoid {
        semi_major_metres: canonical_f64(dto.semi_major_metres)?,
        inverse_flattening: canonical_f64(dto.inverse_flattening)?,
    })
}

fn datum_to_dto(datum: &Datum) -> Result<DatumDto, BundleError> {
    Ok(DatumDto {
        name: datum.name.clone(),
        ellipsoid: ellipsoid_to_dto(&datum.ellipsoid)?,
    })
}

fn datum_from_dto(dto: &DatumDto) -> Result<Datum, BundleError> {
    Ok(Datum {
        name: dto.name.clone(),
        ellipsoid: ellipsoid_from_dto(&dto.ellipsoid)?,
    })
}

fn transform_to_dto(transform: &Transform) -> Result<TransformDto, BundleError> {
    Ok(TransformDto {
        kind: TransformKindDto::from(&transform.kind),
        coefficients: transform
            .coefficients
            .iter()
            .copied()
            .map(canonical_f64)
            .collect::<Result<_, _>>()?,
        unit: LengthUnitDto::from(&transform.unit),
        profile_version: transform.profile_version,
    })
}

fn transform_from_dto(dto: &TransformDto) -> Result<Transform, BundleError> {
    Ok(Transform {
        kind: TransformKind::from(dto.kind),
        coefficients: dto
            .coefficients
            .iter()
            .copied()
            .map(canonical_f64)
            .collect::<Result<_, _>>()?,
        unit: LengthUnit::from(dto.unit),
        profile_version: dto.profile_version,
    })
}

fn registration_evidence_to_dto(
    evidence: &RegistrationEvidence,
) -> Result<RegistrationEvidenceDto, BundleError> {
    Ok(RegistrationEvidenceDto {
        method: EvidenceMethodDto::from(&evidence.method),
        source_locator_ref: evidence.source_locator_ref,
        transform_ref: evidence.transform_ref,
        confidence_ref: evidence.confidence_ref,
        assumption_ref: evidence.assumption_ref,
        detail: evidence.detail.clone(),
    })
}

fn registration_evidence_from_dto(
    dto: &RegistrationEvidenceDto,
) -> Result<RegistrationEvidence, BundleError> {
    Ok(RegistrationEvidence {
        method: EvidenceMethod::from(dto.method),
        source_locator_ref: dto.source_locator_ref,
        transform_ref: dto.transform_ref,
        confidence_ref: dto.confidence_ref,
        assumption_ref: dto.assumption_ref,
        detail: dto.detail.clone(),
    })
}

fn level_record_to_dto(record: &LevelRecord) -> Result<LevelRecordDto, BundleError> {
    Ok(LevelRecordDto {
        level_id: record.level_id.clone(),
        ordinal: canonical_f64(record.ordinal)?,
        source_elevation_m: record.source_elevation_m.map(canonical_f64).transpose()?,
        network_difference_mm: record.network_difference_mm,
        resolved_scene_z_mm: record.resolved_scene_z_mm,
        method: ResolutionMethodDto::from(&record.method),
        confidence_ref: record.confidence_ref,
        evidence_refs: record.evidence_refs.clone(),
    })
}

fn level_record_from_dto(dto: &LevelRecordDto) -> Result<LevelRecord, BundleError> {
    Ok(LevelRecord {
        level_id: dto.level_id.clone(),
        ordinal: canonical_f64(dto.ordinal)?,
        source_elevation_m: dto.source_elevation_m.map(canonical_f64).transpose()?,
        network_difference_mm: dto.network_difference_mm,
        resolved_scene_z_mm: dto.resolved_scene_z_mm,
        method: ResolutionMethod::from(dto.method),
        confidence_ref: dto.confidence_ref,
        evidence_refs: dto.evidence_refs.clone(),
    })
}

fn frame_to_dto(frame: &Frame) -> Result<FrameDto, BundleError> {
    Ok(FrameDto {
        anchor: [canonical_f64(frame.anchor[0])?, canonical_f64(frame.anchor[1])?],
        ecef_origin: [
            canonical_f64(frame.ecef_origin[0])?,
            canonical_f64(frame.ecef_origin[1])?,
            canonical_f64(frame.ecef_origin[2])?,
        ],
        enu_basis_ecef: [
            [
                canonical_f64(frame.enu_basis_ecef[0][0])?,
                canonical_f64(frame.enu_basis_ecef[0][1])?,
                canonical_f64(frame.enu_basis_ecef[0][2])?,
            ],
            [
                canonical_f64(frame.enu_basis_ecef[1][0])?,
                canonical_f64(frame.enu_basis_ecef[1][1])?,
                canonical_f64(frame.enu_basis_ecef[1][2])?,
            ],
            [
                canonical_f64(frame.enu_basis_ecef[2][0])?,
                canonical_f64(frame.enu_basis_ecef[2][1])?,
                canonical_f64(frame.enu_basis_ecef[2][2])?,
            ],
        ],
        world_translation: [
            canonical_f64(frame.world_translation[0])?,
            canonical_f64(frame.world_translation[1])?,
            canonical_f64(frame.world_translation[2])?,
        ],
        axes: AxesDto::from(&frame.axes),
        unit: LengthUnitDto::from(&frame.unit),
        vertical_normalisation_offset_mm: frame.vertical_normalisation_offset_mm,
        datum_ref: frame.datum_ref,
        anchor_evidence_ref: frame.anchor_evidence_ref,
    })
}

fn frame_from_dto(dto: &FrameDto) -> Result<Frame, BundleError> {
    Ok(Frame {
        anchor: [canonical_f64(dto.anchor[0])?, canonical_f64(dto.anchor[1])?],
        ecef_origin: [
            canonical_f64(dto.ecef_origin[0])?,
            canonical_f64(dto.ecef_origin[1])?,
            canonical_f64(dto.ecef_origin[2])?,
        ],
        enu_basis_ecef: [
            [
                canonical_f64(dto.enu_basis_ecef[0][0])?,
                canonical_f64(dto.enu_basis_ecef[0][1])?,
                canonical_f64(dto.enu_basis_ecef[0][2])?,
            ],
            [
                canonical_f64(dto.enu_basis_ecef[1][0])?,
                canonical_f64(dto.enu_basis_ecef[1][1])?,
                canonical_f64(dto.enu_basis_ecef[1][2])?,
            ],
            [
                canonical_f64(dto.enu_basis_ecef[2][0])?,
                canonical_f64(dto.enu_basis_ecef[2][1])?,
                canonical_f64(dto.enu_basis_ecef[2][2])?,
            ],
        ],
        world_translation: [
            canonical_f64(dto.world_translation[0])?,
            canonical_f64(dto.world_translation[1])?,
            canonical_f64(dto.world_translation[2])?,
        ],
        axes: Axes::from(dto.axes),
        unit: LengthUnit::from(dto.unit),
        vertical_normalisation_offset_mm: dto.vertical_normalisation_offset_mm,
        datum_ref: dto.datum_ref,
        anchor_evidence_ref: dto.anchor_evidence_ref,
    })
}

fn registries_to_dto(registries: &Registries) -> Result<RegistriesDto, BundleError> {
    Ok(RegistriesDto {
        artifacts: registries
            .artifacts
            .iter()
            .map(|a| SourceArtifactDto {
                name: a.name.clone(),
                hash: a.hash,
            })
            .collect(),
        locators: registries
            .locators
            .iter()
            .map(|l| SourceLocatorDto {
                kind: LocatorKindDto::from(&l.kind),
                value: l.value.clone(),
                artifact_ref: l.artifact_ref,
            })
            .collect(),
        datums: registries.datums.iter().map(datum_to_dto).collect::<Result<_, _>>()?,
        transforms: registries
            .transforms
            .iter()
            .map(transform_to_dto)
            .collect::<Result<_, _>>()?,
        registration_evidence: registries
            .registration_evidence
            .iter()
            .map(registration_evidence_to_dto)
            .collect::<Result<_, _>>()?,
        assumptions: registries
            .assumptions
            .iter()
            .map(|a| AssumptionDto {
                kind: AssumptionKindDto::from(&a.kind),
                detail: a.detail.clone(),
            })
            .collect(),
        confidence: registries
            .confidence
            .iter()
            .map(|c| {
                Ok(ConfidenceDto {
                    kind: ConfidenceKindDto::from(&c.kind),
                    value: canonical_f64(c.value)?,
                })
            })
            .collect::<Result<_, BundleError>>()?,
        manual_provenance: registries
            .manual_provenance
            .iter()
            .map(|m| ManualProvenanceDto {
                actor: m.actor.clone(),
                reason: m.reason.clone(),
            })
            .collect(),
    })
}

fn registries_from_dto(dto: &RegistriesDto) -> Result<Registries, BundleError> {
    Ok(Registries {
        artifacts: dto
            .artifacts
            .iter()
            .map(|a| SourceArtifact {
                name: a.name.clone(),
                hash: a.hash,
            })
            .collect(),
        locators: dto
            .locators
            .iter()
            .map(|l| SourceLocator {
                kind: LocatorKind::from(l.kind),
                value: l.value.clone(),
                artifact_ref: l.artifact_ref,
            })
            .collect(),
        datums: dto.datums.iter().map(datum_from_dto).collect::<Result<_, _>>()?,
        transforms: dto
            .transforms
            .iter()
            .map(transform_from_dto)
            .collect::<Result<_, _>>()?,
        registration_evidence: dto
            .registration_evidence
            .iter()
            .map(registration_evidence_from_dto)
            .collect::<Result<_, _>>()?,
        assumptions: dto
            .assumptions
            .iter()
            .map(|a| Assumption {
                kind: AssumptionKind::from(a.kind),
                detail: a.detail.clone(),
            })
            .collect(),
        confidence: dto
            .confidence
            .iter()
            .map(|c| {
                Ok(Confidence {
                    kind: ConfidenceKind::from(c.kind),
                    value: canonical_f64(c.value)?,
                })
            })
            .collect::<Result<_, BundleError>>()?,
        manual_provenance: dto
            .manual_provenance
            .iter()
            .map(|m| ManualProvenance {
                actor: m.actor.clone(),
                reason: m.reason.clone(),
            })
            .collect(),
    })
}

// -- Validation ------------------------------------------------------------

fn invalid(message: impl Into<String>) -> BundleError {
    BundleError::new(BundleErrorCode::InvalidBundle, message)
}

fn bounded_string(value: &str, what: &str) -> Result<(), BundleError> {
    if value.len() > MAX_STRING_LEN {
        return Err(invalid(format!("{what} exceeds {MAX_STRING_LEN} bytes")));
    }
    Ok(())
}

/// Validate every identifier, numeric range, collection count, ordering
/// invariant, string length, and cross-reference of a decoded/encoded
/// spatial context. Runs on both the encode and decode path, so a
/// hand-crafted section is held to exactly the same rules as a freshly
/// encoded one — and nothing invalid is ever offered as available.
fn validate_spatial_context(context: &SpatialContext) -> Result<(), BundleError> {
    let frame = &context.frame;
    let registries = &context.registries;

    let (lon, lat) = (frame.anchor[0], frame.anchor[1]);
    if !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat) {
        return Err(invalid("spatial context frame anchor is outside WGS84 bounds"));
    }
    if frame.world_translation != frame.ecef_origin {
        return Err(invalid(
            "spatial context world transform translation must equal the ECEF origin",
        ));
    }
    for (axis, column) in ["east", "north", "up"].iter().zip(frame.enu_basis_ecef.iter()) {
        let norm = (column[0] * column[0] + column[1] * column[1] + column[2] * column[2]).sqrt();
        if (norm - 1.0).abs() > BASIS_UNIT_TOLERANCE {
            return Err(invalid(format!(
                "spatial context {axis} basis column is not a unit vector (norm {norm})"
            )));
        }
    }
    if frame.vertical_normalisation_offset_mm.abs() > MAX_VERTICAL_OFFSET_MM {
        return Err(invalid(format!(
            "spatial context vertical normalisation offset exceeds ±{MAX_VERTICAL_OFFSET_MM} mm"
        )));
    }

    let bounds = |len: usize, what: &str| -> Result<(), BundleError> {
        if len > MAX_REGISTRY_LEN {
            return Err(invalid(format!("{what} exceeds {MAX_REGISTRY_LEN} entries")));
        }
        Ok(())
    };
    bounds(registries.artifacts.len(), "source artifact registry")?;
    bounds(registries.locators.len(), "source locator registry")?;
    bounds(registries.datums.len(), "datum registry")?;
    bounds(registries.transforms.len(), "transform registry")?;
    bounds(registries.registration_evidence.len(), "registration evidence registry")?;
    bounds(registries.assumptions.len(), "assumption registry")?;
    bounds(registries.confidence.len(), "confidence registry")?;
    bounds(registries.manual_provenance.len(), "manual provenance registry")?;

    let reference = |index: u32, len: usize, what: &str| -> Result<(), BundleError> {
        if index as usize >= len {
            return Err(invalid(format!(
                "spatial context {what} references index {index} beyond {len} entries"
            )));
        }
        Ok(())
    };

    reference(frame.datum_ref, registries.datums.len(), "datum")?;
    reference(
        frame.anchor_evidence_ref,
        registries.registration_evidence.len(),
        "anchor evidence",
    )?;
    for (i, locator) in registries.locators.iter().enumerate() {
        bounded_string(&locator.value, &format!("source locator {i} value"))?;
        if let Some(artifact_ref) = locator.artifact_ref {
            reference(artifact_ref, registries.artifacts.len(), "locator artifact")?;
        }
    }
    for (i, evidence) in registries.registration_evidence.iter().enumerate() {
        reference(
            evidence.source_locator_ref,
            registries.locators.len(),
            &format!("registration evidence {i} source locator"),
        )?;
        if let Some(transform_ref) = evidence.transform_ref {
            reference(
                transform_ref,
                registries.transforms.len(),
                &format!("registration evidence {i} transform"),
            )?;
        }
        if let Some(confidence_ref) = evidence.confidence_ref {
            reference(
                confidence_ref,
                registries.confidence.len(),
                &format!("registration evidence {i} confidence"),
            )?;
        }
        if let Some(assumption_ref) = evidence.assumption_ref {
            reference(
                assumption_ref,
                registries.assumptions.len(),
                &format!("registration evidence {i} assumption"),
            )?;
        }
        bounded_string(&evidence.detail, &format!("registration evidence {i} detail"))?;
    }

    for (i, confidence) in registries.confidence.iter().enumerate() {
        if !(0.0..=1.0).contains(&confidence.value) {
            return Err(invalid(format!("confidence {i} value is outside 0..=1")));
        }
    }
    for (i, datum) in registries.datums.iter().enumerate() {
        bounded_string(&datum.name, &format!("datum {i} name"))?;
    }
    for (i, artifact) in registries.artifacts.iter().enumerate() {
        bounded_string(&artifact.name, &format!("source artifact {i} name"))?;
    }
    for (i, assumption) in registries.assumptions.iter().enumerate() {
        bounded_string(&assumption.detail, &format!("assumption {i} detail"))?;
    }
    for (i, transform) in registries.transforms.iter().enumerate() {
        if transform.coefficients.len() > MAX_REGISTRY_LEN {
            return Err(invalid(format!("transform {i} has too many coefficients")));
        }
    }
    for (i, provenance) in registries.manual_provenance.iter().enumerate() {
        bounded_string(&provenance.actor, &format!("manual provenance {i} actor"))?;
        bounded_string(&provenance.reason, &format!("manual provenance {i} reason"))?;
    }

    if context.source_properties.len() > MAX_SOURCE_PROPERTIES {
        return Err(invalid(format!(
            "spatial context source properties exceed {MAX_SOURCE_PROPERTIES} entries"
        )));
    }
    for key in context.source_properties.keys() {
        if key.len() > MAX_SOURCE_PROPERTY_KEY_LEN {
            return Err(invalid(format!(
                "spatial context source property key exceeds {MAX_SOURCE_PROPERTY_KEY_LEN} bytes"
            )));
        }
    }

    bounds(context.levels.len(), "level record registry")?;
    for (i, record) in context.levels.iter().enumerate() {
        bounded_string(&record.level_id, &format!("level record {i} id"))?;
        if record.resolved_scene_z_mm < 0 || record.resolved_scene_z_mm > MAX_VERTICAL_OFFSET_MM {
            return Err(invalid(format!(
                "level record {i} resolved scene Z {} is outside 0..={MAX_VERTICAL_OFFSET_MM} mm",
                record.resolved_scene_z_mm
            )));
        }
        if let Some(difference) = record.network_difference_mm
            && difference.abs() > MAX_VERTICAL_OFFSET_MM
        {
            return Err(invalid(format!(
                "level record {i} network difference exceeds ±{MAX_VERTICAL_OFFSET_MM} mm"
            )));
        }
        reference(
            record.confidence_ref,
            registries.confidence.len(),
            &format!("level record {i} confidence"),
        )?;
        if record.evidence_refs.len() > MAX_REGISTRY_LEN {
            return Err(invalid(format!(
                "level record {i} has too many evidence references"
            )));
        }
        for (j, evidence_ref) in record.evidence_refs.iter().enumerate() {
            reference(
                *evidence_ref,
                registries.registration_evidence.len(),
                &format!("level record {i} evidence {j}"),
            )?;
        }
    }

    Ok(())
}

// -- Section codec ---------------------------------------------------------

/// Encode a [`SpatialContext`] as the §8 section payload. Validates the
/// canonical value first (an in-memory document cannot encode garbage), then
/// canonicalizes every `f64` into the DTO and serializes with postcard.
pub(crate) fn encode_spatial_context(context: &SpatialContext) -> Result<Vec<u8>, BundleError> {
    validate_spatial_context(context)?;
    let dto = SpatialContextSectionDto {
        frame: frame_to_dto(&context.frame)?,
        registries: registries_to_dto(&context.registries)?,
        levels: context
            .levels
            .iter()
            .map(level_record_to_dto)
            .collect::<Result<_, _>>()?,
        source_properties: object_to_dto(&context.source_properties)?,
    };
    postcard::to_allocvec(&dto).map_err(postcard_encode_err("encode spatial context section"))
}

/// Decode the §8 section payload into a [`SpatialContext`]. Rejects trailing
/// bytes, canonicalizes every `f64`, converts to the canonical model, and
/// validates — a violation rejects the section, which the capability model
/// reports as `invalid` without failing the bundle.
pub(crate) fn decode_spatial_context(bytes: &[u8]) -> Result<SpatialContext, BundleError> {
    let dto: SpatialContextSectionDto =
        postcard_take_exact(bytes, "decode spatial context section")?;
    let context = SpatialContext {
        frame: frame_from_dto(&dto.frame)?,
        registries: registries_from_dto(&dto.registries)?,
        levels: dto
            .levels
            .iter()
            .map(level_record_from_dto)
            .collect::<Result<_, _>>()?,
        source_properties: dto_to_object(&dto.source_properties)?,
    };
    validate_spatial_context(&context)?;
    Ok(context)
}

/// Derive the §8 spatial context for a compiled venue: one shared WGS84
/// local east-north-up frame anchored at the canonical venue
/// horizontal-bounds centre, plus the registries holding the evidence behind
/// it. `None` when the venue has no computable horizontal extent — such a
/// venue gets no frame and the capability reports `absent`.
///
/// Deterministic by construction: the anchor comes from venue geometry
/// bounds, the transforms are the fixed WGS84 geodesy evaluated at that
/// anchor, and registry order is fixed. The source archive itself is never
/// hashed here — raw-zip hashing would make identical canonical inputs
/// compile to different bytes when ZIP record order differs.
/// Assemble the §8 spatial context for a compiled venue: the shared WGS84
/// local east-north-up frame anchored at the canonical venue
/// horizontal-bounds centre, the registries holding the evidence behind it,
/// and every level's resolved floor plane referencing those registries.
/// `None` when the venue has no computable horizontal extent — such a venue
/// gets no frame and the capability reports `absent`.
///
/// Deterministic by construction: the anchor comes from venue geometry
/// bounds, the transforms are the fixed WGS84 geodesy evaluated at that
/// anchor, resolution outcome and profile are fixed, and registry append
/// order is fixed. The source archive itself is never hashed here — raw-zip
/// hashing would make identical canonical inputs compile to different bytes
/// when ZIP record order differs.
pub(crate) fn build_spatial_context(
    bounds: Option<Bounds>,
    venue_feature_id: Option<String>,
    outcome: &ResolutionOutcome,
    profile: &ResolutionProfile,
) -> Option<SpatialContext> {
    let bounds = bounds?;
    let anchor = [
        (bounds.west + bounds.east) / 2.0,
        (bounds.south + bounds.north) / 2.0,
    ];
    let ecef_origin = wgs84_ecef(anchor[0], anchor[1], 0.0);
    let basis = enu_basis_ecef(anchor[0], anchor[1]);
    let venue_id = venue_feature_id?;

    let mut registries = Registries {
        // Source-archive artifacts are intentionally not registered here:
        // hashing the raw archive would break byte-identical compilation
        // across ZIP record orders. Later stages register artifacts whose
        // hashes are canonical.
        artifacts: Vec::new(),
        locators: vec![SourceLocator {
            kind: LocatorKind::FeatureId,
            value: venue_id,
            artifact_ref: None,
        }],
        datums: vec![Datum {
            name: "WGS84".into(),
            ellipsoid: Ellipsoid {
                semi_major_metres: WGS84_SEMI_MAJOR_M,
                inverse_flattening: WGS84_INVERSE_FLATTENING,
            },
        }],
        transforms: Vec::new(),
        registration_evidence: vec![RegistrationEvidence {
            method: EvidenceMethod::DerivedFromVenueGeometry,
            source_locator_ref: 0,
            transform_ref: None,
            confidence_ref: None,
            assumption_ref: None,
            detail: "frame anchor at the canonical venue horizontal-bounds centre".into(),
        }],
        assumptions: Vec::new(),
        confidence: Vec::new(),
        manual_provenance: Vec::new(),
    };

    // Shared network-source locator, present only when some level's plane
    // rests on a preserved routing-network altitude (as its resolver or as
    // the validating counterpart of an imported elevation).
    let net_junction_locator = if outcome
        .levels
        .iter()
        .any(|l| l.network_altitude_m.is_some())
    {
        registries.locators.push(SourceLocator {
            kind: LocatorKind::LayerName,
            value: "net_junction".into(),
            artifact_ref: None,
        });
        Some((registries.locators.len() - 1) as u32)
    } else {
        None
    };

    // One shared nominal-spacing assumption, referenced by every level the
    // nominal branch resolved.
    let nominal_assumption = if outcome
        .levels
        .iter()
        .any(|l| l.method == ResolutionMethod::NominalSpacing)
    {
        registries.assumptions.push(Assumption {
            kind: AssumptionKind::Nominal,
            detail: format!(
                "nominal_floor_spacing_m={} (profile v{})",
                profile.nominal_floor_spacing_m, profile.profile_version
            ),
        });
        Some((registries.assumptions.len() - 1) as u32)
    } else {
        None
    };

    // Confidence entries are shared per method: a measured, estimated, or
    // assumed plane is the same class of claim wherever it appears.
    let mut imported_confidence: Option<u32> = None;
    let mut network_confidence: Option<u32> = None;
    let mut nominal_confidence: Option<u32> = None;

    let mut levels = Vec::with_capacity(outcome.levels.len());
    for resolved in &outcome.levels {
        let confidence_ref = match resolved.method {
            ResolutionMethod::ImportedElevation => *imported_confidence.get_or_insert_with(|| {
                push_confidence(&mut registries, ConfidenceKind::Measured, 1.0)
            }),
            ResolutionMethod::NetworkAltitude => *network_confidence.get_or_insert_with(|| {
                push_confidence(&mut registries, ConfidenceKind::Estimated, 0.7)
            }),
            ResolutionMethod::NominalSpacing => *nominal_confidence.get_or_insert_with(|| {
                push_confidence(&mut registries, ConfidenceKind::Assumed, 0.3)
            }),
        };

        // One locator per level: the evidence points at the level it places.
        registries.locators.push(SourceLocator {
            kind: LocatorKind::FeatureId,
            value: resolved.level_id.clone(),
            artifact_ref: None,
        });
        let level_locator = (registries.locators.len() - 1) as u32;

        let mut evidence_refs = Vec::new();
        match resolved.method {
            ResolutionMethod::ImportedElevation => {
                let imported = registries.registration_evidence.len() as u32;
                registries.registration_evidence.push(RegistrationEvidence {
                    method: EvidenceMethod::ImportedElevation,
                    source_locator_ref: level_locator,
                    transform_ref: None,
                    confidence_ref: Some(confidence_ref),
                    assumption_ref: None,
                    detail: "explicit elevation from level source properties".into(),
                });
                evidence_refs.push(imported);
                if resolved.network_altitude_m.is_some() {
                    let preserved = registries.registration_evidence.len() as u32;
                    registries.registration_evidence.push(RegistrationEvidence {
                        method: EvidenceMethod::PreservedNetworkAltitude,
                        source_locator_ref: net_junction_locator
                            .expect("a network altitude implies the shared locator"),
                        transform_ref: None,
                        confidence_ref: Some(confidence_ref),
                        assumption_ref: None,
                        detail: "preserved routing-network altitude (median)".into(),
                    });
                    evidence_refs.push(preserved);
                }
            }
            ResolutionMethod::NetworkAltitude => {
                let preserved = registries.registration_evidence.len() as u32;
                registries.registration_evidence.push(RegistrationEvidence {
                    method: EvidenceMethod::PreservedNetworkAltitude,
                    source_locator_ref: net_junction_locator
                        .expect("the network branch implies the shared locator"),
                    transform_ref: None,
                    confidence_ref: Some(confidence_ref),
                    assumption_ref: None,
                    detail: "preserved routing-network altitude (median)".into(),
                });
                evidence_refs.push(preserved);
            }
            ResolutionMethod::NominalSpacing => {
                let nominal = registries.registration_evidence.len() as u32;
                registries.registration_evidence.push(RegistrationEvidence {
                    method: EvidenceMethod::NominalSpacing,
                    source_locator_ref: level_locator,
                    transform_ref: None,
                    confidence_ref: Some(confidence_ref),
                    assumption_ref: nominal_assumption,
                    detail: "resolved by nominal floor spacing".into(),
                });
                evidence_refs.push(nominal);
            }
        }

        levels.push(LevelRecord {
            level_id: resolved.level_id.clone(),
            ordinal: resolved.ordinal,
            source_elevation_m: resolved.source_elevation_m,
            network_difference_mm: resolved.network_difference_mm,
            resolved_scene_z_mm: resolved.scene_z_mm,
            method: resolved.method,
            confidence_ref,
            evidence_refs,
        });
    }

    Some(SpatialContext {
        frame: Frame {
            anchor,
            ecef_origin,
            enu_basis_ecef: basis,
            world_translation: ecef_origin,
            axes: Axes::EastNorthUp,
            unit: LengthUnit::Millimetre,
            // The lowest resolved plane lands at scene Z 0.
            vertical_normalisation_offset_mm: outcome.normalisation_offset_mm,
            datum_ref: 0,
            anchor_evidence_ref: 0,
        },
        registries,
        levels,
        source_properties: BTreeMap::new(),
    })
}

fn push_confidence(
    registries: &mut Registries,
    kind: ConfidenceKind,
    value: f64,
) -> u32 {
    registries.confidence.push(Confidence { kind, value });
    (registries.confidence.len() - 1) as u32
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use kiriko_model::canonical::Value;
    use kiriko_model::spatial::{
        Assumption, AssumptionKind, Axes, Confidence, ConfidenceKind, Datum, Ellipsoid,
        EvidenceMethod, Frame, LengthUnit, LevelRecord, LocatorKind, ManualProvenance, Registries,
        RegistrationEvidence, ResolutionMethod, SourceArtifact, SourceLocator, SpatialContext,
        Transform, TransformKind, enu_basis_ecef, wgs84_ecef,
    };

    use super::{decode_spatial_context, encode_spatial_context};

    fn base_context() -> SpatialContext {
        let anchor = [139.767, 35.681];
        let ecef_origin = wgs84_ecef(anchor[0], anchor[1], 0.0);
        SpatialContext {
            frame: Frame {
                anchor,
                ecef_origin,
                enu_basis_ecef: enu_basis_ecef(anchor[0], anchor[1]),
                world_translation: ecef_origin,
                axes: Axes::EastNorthUp,
                unit: LengthUnit::Millimetre,
                vertical_normalisation_offset_mm: 0,
                datum_ref: 0,
                anchor_evidence_ref: 0,
            },
            registries: Registries {
                artifacts: vec![SourceArtifact {
                    name: "source.zip".into(),
                    hash: [7u8; 32],
                }],
                locators: vec![SourceLocator {
                    kind: LocatorKind::FeatureId,
                    value: "venue-1".into(),
                    artifact_ref: Some(0),
                }],
                datums: vec![Datum {
                    name: "WGS84".into(),
                    ellipsoid: Ellipsoid {
                        semi_major_metres: 6_378_137.0,
                        inverse_flattening: 298.257_223_563,
                    },
                }],
                transforms: vec![Transform {
                    kind: TransformKind::Registration,
                    coefficients: vec![1.0, 2.0],
                    unit: LengthUnit::Millimetre,
                    profile_version: 1,
                }],
                registration_evidence: vec![RegistrationEvidence {
                    method: EvidenceMethod::DerivedFromVenueGeometry,
                    source_locator_ref: 0,
                    transform_ref: Some(0),
                    confidence_ref: Some(0),
                    assumption_ref: None,
                    detail: "anchor at venue bounds centre".into(),
                }],
                assumptions: vec![Assumption {
                    kind: AssumptionKind::Nominal,
                    detail: "nominal spacing 4000".into(),
                }],
                confidence: vec![Confidence {
                    kind: ConfidenceKind::Measured,
                    value: 0.9,
                }],
                manual_provenance: vec![ManualProvenance {
                    actor: "alice".into(),
                    reason: "reviewed".into(),
                }],
            },
            levels: Vec::new(),
            source_properties: BTreeMap::from([("vendor_field".into(), Value::String("x".into()))]),
        }
    }

    #[test]
    fn round_trip_preserves_a_fully_populated_context() {
        let context = base_context();
        let bytes = encode_spatial_context(&context).expect("valid context encodes");
        let decoded = decode_spatial_context(&bytes).expect("bytes decode");
        assert_eq!(decoded, context);
    }

    #[test]
    fn round_trip_preserves_a_minimal_context() {
        // A frame always carries its declared datum and anchor evidence, so
        // the minimal valid context has exactly those registries populated.
        let anchor = [139.767, 35.681];
        let ecef_origin = wgs84_ecef(anchor[0], anchor[1], 0.0);
        let context = SpatialContext {
            frame: Frame {
                anchor,
                ecef_origin,
                enu_basis_ecef: enu_basis_ecef(anchor[0], anchor[1]),
                world_translation: ecef_origin,
                axes: Axes::EastNorthUp,
                unit: LengthUnit::Millimetre,
                vertical_normalisation_offset_mm: 0,
                datum_ref: 0,
                anchor_evidence_ref: 0,
            },
            registries: Registries {
                locators: vec![SourceLocator {
                    kind: LocatorKind::FeatureId,
                    value: "venue-1".into(),
                    artifact_ref: None,
                }],
                datums: vec![Datum {
                    name: "WGS84".into(),
                    ellipsoid: Ellipsoid {
                        semi_major_metres: 6_378_137.0,
                        inverse_flattening: 298.257_223_563,
                    },
                }],
                registration_evidence: vec![RegistrationEvidence {
                    method: EvidenceMethod::DerivedFromVenueGeometry,
                    source_locator_ref: 0,
                    transform_ref: None,
                    confidence_ref: None,
                    assumption_ref: None,
                    detail: "anchor at venue bounds centre".into(),
                }],
                ..Registries::default()
            },
            levels: Vec::new(),
            source_properties: BTreeMap::new(),
        };
        let bytes = encode_spatial_context(&context).expect("valid context encodes");
        assert_eq!(decode_spatial_context(&bytes).expect("bytes decode"), context);
    }

    #[test]
    fn out_of_range_datum_ref_is_rejected() {
        let mut context = base_context();
        context.frame.datum_ref = 1;
        assert!(encode_spatial_context(&context).is_err(), "empty datums: index 1 is out of range");
        let bytes = encode_spatial_context(&base_context()).expect("base encodes");
        // Re-encode a modified DTO through bytes is covered by decode-side
        // validation below; encode-side rejection is the contract here.
        let _ = bytes;
    }

    #[test]
    fn out_of_range_anchor_evidence_ref_is_rejected_on_encode() {
        let mut context = base_context();
        context.frame.anchor_evidence_ref = 7;
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn out_of_range_locator_artifact_ref_is_rejected_on_encode() {
        let mut context = base_context();
        context.registries.locators[0].artifact_ref = Some(9);
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn out_of_range_evidence_references_are_rejected_on_encode() {
        let mut context = base_context();
        context.registries.registration_evidence[0].source_locator_ref = 3;
        assert!(encode_spatial_context(&context).is_err());

        let mut context = base_context();
        context.registries.registration_evidence[0].transform_ref = Some(1);
        assert!(encode_spatial_context(&context).is_err());

        let mut context = base_context();
        context.registries.registration_evidence[0].confidence_ref = Some(1);
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn inconsistent_world_translation_is_rejected() {
        let mut context = base_context();
        context.frame.world_translation = [1.0, 2.0, 3.0];
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn non_unit_basis_column_is_rejected() {
        let mut context = base_context();
        context.frame.enu_basis_ecef[0] = [2.0, 0.0, 0.0];
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn non_finite_anchor_is_rejected() {
        let mut context = base_context();
        context.frame.anchor = [f64::NAN, 35.681];
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn out_of_range_anchor_coordinates_are_rejected() {
        let mut context = base_context();
        context.frame.anchor = [200.0, 35.681];
        assert!(encode_spatial_context(&context).is_err());

        let mut context = base_context();
        context.frame.anchor = [139.767, 95.0];
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn oversize_vertical_offset_is_rejected() {
        let mut context = base_context();
        context.frame.vertical_normalisation_offset_mm = 1_000_000_001;
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn oversized_registry_is_rejected() {
        let mut context = base_context();
        let overflow = vec![SourceArtifact { name: "x".into(), hash: [0u8; 32] }; 65_537];
        context.registries.artifacts = overflow;
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn oversized_string_is_rejected() {
        let mut context = base_context();
        context.registries.datums[0].name = "x".repeat(1025);
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn confidence_out_of_range_is_rejected() {
        let mut context = base_context();
        context.registries.confidence[0].value = 1.5;
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn oversize_source_properties_map_is_rejected() {
        let mut context = base_context();
        context.source_properties = (0..1025)
            .map(|i| (format!("k{i}"), Value::Number(1.0)))
            .collect();
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn oversize_source_property_key_is_rejected() {
        let mut context = base_context();
        context.source_properties = BTreeMap::from([("x".repeat(257).into(), Value::Number(1.0))]);
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn negative_zero_is_normalized_on_round_trip() {
        let mut context = base_context();
        context.registries.transforms[0].coefficients = vec![-0.0];
        let bytes = encode_spatial_context(&context).expect("encodes");
        let decoded = decode_spatial_context(&bytes).expect("decodes");
        assert_eq!(decoded.registries.transforms[0].coefficients, vec![0.0]);
    }

    #[test]
    fn trailing_bytes_after_the_value_are_rejected() {
        let bytes = encode_spatial_context(&base_context()).expect("base encodes");
        let mut padded = bytes.clone();
        padded.push(0u8);
        assert!(decode_spatial_context(&padded).is_err());
    }

    #[test]
    fn decode_rejects_a_malformed_dto() {
        // A well-formed postcard encoding of a wrong type must not decode.
        let bogus = postcard::to_allocvec(&42u8).expect("encodes");
        assert!(decode_spatial_context(&bogus).is_err());
    }

    fn level_record() -> LevelRecord {
        LevelRecord {
            level_id: "level-1".into(),
            ordinal: 1.0,
            source_elevation_m: Some(12.25),
            network_difference_mm: Some(-250),
            resolved_scene_z_mm: 4000,
            method: ResolutionMethod::ImportedElevation,
            confidence_ref: 0,
            evidence_refs: vec![0],
        }
    }

    #[test]
    fn round_trip_preserves_level_records() {
        let mut context = base_context();
        context.levels = vec![level_record()];
        let bytes = encode_spatial_context(&context).expect("valid context encodes");
        let decoded = decode_spatial_context(&bytes).expect("bytes decode");
        assert_eq!(decoded.levels, vec![level_record()]);
    }

    #[test]
    fn negative_scene_z_is_rejected() {
        let mut context = base_context();
        let mut record = level_record();
        record.resolved_scene_z_mm = -1;
        context.levels = vec![record];
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn out_of_range_level_confidence_ref_is_rejected() {
        let mut context = base_context();
        let mut record = level_record();
        record.confidence_ref = 1;
        context.levels = vec![record];
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn out_of_range_level_evidence_ref_is_rejected() {
        let mut context = base_context();
        let mut record = level_record();
        record.evidence_refs = vec![7];
        context.levels = vec![record];
        assert!(encode_spatial_context(&context).is_err());
    }

    #[test]
    fn out_of_range_assumption_ref_is_rejected() {
        let mut context = base_context();
        // The base context carries exactly one assumption, so index 1 dangles.
        context.registries.registration_evidence[0].assumption_ref = Some(1);
        assert!(
            encode_spatial_context(&context).is_err(),
            "an assumption reference beyond the registry must be rejected"
        );
    }

    #[test]
    fn oversize_network_difference_is_rejected() {
        let mut context = base_context();
        let mut record = level_record();
        record.network_difference_mm = Some(1_000_000_001);
        context.levels = vec![record];
        assert!(encode_spatial_context(&context).is_err());
    }
}
