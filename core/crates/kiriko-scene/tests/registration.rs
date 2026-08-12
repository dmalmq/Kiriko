//! Tile registration: composite level identity, floor planes resolved from
//! tile surfaces, and the residuals a producer's activation is gated on (#74).

mod support;

use kiriko_scene::{
    FrameTransform, RegistrationProfile, VenueFloor, measure_registration, read_glb,
    resolve_tile_levels,
};
use support::{FeatureSpec, glb_with_features, quad};

/// A venue floor whose only unit is the rectangle `min..max`, on plane 0.
fn venue_floor(level_id: &str, min: [f64; 2], max: [f64; 2]) -> VenueFloor {
    VenueFloor {
        level_id: level_id.to_string(),
        ordinal: 0.0,
        plane_z_m: 0.0,
        rings: vec![vec![
            [min[0], min[1]],
            [max[0], min[1]],
            [max[0], max[1]],
            [min[0], max[1]],
        ]],
        // Unlabelled: these tests measure geometry, and no label is the honest
        // "no corroboration available" case rather than a passing check.
        labels: Vec::new(),
    }
}

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

    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );

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

    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );

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

    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );

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

    let levels = resolve_tile_levels(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
    );

    assert_eq!(levels[0].resolved_plane_m, Some(4.0));
}

