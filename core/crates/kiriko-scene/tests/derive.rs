use kiriko_scene::read_glb;
use support::{synthetic_glb, synthetic_glb_with};

mod support;

#[test]
fn reads_primitives_and_feature_rows() {
    let scene = read_glb(&synthetic_glb()).expect("read glb");
    assert_eq!(scene.primitives.len(), 2);
    assert_eq!(scene.primitives[0].positions.len(), 3);
    assert_eq!(scene.primitives[0].feature_id, 0);
    assert_eq!(scene.primitives[1].feature_id, 1);
    assert_eq!(scene.features.len(), 2);
    assert_eq!(scene.features[0].revit_unique_id, "elem-a");
    assert_eq!(scene.features[1].revit_unique_id, "elem-b");
    assert_eq!(scene.features[0].level_key, "elem-a");
    assert!((scene.features[0].level_elevation_meters + 6.5).abs() < 1e-6);
    assert!((scene.features[1].level_elevation_meters - 3.5).abs() < 1e-6);
}

#[test]
fn rejects_non_glb_input() {
    let err = read_glb(b"not a glb at all").expect_err("must reject");
    assert!(format!("{err}").contains("glb"));
}

#[test]
fn resolves_non_identity_indices_into_triangle_order() {
    // Reversed index buffer over the first primitive's three vertices.
    let scene = read_glb(&synthetic_glb_with(Some(&[2, 1, 0]))).expect("read glb");
    let first = &scene.primitives[0];
    assert!(!first.indices_were_identity);
    // Source vertex 2 is (0,1,0); after the gather it must come first.
    assert_eq!(first.positions[0], [0.0, 1.0, 0.0]);
    assert_eq!(first.positions[2], [0.0, 0.0, 0.0]);
}

#[test]
fn identity_indices_take_the_fast_path() {
    let scene = read_glb(&synthetic_glb_with(Some(&[0, 1, 2]))).expect("read glb");
    assert!(scene.primitives[0].indices_were_identity);
    assert_eq!(scene.primitives[0].positions[0], [0.0, 0.0, 0.0]);
}

use kiriko_scene::{SemanticRole, derive_scene, role_for_category};

#[test]
fn maps_revit_categories_onto_semantic_roles() {
    assert_eq!(role_for_category("Floors"), SemanticRole::Walkable);
    assert_eq!(role_for_category("Ceilings"), SemanticRole::Ceiling);
    assert_eq!(role_for_category("Walls"), SemanticRole::Structure);
    assert_eq!(role_for_category("Doors"), SemanticRole::Opening);
    assert_eq!(role_for_category("Stairs"), SemanticRole::Stairs);
    assert_eq!(role_for_category("Escalators"), SemanticRole::Escalator);
    assert_eq!(role_for_category("Elevators"), SemanticRole::Elevator);
    assert_eq!(role_for_category("Ramps"), SemanticRole::Ramp);
    assert_eq!(role_for_category("Columns"), SemanticRole::Structure);
    // Unknown categories become contextual mass, never navigable surface.
    assert_eq!(role_for_category("Generic Models"), SemanticRole::Context);
    assert_eq!(role_for_category(""), SemanticRole::Context);
}

#[test]
fn maps_revit_stair_components_and_supports() {
    assert_eq!(role_for_category("Runs"), SemanticRole::Stairs);
    assert_eq!(role_for_category("Landings"), SemanticRole::Stairs);
    assert_eq!(role_for_category("Supports"), SemanticRole::Structure);
    assert_eq!(role_for_category("Wall Sweeps"), SemanticRole::Structure);
    assert_eq!(
        role_for_category("Structural Framing"),
        SemanticRole::Structure
    );
    assert_eq!(
        role_for_category("Mechanical Equipment"),
        SemanticRole::Service
    );
    // Genuinely ambiguous mass stays contextual rather than guessing.
    assert_eq!(
        role_for_category("Specialty Equipment"),
        SemanticRole::Context
    );
    assert_eq!(role_for_category("Curtain Panels"), SemanticRole::Context);
}

