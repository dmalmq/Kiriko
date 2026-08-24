//! The Generated scene producer: a bundle's §9 semantic primitives plus §8
//! spatial context compiled into the same KSC1 render document the Tiles
//! deriver emits, so one renderer serves both sources (#23 D4).

use kiriko_model::model::{FeatureType, VenueFeature};
use kiriko_model::scene::{
    ConveyanceKind, Mesh, OcclusionClass as SceneOcclusion, PrimitiveGeometry, PrimitiveRole,
    ScenePrimitive, SceneSection,
};
use kiriko_model::spatial::{
    enu_basis_ecef, wgs84_ecef, Assumption, AssumptionKind, Axes, Confidence, ConfidenceKind,
    Datum, Ellipsoid, EvidenceMethod, Frame, LengthUnit, LevelRecord, LocatorKind,
    RegistrationEvidence, Registries, ResolutionMethod, SourceLocator, SpatialContext,
};
use kiriko_scene::{
    compile_generated_scene, decode_normal_oct, encode_scene, OcclusionClass, SemanticRole,
};
use std::collections::BTreeMap;

const ANCHOR_LON: f64 = 139.7671;
const ANCHOR_LAT: f64 = 35.6812;

/// Two levels, planes 0 mm and 4,500 mm.
fn spatial_context() -> SpatialContext {
    let registries = Registries {
        artifacts: Vec::new(),
        locators: vec![
            SourceLocator {
                kind: LocatorKind::FeatureId,
                value: "level-b1".to_string(),
                artifact_ref: None,
            },
            SourceLocator {
                kind: LocatorKind::FeatureId,
                value: "unit-walkway".to_string(),
                artifact_ref: None,
            },
        ],
        datums: vec![Datum {
            name: "WGS84".to_string(),
            ellipsoid: Ellipsoid {
                semi_major_metres: 6_378_137.0,
                inverse_flattening: 298.257_223_563,
            },
        }],
        transforms: Vec::new(),
        registration_evidence: vec![RegistrationEvidence {
            method: EvidenceMethod::DerivedFromVenueGeometry,
            source_locator_ref: 0,
            transform_ref: None,
            confidence_ref: Some(0),
            assumption_ref: None,
            detail: "anchor from venue bounds centre".to_string(),
        }],
        assumptions: vec![Assumption {
            kind: AssumptionKind::Nominal,
            detail: "nominal 4.5 m spacing".to_string(),
        }],
        confidence: vec![
            Confidence {
                kind: ConfidenceKind::Measured,
                value: 1.0,
            },
            Confidence {
                kind: ConfidenceKind::Assumed,
                value: 0.4,
            },
        ],
        manual_provenance: Vec::new(),
    };

    SpatialContext {
        frame: Frame {
            anchor: [ANCHOR_LON, ANCHOR_LAT],
            ecef_origin: wgs84_ecef(ANCHOR_LON, ANCHOR_LAT, 0.0),
            enu_basis_ecef: enu_basis_ecef(ANCHOR_LON, ANCHOR_LAT),
            world_translation: wgs84_ecef(ANCHOR_LON, ANCHOR_LAT, 0.0),
            axes: Axes::EastNorthUp,
            unit: LengthUnit::Millimetre,
            vertical_normalisation_offset_mm: 0,
            datum_ref: 0,
            anchor_evidence_ref: 0,
        },
        registries,
        levels: vec![
            LevelRecord {
                level_id: "level-b1".to_string(),
                ordinal: -1.0,
                source_elevation_m: Some(-6.5),
                network_difference_mm: None,
                resolved_scene_z_mm: 0,
                method: ResolutionMethod::ImportedElevation,
                confidence_ref: 0,
                evidence_refs: vec![0],
                override_elevation_m: None,
                override_ref: None,
            },
            LevelRecord {
                level_id: "level-1f".to_string(),
                ordinal: 0.0,
                source_elevation_m: None,
                network_difference_mm: None,
                resolved_scene_z_mm: 4_500,
                method: ResolutionMethod::NominalSpacing,
                confidence_ref: 1,
                evidence_refs: vec![0],
                override_elevation_m: None,
                override_ref: None,
            },
        ],
        source_properties: BTreeMap::new(),
    }
}

