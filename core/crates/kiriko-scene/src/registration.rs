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

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::floor_label::{floor_label_candidates, labels_agree};
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// The canonical floor this level was matched to, and that floor's own
    /// plane. Reported because the match is the one decision in this report a
    /// producer must check by eye: a whole stack offset by roughly a storey
    /// maps every level to its neighbour, and where footprints repeat — station
    /// platforms, concourses — the residuals against the wrong floor are as
    /// small as against the right one. Geometry cannot settle it, so the
    /// producer is shown both planes and asked.
    pub mapped_canonical_level_id: Option<String>,
    pub mapped_floor_plane_m: Option<f64>,
    /// What this level's own label says about that match (#81). The one check
    /// that does not come from altitude, and so the only one that can catch a
    /// stack offset by a storey where every footprint repeats.
    pub label_agreement: LabelAgreement,
}

/// Group a package's source elements into composite levels and resolve each
/// level's floor plane from its own walkable surfaces.
///
/// Levels come back ordered by composite identity, so the same asset always
/// produces the same registration table.
#[must_use]
pub fn resolve_tile_levels(
    scenes: &[GlbScene],
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
    // Feature ids are table-local, so identity is resolved per member.
    let mut identity_by_feature: Vec<Vec<String>> = Vec::with_capacity(scenes.len());

    for scene in scenes {
        let mut identities: Vec<String> = Vec::with_capacity(scene.features.len());
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
            identities.push(identity);
        }
        identity_by_feature.push(identities);
    }

    // Walkable geometry, weighted by triangle area: a plane is where most of
    // the walkable surface is, not where the most triangles happen to be. A
    // finely tessellated ramp cannot outvote a coarse concourse slab.
    for (index, scene) in scenes.iter().enumerate() {
        for primitive in &scene.primitives {
            let Some(identity) = identity_by_feature
                .get(index)
                .and_then(|identities| identities.get(primitive.feature_id as usize))
            else {
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
                // Resolving a level says nothing about which floor it is;
                // `measure_registration` fills these once it has matched.
                mapped_canonical_level_id: None,
                mapped_floor_plane_m: None,
                label_agreement: LabelAgreement::Unknown,
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

/// One canonical venue floor's own geometry, in venue-local ENU metres: what
/// the tiles are measured against. Rings are unit polygon outlines, open or
/// closed; the caller projects them through the §8 frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueFloor {
    pub level_id: String,
    pub ordinal: f64,
    /// The §8 resolved floor plane, venue-local metres. Level identity is
    /// resolved by altitude before distance (#33).
    pub plane_z_m: f64,
    pub rings: Vec<Vec<[f64; 2]>>,
    /// This floor's own names, every locale. Corroboration, never a join key:
    /// altitude picks the floor and a label can only agree or contradict (#81).
    pub labels: Vec<String>,
}

/// What a tile level's own label says about the floor altitude matched it to.
///
/// The distinction that matters is between *no evidence* and *evidence of
/// correctness*. Two exports sharing no naming convention produce `Unknown`, and
/// `Unknown` must never read as reassurance — it is the absence of a check, not
/// a passed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelAgreement {
    /// The level's label names the floor it was matched to.
    Agrees,
    /// The level's label names exactly one venue floor, and it is a different one.
    Contradicts,
    /// No label on either side, none that reduce to a comparable form, or a label
    /// naming several floors — none of which is evidence either way.
    Unknown,
}

/// The versioned thresholds and sampling parameters every registration
/// judgement comes from. Stored with an activation so a later profile change
/// cannot retroactively re-judge a published version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Every field defaults, so a profile stored before a field existed still loads
// as the value that field's absence used to mean.
#[serde(default)]
pub struct RegistrationProfile {
    pub id: String,
    pub version: u32,
    /// Spacing between boundary samples, metres.
    pub sample_spacing_m: f64,
    /// A boundary sample further than this from every unit edge *and* inside
    /// no unit is a coverage difference, not a residual (#31).
    pub carve_out_distance_m: f64,
    /// Trusted p90 residual band, metres.
    pub p90_max_m: f64,
    /// Per-canonical-floor p90 overrides. No single number describes an asset:
    /// Tokyo's floors measured 0.433 to 0.608 m carved.
    pub floor_p90_max_m: BTreeMap<String, f64>,
    /// Median coherent shift band, metres.
    pub median_shift_max_m: f64,
    /// A spatially separated coherent residual above this blocks activation.
    pub coherent_residual_max_m: f64,
    /// Cell size for the spatial separation test, metres.
    pub cluster_cell_m: f64,
    /// Offending samples a cell needs before it counts as a cluster rather
    /// than noise.
    pub cluster_min_samples: usize,
    /// How far a tile level's resolved plane may sit from a canonical floor's
    /// plane and still be that floor.
    pub level_match_tolerance_m: f64,
    /// Added to every tile plane before it is matched to a canonical floor.
    ///
    /// The venue GDB proves no floor elevation — every exported Z was 0 (#31) —
    /// so the two sides can sit on different vertical datums. Reconciling them
    /// is a recorded producer decision carried by the versioned profile, never
    /// an alignment inferred from the data: inferring it would map every level
    /// somewhere, which is exactly the guess the activation gate exists to
    /// refuse.
    pub vertical_offset_m: f64,
}

impl Default for RegistrationProfile {
    /// The versioned default profile: #31's certified bands, and the sampling
    /// parameters its measurement used.
    fn default() -> Self {
        Self {
            id: "default".to_string(),
            version: 1,
            sample_spacing_m: 0.5,
            carve_out_distance_m: 1.0,
            p90_max_m: 0.50,
            floor_p90_max_m: BTreeMap::new(),
            median_shift_max_m: 0.15,
            coherent_residual_max_m: 1.0,
            cluster_cell_m: 40.0,
            cluster_min_samples: 5,
            level_match_tolerance_m: 1.5,
            vertical_offset_m: 0.0,
        }
    }
}

impl RegistrationProfile {
    /// The p90 band this floor is held to: its own measured band when the
    /// profile carries one, the venue-wide band otherwise.
    #[must_use]
    pub fn p90_band_for(&self, canonical_level_id: &str) -> f64 {
        self.floor_p90_max_m
            .get(canonical_level_id)
            .copied()
            .unwrap_or(self.p90_max_m)
    }
}

/// Residual distribution over a set of samples, metres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResidualStats {
    pub samples: usize,
    pub p50_m: f64,
    pub p90_m: f64,
    pub max_m: f64,
}

