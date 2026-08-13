//! Kiriko scene format: one GPU-ready batch layout that both scene sources
//! compile to (design: docs/superpowers/specs/2026-08-03-3d-rendering-architecture-design.md).

mod derive;
mod floor_label;
mod format;
mod generated;
mod glb;
mod package;
mod quantize;
mod registration;
mod roles;
pub use derive::{
    DeriveReport, PackageIdentity, PackageScene, VenueFrame, derive_package_scene, derive_scene,
    derive_scene_with_report,
};
pub use format::{
    OcclusionClass, SCENE_MAGIC, SceneBatch, SceneDocument, SceneFeature, SceneHeader, SceneLevel,
    SemanticRole, decode_scene, encode_scene,
};
pub use generated::compile_generated_scene;
pub use glb::{GlbFeatureRow, GlbPrimitive, GlbScene, read_glb};
pub use package::{
    TileMember, TileMemberKind, TilePackageError, TilePackageReport, validate_tile_package,
};
pub use quantize::{decode_normal_oct, encode_normal_oct, quantize_positions};
pub use registration::{
    ActivationEvaluation, ActivationInput, CoherentCluster, FloorRegistration, FrameTransform,
    GateCode, GateFailure, LabelAgreement, RegistrationProfile, RegistrationReport, ResidualStats,
    TileLevel, VenueFloor, composite_level_id, evaluate_activation, measure_registration,
    resolve_tile_levels,
};
pub use roles::{occlusion_for_role, role_for_category};

#[derive(Debug, thiserror::Error)]
pub enum SceneError {
    #[error("scene container magic missing or unrecognized")]
    Magic,
    #[error("postcard codec failure: {0}")]
    Postcard(#[from] postcard::Error),
    #[error("io failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("glb: {0}")]
    Glb(String),
    #[error("levels.json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("primitive {primitive} names level {level}, which the spatial context does not carry")]
    UnplaceablePrimitive { primitive: String, level: String },
}
