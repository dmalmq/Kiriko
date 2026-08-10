//! Deriving the render document from an activated tile package (#75).
//!
//! The document is the *same* KSC1 the generated source compiles to — that is
//! what lets one renderer serve both sources. So these tests are about the
//! parts only a package can supply: composite levels carrying the canonical
//! floor they were registered to, source objects carrying the canonical feature
//! they were associated with, and producer-classified context carrying its own
//! occlusion policy.

mod support;

use std::collections::BTreeMap;

use kiriko_scene::{
    FrameTransform, OcclusionClass, PackageScene, RegistrationProfile, SemanticRole,
    derive_package_scene, read_glb, resolve_tile_levels,
};
use support::{FeatureSpec, glb_with_features, quad};

/// A package with one floor on `b1fl` and one wall beside it.
fn station_package() -> Vec<u8> {
    glb_with_features(&[
        FeatureSpec::new(
            "floor-b1",
            "Floors",
            "b1fl",
            -3.1,
            quad([0.0, 0.0], [40.0, 20.0], -3.1),
        ),
        FeatureSpec::new(
            "wall-b1",
            "Walls",
            "b1fl",
            -3.1,
            quad([0.0, 0.0], [40.0, 0.3], -3.1),
        ),
    ])
}

fn package_scene(glb: &[u8], mappings: &BTreeMap<String, String>) -> PackageScene {
    let scene = read_glb(glb).expect("fixture glb reads");
    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );
    derive_package_scene(
        std::slice::from_ref(&scene),
        &levels,
        &FrameTransform::identity(),
        "package-hash",
        mappings,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect("the package derives")
}

fn mapped(composite: &str, canonical: &str) -> BTreeMap<String, String> {
    BTreeMap::from([(composite.to_string(), canonical.to_string())])
}

#[test]
fn a_levels_canonical_id_is_the_floor_it_was_registered_to() {
    let derived = package_scene(
        &station_package(),
        &mapped("asset-v1|station.rvt||b1fl|-31", "level-b1"),
    );

    assert_eq!(derived.document.levels.len(), 1);
    let level = &derived.document.levels[0];
    assert_eq!(level.canonical_id, "level-b1");
    assert_eq!(level.source_level_key, "b1fl");
    assert_eq!(level.source_document, "station.rvt");
    assert_eq!(level.quantized_elevation_dm, -31);
    assert!((level.resolved_plane_z - -3.1).abs() < 1e-5);
}

#[test]
fn two_composite_levels_on_one_floor_both_carry_that_floors_id() {
    // The registration table is many-to-many (#31): filtering by canonical
    // floor has to find every composite level registered to it, so both levels
    // carry the same canonical id rather than one winning.
    let glb = glb_with_features(&[
        FeatureSpec::new(
            "floor-jr",
            "Floors",
            "b1fl",
            -3.1,
            quad([0.0, 0.0], [40.0, 20.0], -3.1),
        ),
        FeatureSpec::new(
            "floor-kitte",
            "Floors",
            "b1fl",
            -1.25,
            quad([40.0, 0.0], [80.0, 20.0], -1.25),
        )
        .in_document("kitte.rvt", "kitte-link"),
    ]);
    let mappings = BTreeMap::from([
        (
            "asset-v1|station.rvt||b1fl|-31".to_string(),
            "level-b1".to_string(),
        ),
        (
            "asset-v1|kitte.rvt|kitte-link|b1fl|-13".to_string(),
            "level-b1".to_string(),
        ),
    ]);

    let derived = package_scene(&glb, &mappings);

    assert_eq!(derived.document.levels.len(), 2);
    for level in &derived.document.levels {
        assert_eq!(level.canonical_id, "level-b1");
    }
    // And each feature still points at its own composite level, not a merged one.
    let level_of = |id: &str| {
        derived
            .document
            .features
            .iter()
            .find(|feature| feature.source_object_id == id)
            .expect("feature")
            .level_index
    };
    assert_ne!(level_of("floor-jr"), level_of("floor-kitte"));
}

#[test]
fn a_level_no_floor_was_registered_to_is_left_unclaimed() {
    // Activation refuses such a package (#74), so this only happens to content
    // the producer classified as context. It must not borrow a floor id.
    let derived = package_scene(&station_package(), &BTreeMap::new());

    assert_eq!(derived.document.levels[0].canonical_id, "");
    assert_eq!(
        derived.unmapped_levels,
        vec!["asset-v1|station.rvt||b1fl|-31"]
    );
}