/// A 2 m square ring at plane `z_mm`, wound counter-clockwise.
fn square(z_mm: i64) -> Mesh {
    Mesh {
        positions: vec![
            [0, 0, z_mm],
            [2_000, 0, z_mm],
            [2_000, 2_000, z_mm],
            [0, 2_000, z_mm],
        ],
        faces: vec![[0, 1, 2], [0, 2, 3]],
    }
}

/// A vertical quad from `z_mm` up 3 m — a wall panel along y = 0.
fn wall(z_mm: i64) -> Mesh {
    Mesh {
        positions: vec![
            [0, 0, z_mm],
            [2_000, 0, z_mm],
            [2_000, 0, z_mm + 3_000],
            [0, 0, z_mm + 3_000],
        ],
        faces: vec![[0, 1, 2], [0, 2, 3]],
    }
}

/// A doorway quad on another line entirely: the shared fixture keeps its
/// portal off the wall panel, because doorways that cut their host wall are
/// the dedicated tests' subject below.
fn off_wall_doorway(z_mm: i64) -> Mesh {
    Mesh {
        positions: vec![
            [4_000, 4_000, z_mm],
            [6_000, 4_000, z_mm],
            [6_000, 4_000, z_mm + 2_100],
            [4_000, 4_000, z_mm + 2_100],
        ],
        faces: vec![[0, 1, 2], [0, 2, 3]],
    }
}

fn primitive(
    id: &str,
    role: PrimitiveRole,
    level_id: &str,
    canonical: Option<&str>,
    geometry: PrimitiveGeometry,
) -> ScenePrimitive {
    ScenePrimitive {
        id: id.to_string(),
        role,
        level_id: level_id.to_string(),
        occlusion: SceneOcclusion::Opaque,
        confidence_ref: 0,
        canonical_feature_id: canonical.map(str::to_string),
        source_locator_refs: vec![0],
        evidence_refs: vec![0],
        geometry,
    }
}

/// One primitive of every §9 role across two levels.
fn scene_section() -> SceneSection {
    SceneSection {
        primitives: vec![
            primitive(
                "slab-level-b1",
                PrimitiveRole::Surface,
                "level-b1",
                Some("level-b1"),
                PrimitiveGeometry::Mesh(square(0)),
            ),
            primitive(
                "surface-unit-walkway",
                PrimitiveRole::Surface,
                "level-b1",
                Some("unit-walkway"),
                PrimitiveGeometry::Mesh(square(0)),
            ),
            primitive(
                "surface-unit-shop",
                PrimitiveRole::Surface,
                "level-b1",
                Some("unit-shop"),
                PrimitiveGeometry::Mesh(square(0)),
            ),
            primitive(
                "wall-level-b1-0",
                PrimitiveRole::Wall,
                "level-b1",
                None,
                PrimitiveGeometry::Mesh(wall(0)),
            ),
            primitive(
                "ceiling-unit-walkway",
                PrimitiveRole::Ceiling,
                "level-b1",
                Some("unit-walkway"),
                PrimitiveGeometry::Mesh(square(3_000)),
            ),
            primitive(
                "portal-0",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                PrimitiveGeometry::Portal {
                    connects: (1, 2),
                    opening: off_wall_doorway(0),
                },
            ),
            // An evidenced conveyance: its canonical unit is an escalator.
            primitive(
                "conveyance-0",
                PrimitiveRole::Conveyance,
                "level-b1",
                Some("unit-escalator"),
                PrimitiveGeometry::Conveyance {
                    kind: ConveyanceKind::Neutral,
                    mesh: wall(0),
                },
            ),
            // A graph-derived conveyance with no canonical association: the
            // never-guess rule means its transport type stays unknown.
            primitive(
                "conveyance-1",
                PrimitiveRole::Conveyance,
                "level-1f",
                None,
                PrimitiveGeometry::Conveyance {
                    kind: ConveyanceKind::Neutral,
                    mesh: wall(4_500),
                },
            ),
            primitive(
                "slab-level-1f",
                PrimitiveRole::Surface,
                "level-1f",
                Some("level-1f"),
                PrimitiveGeometry::Mesh(square(4_500)),
            ),
        ],
        descriptor: None,
    }
}