/// A spatially separated group of offending samples that agree on a direction:
/// the shape of a real misregistration, as opposed to scattered noise.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoherentCluster {
    /// Cell centre, venue-local metres.
    pub east_m: f64,
    pub north_m: f64,
    pub samples: usize,
    pub offset_m: [f64; 2],
    pub distance_m: f64,
}

/// One canonical floor's registration against the tile levels mapped to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorRegistration {
    pub canonical_level_id: String,
    /// The composite tile levels this floor renders — a set, because the
    /// mapping is many-to-many on both sides (#31).
    pub composite_source_levels: Vec<String>,
    /// Boundary samples taken, before the coverage carve-out.
    pub sampled: usize,
    /// Samples excluded as model-coverage differences.
    pub carved_out: usize,
    /// `None` when nothing survived the carve-out. Zeroed statistics read as
    /// perfect agreement, which is the opposite of what no samples mean.
    pub stats: Option<ResidualStats>,
    /// Componentwise median offset, tile minus venue.
    pub median_offset_m: [f64; 2],
    pub median_shift_m: f64,
    pub coherent_clusters: Vec<CoherentCluster>,
}

/// What a package looks like against a venue's own geometry: where its levels
/// are, which canonical floor each one is, and how far off they sit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationReport {
    pub profile_id: String,
    pub profile_version: u32,
    pub levels: Vec<TileLevel>,
    pub floors: Vec<FloorRegistration>,
    /// Composite levels no canonical floor claims. Reported, never guessed at.
    pub unmapped_levels: Vec<String>,
    /// Composite levels with more than one candidate floor inside the match
    /// tolerance. The tolerance is wider than some floor-to-floor gaps, so
    /// nearest-wins here would be a guess wearing a mapping's clothes.
    pub ambiguous_levels: Vec<String>,
    /// The vertical offset the profile applied to tile planes before matching.
    /// Recorded so a producer can see which datum reconciliation produced this
    /// registration table.
    pub applied_vertical_offset_m: f64,
    /// Every surviving sample across every floor; `None` when there were none.
    pub venue_wide: Option<ResidualStats>,
}

