//! GLB → merged semantic batches → `SceneDocument`.
//!
//! The deriver is deliberately dumb about identity: it groups source geometry
//! by `(level, semantic role)` and quantizes per group. Canonical object and
//! level association is issue #30's ingestion concern, not this pass.

use std::collections::HashMap;

use crate::format::{
    SceneBatch, SceneDocument, SceneFeature, SceneHeader, SceneLevel, SemanticRole,
};
use crate::glb::read_glb;
use crate::quantize::{encode_normal_oct, quantize_positions};
use crate::roles::{occlusion_for_role, role_for_category};
use crate::SceneError;

/// Deriver output plus the gate-1 measurement the CLI reports.
#[derive(Debug, Clone)]
pub struct DeriveReport {
    pub document: SceneDocument,
    /// Source primitives whose index buffer was not identity (`0..n-1`,
    /// `count == POSITION count`) and therefore had to be gathered into
    /// triangle-list order. Zero means the asset took the fast path end to end.
    pub gathered_primitives: usize,
}

/// Derive a scene document from a GLB and its `levels.json`.
pub fn derive_scene(
    glb: &[u8],
    levels_json: &[u8],
    source_hash: &str,
    world_transform: [f64; 16],
) -> Result<SceneDocument, SceneError> {
    Ok(derive_scene_with_report(glb, levels_json, source_hash, world_transform)?.document)
}

