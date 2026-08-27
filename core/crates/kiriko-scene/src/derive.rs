//! GLB → merged semantic batches → `SceneDocument`.
//!
//! The deriver is deliberately dumb about identity: it groups source geometry
//! by `(level, semantic role)` and quantizes per group. Canonical object and
//! level association is issue #30's ingestion concern, not this pass.

use std::collections::{BTreeMap, HashMap};

use crate::SceneError;
use crate::format::{
    OcclusionClass, SceneBatch, SceneDocument, SceneFeature, SceneHeader, SceneLevel, SemanticRole,
};
use crate::glb::{GlbPrimitive, GlbScene, read_glb};
use crate::quantize::{encode_normal_oct, quantize_positions};
use crate::registration::{FrameTransform, TileLevel};
use crate::roles::{occlusion_for_role, role_for_category};

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
            source_elevation_meters: Some(elevation),
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
                    source_elevation_meters: Some(row.level_elevation_meters),
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
        let group = groups
            .entry((feature.level_index, role_rank(feature.role)))
            .or_default();
        group.positions.extend_from_slice(&primitive.positions);
        group.normals.extend_from_slice(&primitive.normals);
        group.feature_indices.extend(std::iter::repeat_n(
            primitive.feature_id,
            primitive.positions.len(),
        ));
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
            normals: group
                .normals
                .iter()
                .map(|normal| encode_normal_oct(*normal))
                .collect(),
            feature_indices: group.feature_indices,
            colors: None,
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
    Ok(DeriveReport {
        document,
        gathered_primitives,
    })
}

/// A package's derived document plus what derivation could not resolve.
#[derive(Debug, Clone)]
pub struct PackageScene {
    pub document: SceneDocument,
    /// Composite levels no floor mapping claimed. Activation refuses a package
    /// with any of these unless its content is classified context (#74), so a
    /// non-empty list here is either context or a caller that skipped the gate.
    pub unmapped_levels: Vec<String>,
}

/// The venue-local frame a derived document is expressed in: §8's ENU frame.
///
/// Separate from the tile-to-venue placement transform on purpose. Placement is
/// how a package's own coordinates reach this frame; the frame is what the
/// renderer uses to put the scene on the globe, and both sources must state the
/// same one or they would draw in different places.
#[derive(Debug, Clone, PartialEq)]
pub struct VenueFrame {
    pub ecef_origin: [f64; 3],
    /// East, north, up as ECEF unit vectors.
    pub enu_basis_ecef: [[f64; 3]; 3],
}

impl VenueFrame {
    /// Column-major 4x4: the ENU basis as columns, the ECEF origin last —
    /// `p_ecef = origin + basis · p_local`.
    #[must_use]
    pub fn world_transform(&self) -> [f64; 16] {
        let b = self.enu_basis_ecef;
        let t = self.ecef_origin;
        [
            b[0][0], b[0][1], b[0][2], 0.0, //
            b[1][0], b[1][1], b[1][2], 0.0, //
            b[2][0], b[2][1], b[2][2], 0.0, //
            t[0], t[1], t[2], 1.0,
        ]
    }
}

/// What the activation decided about a package's identity: which canonical
/// floor each composite level renders as, which canonical feature each source
/// object represents, and what a producer classified as context.
///
/// Grouped because they arrive together, from one activation's descriptor, and
/// separating them at a call site would let a document be derived from one
/// activation's mappings and another's associations.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PackageIdentity {
    /// Composite level identity → canonical floor id.
    pub floor_mappings: BTreeMap<String, String>,
    /// Source object id → canonical venue feature id.
    pub associations: BTreeMap<String, String>,
    /// Source object id → the producer's occlusion policy for it.
    pub contextual: BTreeMap<String, OcclusionClass>,
}