/// Measure a package's registration against the venue's own geometry, the way
/// #31 measured it: sample the tile surfaces' boundaries, take the distance to
/// the nearest venue unit edge on the floor that level maps to, and carve out
/// the samples that are model-coverage differences rather than residuals.
///
/// Reports numbers; judges nothing. The profile's bands are applied by
/// [`evaluate_activation`](crate::evaluate_activation).
#[must_use]
pub fn measure_registration(
    scenes: &[GlbScene],
    asset_version: &str,
    transform: &FrameTransform,
    venue: &[VenueFloor],
    profile: &RegistrationProfile,
) -> RegistrationReport {
    let mut levels = resolve_tile_levels(scenes, asset_version, transform);

    // Altitude first: a level belongs to the canonical floor whose resolved
    // plane it sits on, not to whichever floor happens to be closest in plan.
    let mut floor_of_level: BTreeMap<String, &VenueFloor> = BTreeMap::new();
    let mut unmapped_levels: Vec<String> = Vec::new();
    let mut ambiguous_levels: Vec<String> = Vec::new();
    for level in &mut levels {
        let Some(measured) = level.resolved_plane_m else {
            // No plane is its own gate failure; it cannot also be a mapping.
            unmapped_levels.push(level.composite_id.clone());
            continue;
        };
        let plane = measured + profile.vertical_offset_m;
        let mut candidates: Vec<&VenueFloor> = venue
            .iter()
            .filter(|floor| (floor.plane_z_m - plane).abs() <= profile.level_match_tolerance_m)
            .collect();
        candidates.sort_by(|a, b| {
            (a.plane_z_m - plane)
                .abs()
                .total_cmp(&(b.plane_z_m - plane).abs())
        });
        // Two floors inside the tolerance is not a near miss to break by
        // nearest: the tolerance is wider than some mezzanine gaps, and picking
        // one silently is the difference between a mapping and a guess.
        if candidates.len() > 1 {
            ambiguous_levels.push(level.composite_id.clone());
        }
        // The label check, done against every floor rather than only the matched
        // one: the question is not "do these two strings agree" but "does this
        // level's own name belong to a *different* floor" — which is the shape a
        // whole-storey offset takes and the shape altitude cannot see.
        let tile_labels: BTreeSet<String> = floor_label_candidates(&level.level_key)
            .into_iter()
            .chain(floor_label_candidates(&level.level_name))
            .collect();
        let named: Vec<&VenueFloor> = venue
            .iter()
            .filter(|floor| {
                let floor_labels = floor
                    .labels
                    .iter()
                    .flat_map(|label| floor_label_candidates(label))
                    .collect::<BTreeSet<String>>();
                labels_agree(&tile_labels, &floor_labels)
            })
            .collect();

        match candidates.first() {
            Some(floor) => {
                level.mapped_canonical_level_id = Some(floor.level_id.clone());
                level.mapped_floor_plane_m = Some(floor.plane_z_m);
                level.label_agreement =
                    if named.iter().any(|named| named.level_id == floor.level_id) {
                        LabelAgreement::Agrees
                    } else if named.len() == 1 {
                        // Exactly one floor answers to this level's name, and it is
                        // not the floor altitude chose. That is a contradiction, not
                        // a preference — and still not a licence to remap.
                        LabelAgreement::Contradicts
                    } else {
                        // No floor answers to it, or several do. Neither is evidence.
                        LabelAgreement::Unknown
                    };
                floor_of_level.insert(level.composite_id.clone(), floor);
            }
            None => unmapped_levels.push(level.composite_id.clone()),
        }
    }

    // Boundary samples per mapped level, in one pass over the walkable
    // geometry: an edge shared by two triangles is interior and never sampled.
    let mut samples_by_level: BTreeMap<&str, Vec<[f64; 2]>> = BTreeMap::new();
    let mut edges_by_level: BTreeMap<&str, BTreeMap<(WeldedPoint, WeldedPoint), i32>> =
        BTreeMap::new();
    for scene in scenes {
        for primitive in &scene.primitives {
            let Some(row) = scene.features.get(primitive.feature_id as usize) else {
                continue;
            };
            if role_for_category(&row.category) != SemanticRole::Walkable {
                continue;
            }
            let composite = composite_level_id(
                asset_version,
                &row.source_document,
                &row.source_link_name,
                &row.level_key,
                (f64::from(row.level_elevation_meters) * 10.0).round() as i32,
            );
            let Some((key, _)) = floor_of_level.get_key_value(composite.as_str()) else {
                continue;
            };
            let edges = edges_by_level.entry(key).or_default();
            for triangle in primitive.positions.chunks_exact(3) {
                let corners = [
                    weld(transform.apply(triangle[0])),
                    weld(transform.apply(triangle[1])),
                    weld(transform.apply(triangle[2])),
                ];
                for i in 0..3 {
                    let (a, b) = (corners[i], corners[(i + 1) % 3]);
                    if a == b {
                        continue;
                    }
                    // Undirected, and welded across members: a shared edge
                    // arrives once from each triangle with opposite winding,
                    // and the seam where two content files meet is interior
                    // geometry rather than two boundaries facing each other.
                    let key = if a <= b { (a, b) } else { (b, a) };
                    *edges.entry(key).or_insert(0) += 1;
                }
            }
        }
    }
    for (level, edges) in &edges_by_level {
        let samples = samples_by_level.entry(level).or_default();
        for ((a, b), count) in edges {
            if *count != 1 {
                continue;
            }
            sample_edge(unweld(*a), unweld(*b), profile.sample_spacing_m, samples);
        }
    }

    // Per canonical floor: measure every sample of every level mapped to it.
    let mut floors: Vec<FloorRegistration> = Vec::new();
    let mut venue_wide: Vec<f64> = Vec::new();
    for floor in venue {
        let mut composite_source_levels: Vec<String> = floor_of_level
            .iter()
            .filter(|(_, mapped)| mapped.level_id == floor.level_id)
            .map(|(composite, _)| (*composite).to_string())
            .collect();
        composite_source_levels.sort();
        if composite_source_levels.is_empty() {
            continue;
        }
        let segments = ring_segments(&floor.rings);
        let mut distances: Vec<f64> = Vec::new();
        let mut offsets: Vec<[f64; 2]> = Vec::new();
        let mut offending: Vec<([f64; 2], [f64; 2], f64)> = Vec::new();
        let mut sampled = 0usize;
        let mut carved_out = 0usize;
        let band = profile.p90_band_for(&floor.level_id);
        for composite in &composite_source_levels {
            let Some(samples) = samples_by_level.get(composite.as_str()) else {
                continue;
            };
            for sample in samples {
                sampled += 1;
                let Some((closest, distance)) = nearest_on_segments(*sample, &segments) else {
                    // A floor with no unit geometry cannot measure anything;
                    // the sample is neither a residual nor a carve-out.
                    carved_out += 1;
                    continue;
                };
                if distance > profile.carve_out_distance_m && !point_in_rings(*sample, &floor.rings)
                {
                    carved_out += 1;
                    continue;
                }
                let offset = [sample[0] - closest[0], sample[1] - closest[1]];
                distances.push(distance);
                offsets.push(offset);
                if distance > band {
                    offending.push((*sample, offset, distance));
                }
            }
        }
        venue_wide.extend(distances.iter().copied());
        floors.push(FloorRegistration {
            canonical_level_id: floor.level_id.clone(),
            composite_source_levels,
            sampled,
            carved_out,
            stats: stats_of(&mut distances),
            median_offset_m: median_offset(&offsets),
            median_shift_m: magnitude(median_offset(&offsets)),
            coherent_clusters: cluster(&offending, profile),
        });
    }

    RegistrationReport {
        profile_id: profile.id.clone(),
        profile_version: profile.version,
        levels,
        floors,
        unmapped_levels,
        ambiguous_levels,
        applied_vertical_offset_m: profile.vertical_offset_m,
        venue_wide: stats_of(&mut venue_wide),
    }
}

