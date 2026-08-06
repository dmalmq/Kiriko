//! The Generated scene producer: a bundle's §9 semantic primitives plus §8
//! spatial context compiled into the KSC1 render document the Tiles deriver
//! also emits. One render format means one renderer, so a source can never
//! fork the visual language (issue #23, decision D4).
//!
//! What this module does *not* do is as load-bearing as what it does. It
//! resolves no elevation (§8 already did, with recorded method and
//! confidence), interprets no source property, and guesses no transport type:
//! a conveyance whose canonical unit is unknown compiles to
//! [`SemanticRole::Conveyance`], never to an escalator that looks authored.
//! Provenance beyond what the renderer draws stays in the semantic projection
//! (issue #53), which is the authority the UI reads.

use std::collections::BTreeMap;

use kiriko_model::model::{FeatureType, VenueFeature};
use kiriko_model::scene::{Mesh, PrimitiveGeometry, PrimitiveRole, ScenePrimitive, SceneSection};
use kiriko_model::spatial::SpatialContext;
use sha2::{Digest, Sha256};

use crate::SceneError;
use crate::format::{
    SceneBatch, SceneDocument, SceneFeature, SceneHeader, SceneLevel, SemanticRole,
};
use crate::quantize::{encode_normal_oct, quantize_positions};
use crate::roles::occlusion_for_role;

/// Bumped when this producer's output changes for unchanged input.
const GENERATED_PRODUCER_VERSION: u16 = 1;

/// The render format this producer writes.
const SCENE_FORMAT_VERSION: u16 = 1;

const MM_PER_M: f32 = 1_000.0;

/// One primitive's triangle-list geometry in venue-local metres, plus the
/// vertical extent the pick pass and floor filtering read.
struct Triangles {
    /// Triangle-list vertices; every three form one facet.
    vertices: Vec<[f32; 3]>,
    /// Per-vertex normal, flat across each facet.
    normals: Vec<[f32; 3]>,
    min_z: f32,
    max_z: f32,
}

/// Compile a bundle's §9 scene into the shared render document.
///
/// `features` supplies the canonical venue features whose IMDF categories
/// refine a primitive's semantic role; a primitive with no canonical feature
/// keeps the role its §9 class alone can justify.
///
/// # Errors
///
/// Returns [`SceneError::UnplaceablePrimitive`] when a primitive names a level
/// the spatial context does not carry: a scene Kiriko cannot place is not
/// renderable, and silently dropping the geometry would hide a real defect.
pub fn compile_generated_scene(
    scene: &SceneSection,
    spatial: &SpatialContext,
    features: &[VenueFeature],
) -> Result<SceneDocument, SceneError> {
    let levels = compile_levels(spatial);
    let level_indices: BTreeMap<&str, u32> = spatial
        .levels
        .iter()
        .enumerate()
        .map(|(index, record)| (record.level_id.as_str(), index as u32))
        .collect();
    let categories: BTreeMap<&str, (FeatureType, Option<&str>)> = features
        .iter()
        .map(|feature| {
            (
                feature.id.as_str(),
                (feature.feature_type, feature.category.as_deref()),
            )
        })
        .collect();

    // Geometry accumulates per (level, role) so a visible floor draws in a
    // handful of calls rather than once per primitive.
    let mut batched: BTreeMap<(u32, u8), BatchAccumulator> = BTreeMap::new();
    let mut scene_features: Vec<SceneFeature> = Vec::with_capacity(scene.primitives.len());
    let mut bounds_min = [f32::INFINITY; 3];
    let mut bounds_max = [f32::NEG_INFINITY; 3];

    for primitive in &scene.primitives {
        let level_index = *level_indices
            .get(primitive.level_id.as_str())
            .ok_or_else(|| SceneError::UnplaceablePrimitive {
                primitive: primitive.id.clone(),
                level: primitive.level_id.clone(),
            })?;

        let role = semantic_role(primitive, &categories);
        let triangles = triangulate(mesh_of(primitive));
        let feature_index = scene_features.len() as u32;

        scene_features.push(SceneFeature {
            source_object_id: primitive.id.clone(),
            canonical_id: primitive.canonical_feature_id.clone(),
            level_index,
            role,
            occlusion: occlusion_for_role(role),
            confidence: confidence_byte(spatial, primitive.confidence_ref),
            min_z: triangles.min_z,
            max_z: triangles.max_z,
        });

        for vertex in &triangles.vertices {
            for axis in 0..3 {
                bounds_min[axis] = bounds_min[axis].min(vertex[axis]);
                bounds_max[axis] = bounds_max[axis].max(vertex[axis]);
            }
        }

        let accumulator = batched
            .entry((level_index, role_key(role)))
            .or_insert_with(|| BatchAccumulator::new(role));
        accumulator.push(&triangles, feature_index);
    }

    if scene_features.is_empty() {
        bounds_min = [0.0; 3];
        bounds_max = [0.0; 3];
    }

    let batches: Vec<SceneBatch> = batched
        .into_iter()
        .map(|((level_index, _), accumulator)| accumulator.finish(level_index))
        .collect();

    let header = SceneHeader {
        format_version: SCENE_FORMAT_VERSION,
        deriver_version: GENERATED_PRODUCER_VERSION,
        source_hash: source_hash(scene, spatial),
        frame_origin_ecef: spatial.frame.ecef_origin,
        world_transform: world_transform(spatial),
        bounds_min,
        bounds_max,
    };

    Ok(SceneDocument {
        header,
        levels,
        features: scene_features,
        batches,
    })
}

