//! The Generated scene producer: a bundle's §9 semantic primitives plus §8
//! spatial context compiled into the same KSC1 render document the Tiles
//! deriver emits, so one renderer serves both sources (#23 D4).

use kiriko_model::model::{FeatureType, VenueFeature};
use kiriko_model::scene::{
    ConveyanceKind, Mesh, OcclusionClass as SceneOcclusion, PrimitiveGeometry, PrimitiveRole,
    ScenePrimitive, SceneSection,
};
use kiriko_model::spatial::{
    Assumption, AssumptionKind, Axes, Confidence, ConfidenceKind, Datum, Ellipsoid, EvidenceMethod,
    Frame, LengthUnit, LevelRecord, LocatorKind, RegistrationEvidence, Registries,
    ResolutionMethod, SourceLocator, SpatialContext, enu_basis_ecef, wgs84_ecef,
};
use kiriko_scene::{
    OcclusionClass, SemanticRole, compile_generated_scene, decode_normal_oct, encode_scene,
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

/// A vertical quad from `z_mm` up 3 m — a wall panel.
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
                    opening: wall(0),
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
    assert_eq!(document.header.deriver_version, 2);

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

    // Bounds cover the venue-local metre extent: 0..2 m horizontally, and
    // vertically from the lowest plane to the upper conveyance's top.
    assert_eq!(document.header.bounds_min, [0.0, 0.0, 0.0]);
    assert_eq!(document.header.bounds_max, [2.0, 2.0, 7.5]);
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