/// A position welded to the millimetre, so a shared edge between two triangles
/// is recognised as shared despite float tessellation noise.
type WeldedPoint = (i64, i64);

fn weld(position: [f64; 3]) -> WeldedPoint {
    (
        (position[0] * 1000.0).round() as i64,
        (position[1] * 1000.0).round() as i64,
    )
}

fn unweld(point: WeldedPoint) -> [f64; 2] {
    [point.0 as f64 / 1000.0, point.1 as f64 / 1000.0]
}

/// Sample an edge at fixed spacing, at least once. Samples sit at cell centres
/// so the same edge traversed from either end yields the same points.
fn sample_edge(a: [f64; 2], b: [f64; 2], spacing_m: f64, out: &mut Vec<[f64; 2]>) {
    let length = magnitude([b[0] - a[0], b[1] - a[1]]);
    if length <= 0.0 {
        return;
    }
    let count = ((length / spacing_m).floor() as usize).max(1);
    for index in 0..count {
        let t = (index as f64 + 0.5) / count as f64;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
}

/// Every ring's segments, closing each ring.
fn ring_segments(rings: &[Vec<[f64; 2]>]) -> Vec<([f64; 2], [f64; 2])> {
    let mut segments = Vec::new();
    for ring in rings {
        if ring.len() < 2 {
            continue;
        }
        for index in 0..ring.len() {
            let a = ring[index];
            let b = ring[(index + 1) % ring.len()];
            if a != b {
                segments.push((a, b));
            }
        }
    }
    segments
}

/// The closest point on any segment, and its distance.
fn nearest_on_segments(
    point: [f64; 2],
    segments: &[([f64; 2], [f64; 2])],
) -> Option<([f64; 2], f64)> {
    let mut best: Option<([f64; 2], f64)> = None;
    for (a, b) in segments {
        let candidate = closest_on_segment(point, *a, *b);
        let distance = magnitude([point[0] - candidate[0], point[1] - candidate[1]]);
        if best.is_none_or(|(_, best_distance)| distance < best_distance) {
            best = Some((candidate, distance));
        }
    }
    best
}

fn closest_on_segment(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length_squared = dx * dx + dy * dy;
    if length_squared <= 0.0 {
        return a;
    }
    let t = (((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_squared).clamp(0.0, 1.0);
    [a[0] + dx * t, a[1] + dy * t]
}

/// Even-odd containment across every ring.
fn point_in_rings(point: [f64; 2], rings: &[Vec<[f64; 2]>]) -> bool {
    let mut inside = false;
    for ring in rings {
        if ring.len() < 3 {
            continue;
        }
        for index in 0..ring.len() {
            let a = ring[index];
            let b = ring[(index + 1) % ring.len()];
            if (a[1] > point[1]) != (b[1] > point[1]) {
                let x = (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0];
                if point[0] < x {
                    inside = !inside;
                }
            }
        }
    }
    inside
}

/// Offending samples grouped into cells; a cell holding enough of them whose
/// median offset is beyond the band is a coherent residual, not scatter.
fn cluster(
    offending: &[([f64; 2], [f64; 2], f64)],
    profile: &RegistrationProfile,
) -> Vec<CoherentCluster> {
    let mut cells: BTreeMap<(i64, i64), Vec<[f64; 2]>> = BTreeMap::new();
    for (sample, offset, _) in offending {
        let cell = (
            (sample[0] / profile.cluster_cell_m).floor() as i64,
            (sample[1] / profile.cluster_cell_m).floor() as i64,
        );
        cells.entry(cell).or_default().push(*offset);
    }
    cells
        .into_iter()
        .filter(|(_, offsets)| offsets.len() >= profile.cluster_min_samples)
        .filter_map(|((cx, cy), offsets)| {
            let offset = median_offset(&offsets);
            let distance = magnitude(offset);
            (distance > profile.coherent_residual_max_m).then_some(CoherentCluster {
                east_m: (cx as f64 + 0.5) * profile.cluster_cell_m,
                north_m: (cy as f64 + 0.5) * profile.cluster_cell_m,
                samples: offsets.len(),
                offset_m: offset,
                distance_m: distance,
            })
        })
        .collect()
}

fn stats_of(distances: &mut [f64]) -> Option<ResidualStats> {
    if distances.is_empty() {
        // Not a distribution of zero error — no distribution at all. Returning
        // zeroes here is what let an unmeasured registration print as a clean
        // one all the way out to the producer's screen.
        return None;
    }
    distances.sort_by(f64::total_cmp);
    Some(ResidualStats {
        samples: distances.len(),
        p50_m: percentile(distances, 0.50),
        p90_m: percentile(distances, 0.90),
        max_m: distances[distances.len() - 1],
    })
}

/// Nearest-rank percentile over sorted values: an actual measured sample, never
/// an interpolation between two of them.
fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn median_offset(offsets: &[[f64; 2]]) -> [f64; 2] {
    if offsets.is_empty() {
        return [0.0, 0.0];
    }
    let mut east: Vec<f64> = offsets.iter().map(|o| o[0]).collect();
    let mut north: Vec<f64> = offsets.iter().map(|o| o[1]).collect();
    east.sort_by(f64::total_cmp);
    north.sort_by(f64::total_cmp);
    [median(&east), median(&north)]
}

fn median(sorted: &[f64]) -> f64 {
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}

fn magnitude(vector: [f64; 2]) -> f64 {
    vector[0].hypot(vector[1])
}

/// Why an activation is blocked. Typed, because a producer UI has to say which
/// part of their export to look at without parsing prose, in either language.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GateCode {
    /// A member failed integrity or did not resolve.
    IntegrityUnresolved,
    /// No capability profile was recorded for this activation.
    CapabilityProfileMissing,
    /// A floor's p90 residual is beyond its band.
    RegistrationOutOfBand,
    /// A floor's correspondences agree on one direction beyond the band —
    /// displacement rather than noise.
    CoherentShiftOutOfBand,
    /// A spatially separated group of residuals agrees beyond the band.
    CoherentResidual,
    /// A rendered level exposes no surface to resolve a floor plane from.
    LevelPlaneUnresolved,
    /// A rendered level maps to no canonical floor.
    LevelNotMapped,
    /// More than one canonical floor sits inside the match tolerance, so the
    /// nearest is a tie-break rather than an identification.
    LevelMappingAmbiguous,
    /// Levels sorted by their own plane map to floors that are not in the same
    /// order. A stack cannot interleave, so something is misaligned.
    LevelMappingScrambled,
    /// Two levels further apart than the tolerance map to one floor. A floor may
    /// legitimately be rendered by several levels (#31), but not by levels that
    /// cannot be the same storey.
    LevelMappingCollapsed,
    /// A level's own label names a different canonical floor than the one its
    /// altitude matched. The only check here that does not come from altitude,
    /// and so the only one that sees a stack offset by a whole storey.
    LevelLabelContradiction,
    /// Opaque content belongs to no level and has no contextual class.
    UnclassifiedOpaqueContent,
}

impl GateCode {
    /// Stable string value (camelCase, never changes for an existing variant):
    /// the key the producer-facing copy table answers for.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IntegrityUnresolved => "integrityUnresolved",
            Self::CapabilityProfileMissing => "capabilityProfileMissing",
            Self::RegistrationOutOfBand => "registrationOutOfBand",
            Self::CoherentShiftOutOfBand => "coherentShiftOutOfBand",
            Self::CoherentResidual => "coherentResidual",
            Self::LevelPlaneUnresolved => "levelPlaneUnresolved",
            Self::LevelNotMapped => "levelNotMapped",
            Self::LevelMappingAmbiguous => "levelMappingAmbiguous",
            Self::LevelMappingScrambled => "levelMappingScrambled",
            Self::LevelMappingCollapsed => "levelMappingCollapsed",
            Self::LevelLabelContradiction => "levelLabelContradiction",
            Self::UnclassifiedOpaqueContent => "unclassifiedOpaqueContent",
        }
    }
}

