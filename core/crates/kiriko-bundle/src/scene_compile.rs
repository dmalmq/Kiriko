//! The generated-scene compiler: canonical venue model + §8 floor planes +
//! routing graph endpoints → §9 semantic primitives.
//!
//! Runs at publication time, evolving the `synth` geometry path: slabs from
//! level polygons, navigable surfaces from unit polygons, walls from unique
//! unit-boundary edges, portals from opening lines, ceilings per unit, and
//! neutral conveyance forms from vertical graph connections and transit
//! footprints. Every primitive is emitted with explicit provenance into §8's
//! registries, and a scene never presents a guess as a measurement.
//!
//! Resolved geometry is venue-local checked integer millimetres, projected
//! through the §8 ENU frame; the authoritative Z is each level's resolved
//! plane from §8's level records. Determinism: every emission derives from
//! canonical inputs in a fixed order, with `round` applied exactly once per
//! value.

use kiriko_model::canonical::Value;
use kiriko_model::model::{FeatureType, VenueFeature};
use kiriko_model::scene::{
    ConveyanceKind, Mesh, OcclusionClass, PrimitiveGeometry, PrimitiveRole, ScenePrimitive,
    SceneSection,
};
use kiriko_model::spatial::{
    wgs84_ecef, Assumption, AssumptionKind, Confidence, ConfidenceKind, EvidenceMethod, Frame,
    LocatorKind, RegistrationEvidence, Registries, SourceLocator, SpatialContext,
};

use crate::codec::BundleDocument;

/// Versioned scene profile: nominal dimensions and tolerances, never global
/// constants.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneProfile {
    pub profile_version: u32,
    /// Nominal wall height (millimetres) when no source dimension exists.
    pub wall_height_mm: i64,
    /// Nominal ceiling height above the slab when no source dimension exists.
    pub ceiling_height_mm: i64,
    /// Nominal door/portal opening height.
    pub door_height_mm: i64,
    /// Source-property key the explicit unit height is read from (metres,
    /// finite), like the resolution profile's elevation key.
    pub height_property_key: String,
    /// A `Drawing` line within this distance (mm) of a space boundary
    /// corroborates it; a drawing line on no boundary is detail linework.
    pub corroboration_tolerance_mm: i64,
    /// Vertical extent of the neutral conveyance box for a transit footprint
    /// without graph endpoints.
    pub conveyance_height_mm: i64,
    /// Half the square cross-section of the neutral conveyance prism for a
    /// vertical graph connection (a point-to-point connection gets a
    /// nominal volume, never fabricated machinery).
    pub conveyance_half_width_mm: i64,
    /// Spacing between gate machines in an illustrative ticket-gate row.
    pub gate_pitch_mm: i64,
    /// Pedestal height of an illustrative ticket-gate machine.
    pub gate_height_mm: i64,
}

impl Default for SceneProfile {
    /// The versioned default scene profile (v1).
    fn default() -> Self {
        Self {
            profile_version: 1,
            wall_height_mm: 3000,
            ceiling_height_mm: 3000,
            door_height_mm: 2100,
            height_property_key: "height".to_string(),
            corroboration_tolerance_mm: 200,
            conveyance_height_mm: 3000,
            conveyance_half_width_mm: 600,
            gate_pitch_mm: 600,
            gate_height_mm: 1000,
        }
    }
}

/// Project `(lon, lat)` into the venue-local ENU frame as checked integer
/// millimetres, given the §8 frame's anchor ECEF position and basis. The
/// ellipsoid-height component is deliberately ignored — the authoritative Z
/// is each level's resolved plane, applied by the caller.
pub(crate) fn project_local_mm(frame: &Frame, lon: f64, lat: f64) -> [i64; 2] {
    let ecef = wgs84_ecef(lon, lat, 0.0);
    let d = [
        ecef[0] - frame.ecef_origin[0],
        ecef[1] - frame.ecef_origin[1],
        ecef[2] - frame.ecef_origin[2],
    ];
    let east = frame.enu_basis_ecef[0];
    let north = frame.enu_basis_ecef[1];
    let x = east[0] * d[0] + east[1] * d[1] + east[2] * d[2];
    let y = north[0] * d[0] + north[1] * d[1] + north[2] * d[2];
    [(x * 1000.0).round() as i64, (y * 1000.0).round() as i64]
}

/// One canonical floor's own geometry, as tile registration measures against
/// it: the level's unit polygons in venue-local ENU metres, on the level's
/// **source** plane.
///
/// Deliberately not the normalised scene Z. A tile package's heights are
/// whatever its transform produces; normalising one side and not the other
/// would compare two datums and call the difference a residual.
#[derive(Debug, Clone, PartialEq)]
pub struct VenueFloorGeometry {
    pub level_id: String,
    pub ordinal: f64,
    pub plane_z_m: f64,
    /// Unit outlines, venue-local metres, closing vertex dropped.
    pub rings: Vec<Vec<[f64; 2]>>,
    /// This floor's own names, in every locale the venue carries them: the
    /// corroboration altitude cannot supply (#81). Never a join key — labels
    /// agree with the mapping altitude chose, or contradict it, or say nothing.
    pub labels: Vec<String>,
}

