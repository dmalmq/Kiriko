//! Canonical §9 scene-sources types.
//!
//! The compiled Generated 3D scene is a set of compact indexed semantic
//! primitives in venue-local millimetres — never duplicated GeoJSON, never
//! renderer/GPU buffers — plus the typed descriptor slot for an optional
//! external 3D Tiles package. This module holds the canonical model only;
//! the postcard DTOs and the §9 codec live in `kiriko-bundle` (the same
//! split as `kiriko_model::spatial`).
//!
//! Resolved scene geometry is checked integer millimetres; source evidence
//! (coordinates, dimensions, datum, transforms) stays canonical finite `f64`
//! inside §8's registries, which §9 references rather than duplicating.
//! Primitive evidence/confidence references therefore resolve into the §8
//! registries of the same bundle.

/// Semantic role of a scene primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimitiveRole {
    /// A floor slab or navigable surface.
    Surface,
    /// A wall derived from space boundaries / corroborated source lines.
    Wall,
    /// A ceiling surface (navigation-time fade/opacity is the visual
    /// language's concern, not the format's).
    Ceiling,
    /// An explicit portal/topology relationship between two primitives.
    Portal,
    /// A conveyance form (stairs, ramp, escalator, lift, shaft) — either
    /// source-evidenced or the category-specific neutral fallback.
    Conveyance,
}

/// How much a primitive blocks the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcclusionClass {
    Opaque,
    SemiTransparent,
    Transparent,
}

/// Whether a conveyance form is derived from source evidence or is the
/// category-specific neutral fallback emitted when evidence is insufficient.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConveyanceKind {
    SourceEvidenced,
    Neutral,
}

/// An indexed triangle mesh in venue-local millimetres. Positions are checked
/// integer millimetres; `faces` are triangle index triples into `positions`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mesh {
    pub positions: Vec<[i64; 3]>,
    pub faces: Vec<[u32; 3]>,
}

/// Per-role geometry. A portal is an explicit topology relationship between
/// two primitives plus the opening's own mesh — never a coincident-polygon
/// convention.
#[derive(Debug, Clone, PartialEq)]
pub enum PrimitiveGeometry {
    Mesh(Mesh),
    Portal {
        connects: (u32, u32),
        opening: Mesh,
    },
    Conveyance {
        kind: ConveyanceKind,
        mesh: Mesh,
    },
}

/// One compiled semantic scene primitive, referencing §8's registries for its
/// confidence, source locators, and evidence.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenePrimitive {
    /// Stable identity, canonical for the venue version.
    pub id: String,
    pub role: PrimitiveRole,
    /// Canonical level membership — matches a §8 `LevelRecord.level_id`.
    pub level_id: String,
    pub occlusion: OcclusionClass,
    /// Index into §8 `Registries::confidence`.
    pub confidence_ref: u32,
    /// The canonical venue feature (§2/§3) this primitive represents, when
    /// one exists.
    pub canonical_feature_id: Option<String>,
    /// Indices into §8 `Registries::locators` — the source objects.
    pub source_locator_refs: Vec<u32>,
    /// Indices into §8 `Registries::registration_evidence`.
    pub evidence_refs: Vec<u32>,
    pub geometry: PrimitiveGeometry,
}

/// Activation and validated capability state of an external tile package.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationState {
    NotActivated,
    Activated,
}

/// Canonical floor → composite source levels. The composite identity encodes
/// asset version + source document + source link + level key + quantized
/// elevation; it is never a join key into venue data.
#[derive(Debug, Clone, PartialEq)]
pub struct FloorMapping {
    pub canonical_level_id: String,
    pub composite_source_levels: Vec<String>,
}

/// A stable source-object identity with its optional canonical association.
/// An unassociated source object cannot impersonate a canonical feature.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceObjectAssociation {
    pub source_object_id: String,
    pub canonical_feature_id: Option<String>,
}

/// An unassigned source object classified with an explicit visibility and
/// occlusion policy — it cannot default to an always-visible blocker.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextualClassification {
    pub source_object_id: String,
    pub occlusion: OcclusionClass,
}