fn feature(id: &str, feature_type: FeatureType, category: Option<&str>) -> VenueFeature {
    VenueFeature {
        id: id.to_string(),
        feature_type,
        level_id: Some("level-b1".to_string()),
        geometry: None,
        center: None,
        labels: BTreeMap::new(),
        alt_labels: BTreeMap::new(),
        category: category.map(str::to_string),
        accessibility: Vec::new(),
        restriction: None,
        source_properties: Default::default(),
    }
}

fn features() -> Vec<VenueFeature> {
    vec![
        feature("level-b1", FeatureType::Level, Some("unspecified")),
        feature("level-1f", FeatureType::Level, Some("unspecified")),
        feature("unit-walkway", FeatureType::Unit, Some("walkway")),
        feature("unit-shop", FeatureType::Unit, Some("shop")),
        feature("unit-escalator", FeatureType::Unit, Some("escalator")),
    ]
}

#[test]
fn levels_mirror_the_spatial_context_planes() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let ids: Vec<&str> = document
        .levels
        .iter()
        .map(|level| level.canonical_id.as_str())
        .collect();
    assert_eq!(ids, vec!["level-b1", "level-1f"]);

    assert_eq!(document.levels[0].resolved_plane_z, 0.0);
    assert_eq!(document.levels[1].resolved_plane_z, 4.5);
    // §8 records the source elevation when one exists; the generated source
    // never fabricates one for a level resolved by nominal spacing.
    assert_eq!(document.levels[0].source_elevation_meters, Some(-6.5));
    assert_eq!(document.levels[1].source_elevation_meters, None);
    assert_eq!(document.levels[0].quantized_elevation_dm, 0);
    assert_eq!(document.levels[1].quantized_elevation_dm, 45);
}

#[test]
fn semantic_roles_come_from_the_canonical_category_never_a_guess() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let role_of = |id: &str| -> SemanticRole {
        document
            .features
            .iter()
            .find(|feature| feature.source_object_id == id)
            .unwrap_or_else(|| panic!("{id} present"))
            .role
    };

    // A level slab is contextual floor plate, not a navigability claim — and a
    // distinct role from the finishes that sit coplanar on top of it.
    assert_eq!(role_of("slab-level-b1"), SemanticRole::Context);
    assert_eq!(role_of("surface-unit-walkway"), SemanticRole::Walkable);
    assert_eq!(role_of("surface-unit-shop"), SemanticRole::Public);
    assert_eq!(role_of("wall-level-b1-0"), SemanticRole::Structure);
    assert_eq!(role_of("ceiling-unit-walkway"), SemanticRole::Ceiling);
    assert_eq!(role_of("portal-0"), SemanticRole::Opening);
    // Evidenced: the canonical unit is an escalator.
    assert_eq!(role_of("conveyance-0"), SemanticRole::Escalator);
    // Unassociated: a conveyance form whose transport type is not evidenced
    // stays a conveyance rather than being guessed into one.
    assert_eq!(role_of("conveyance-1"), SemanticRole::Conveyance);
}

#[test]
fn occlusion_policy_follows_the_role_not_the_source_opacity() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let occlusion_of = |id: &str| -> OcclusionClass {
        document
            .features
            .iter()
            .find(|feature| feature.source_object_id == id)
            .unwrap_or_else(|| panic!("{id} present"))
            .occlusion
    };

    // Every §9 primitive here declares `Opaque`; the fade policy is the
    // role's, so ceilings may fade and navigable surfaces never do.
    assert_eq!(
        occlusion_of("ceiling-unit-walkway"),
        OcclusionClass::ProtectedCorridor
    );
    assert_eq!(occlusion_of("wall-level-b1-0"), OcclusionClass::Context);
    assert_eq!(occlusion_of("surface-unit-walkway"), OcclusionClass::Never);
    assert_eq!(occlusion_of("conveyance-1"), OcclusionClass::Never);
}