/// §8's resolved planes, in the order §8 records them — that order is this
/// document's level index space.
fn compile_levels(spatial: &SpatialContext) -> Vec<SceneLevel> {
    spatial
        .levels
        .iter()
        .map(|record| SceneLevel {
            canonical_id: record.level_id.clone(),
            // The generated source has no composite source level: it is
            // compiled from the venue's own features, so there is no source
            // document, layer, or level key to carry. §8's resolution method
            // and evidence are the provenance, read through issue #53's
            // projection.
            source_level_key: String::new(),
            source_level_name: String::new(),
            source_document: String::new(),
            source_link_name: String::new(),
            source_elevation_meters: record.source_elevation_m.map(|metres| metres as f32),
            resolved_plane_z: record.resolved_scene_z_mm as f32 / MM_PER_M,
            quantized_elevation_dm: (record.resolved_scene_z_mm / 100) as i32,
        })
        .collect()
}

/// The §9 geometry a primitive contributes to the scene. A portal renders its
/// opening; the topology pair it also carries is a relation, not geometry.
fn mesh_of(primitive: &ScenePrimitive) -> &Mesh {
    match &primitive.geometry {
        PrimitiveGeometry::Mesh(mesh) => mesh,
        PrimitiveGeometry::Portal { opening, .. } => opening,
        PrimitiveGeometry::Conveyance { mesh, .. } => mesh,
    }
}

/// A primitive's semantic role: its §9 class, refined by the canonical
/// feature's IMDF category when one is associated.
fn semantic_role(
    primitive: &ScenePrimitive,
    categories: &BTreeMap<&str, (FeatureType, Option<&str>)>,
) -> SemanticRole {
    let canonical = primitive
        .canonical_feature_id
        .as_deref()
        .and_then(|id| categories.get(id))
        .copied();

    match primitive.role {
        PrimitiveRole::Wall => SemanticRole::Structure,
        PrimitiveRole::Ceiling => SemanticRole::Ceiling,
        PrimitiveRole::Portal => SemanticRole::Opening,
        PrimitiveRole::Conveyance => match canonical.and_then(|(_, category)| category) {
            // Only a conveyance category the source actually states may type
            // the form; anything else stays an untyped conveyance.
            Some(category) => conveyance_role(category).unwrap_or(SemanticRole::Conveyance),
            None => SemanticRole::Conveyance,
        },
        PrimitiveRole::Surface => match canonical {
            // A level slab is the whole floor's plate: contextual mass, not a
            // claim that every square metre of it is navigable. It is also
            // coplanar with the unit finishes that sit on it, and the renderer
            // resolves that by drawing contextual mass first and biased back —
            // so the plate must not share a role with the finishes.
            Some((FeatureType::Level, _)) => SemanticRole::Context,
            Some((_, Some(category))) => surface_role(category),
            // A surface with no category to read is contextual mass; it never
            // becomes navigable by default.
            Some((_, None)) | None => SemanticRole::Context,
        },
    }
}

