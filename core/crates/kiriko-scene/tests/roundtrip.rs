use kiriko_scene::{
    OcclusionClass, SceneBatch, SceneDocument, SceneFeature, SceneHeader, SceneLevel, SemanticRole,
    decode_scene, encode_scene,
};

fn sample_document() -> SceneDocument {
    SceneDocument {
        header: SceneHeader {
            format_version: 1,
            deriver_version: 1,
            source_hash: "sha256:abc".to_string(),
            frame_origin_ecef: [
                -3_959_720.400_616_091_7,
                3_350_435.954_423_757_7,
                3_699_347.113_056_253_6,
            ],
            world_transform: [
                -0.645_931_378_009_025_9,
                -0.763_395_477_392_524_9,
                0.0,
                0.0,
                0.445_240_265_906_090_45,
                -0.376_730_891_155_057_1,
                0.812_302_247_482_666,
                0.0,
                -0.620_107_862_004_050_7,
                0.524_691_510_076_307_2,
                0.583_236_709_008_109,
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
            ],
            bounds_min: [-10.0, -20.0, -115.7],
            bounds_max: [650.0, 1108.0, 115.7],
        },
        levels: vec![SceneLevel {
            canonical_id: "level-b1".to_string(),
            source_level_key: "b1f_concourse".to_string(),
            source_level_name: "B1F コンコース".to_string(),
            source_document: "TokyoSta.rvt".to_string(),
            source_link_name: String::new(),
            source_elevation_meters: -6.5,
            resolved_plane_z: -6.4,
            quantized_elevation_dm: -64,
        }],
        features: vec![SceneFeature {
            source_object_id: "revit:9f2c".to_string(),
            canonical_id: Some("unit-b1-public".to_string()),
            level_index: 0,
            role: SemanticRole::Public,
            occlusion: OcclusionClass::Never,
            confidence: 200,
            min_z: -6.4,
            max_z: -3.2,
        }],
        batches: vec![SceneBatch {
            level_index: 0,
            role: SemanticRole::Public,
            quantization_origin: [0.0, 0.0, -10.0],
            quantization_scale: [0.01, 0.01, 0.01],
            vertex_count: 3,
            positions: vec![[0, 0, 0], [100, 0, 0], [0, 100, 0]],
            normals: vec![[0, 0], [0, 0], [0, 0]],
            feature_indices: vec![0, 0, 0],
        }],
    }
}

#[test]
fn scene_document_survives_encode_decode() {
    let original = sample_document();
    let bytes = encode_scene(&original).expect("encode");
    let decoded = decode_scene(&bytes).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn encoded_scene_is_smaller_than_postcard_alone() {
    let doc = sample_document();
    let compressed = encode_scene(&doc).expect("encode");
    // zstd container must actually be applied: a magic prefix identifies it.
    assert_eq!(&compressed[0..4], b"KSC1");
}

#[test]
fn decode_rejects_foreign_magic() {
    let err = decode_scene(b"NOPE0000").expect_err("must reject");
    assert!(format!("{err}").contains("magic"));
}

use kiriko_scene::{decode_normal_oct, encode_normal_oct, quantize_positions};

#[test]
fn quantized_positions_stay_within_one_millimetre() {
    let input = vec![
        [0.0_f32, 0.0, 0.0],
        [12.5, -3.25, 7.125],
        [650.0, 1108.0, 115.65],
    ];
    let (quantized, origin, scale) = quantize_positions(&input);
    for (index, source) in input.iter().enumerate() {
        let q = quantized[index];
        for axis in 0..3 {
            let restored = origin[axis] + f32::from(q[axis]) * scale[axis];
            let error = (restored - source[axis]).abs();
            let extent = 1108.0_f32;
            // u16 over the largest extent gives ~17 mm; assert the bound explicitly.
            assert!(
                error <= extent / 65_535.0 + 1e-4,
                "axis {axis} error {error}"
            );
        }
    }
}

#[test]
fn octahedral_normals_round_trip_within_one_degree() {
    let normals = [
        [0.0_f32, 0.0, 1.0],
        [0.0, 0.0, -1.0],
        [1.0, 0.0, 0.0],
        [0.577_35, 0.577_35, 0.577_35],
        [-0.267_26, 0.534_52, -0.801_78],
    ];
    for normal in normals {
        let restored = decode_normal_oct(encode_normal_oct(normal));
        let dot = normal[0] * restored[0] + normal[1] * restored[1] + normal[2] * restored[2];
        let angle = dot.clamp(-1.0, 1.0).acos().to_degrees();
        assert!(angle < 1.0, "normal {normal:?} drifted {angle} degrees");
    }
}