#[test]
fn features_carry_canonical_identity_level_membership_and_z_extent() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let surface = document
        .features
        .iter()
        .find(|feature| feature.source_object_id == "surface-unit-walkway")
        .expect("surface present");
    assert_eq!(surface.canonical_id.as_deref(), Some("unit-walkway"));
    assert_eq!(surface.level_index, 0);
    assert_eq!(surface.min_z, 0.0);
    assert_eq!(surface.max_z, 0.0);
    // §8 confidence 1.0 (measured) scales to full byte certainty.
    assert_eq!(surface.confidence, 255);

    let wall = document
        .features
        .iter()
        .find(|feature| feature.source_object_id == "wall-level-b1-0")
        .expect("wall present");
    assert_eq!(wall.canonical_id, None);
    assert_eq!(wall.min_z, 0.0);
    assert_eq!(wall.max_z, 3.0);

    let upper = document
        .features
        .iter()
        .find(|feature| feature.source_object_id == "conveyance-1")
        .expect("upper conveyance present");
    assert_eq!(upper.level_index, 1);
}

#[test]
fn geometry_batches_merge_one_per_level_and_role() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let pairs: Vec<(u32, SemanticRole)> = document
        .batches
        .iter()
        .map(|batch| (batch.level_index, batch.role))
        .collect();

    // Level 0 carries Context (the slab), Public (the shop), Walkable,
    // Structure, Ceiling, Opening, and Escalator; level 1 carries Context and
    // Conveyance. Every batch is a distinct (level, role) pair — the merge is
    // what keeps a visible floor inside the draw-call budget.
    let mut sorted = pairs.clone();
    sorted.sort_by_key(|(level, role)| (*level, format!("{role:?}")));
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        pairs.len(),
        "no duplicate (level, role) batch"
    );

    let level_0_batches = pairs.iter().filter(|(level, _)| *level == 0).count();
    assert_eq!(level_0_batches, 7);
    assert!(
        level_0_batches <= 8,
        "a visible floor stays inside the 8 draw-call budget"
    );

    // The shop's own 2-triangle square: 6 triangle-list vertices.
    let public = document
        .batches
        .iter()
        .find(|batch| batch.level_index == 0 && batch.role == SemanticRole::Public)
        .expect("public batch");
    assert_eq!(public.vertex_count, 6);
    assert_eq!(public.positions.len(), 6);
    assert_eq!(public.normals.len(), 6);
    assert_eq!(public.feature_indices.len(), 6);
}

#[test]
fn quantized_positions_restore_to_the_source_millimetres() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let walkable = document
        .batches
        .iter()
        .find(|batch| batch.level_index == 0 && batch.role == SemanticRole::Walkable)
        .expect("walkable batch");

    let mut restored: Vec<[f32; 3]> = Vec::new();
    for quantized in &walkable.positions {
        let mut point = [0.0_f32; 3];
        for axis in 0..3 {
            point[axis] = walkable.quantization_origin[axis]
                + f32::from(quantized[axis]) * walkable.quantization_scale[axis];
        }
        restored.push(point);
    }

    // The unit square spans 0..2 m in x and y on the 0 m plane; quantization
    // error inside a 2 m batch is far below a millimetre.
    for point in &restored {
        assert!(
            point[0] >= -0.001 && point[0] <= 2.001,
            "x in range: {point:?}"
        );
        assert!(
            point[1] >= -0.001 && point[1] <= 2.001,
            "y in range: {point:?}"
        );
        assert!(point[2].abs() <= 0.001, "on the plane: {point:?}");
    }
    assert!(
        restored.iter().any(|p| p[0] > 1.99),
        "the far edge survives quantization"
    );
}

#[test]
fn normals_face_up_for_a_floor_and_sideways_for_a_wall() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let walkable = document
        .batches
        .iter()
        .find(|batch| batch.level_index == 0 && batch.role == SemanticRole::Walkable)
        .expect("walkable batch");
    for encoded in &walkable.normals {
        let normal = decode_normal_oct(*encoded);
        assert!(normal[2] > 0.9, "floor normal points up: {normal:?}");
    }

    let structure = document
        .batches
        .iter()
        .find(|batch| batch.level_index == 0 && batch.role == SemanticRole::Structure)
        .expect("structure batch");
    for encoded in &structure.normals {
        let normal = decode_normal_oct(*encoded);
        assert!(
            normal[2].abs() < 0.1,
            "wall normal is horizontal: {normal:?}"
        );
    }
}

