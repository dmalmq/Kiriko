//! Shared fixtures for the scene crate's integration tests: a synthetic GLB
//! that exercises the deriver's real code path, and a ZIP builder for tile
//! packages. Kept in one place so the deriver tests and the package tests
//! cannot drift into describing two different "valid GLB"s.

#![allow(dead_code)]

use serde_json::json;

/// Build a two-triangle GLB with one property table row per triangle.
/// Layout: positions f32x3, normals f32x3, feature ids u32, then the
/// EXT_structural_metadata string data and offsets. When `indices` is present
/// they are appended to the BIN chunk and wired to the first primitive.
pub fn synthetic_glb_with(indices: Option<&[u32]>) -> Vec<u8> {
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
pub fn synthetic_glb() -> Vec<u8> {
    synthetic_glb_with(None)
}

/// Build a ZIP whose entries are `(path, bytes)`, in the order given. Stored
/// without compression so a test can reason about exact bytes.
pub fn zip_package(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (path, bytes) in entries {
            writer.start_file(*path, options).expect("start entry");
            writer.write_all(bytes).expect("write entry");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

/// A minimal valid root tileset referencing one content member.
pub fn tileset_json(content_uri: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "asset": { "version": "1.1" },
        "geometricError": 0.0,
        "root": {
            "boundingVolume": { "box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
            "geometricError": 0.0,
            "refine": "ADD",
            "content": { "uri": content_uri },
        },
    }))
    .expect("serialize tileset")
}
