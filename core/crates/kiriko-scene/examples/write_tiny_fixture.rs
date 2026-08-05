//! Rebuild the spike's committed `.kscene` test fixture.
//!
//! Builds the same synthetic two-triangle GLB as `tests/derive.rs`, derives
//! it with the identity world transform, and writes the encoded scene to
//! `src/spikes/renderer/fixtures/tiny.kscene` (relative to the repo root —
//! run from there, as the plan's command does).
//!
//! Run: cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene \
//!        --example write_tiny_fixture

use std::{fs, path::PathBuf};

use kiriko_scene::{derive_scene, encode_scene};
use serde_json::json;

/// Build a two-triangle GLB with one property table row per triangle.
/// Layout: positions f32x3, normals f32x3, feature ids u32, then the
/// EXT_structural_metadata string data and offsets. When `indices` is present
/// they are appended to the BIN chunk and wired to the first primitive.
/// Copied verbatim from `tests/derive.rs` so the fixture always matches the
/// deriver's own test input.
fn synthetic_glb_with(indices: Option<&[u32]>) -> Vec<u8> {
    let positions: [[f32; 3]; 6] = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 3.0],
        [1.0, 0.0, 3.0],
        [0.0, 1.0, 3.0],
    ];
    let normals: [[f32; 3]; 6] = [[0.0, 0.0, 1.0]; 6];
    let feature_ids: [u32; 6] = [0, 0, 0, 1, 1, 1];

    let mut bin: Vec<u8> = Vec::new();
    for position in positions {
        for value in position {
            bin.extend_from_slice(&value.to_le_bytes());
        }
    }
    let normals_offset = bin.len();
    for normal in normals {
        for value in normal {
            bin.extend_from_slice(&value.to_le_bytes());
        }
    }
    let ids_offset = bin.len();
    for id in feature_ids {
        bin.extend_from_slice(&id.to_le_bytes());
    }

    // String property: two rows, "elem-a" and "elem-b".
    let strings_offset = bin.len();
    bin.extend_from_slice(b"elem-aelem-b");
    let string_offsets_offset = bin.len();
    for offset in [0_u32, 6, 12] {
        bin.extend_from_slice(&offset.to_le_bytes());
    }
    // Float property: level elevation for two rows.
    let elevation_offset = bin.len();
    for value in [-6.5_f32, 3.5] {
        bin.extend_from_slice(&value.to_le_bytes());
    }
    let indices_offset = bin.len();
    if let Some(indices) = indices {
        for &value in indices {
            bin.extend_from_slice(&value.to_le_bytes());
        }
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }

    let mut gltf = json!({
        "asset": { "version": "2.0" },
        "extensionsUsed": ["EXT_mesh_features", "EXT_structural_metadata"],
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0 }],
        "meshes": [{ "primitives": [
            {
                "mode": 4,
                "material": 0,
                "attributes": { "POSITION": 0, "NORMAL": 1, "_FEATURE_ID_0": 2 },
                "extensions": { "EXT_mesh_features": { "featureIds": [
                    { "featureCount": 2, "attribute": 0, "propertyTable": 0, "label": "element" }
                ] } }
            },
            {
                "mode": 4,
                "material": 0,
                "attributes": { "POSITION": 3, "NORMAL": 4, "_FEATURE_ID_0": 5 },
                "extensions": { "EXT_mesh_features": { "featureIds": [
                    { "featureCount": 2, "attribute": 0, "propertyTable": 0, "label": "element" }
                ] } }
            }
        ] }],
        "materials": [{ "name": "generic" }],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3" },
            { "bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3" },
            { "bufferView": 2, "componentType": 5125, "count": 3, "type": "SCALAR", "min": [0.0], "max": [0.0] },
            { "bufferView": 3, "componentType": 5126, "count": 3, "type": "VEC3" },
            { "bufferView": 4, "componentType": 5126, "count": 3, "type": "VEC3" },
            { "bufferView": 5, "componentType": 5125, "count": 3, "type": "SCALAR", "min": [1.0], "max": [1.0] }
        ],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": 36 },
            { "buffer": 0, "byteOffset": normals_offset, "byteLength": 36 },
            { "buffer": 0, "byteOffset": ids_offset, "byteLength": 12 },
            { "buffer": 0, "byteOffset": 36, "byteLength": 36 },
            { "buffer": 0, "byteOffset": normals_offset + 36, "byteLength": 36 },
            { "buffer": 0, "byteOffset": ids_offset + 12, "byteLength": 12 },
            { "buffer": 0, "byteOffset": strings_offset, "byteLength": 12 },
            { "buffer": 0, "byteOffset": string_offsets_offset, "byteLength": 12 },
            { "buffer": 0, "byteOffset": elevation_offset, "byteLength": 8 }
        ],
        "buffers": [{ "byteLength": bin.len() }],
        "extensions": { "EXT_structural_metadata": {
            "schema": { "classes": { "element": { "properties": {
                "revitUniqueId": { "type": "STRING" },
                "levelKey": { "type": "STRING" },
                "levelElevationMeters": { "type": "SCALAR", "componentType": "FLOAT32" }
            } } } },
            "propertyTables": [{ "class": "element", "count": 2, "properties": {
                "revitUniqueId": { "values": 6, "stringOffsets": 7 },
                "levelKey": { "values": 6, "stringOffsets": 7 },
                "levelElevationMeters": { "values": 8 }
            } }]
        } }
    });

    if let Some(indices) = indices {
        let view_index = gltf["bufferViews"]
            .as_array()
            .map(Vec::len)
            .expect("bufferViews");
        let accessor_index = gltf["accessors"]
            .as_array()
            .map(Vec::len)
            .expect("accessors");
        gltf["bufferViews"]
            .as_array_mut()
            .expect("bufferViews")
            .push(json!({ "buffer": 0, "byteOffset": indices_offset, "byteLength": indices.len() * 4 }));
        gltf["accessors"]
            .as_array_mut()
            .expect("accessors")
            .push(json!({ "bufferView": view_index, "componentType": 5125, "count": indices.len(), "type": "SCALAR" }));
        gltf["meshes"][0]["primitives"][0]["indices"] = json!(accessor_index);
    }

    let mut json_chunk = serde_json::to_vec(&gltf).expect("serialize gltf");
    while !json_chunk.len().is_multiple_of(4) {
        json_chunk.push(b' ');
    }

    let mut glb: Vec<u8> = Vec::new();
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2_u32.to_le_bytes());
    let total = 12 + 8 + json_chunk.len() + 8 + bin.len();
    glb.extend_from_slice(&(total as u32).to_le_bytes());
    glb.extend_from_slice(&(json_chunk.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json_chunk);
    glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"BIN\0");
    glb.extend_from_slice(&bin);
    glb
}

/// Thin wrapper: the default GLB has no index buffer.
fn synthetic_glb() -> Vec<u8> {
    synthetic_glb_with(None)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let glb = synthetic_glb();
    let levels_json = br#"{"version":1,"levels":[
        {"levelKey":"elem-a","levelName":"B1","levelElevationMeters":-6.5,"elementCount":1,"minZMeters":-6.5,"maxZMeters":-3.0},
        {"levelKey":"elem-b","levelName":"1F","levelElevationMeters":3.5,"elementCount":1,"minZMeters":3.5,"maxZMeters":7.0}
    ]}"#;
    // Identity world transform: ECEF origin at (0, 0, 0), no rotation.
    let identity = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];

    let document = derive_scene(&glb, levels_json, "sha256:tiny-fixture", identity)?;
    let bytes = encode_scene(&document)?;

    let out_path = PathBuf::from("src/spikes/renderer/fixtures/tiny.kscene");
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&out_path, &bytes)?;
    println!(
        "wrote {} bytes to {} ({} levels, {} features, {} batches)",
        bytes.len(),
        out_path.canonicalize()?.display(),
        document.levels.len(),
        document.features.len(),
        document.batches.len(),
    );
    Ok(())
}