#[test]
fn feature_indices_attribute_every_vertex_to_its_primitive() {
    let document = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("scene compiles");

    let public = document
        .batches
        .iter()
        .find(|batch| batch.level_index == 0 && batch.role == SemanticRole::Public)
        .expect("public batch");

    let mut attributed: Vec<&str> = public
        .feature_indices
        .iter()
        .map(|index| document.features[*index as usize].source_object_id.as_str())
        .collect();
    attributed.sort_unstable();
    attributed.dedup();
    assert_eq!(attributed, vec!["surface-unit-shop"]);

    // Every vertex resolves to a feature on this batch's own level and role.
    for index in &public.feature_indices {
        let feature = &document.features[*index as usize];
        assert_eq!(feature.level_index, 0);
        assert_eq!(feature.role, SemanticRole::Public);
    }
}

#[test]
fn the_header_carries_the_frame_world_transform_and_scene_bounds() {
    let spatial = spatial_context();
    let document =
        compile_generated_scene(&scene_section(), &spatial, &features()).expect("scene compiles");

    assert_eq!(document.header.frame_origin_ecef, spatial.frame.ecef_origin);

    // Column-major 4x4: the ENU basis vectors as columns, translation last.
    let transform = document.header.world_transform;
    for axis in 0..3 {
        for component in 0..3 {
            assert_eq!(
                transform[axis * 4 + component],
                spatial.frame.enu_basis_ecef[axis][component],
                "basis column {axis} component {component}"
            );
        }
        assert_eq!(transform[axis * 4 + 3], 0.0);
    }
    for component in 0..3 {
        assert_eq!(
            transform[12 + component],
            spatial.frame.world_translation[component]
        );
    }
    assert_eq!(transform[15], 1.0);

    // Bounds cover the venue-local metre extent: 0..2 m of floor stack, plus
    // the shared fixture's doorway parked away from its wall panel (4..6 m,
    // y = 4 m), and vertically from the lowest plane to the upper conveyance.
    assert_eq!(document.header.bounds_min, [0.0, 0.0, 0.0]);
    assert_eq!(document.header.bounds_max, [6.0, 4.0, 7.5]);
}

#[test]
fn identical_input_compiles_byte_identically() {
    let first = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("first compile");
    let second = compile_generated_scene(&scene_section(), &spatial_context(), &features())
        .expect("second compile");

    assert_eq!(first, second, "the compile is deterministic");
    assert_eq!(
        encode_scene(&first).expect("first encodes"),
        encode_scene(&second).expect("second encodes"),
        "and encodes to identical bytes"
    );
    assert_eq!(
        first.header.source_hash, second.header.source_hash,
        "the source hash identifies the same input"
    );
}

#[test]
fn a_primitive_on_an_unknown_level_is_rejected_rather_than_placed() {
    let mut section = scene_section();
    section.primitives.push(primitive(
        "surface-orphan",
        PrimitiveRole::Surface,
        "level-missing",
        None,
        PrimitiveGeometry::Mesh(square(0)),
    ));

    let error = compile_generated_scene(&section, &spatial_context(), &features())
        .expect_err("an unplaceable primitive fails the compile");
    let message = error.to_string();
    assert!(
        message.contains("level-missing"),
        "the message names the unresolved level: {message}"
    );
}

#[test]
fn an_empty_scene_compiles_to_a_document_with_no_batches() {
    let section = SceneSection {
        primitives: Vec::new(),
        descriptor: None,
    };
    let document = compile_generated_scene(&section, &spatial_context(), &features())
        .expect("an empty scene still compiles");

    assert!(document.batches.is_empty());
    assert!(document.features.is_empty());
    assert_eq!(
        document.levels.len(),
        2,
        "the frame's levels still describe the venue"
    );
}

/// A 10 m wall along y = 0 from x = 0, rising `height_mm` above `z_mm`.
fn long_wall(z_mm: i64, height_mm: i64, length_mm: i64) -> Mesh {
    Mesh {
        positions: vec![
            [0, 0, z_mm],
            [length_mm, 0, z_mm],
            [length_mm, 0, z_mm + height_mm],
            [0, 0, z_mm + height_mm],
        ],
        faces: vec![[0, 1, 2], [0, 2, 3]],
    }
}

/// A doorway quad on y = 0 spanning `x0..x1`, its top `height_mm` above the
/// plane — the shape §8 emits for an opening on a unit boundary.
fn doorway(x0: i64, x1: i64, height_mm: i64) -> PrimitiveGeometry {
    PrimitiveGeometry::Portal {
        connects: (0, 1),
        opening: Mesh {
            positions: vec![
                [x0, 0, 0],
                [x1, 0, 0],
                [x1, 0, height_mm],
                [x0, 0, height_mm],
            ],
            faces: vec![[0, 1, 2], [0, 2, 3]],
        },
    }
}