/// Like [`derive_scene`], but also reports how many primitives needed an index
/// gather. The CLI surfaces that number so gate 1 can judge the identity-index
/// fast path against real assets.
pub fn derive_scene_with_report(
    glb: &[u8],
    levels_json: &[u8],
    source_hash: &str,
    world_transform: [f64; 16],
) -> Result<DeriveReport, SceneError> {
    // 1. Read the GLB.
    let scene = read_glb(glb)?;

    // 2. Parse levels.json into level records. Tile surfaces are placement
    //    authority, so `resolved_plane_z` comes from `minZMeters`;
    //    `levelElevationMeters` is provenance only (issue #31).
    let levels_value: serde_json::Value = serde_json::from_slice(levels_json)?;
    let level_array = levels_value
        .get("levels")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| SceneError::Glb("levels.json has no levels array".into()))?;
    let mut levels: Vec<SceneLevel> = Vec::with_capacity(level_array.len());
    let mut level_by_key: HashMap<String, usize> = HashMap::with_capacity(level_array.len());
    for record in level_array {
        let key = record
            .get("levelKey")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        if level_by_key.contains_key(&key) {
            continue; // First declaration wins; later duplicates are noise.
        }
        let name = record
            .get("levelName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let elevation = record
            .get("levelElevationMeters")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0) as f32;
        let min_z = record
            .get("minZMeters")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0) as f32;
        let index = levels.len();
        level_by_key.insert(key.clone(), index);
        // levels.json carries no document/link identity; that arrives with the
        // canonical association (issue #30), so it stays empty here.
        levels.push(SceneLevel {
            canonical_id: String::new(),
            source_level_key: key,
            source_level_name: name,
            source_document: String::new(),
            source_link_name: String::new(),
            source_elevation_meters: elevation,
            resolved_plane_z: min_z,
            quantized_elevation_dm: (elevation * 10.0).round() as i32,
        });
    }

    // 3. Build feature rows in property-table order. Features whose level key
    //    is missing get a synthesized level appended so nothing is dropped.
    let mut features: Vec<SceneFeature> = Vec::with_capacity(scene.features.len());
    for row in &scene.features {
        let role = role_for_category(&row.category);
        let level_index = match level_by_key.get(&row.level_key) {
            Some(&index) => index,
            None => {
                let index = levels.len();
                level_by_key.insert(row.level_key.clone(), index);
                levels.push(SceneLevel {
                    canonical_id: format!("level-unmapped-{}", row.level_key),
                    source_level_key: row.level_key.clone(),
                    source_level_name: row.level_name.clone(),
                    source_document: row.source_document.clone(),
                    source_link_name: row.source_link_name.clone(),
                    source_elevation_meters: row.level_elevation_meters,
                    // No level record means no minZMeters; the feature's own
                    // surface min is the best placement evidence available.
                    resolved_plane_z: row.min_z,
                    quantized_elevation_dm: (row.level_elevation_meters * 10.0).round() as i32,
                });
                index
            }
        };

        // `levels.json` carries no document provenance, but issue #30's composite
        // level identity is `asset version + sourceDocument + sourceLinkName +
        // levelKey + quantized elevation`. Backfill those two fields from the
        // first feature that maps to the level, so mapped levels carry the same
        // identity the synthesized ones already do.
        if let Some(level) = levels.get_mut(level_index) {
            if level.source_document.is_empty() {
                level.source_document = row.source_document.clone();
            }
            if level.source_link_name.is_empty() {
                level.source_link_name = row.source_link_name.clone();
            }
        }
        features.push(SceneFeature {
            source_object_id: row.revit_unique_id.clone(),
            // Canonical association is issue #30's ingestion concern.
            canonical_id: None,
            level_index: level_index as u32,
            role,
            occlusion: occlusion_for_role(role),
            // Source-authored geometry: full confidence.
            confidence: 255,
            min_z: row.min_z,
            max_z: row.max_z,
        });
    }

    // 4. Group primitives by the (level, role) of their feature. The reader
    //    already resolved index buffers into triangle-list order, so the
    //    deriver concatenates. `SemanticRole` has no `Hash`, so the group key
    //    uses its rank in the role order table.
    let mut groups: HashMap<(u32, u8), Group> = HashMap::new();
    let mut gathered_primitives = 0usize;
    let mut bounds_min = [f32::INFINITY; 3];
    let mut bounds_max = [f32::NEG_INFINITY; 3];
    for primitive in &scene.primitives {
        let feature_index = primitive.feature_id as usize;
        let feature = features.get(feature_index).ok_or_else(|| {
            SceneError::Glb(format!(
                "primitive feature id {feature_index} out of range ({} features)",
                features.len()
            ))
        })?;
        let group = groups.entry((feature.level_index, role_rank(feature.role))).or_default();
        group.positions.extend_from_slice(&primitive.positions);
        group.normals.extend_from_slice(&primitive.normals);
        group
            .feature_indices
            .extend(std::iter::repeat_n(primitive.feature_id, primitive.positions.len()));
        if !primitive.indices_were_identity {
            gathered_primitives += 1;
        }
        for position in &primitive.positions {
            for axis in 0..3 {
                bounds_min[axis] = bounds_min[axis].min(position[axis]);
                bounds_max[axis] = bounds_max[axis].max(position[axis]);
            }
        }
    }
    if scene.primitives.is_empty() {
        bounds_min = [0.0; 3];
        bounds_max = [0.0; 3];
    }

    // 5. Per group: quantize positions, oct-encode normals, emit one batch.
    //    Batches come out in deterministic (level, role-rank) order.
    let mut group_order: Vec<((u32, u8), Group)> = groups.into_iter().collect();
    group_order.sort_by_key(|((level_index, rank), _)| (*level_index, *rank));
    let mut batches = Vec::with_capacity(group_order.len());
    for ((level_index, rank), group) in group_order {
        let (quantized, origin, scale) = quantize_positions(&group.positions);
        batches.push(SceneBatch {
            level_index,
            role: ROLE_ORDER[rank as usize],
            quantization_origin: origin,
            quantization_scale: scale,
            vertex_count: group.positions.len() as u32,
            positions: quantized,
            normals: group.normals.iter().map(|normal| encode_normal_oct(*normal)).collect(),
            feature_indices: group.feature_indices,
        });
    }

    // 6. Header: frame origin is the last column of the tileset transform.
    let document = SceneDocument {
        header: SceneHeader {
            format_version: 1,
            deriver_version: 1,
            source_hash: source_hash.to_string(),
            frame_origin_ecef: [
                world_transform[12],
                world_transform[13],
                world_transform[14],
            ],
            world_transform,
            bounds_min,
            bounds_max,
        },
        levels,
        features,
        batches,
    };

    // 7. Return the document plus the gate measurement.
    Ok(DeriveReport { document, gathered_primitives })
}

/// One accumulating group of concatenated triangle-list geometry.
#[derive(Default)]
struct Group {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    feature_indices: Vec<u32>,
}

/// Stable rank for every role, mirroring the declaration order in `format.rs`
/// and giving `SemanticRole` a `Hash`-free ordering for grouping and sorting.
const ROLE_ORDER: [SemanticRole; 12] = [
    SemanticRole::Walkable,
    SemanticRole::Public,
    SemanticRole::Service,
    SemanticRole::Restricted,
    SemanticRole::Structure,
    SemanticRole::Ceiling,
    SemanticRole::Opening,
    SemanticRole::Elevator,
    SemanticRole::Escalator,
    SemanticRole::Stairs,
    SemanticRole::Ramp,
    SemanticRole::Context,
];

fn role_rank(role: SemanticRole) -> u8 {
    ROLE_ORDER.iter().position(|&candidate| candidate == role).unwrap_or(11) as u8
}
