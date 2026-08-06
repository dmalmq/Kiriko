//! The Generated scene source: a thin adapter over the bundle's §9 content
//! and §8 spatial context, implementing the renderer-neutral [`SceneSource`]
//! contract. Tiles (Stage 3) implements the same contract from its own data,
//! so a renderer adapts once and the sources cannot drift.

use std::collections::HashMap;

use kiriko_model::scene::{PrimitiveGeometry, PrimitiveRole};
use kiriko_model::scene_projection::{
    SceneCapabilityState, SceneConfidenceProjection, SceneEvidenceProjection, SceneFrameProjection,
    SceneLevelProjection, ScenePickProjection, ScenePrimitiveProjection, SceneProjection,
    SceneSource, SceneSourceIdentity, SceneSourceKind,
};
use kiriko_model::spatial::{Axes, LengthUnit};

use crate::codec::{BundleDocument, SectionCapability};

/// The Generated scene source: adapts a decoded bundle's §9 primitives and
/// §8 frame/levels/registries into the renderer-neutral projection.
pub(crate) struct GeneratedSceneSource<'a> {
    document: &'a BundleDocument,
}

impl<'a> GeneratedSceneSource<'a> {
    pub fn new(document: &'a BundleDocument) -> Self {
        Self { document }
    }

    fn projection(&self) -> SceneProjection {
        SceneProjection {
            identity: self.identity(),
            frame: self.frame(),
            levels: self.levels(),
            primitives: self.primitives(),
            capability: self.capability(),
        }
    }
}

/// The full typed projection of the Generated scene source for a decoded
/// bundle. `capability` reflects the bundle's actual §9 state (a bundle
/// without a scene reports `Absent`; one whose §9 is broken reports the
/// structured failure). The projection is pure: it decodes nothing, mutates
/// nothing, and never reaches into section bytes from TypeScript.
pub fn scene_projection(document: &BundleDocument) -> SceneProjection {
    GeneratedSceneSource::new(document).projection()
}

impl SceneSource for GeneratedSceneSource<'_> {
    fn identity(&self) -> SceneSourceIdentity {
        SceneSourceIdentity {
            kind: SceneSourceKind::Generated,
            provenance: "compiled at publication from canonical venue geometry".to_string(),
        }
    }

    fn frame(&self) -> Option<SceneFrameProjection> {
        let frame = &self.document.spatial_context.as_ref()?.frame;
        Some(SceneFrameProjection {
            anchor: frame.anchor,
            ecef_origin: frame.ecef_origin,
            enu_basis_ecef: frame.enu_basis_ecef,
            axes: Axes::EastNorthUp.as_str().to_string(),
            unit: LengthUnit::Millimetre.as_str().to_string(),
            vertical_normalisation_offset_mm: frame.vertical_normalisation_offset_mm,
        })
    }

    fn levels(&self) -> Vec<SceneLevelProjection> {
        let Some(spatial) = &self.document.spatial_context else {
            return Vec::new();
        };
        // Scene bounds per level come from the level's slab geometry.
        let mut slab_bounds: HashMap<&str, [i64; 4]> = HashMap::new();
        if let Some(scene) = &self.document.scene {
            for primitive in &scene.primitives {
                if primitive.role != PrimitiveRole::Surface
                    || primitive.canonical_feature_id.as_deref() != Some(primitive.level_id.as_str())
                {
                    continue;
                }
                let PrimitiveGeometry::Mesh(mesh) = &primitive.geometry else {
                    continue;
                };
                let (mut min_x, mut min_y, mut max_x, mut max_y) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
                for [x, y, _] in &mesh.positions {
                    min_x = min_x.min(*x);
                    min_y = min_y.min(*y);
                    max_x = max_x.max(*x);
                    max_y = max_y.max(*y);
                }
                if mesh.positions.is_empty() {
                    continue;
                }
                slab_bounds.insert(primitive.level_id.as_str(), [min_x, min_y, max_x, max_y]);
            }
        }
        spatial
            .levels
            .iter()
            .map(|level| SceneLevelProjection {
                level_id: level.level_id.clone(),
                ordinal: level.ordinal,
                resolved_scene_z_mm: level.resolved_scene_z_mm,
                bounds_mm: slab_bounds.get(level.level_id.as_str()).copied(),
                source_levels: Vec::new(),
            })
            .collect()
    }

    fn primitives(&self) -> Vec<ScenePrimitiveProjection> {
        let Some(spatial) = &self.document.spatial_context else {
            return Vec::new();
        };
        let Some(scene) = &self.document.scene else {
            return Vec::new();
        };
        scene
            .primitives
            .iter()
            .map(|primitive| {
                let confidence =
                    &spatial.registries.confidence[primitive.confidence_ref as usize];
                let source_object_ids = primitive
                    .source_locator_refs
                    .iter()
                    .map(|reference| {
                        spatial.registries.locators[*reference as usize].value.clone()
                    })
                    .collect();
                let evidence = primitive
                    .evidence_refs
                    .iter()
                    .map(|reference| {
                        let entry = &spatial.registries.registration_evidence[*reference as usize];
                        SceneEvidenceProjection {
                            method: entry.method.as_str().to_string(),
                            detail: entry.detail.clone(),
                        }
                    })
                    .collect();
                let conveyance_kind = match &primitive.geometry {
                    PrimitiveGeometry::Conveyance { kind, .. } => {
                        Some(kind.as_str().to_string())
                    }
                    _ => None,
                };
                ScenePrimitiveProjection {
                    id: primitive.id.clone(),
                    role: primitive.role.as_str().to_string(),
                    level_id: primitive.level_id.clone(),
                    occlusion: primitive.occlusion.as_str().to_string(),
                    confidence: SceneConfidenceProjection {
                        kind: confidence.kind.as_str().to_string(),
                        value: confidence.value,
                    },
                    canonical_feature_id: primitive.canonical_feature_id.clone(),
                    source_object_ids,
                    conveyance_kind,
                    evidence,
                }
            })
            .collect()
    }

    fn capability(&self) -> SceneCapabilityState {
        match self.document.capabilities.scene_sources() {
            SectionCapability::Available => SceneCapabilityState::Ready,
            SectionCapability::Absent => SceneCapabilityState::Absent,
            SectionCapability::Invalid { reason } => SceneCapabilityState::Invalid { reason },
            SectionCapability::UnsupportedVersion { declared, supported } => {
                SceneCapabilityState::UnsupportedVersion { declared, supported }
            }
            SectionCapability::DisabledByDependency { requires } => {
                SceneCapabilityState::DisabledByDependency { requires }
            }
        }
    }

    fn pick(&self, source_object_id: &str) -> Option<ScenePickProjection> {
        self.projection().pick(source_object_id)
    }
}