#[test]
fn derive_merges_primitives_into_one_batch_per_level_and_role() {
    let levels = br#"{"version":1,"levels":[
        {"levelKey":"elem-a","levelName":"B1","levelElevationMeters":-6.5,"elementCount":1,"minZMeters":-6.5,"maxZMeters":-3.0},
        {"levelKey":"elem-b","levelName":"1F","levelElevationMeters":3.5,"elementCount":1,"minZMeters":3.5,"maxZMeters":7.0}
    ]}"#;
    let identity = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    let document = derive_scene(&synthetic_glb(), levels, "sha256:test", identity).expect("derive");

    assert_eq!(document.levels.len(), 2);
    assert_eq!(document.features.len(), 2);
    // Two features on different levels, same role -> two batches, not one.
    assert_eq!(document.batches.len(), 2);
    for batch in &document.batches {
        assert_eq!(batch.vertex_count, 3);
        assert_eq!(batch.positions.len(), 3);
        assert_eq!(batch.normals.len(), 3);
        assert_eq!(batch.feature_indices.len(), 3);
    }
    // Feature indices must address the document's feature table.
    for batch in &document.batches {
        for index in &batch.feature_indices {
            assert!((*index as usize) < document.features.len());
        }
    }
}

#[test]
fn derive_assigns_features_to_levels_by_level_key() {
    let levels = br#"{"version":1,"levels":[
        {"levelKey":"elem-b","levelName":"1F","levelElevationMeters":3.5,"elementCount":1,"minZMeters":3.5,"maxZMeters":7.0},
        {"levelKey":"elem-a","levelName":"B1","levelElevationMeters":-6.5,"elementCount":1,"minZMeters":-6.5,"maxZMeters":-3.0}
    ]}"#;
    let identity = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    let document = derive_scene(&synthetic_glb(), levels, "sha256:test", identity).expect("derive");
    let first = &document.features[0];
    let level = &document.levels[first.level_index as usize];
    assert_eq!(level.source_level_key, "elem-a");
    assert_eq!(level.quantized_elevation_dm, -65);
}

#[test]
fn computes_flat_normals_when_a_primitive_omits_them() {
    // NORMAL is optional in glTF: a renderer is expected to shade from the
    // winding. Refusing such an export would reject spec-valid content over an
    // attribute the deriver can compute.
    let mut glb = synthetic_glb();
    let without_normals = strip_attribute(&mut glb, "NORMAL");

    let scene = read_glb(&without_normals).expect("a primitive without NORMAL still reads");
    assert!(!scene.primitives.is_empty());
    for primitive in &scene.primitives {
        assert_eq!(primitive.normals.len(), primitive.positions.len());
        for normal in &primitive.normals {
            let length =
                (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
            assert!((length - 1.0).abs() < 1e-5, "normal is unit: {normal:?}");
        }
    }

    // The fixture's triangles lie in planes of constant z, so the computed
    // normals point along z rather than in an arbitrary direction.
    for primitive in &scene.primitives {
        for normal in &primitive.normals {
            assert!(
                normal[2].abs() > 0.99,
                "flat facet normal faces z: {normal:?}"
            );
        }
    }
}

#[test]
fn still_refuses_content_with_no_feature_ids() {
    // Feature ids are not optional for Kiriko: they are the source-object
    // identity picking resolves against, so content without them cannot be a
    // tiles source however well it renders.
    let mut glb = synthetic_glb();
    let without_ids = strip_attribute(&mut glb, "_FEATURE_ID_0");
    let error = read_glb(&without_ids).expect_err("missing feature ids is refused");
    assert!(format!("{error}").contains("_FEATURE_ID_0"), "got {error}");
}

/// Remove one attribute from every primitive of a GLB's JSON chunk, keeping the
/// container's chunk lengths valid.
fn strip_attribute(glb: &mut [u8], attribute: &str) -> Vec<u8> {
    let json_length = u32::from_le_bytes([glb[12], glb[13], glb[14], glb[15]]) as usize;
    let json_start = 20;
    let json = std::str::from_utf8(&glb[json_start..json_start + json_length])
        .expect("json chunk is utf8");
    let mut root: serde_json::Value = serde_json::from_str(json.trim_end()).expect("parse gltf");
    for mesh in root["meshes"].as_array_mut().expect("meshes") {
        for primitive in mesh["primitives"].as_array_mut().expect("primitives") {
            primitive["attributes"]
                .as_object_mut()
                .expect("attributes")
                .remove(attribute);
        }
    }

    let mut new_json = serde_json::to_vec(&root).expect("serialize gltf");
    while !new_json.len().is_multiple_of(4) {
        new_json.push(b' ');
    }
    let bin = &glb[json_start + json_length + 8..];
    let mut out = Vec::with_capacity(20 + new_json.len() + 8 + bin.len());
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2_u32.to_le_bytes());
    out.extend_from_slice(&((28 + new_json.len() + bin.len()) as u32).to_le_bytes());
    out.extend_from_slice(&(new_json.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&new_json);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(bin);
    out
}