#[test]
fn an_associated_source_object_carries_its_canonical_feature() {
    let scene = read_glb(&station_package()).expect("fixture glb reads");
    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );

    let derived = derive_package_scene(
        std::slice::from_ref(&scene),
        &levels,
        &FrameTransform::identity(),
        "package-hash",
        &mapped("asset-v1|station.rvt||b1fl|-31", "level-b1"),
        &BTreeMap::from([("floor-b1".to_string(), "unit-corridor".to_string())]),
        &BTreeMap::new(),
    )
    .expect("the package derives");

    let feature = |id: &str| {
        derived
            .document
            .features
            .iter()
            .find(|feature| feature.source_object_id == id)
            .expect("feature")
    };
    assert_eq!(
        feature("floor-b1").canonical_id.as_deref(),
        Some("unit-corridor")
    );
    // An unassociated object stays inspectable and impersonates nothing.
    assert_eq!(feature("wall-b1").canonical_id, None);
    assert_eq!(feature("wall-b1").source_object_id, "wall-b1");
}

#[test]
fn producer_classified_context_renders_under_its_own_occlusion_policy() {
    // Left to the role table a wall is `Context` occlusion, which fades for the
    // camera. A producer who classified it transparent gets transparent —
    // otherwise the classification the activation gate demanded means nothing.
    let scene = read_glb(&station_package()).expect("fixture glb reads");
    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );

    let derived = derive_package_scene(
        std::slice::from_ref(&scene),
        &levels,
        &FrameTransform::identity(),
        "package-hash",
        &mapped("asset-v1|station.rvt||b1fl|-31", "level-b1"),
        &BTreeMap::new(),
        &BTreeMap::from([("wall-b1".to_string(), OcclusionClass::Never)]),
    )
    .expect("the package derives");

    let wall = derived
        .document
        .features
        .iter()
        .find(|feature| feature.source_object_id == "wall-b1")
        .expect("the wall");
    assert_eq!(wall.occlusion, OcclusionClass::Never);
    assert_eq!(wall.role, SemanticRole::Structure, "the role is untouched");
}

#[test]
fn geometry_is_batched_per_level_and_role_exactly_as_the_generated_source_is() {
    let derived = package_scene(
        &station_package(),
        &mapped("asset-v1|station.rvt||b1fl|-31", "level-b1"),
    );

    let roles: Vec<SemanticRole> = derived.document.batches.iter().map(|b| b.role).collect();
    assert_eq!(roles, vec![SemanticRole::Walkable, SemanticRole::Structure]);
    for batch in &derived.document.batches {
        assert_eq!(batch.level_index, 0);
        assert_eq!(batch.vertex_count as usize, batch.feature_indices.len());
        // One quantized `[u16; 3]` and one octahedral normal per vertex.
        assert_eq!(batch.positions.len(), batch.feature_indices.len());
        assert_eq!(batch.normals.len(), batch.feature_indices.len());
    }
    assert_eq!(derived.document.header.source_hash, "package-hash");
}

#[test]
fn the_world_transform_is_the_one_the_package_was_registered_with() {
    // The renderer places the scene with this matrix. If derivation invented
    // its own, a package that passed registration would draw somewhere else.
    let scene = read_glb(&station_package()).expect("fixture glb reads");
    let transform = FrameTransform::from_tileset(
        &[
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 200.0, 300.0, 1.0,
        ],
        &[0.0, 0.0, 0.0],
        &[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    );
    let levels = resolve_tile_levels(std::slice::from_ref(&scene), "asset-v1", &transform);

    let derived = derive_package_scene(
        std::slice::from_ref(&scene),
        &levels,
        &transform,
        "package-hash",
        &BTreeMap::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect("the package derives");

    assert_eq!(&derived.document.header.world_transform, transform.matrix());
    assert_eq!(
        derived.document.header.frame_origin_ecef,
        [
            transform.matrix()[12],
            transform.matrix()[13],
            transform.matrix()[14]
        ]
    );
}

#[test]
fn a_default_profile_registration_and_a_derivation_agree_on_levels() {
    // The document the renderer draws must describe the same levels the gates
    // were applied to; a second, differently-derived level set would let a
    // package render floors activation never judged.
    let scene = read_glb(&station_package()).expect("fixture glb reads");
    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );
    let _ = RegistrationProfile::default();

    let derived = package_scene(
        &station_package(),
        &mapped("asset-v1|station.rvt||b1fl|-31", "level-b1"),
    );

    assert_eq!(derived.document.levels.len(), levels.len());
    assert_eq!(
        derived.document.levels[0].source_level_key,
        levels[0].level_key
    );
}
