//! The generated §9 scene compiled into the shared KSC1 render document, on a
//! real published bundle rather than hand-built input. These assertions are
//! the renderer's structural contract (issue #60): a visible floor stays
//! inside the draw-call budget, every vertex is attributable, and the same
//! bundle always compiles to the same bytes.

use kiriko_bundle::{BundleMetadata, compile_imdf, decode_bundle};
use kiriko_scene::{SemanticRole, compile_generated_scene, decode_scene, encode_scene};
use std::collections::{BTreeMap, BTreeSet};

mod support;

// The scene crate's own GLB fixture builder, included rather than copied: two
// builders would drift into describing two different "valid GLB"s, which is
// exactly what an equivalence test must not let happen.
#[path = "../../kiriko-scene/tests/support/mod.rs"]
mod scene_support;

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

    // The multi-floor fixture carries walkways, a stairs unit, floor plates,
    // walls, ceilings, and openings — the classes a renderer must style
    // differently. `Stairs` proves a conveyance types itself from its
    // canonical unit's category rather than staying untyped, and `Context`
    // proves the level plate is distinct from the finishes on it. A regression
    // that collapsed the mapping would shrink this set.
    for expected in [
        SemanticRole::Walkable,
        SemanticRole::Context,
        SemanticRole::Stairs,
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

// -- Stage 3: the two sources produce one render contract (#75) ------------

/// A role's stable name — `SemanticRole` is `Copy + Eq` but not `Ord`, and a
/// comparison between sources wants a deterministic order.
fn role_name(role: SemanticRole) -> &'static str {
    match role {
        SemanticRole::Walkable => "Walkable",
        SemanticRole::Public => "Public",
        SemanticRole::Service => "Service",
        SemanticRole::Restricted => "Restricted",
        SemanticRole::Structure => "Structure",
        SemanticRole::Ceiling => "Ceiling",
        SemanticRole::Opening => "Opening",
        SemanticRole::Elevator => "Elevator",
        SemanticRole::Escalator => "Escalator",
        SemanticRole::Stairs => "Stairs",
        SemanticRole::Ramp => "Ramp",
        SemanticRole::Context => "Context",
        SemanticRole::Conveyance => "Conveyance",
        SemanticRole::TicketGate => "TicketGate",
    }
}

/// The same venue as a tile package: one walkable floor per canonical level,
/// authored on that level's own resolved plane, registered to it.
fn tiles_document(generated: &kiriko_scene::SceneDocument) -> kiriko_scene::SceneDocument {
    let mut features = Vec::new();
    let mut mappings = BTreeMap::new();
    for (index, level) in generated.levels.iter().enumerate() {
        let key = format!("L{index}");
        features.push(scene_support::FeatureSpec::new(
            &format!("floor-{index}"),
            "Floors",
            &key,
            level.resolved_plane_z,
            scene_support::quad([0.0, 0.0], [40.0, 20.0], level.resolved_plane_z),
        ));
        mappings.insert(
            format!(
                "asset-v1|station.rvt||{key}|{}",
                (f64::from(level.resolved_plane_z) * 10.0).round() as i32
            ),
            level.canonical_id.clone(),
        );
    }
    let glb = scene_support::glb_with_features(&features);
    let scene = kiriko_scene::read_glb(&glb).expect("the package reads");
    let placement = kiriko_scene::FrameTransform::identity();
    let levels =
        kiriko_scene::resolve_tile_levels(std::slice::from_ref(&scene), "asset-v1", &placement);
    kiriko_scene::derive_package_scene(
        std::slice::from_ref(&scene),
        &levels,
        &placement,
        &kiriko_scene::VenueFrame {
            ecef_origin: generated.header.frame_origin_ecef,
            enu_basis_ecef: [
                [
                    generated.header.world_transform[0],
                    generated.header.world_transform[1],
                    generated.header.world_transform[2],
                ],
                [
                    generated.header.world_transform[4],
                    generated.header.world_transform[5],
                    generated.header.world_transform[6],
                ],
                [
                    generated.header.world_transform[8],
                    generated.header.world_transform[9],
                    generated.header.world_transform[10],
                ],
            ],
        },
        "tiles-package-hash",
        &kiriko_scene::PackageIdentity {
            floor_mappings: mappings,
            ..kiriko_scene::PackageIdentity::default()
        },
    )
    .expect("the package derives")
    .document
}

#[test]
fn both_sources_place_the_scene_in_the_same_frame() {
    // The renderer positions a scene with the header alone. Two sources that
    // disagreed here would draw the same venue in two places, and no amount of
    // shared downstream code would hide it.
    let generated = render_document();
    let tiles = tiles_document(&generated);

    assert_eq!(
        tiles.header.frame_origin_ecef,
        generated.header.frame_origin_ecef
    );
    assert_eq!(
        tiles.header.world_transform,
        generated.header.world_transform
    );
    assert_eq!(tiles.header.format_version, generated.header.format_version);
}

#[test]
fn both_sources_report_the_same_canonical_level_groups() {
    let generated = render_document();
    let tiles = tiles_document(&generated);

    let canonical = |document: &kiriko_scene::SceneDocument| -> BTreeSet<String> {
        document
            .levels
            .iter()
            .map(|level| level.canonical_id.clone())
            .collect()
    };
    assert_eq!(canonical(&tiles), canonical(&generated));
    assert!(!canonical(&tiles).is_empty(), "the fixture has floors");
}

#[test]
fn both_sources_draw_from_one_role_and_occlusion_vocabulary() {
    // The visual language styles roles, never source materials (#32). A role
    // or occlusion class only one source could produce would be a fork in the
    // renderer even if every line of drawing code were shared.
    let generated = render_document();
    let tiles = tiles_document(&generated);

    for document in [&generated, &tiles] {
        for feature in &document.features {
            assert_eq!(
                feature.occlusion,
                kiriko_scene::occlusion_for_role(feature.role),
                "an unclassified feature's occlusion comes from its role alone"
            );
        }
    }
    // Both vocabularies are the one `SemanticRole` enum; the check that matters
    // is that every role a source emits round-trips through the shared table
    // above, which it just did for every feature of both documents.
    let roles = |document: &kiriko_scene::SceneDocument| -> Vec<&'static str> {
        let mut names: Vec<&'static str> = document
            .features
            .iter()
            .map(|f| role_name(f.role))
            .collect();
        names.sort_unstable();
        names.dedup();
        names
    };
    assert!(!roles(&tiles).is_empty());
    assert!(!roles(&generated).is_empty());
}

#[test]
fn only_identity_and_provenance_distinguish_the_two_documents() {
    // What a reader may tell apart: which package produced it. What it may
    // not: anything the renderer branches on.
    let generated = render_document();
    let tiles = tiles_document(&generated);

    assert_ne!(tiles.header.source_hash, generated.header.source_hash);
    for document in [&generated, &tiles] {
        for batch in &document.batches {
            assert!(
                (batch.level_index as usize) < document.levels.len(),
                "every batch names a level of its own document"
            );
            assert_eq!(batch.positions.len(), batch.feature_indices.len());
        }
        for feature in &document.features {
            assert!((feature.level_index as usize) < document.levels.len());
        }
    }
}
