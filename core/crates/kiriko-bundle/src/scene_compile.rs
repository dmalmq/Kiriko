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
    Mesh, OcclusionClass, PrimitiveGeometry, PrimitiveRole, ScenePrimitive, SceneSection,
};
use kiriko_model::spatial::{
    Assumption, AssumptionKind, Confidence, ConfidenceKind, EvidenceMethod, Frame, LocatorKind,
    Registries, RegistrationEvidence, SourceLocator, SpatialContext, wgs84_ecef,
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
    let poly_sign = if signed_area2(ring) >= 0 { 1i128 } else { -1i128 };
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

/// The outer ring of the first `Polygon` in `geometry`, as `[lon, lat]`
/// pairs. `None` for point/line/collection or missing geometry.
fn polygon_ring(geometry: &Value) -> Option<Vec<[f64; 2]>> {
    let obj = geometry.as_object()?;
    let kind = obj.get("type")?.as_str()?;
    if kind == "GeometryCollection" {
        for child in obj.get("geometries")?.as_array()? {
            if let Some(ring) = polygon_ring(child) {
                return Some(ring);
            }
        }
        return None;
    }
    if kind != "Polygon" {
        return None;
    }
    let rings = obj.get("coordinates")?.as_array()?;
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

/// The projected, triangulated mesh for a polygon ring at `z`.
fn ring_mesh(frame: &Frame, ring: &[[f64; 2]], z: i64) -> Mesh {
    let xy: Vec<[i64; 2]> = ring.iter().map(|[lon, lat]| project_local_mm(frame, *lon, *lat)).collect();
    let faces = triangulate_simple(&xy);
    Mesh {
        positions: xy.iter().map(|[x, y]| [*x, *y, z]).collect(),
        faces,
    }
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

/// The explicit height of a unit from its source properties (metres → mm),
/// when present and finite.
fn unit_height_mm(unit: &VenueFeature, profile: &SceneProfile) -> Option<i64> {
    let height = unit.source_properties.get(&profile.height_property_key)?.as_f64()?;
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

    let mut primitives = Vec::new();
    let mut measured_confidence: Option<u32> = None;
    let mut assumed_confidence: Option<u32> = None;
    let mut nominal_ceiling_assumption: Option<u32> = None;
    let conf_ref = |registries: &mut Registries,
                    assumed: bool,
                    measured: &mut Option<u32>,
                    assumed_slot: &mut Option<u32>|
     -> u32 {
        if assumed {
            *assumed_slot.get_or_insert_with(|| push_confidence(registries, ConfidenceKind::Assumed, 0.3))
        } else {
            *measured.get_or_insert_with(|| push_confidence(registries, ConfidenceKind::Measured, 1.0))
        }
    };

    let mut emitted = false;

    // Slabs: one per level with a polygon, on the resolved plane.
    for level in &document.levels {
        let Some(level_feature) = document
            .features
            .iter()
            .find(|f| f.feature_type == FeatureType::Level && f.id == level.id)
        else {
            continue;
        };
        let Some(ring) = level_feature.geometry.as_ref().and_then(polygon_ring) else {
            continue;
        };
        let Some(z) = plane_z(&level.id) else {
            continue;
        };
        emitted = true;
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
            id: format!("slab-{}", level.id),
            role: PrimitiveRole::Surface,
            level_id: level.id.clone(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref,
            canonical_feature_id: Some(level.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![evidence_ref],
            geometry: PrimitiveGeometry::Mesh(ring_mesh(frame, &ring, z)),
        });
    }

    // Ceilings and surfaces: one per unit.
    for unit in document
        .features
        .iter()
        .filter(|f| f.feature_type == FeatureType::Unit)
    {
        let Some(level_id) = unit.level_id.as_deref() else { continue };
        let Some(z) = plane_z(level_id) else { continue };
        let Some(ring) = unit.geometry.as_ref().and_then(polygon_ring) else {
            continue;
        };
        emitted = true;
        let locator = find_or_push_locator(&mut spatial.registries, &unit.id);
        let source_height = unit_height_mm(unit, profile);

        // Surface: the navigable unit polygon on the plane.
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
        primitives.push(ScenePrimitive {
            id: format!("surface-{}", unit.id),
            role: PrimitiveRole::Surface,
            level_id: level_id.to_string(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: surface_confidence,
            canonical_feature_id: Some(unit.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![surface_evidence],
            geometry: PrimitiveGeometry::Mesh(ring_mesh(frame, &ring, z)),
        });

        // Ceiling: the unit polygon at the unit's height (source or nominal).
        let (height, assumed) = match source_height {
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
            if assumed { "ceiling at nominal height" } else { "ceiling at source height" },
        );
        primitives.push(ScenePrimitive {
            id: format!("ceiling-{}", unit.id),
            role: PrimitiveRole::Ceiling,
            level_id: level_id.to_string(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: ceiling_confidence,
            canonical_feature_id: Some(unit.id.clone()),
            source_locator_refs: vec![locator],
            evidence_refs: vec![ceiling_evidence],
            geometry: PrimitiveGeometry::Mesh(ring_mesh(frame, &ring, z + height)),
        });
    }

    if !emitted {
        return None;
    }
    Some(SceneSection {
        primitives,
        descriptor: None,
    })
}

#[cfg(test)]
mod tests {
    use kiriko_model::spatial::{Axes, Frame, LengthUnit, enu_basis_ecef, wgs84_ecef};

    use super::{SceneProfile, project_local_mm, triangulate_simple};

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
        let ring = [[0, 0], [2000, 0], [2000, 1000], [1000, 1000], [1000, 2000], [0, 2000]];
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
