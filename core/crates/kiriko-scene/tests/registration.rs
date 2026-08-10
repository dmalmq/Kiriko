//! Tile registration: composite level identity, floor planes resolved from
//! tile surfaces, and the residuals a producer's activation is gated on (#74).

mod support;

use kiriko_scene::{FrameTransform, read_glb, resolve_tile_levels};
use support::{FeatureSpec, glb_with_features, quad};

#[test]
fn a_level_plane_resolves_from_its_walkable_surfaces_not_its_metadata() {
    // KITTE's case (#31): `levelElevationMeters` sits 3.02 m above the mesh.
    // The mesh wins, and the disagreement is recorded rather than discarded.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "b1fl",
        15.02,
        quad([0.0, 0.0], [10.0, 10.0], 12.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");

    let levels = resolve_tile_levels(&scene, "asset-v1", &FrameTransform::identity());

    assert_eq!(levels.len(), 1);
    let level = &levels[0];
    assert_eq!(level.resolved_plane_m, Some(12.0));
    let difference = level
        .metadata_difference_m
        .expect("a disagreement is recorded");
    assert!(
        (difference - 3.02).abs() < 1e-3,
        "metadata difference was {difference}"
    );
}

#[test]
fn a_level_without_surface_geometry_resolves_no_plane() {
    // Walls alone cannot place a floor: there is no walkable surface to read a
    // plane from, and inventing one from the metadata is exactly what #31 ruled
    // out. The level survives so the gate can name it.
    let glb = glb_with_features(&[FeatureSpec::new(
        "wall-a",
        "Walls",
        "b1fl",
        15.02,
        quad([0.0, 0.0], [10.0, 0.2], 12.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");

    let levels = resolve_tile_levels(&scene, "asset-v1", &FrameTransform::identity());

    assert_eq!(levels.len(), 1);
    assert_eq!(levels[0].resolved_plane_m, None);
    assert_eq!(levels[0].metadata_difference_m, None);
}

#[test]
fn one_level_key_at_two_elevations_is_two_composite_levels() {
    // 11 of the Tokyo asset's 90 level keys occur at several elevations, and
    // generic keys like `b1fl` appear in four linked models. A level key is
    // therefore never an identity on its own.
    let glb = glb_with_features(&[
        FeatureSpec::new(
            "floor-a",
            "Floors",
            "b1fl",
            -3.1,
            quad([0.0, 0.0], [10.0, 10.0], -3.1),
        ),
        FeatureSpec::new(
            "floor-b",
            "Floors",
            "b1fl",
            -1.25,
            quad([20.0, 0.0], [30.0, 10.0], -1.25),
        )
        .in_document("kitte.rvt", "kitte-link"),
    ]);
    let scene = read_glb(&glb).expect("fixture glb reads");

    let levels = resolve_tile_levels(&scene, "asset-v1", &FrameTransform::identity());

    assert_eq!(levels.len(), 2);
    let ids: Vec<&str> = levels.iter().map(|l| l.composite_id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "asset-v1|kitte.rvt|kitte-link|b1fl|-13",
            "asset-v1|station.rvt||b1fl|-31",
        ],
        "composite identity carries document, link, key, and quantized elevation"
    );
}

#[test]
fn a_levels_plane_is_the_dominant_surface_height_not_an_average() {
    // A floor with a small raised platform is still one floor. The mode is what
    // #31 measured; a mean would place the plane where no surface is.
    let mut triangles = quad([0.0, 0.0], [20.0, 20.0], 4.0);
    triangles.extend(quad([0.0, 0.0], [2.0, 2.0], 5.2));
    let glb = glb_with_features(&[FeatureSpec::new("floor-a", "Floors", "l1", 4.0, triangles)]);
    let scene = read_glb(&glb).expect("fixture glb reads");

    let levels = resolve_tile_levels(&scene, "asset-v1", &FrameTransform::identity());

    assert_eq!(levels[0].resolved_plane_m, Some(4.0));
}