/// The typed descriptor slot for an optional external 3D Tiles package.
/// Deliberately contains no deployment URL and no GLB bytes: tile manifests
/// and members are separately content-addressed and version-pinned (Stage 3).
#[derive(Debug, Clone, PartialEq)]
pub struct TilesDescriptor {
    /// Immutable package identity (manifest's content hash).
    pub package_hash: [u8; 32],
    /// Root tileset manifest hash.
    pub manifest_hash: [u8; 32],
    pub activation_state: ActivationState,
    /// Registration/profile identity (versioned profile data).
    pub registration_profile_id: String,
    pub floor_mappings: Vec<FloorMapping>,
    pub source_object_associations: Vec<SourceObjectAssociation>,
    pub contextual_classifications: Vec<ContextualClassification>,
}

/// Section 9 (scene sources) content: the compiled Generated 3D primitives
/// plus the optional tiles descriptor. Requires §8 — the declared dependency
/// edge — for its frame, level records, and registries.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneSection {
    pub primitives: Vec<ScenePrimitive>,
    pub descriptor: Option<TilesDescriptor>,
}

#[cfg(test)]
mod tests {
    use super::{
        ActivationState, ConveyanceKind, FloorMapping, Mesh, OcclusionClass, PrimitiveGeometry,
        PrimitiveRole, ScenePrimitive, SceneSection, SourceObjectAssociation,
        TilesDescriptor,
    };

    #[test]
    fn every_primitive_role_and_geometry_is_constructible() {
        let surface = ScenePrimitive {
            id: "p1".into(),
            role: PrimitiveRole::Surface,
            level_id: "l1".into(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: 0,
            canonical_feature_id: Some("f1".into()),
            source_locator_refs: vec![0],
            evidence_refs: vec![0],
            geometry: PrimitiveGeometry::Mesh(Mesh {
                positions: vec![[0, 0, 0], [1000, 0, 0], [1000, 1000, 0], [0, 1000, 0]],
                faces: vec![[0, 1, 2], [0, 2, 3]],
            }),
        };
        let portal = ScenePrimitive {
            id: "p2".into(),
            role: PrimitiveRole::Portal,
            level_id: "l1".into(),
            occlusion: OcclusionClass::Transparent,
            confidence_ref: 0,
            canonical_feature_id: None,
            source_locator_refs: Vec::new(),
            evidence_refs: vec![0],
            geometry: PrimitiveGeometry::Portal {
                connects: (0, 1),
                opening: Mesh {
                    positions: vec![[0, 0, 0], [500, 0, 0], [500, 2000, 0], [0, 2000, 0]],
                    faces: vec![[0, 1, 2], [0, 2, 3]],
                },
            },
        };
        let conveyance = ScenePrimitive {
            id: "p3".into(),
            role: PrimitiveRole::Conveyance,
            level_id: "l2".into(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: 1,
            canonical_feature_id: Some("f2".into()),
            source_locator_refs: vec![1],
            evidence_refs: vec![1],
            geometry: PrimitiveGeometry::Conveyance {
                kind: ConveyanceKind::Neutral,
                mesh: Mesh {
                    positions: vec![[0, 0, 0], [1000, 0, 0], [1000, 2000, 0]],
                    faces: vec![[0, 1, 2]],
                },
            },
        };
        assert_eq!(surface.role, PrimitiveRole::Surface);
        assert_eq!(portal.role, PrimitiveRole::Portal);
        assert_eq!(conveyance.role, PrimitiveRole::Conveyance);
        assert_eq!(OcclusionClass::SemiTransparent as u8, 1);
        assert_eq!(ConveyanceKind::SourceEvidenced as u8, 0);
    }

    #[test]
    fn a_tiles_descriptor_is_constructible_without_urls_or_bytes() {
        let descriptor = TilesDescriptor {
            package_hash: [7u8; 32],
            manifest_hash: [9u8; 32],
            activation_state: ActivationState::NotActivated,
            registration_profile_id: "tokyo-v1".into(),
            floor_mappings: vec![FloorMapping {
                canonical_level_id: "l1".into(),
                composite_source_levels: vec![
                    "asset-v1|doc.glb|link-a|L1|elev-100".into(),
                ],
            }],
            source_object_associations: vec![SourceObjectAssociation {
                source_object_id: "so-1".into(),
                canonical_feature_id: Some("f1".into()),
            }],
            contextual_classifications: Vec::new(),
        };
        assert_eq!(descriptor.activation_state, ActivationState::NotActivated);
        assert_eq!(descriptor.floor_mappings[0].composite_source_levels.len(), 1);
    }

    #[test]
    fn a_scene_section_is_constructible() {
        let scene = SceneSection {
            primitives: Vec::new(),
            descriptor: None,
        };
        assert!(scene.primitives.is_empty());
        assert!(scene.descriptor.is_none());
    }
}