fn structure_of(document: &kiriko_scene::SceneDocument) -> kiriko_scene::SceneBatch {
    document
        .batches
        .iter()
        .find(|batch| batch.role == SemanticRole::Structure)
        .expect("structure batch")
        .clone()
}

/// Restored batch positions, back in venue-local millimetres.
fn restored_mm(batch: &kiriko_scene::SceneBatch) -> Vec<[f32; 3]> {
    batch
        .positions
        .iter()
        .map(|quantized| {
            let mut point = [0.0_f32; 3];
            for axis in 0..3 {
                point[axis] = batch.quantization_origin[axis]
                    + f32::from(quantized[axis]) * batch.quantization_scale[axis];
            }
            point
        })
        .collect()
}

#[test]
fn a_doorway_cuts_a_full_height_hole_in_its_host_wall() {
    // A 10 m wall with a 2 m doorway centred at 4–6 m, top at 2.1 m: the
    // compile must leave two full-height side pieces and a lintel, and no
    // geometry inside the opening below its top.
    let section = SceneSection {
        primitives: vec![
            primitive(
                "wall-x",
                PrimitiveRole::Wall,
                "level-b1",
                None,
                PrimitiveGeometry::Mesh(long_wall(0, 3_000, 10_000)),
            ),
            primitive(
                "portal-x",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                doorway(4_000, 6_000, 2_100),
            ),
        ],
        descriptor: None,
    };
    let document =
        compile_generated_scene(&section, &spatial_context(), &features()).expect("scene compiles");

    let structure = structure_of(&document);
    assert_eq!(
        structure.vertex_count, 18,
        "two side pieces plus one lintel, six vertices each"
    );
    for p in restored_mm(&structure) {
        let inside_span = p[0] > 4.001 && p[0] < 5.999;
        assert!(
            !inside_span || p[2] > 2.099,
            "no wall face fills the doorway below its top: {p:?}"
        );
    }
    // The lintel's soffit sits exactly at the doorway's stated top.
    let restored = restored_mm(&structure);
    assert!(
        restored.iter().any(|p| (p[2] - 2.1).abs() < 0.001),
        "a lintel bottom edge exists at the doorway top"
    );
}

#[test]
fn a_doorway_taller_than_its_wall_leaves_no_lintel() {
    let section = SceneSection {
        primitives: vec![
            primitive(
                "wall-x",
                PrimitiveRole::Wall,
                "level-b1",
                None,
                PrimitiveGeometry::Mesh(long_wall(0, 2_000, 10_000)),
            ),
            primitive(
                "portal-x",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                doorway(4_000, 6_000, 2_100),
            ),
        ],
        descriptor: None,
    };
    let document =
        compile_generated_scene(&section, &spatial_context(), &features()).expect("scene compiles");

    let structure = structure_of(&document);
    assert_eq!(structure.vertex_count, 12, "two side pieces, no lintel");
    for p in restored_mm(&structure) {
        assert!(
            p[2] <= 2.001,
            "nothing stands above the wall's own top: {p:?}"
        );
    }
}

#[test]
fn a_portal_off_the_wall_line_or_level_cuts_nothing() {
    // The doorway runs along y at x = 4 m — perpendicular to the wall — and a
    // second collinear doorway sits on the floor above, where this wall is not.
    let off_line = PrimitiveGeometry::Portal {
        connects: (0, 1),
        opening: Mesh {
            positions: vec![
                [4_000, 0, 0],
                [4_000, 2_000, 0],
                [4_000, 2_000, 2_100],
                [4_000, 0, 2_100],
            ],
            faces: vec![[0, 1, 2], [0, 2, 3]],
        },
    };
    let section = SceneSection {
        primitives: vec![
            primitive(
                "wall-x",
                PrimitiveRole::Wall,
                "level-b1",
                None,
                PrimitiveGeometry::Mesh(long_wall(0, 3_000, 10_000)),
            ),
            primitive(
                "portal-off-line",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                off_line,
            ),
            primitive(
                "portal-other-level",
                PrimitiveRole::Portal,
                "level-1f",
                None,
                doorway(4_000, 6_000, 2_100),
            ),
        ],
        descriptor: None,
    };
    let document =
        compile_generated_scene(&section, &spatial_context(), &features()).expect("scene compiles");

    let b1_structure = document
        .batches
        .iter()
        .find(|batch| batch.level_index == 0 && batch.role == SemanticRole::Structure)
        .expect("b1 structure batch");
    assert_eq!(b1_structure.vertex_count, 6, "the wall survives intact");
}