/// One blocked gate: what failed, on what, and against which number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateFailure {
    pub code: GateCode,
    /// The canonical floor, composite level, or source object at fault.
    pub subject: String,
    /// What was measured, when the gate is numeric.
    pub measured: Option<f64>,
    /// The band it was measured against.
    pub band: Option<f64>,
}

/// What a producer's activation request carries beyond the package itself.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivationInput<'a> {
    /// The immutable asset version, the first component of composite level
    /// identity.
    pub asset_version: &'a str,
    /// Whether every declared member resolved and hashed as recorded. Proven
    /// by the caller that holds the store, never assumed here.
    pub integrity_verified: bool,
    /// The capability profile this activation is recorded against.
    pub capability_profile: Option<&'a str>,
    /// Source objects the producer classified as contextual, with an explicit
    /// occlusion policy.
    pub contextual_source_objects: &'a BTreeSet<String>,
}

/// The whole activation decision: the measurements, the registration table
/// they produced, and every gate that blocks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationEvaluation {
    pub report: RegistrationReport,
    /// Canonical floor → the composite tile levels it renders. This is the
    /// registration table that lands in §9's `TilesDescriptor`.
    pub floor_mappings: Vec<(String, Vec<String>)>,
    pub gates: Vec<GateFailure>,
}