/// IMDF unit categories that name a conveyance's transport type.
fn conveyance_role(category: &str) -> Option<SemanticRole> {
    match category {
        "elevator" => Some(SemanticRole::Elevator),
        "escalator" => Some(SemanticRole::Escalator),
        "stairs" | "steps" => Some(SemanticRole::Stairs),
        "ramp" | "movingwalkway" => Some(SemanticRole::Ramp),
        _ => None,
    }
}

/// Map an IMDF unit category onto a surface role. The IMDF category vocabulary
/// is closed, so this matches exact values rather than guessing at substrings;
/// an unlisted category is public floor rather than navigable walkway.
fn surface_role(category: &str) -> SemanticRole {
    if let Some(role) = conveyance_role(category) {
        return role;
    }
    match category {
        // Circulation: the surfaces a route may traverse.
        "walkway" | "pedestrian" | "concourse" | "corridor" | "lobby" | "plaza" | "footbridge"
        | "parkingcirculation" | "platform" | "walkwayisland" => SemanticRole::Walkable,
        // Public occupiable space.
        "room" | "shop" | "restaurant" | "restroom" | "restroom.female" | "restroom.male"
        | "restroom.unisex" | "restroom.family" | "waitingroom" | "auditorium" | "classroom"
        | "library" | "lounge" | "recreation" | "terrace" | "vegetation" | "exhibit"
        | "fieldofplay" | "foodservice" | "conferenceroom" | "privatelounge" => {
            SemanticRole::Public
        }
        // Building operations.
        "office" | "mechanicalroom" | "electricalroom" | "serverroom" | "storage" | "structure"
        | "utilityroom" | "serviceyard" | "loadingdock" | "phoneroom" | "smokingarea"
        | "laboratory" | "kitchen" => SemanticRole::Service,
        // Access-controlled space.
        "nonpublic" | "restricted" | "unenclosedarea" | "road" | "parking" | "driveway" => {
            SemanticRole::Restricted
        }
        _ => SemanticRole::Public,
    }
}

/// §8's registered confidence as the render document's byte scale. A missing
/// registry entry reads as no confidence rather than as certainty.
fn confidence_byte(spatial: &SpatialContext, confidence_ref: u32) -> u8 {
    let value = spatial
        .registries
        .confidence
        .get(confidence_ref as usize)
        .map_or(0.0, |confidence| confidence.value);
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Column-major 4x4 world transform: the ENU basis vectors as columns, the
/// frame's ECEF translation last — `p_ecef = translation + basis · p_local`.
fn world_transform(spatial: &SpatialContext) -> [f64; 16] {
    let basis = spatial.frame.enu_basis_ecef;
    let translation = spatial.frame.world_translation;
    [
        basis[0][0],
        basis[0][1],
        basis[0][2],
        0.0,
        basis[1][0],
        basis[1][1],
        basis[1][2],
        0.0,
        basis[2][0],
        basis[2][1],
        basis[2][2],
        0.0,
        translation[0],
        translation[1],
        translation[2],
        1.0,
    ]
}

/// A deterministic identity for the compiled input: the frame anchor plus
/// every primitive's identity, class, level, and vertex count. Two bundles
/// whose §9 content differs anywhere hash differently; the same bundle always
/// hashes the same, so the value is usable as a cache key.
fn source_hash(scene: &SceneSection, spatial: &SpatialContext) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kiriko-generated-scene\0");
    digest.update(GENERATED_PRODUCER_VERSION.to_le_bytes());
    for component in spatial.frame.ecef_origin {
        digest.update(component.to_le_bytes());
    }
    digest.update(spatial.frame.vertical_normalisation_offset_mm.to_le_bytes());
    for record in &spatial.levels {
        digest.update(record.level_id.as_bytes());
        digest.update(b"\0");
        digest.update(record.resolved_scene_z_mm.to_le_bytes());
    }
    for primitive in &scene.primitives {
        digest.update(primitive.id.as_bytes());
        digest.update(b"\0");
        digest.update(primitive.level_id.as_bytes());
        digest.update(b"\0");
        digest.update([role_class(primitive.role)]);
        let mesh = mesh_of(primitive);
        digest.update((mesh.positions.len() as u64).to_le_bytes());
        digest.update((mesh.faces.len() as u64).to_le_bytes());
        for position in &mesh.positions {
            for component in position {
                digest.update(component.to_le_bytes());
            }
        }
    }
    format!("{:x}", digest.finalize())
}