#[test]
fn overlapping_doorways_merge_and_sliver_pieces_do_not_survive() {
    // Doorways at 4–5 m and 5–7 m share an edge; a third at 7.006–8 m leaves
    // only a 6 mm gap to the merged span. The wall compiles as one piece
    // before the span and one after — never a 6 mm sliver.
    let section = SceneSection {
        primitives: vec![
            primitive(
                "wall-x",
                PrimitiveRole::Wall,
                "level-b1",
                None,
                PrimitiveGeometry::Mesh(long_wall(0, 3_000, 10_000)),
            ),
            primitive(
                "portal-a",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                doorway(4_000, 5_000, 2_100),
            ),
            primitive(
                "portal-b",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                doorway(5_000, 7_000, 2_100),
            ),
            primitive(
                "portal-c",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                doorway(7_006, 8_000, 2_100),
            ),
        ],
        descriptor: None,
    };
    let document =
        compile_generated_scene(&section, &spatial_context(), &features()).expect("scene compiles");

    let structure = structure_of(&document);
    assert_eq!(
        structure.vertex_count, 18,
        "one piece before 4 m, one lintel across 4–8 m, one piece after"
    );
    for p in restored_mm(&structure) {
        let under_lintel = p[0] > 4.001 && p[0] < 7.999 && p[2] < 2.099;
        assert!(!under_lintel, "the merged span is fully open: {p:?}");
    }
}

#[test]
fn a_wall_fully_covered_by_a_doorway_compiles_with_no_geometry() {
    let section = SceneSection {
        primitives: vec![
            primitive(
                "wall-x",
                PrimitiveRole::Wall,
                "level-b1",
                None,
                PrimitiveGeometry::Mesh(long_wall(0, 3_000, 2_000)),
            ),
            primitive(
                "portal-x",
                PrimitiveRole::Portal,
                "level-b1",
                None,
                doorway(0, 2_000, 3_000),
            ),
        ],
        descriptor: None,
    };
    let document = compile_generated_scene(&section, &spatial_context(), &features())
        .expect("an emptied wall still compiles");

    let structure = structure_of(&document);
    assert_eq!(structure.vertex_count, 0, "nothing of the wall remains");
    let wall = document
        .features
        .iter()
        .find(|feature| feature.source_object_id == "wall-x")
        .expect("the wall's feature entry stays for provenance");
    assert_eq!(wall.min_z, 0.0);
    assert_eq!(wall.max_z, 0.0);
}

/// A closed rectangular tube — walls plus lid, no bottom: the shape §9's
/// neutral conveyance meshes take for a transit footprint.
fn conduit_box(x0: i64, y0: i64, x1: i64, y1: i64, z0: i64, z1: i64) -> Mesh {
    let ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    let mut positions = Vec::new();
    for p in ring {
        positions.push([p[0], p[1], z0]);
    }
    for p in ring {
        positions.push([p[0], p[1], z1]);
    }
    let (b, t) = (0u32, 4u32);
    let mut quad = |faces: &mut Vec<[u32; 3]>, a: u32, b: u32, c: u32, d: u32| {
        faces.push([a, b, c]);
        faces.push([a, c, d]);
    };
    let mut faces = Vec::new();
    quad(&mut faces, b, b + 1, t + 1, t);
    quad(&mut faces, b + 1, b + 2, t + 2, t + 1);
    quad(&mut faces, b + 2, b + 3, t + 3, t + 2);
    quad(&mut faces, b + 3, b, t, t + 3);
    quad(&mut faces, t, t + 1, t + 2, t + 3);
    Mesh { positions, faces }
}

