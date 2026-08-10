//! Tile registration: what a package would look like as a venue's primary
//! scene, measured before a producer is allowed to make it one (#74).
//!
//! Three questions, in dependency order.
//!
//! **Where is each level?** A tile level's placement comes from its own
//! walkable surfaces, never from `levelElevationMeters` — the KITTE floors in
//! the Tokyo asset disagree with their metadata by 3.02 m, repeatably, and the
//! mesh is what renders (#31). The metadata is kept as provenance and its
//! disagreement is reported, because a silent correction hides a broken export.
//!
//! **Which level is it?** `levelKey` is never an identity on its own: 11 of the
//! Tokyo asset's 90 keys occur at several elevations, and generic keys such as
//! `b1fl` appear in four linked models. Identity is the composite
//! `asset version | source document | source link | level key | quantized
//! elevation` (#30 section 3).
//!
//! **Is it in the right place?** Residuals are measured against the venue's own
//! geometry the way #31 measured them, and the numbers are reported rather than
//! judged here; judging is the profile's job.

use std::collections::BTreeMap;

use crate::format::SemanticRole;
use crate::glb::GlbScene;
use crate::roles::role_for_category;

/// Bin width for the dominant-surface-height histogram, metres. One centimetre
/// separates genuinely different planes while absorbing float noise in a
/// tessellation; #31's measured planes differ by decimetres at the closest.
const PLANE_BIN_M: f64 = 0.01;

/// A tile-local to venue-local transform, column-major like glTF and 3D Tiles.
///
/// The composed chain is `venue_enu ← ecef ← tileset_transform ← z_up ← glTF`.
/// It is composed once and applied per vertex: a 172 MiB asset cannot afford
/// four matrix multiplies per position.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameTransform {
    matrix: [f64; 16],
}

impl FrameTransform {
    /// The identity — tile coordinates are already venue-local metres.
    #[must_use]
    pub const fn identity() -> Self {
        Self {
            matrix: [
                1.0, 0.0, 0.0, 0.0, //
                0.0, 1.0, 0.0, 0.0, //
                0.0, 0.0, 1.0, 0.0, //
                0.0, 0.0, 0.0, 1.0,
            ],
        }
    }

    /// Compose the published tileset root transform with the venue's own ENU
    /// frame.
    ///
    /// The root transform is applied **unchanged** — #31 decided that, and an
    /// independently fitted offset would register the asset against a frame no
    /// standards-compliant renderer uses. The glTF Y-up to 3D Tiles Z-up
    /// conversion is part of the chain because the content is glTF and the
    /// tileset transform expects Z-up input.
    #[must_use]
    pub fn from_tileset(
        root_transform: &[f64; 16],
        ecef_origin: &[f64; 3],
        enu_basis_ecef: &[[f64; 3]; 3],
    ) -> Self {
        // glTF Y-up → 3D Tiles Z-up: (x, y, z) → (x, -z, y).
        const Y_UP_TO_Z_UP: [f64; 16] = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, -1.0, 0.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ];
        // ECEF → venue-local ENU: translate by the frame origin, then project
        // onto the ENU basis (whose columns are unit vectors, so the inverse
        // rotation is its transpose).
        let ecef_to_enu = [
            enu_basis_ecef[0][0],
            enu_basis_ecef[1][0],
            enu_basis_ecef[2][0],
            0.0,
            enu_basis_ecef[0][1],
            enu_basis_ecef[1][1],
            enu_basis_ecef[2][1],
            0.0,
            enu_basis_ecef[0][2],
            enu_basis_ecef[1][2],
            enu_basis_ecef[2][2],
            0.0,
            -(enu_basis_ecef[0][0] * ecef_origin[0]
                + enu_basis_ecef[0][1] * ecef_origin[1]
                + enu_basis_ecef[0][2] * ecef_origin[2]),
            -(enu_basis_ecef[1][0] * ecef_origin[0]
                + enu_basis_ecef[1][1] * ecef_origin[1]
                + enu_basis_ecef[1][2] * ecef_origin[2]),
            -(enu_basis_ecef[2][0] * ecef_origin[0]
                + enu_basis_ecef[2][1] * ecef_origin[1]
                + enu_basis_ecef[2][2] * ecef_origin[2]),
            1.0,
        ];
        Self {
            matrix: multiply(&ecef_to_enu, &multiply(root_transform, &Y_UP_TO_Z_UP)),
        }
    }

    /// The composed matrix, column-major.
    #[must_use]
    pub const fn matrix(&self) -> &[f64; 16] {
        &self.matrix
    }

    /// Transform one tile-local position into venue-local metres.
    #[must_use]
    pub fn apply(&self, position: [f32; 3]) -> [f64; 3] {
        let m = &self.matrix;
        let (x, y, z) = (
            f64::from(position[0]),
            f64::from(position[1]),
            f64::from(position[2]),
        );
        [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
        ]
    }
}

