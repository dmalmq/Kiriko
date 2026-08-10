//! Shared fixtures for the scene crate's integration tests: a synthetic GLB
//! that exercises the deriver's real code path, and a ZIP builder for tile
//! packages. Kept in one place so the deriver tests and the package tests
//! cannot drift into describing two different "valid GLB"s.

#![allow(dead_code)]

use serde_json::json;

/// One source element in a fixture package: its Revit metadata plus the
/// triangles it contributes. Registration reads both, so a fixture that
/// carries only one of them cannot exercise it.
#[derive(Debug, Clone)]
pub struct FeatureSpec {
    pub revit_unique_id: String,
    pub category: String,
    pub level_key: String,
    pub level_name: String,
    pub level_elevation_meters: f32,
    pub source_document: String,
    pub source_link_name: String,
    /// Triangles in the GLB's own coordinates, one `[a, b, c]` per triangle.
    pub triangles: Vec<[[f32; 3]; 3]>,
}

impl FeatureSpec {
    /// A feature with the identity fields a single-document export produces,
    /// so a test states only what it is actually about.
    pub fn new(
        id: &str,
        category: &str,
        level_key: &str,
        level_elevation_meters: f32,
        triangles: Vec<[[f32; 3]; 3]>,
    ) -> Self {
        Self {
            revit_unique_id: id.to_string(),
            category: category.to_string(),
            level_key: level_key.to_string(),
            level_name: level_key.to_string(),
            level_elevation_meters,
            source_document: "station.rvt".to_string(),
            source_link_name: String::new(),
            triangles,
        }
    }

    #[must_use]
    pub fn in_document(mut self, document: &str, link: &str) -> Self {
        self.source_document = document.to_string();
        self.source_link_name = link.to_string();
        self
    }
}

/// An axis-aligned rectangle at height `z`, as two triangles. The winding is
/// fixed so boundary-edge extraction sees the same edges every run.
pub fn quad(min: [f32; 2], max: [f32; 2], z: f32) -> Vec<[[f32; 3]; 3]> {
    let (x0, y0, x1, y1) = (min[0], min[1], max[0], max[1]);
    vec![
        [[x0, y0, z], [x1, y0, z], [x1, y1, z]],
        [[x0, y0, z], [x1, y1, z], [x0, y1, z]],
    ]
}

