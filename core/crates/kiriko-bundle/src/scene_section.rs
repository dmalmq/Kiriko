//! Section 9 (scene sources) postcard DTOs, encode/decode, and bounded
//! validation against §8's registries.
//!
//! The canonical types live in `kiriko-model::scene`; this module mirrors
//! them as postcard-serializable DTOs (the same split as the §8 spatial
//! context section). §9 is the first section whose references cross into
//! another section: every primitive's level membership, confidence, source
//! locators, and evidence resolve into the §8 spatial context of the same
//! bundle — never duplicated. Encode therefore requires the §8 context, and
//! decode validates against the decoded §8 (the capability model guarantees
//! §8 is available whenever §9 is decoded).
//!
//! §9 carries no floating-point values: resolved geometry is checked integer
//! millimetres and source evidence lives in §8's registries. Validation is
//! bounded and runs before availability is offered.

use kiriko_model::scene::{
    ActivationState, ContextualClassification, ConveyanceKind, FloorMapping, Mesh,
    OcclusionClass, PrimitiveGeometry, PrimitiveRole, ScenePrimitive, SceneSection,
    SourceObjectAssociation, TilesDescriptor,
};
use kiriko_model::spatial::SpatialContext;
use serde::{Deserialize, Serialize};

use crate::codec::{postcard_encode_err, postcard_take_exact};
use crate::error::{BundleError, BundleErrorCode};
use crate::spatial_section::{MAX_REGISTRY_LEN, MAX_STRING_LEN};

/// Cap on any absolute scene coordinate (venue-local millimetres, ±1000 km).
pub(crate) const MAX_SCENE_COORDINATE_MM: i64 = 1_000_000_000;
/// Cap on positions per mesh — bounds memory on decode of a hostile bundle.
pub(crate) const MAX_MESH_POSITIONS: usize = 1_000_000;
/// Cap on triangle faces per mesh.
pub(crate) const MAX_MESH_FACES: usize = 1_000_000;
/// Cap on descriptor entry lists.
pub(crate) const MAX_DESCRIPTOR_ENTRIES: usize = 65_536;

