//! Kiriko scene format: one GPU-ready batch layout that both scene sources
//! compile to (design: docs/superpowers/specs/2026-08-03-3d-rendering-architecture-design.md).

mod format;
mod glb;
mod quantize;

pub use format::{
    decode_scene, encode_scene, OcclusionClass, SceneBatch, SceneDocument, SceneFeature,
    SceneHeader, SceneLevel, SemanticRole, SCENE_MAGIC,
};
pub use glb::{read_glb, GlbFeatureRow, GlbPrimitive, GlbScene};
pub use quantize::{decode_normal_oct, encode_normal_oct, quantize_positions};

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
}
