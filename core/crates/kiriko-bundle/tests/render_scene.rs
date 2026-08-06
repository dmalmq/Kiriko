//! The generated §9 scene compiled into the shared KSC1 render document, on a
//! real published bundle rather than hand-built input. These assertions are
//! the renderer's structural contract (issue #60): a visible floor stays
//! inside the draw-call budget, every vertex is attributable, and the same
//! bundle always compiles to the same bytes.

use kiriko_bundle::{BundleMetadata, compile_imdf, decode_bundle};
use kiriko_scene::{SemanticRole, compile_generated_scene, decode_scene, encode_scene};
use std::collections::{BTreeMap, BTreeSet};

mod support;

fn metadata() -> BundleMetadata {
    BundleMetadata {
        dataset_id: "render".to_string(),
        version: 1,
    }
}

/// The multi-floor fixture's published bundle, compiled to a render document.
fn render_document() -> kiriko_scene::SceneDocument {
    let source = support::build_multi_floor_imdf_zip();
    let compiled = compile_imdf(&source, metadata()).expect("fixture compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");
    let scene = document
        .scene
        .expect("the fixture carries a generated scene");
    let spatial = document
        .spatial_context
        .expect("the fixture carries spatial context");

    compile_generated_scene(&scene, &spatial, &document.features).expect("scene compiles")
}

#[test]
fn a_visible_floor_stays_inside_the_draw_call_budget() {
    let document = render_document();

    let mut per_level: BTreeMap<u32, usize> = BTreeMap::new();
    for batch in &document.batches {
        *per_level.entry(batch.level_index).or_default() += 1;
    }

    assert!(!per_level.is_empty(), "the fixture renders something");
    for (level_index, batches) in &per_level {
        assert!(
            *batches <= 8,
            "level {level_index} draws in {batches} calls, over the 8-call budget"
        );
    }

    assert!(
        document.batches.len() <= 320,
        "all levels visible draw in {} calls, over the 320-call budget",
        document.batches.len()
    );
}

#[test]
fn every_primitive_becomes_one_attributable_feature() {
    let source = support::build_multi_floor_imdf_zip();
    let compiled = compile_imdf(&source, metadata()).expect("fixture compiles");
    let bundle = decode_bundle(&compiled.bytes).expect("bundle decodes");
    let scene = bundle.scene.clone().expect("scene present");
    let document = render_document();

    assert_eq!(
        document.features.len(),
        scene.primitives.len(),
        "no primitive is dropped or duplicated"
    );

    // Every vertex resolves to a feature, and that feature agrees with its
    // batch about both level and role — the pick pass reads this mapping.
    for batch in &document.batches {
        assert_eq!(batch.feature_indices.len(), batch.vertex_count as usize);
        assert_eq!(batch.positions.len(), batch.vertex_count as usize);
        assert_eq!(batch.normals.len(), batch.vertex_count as usize);
        assert_eq!(
            batch.vertex_count % 3,
            0,
            "triangle-list batches carry whole facets"
        );
        for index in &batch.feature_indices {
            let feature = document
                .features
                .get(*index as usize)
                .expect("feature index resolves");
            assert_eq!(feature.level_index, batch.level_index);
            assert_eq!(feature.role, batch.role);
        }
    }
}

#[test]
fn the_fixture_exercises_the_semantic_role_span() {
    let document = render_document();

    let roles: BTreeSet<String> = document
        .features
        .iter()
        .map(|feature| format!("{:?}", feature.role))
        .collect();

    // The multi-floor fixture carries walkways, rooms, walls, ceilings,
    // openings, and vertical connections — the classes a renderer must style
    // differently. A regression that collapsed the mapping would shrink this.
    for expected in [
        SemanticRole::Walkable,
        SemanticRole::Public,
        SemanticRole::Structure,
        SemanticRole::Ceiling,
        SemanticRole::Opening,
    ] {
        assert!(
            roles.contains(&format!("{expected:?}")),
            "{expected:?} missing from {roles:?}"
        );
    }
}

#[test]
fn the_render_document_round_trips_through_the_container() {
    let document = render_document();
    let bytes = encode_scene(&document).expect("encodes");
    let decoded = decode_scene(&bytes).expect("decodes");
    assert_eq!(decoded, document, "the container is lossless");
}

#[test]
fn the_same_bundle_compiles_to_identical_render_bytes() {
    let first = encode_scene(&render_document()).expect("first encodes");
    let second = encode_scene(&render_document()).expect("second encodes");
    assert_eq!(first, second, "the render compile is deterministic");
}

#[test]
fn geometry_is_finite_and_placed_on_the_resolved_planes() {
    let document = render_document();

    for axis in 0..3 {
        assert!(
            document.header.bounds_min[axis].is_finite()
                && document.header.bounds_max[axis].is_finite(),
            "bounds are finite on axis {axis}"
        );
        assert!(document.header.bounds_max[axis] >= document.header.bounds_min[axis]);
    }

    // The fixture's four floors sit on distinct planes; the scene's vertical
    // extent must span them rather than collapsing to one level.
    let planes: Vec<f32> = document
        .levels
        .iter()
        .map(|level| level.resolved_plane_z)
        .collect();
    let lowest = planes.iter().copied().fold(f32::INFINITY, f32::min);
    let highest = planes.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    assert!(
        highest - lowest > 1.0,
        "levels resolve to distinct planes: {planes:?}"
    );
    assert!(document.header.bounds_max[2] >= highest);

    // Quantization restores inside the batch's own bounds on every axis.
    for batch in &document.batches {
        for axis in 0..3 {
            assert!(
                batch.quantization_scale[axis] > 0.0,
                "batch scale is positive on axis {axis}"
            );
            assert!(batch.quantization_origin[axis].is_finite());
        }
    }
}