/// Derive the render document for an activated tile package.
///
/// Produces the *same* KSC1 the generated source compiles to — that is what
/// lets one renderer, one picking path, and one visual language serve both
/// sources. What only a package can supply is identity: each composite level
/// carries the canonical floor it was registered to, each source object carries
/// the canonical feature it was associated with, and producer-classified
/// context carries the occlusion policy the producer chose rather than the one
/// its Revit category implies.
///
/// `levels` comes from [`resolve_tile_levels`](crate::resolve_tile_levels) —
/// the same pass registration measured — so the renderer cannot draw floors the
/// activation gates never judged.
///
/// # Errors
///
/// Returns [`SceneError::Glb`] when a primitive's feature id falls outside its
/// member's feature table.
pub fn derive_package_scene(
    scenes: &[GlbScene],
    levels: &[TileLevel],
    placement: &FrameTransform,
    frame: &VenueFrame,
    source_hash: &str,
    identity: &PackageIdentity,
) -> Result<PackageScene, SceneError> {
    // Keyed on the composite identity minus its asset-version component, which
    // is constant within one package.
    let mut level_index_of: HashMap<(&str, &str, &str, i32), u32> =
        HashMap::with_capacity(levels.len());
    let mut unmapped_levels: Vec<String> = Vec::new();
    let scene_levels: Vec<SceneLevel> = levels
        .iter()
        .enumerate()
        .map(|(index, level)| {
            level_index_of.insert(
                (
                    level.source_document.as_str(),
                    level.source_link_name.as_str(),
                    level.level_key.as_str(),
                    level.quantized_elevation_dm,
                ),
                index as u32,
            );
            let canonical_id = identity.floor_mappings.get(&level.composite_id).cloned();
            if canonical_id.is_none() {
                unmapped_levels.push(level.composite_id.clone());
            }
            SceneLevel {
                // Empty rather than borrowed: a level no floor claimed must not
                // answer a floor filter for one.
                canonical_id: canonical_id.unwrap_or_default(),
                source_level_key: level.level_key.clone(),
                source_level_name: level.level_name.clone(),
                source_document: level.source_document.clone(),
                source_link_name: level.source_link_name.clone(),
                source_elevation_meters: Some(level.metadata_elevation_m as f32),
                // The mesh is placement authority (#31); the metadata above is
                // provenance sitting beside it.
                resolved_plane_z: level.resolved_plane_m.unwrap_or(0.0) as f32,
                quantized_elevation_dm: level.quantized_elevation_dm,
            }
        })
        .collect();

    // Features in member order, each remembering which member it came from:
    // feature ids are member-local, so a primitive resolves against its own
    // member's slice of the feature list.
    let mut features: Vec<SceneFeature> = Vec::new();
    let mut feature_base: Vec<usize> = Vec::with_capacity(scenes.len());
    for scene in scenes {
        feature_base.push(features.len());
        for row in &scene.features {
            // Matched on the composite identity minus its asset-version
            // component, which is constant within one package: recomputing the
            // full string here would mean two places spelling identity, and
            // that is how they stop agreeing.
            let level_identity = (
                row.source_document.as_str(),
                row.source_link_name.as_str(),
                row.level_key.as_str(),
                (f64::from(row.level_elevation_meters) * 10.0).round() as i32,
            );
            let role = role_for_category(&row.category);
            features.push(SceneFeature {
                source_object_id: row.revit_unique_id.clone(),
                canonical_id: identity.associations.get(&row.revit_unique_id).cloned(),
                level_index: level_index_of.get(&level_identity).copied().unwrap_or(0),
                role,
                occlusion: identity
                    .contextual
                    .get(&row.revit_unique_id)
                    .copied()
                    .unwrap_or_else(|| occlusion_for_role(role)),
                // Source-authored geometry: full confidence.
                confidence: 255,
                min_z: row.min_z,
                max_z: row.max_z,
            });
        }
    }

    let geometry = batch_geometry(scenes, &feature_base, &features, placement)?;

    Ok(PackageScene {
        document: SceneDocument {
            header: SceneHeader {
                format_version: 1,
                deriver_version: 1,
                source_hash: source_hash.to_string(),
                // The venue's own frame, identical to what the generated
                // source emits. Geometry is already placed into it above, so
                // the renderer positions both sources with one matrix and never
                // learns which one it is drawing.
                frame_origin_ecef: frame.ecef_origin,
                world_transform: frame.world_transform(),
                bounds_min: geometry.bounds_min,
                bounds_max: geometry.bounds_max,
            },
            levels: scene_levels,
            features,
            batches: geometry.batches,
        },
        unmapped_levels,
    })
}

