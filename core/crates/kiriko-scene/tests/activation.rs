//! The activation gates: what stops an ingested package from becoming a
//! venue's primary view (#74, #30 section 3).
//!
//! Every gate gets a package that fails exactly it, so a gate cannot be
//! satisfied by another gate's refusal and a passing package cannot be passing
//! by accident.

mod support;

use std::collections::BTreeSet;

use kiriko_scene::{
    ActivationInput, FrameTransform, GateCode, RegistrationProfile, VenueFloor,
    evaluate_activation, read_glb,
};
use support::{FeatureSpec, glb_with_features, quad};

fn venue_floor(level_id: &str, plane_z_m: f64, min: [f64; 2], max: [f64; 2]) -> VenueFloor {
    VenueFloor {
        level_id: level_id.to_string(),
        ordinal: 0.0,
        plane_z_m,
        rings: vec![vec![
            [min[0], min[1]],
            [max[0], min[1]],
            [max[0], max[1]],
            [min[0], max[1]],
        ]],
    }
}

/// A package that registers cleanly: one floor exactly on the venue outline.
fn registered_package() -> Vec<u8> {
    glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([0.0, 0.0], [40.0, 20.0], 0.0),
    )])
}

fn input<'a>(contextual: &'a BTreeSet<String>) -> ActivationInput<'a> {
    ActivationInput {
        asset_version: "asset-v1",
        integrity_verified: true,
        capability_profile: Some("webgl2-mrt-float"),
        contextual_source_objects: contextual,
    }
}

fn codes(gates: &[kiriko_scene::GateFailure]) -> Vec<GateCode> {
    gates.iter().map(|gate| gate.code).collect()
}

#[test]
fn a_registered_package_passes_every_gate() {
    let scene = read_glb(&registered_package()).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&contextual),
        &FrameTransform::identity(),
    );

    assert_eq!(codes(&evaluation.gates), Vec::<GateCode>::new());
    assert!(evaluation.passes());
    assert_eq!(
        evaluation.floor_mappings,
        vec![(
            "level-1".to_string(),
            vec!["asset-v1|station.rvt||l1|0".to_string()]
        )],
        "the registration table maps the canonical floor to its composite level"
    );
}

#[test]
fn unverified_package_integrity_blocks_activation() {
    let scene = read_glb(&registered_package()).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();
    let mut request = input(&contextual);
    request.integrity_verified = false;

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &request,
        &FrameTransform::identity(),
    );

    assert_eq!(
        codes(&evaluation.gates),
        vec![GateCode::IntegrityUnresolved]
    );
}

#[test]
fn a_missing_capability_profile_blocks_activation() {
    let scene = read_glb(&registered_package()).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();
    let mut request = input(&contextual);
    request.capability_profile = None;

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &request,
        &FrameTransform::identity(),
    );

    assert_eq!(
        codes(&evaluation.gates),
        vec![GateCode::CapabilityProfileMissing]
    );
}

#[test]
fn a_p90_beyond_the_floors_band_blocks_activation() {
    // The tile floor is inset 0.8 m inside the venue outline all round, so every
    // surviving sample is 0.8 m from a unit edge and inside a unit — a real
    // residual, not a coverage difference.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([0.8, 0.8], [39.2, 19.2], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&contextual),
        &FrameTransform::identity(),
    );

    assert_eq!(
        codes(&evaluation.gates),
        vec![GateCode::RegistrationOutOfBand]
    );
    let gate = &evaluation.gates[0];
    assert_eq!(gate.subject, "level-1");
    assert_eq!(gate.band, Some(0.50));
    assert!(
        gate.measured.is_some_and(|m| (m - 0.8).abs() < 1e-6),
        "measured p90 was {:?}",
        gate.measured
    );
}

#[test]
fn a_floors_own_measured_band_is_what_it_is_held_to() {
    // Tokyo's floors measured 0.433 to 0.608 m carved, so a single band is an
    // approximation. A profile carrying the floor's own band admits it.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([0.6, 0.6], [39.4, 19.4], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();
    let mut profile = RegistrationProfile::default();
    profile.floor_p90_max_m.insert("level-1".into(), 0.65);

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &profile,
        &input(&contextual),
        &FrameTransform::identity(),
    );

    assert_eq!(codes(&evaluation.gates), Vec::<GateCode>::new());
}

#[test]
fn a_coherent_shift_beyond_the_band_blocks_activation() {
    // The tile floor abuts the venue 0.2 m away: p90 is inside the band, but
    // every correspondence agrees on the same direction, which is displacement.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([40.2, 0.0], [80.2, 20.0], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&contextual),
        &FrameTransform::identity(),
    );

    assert_eq!(
        codes(&evaluation.gates),
        vec![GateCode::CoherentShiftOutOfBand]
    );
    assert_eq!(evaluation.gates[0].band, Some(0.15));
}