/// Build a GLB whose property table carries every field the registration pass
/// reads, with one primitive per feature. `minZMeters`/`maxZMeters` are derived
/// from the feature's own triangles rather than declared, so a fixture cannot
/// claim an extent its geometry does not have.
pub fn glb_with_features(features: &[FeatureSpec]) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let mut primitives = Vec::new();
    let mut accessors = Vec::new();
    let mut buffer_views = Vec::new();

    for (index, feature) in features.iter().enumerate() {
        let vertex_count = feature.triangles.len() * 3;
        assert!(vertex_count > 0, "a fixture feature needs geometry");

        let positions_offset = bin.len();
        for triangle in &feature.triangles {
            for vertex in triangle {
                for value in vertex {
                    bin.extend_from_slice(&value.to_le_bytes());
                }
            }
        }
        let ids_offset = bin.len();
        for _ in 0..vertex_count {
            bin.extend_from_slice(&(index as u32).to_le_bytes());
        }

        let position_view = buffer_views.len();
        buffer_views.push(json!({
            "buffer": 0, "byteOffset": positions_offset, "byteLength": vertex_count * 12
        }));
        let id_view = buffer_views.len();
        buffer_views.push(json!({
            "buffer": 0, "byteOffset": ids_offset, "byteLength": vertex_count * 4
        }));

        let position_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": position_view, "componentType": 5126,
            "count": vertex_count, "type": "VEC3"
        }));
        let id_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": id_view, "componentType": 5125, "count": vertex_count,
            "type": "SCALAR", "min": [index as f64], "max": [index as f64]
        }));

        primitives.push(json!({
            "mode": 4,
            "attributes": { "POSITION": position_accessor, "_FEATURE_ID_0": id_accessor },
            "extensions": { "EXT_mesh_features": { "featureIds": [
                { "featureCount": features.len(), "attribute": 0, "propertyTable": 0 }
            ] } }
        }));
    }

    // One string property per text field, each with its own values/offsets
    // views, plus one f32 view per scalar field.
    let mut string_views = serde_json::Map::new();
    for (name, values) in [
        (
            "revitUniqueId",
            features
                .iter()
                .map(|f| f.revit_unique_id.clone())
                .collect::<Vec<_>>(),
        ),
        (
            "category",
            features.iter().map(|f| f.category.clone()).collect(),
        ),
        (
            "levelKey",
            features.iter().map(|f| f.level_key.clone()).collect(),
        ),
        (
            "levelName",
            features.iter().map(|f| f.level_name.clone()).collect(),
        ),
        (
            "sourceDocument",
            features.iter().map(|f| f.source_document.clone()).collect(),
        ),
        (
            "sourceLinkName",
            features
                .iter()
                .map(|f| f.source_link_name.clone())
                .collect(),
        ),
    ] {
        let values_offset = bin.len();
        let mut offsets: Vec<u32> = vec![0];
        for value in &values {
            bin.extend_from_slice(value.as_bytes());
            offsets.push(bin.len() as u32 - values_offset as u32);
        }
        let values_len = bin.len() - values_offset;
        let offsets_offset = bin.len();
        for offset in &offsets {
            bin.extend_from_slice(&offset.to_le_bytes());
        }
        let values_view = buffer_views.len();
        buffer_views.push(json!({
            "buffer": 0, "byteOffset": values_offset, "byteLength": values_len.max(1)
        }));
        let offsets_view = buffer_views.len();
        buffer_views.push(json!({
            "buffer": 0, "byteOffset": offsets_offset, "byteLength": offsets.len() * 4
        }));
        string_views.insert(
            name.to_string(),
            json!({ "values": values_view, "stringOffsets": offsets_view }),
        );
    }

    let mut scalar_views = serde_json::Map::new();
    for (name, values) in [
        (
            "levelElevationMeters",
            features
                .iter()
                .map(|f| f.level_elevation_meters)
                .collect::<Vec<_>>(),
        ),
        (
            "minZMeters",
            features
                .iter()
                .map(|f| triangle_extent(&f.triangles).0)
                .collect(),
        ),
        (
            "maxZMeters",
            features
                .iter()
                .map(|f| triangle_extent(&f.triangles).1)
                .collect(),
        ),
    ] {
        let offset = bin.len();
        for value in &values {
            bin.extend_from_slice(&value.to_le_bytes());
        }
        let view = buffer_views.len();
        buffer_views.push(json!({
            "buffer": 0, "byteOffset": offset, "byteLength": values.len() * 4
        }));
        scalar_views.insert(name.to_string(), json!({ "values": view }));
    }

    let mut properties = string_views;
    properties.extend(scalar_views);
    let class_properties = json!({
        "revitUniqueId": { "type": "STRING" },
        "category": { "type": "STRING" },
        "levelKey": { "type": "STRING" },
        "levelName": { "type": "STRING" },
        "sourceDocument": { "type": "STRING" },
        "sourceLinkName": { "type": "STRING" },
        "levelElevationMeters": { "type": "SCALAR", "componentType": "FLOAT32" },
        "minZMeters": { "type": "SCALAR", "componentType": "FLOAT32" },
        "maxZMeters": { "type": "SCALAR", "componentType": "FLOAT32" }
    });

    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }

    let gltf = json!({
        "asset": { "version": "2.0" },
        "extensionsUsed": ["EXT_mesh_features", "EXT_structural_metadata"],
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0 }],
        "meshes": [{ "primitives": primitives }],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{ "byteLength": bin.len() }],
        "extensions": { "EXT_structural_metadata": {
            "schema": { "classes": { "element": { "properties": class_properties } } },
            "propertyTables": [{
                "class": "element",
                "count": features.len(),
                "properties": serde_json::Value::Object(properties)
            }]
        } }
    });

    glb_container(&gltf, &bin)
}

fn triangle_extent(triangles: &[[[f32; 3]; 3]]) -> (f32, f32) {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for triangle in triangles {
        for vertex in triangle {
            min = min.min(vertex[2]);
            max = max.max(vertex[2]);
        }
    }
    (min, max)
}

/// Wrap glTF JSON and a BIN chunk in a GLB container.
fn glb_container(gltf: &serde_json::Value, bin: &[u8]) -> Vec<u8> {
    let mut json_chunk = serde_json::to_vec(gltf).expect("serialize gltf");
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
    glb.extend_from_slice(bin);
    glb
}

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
