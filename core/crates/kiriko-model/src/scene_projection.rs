//! The renderer-neutral scene-source adapter contract: typed projections and
//! the [`SceneSource`] trait both Generated (this stage) and Tiles (Stage 3)
//! implement. TypeScript mirrors these types; it never decodes section bytes,
//! interprets source-property keys, or resolves elevation. Bilingual copy is
//! renderable from the typed capability states, the same division as
//! `ViewerWarning` codes.

use serde::Serialize;

/// Which scene source produced a projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SceneSourceKind {
    /// The compiled Generated 3D scene baked into the bundle (Stage 1).
    Generated,
    /// An activated 3D Tiles package (Stage 3) — the contract exists now so
    /// both sources share it and cannot drift.
    Tiles,
}

/// Immutable scene-source identity and provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSourceIdentity {
    pub kind: SceneSourceKind,
    /// How this scene was produced, for audit.
    pub provenance: String,
}

/// The venue-local scene frame and world transform, from §8.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneFrameProjection {
    /// Exact WGS84 anchor (longitude, latitude).
    pub anchor: [f64; 2],
    pub ecef_origin: [f64; 3],
    /// East, north, up unit vectors in ECEF — the world-transform rotation.
    pub enu_basis_ecef: [[f64; 3]; 3],
    /// Declared axis convention: `east_north_up`.
    pub axes: String,
    /// Declared units for resolved coordinates: `millimetre`.
    pub unit: String,
    pub vertical_normalisation_offset_mm: i64,
}

/// One canonical level group: resolved plane, scene bounds, source membership.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneLevelProjection {
    pub level_id: String,
    pub ordinal: f64,
    pub resolved_scene_z_mm: i64,
    /// Scene-local horizontal bounds `[west, south, east, north]` (min/max
    /// x/y of the level's slab geometry), when computable.
    pub bounds_mm: Option<[i64; 4]>,
    /// Composite source levels this canonical floor maps to (the tiles
    /// descriptor's floor mappings); empty for the generated source.
    pub source_levels: Vec<String>,
}

/// A primitive's confidence class and value (from §8's confidence registry).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneConfidenceProjection {
    /// `measured` | `estimated` | `assumed` | `unknown`.
    pub kind: String,
    pub value: f64,
}

/// A primitive's evidence summary (from §8's registration evidence).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEvidenceProjection {
    pub method: String,
    pub detail: String,
}

/// One primitive as the renderer sees it: semantic role, occlusion,
/// confidence, associations, and evidence.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePrimitiveProjection {
    /// Stable source-object identity.
    pub id: String,
    /// `surface` | `wall` | `ceiling` | `portal` | `conveyance`.
    pub role: String,
    pub level_id: String,
    /// `opaque` | `semi_transparent` | `transparent`.
    pub occlusion: String,
    pub confidence: SceneConfidenceProjection,
    /// The canonical venue feature this primitive represents, when one
    /// exists — `None` never impersonates a canonical object.
    pub canonical_feature_id: Option<String>,
    /// The source objects behind this primitive (resolved §8 locators).
    pub source_object_ids: Vec<String>,
    /// `neutral` | `source_evidenced` for conveyance primitives.
    pub conveyance_kind: Option<String>,
    pub evidence: Vec<SceneEvidenceProjection>,
}

/// Readiness, capability, and structured failure state — typed, not prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SceneCapabilityState {
    /// The scene is present, valid, and renderable.
    Ready,
    /// The bundle carries no scene source.
    Absent,
    /// The scene section is present but failed validation.
    Invalid { reason: String },
    UnsupportedVersion { declared: u16, supported: u16 },
    /// The scene requires §8, which is unavailable.
    DisabledByDependency { requires: u16 },
}

/// A pick result: the selected source object, its primitive, and the
/// canonical objects it maps to (feature, level, conveyance, graph) when
/// associations exist — plus the evidence behind the selection. An
/// unassociated source object stays inspectable but cannot impersonate a
/// canonical venue feature.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePickProjection {
    pub source_object_id: String,
    pub primitive_id: String,
    pub canonical_feature_id: Option<String>,
    pub canonical_level_id: Option<String>,
    /// The conveyance's canonical feature, when the picked primitive is a
    /// conveyance with an association.
    pub canonical_conveyance_id: Option<String>,
    /// A canonical graph object, when the scene carries associations to one
    /// (always `None` for the generated source until Stage 4).
    pub canonical_graph_object_id: Option<String>,
    pub evidence: Vec<SceneEvidenceProjection>,
}

/// The full typed scene projection: everything a renderer needs plus the
/// capability state, serializable to TypeScript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneProjection {
    pub identity: SceneSourceIdentity,
    /// `None` when the bundle carries no §8 spatial context (no frame).
    pub frame: Option<SceneFrameProjection>,
    pub levels: Vec<SceneLevelProjection>,
    pub primitives: Vec<ScenePrimitiveProjection>,
    pub capability: SceneCapabilityState,
}