/// Column-major 4×4 multiply: `a · b`.
fn multiply(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut out = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            let mut sum = 0.0;
            for k in 0..4 {
                sum += a[k * 4 + row] * b[column * 4 + k];
            }
            out[column * 4 + row] = sum;
        }
    }
    out
}

/// One composite tile level: its identity, where its surfaces actually are,
/// and what its metadata claimed.
#[derive(Debug, Clone, PartialEq)]
pub struct TileLevel {
    /// `asset version | source document | source link | level key | quantized
    /// elevation (decimetres)`.
    pub composite_id: String,
    pub source_document: String,
    pub source_link_name: String,
    pub level_key: String,
    pub level_name: String,
    /// The metadata elevation, quantized to decimetres — the identity
    /// component, never a placement.
    pub quantized_elevation_dm: i32,
    pub metadata_elevation_m: f64,
    /// The dominant walkable-surface height, venue-local metres. `None` when
    /// the level exposes no walkable surface to read a plane from.
    pub resolved_plane_m: Option<f64>,
    /// `metadata − resolved`, recorded whenever both exist. Provenance for a
    /// producer, and the input to the metadata-disagreement finding.
    pub metadata_difference_m: Option<f64>,
    /// Walkable triangles behind the resolved plane.
    pub surface_triangles: usize,
    /// Every source object on this level, in property-table order.
    pub source_object_ids: Vec<String>,
    /// Source objects on this level whose role occludes and that therefore
    /// must be assigned to a floor or explicitly classified as context.
    pub opaque_source_object_ids: Vec<String>,
}