fn conveyance_section(category: Option<&str>) -> SceneSection {
    SceneSection {
        primitives: vec![primitive(
            "conveyance-x",
            PrimitiveRole::Conveyance,
            "level-b1",
            category.map(|_| "unit-x"),
            PrimitiveGeometry::Conveyance {
                kind: kiriko_model::scene::ConveyanceKind::Neutral,
                mesh: conduit_box(-3_000, -1_000, 3_000, 1_000, 0, 3_000),
            },
        )],
        descriptor: None,
    }
}

fn conveyance_features(category: Option<&str>) -> Vec<VenueFeature> {
    vec![feature("unit-x", FeatureType::Unit, category)]
}

#[test]
fn an_evidenced_stair_run_compiles_to_steps() {
    let document = compile_generated_scene(
        &conveyance_section(Some("stairs")),
        &spatial_context(),
        &conveyance_features(Some("stairs")),
    )
    .expect("scene compiles");

    let batch = document
        .batches
        .iter()
        .find(|batch| batch.role == SemanticRole::Stairs)
        .expect("stairs batch");
    // 26 risers of ~175 mm span the 4.5 m to the next plane: one box each.
    assert_eq!(batch.vertex_count, 26 * 30);
    let restored = restored_mm(batch);
    assert!(
        restored.iter().any(|p| (p[2] - 4.5).abs() < 0.01),
        "the top step lands on the upper plane"
    );
    assert!(
        restored.iter().any(|p| p[2] > 0.1 && p[2] < 4.4),
        "intermediate risers exist"
    );
    assert!(
        restored.iter().all(|p| p[1] >= -1.001 && p[1] <= 1.001),
        "the steps stay inside the authored 2 m footprint"
    );
}

#[test]
fn an_elevator_gets_doors_and_a_roof() {
    let document = compile_generated_scene(
        &conveyance_section(Some("elevator")),
        &spatial_context(),
        &conveyance_features(Some("elevator")),
    )
    .expect("scene compiles");

    let batch = document
        .batches
        .iter()
        .find(|batch| batch.role == SemanticRole::Elevator)
        .expect("elevator batch");
    // Shaft + two door panels + roof slab.
    assert_eq!(batch.vertex_count, 120);
    let restored = restored_mm(batch);
    assert!(
        restored.iter().any(|p| (p[2] - 4.62).abs() < 0.01),
        "the roof slab exists above the shaft"
    );
}

#[test]
fn an_escalator_gets_rails_and_comb_platforms() {
    let document = compile_generated_scene(
        &conveyance_section(Some("escalator")),
        &spatial_context(),
        &conveyance_features(Some("escalator")),
    )
    .expect("scene compiles");

    let batch = document
        .batches
        .iter()
        .find(|batch| batch.role == SemanticRole::Escalator)
        .expect("escalator batch");
    // Deck quad + two balustrade bands + two comb boxes.
    assert_eq!(batch.vertex_count, 78);
    let restored = restored_mm(batch);
    assert!(
        restored.iter().any(|p| p[2] > 5.0),
        "balustrades rise above the upper landing"
    );
}

#[test]
fn an_untyped_conveyance_keeps_its_neutral_mesh() {
    let document = compile_generated_scene(
        &conveyance_section(None),
        &spatial_context(),
        &conveyance_features(None),
    )
    .expect("scene compiles");

    let batch = document
        .batches
        .iter()
        .find(|batch| batch.role == SemanticRole::Conveyance)
        .expect("conveyance batch");
    assert_eq!(batch.vertex_count, 30, "the authored tube, untouched");
}

#[test]
fn a_fixture_compiles_as_a_ticket_gate_row() {
    let section = SceneSection {
        primitives: vec![primitive(
            "fixture-x",
            PrimitiveRole::Fixture,
            "level-b1",
            None,
            PrimitiveGeometry::Mesh(square(0)),
        )],
        descriptor: None,
    };
    let document =
        compile_generated_scene(&section, &spatial_context(), &features()).expect("scene compiles");

    let batch = document
        .batches
        .iter()
        .find(|batch| batch.role == SemanticRole::TicketGate)
        .expect("ticket-gate batch");
    assert_eq!(batch.vertex_count, 6, "the authored square, untouched");
    let gate = document
        .features
        .iter()
        .find(|feature| feature.source_object_id == "fixture-x")
        .expect("gate feature present");
    assert_eq!(gate.role, SemanticRole::TicketGate);
}