#[test]
fn a_tile_floor_on_the_venue_outline_registers_at_zero() {
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([0.0, 0.0], [40.0, 20.0], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", [0.0, 0.0], [40.0, 20.0])];

    let report = measure_registration(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    assert_eq!(report.floors.len(), 1);
    let floor = &report.floors[0];
    assert_eq!(floor.canonical_level_id, "level-1");
    let stats = floor.stats.expect("a mapped, sampled floor has residuals");
    assert!(stats.samples > 100, "the outline is sampled densely");
    assert!(stats.p90_m < 1e-9, "p90 was {}", stats.p90_m);
    assert!(floor.median_shift_m < 1e-9);
    assert!(floor.coherent_clusters.is_empty());
    assert!(report.unmapped_levels.is_empty());
}

#[test]
fn a_floor_offset_from_the_venue_reports_a_coherent_shift() {
    // The tile floor abuts the venue 0.2 m away along one edge. Only that edge
    // is close enough to be a correspondence; the rest is coverage difference.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([10.2, 0.0], [20.2, 20.0], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", [0.0, 0.0], [10.0, 20.0])];

    let report = measure_registration(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    let floor = &report.floors[0];
    assert!(
        (floor.median_offset_m[0] - 0.2).abs() < 1e-6,
        "east offset was {}",
        floor.median_offset_m[0]
    );
    assert!((floor.median_offset_m[1]).abs() < 1e-6);
    assert!((floor.median_shift_m - 0.2).abs() < 1e-6);
    let stats = floor.stats.expect("a mapped, sampled floor has residuals");
    assert!((stats.p90_m - 0.2).abs() < 1e-6);
}

#[test]
fn geometry_the_venue_does_not_model_is_carved_out_not_counted() {
    // #31's rule: a boundary sample more than a metre from every unit edge and
    // inside no unit is a model-coverage difference, not misregistration.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([10.2, 0.0], [20.2, 20.0], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", [0.0, 0.0], [10.0, 20.0])];

    let report = measure_registration(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    let floor = &report.floors[0];
    assert!(
        floor.carved_out > 0,
        "the overhanging three quarters of the tile floor is carved out"
    );
    let stats = floor.stats.expect("a mapped, sampled floor has residuals");
    assert!(
        stats.max_m < 1.0,
        "nothing beyond the carve-out band survives, but max was {}",
        stats.max_m
    );
    assert_eq!(floor.sampled, stats.samples + floor.carved_out);
}

#[test]
fn a_spatially_separated_pocket_of_large_residuals_is_a_coherent_cluster() {
    // An island of tile surface inside the venue with no venue edge near it:
    // the two Yaesu clusters (#31) in miniature, and the falsifier the gate
    // names as blocking.
    let mut triangles = quad([0.0, 0.0], [100.0, 40.0], 0.0);
    triangles.extend(quad([50.0, 20.0], [54.0, 24.0], 0.0));
    let glb = glb_with_features(&[FeatureSpec::new("floor-a", "Floors", "l1", 0.0, triangles)]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", [0.0, 0.0], [100.0, 40.0])];

    let report = measure_registration(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    let floor = &report.floors[0];
    assert_eq!(
        floor.coherent_clusters.len(),
        1,
        "one pocket, not one cluster per sample"
    );
    let cluster = &floor.coherent_clusters[0];
    assert!(cluster.samples >= 5);
    assert!(
        cluster.distance_m > 1.0,
        "cluster residual was {}",
        cluster.distance_m
    );
}

#[test]
fn a_level_whose_plane_matches_no_canonical_floor_is_reported_unmapped() {
    // Altitude resolves level identity first (#33). A tile level 8 m above
    // every canonical plane belongs to none of them, and guessing the nearest
    // is how a mezzanine ends up rendered as a concourse.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l9",
        8.0,
        quad([0.0, 0.0], [40.0, 20.0], 8.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", [0.0, 0.0], [40.0, 20.0])];

    let report = measure_registration(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    assert_eq!(report.unmapped_levels, vec!["asset-v1|station.rvt||l9|80"]);
    assert!(report.floors.is_empty(), "no floor was registered");
}

#[test]
fn the_profiles_vertical_offset_is_what_reconciles_two_datums() {
    // The venue GDB proves no floor elevation (#31: every exported Z was 0), so
    // tile heights and canonical planes can sit on different datums. The offset
    // is a recorded, versioned producer decision — never inferred, because
    // inferring it is how a mezzanine silently becomes a concourse.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([0.0, 0.0], [40.0, 20.0], 123.4),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", [0.0, 0.0], [40.0, 20.0])];
    let profile = RegistrationProfile {
        vertical_offset_m: -123.4,
        ..RegistrationProfile::default()
    };

    let report = measure_registration(
        std::slice::from_ref(&scene),
        "asset-v1",
        &FrameTransform::identity(),
        &venue,
        &profile,
    );

    assert!(report.unmapped_levels.is_empty(), "the offset places it");
    assert_eq!(report.floors.len(), 1);
    assert_eq!(report.applied_vertical_offset_m, -123.4);
    assert_eq!(
        report.levels[0].resolved_plane_m,
        Some(123.4),
        "the level's own measured plane is reported untouched"
    );
}

#[test]
fn content_split_across_several_members_registers_as_one_asset() {
    // A tileset graph normally references several content files. Each carries
    // its own feature table, so a per-member evaluation would report the same
    // canonical floor several times with a fraction of its evidence each.
    let west = glb_with_features(&[FeatureSpec::new(
        "floor-west",
        "Floors",
        "l1",
        0.0,
        quad([0.0, 0.0], [20.0, 20.0], 0.0),
    )]);
    let east = glb_with_features(&[FeatureSpec::new(
        "floor-east",
        "Floors",
        "l1",
        0.0,
        quad([20.0, 0.0], [40.0, 20.0], 0.0),
    )]);
    let scenes = [
        read_glb(&west).expect("west reads"),
        read_glb(&east).expect("east reads"),
    ];
    let venue = [venue_floor("level-1", [0.0, 0.0], [40.0, 20.0])];

    let report = measure_registration(
        &scenes,
        "asset-v1",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    assert_eq!(
        report.levels.len(),
        1,
        "one composite level, not one per file"
    );
    assert_eq!(
        report.levels[0].source_object_ids,
        ["floor-west", "floor-east"]
    );
    assert_eq!(report.floors.len(), 1);
    let stats = report.floors[0]
        .stats
        .expect("a mapped, sampled floor has residuals");
    assert!(
        stats.p90_m < 1e-9,
        "the seam where two members meet is interior geometry, not a boundary: p90 was {}",
        stats.p90_m
    );
}

/// The same rectangle, on an arbitrary plane: a stack to check mappings against.
fn venue_floor_at(level_id: &str, plane_z_m: f64) -> VenueFloor {
    VenueFloor {
        plane_z_m,
        ..venue_floor(level_id, [0.0, 0.0], [10.0, 10.0])
    }
}

/// A walkable quad covering the venue rectangle at `plane`, on its own level.
fn tile_floor_at(level_key: &str, plane: f32) -> Vec<u8> {
    glb_with_features(&[FeatureSpec::new(
        &format!("floor-{level_key}"),
        "Floors",
        level_key,
        plane,
        quad([0.0, 0.0], [10.0, 10.0], plane),
    )])
}

#[test]
fn a_level_inside_the_tolerance_of_two_floors_is_ambiguous_not_nearest() {
    // The tolerance is wider than some floor-to-floor gaps. Picking the nearer
    // of two candidates would be a guess presented as an identification, and a
    // producer would never learn a choice had been made.
    let glb = tile_floor_at("l1", 0.4);
    let scenes = [read_glb(&glb).expect("fixture parses")];
    let venue = [venue_floor_at("upper", 1.0), venue_floor_at("lower", 0.0)];

    let report = measure_registration(
        &scenes,
        "asset",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    assert_eq!(report.ambiguous_levels.len(), 1);
    // Still mapped, and to the nearer floor: the report describes what happened.
    // The gate is what refuses to act on it.
    assert_eq!(
        report.levels[0].mapped_canonical_level_id.as_deref(),
        Some("lower")
    );
    assert_eq!(report.levels[0].mapped_floor_plane_m, Some(0.0));
}

#[test]
fn a_level_reports_the_floor_it_matched_and_that_floor_s_own_plane() {
    // The one decision in this report a producer must check by eye, so both
    // planes have to reach them: a whole stack offset by a storey maps every
    // level to its neighbour and every residual still measures small.
    let glb = tile_floor_at("l1", 4.0);
    let scenes = [read_glb(&glb).expect("fixture parses")];
    let venue = [venue_floor_at("second", 4.0), venue_floor_at("first", 0.0)];

    let report = measure_registration(
        &scenes,
        "asset",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    assert_eq!(
        report.levels[0].mapped_canonical_level_id.as_deref(),
        Some("second")
    );
    assert_eq!(report.levels[0].resolved_plane_m, Some(4.0));
    assert_eq!(report.levels[0].mapped_floor_plane_m, Some(4.0));
    assert!(report.ambiguous_levels.is_empty());
}

#[test]
fn a_floor_with_no_surviving_samples_reports_no_residuals_rather_than_zeroes() {
    // Zeroed statistics read exactly like perfect agreement. A floor nothing was
    // measured against must say so, or the number is a lie with a decimal point.
    let glb = tile_floor_at("l1", 0.0);
    let scenes = [read_glb(&glb).expect("fixture parses")];
    // The venue floor is far away in plan, so every sample is carved out as a
    // model-coverage difference rather than counted as a residual.
    let venue = [venue_floor("only", [500.0, 500.0], [510.0, 510.0])];

    let report = measure_registration(
        &scenes,
        "asset",
        &FrameTransform::identity(),
        &venue,
        &RegistrationProfile::default(),
    );

    assert!(report.venue_wide.is_none(), "nothing was measured");
    for floor in &report.floors {
        assert!(floor.stats.is_none(), "no samples survived on any floor");
    }
}