// -- DTO mirrors -----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum PrimitiveRoleDto {
    Surface,
    Wall,
    Ceiling,
    Portal,
    Conveyance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum OcclusionClassDto {
    Opaque,
    SemiTransparent,
    Transparent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum ConveyanceKindDto {
    SourceEvidenced,
    Neutral,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct MeshDto {
    positions: Vec<[i64; 3]>,
    faces: Vec<[u32; 3]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum PrimitiveGeometryDto {
    Mesh(MeshDto),
    Portal { connects: (u32, u32), opening: MeshDto },
    Conveyance { kind: ConveyanceKindDto, mesh: MeshDto },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ScenePrimitiveDto {
    id: String,
    role: PrimitiveRoleDto,
    level_id: String,
    occlusion: OcclusionClassDto,
    confidence_ref: u32,
    canonical_feature_id: Option<String>,
    source_locator_refs: Vec<u32>,
    evidence_refs: Vec<u32>,
    geometry: PrimitiveGeometryDto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum ActivationStateDto {
    NotActivated,
    Activated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct FloorMappingDto {
    canonical_level_id: String,
    composite_source_levels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SourceObjectAssociationDto {
    source_object_id: String,
    canonical_feature_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ContextualClassificationDto {
    source_object_id: String,
    occlusion: OcclusionClassDto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct TilesDescriptorDto {
    package_hash: [u8; 32],
    manifest_hash: [u8; 32],
    activation_state: ActivationStateDto,
    registration_profile_id: String,
    floor_mappings: Vec<FloorMappingDto>,
    source_object_associations: Vec<SourceObjectAssociationDto>,
    contextual_classifications: Vec<ContextualClassificationDto>,
}

/// Section 9 payload. Optional — `encode_bundle` emits it only when the
/// document carries a scene, and only alongside §8.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SceneSectionDto {
    primitives: Vec<ScenePrimitiveDto>,
    descriptor: Option<TilesDescriptorDto>,
}

// -- Enum conversions ------------------------------------------------------

impl From<&PrimitiveRole> for PrimitiveRoleDto {
    fn from(value: &PrimitiveRole) -> Self {
        match value {
            PrimitiveRole::Surface => Self::Surface,
            PrimitiveRole::Wall => Self::Wall,
            PrimitiveRole::Ceiling => Self::Ceiling,
            PrimitiveRole::Portal => Self::Portal,
            PrimitiveRole::Conveyance => Self::Conveyance,
        }
    }
}

impl From<PrimitiveRoleDto> for PrimitiveRole {
    fn from(value: PrimitiveRoleDto) -> Self {
        match value {
            PrimitiveRoleDto::Surface => Self::Surface,
            PrimitiveRoleDto::Wall => Self::Wall,
            PrimitiveRoleDto::Ceiling => Self::Ceiling,
            PrimitiveRoleDto::Portal => Self::Portal,
            PrimitiveRoleDto::Conveyance => Self::Conveyance,
        }
    }
}

impl From<&OcclusionClass> for OcclusionClassDto {
    fn from(value: &OcclusionClass) -> Self {
        match value {
            OcclusionClass::Opaque => Self::Opaque,
            OcclusionClass::SemiTransparent => Self::SemiTransparent,
            OcclusionClass::Transparent => Self::Transparent,
        }
    }
}

impl From<OcclusionClassDto> for OcclusionClass {
    fn from(value: OcclusionClassDto) -> Self {
        match value {
            OcclusionClassDto::Opaque => Self::Opaque,
            OcclusionClassDto::SemiTransparent => Self::SemiTransparent,
            OcclusionClassDto::Transparent => Self::Transparent,
        }
    }
}

impl From<&ConveyanceKind> for ConveyanceKindDto {
    fn from(value: &ConveyanceKind) -> Self {
        match value {
            ConveyanceKind::SourceEvidenced => Self::SourceEvidenced,
            ConveyanceKind::Neutral => Self::Neutral,
        }
    }
}

impl From<ConveyanceKindDto> for ConveyanceKind {
    fn from(value: ConveyanceKindDto) -> Self {
        match value {
            ConveyanceKindDto::SourceEvidenced => Self::SourceEvidenced,
            ConveyanceKindDto::Neutral => Self::Neutral,
        }
    }
}

impl From<&ActivationState> for ActivationStateDto {
    fn from(value: &ActivationState) -> Self {
        match value {
            ActivationState::NotActivated => Self::NotActivated,
            ActivationState::Activated => Self::Activated,
        }
    }
}

impl From<ActivationStateDto> for ActivationState {
    fn from(value: ActivationStateDto) -> Self {
        match value {
            ActivationStateDto::NotActivated => Self::NotActivated,
            ActivationStateDto::Activated => Self::Activated,
        }
    }
}

// -- Canonical <-> DTO conversions -----------------------------------------

fn mesh_to_dto(mesh: &Mesh) -> MeshDto {
    MeshDto {
        positions: mesh.positions.clone(),
        faces: mesh.faces.clone(),
    }
}

fn mesh_from_dto(dto: &MeshDto) -> Mesh {
    Mesh {
        positions: dto.positions.clone(),
        faces: dto.faces.clone(),
    }
}

fn geometry_to_dto(geometry: &PrimitiveGeometry) -> PrimitiveGeometryDto {
    match geometry {
        PrimitiveGeometry::Mesh(mesh) => PrimitiveGeometryDto::Mesh(mesh_to_dto(mesh)),
        PrimitiveGeometry::Portal { connects, opening } => PrimitiveGeometryDto::Portal {
            connects: *connects,
            opening: mesh_to_dto(opening),
        },
        PrimitiveGeometry::Conveyance { kind, mesh } => PrimitiveGeometryDto::Conveyance {
            kind: ConveyanceKindDto::from(kind),
            mesh: mesh_to_dto(mesh),
        },
    }
}

fn geometry_from_dto(dto: &PrimitiveGeometryDto) -> PrimitiveGeometry {
    match dto {
        PrimitiveGeometryDto::Mesh(mesh) => PrimitiveGeometry::Mesh(mesh_from_dto(mesh)),
        PrimitiveGeometryDto::Portal { connects, opening } => PrimitiveGeometry::Portal {
            connects: *connects,
            opening: mesh_from_dto(opening),
        },
        PrimitiveGeometryDto::Conveyance { kind, mesh } => PrimitiveGeometry::Conveyance {
            kind: ConveyanceKind::from(*kind),
            mesh: mesh_from_dto(mesh),
        },
    }
}

fn primitive_to_dto(primitive: &ScenePrimitive) -> ScenePrimitiveDto {
    ScenePrimitiveDto {
        id: primitive.id.clone(),
        role: PrimitiveRoleDto::from(&primitive.role),
        level_id: primitive.level_id.clone(),
        occlusion: OcclusionClassDto::from(&primitive.occlusion),
        confidence_ref: primitive.confidence_ref,
        canonical_feature_id: primitive.canonical_feature_id.clone(),
        source_locator_refs: primitive.source_locator_refs.clone(),
        evidence_refs: primitive.evidence_refs.clone(),
        geometry: geometry_to_dto(&primitive.geometry),
    }
}

fn primitive_from_dto(dto: &ScenePrimitiveDto) -> ScenePrimitive {
    ScenePrimitive {
        id: dto.id.clone(),
        role: PrimitiveRole::from(dto.role),
        level_id: dto.level_id.clone(),
        occlusion: OcclusionClass::from(dto.occlusion),
        confidence_ref: dto.confidence_ref,
        canonical_feature_id: dto.canonical_feature_id.clone(),
        source_locator_refs: dto.source_locator_refs.clone(),
        evidence_refs: dto.evidence_refs.clone(),
        geometry: geometry_from_dto(&dto.geometry),
    }
}

fn descriptor_to_dto(descriptor: &TilesDescriptor) -> TilesDescriptorDto {
    TilesDescriptorDto {
        package_hash: descriptor.package_hash,
        manifest_hash: descriptor.manifest_hash,
        activation_state: ActivationStateDto::from(&descriptor.activation_state),
        registration_profile_id: descriptor.registration_profile_id.clone(),
        floor_mappings: descriptor
            .floor_mappings
            .iter()
            .map(|m| FloorMappingDto {
                canonical_level_id: m.canonical_level_id.clone(),
                composite_source_levels: m.composite_source_levels.clone(),
            })
            .collect(),
        source_object_associations: descriptor
            .source_object_associations
            .iter()
            .map(|a| SourceObjectAssociationDto {
                source_object_id: a.source_object_id.clone(),
                canonical_feature_id: a.canonical_feature_id.clone(),
            })
            .collect(),
        contextual_classifications: descriptor
            .contextual_classifications
            .iter()
            .map(|c| ContextualClassificationDto {
                source_object_id: c.source_object_id.clone(),
                occlusion: OcclusionClassDto::from(&c.occlusion),
            })
            .collect(),
    }
}

fn descriptor_from_dto(dto: &TilesDescriptorDto) -> TilesDescriptor {
    TilesDescriptor {
        package_hash: dto.package_hash,
        manifest_hash: dto.manifest_hash,
        activation_state: ActivationState::from(dto.activation_state),
        registration_profile_id: dto.registration_profile_id.clone(),
        floor_mappings: dto
            .floor_mappings
            .iter()
            .map(|m| FloorMapping {
                canonical_level_id: m.canonical_level_id.clone(),
                composite_source_levels: m.composite_source_levels.clone(),
            })
            .collect(),
        source_object_associations: dto
            .source_object_associations
            .iter()
            .map(|a| SourceObjectAssociation {
                source_object_id: a.source_object_id.clone(),
                canonical_feature_id: a.canonical_feature_id.clone(),
            })
            .collect(),
        contextual_classifications: dto
            .contextual_classifications
            .iter()
            .map(|c| ContextualClassification {
                source_object_id: c.source_object_id.clone(),
                occlusion: OcclusionClass::from(c.occlusion),
            })
            .collect(),
    }
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

/// Validate a scene mesh: position bounds and face indices.
fn validate_mesh(mesh: &Mesh, what: &str) -> Result<(), BundleError> {
    if mesh.positions.len() > MAX_MESH_POSITIONS {
        return Err(invalid(format!("{what} has too many positions")));
    }
    if mesh.faces.len() > MAX_MESH_FACES {
        return Err(invalid(format!("{what} has too many faces")));
    }
    for (i, position) in mesh.positions.iter().enumerate() {
        if position.iter().any(|c| c.abs() > MAX_SCENE_COORDINATE_MM) {
            return Err(invalid(format!(
                "{what} position {i} is outside ±{MAX_SCENE_COORDINATE_MM} mm"
            )));
        }
    }
    for (i, face) in mesh.faces.iter().enumerate() {
        for index in face {
            if *index as usize >= mesh.positions.len() {
                return Err(invalid(format!(
                    "{what} face {i} references position {index} beyond {} positions",
                    mesh.positions.len()
                )));
            }
        }
    }
    Ok(())
}

/// Validate every identifier, numeric range, collection count, ordering
/// invariant, string length, and cross-reference of a scene, resolving its
/// references against the §8 spatial context of the same bundle. Runs on both
/// the encode and decode path, so a hand-crafted section is held to exactly
/// the same rules as a freshly encoded one.
fn validate_scene(scene: &SceneSection, spatial: &SpatialContext) -> Result<(), BundleError> {
    let registries = &spatial.registries;
    let known_levels: Vec<&str> = spatial.levels.iter().map(|l| l.level_id.as_str()).collect();

    if scene.primitives.len() > MAX_REGISTRY_LEN {
        return Err(invalid(format!(
            "scene primitive count exceeds {MAX_REGISTRY_LEN}"
        )));
    }
    for (i, primitive) in scene.primitives.iter().enumerate() {
        bounded_string(&primitive.id, &format!("primitive {i} id"))?;
        bounded_string(&primitive.level_id, &format!("primitive {i} level"))?;
        if !known_levels.contains(&primitive.level_id.as_str()) {
            return Err(invalid(format!(
                "primitive {i} references unknown level {:?}",
                primitive.level_id
            )));
        }
        if let Some(feature_id) = &primitive.canonical_feature_id {
            bounded_string(feature_id, &format!("primitive {i} canonical feature"))?;
        }
        if primitive.confidence_ref as usize >= registries.confidence.len() {
            return Err(invalid(format!(
                "primitive {i} confidence reference {} is out of range",
                primitive.confidence_ref
            )));
        }
        if primitive.source_locator_refs.len() > MAX_REGISTRY_LEN
            || primitive.evidence_refs.len() > MAX_REGISTRY_LEN
        {
            return Err(invalid(format!("primitive {i} has too many references")));
        }
        for locator_ref in &primitive.source_locator_refs {
            if *locator_ref as usize >= registries.locators.len() {
                return Err(invalid(format!(
                    "primitive {i} locator reference {locator_ref} is out of range"
                )));
            }
        }
        for evidence_ref in &primitive.evidence_refs {
            if *evidence_ref as usize >= registries.registration_evidence.len() {
                return Err(invalid(format!(
                    "primitive {i} evidence reference {evidence_ref} is out of range"
                )));
            }
        }
        match &primitive.geometry {
            PrimitiveGeometry::Mesh(mesh) => {
                if primitive.role == PrimitiveRole::Portal || primitive.role == PrimitiveRole::Conveyance {
                    return Err(invalid(format!(
                        "primitive {i} role {:?} cannot carry plain mesh geometry",
                        primitive.role
                    )));
                }
                validate_mesh(mesh, &format!("primitive {i} mesh"))?;
            }
            PrimitiveGeometry::Portal { connects, opening } => {
                if primitive.role != PrimitiveRole::Portal {
                    return Err(invalid(format!(
                        "primitive {i} carries portal geometry but role {:?}",
                        primitive.role
                    )));
                }
                let (a, b) = *connects;
                if a as usize >= scene.primitives.len() || b as usize >= scene.primitives.len() {
                    return Err(invalid(format!(
                        "primitive {i} portal connects ({a}, {b}) out of range"
                    )));
                }
                if a == b {
                    return Err(invalid(format!(
                        "primitive {i} portal connects a primitive to itself"
                    )));
                }
                validate_mesh(opening, &format!("primitive {i} opening"))?;
            }
            PrimitiveGeometry::Conveyance { kind, mesh } => {
                if primitive.role != PrimitiveRole::Conveyance {
                    return Err(invalid(format!(
                        "primitive {i} carries conveyance geometry but role {:?}",
                        primitive.role
                    )));
                }
                let _ = kind;
                validate_mesh(mesh, &format!("primitive {i} conveyance mesh"))?;
            }
        }
    }

    if let Some(descriptor) = &scene.descriptor {
        bounded_string(&descriptor.registration_profile_id, "tiles registration profile")?;
        if descriptor.floor_mappings.len() > MAX_DESCRIPTOR_ENTRIES
            || descriptor.source_object_associations.len() > MAX_DESCRIPTOR_ENTRIES
            || descriptor.contextual_classifications.len() > MAX_DESCRIPTOR_ENTRIES
        {
            return Err(invalid(format!(
                "tiles descriptor entry list exceeds {MAX_DESCRIPTOR_ENTRIES}"
            )));
        }
        for (i, mapping) in descriptor.floor_mappings.iter().enumerate() {
            bounded_string(&mapping.canonical_level_id, &format!("floor mapping {i} level"))?;
            if !known_levels.contains(&mapping.canonical_level_id.as_str()) {
                return Err(invalid(format!(
                    "floor mapping {i} references unknown level {:?}",
                    mapping.canonical_level_id
                )));
            }
            if mapping.composite_source_levels.len() > MAX_DESCRIPTOR_ENTRIES {
                return Err(invalid(format!("floor mapping {i} has too many source levels")));
            }
            for composite in &mapping.composite_source_levels {
                bounded_string(composite, &format!("floor mapping {i} composite identity"))?;
            }
        }
        for (i, association) in descriptor.source_object_associations.iter().enumerate() {
            bounded_string(&association.source_object_id, &format!("source object association {i}"))?;
            if let Some(feature_id) = &association.canonical_feature_id {
                bounded_string(feature_id, &format!("source object association {i} feature"))?;
            }
        }
        for (i, classification) in descriptor.contextual_classifications.iter().enumerate() {
            bounded_string(&classification.source_object_id, &format!("contextual classification {i}"))?;
        }
    }

    Ok(())
}

// -- Section codec ---------------------------------------------------------

/// Encode a [`SceneSection`] as the §9 payload. Requires the §8 spatial
/// context (the section's declared dependency) so every reference resolves;
/// validates the canonical value first, then serializes with postcard.
pub(crate) fn encode_scene_section(
    scene: &SceneSection,
    spatial: &SpatialContext,
) -> Result<Vec<u8>, BundleError> {
    validate_scene(scene, spatial)?;
    let dto = SceneSectionDto {
        primitives: scene.primitives.iter().map(primitive_to_dto).collect(),
        descriptor: scene.descriptor.as_ref().map(descriptor_to_dto),
    };
    postcard::to_allocvec(&dto).map_err(postcard_encode_err("encode scene sources section"))
}

/// Decode the §9 payload against the decoded §8 spatial context. Rejects
/// trailing bytes, converts to the canonical model, and validates every
/// reference against §8 — a violation rejects the section, which the
/// capability model reports as `invalid` without failing the bundle.
pub(crate) fn decode_scene_section(
    bytes: &[u8],
    spatial: &SpatialContext,
) -> Result<SceneSection, BundleError> {
    let dto: SceneSectionDto = postcard_take_exact(bytes, "decode scene sources section")?;
    let scene = SceneSection {
        primitives: dto.primitives.iter().map(primitive_from_dto).collect(),
        descriptor: dto.descriptor.as_ref().map(descriptor_from_dto),
    };
    validate_scene(&scene, spatial)?;
    Ok(scene)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use kiriko_model::scene::{
        ActivationState, ConveyanceKind, FloorMapping, Mesh, OcclusionClass, PrimitiveGeometry,
        PrimitiveRole, ScenePrimitive, SceneSection, SourceObjectAssociation, TilesDescriptor,
    };
    use kiriko_model::spatial::{
        Assumption, AssumptionKind, Axes, Confidence, ConfidenceKind, Datum, Ellipsoid,
        EvidenceMethod, Frame, LengthUnit, LevelRecord, LocatorKind, ManualProvenance, Registries,
        RegistrationEvidence, ResolutionMethod, SourceArtifact, SourceLocator, SpatialContext,
    };

    use super::{decode_scene_section, encode_scene_section};

    /// A §8 spatial context whose registries are big enough for the test
    /// refs (confidence 0..2, locators 0..2, evidence 0..1, levels l1/l2).
    fn spatial_context() -> SpatialContext {
        SpatialContext {
            frame: Frame {
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
            registries: Registries {
                artifacts: Vec::new(),
                locators: vec![
                    SourceLocator {
                        kind: LocatorKind::FeatureId,
                        value: "so-0".into(),
                        artifact_ref: None,
                    },
                    SourceLocator {
                        kind: LocatorKind::LayerName,
                        value: "net_junction".into(),
                        artifact_ref: None,
                    },
                ],
                datums: vec![Datum {
                    name: "WGS84".into(),
                    ellipsoid: Ellipsoid {
                        semi_major_metres: 6_378_137.0,
                        inverse_flattening: 298.257_223_563,
                    },
                }],
                transforms: Vec::new(),
                registration_evidence: vec![RegistrationEvidence {
                    method: EvidenceMethod::DerivedFromVenueGeometry,
                    source_locator_ref: 0,
                    transform_ref: None,
                    confidence_ref: None,
                    assumption_ref: None,
                    detail: "test evidence".into(),
                }],
                assumptions: vec![Assumption {
                    kind: AssumptionKind::Nominal,
                    detail: "nominal wall height".into(),
                }],
                confidence: vec![
                    Confidence {
                        kind: ConfidenceKind::Measured,
                        value: 1.0,
                    },
                    Confidence {
                        kind: ConfidenceKind::Assumed,
                        value: 0.3,
                    },
                ],
                manual_provenance: Vec::new(),
            },
            levels: vec![
                LevelRecord {
                    level_id: "l1".into(),
                    ordinal: 0.0,
                    source_elevation_m: Some(10.0),
                    network_difference_mm: None,
                    resolved_scene_z_mm: 0,
                    method: ResolutionMethod::ImportedElevation,
                    confidence_ref: 0,
                    evidence_refs: vec![0],
                    override_elevation_m: None,
                    override_ref: None,
                },
                LevelRecord {
                    level_id: "l2".into(),
                    ordinal: 1.0,
                    source_elevation_m: None,
                    network_difference_mm: None,
                    resolved_scene_z_mm: 4000,
                    method: ResolutionMethod::NominalSpacing,
                    confidence_ref: 1,
                    evidence_refs: vec![0],
                    override_elevation_m: None,
                    override_ref: None,
                },
            ],
            source_properties: BTreeMap::new(),
        }
    }

    fn mesh() -> Mesh {
        Mesh {
            positions: vec![[0, 0, 0], [1000, 0, 0], [1000, 1000, 0], [0, 1000, 0]],
            faces: vec![[0, 1, 2], [0, 2, 3]],
        }
    }

    fn scene_section() -> SceneSection {
        SceneSection {
            primitives: vec![
                ScenePrimitive {
                    id: "p-surface".into(),
                    role: PrimitiveRole::Surface,
                    level_id: "l1".into(),
                    occlusion: OcclusionClass::Opaque,
                    confidence_ref: 0,
                    canonical_feature_id: Some("f1".into()),
                    source_locator_refs: vec![0],
                    evidence_refs: vec![0],
                    geometry: PrimitiveGeometry::Mesh(mesh()),
                },
                ScenePrimitive {
                    id: "p-portal".into(),
                    role: PrimitiveRole::Portal,
                    level_id: "l1".into(),
                    occlusion: OcclusionClass::Transparent,
                    confidence_ref: 0,
                    canonical_feature_id: None,
                    source_locator_refs: Vec::new(),
                    evidence_refs: vec![0],
                    geometry: PrimitiveGeometry::Portal {
                        connects: (0, 1),
                        opening: mesh(),
                    },
                },
                ScenePrimitive {
                    id: "p-convey".into(),
                    role: PrimitiveRole::Conveyance,
                    level_id: "l2".into(),
                    occlusion: OcclusionClass::Opaque,
                    confidence_ref: 1,
                    canonical_feature_id: Some("f2".into()),
                    source_locator_refs: vec![1],
                    evidence_refs: vec![0],
                    geometry: PrimitiveGeometry::Conveyance {
                        kind: ConveyanceKind::Neutral,
                        mesh: mesh(),
                    },
                },
            ],
            descriptor: Some(TilesDescriptor {
                package_hash: [7u8; 32],
                manifest_hash: [9u8; 32],
                activation_state: ActivationState::NotActivated,
                registration_profile_id: "tokyo-v1".into(),
                floor_mappings: vec![FloorMapping {
                    canonical_level_id: "l1".into(),
                    composite_source_levels: vec!["asset-v1|doc|link|L1|elev-100".into()],
                }],
                source_object_associations: vec![SourceObjectAssociation {
                    source_object_id: "so-1".into(),
                    canonical_feature_id: Some("f1".into()),
                }],
                contextual_classifications: Vec::new(),
            }),
        }
    }

    #[test]
    fn round_trip_preserves_a_fully_populated_scene() {
        let scene = scene_section();
        let bytes = encode_scene_section(&scene, &spatial_context()).expect("valid scene encodes");
        assert_eq!(
            decode_scene_section(&bytes, &spatial_context()).expect("bytes decode"),
            scene
        );
    }

    #[test]
    fn out_of_range_face_index_is_rejected() {
        let mut scene = scene_section();
        let mut mesh = mesh();
        mesh.faces = vec![[0, 1, 4]];
        scene.primitives[0].geometry = PrimitiveGeometry::Mesh(mesh);
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn a_portal_connecting_itself_is_rejected() {
        let mut scene = scene_section();
        scene.primitives[1].geometry = PrimitiveGeometry::Portal {
            connects: (1, 1),
            opening: mesh(),
        };
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn an_out_of_range_portal_reference_is_rejected() {
        let mut scene = scene_section();
        scene.primitives[1].geometry = PrimitiveGeometry::Portal {
            connects: (0, 7),
            opening: mesh(),
        };
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn a_role_geometry_mismatch_is_rejected() {
        let mut scene = scene_section();
        scene.primitives[0].geometry = PrimitiveGeometry::Portal {
            connects: (1, 2),
            opening: mesh(),
        };
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn an_unknown_level_membership_is_rejected() {
        let mut scene = scene_section();
        scene.primitives[0].level_id = "no-such-level".into();
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn an_out_of_range_confidence_ref_is_rejected() {
        let mut scene = scene_section();
        scene.primitives[0].confidence_ref = 9;
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn an_out_of_range_locator_ref_is_rejected() {
        let mut scene = scene_section();
        scene.primitives[0].source_locator_refs = vec![5];
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn an_out_of_range_evidence_ref_is_rejected() {
        let mut scene = scene_section();
        scene.primitives[0].evidence_refs = vec![5];
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn out_of_bounds_scene_coordinates_are_rejected() {
        let mut scene = scene_section();
        let mut mesh = mesh();
        mesh.positions[0] = [2_000_000_000, 0, 0];
        scene.primitives[0].geometry = PrimitiveGeometry::Mesh(mesh);
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn oversize_strings_and_counts_are_rejected() {
        let mut scene = scene_section();
        scene.primitives[0].id = "x".repeat(1025);
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());

        let mut scene = scene_section();
        scene.primitives = Vec::new();
        let mut descriptor = TilesDescriptor {
            package_hash: [0u8; 32],
            manifest_hash: [0u8; 32],
            activation_state: ActivationState::NotActivated,
            registration_profile_id: "p".into(),
            floor_mappings: Vec::new(),
            source_object_associations: Vec::new(),
            contextual_classifications: Vec::new(),
        };
        descriptor.floor_mappings = (0..65_537)
            .map(|i| FloorMapping {
                canonical_level_id: format!("l{i}"),
                composite_source_levels: Vec::new(),
            })
            .collect();
        scene.descriptor = Some(descriptor);
        assert!(encode_scene_section(&scene, &spatial_context()).is_err());
    }

    #[test]
    fn trailing_bytes_after_the_value_are_rejected() {
        let bytes = encode_scene_section(&scene_section(), &spatial_context()).expect("encodes");
        let mut padded = bytes.clone();
        padded.push(0u8);
        assert!(decode_scene_section(&padded, &spatial_context()).is_err());
    }
}