impl SceneProjection {
    /// Pick the primitive whose source objects include `source_object_id`.
    pub fn pick(&self, source_object_id: &str) -> Option<ScenePickProjection> {
        let primitive = self
            .primitives
            .iter()
            .find(|p| p.source_object_ids.iter().any(|id| id == source_object_id))?;
        Some(ScenePickProjection {
            source_object_id: source_object_id.to_string(),
            primitive_id: primitive.id.clone(),
            canonical_feature_id: primitive.canonical_feature_id.clone(),
            canonical_level_id: Some(primitive.level_id.clone()),
            canonical_conveyance_id: if primitive.role == "conveyance" {
                primitive.canonical_feature_id.clone()
            } else {
                None
            },
            canonical_graph_object_id: None,
            evidence: primitive.evidence.clone(),
        })
    }
}

/// The renderer-neutral scene-source contract: every scene source exposes
/// the same typed projections, so a renderer adapts once and sources cannot
/// drift.
pub trait SceneSource {
    fn identity(&self) -> SceneSourceIdentity;
    fn frame(&self) -> Option<SceneFrameProjection>;
    fn levels(&self) -> Vec<SceneLevelProjection>;
    fn primitives(&self) -> Vec<ScenePrimitiveProjection>;
    fn capability(&self) -> SceneCapabilityState;
    fn pick(&self, source_object_id: &str) -> Option<ScenePickProjection>;
}

#[cfg(test)]
mod tests {
    use super::{
        SceneCapabilityState, SceneConfidenceProjection, SceneEvidenceProjection,
        SceneFrameProjection, ScenePickProjection, ScenePrimitiveProjection, SceneProjection,
        SceneSource, SceneSourceIdentity, SceneSourceKind,
    };

    fn primitive(id: &str, source_objects: Vec<&str>, canonical_feature: Option<&str>) -> ScenePrimitiveProjection {
        ScenePrimitiveProjection {
            id: id.to_string(),
            role: "surface".to_string(),
            level_id: "l1".to_string(),
            occlusion: "opaque".to_string(),
            confidence: SceneConfidenceProjection {
                kind: "measured".to_string(),
                value: 1.0,
            },
            canonical_feature_id: canonical_feature.map(str::to_string),
            source_object_ids: source_objects.into_iter().map(str::to_string).collect(),
            conveyance_kind: None,
            evidence: vec![SceneEvidenceProjection {
                method: "derivedFromVenueGeometry".to_string(),
                detail: "floor slab from level polygon".to_string(),
            }],
        }
    }

    fn projection() -> SceneProjection {
        SceneProjection {
            identity: SceneSourceIdentity {
                kind: SceneSourceKind::Generated,
                provenance: "compiled at publication from canonical venue geometry".to_string(),
            },
            frame: None,
            levels: Vec::new(),
            primitives: vec![
                primitive("p1", vec!["so-1"], Some("f1")),
                primitive("p2", vec!["so-2"], None),
            ],
            capability: SceneCapabilityState::Ready,
        }
    }

    #[test]
    fn the_projection_types_are_constructible() {
        let projection = projection();
        assert_eq!(projection.identity.kind, SceneSourceKind::Generated);
        assert_eq!(projection.capability, SceneCapabilityState::Ready);
        assert_eq!(projection.primitives.len(), 2);
        assert!(matches!(
            SceneCapabilityState::DisabledByDependency { requires: 8 },
            SceneCapabilityState::DisabledByDependency { requires: 8 }
        ));
    }

    #[test]
    fn pick_returns_the_associated_canonical_object_with_evidence() {
        let pick = projection().pick("so-1").expect("so-1 is a source object of p1");
        assert_eq!(pick.primitive_id, "p1");
        assert_eq!(pick.canonical_feature_id.as_deref(), Some("f1"));
        assert_eq!(pick.canonical_level_id.as_deref(), Some("l1"));
        assert_eq!(pick.evidence.len(), 1);
        assert_eq!(pick.evidence[0].detail, "floor slab from level polygon");
    }

    #[test]
    fn an_unassociated_source_object_cannot_impersonate_a_canonical_feature() {
        let pick = projection().pick("so-2").expect("so-2 is a source object of p2");
        assert_eq!(pick.canonical_feature_id, None, "no canonical feature is invented");
        assert_eq!(pick.canonical_conveyance_id, None);
        assert_eq!(pick.canonical_graph_object_id, None);
    }

    #[test]
    fn pick_returns_none_for_an_unknown_source_object() {
        assert!(projection().pick("no-such-object").is_none());
    }

    #[test]
    fn the_trait_is_implementable() {
        struct FakeSource;
        impl SceneSource for FakeSource {
            fn identity(&self) -> SceneSourceIdentity {
                SceneSourceIdentity {
                    kind: SceneSourceKind::Tiles,
                    provenance: "test".to_string(),
                }
            }
            fn frame(&self) -> Option<SceneFrameProjection> {
                None
            }
            fn levels(&self) -> Vec<super::SceneLevelProjection> {
                Vec::new()
            }
            fn primitives(&self) -> Vec<ScenePrimitiveProjection> {
                Vec::new()
            }
            fn capability(&self) -> SceneCapabilityState {
                SceneCapabilityState::Ready
            }
            fn pick(&self, _source_object_id: &str) -> Option<ScenePickProjection> {
                None
            }
        }
        let source = FakeSource;
        assert_eq!(source.identity().kind, SceneSourceKind::Tiles);
        assert_eq!(source.capability(), SceneCapabilityState::Ready);
    }
}