/// Expand an indexed mesh into triangle-list vertices with flat facet
/// normals. Millimetres become metres here — the render format's unit — and
/// the vertical extent is recorded for floor filtering and picking.
fn triangulate(mesh: &Mesh) -> Triangles {
    let mut vertices = Vec::with_capacity(mesh.faces.len() * 3);
    let mut normals = Vec::with_capacity(mesh.faces.len() * 3);
    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;

    for face in &mesh.faces {
        let corners: Option<Vec<[f32; 3]>> = face
            .iter()
            .map(|index| mesh.positions.get(*index as usize).map(metres))
            .collect();
        // A face indexing past its own positions is not geometry; skipping it
        // keeps the rest of the primitive renderable.
        let Some(corners) = corners else { continue };

        let normal = facet_normal(&corners);
        for corner in corners {
            min_z = min_z.min(corner[2]);
            max_z = max_z.max(corner[2]);
            vertices.push(corner);
            normals.push(normal);
        }
    }

    if vertices.is_empty() {
        min_z = 0.0;
        max_z = 0.0;
    }

    Triangles {
        vertices,
        normals,
        min_z,
        max_z,
    }
}

fn metres(position: &[i64; 3]) -> [f32; 3] {
    [
        position[0] as f32 / MM_PER_M,
        position[1] as f32 / MM_PER_M,
        position[2] as f32 / MM_PER_M,
    ]
}

/// The facet's outward normal from its winding. A degenerate facet (zero
/// area) gets an up normal rather than a NaN one.
fn facet_normal(corners: &[[f32; 3]]) -> [f32; 3] {
    let (a, b, c) = (corners[0], corners[1], corners[2]);
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let normal = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
    if length <= f32::EPSILON {
        return [0.0, 0.0, 1.0];
    }
    [normal[0] / length, normal[1] / length, normal[2] / length]
}

/// Stable ordering key for a role, so batch order depends on the role itself
/// and not on the order primitives happened to arrive in.
fn role_key(role: SemanticRole) -> u8 {
    match role {
        SemanticRole::Walkable => 0,
        SemanticRole::Public => 1,
        SemanticRole::Service => 2,
        SemanticRole::Restricted => 3,
        SemanticRole::Structure => 4,
        SemanticRole::Ceiling => 5,
        SemanticRole::Opening => 6,
        SemanticRole::Elevator => 7,
        SemanticRole::Escalator => 8,
        SemanticRole::Stairs => 9,
        SemanticRole::Ramp => 10,
        SemanticRole::Context => 11,
        SemanticRole::Conveyance => 12,
    }
}

fn role_class(role: PrimitiveRole) -> u8 {
    match role {
        PrimitiveRole::Surface => 0,
        PrimitiveRole::Wall => 1,
        PrimitiveRole::Ceiling => 2,
        PrimitiveRole::Portal => 3,
        PrimitiveRole::Conveyance => 4,
    }
}

/// Accumulates one `(level, role)` batch before quantization.
struct BatchAccumulator {
    role: SemanticRole,
    vertices: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    feature_indices: Vec<u32>,
}

impl BatchAccumulator {
    fn new(role: SemanticRole) -> Self {
        Self {
            role,
            vertices: Vec::new(),
            normals: Vec::new(),
            feature_indices: Vec::new(),
        }
    }

    fn push(&mut self, triangles: &Triangles, feature_index: u32) {
        self.vertices.extend_from_slice(&triangles.vertices);
        self.normals.extend_from_slice(&triangles.normals);
        self.feature_indices
            .extend(std::iter::repeat_n(feature_index, triangles.vertices.len()));
    }

    fn finish(self, level_index: u32) -> SceneBatch {
        let (positions, quantization_origin, quantization_scale) =
            quantize_positions(&self.vertices);
        SceneBatch {
            level_index,
            role: self.role,
            quantization_origin,
            quantization_scale,
            vertex_count: positions.len() as u32,
            positions,
            normals: self.normals.into_iter().map(encode_normal_oct).collect(),
            feature_indices: self.feature_indices,
        }
    }
}