/// Group a package's source elements into composite levels and resolve each
/// level's floor plane from its own walkable surfaces.
///
/// Levels come back ordered by composite identity, so the same asset always
/// produces the same registration table.
#[must_use]
pub fn resolve_tile_levels(
    scene: &GlbScene,
    asset_version: &str,
    transform: &FrameTransform,
) -> Vec<TileLevel> {
    struct Accum {
        source_document: String,
        source_link_name: String,
        level_key: String,
        level_name: String,
        quantized_elevation_dm: i32,
        metadata_elevation_m: f64,
        surface_heights: BTreeMap<i64, f64>,
        surface_triangles: usize,
        source_object_ids: Vec<String>,
        opaque_source_object_ids: Vec<String>,
    }

    let mut by_identity: BTreeMap<String, Accum> = BTreeMap::new();
    let mut identity_by_feature: Vec<Option<String>> = Vec::with_capacity(scene.features.len());

    for row in &scene.features {
        let quantized = (f64::from(row.level_elevation_meters) * 10.0).round() as i32;
        let identity = composite_level_id(
            asset_version,
            &row.source_document,
            &row.source_link_name,
            &row.level_key,
            quantized,
        );
        let entry = by_identity
            .entry(identity.clone())
            .or_insert_with(|| Accum {
                source_document: row.source_document.clone(),
                source_link_name: row.source_link_name.clone(),
                level_key: row.level_key.clone(),
                level_name: row.level_name.clone(),
                quantized_elevation_dm: quantized,
                metadata_elevation_m: f64::from(row.level_elevation_meters),
                surface_heights: BTreeMap::new(),
                surface_triangles: 0,
                source_object_ids: Vec::new(),
                opaque_source_object_ids: Vec::new(),
            });
        entry.source_object_ids.push(row.revit_unique_id.clone());
        if occludes(role_for_category(&row.category)) {
            entry
                .opaque_source_object_ids
                .push(row.revit_unique_id.clone());
        }
        identity_by_feature.push(Some(identity));
    }

    // Walkable geometry, weighted by triangle area: a plane is where most of
    // the walkable surface is, not where the most triangles happen to be. A
    // finely tessellated ramp cannot outvote a coarse concourse slab.
    for primitive in &scene.primitives {
        let Some(Some(identity)) = identity_by_feature.get(primitive.feature_id as usize) else {
            continue;
        };
        let Some(row) = scene.features.get(primitive.feature_id as usize) else {
            continue;
        };
        if role_for_category(&row.category) != SemanticRole::Walkable {
            continue;
        }
        let Some(entry) = by_identity.get_mut(identity) else {
            continue;
        };
        for triangle in primitive.positions.chunks_exact(3) {
            let a = transform.apply(triangle[0]);
            let b = transform.apply(triangle[1]);
            let c = transform.apply(triangle[2]);
            let area = horizontal_area(a, b, c);
            if area <= 0.0 {
                // A vertical facet is a riser or a wall face, not a plane.
                continue;
            }
            let height = (a[2] + b[2] + c[2]) / 3.0;
            let bin = (height / PLANE_BIN_M).round() as i64;
            *entry.surface_heights.entry(bin).or_insert(0.0) += area;
            entry.surface_triangles += 1;
        }
    }

    by_identity
        .into_iter()
        .map(|(composite_id, accum)| {
            // Ties break toward the lower plane: the walkable floor sits under
            // whatever is stacked on it.
            let resolved_plane_m = accum
                .surface_heights
                .iter()
                .fold(None::<(i64, f64)>, |best, (&bin, &area)| match best {
                    Some((_, best_area)) if best_area >= area => best,
                    _ => Some((bin, area)),
                })
                .map(|(bin, _)| bin as f64 * PLANE_BIN_M);
            TileLevel {
                composite_id,
                source_document: accum.source_document,
                source_link_name: accum.source_link_name,
                level_key: accum.level_key,
                level_name: accum.level_name,
                quantized_elevation_dm: accum.quantized_elevation_dm,
                metadata_elevation_m: accum.metadata_elevation_m,
                resolved_plane_m,
                metadata_difference_m: resolved_plane_m
                    .map(|plane| accum.metadata_elevation_m - plane),
                surface_triangles: accum.surface_triangles,
                source_object_ids: accum.source_object_ids,
                opaque_source_object_ids: accum.opaque_source_object_ids,
            }
        })
        .collect()
}

/// The composite level identity from #30 section 3. Built in one place so a
/// reader and a writer cannot disagree about the separator.
#[must_use]
pub fn composite_level_id(
    asset_version: &str,
    source_document: &str,
    source_link_name: &str,
    level_key: &str,
    quantized_elevation_dm: i32,
) -> String {
    format!(
        "{asset_version}|{source_document}|{source_link_name}|{level_key}|{quantized_elevation_dm}"
    )
}

/// Whether a role's geometry blocks the view, and so has to be either placed on
/// a floor or explicitly classified as context before it can render (#30
/// section 3, #32 section 6).
fn occludes(role: SemanticRole) -> bool {
    !matches!(
        crate::roles::occlusion_for_role(role),
        crate::format::OcclusionClass::Never
    )
}

/// The triangle's area projected onto the horizontal plane: how much floor it
/// covers, which is what weights a plane vote.
fn horizontal_area(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs() / 2.0
}