/// Batched geometry and the bounds it spans, venue-local metres.
struct BatchedGeometry {
    batches: Vec<SceneBatch>,
    bounds_min: [f32; 3],
    bounds_max: [f32; 3],
}

/// Group every member's geometry by `(level, role)`, quantize per group, and
/// measure the scene's bounds — the shared tail of both derivation paths.
fn batch_geometry(
    scenes: &[GlbScene],
    feature_base: &[usize],
    features: &[SceneFeature],
    transform: &FrameTransform,
) -> Result<BatchedGeometry, SceneError> {
    let mut groups: HashMap<(u32, u8), Group> = HashMap::new();
    let mut bounds_min = [f32::INFINITY; 3];
    let mut bounds_max = [f32::NEG_INFINITY; 3];
    let mut any = false;

    for (member, scene) in scenes.iter().enumerate() {
        let base = feature_base.get(member).copied().unwrap_or(0);
        for primitive in &scene.primitives {
            let index = base + primitive.feature_id as usize;
            let feature = features.get(index).ok_or_else(|| {
                SceneError::Glb(format!(
                    "primitive feature id {} out of range in member {member}",
                    primitive.feature_id
                ))
            })?;
            let group = groups
                .entry((feature.level_index, role_rank(feature.role)))
                .or_default();
            // Positions arrive in the venue-local frame: the renderer places the
            // scene with the header transform, and a package that kept tile
            // coordinates would need the renderer to know which source it is
            // drawing.
            for position in &primitive.positions {
                let placed = transform.apply(*position);
                let placed = [placed[0] as f32, placed[1] as f32, placed[2] as f32];
                group.positions.push(placed);
                for axis in 0..3 {
                    bounds_min[axis] = bounds_min[axis].min(placed[axis]);
                    bounds_max[axis] = bounds_max[axis].max(placed[axis]);
                }
                any = true;
            }
            group.normals.extend(rotated_normals(primitive, transform));
            group
                .feature_indices
                .extend(std::iter::repeat_n(index as u32, primitive.positions.len()));
        }
    }
    if !any {
        bounds_min = [0.0; 3];
        bounds_max = [0.0; 3];
    }

    let mut group_order: Vec<((u32, u8), Group)> = groups.into_iter().collect();
    group_order.sort_by_key(|((level_index, rank), _)| (*level_index, *rank));
    let batches = group_order
        .into_iter()
        .map(|((level_index, rank), group)| {
            let (quantized, origin, scale) = quantize_positions(&group.positions);
            SceneBatch {
                level_index,
                role: ROLE_ORDER[rank as usize],
                quantization_origin: origin,
                quantization_scale: scale,
                vertex_count: group.positions.len() as u32,
                positions: quantized,
                normals: group
                    .normals
                    .iter()
                    .map(|normal| encode_normal_oct(*normal))
                    .collect(),
                feature_indices: group.feature_indices,
                colors: None,
            }
        })
        .collect();
    Ok(BatchedGeometry {
        batches,
        bounds_min,
        bounds_max,
    })
}

/// Normals rotated into the venue frame. The transform's basis is orthonormal
/// (an ENU basis composed with an axis swap), so rotating is enough — no
/// inverse-transpose, and no renormalisation to pay for.
fn rotated_normals(primitive: &GlbPrimitive, transform: &FrameTransform) -> Vec<[f32; 3]> {
    let m = transform.matrix();
    primitive
        .normals
        .iter()
        .map(|normal| {
            let (x, y, z) = (
                f64::from(normal[0]),
                f64::from(normal[1]),
                f64::from(normal[2]),
            );
            [
                (m[0] * x + m[4] * y + m[8] * z) as f32,
                (m[1] * x + m[5] * y + m[9] * z) as f32,
                (m[2] * x + m[6] * y + m[10] * z) as f32,
            ]
        })
        .collect()
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
    ROLE_ORDER
        .iter()
        .position(|&candidate| candidate == role)
        .unwrap_or(11) as u8
}