impl ActivationEvaluation {
    /// Whether a producer may activate this package.
    #[must_use]
    pub fn passes(&self) -> bool {
        self.gates.is_empty()
    }
}

/// Measure a package against a venue and apply the profile's bands: the
/// complete answer to "may this become the primary view, and if not, why not".
///
/// Gates are evaluated in a fixed order — package-wide, then per level, then
/// per floor — so the same package always reports the same list, and a producer
/// fixing the first failure sees a shorter list rather than a different one.
#[must_use]
pub fn evaluate_activation(
    scenes: &[GlbScene],
    venue: &[VenueFloor],
    profile: &RegistrationProfile,
    input: &ActivationInput<'_>,
    transform: &FrameTransform,
) -> ActivationEvaluation {
    let report = measure_registration(scenes, input.asset_version, transform, venue, profile);
    let mut gates: Vec<GateFailure> = Vec::new();

    if !input.integrity_verified {
        gates.push(GateFailure {
            code: GateCode::IntegrityUnresolved,
            subject: input.asset_version.to_string(),
            measured: None,
            band: None,
        });
    }
    if input.capability_profile.is_none() {
        gates.push(GateFailure {
            code: GateCode::CapabilityProfileMissing,
            subject: input.asset_version.to_string(),
            measured: None,
            band: None,
        });
    }

    let mapped: BTreeSet<&str> = report
        .floors
        .iter()
        .flat_map(|floor| floor.composite_source_levels.iter().map(String::as_str))
        .collect();

    for level in &report.levels {
        let contextual = |id: &String| input.contextual_source_objects.contains(id);
        // A level with no level key was never a floor: it is site or context
        // mass, and the only question is whether the producer said so.
        if level.level_key.is_empty() {
            for source_object_id in &level.opaque_source_object_ids {
                if !contextual(source_object_id) {
                    gates.push(GateFailure {
                        code: GateCode::UnclassifiedOpaqueContent,
                        subject: source_object_id.clone(),
                        measured: None,
                        band: None,
                    });
                }
            }
            continue;
        }
        // A level whose every object is classified context is context, however
        // it is keyed; it renders under its own policy and needs no floor.
        if level.source_object_ids.iter().all(contextual) {
            continue;
        }
        if level.resolved_plane_m.is_none() {
            gates.push(GateFailure {
                code: GateCode::LevelPlaneUnresolved,
                subject: level.composite_id.clone(),
                measured: None,
                band: None,
            });
            continue;
        }
        if !mapped.contains(level.composite_id.as_str()) {
            gates.push(GateFailure {
                code: GateCode::LevelNotMapped,
                subject: level.composite_id.clone(),
                measured: None,
                band: None,
            });
        }
        if level.label_agreement == LabelAgreement::Contradicts {
            // The level's own name belongs to another floor. Not a preference to
            // weigh against altitude — a contradiction between two independent
            // accounts of the same fact, which is exactly the evidence altitude
            // cannot produce about a stack offset by a storey.
            gates.push(GateFailure {
                code: GateCode::LevelLabelContradiction,
                subject: level.composite_id.clone(),
                measured: None,
                band: None,
            });
        }
    }

    // The mapping invariants. None of these can prove a mapping right: a stack
    // shifted a whole storey, covering fewer floors than the venue has, with
    // repeated footprints, satisfies every one of them and is still wrong. That
    // case is why the datum is a producer decision (#74) and why the producer
    // confirms the table. These catch the cases that *are* decidable.
    for composite in &report.ambiguous_levels {
        gates.push(GateFailure {
            code: GateCode::LevelMappingAmbiguous,
            subject: composite.clone(),
            measured: None,
            band: Some(profile.level_match_tolerance_m),
        });
    }

    // Order: levels sorted by their own plane must map to floors whose planes
    // are in the same order. A real stack does not interleave.
    let mut placed: Vec<(f64, f64, &str)> = report
        .levels
        .iter()
        .filter_map(|level| {
            Some((
                level.resolved_plane_m?,
                level.mapped_floor_plane_m?,
                level.composite_id.as_str(),
            ))
        })
        .collect();
    placed.sort_by(|a, b| a.0.total_cmp(&b.0));
    for pair in placed.windows(2) {
        let [lower, upper] = [pair[0], pair[1]];
        if upper.1 < lower.1 {
            gates.push(GateFailure {
                code: GateCode::LevelMappingScrambled,
                subject: upper.2.to_string(),
                measured: Some(upper.1),
                band: Some(lower.1),
            });
        }
    }

    // Collapse: one floor claiming two levels that cannot be the same storey.
    let mut planes_by_floor: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    for level in &report.levels {
        if let (Some(floor), Some(plane)) = (
            level.mapped_canonical_level_id.as_deref(),
            level.resolved_plane_m,
        ) {
            planes_by_floor.entry(floor).or_default().push(plane);
        }
    }
    for (floor, planes) in &planes_by_floor {
        let (Some(low), Some(high)) = (
            planes.iter().copied().reduce(f64::min),
            planes.iter().copied().reduce(f64::max),
        ) else {
            continue;
        };
        let spread = high - low;
        if spread > profile.level_match_tolerance_m {
            gates.push(GateFailure {
                code: GateCode::LevelMappingCollapsed,
                subject: (*floor).to_string(),
                measured: Some(spread),
                band: Some(profile.level_match_tolerance_m),
            });
        }
    }

    for floor in &report.floors {
        let band = profile.p90_band_for(&floor.canonical_level_id);
        // A floor with no surviving samples cannot exceed a band; it also cannot
        // clear one. `LevelNotMapped` and the unmeasured report are what say so —
        // this gate speaks only about measurements that exist.
        if let Some(stats) = floor.stats
            && stats.p90_m > band
        {
            gates.push(GateFailure {
                code: GateCode::RegistrationOutOfBand,
                subject: floor.canonical_level_id.clone(),
                measured: Some(stats.p90_m),
                band: Some(band),
            });
        }
        if floor.median_shift_m > profile.median_shift_max_m {
            gates.push(GateFailure {
                code: GateCode::CoherentShiftOutOfBand,
                subject: floor.canonical_level_id.clone(),
                measured: Some(floor.median_shift_m),
                band: Some(profile.median_shift_max_m),
            });
        }
        for cluster in &floor.coherent_clusters {
            gates.push(GateFailure {
                code: GateCode::CoherentResidual,
                subject: format!(
                    "{} @ {:.0},{:.0}",
                    floor.canonical_level_id, cluster.east_m, cluster.north_m
                ),
                measured: Some(cluster.distance_m),
                band: Some(profile.coherent_residual_max_m),
            });
        }
    }

    let floor_mappings = report
        .floors
        .iter()
        .map(|floor| {
            (
                floor.canonical_level_id.clone(),
                floor.composite_source_levels.clone(),
            )
        })
        .collect();

    ActivationEvaluation {
        report,
        floor_mappings,
        gates,
    }
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
