use serde::{Deserialize, Serialize};

use crate::SceneError;

/// Container magic for the current byte layout. Bumped whenever the postcard
/// layout changes incompatibly: postcard is positional, so a reader cannot
/// recover from a field it does not expect. `KSC2` added
/// [`SceneBatch::colors`].
pub const SCENE_MAGIC: &[u8; 4] = b"KSC2";

/// The layout before [`SceneBatch::colors`]. Read-only: documents derived
/// once at activation are served immutably, so previously activated packages
/// keep these bytes forever and must keep decoding.
const SCENE_MAGIC_V1: &[u8; 4] = b"KSC1";

/// Semantic roles from the renderer-neutral visual language (issue #32). The
/// renderer styles these; it never sees a source material. `Conveyance` is
/// the honest form for a conveyance whose transport type is not evidenced —
/// the never-guess rule (issue #19) forbids promoting it to a typed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SemanticRole {
    Walkable,
    Public,
    Service,
    Restricted,
    Structure,
    Ceiling,
    Opening,
    Elevator,
    Escalator,
    Stairs,
    Ramp,
    Context,
    Conveyance,
    /// A ticket-gate row — the illustrative form for a fare-gate fixture.
    TicketGate,
}

/// Whether an object may occlude the route, selection, or a priority label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OcclusionClass {
    Never,
    ProtectedCorridor,
    Context,
}

/// Immutable scene identity plus the venue-local metric frame (issue #19).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneHeader {
    pub format_version: u16,
    pub deriver_version: u16,
    pub source_hash: String,
    /// ECEF translation of the venue-local frame origin, double precision.
    pub frame_origin_ecef: [f64; 3],
    /// Column-major 4x4 tileset transform, retained unchanged (issue #31).
    pub world_transform: [f64; 16],
    pub bounds_min: [f32; 3],
    pub bounds_max: [f32; 3],
}

/// One canonical level and the composite source identity issue #30 requires.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneLevel {
    pub canonical_id: String,
    pub source_level_key: String,
    pub source_level_name: String,
    pub source_document: String,
    pub source_link_name: String,
    /// Source elevation retained as provenance, never placement authority.
    /// `None` when the source carries no elevation for this level — the
    /// generated source never fabricates one for a nominally spaced floor.
    pub source_elevation_meters: Option<f32>,
    /// Plane resolved from tile surfaces (issue #31).
    pub resolved_plane_z: f32,
    /// Elevation quantized to decimetres, part of the composite identity.
    pub quantized_elevation_dm: i32,
}

/// One pickable source object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneFeature {
    pub source_object_id: String,
    pub canonical_id: Option<String>,
    pub level_index: u32,
    pub role: SemanticRole,
    pub occlusion: OcclusionClass,
    /// 0-255 confidence; 255 = source-authored certainty.
    pub confidence: u8,
    pub min_z: f32,
    pub max_z: f32,
}

/// Merged geometry for one `(level, role)` pair. Vertices are triangle-list
/// order; no index buffer, because the source indexes 1:1 with vertices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneBatch {
    pub level_index: u32,
    pub role: SemanticRole,
    pub quantization_origin: [f32; 3],
    pub quantization_scale: [f32; 3],
    pub vertex_count: u32,
    pub positions: Vec<[u16; 3]>,
    pub normals: Vec<[i16; 2]>,
    pub feature_indices: Vec<u32>,
    /// Triangle-list RGB, same length as `vertex_count`. `None` uses the
    /// renderer's `ROLE_COLORS[role]`.
    #[serde(default)]
    pub colors: Option<Vec<[u8; 3]>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneDocument {
    pub header: SceneHeader,
    pub levels: Vec<SceneLevel>,
    pub features: Vec<SceneFeature>,
    pub batches: Vec<SceneBatch>,
}

/// [`SCENE_MAGIC`] followed by zstd-compressed postcard.
pub fn encode_scene(document: &SceneDocument) -> Result<Vec<u8>, SceneError> {
    let raw = postcard::to_allocvec(document)?;
    let compressed = zstd::encode_all(raw.as_slice(), 19)?;
    let mut out = Vec::with_capacity(compressed.len() + 4);
    out.extend_from_slice(SCENE_MAGIC);
    out.extend_from_slice(&compressed);
    Ok(out)
}

/// Decode either container version. A `KSC1` document is read through the
/// pre-`colors` layout and reports `colors: None` — the same absence a fresh
/// deriver emits — rather than failing on the byte it never encoded.
pub fn decode_scene(bytes: &[u8]) -> Result<SceneDocument, SceneError> {
    if let Some(body) = bytes.strip_prefix(SCENE_MAGIC) {
        return Ok(postcard::from_bytes(&zstd::decode_all(body)?)?);
    }
    let Some(body) = bytes.strip_prefix(SCENE_MAGIC_V1) else {
        return Err(SceneError::Magic);
    };
    let legacy: v1::SceneDocumentV1 = postcard::from_bytes(&zstd::decode_all(body)?)?;
    Ok(legacy.into())
}

/// The `KSC1` layout. Identical to the current document except that a batch
/// carries no per-vertex colours, so it needs its own positional mirror of
/// [`SceneBatch`]. Deserialize-only: nothing writes `KSC1` any more.
mod v1 {
    use serde::Deserialize;

    use super::{SceneBatch, SceneDocument, SceneFeature, SceneHeader, SceneLevel, SemanticRole};

    #[derive(Deserialize)]
    pub(super) struct SceneDocumentV1 {
        header: SceneHeader,
        levels: Vec<SceneLevel>,
        features: Vec<SceneFeature>,
        batches: Vec<SceneBatchV1>,
    }

    #[derive(Deserialize)]
    struct SceneBatchV1 {
        level_index: u32,
        role: SemanticRole,
        quantization_origin: [f32; 3],
        quantization_scale: [f32; 3],
        vertex_count: u32,
        positions: Vec<[u16; 3]>,
        normals: Vec<[i16; 2]>,
        feature_indices: Vec<u32>,
    }

    impl From<SceneDocumentV1> for SceneDocument {
        fn from(document: SceneDocumentV1) -> Self {
            Self {
                header: document.header,
                levels: document.levels,
                features: document.features,
                batches: document.batches.into_iter().map(SceneBatch::from).collect(),
            }
        }
    }

    impl From<SceneBatchV1> for SceneBatch {
        fn from(batch: SceneBatchV1) -> Self {
            Self {
                level_index: batch.level_index,
                role: batch.role,
                quantization_origin: batch.quantization_origin,
                quantization_scale: batch.quantization_scale,
                vertex_count: batch.vertex_count,
                positions: batch.positions,
                normals: batch.normals,
                feature_indices: batch.feature_indices,
                colors: None,
            }
        }
    }
}