#[test]
fn a_spatially_separated_coherent_residual_blocks_activation() {
    let mut triangles = quad([0.0, 0.0], [100.0, 40.0], 0.0);
    triangles.extend(quad([50.0, 20.0], [54.0, 24.0], 0.0));
    let glb = glb_with_features(&[FeatureSpec::new("floor-a", "Floors", "l1", 0.0, triangles)]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [100.0, 40.0])];
    let contextual = BTreeSet::new();

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&contextual),
        &FrameTransform::identity(),
    );

    assert!(
        codes(&evaluation.gates).contains(&GateCode::CoherentResidual),
        "gates were {:?}",
        codes(&evaluation.gates)
    );
}

#[test]
fn a_rendered_level_without_a_resolved_plane_blocks_activation() {
    let glb = glb_with_features(&[FeatureSpec::new(
        "wall-a",
        "Walls",
        "l1",
        0.0,
        quad([0.0, 0.0], [40.0, 0.2], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&contextual),
        &FrameTransform::identity(),
    );

    assert_eq!(
        codes(&evaluation.gates),
        vec![GateCode::LevelPlaneUnresolved]
    );
    assert_eq!(evaluation.gates[0].subject, "asset-v1|station.rvt||l1|0");
}

#[test]
fn a_rendered_level_with_no_canonical_mapping_blocks_activation() {
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l9",
        8.0,
        quad([0.0, 0.0], [40.0, 20.0], 8.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&contextual),
        &FrameTransform::identity(),
    );

    assert_eq!(codes(&evaluation.gates), vec![GateCode::LevelNotMapped]);
    assert_eq!(evaluation.gates[0].subject, "asset-v1|station.rvt||l9|80");
}

#[test]
fn opaque_content_belonging_to_no_level_blocks_until_it_is_classified() {
    // Site mass with no level key: it can never be assigned to a floor, so it
    // renders only once a producer says what it is. Otherwise it is an
    // always-visible blocker in front of the venue (#32 section 6).
    let mut context = FeatureSpec::new(
        "mass-a",
        "Generic Models",
        "",
        0.0,
        quad([0.0, 0.0], [40.0, 20.0], 6.0),
    );
    context.level_name = String::new();
    let glb = glb_with_features(&[
        FeatureSpec::new(
            "floor-a",
            "Floors",
            "l1",
            0.0,
            quad([0.0, 0.0], [40.0, 20.0], 0.0),
        ),
        context,
    ]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];

    let unclassified = BTreeSet::new();
    let blocked = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&unclassified),
        &FrameTransform::identity(),
    );
    assert_eq!(
        codes(&blocked.gates),
        vec![GateCode::UnclassifiedOpaqueContent]
    );
    assert_eq!(blocked.gates[0].subject, "mass-a");

    let classified = BTreeSet::from(["mass-a".to_string()]);
    let allowed = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&classified),
        &FrameTransform::identity(),
    );
    assert_eq!(codes(&allowed.gates), Vec::<GateCode>::new());
}

#[test]
fn an_evaluation_serialises_with_the_names_the_bridge_reads() {
    // The server stores this JSON with the activation and the producer UI keys
    // its copy off the gate code, so the names are contract, not detail.
    let glb = glb_with_features(&[FeatureSpec::new(
        "floor-a",
        "Floors",
        "l1",
        0.0,
        quad([0.8, 0.8], [39.2, 19.2], 0.0),
    )]);
    let scene = read_glb(&glb).expect("fixture glb reads");
    let venue = [venue_floor("level-1", 0.0, [0.0, 0.0], [40.0, 20.0])];
    let contextual = BTreeSet::new();

    let evaluation = evaluate_activation(
        std::slice::from_ref(&scene),
        &venue,
        &RegistrationProfile::default(),
        &input(&contextual),
        &FrameTransform::identity(),
    );
    let value: serde_json::Value =
        serde_json::to_value(&evaluation).expect("an evaluation serialises");

    assert_eq!(value["gates"][0]["code"], "registrationOutOfBand");
    assert_eq!(value["gates"][0]["subject"], "level-1");
    assert_eq!(value["gates"][0]["band"], 0.5);
    assert_eq!(value["report"]["profileId"], "default");
    assert_eq!(value["report"]["profileVersion"], 1);
    assert_eq!(value["report"]["floors"][0]["canonicalLevelId"], "level-1");
    assert_eq!(
        value["report"]["levels"][0]["compositeId"],
        "asset-v1|station.rvt||l1|0"
    );
    assert!(value["report"]["floors"][0]["stats"]["p90M"].is_number());
    assert_eq!(value["floorMappings"][0][0], "level-1");

    // And the profile the activation is stored against round-trips, so a
    // published version can be re-read under the profile it was judged by.
    let profile = serde_json::to_value(RegistrationProfile::default()).expect("profile serialises");
    assert_eq!(profile["p90MaxM"], 0.5);
    assert_eq!(profile["verticalOffsetM"], 0.0);
    let restored: RegistrationProfile =
        serde_json::from_value(profile).expect("profile round-trips");
    assert_eq!(restored, RegistrationProfile::default());
}