/// Extract every canonical floor's unit geometry from a decoded bundle.
///
/// Levels with no §8 record or no unit polygons are omitted: there is nothing
/// to measure a tile level against, which the activation gate reports as an
/// unmapped level rather than a clean registration.
#[must_use]
pub fn venue_floor_geometry(document: &BundleDocument) -> Vec<VenueFloorGeometry> {
    let Some(spatial) = document.spatial_context.as_ref() else {
        return Vec::new();
    };
    let frame = &spatial.frame;
    let mut floors: Vec<VenueFloorGeometry> = Vec::new();
    for record in &spatial.levels {
        let rings: Vec<Vec<[f64; 2]>> = document
            .features
            .iter()
            .filter(|feature| feature.feature_type == FeatureType::Unit)
            .filter(|feature| feature.level_id.as_deref() == Some(record.level_id.as_str()))
            .filter_map(|feature| feature.geometry.as_ref().and_then(polygon_ring))
            .map(|ring| {
                ring.iter()
                    .map(|[lon, lat]| {
                        let local = project_local_mm(frame, *lon, *lat);
                        [local[0] as f64 / 1000.0, local[1] as f64 / 1000.0]
                    })
                    .collect()
            })
            .collect();
        if rings.is_empty() {
            continue;
        }
        // Every locale's label and short name. A Revit level key might resemble
        // either — "B1" the short name, or "B1F Yaesu" the label — so all of them
        // travel and the comparison decides.
        let level = document
            .levels
            .iter()
            .find(|level| level.id == record.level_id);
        let labels: Vec<String> = level
            .map(|level| {
                level
                    .short_name
                    .values()
                    .chain(level.label.values())
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        floors.push(VenueFloorGeometry {
            level_id: record.level_id.clone(),
            ordinal: record.ordinal,
            // `scene_z = source − offset`, so the source plane adds it back.
            plane_z_m: (record.resolved_scene_z_mm + frame.vertical_normalisation_offset_mm) as f64
                / 1000.0,
            rings,
            labels,
        });
    }
    floors
}

/// Twice the signed area of the ring (shoelace); positive = counter-clockwise.
fn signed_area2(ring: &[[i64; 2]]) -> i128 {
    let mut sum: i128 = 0;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        sum += i128::from(a[0]) * i128::from(b[1]) - i128::from(b[0]) * i128::from(a[1]);
    }
    sum
}

fn cross(a: [i64; 2], b: [i64; 2], c: [i64; 2]) -> i128 {
    i128::from(b[0] - a[0]) * i128::from(c[1] - a[1])
        - i128::from(b[1] - a[1]) * i128::from(c[0] - a[0])
}

/// Whether `p` lies inside (or on the boundary of) triangle `(a, b, c)`.
fn point_in_triangle(a: [i64; 2], b: [i64; 2], c: [i64; 2], p: [i64; 2]) -> bool {
    let d1 = cross(a, b, p);
    let d2 = cross(b, c, p);
    let d3 = cross(c, a, p);
    let has_neg = d1 < 0 || d2 < 0 || d3 < 0;
    let has_pos = d1 > 0 || d2 > 0 || d3 > 0;
    !(has_neg && has_pos)
}

/// Deterministic ear-clipping triangulation of a simple polygon ring (no
/// holes), returning triangle index triples into `ring`. Winding-independent:
/// the same geometric ring in either order yields the same triangle
/// partition. Collinear or degenerate rings yield fewer triangles.
pub(crate) fn triangulate_simple(ring: &[[i64; 2]]) -> Vec<[u32; 3]> {
    let n = ring.len();
    if n < 3 {
        return Vec::new();
    }
    let poly_sign = if signed_area2(ring) >= 0 {
        1i128
    } else {
        -1i128
    };
    let mut remaining: Vec<u32> = (0..n as u32).collect();
    let mut triangles: Vec<[u32; 3]> = Vec::new();

    let mut guard = 0usize;
    while remaining.len() > 3 {
        guard += 1;
        if guard > remaining.len() * remaining.len() {
            break; // malformed ring: never loop forever
        }
        let len = remaining.len();
        let mut clipped = false;
        for i in 0..len {
            let a_idx = remaining[(i + len - 1) % len] as usize;
            let b_idx = remaining[i] as usize;
            let c_idx = remaining[(i + 1) % len] as usize;
            let (a, b, c) = (ring[a_idx], ring[b_idx], ring[c_idx]);
            // Reflex vertices (or collinear) are never ears.
            if cross(a, b, c) * poly_sign <= 0 {
                continue;
            }
            // An ear must contain no other remaining vertex.
            let mut occluded = false;
            for &k in &remaining {
                let k_idx = k as usize;
                if k_idx == a_idx || k_idx == b_idx || k_idx == c_idx {
                    continue;
                }
                if point_in_triangle(a, b, c, ring[k_idx]) {
                    occluded = true;
                    break;
                }
            }
            if occluded {
                continue;
            }
            triangles.push([a_idx as u32, b_idx as u32, c_idx as u32]);
            remaining.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    if remaining.len() == 3 {
        triangles.push([remaining[0], remaining[1], remaining[2]]);
    }
    triangles
}

// -- Geometry extraction ---------------------------------------------------

/// The outer ring of one GeoJSON polygon coordinate array (`[ring, hole…]`).
fn polygon_outer_from_coords(poly: &Value) -> Option<Vec<[f64; 2]>> {
    let rings = poly.as_array()?;
    let outer = rings.first()?.as_array()?;
    let mut ring = Vec::with_capacity(outer.len());
    for position in outer {
        let coords = position.as_array()?;
        let (lon, lat) = (coords.first()?.as_f64()?, coords.get(1)?.as_f64()?);
        if !lon.is_finite() || !lat.is_finite() {
            return None;
        }
        ring.push([lon, lat]);
    }
    // Drop the repeated closing vertex of a closed ring so triangulation sees
    // a simple polygon, not a duplicated point.
    if ring.len() >= 2 && ring.first() == ring.last() {
        ring.pop();
    }
    (ring.len() >= 3).then_some(ring)
}

/// Every outer ring of `Polygon` / `MultiPolygon` / nested collections.
/// Point, line, and invalid rings are omitted rather than reported as empty
/// success.
fn polygon_outers(geometry: &Value) -> Vec<Vec<[f64; 2]>> {
    let Some(obj) = geometry.as_object() else {
        return Vec::new();
    };
    let Some(kind) = obj.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    match kind {
        "Polygon" => obj
            .get("coordinates")
            .and_then(polygon_outer_from_coords)
            .into_iter()
            .collect(),
        "MultiPolygon" => obj
            .get("coordinates")
            .and_then(Value::as_array)
            .map(|polys| polys.iter().filter_map(polygon_outer_from_coords).collect())
            .unwrap_or_default(),
        "GeometryCollection" => obj
            .get("geometries")
            .and_then(Value::as_array)
            .map(|children| children.iter().flat_map(polygon_outers).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The outer ring of the first `Polygon` in `geometry`, as `[lon, lat]`
/// pairs. `None` for point/line/collection or missing geometry.
fn polygon_ring(geometry: &Value) -> Option<Vec<[f64; 2]>> {
    polygon_outers(geometry).into_iter().next()
}

/// The vertices of the first `LineString` in `geometry`, as `[lon, lat]`.
#[allow(dead_code)] // portals (next pass) consume opening lines
fn linestring(geometry: &Value) -> Option<Vec<[f64; 2]>> {
    let obj = geometry.as_object()?;
    let kind = obj.get("type")?.as_str()?;
    if kind == "GeometryCollection" {
        for child in obj.get("geometries")?.as_array()? {
            if let Some(line) = linestring(child) {
                return Some(line);
            }
        }
        return None;
    }
    if kind != "LineString" {
        return None;
    }
    let positions = obj.get("coordinates")?.as_array()?;
    let mut line = Vec::with_capacity(positions.len());
    for position in positions {
        let coords = position.as_array()?;
        let (lon, lat) = (coords.first()?.as_f64()?, coords.get(1)?.as_f64()?);
        if !lon.is_finite() || !lat.is_finite() {
            return None;
        }
        line.push([lon, lat]);
    }
    (line.len() >= 2).then_some(line)
}

// -- Registry helpers ------------------------------------------------------

fn find_or_push_locator(registries: &mut Registries, value: &str) -> u32 {
    if let Some(index) = registries.locators.iter().position(|l| l.value == value) {
        return index as u32;
    }
    registries.locators.push(SourceLocator {
        kind: LocatorKind::FeatureId,
        value: value.to_string(),
        artifact_ref: None,
    });
    (registries.locators.len() - 1) as u32
}

fn push_evidence(
    registries: &mut Registries,
    source_locator_ref: u32,
    confidence_ref: Option<u32>,
    assumption_ref: Option<u32>,
    detail: &str,
) -> u32 {
    registries.registration_evidence.push(RegistrationEvidence {
        method: EvidenceMethod::DerivedFromVenueGeometry,
        source_locator_ref,
        transform_ref: None,
        confidence_ref,
        assumption_ref,
        detail: detail.to_string(),
    });
    (registries.registration_evidence.len() - 1) as u32
}

fn push_confidence(registries: &mut Registries, kind: ConfidenceKind, value: f64) -> u32 {
    registries.confidence.push(Confidence { kind, value });
    (registries.confidence.len() - 1) as u32
}

fn push_assumption(registries: &mut Registries, detail: &str) -> u32 {
    registries.assumptions.push(Assumption {
        kind: AssumptionKind::Nominal,
        detail: detail.to_string(),
    });
    (registries.assumptions.len() - 1) as u32
}

// -- Compiler --------------------------------------------------------------

/// A unique boundary edge keyed by (level id, ordered vertex pair).
type WallEdgeKey = (String, i64, i64, i64, i64);

/// The explicit height of a unit from its source properties (metres → mm),
/// when present and finite.
fn unit_height_mm(unit: &VenueFeature, profile: &SceneProfile) -> Option<i64> {
    let height = unit
        .source_properties
        .get(&profile.height_property_key)?
        .as_f64()?;
    height.is_finite().then(|| (height * 1000.0).round() as i64)
}

/// Compile the generated scene for a decoded document: slabs, ceilings,
/// surfaces, walls, portals, and conveyance (the latter three in later
/// passes). Appends source locators, evidence, confidence, and assumptions
/// into §8's registries; every primitive references them. `None` when the
/// venue has no computable scene content (no level geometry).
pub(crate) fn compile_scene(
    document: &BundleDocument,
    spatial: &mut SpatialContext,
    profile: &SceneProfile,
) -> Option<SceneSection> {
    let frame = &spatial.frame;
    let plane_z = |level_id: &str| -> Option<i64> {
        spatial
            .levels
            .iter()
            .find(|l| l.level_id == level_id)
            .map(|l| l.resolved_scene_z_mm)
    };

    let mut primitives: Vec<ScenePrimitive> = Vec::new();
    let mut measured_confidence: Option<u32> = None;
    let mut assumed_confidence: Option<u32> = None;
    let mut nominal_ceiling_assumption: Option<u32> = None;
    let mut nominal_wall_assumption: Option<u32> = None;
    let mut nominal_door_assumption: Option<u32> = None;
    let mut nominal_conveyance_assumption: Option<u32> = None;
    let mut nominal_gate_assumption: Option<u32> = None;
    let conf_ref = |registries: &mut Registries,
                    assumed: bool,
                    measured: &mut Option<u32>,
                    assumed_slot: &mut Option<u32>|
     -> u32 {
        if assumed {
            *assumed_slot
                .get_or_insert_with(|| push_confidence(registries, ConfidenceKind::Assumed, 0.3))
        } else {
            *measured
                .get_or_insert_with(|| push_confidence(registries, ConfidenceKind::Measured, 1.0))
        }
    };

    // -- Collect level and unit geometry in canonical order. ----------------
    struct LevelGeom {
        id: String,
        ring_index: usize,
        ring_xy: Vec<[i64; 2]>,
        z: i64,
    }
    struct UnitGeom {
        id: String,
        ring_index: usize,
        level_id: String,
        ring_xy: Vec<[i64; 2]>,
        z: i64,
        source_height_mm: Option<i64>,
        surface_index: Option<u32>,
        category: Option<String>,
    }

    let mut levels_data: Vec<LevelGeom> = Vec::new();
    for level in &document.levels {
        let Some(feature) = document
            .features
            .iter()
            .find(|f| f.feature_type == FeatureType::Level && f.id == level.id)
        else {
            continue;
        };
        let Some(z) = plane_z(&level.id) else {
            continue;
        };
        let Some(geometry) = feature.geometry.as_ref() else {
            continue;
        };
        for (ring_index, ring) in polygon_outers(geometry).into_iter().enumerate() {
            levels_data.push(LevelGeom {
                id: level.id.clone(),
                ring_index,
                ring_xy: ring
                    .iter()
                    .map(|[lon, lat]| project_local_mm(frame, *lon, *lat))
                    .collect(),
                z,
            });
        }
    }
    let mut units_data: Vec<UnitGeom> = Vec::new();
    for unit in document
        .features
        .iter()
        .filter(|f| f.feature_type == FeatureType::Unit)
    {
        let Some(level_id) = unit.level_id.as_deref() else {
            continue;
        };
        let Some(z) = plane_z(level_id) else { continue };
        let Some(geometry) = unit.geometry.as_ref() else {
            continue;
        };
        for (ring_index, ring) in polygon_outers(geometry).into_iter().enumerate() {
            units_data.push(UnitGeom {
                id: unit.id.clone(),
                ring_index,
                level_id: level_id.to_string(),
                ring_xy: ring
                    .iter()
                    .map(|[lon, lat]| project_local_mm(frame, *lon, *lat))
                    .collect(),
                z,
                source_height_mm: unit_height_mm(unit, profile),
                surface_index: None,
                category: unit.category.clone(),
            });
        }
    }
    if levels_data.is_empty() && units_data.is_empty() {
        return None;
    }

    // -- Slabs: one per level, on the resolved plane. -----------------------
    for level in &levels_data {
        let locator = find_or_push_locator(&mut spatial.registries, &level.id);
        let confidence_ref = conf_ref(
            &mut spatial.registries,
            false,
            &mut measured_confidence,
            &mut assumed_confidence,
        );
        let evidence_ref = push_evidence(
            &mut spatial.registries,
            locator,
            Some(confidence_ref),
            None,
            "floor slab from level polygon",
        );
        primitives.push(ScenePrimitive {
            id: if level.ring_index == 0 {
                format!("slab-{}", level.id)
            } else {
                format!("slab-{}-{}", level.id, level.ring_index)
            },
            role: PrimitiveRole::Surface,
            level_id: level.id.clone(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref,
            canonical_feature_id: Some(level.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![evidence_ref],
            geometry: PrimitiveGeometry::Mesh(ring_mesh_from_xy(&level.ring_xy, level.z)),
        });
    }

    // -- Ceilings and surfaces: one per unit. -------------------------------
    for unit in &mut units_data {
        let locator = find_or_push_locator(&mut spatial.registries, &unit.id);

        let surface_confidence = conf_ref(
            &mut spatial.registries,
            false,
            &mut measured_confidence,
            &mut assumed_confidence,
        );
        let surface_evidence = push_evidence(
            &mut spatial.registries,
            locator,
            Some(surface_confidence),
            None,
            "navigable surface from unit polygon",
        );
        let surface_index = primitives.len() as u32;
        primitives.push(ScenePrimitive {
            id: if unit.ring_index == 0 {
                format!("surface-{}", unit.id)
            } else {
                format!("surface-{}-{}", unit.id, unit.ring_index)
            },
            role: PrimitiveRole::Surface,
            level_id: unit.level_id.clone(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: surface_confidence,
            canonical_feature_id: Some(unit.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![surface_evidence],
            geometry: PrimitiveGeometry::Mesh(ring_mesh_from_xy(&unit.ring_xy, unit.z)),
        });
        unit.surface_index = Some(surface_index);

        let (height, assumed) = match unit.source_height_mm {
            Some(height) => (height, false),
            None => (profile.ceiling_height_mm, true),
        };
        let ceiling_confidence = conf_ref(
            &mut spatial.registries,
            assumed,
            &mut measured_confidence,
            &mut assumed_confidence,
        );
        let ceiling_assumption = if assumed {
            Some(*nominal_ceiling_assumption.get_or_insert_with(|| {
                push_assumption(
                    &mut spatial.registries,
                    &format!("nominal ceiling height {} mm", profile.ceiling_height_mm),
                )
            }))
        } else {
            None
        };
        let ceiling_evidence = push_evidence(
            &mut spatial.registries,
            locator,
            Some(ceiling_confidence),
            ceiling_assumption,
            if assumed {
                "ceiling at nominal height"
            } else {
                "ceiling at source height"
            },
        );
        primitives.push(ScenePrimitive {
            id: format!(
                "ceiling-{}{}",
                unit.id,
                if unit.ring_index == 0 {
                    String::new()
                } else {
                    format!("-{}", unit.ring_index)
                }
            ),
            role: PrimitiveRole::Ceiling,
            level_id: unit.level_id.clone(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: ceiling_confidence,
            canonical_feature_id: Some(unit.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![ceiling_evidence],
            geometry: PrimitiveGeometry::Mesh(ring_mesh_from_xy(&unit.ring_xy, unit.z + height)),
        });
    }
    // -- Walls: one vertical quad per unique unit-boundary edge. -------------
    // A shared edge between two units yields one wall at the minimum of the
    // two heights (source or nominal). Drawing lines never add geometry:
    // corroborated ones mark an existing boundary, all others are detail
    // linework.
    let nominal_wall = profile.wall_height_mm;
    let mut walls_by_level: Vec<(WallEdgeKey, Vec<u32>, bool)> = Vec::new();
    for unit in &units_data {
        let platform = unit
            .category
            .as_deref()
            .is_some_and(|c| c.eq_ignore_ascii_case("platform"));
        for (a, b) in ring_edges(&unit.ring_xy) {
            let key = if a <= b { (a, b) } else { (b, a) };
            match walls_by_level.iter_mut().find(|(k, _, _)| {
                k.0 == unit.level_id
                    && (k.1, k.2, k.3, k.4) == (key.0[0], key.0[1], key.1[0], key.1[1])
            }) {
                Some((_, heights, all_platform)) => {
                    heights.push(unit.source_height_mm.unwrap_or(profile.wall_height_mm) as u32);
                    *all_platform = *all_platform && platform;
                }
                None => walls_by_level.push((
                    (
                        unit.level_id.clone(),
                        key.0[0],
                        key.0[1],
                        key.1[0],
                        key.1[1],
                    ),
                    vec![unit.source_height_mm.unwrap_or(profile.wall_height_mm) as u32],
                    platform,
                )),
            }
        }
    }
    walls_by_level.sort_by(|a, b| a.0.cmp(&b.0));
    for ((level_id, ax, ay, bx, by), heights, all_platform) in walls_by_level {
        if all_platform {
            continue;
        }
        let z = plane_z(&level_id).expect("level has a plane");
        let height = *heights.iter().min().expect("at least one height") as i64;
        let assumed = height == nominal_wall;
        let wall_confidence = conf_ref(
            &mut spatial.registries,
            assumed,
            &mut measured_confidence,
            &mut assumed_confidence,
        );
        let wall_assumption = if assumed {
            Some(*nominal_wall_assumption.get_or_insert_with(|| {
                push_assumption(
                    &mut spatial.registries,
                    &format!("nominal wall height {} mm", profile.wall_height_mm),
                )
            }))
        } else {
            None
        };
        let level_locator = find_or_push_locator(&mut spatial.registries, &level_id);
        let wall_evidence = push_evidence(
            &mut spatial.registries,
            level_locator,
            Some(wall_confidence),
            wall_assumption,
            if assumed {
                "wall at nominal height"
            } else {
                "wall at source height"
            },
        );
        let n = primitives
            .iter()
            .filter(|p| p.role == PrimitiveRole::Wall && p.level_id == level_id)
            .count();
        primitives.push(ScenePrimitive {
            id: format!("wall-{level_id}-{n}"),
            role: PrimitiveRole::Wall,
            level_id,
            occlusion: OcclusionClass::Opaque,
            confidence_ref: wall_confidence,
            canonical_feature_id: None,
            source_locator_refs: vec![level_locator],
            evidence_refs: vec![wall_evidence],
            geometry: PrimitiveGeometry::Mesh(wall_mesh([ax, ay], [bx, by], z, height)),
        });
    }

    // -- Portals: openings on unit-boundary edges. ---------------------------
    let tolerance = profile.corroboration_tolerance_mm;
    let door_height = profile.door_height_mm;
    let door_assumption = *nominal_door_assumption.get_or_insert_with(|| {
        push_assumption(
            &mut spatial.registries,
            &format!("nominal door height {door_height} mm"),
        )
    });
    for opening in document
        .features
        .iter()
        .filter(|f| f.feature_type == FeatureType::Opening)
    {
        let Some(level_id) = opening.level_id.as_deref() else {
            continue;
        };
        let Some(z) = plane_z(level_id) else { continue };
        let Some(line) = opening.geometry.as_ref().and_then(linestring) else {
            continue;
        };
        let line_xy: Vec<[i64; 2]> = line
            .iter()
            .map(|[lon, lat]| project_local_mm(frame, *lon, *lat))
            .collect();
        let (p0, p1) = (line_xy[0], *line_xy.last().expect("line has two endpoints"));

        // The edge this opening sits on: the two units sharing it become the
        // portal's connects; an edge on the venue boundary connects the unit
        // to the level slab.
        // Collect the surfaces whose boundary edges the opening lies on.
        let mut matched_units: Vec<u32> = Vec::new();
        let mut matched_edge = false;
        for unit in &units_data {
            if unit.level_id != level_id {
                continue;
            }
            for (a, b) in ring_edges(&unit.ring_xy) {
                if !point_near_segment(p0, a, b, tolerance)
                    || !point_near_segment(p1, a, b, tolerance)
                {
                    continue;
                }
                // Both endpoints of the opening lie on this edge.
                matched_units.push(unit.surface_index.expect("unit surface exists"));
                matched_edge = true;
                break;
            }
        }
        if !matched_edge {
            continue; // an opening on no boundary is not part of the topology
        }
        matched_units.sort_unstable();
        matched_units.dedup();
        let (a_idx, b_idx) = if matched_units.len() >= 2 {
            (matched_units[0], matched_units[1])
        } else if matched_units.len() == 1 {
            // An opening on the venue boundary connects the unit to its slab.
            let slab_index = primitives
                .iter()
                .position(|p| p.id == format!("slab-{level_id}"))
                .expect("slab exists") as u32;
            (matched_units[0], slab_index)
        } else {
            continue;
        };

        let locator = find_or_push_locator(&mut spatial.registries, &opening.id);
        let confidence_ref = conf_ref(
            &mut spatial.registries,
            true,
            &mut measured_confidence,
            &mut assumed_confidence,
        );
        let evidence_ref = push_evidence(
            &mut spatial.registries,
            locator,
            Some(confidence_ref),
            Some(door_assumption),
            "portal opening at nominal door height",
        );
        primitives.push(ScenePrimitive {
            id: format!("portal-{}", opening.id),
            role: PrimitiveRole::Portal,
            level_id: level_id.to_string(),
            occlusion: OcclusionClass::Transparent,
            confidence_ref,
            canonical_feature_id: Some(opening.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![evidence_ref],
            geometry: PrimitiveGeometry::Portal {
                connects: (a_idx, b_idx),
                opening: wall_mesh(p0, p1, z, door_height),
            },
        });
    }

    // -- Conveyance: neutral forms only. --------------------------------------
    // A vertical graph edge connects its two level planes with a nominal
    // prism at the junctions' positions; a transit-category unit extrudes its
    // footprint by the nominal conveyance height. Both are kind Neutral —
    // detailed machinery is emitted only when evidence determines it, which
    // is never here.
    let neutral_assumption = *nominal_conveyance_assumption.get_or_insert_with(|| {
        push_assumption(
            &mut spatial.registries,
            "neutral conveyance form (never fabricated machinery)",
        )
    });
    let net_junction_locator = {
        let index = spatial
            .registries
            .locators
            .iter()
            .position(|l| l.kind == LocatorKind::LayerName && l.value == "net_junction");
        match index {
            Some(i) => i as u32,
            None => {
                spatial.registries.locators.push(SourceLocator {
                    kind: LocatorKind::LayerName,
                    value: "net_junction".to_string(),
                    artifact_ref: None,
                });
                (spatial.registries.locators.len() - 1) as u32
            }
        }
    };
    let conveyance_confidence = conf_ref(
        &mut spatial.registries,
        true,
        &mut measured_confidence,
        &mut assumed_confidence,
    );
    let mut conveyance_count = 0usize;

    if let Some(graph) = &document.graph {
        let ordinal_planes: Vec<(f64, i64)> = spatial
            .levels
            .iter()
            .map(|l| (l.ordinal, l.resolved_scene_z_mm))
            .collect();
        for edge in &graph.edges {
            let from = &graph.nodes[edge.from as usize];
            let to = &graph.nodes[edge.to as usize];
            if from.ordinal == to.ordinal {
                continue;
            }
            let Some(&(_, z_from)) = ordinal_planes
                .iter()
                .find(|(ordinal, _)| *ordinal == from.ordinal)
            else {
                continue;
            };
            let Some(&(_, z_to)) = ordinal_planes
                .iter()
                .find(|(ordinal, _)| *ordinal == to.ordinal)
            else {
                continue;
            };
            let c_from = project_local_mm(frame, from.lon, from.lat);
            let c_to = project_local_mm(frame, to.lon, to.lat);
            let evidence = push_evidence(
                &mut spatial.registries,
                net_junction_locator,
                Some(conveyance_confidence),
                Some(neutral_assumption),
                "neutral conveyance from a vertical graph connection",
            );
            primitives.push(ScenePrimitive {
                id: format!("conveyance-{}", conveyance_count),
                role: PrimitiveRole::Conveyance,
                level_id: from_level_for(spatial, from.ordinal).unwrap_or_default(),
                occlusion: OcclusionClass::Opaque,
                confidence_ref: conveyance_confidence,
                canonical_feature_id: None,
                source_locator_refs: vec![net_junction_locator],
                evidence_refs: vec![evidence],
                geometry: PrimitiveGeometry::Conveyance {
                    kind: ConveyanceKind::Neutral,
                    mesh: prism_mesh(c_from, c_to, z_from, z_to, profile.conveyance_half_width_mm),
                },
            });
            conveyance_count += 1;
        }
    }

    for unit in &units_data {
        if !is_transit_unit(document, &unit.id) {
            continue;
        }
        let locator = find_or_push_locator(&mut spatial.registries, &unit.id);
        let evidence = push_evidence(
            &mut spatial.registries,
            locator,
            Some(conveyance_confidence),
            Some(neutral_assumption),
            "neutral conveyance from a transit footprint",
        );
        primitives.push(ScenePrimitive {
            id: format!("conveyance-{}", conveyance_count),
            role: PrimitiveRole::Conveyance,
            level_id: unit.level_id.clone(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: conveyance_confidence,
            canonical_feature_id: Some(unit.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![evidence],
            geometry: PrimitiveGeometry::Conveyance {
                kind: ConveyanceKind::Neutral,
                mesh: extrude_ring_mesh(
                    &unit.ring_xy,
                    unit.z,
                    unit.z + profile.conveyance_height_mm,
                ),
            },
        });
        conveyance_count += 1;
    }

    // -- Fixtures: illustrative ticket-gate rows. -----------------------------
    // A fixture feature becomes a row of fare-gate machines along its long
    // axis — the gates Japanese stations line their concourses with. The
    // position is measured; the form is an illustration, registered as an
    // assumption like every other nominal shape.
    let gate_assumption = *nominal_gate_assumption.get_or_insert_with(|| {
        push_assumption(
            &mut spatial.registries,
            "illustrative ticket-gate row (never fabricated machinery detail)",
        )
    });
    for fixture in document
        .features
        .iter()
        .filter(|f| f.feature_type == FeatureType::Fixture)
    {
        let Some(level_id) = fixture.level_id.as_deref() else {
            continue;
        };
        let Some(z) = plane_z(level_id) else {
            continue;
        };
        let Some(ring) = fixture.geometry.as_ref().and_then(polygon_ring) else {
            continue;
        };
        let ring_xy: Vec<[i64; 2]> = ring
            .iter()
            .map(|[lon, lat]| project_local_mm(frame, *lon, *lat))
            .collect();
        let locator = find_or_push_locator(&mut spatial.registries, &fixture.id);
        let confidence_ref = conf_ref(
            &mut spatial.registries,
            true,
            &mut measured_confidence,
            &mut assumed_confidence,
        );
        let evidence_ref = push_evidence(
            &mut spatial.registries,
            locator,
            Some(confidence_ref),
            Some(gate_assumption),
            "ticket-gate row at the measured fixture position",
        );
        primitives.push(ScenePrimitive {
            id: format!("fixture-{}", fixture.id),
            role: PrimitiveRole::Fixture,
            level_id: level_id.to_string(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref,
            canonical_feature_id: Some(fixture.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![evidence_ref],
            geometry: PrimitiveGeometry::Mesh(ticket_gate_row(&ring_xy, z, profile)),
        });
    }

    Some(SceneSection {
        primitives,
        descriptor: None,
    })
}

/// The level id whose record carries `ordinal`, for conveying a graph
/// connection's level membership.
fn from_level_for(spatial: &SpatialContext, ordinal: f64) -> Option<String> {
    spatial
        .levels
        .iter()
        .find(|l| l.ordinal == ordinal)
        .map(|l| l.level_id.clone())
}

/// Whether a unit's source category marks it as a conveyance footprint
/// (stairs, escalator, elevator, ramp, lift, or transit).
fn is_transit_unit(document: &BundleDocument, unit_id: &str) -> bool {
    let Some(unit) = document.features.iter().find(|f| f.id == unit_id) else {
        return false;
    };
    let Some(category) = unit
        .source_properties
        .get("category")
        .and_then(|v| v.as_str())
    else {
        return false;
    };
    ["stair", "escalator", "elevator", "ramp", "lift", "transit"]
        .iter()
        .any(|token| category.to_ascii_lowercase().contains(token))
}

/// A closed box from a bottom center at `z0` to a top center at `z1`, with a
/// square cross-section of `2 × half_width` millimetres.
fn prism_mesh(bottom: [i64; 2], top: [i64; 2], z0: i64, z1: i64, half_width: i64) -> Mesh {
    let (bx, by, tx, ty) = (bottom[0], bottom[1], top[0], top[1]);
    box_mesh(
        &[
            [bx - half_width, by - half_width],
            [bx + half_width, by - half_width],
            [bx + half_width, by + half_width],
            [bx - half_width, by + half_width],
        ],
        &[
            [tx - half_width, ty - half_width],
            [tx + half_width, ty - half_width],
            [tx + half_width, ty + half_width],
            [tx - half_width, ty + half_width],
        ],
        z0,
        z1,
    )
}

/// A closed box from a bottom ring (same XY) at `z0` to the top at `z1`.
fn extrude_ring_mesh(ring: &[[i64; 2]], z0: i64, z1: i64) -> Mesh {
    box_mesh(ring, ring, z0, z1)
}

/// A closed box: `bottom` and `top` rings of equal length, at `z0`/`z1`.
/// Faces: bottom + top triangulated, one quad per side.
fn box_mesh(bottom: &[[i64; 2]], top: &[[i64; 2]], z0: i64, z1: i64) -> Mesh {
    let n = bottom.len();
    let mut positions = Vec::with_capacity(2 * n);
    for [x, y] in bottom {
        positions.push([*x, *y, z0]);
    }
    for [x, y] in top {
        positions.push([*x, *y, z1]);
    }
    let mut faces = Vec::new();
    for triangle in triangulate_simple(bottom) {
        faces.push(triangle);
    }
    let mut top_faces = Vec::new();
    for [a, b, c] in triangulate_simple(top) {
        top_faces.push([a + n as u32, b + n as u32, c + n as u32]);
    }
    // Orient the top faces outward (reverse winding).
    for [a, b, c] in top_faces {
        faces.push([c, b, a]);
    }
    for i in 0..n {
        let (a, b) = (i as u32, ((i + 1) % n) as u32);
        let (c, d) = (b + n as u32, a + n as u32);
        faces.push([a, b, c]);
        faces.push([a, c, d]);
    }
    Mesh { positions, faces }
}

/// Consecutive ring edges as vertex pairs.
fn ring_edges(ring: &[[i64; 2]]) -> Vec<([i64; 2], [i64; 2])> {
    let mut edges = Vec::with_capacity(ring.len());
    for i in 0..ring.len() {
        edges.push((ring[i], ring[(i + 1) % ring.len()]));
    }
    edges
}

/// A vertical quad from `z` to `z + height` spanning `a`→`b`.
fn wall_mesh(a: [i64; 2], b: [i64; 2], z: i64, height: i64) -> Mesh {
    Mesh {
        positions: vec![
            [a[0], a[1], z],
            [b[0], b[1], z],
            [b[0], b[1], z + height],
            [a[0], a[1], z + height],
        ],
        faces: vec![[0, 1, 2], [0, 2, 3]],
    }
}

/// Merge `src` into `dst`, re-basing its face indices.
fn append_mesh(dst: &mut Mesh, src: Mesh) {
    let offset = dst.positions.len() as u32;
    dst.positions.extend(src.positions);
    for face in src.faces {
        dst.faces
            .push([face[0] + offset, face[1] + offset, face[2] + offset]);
    }
}

/// An illustrative Japanese fare-gate row along a fixture footprint's long
/// axis: evenly spaced machines, each a pedestal, flap-bar wings reaching to
/// both lane edges, and an IC reader head on top. Boxes only — an
/// illustration of what the gates do, never fabricated machinery detail.
fn ticket_gate_row(ring_xy: &[[i64; 2]], z: i64, profile: &SceneProfile) -> Mesh {
    let Some((min, max)) = ring_xy.iter().fold(None::<([i64; 2], [i64; 2])>, |acc, p| {
        Some(match acc {
            None => (*p, *p),
            Some((lo, hi)) => (
                [lo[0].min(p[0]), lo[1].min(p[1])],
                [hi[0].max(p[0]), hi[1].max(p[1])],
            ),
        })
    }) else {
        return Mesh {
            positions: Vec::new(),
            faces: Vec::new(),
        };
    };
    let (dx, dy) = ((max[0] - min[0]) as f64, (max[1] - min[1]) as f64);
    let (origin, u, v, length, cross) = if dx >= dy {
        (
            [min[0] as f64, (min[1] + max[1]) as f64 / 2.0],
            [1.0, 0.0],
            [0.0, 1.0],
            dx,
            dy,
        )
    } else {
        (
            [(min[0] + max[0]) as f64 / 2.0, min[1] as f64],
            [0.0, 1.0],
            [1.0, 0.0],
            dy,
            dx,
        )
    };
    if length < 300.0 || cross < 200.0 {
        // Too small to read as a gate row: nothing beats drawing nothing.
        return Mesh {
            positions: Vec::new(),
            faces: Vec::new(),
        };
    }
    let half_cross = ((cross / 2.0) as i64 - 40).min(600) as f64;
    let machines = ((length / profile.gate_pitch_mm as f64).round() as usize).max(1);
    let at = |t: f64, s: f64| -> [i64; 2] {
        [
            (origin[0] + u[0] * (t * length) + v[0] * s).round() as i64,
            (origin[1] + u[1] * (t * length) + v[1] * s).round() as i64,
        ]
    };
    let rect = |c: [i64; 2], half_u: f64, half_v: f64| -> Vec<[i64; 2]> {
        vec![
            [
                c[0] - (u[0] * half_u).round() as i64 - (v[0] * half_v).round() as i64,
                c[1] - (u[1] * half_u).round() as i64 - (v[1] * half_v).round() as i64,
            ],
            [
                c[0] + (u[0] * half_u).round() as i64 - (v[0] * half_v).round() as i64,
                c[1] + (u[1] * half_u).round() as i64 - (v[1] * half_v).round() as i64,
            ],
            [
                c[0] + (u[0] * half_u).round() as i64 + (v[0] * half_v).round() as i64,
                c[1] + (u[1] * half_u).round() as i64 + (v[1] * half_v).round() as i64,
            ],
            [
                c[0] - (u[0] * half_u).round() as i64 + (v[0] * half_v).round() as i64,
                c[1] - (u[1] * half_u).round() as i64 + (v[1] * half_v).round() as i64,
            ],
        ]
    };
    let mut mesh = Mesh {
        positions: Vec::new(),
        faces: Vec::new(),
    };
    for i in 0..machines {
        let t = (i as f64 + 0.5) / machines as f64;
        let c = at(t, 0.0);
        // Pedestal: a narrow body across the lane's centre.
        append_mesh(
            &mut mesh,
            box_mesh(
                &rect(c, 150.0, 120.0),
                &rect(c, 150.0, 120.0),
                z,
                z + profile.gate_height_mm,
            ),
        );
        // Flap-bar wings from the body out to both lane edges.
        for s in [-1.0, 1.0] {
            let inner = at(t, s * 120.0);
            let outer = at(t, s * half_cross);
            let mid = [(inner[0] + outer[0]) / 2, (inner[1] + outer[1]) / 2];
            let half_len =
                (((outer[0] - inner[0]) as f64 * u[0] + (outer[1] - inner[1]) as f64 * u[1]).abs()
                    / 2.0)
                    .max(1.0)
                    + (((outer[0] - inner[0]) as f64 * v[0] + (outer[1] - inner[1]) as f64 * v[1])
                        .abs()
                        / 2.0);
            append_mesh(
                &mut mesh,
                box_mesh(
                    &rect(mid, 40.0, half_len),
                    &rect(mid, 40.0, half_len),
                    z + 550,
                    z + 650,
                ),
            );
        }
        // IC reader head on the body top.
        append_mesh(
            &mut mesh,
            box_mesh(
                &rect(c, 170.0, 140.0),
                &rect(c, 170.0, 140.0),
                z + profile.gate_height_mm,
                z + profile.gate_height_mm + 150,
            ),
        );
    }
    mesh
}

/// A projected, triangulated mesh from an already-projected ring at `z`.
fn ring_mesh_from_xy(xy: &[[i64; 2]], z: i64) -> Mesh {
    Mesh {
        positions: xy.iter().map(|[x, y]| [*x, *y, z]).collect(),
        faces: triangulate_simple(xy),
    }
}

/// Squared distance from `p` to the segment `a`–`b`.
fn point_segment_dist2(p: [i64; 2], a: [i64; 2], b: [i64; 2]) -> i128 {
    let (ax, ay, bx, by, px, py) = (a[0], a[1], b[0], b[1], p[0], p[1]);
    let dx = i128::from(bx - ax);
    let dy = i128::from(by - ay);
    let len2 = dx * dx + dy * dy;
    if len2 == 0 {
        let (qx, qy) = (i128::from(px - ax), i128::from(py - ay));
        return qx * qx + qy * qy;
    }
    let t = (i128::from(px - ax) * dx + i128::from(py - ay) * dy)
        .max(0)
        .min(len2);
    let (cx, cy) = (
        i128::from(ax) + dx * t / len2,
        i128::from(ay) + dy * t / len2,
    );
    let (qx, qy) = (i128::from(px) - cx, i128::from(py) - cy);
    qx * qx + qy * qy
}

/// Whether `p` is within `tolerance` millimetres of the segment `a`–`b`.
fn point_near_segment(p: [i64; 2], a: [i64; 2], b: [i64; 2], tolerance: i64) -> bool {
    let t = i128::from(tolerance);
    point_segment_dist2(p, a, b) <= t * t
}

#[cfg(test)]
mod tests {
    use kiriko_model::spatial::{enu_basis_ecef, wgs84_ecef, Axes, Frame, LengthUnit};

    use super::{project_local_mm, ticket_gate_row, triangulate_simple, SceneProfile};

    fn test_frame() -> Frame {
        let anchor = [139.767, 35.681];
        let ecef_origin = wgs84_ecef(anchor[0], anchor[1], 0.0);
        Frame {
            anchor,
            ecef_origin,
            enu_basis_ecef: enu_basis_ecef(anchor[0], anchor[1]),
            world_translation: ecef_origin,
            axes: Axes::EastNorthUp,
            unit: LengthUnit::Millimetre,
            vertical_normalisation_offset_mm: 0,
            datum_ref: 0,
            anchor_evidence_ref: 0,
        }
    }

    #[test]
    fn the_default_scene_profile_is_version_one() {
        let profile = SceneProfile::default();
        assert_eq!(profile.profile_version, 1);
        assert_eq!(profile.wall_height_mm, 3000);
        assert_eq!(profile.ceiling_height_mm, 3000);
        assert_eq!(profile.door_height_mm, 2100);
        assert_eq!(profile.height_property_key, "height");
        assert_eq!(profile.corroboration_tolerance_mm, 200);
        assert_eq!(profile.conveyance_height_mm, 3000);
        assert_eq!(profile.conveyance_half_width_mm, 600);
        assert_eq!(profile.gate_pitch_mm, 600);
        assert_eq!(profile.gate_height_mm, 1000);
    }

    #[test]
    fn ticket_gate_row_places_machines_along_the_long_axis() {
        let profile = SceneProfile::default();
        let ring = vec![[0, 0], [6_000, 0], [6_000, 2_000], [0, 2_000]];
        let mesh = ticket_gate_row(&ring, 4_000, &profile);
        // Ten machines at the default 600 mm pitch; each is four boxes —
        // pedestal, two flap wings, and a reader head — of eight positions.
        assert_eq!(mesh.positions.len(), 10 * 4 * 8);
        let top = mesh
            .positions
            .iter()
            .map(|p| p[2])
            .max()
            .expect("positions");
        assert_eq!(top, 4_000 + 1_000 + 150, "reader head caps the machine");
        let xs: std::collections::HashSet<i64> = mesh.positions.iter().map(|p| p[0]).collect();
        assert!(xs.len() >= 10, "machines spread along the long axis");
    }

    #[test]
    fn a_fixture_too_small_for_a_gate_row_stays_empty() {
        let profile = SceneProfile::default();
        let ring = vec![[0, 0], [200, 0], [200, 100], [0, 100]];
        let mesh = ticket_gate_row(&ring, 0, &profile);
        assert!(mesh.positions.is_empty(), "nothing beats a phantom gate");
    }

    #[test]
    fn the_anchor_projects_to_the_origin() {
        let frame = test_frame();
        assert_eq!(project_local_mm(&frame, 139.767, 35.681), [0, 0]);
    }

    #[test]
    fn a_point_east_and_north_of_the_anchor_projects_to_positive_millimetres() {
        let frame = test_frame();
        // One arc-second east ≈ 24.9 m, one arc-second north ≈ 30.9 m at this
        // latitude; assert the sign and rough magnitude rather than exact
        // geodetic values (the projection is the §8 ENU frame by definition).
        let [x, y] = project_local_mm(&frame, 139.767 + 1.0 / 3600.0, 35.681 + 1.0 / 3600.0);
        assert!(x > 20_000 && x < 30_000, "east component ~25 m: {x}");
        assert!(y > 25_000 && y < 35_000, "north component ~30.9 m: {y}");
    }

    #[test]
    fn the_projection_is_deterministic() {
        let frame = test_frame();
        let a = project_local_mm(&frame, 139.7662, 35.6806);
        let b = project_local_mm(&frame, 139.7662, 35.6806);
        assert_eq!(a, b);
    }

    #[test]
    fn a_rectangle_triangulates_into_two_triangles() {
        let ring = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
        let triangles = triangulate_simple(&ring);
        assert_eq!(triangles.len(), 2);
        // Every index in range.
        for triangle in &triangles {
            for index in triangle {
                assert!((*index as usize) < ring.len());
            }
        }
    }

    #[test]
    fn a_concave_polygon_triangulates_to_n_minus_two_triangles() {
        // L-shaped ring (concave).
        let ring = [
            [0, 0],
            [2000, 0],
            [2000, 1000],
            [1000, 1000],
            [1000, 2000],
            [0, 2000],
        ];
        let triangles = triangulate_simple(&ring);
        assert_eq!(triangles.len(), 4, "n − 2 triangles for a simple polygon");
        for triangle in &triangles {
            for index in triangle {
                assert!((*index as usize) < ring.len());
            }
        }
    }

    #[test]
    fn triangulation_is_orientation_independent_and_deterministic() {
        let clockwise = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
        let counter_clockwise = [[0, 0], [0, 1000], [1000, 1000], [1000, 0]];
        // Canonical form: each triangle as a sorted index triple, the list
        // sorted — the same geometric partition regardless of winding.
        let canonical = |triangles: Vec<[u32; 3]>| -> Vec<Vec<u32>> {
            let mut out: Vec<Vec<u32>> = triangles
                .into_iter()
                .map(|mut triangle| {
                    triangle.sort();
                    triangle.to_vec()
                })
                .collect();
            out.sort();
            out
        };
        assert_eq!(
            canonical(triangulate_simple(&clockwise)),
            canonical(triangulate_simple(&counter_clockwise)),
            "the same geometric ring yields the same triangle partition"
        );
        assert_eq!(
            triangulate_simple(&clockwise),
            triangulate_simple(&clockwise),
            "deterministic across calls"
        );
    }
}
