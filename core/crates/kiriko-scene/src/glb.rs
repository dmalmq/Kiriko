//! GLB container reader: glTF JSON plus `EXT_structural_metadata` feature rows.
//!
//! Encodings verified against the real Tokyo 3D Tiles asset:
//! - `_FEATURE_ID_0` accessors are `componentType` 5125 (u32) with one constant
//!   id per primitive;
//! - `POSITION`/`NORMAL` are 5126 (f32) `VEC3`, tightly packed (no `byteStride`);
//! - primitives carry identity `indices` (`0..n-1`, `count == POSITION count`);
//! - `EXT_structural_metadata` property tables declare no `stringOffsetType`, so
//!   string offsets default to UINT32 with `count + 1` entries.
//!
//! Anything outside these encodings fails loudly with `SceneError::Glb` instead
//! of rendering wrong geometry or wrong picks.

use serde_json::Value;

use crate::SceneError;

/// One renderable mesh primitive: triangle-list positions and normals plus the
/// constant feature id every pickable object carries.
#[derive(Debug, Clone)]
pub struct GlbPrimitive {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub feature_id: u32,
    /// `true` when the primitive had no index buffer or an identity one
    /// (`0..n-1`, `count == POSITION count`), so the deriver can report how
    /// many primitives needed a gather.
    pub indices_were_identity: bool,
}

/// One row of an `EXT_structural_metadata` property table. Missing properties
/// decode to an empty string or `0.0`.
#[derive(Debug, Clone, Default)]
pub struct GlbFeatureRow {
    pub revit_unique_id: String,
    pub category: String,
    pub level_key: String,
    pub level_name: String,
    pub level_elevation_meters: f32,
    pub min_z: f32,
    pub max_z: f32,
    pub source_document: String,
    pub source_link_name: String,
}

/// Everything read from a GLB that the deriver consumes.
#[derive(Debug, Clone)]
pub struct GlbScene {
    pub primitives: Vec<GlbPrimitive>,
    pub features: Vec<GlbFeatureRow>,
}

const GLB_MAGIC: &[u8; 4] = b"glTF";
const CHUNK_JSON: &[u8; 4] = b"JSON";
const CHUNK_BIN: &[u8; 4] = b"BIN\0";

/// glTF component types this reader knows.
const COMPONENT_F32: u32 = 5126;
const COMPONENT_U32: u32 = 5125;
const COMPONENT_U16: u32 = 5123;
const COMPONENT_U8: u32 = 5121;

/// Parse a GLB container and return its primitives plus feature rows.
pub fn read_glb(bytes: &[u8]) -> Result<GlbScene, SceneError> {
    let (json_bytes, bin) = parse_container(bytes)?;
    let root: Value = serde_json::from_slice(json_bytes)
        .map_err(|e| SceneError::Glb(format!("invalid glTF JSON: {e}")))?;

    let primitives = read_primitives(&root, bin)?;
    let features = read_property_tables(&root, bin)?;
    Ok(GlbScene {
        primitives,
        features,
    })
}

/// Walk the container: header plus JSON/BIN chunks. Rejects bad magic, a
/// version other than 2, and any chunk length that overruns the buffer.
fn parse_container(bytes: &[u8]) -> Result<(&[u8], Option<&[u8]>), SceneError> {
    if bytes.len() < 12 {
        return Err(SceneError::Glb(
            "container shorter than the 12-byte GLB header".into(),
        ));
    }
    if &bytes[0..4] != GLB_MAGIC {
        return Err(SceneError::Glb("bad GLB container magic".into()));
    }
    let version = u32_le(&bytes[4..8]);
    if version != 2 {
        return Err(SceneError::Glb(format!(
            "unsupported GLB version {version}"
        )));
    }
    let declared_len = u32_le(&bytes[8..12]) as usize;
    if declared_len > bytes.len() {
        return Err(SceneError::Glb(
            "GLB length field exceeds the input buffer".into(),
        ));
    }

    let mut offset = 12;
    let mut json_chunk = None;
    let mut bin_chunk = None;
    while offset < declared_len {
        if declared_len - offset < 8 {
            return Err(SceneError::Glb("truncated GLB chunk header".into()));
        }
        let chunk_len = u32_le(&bytes[offset..offset + 4]) as usize;
        let chunk_type = &bytes[offset + 4..offset + 8];
        let data_start = offset + 8;
        let data_end = data_start + chunk_len;
        if data_end > declared_len {
            return Err(SceneError::Glb(
                "GLB chunk length exceeds the remaining buffer".into(),
            ));
        }
        let chunk = &bytes[data_start..data_end];
        if chunk_type == CHUNK_JSON {
            json_chunk.get_or_insert(chunk);
        } else if chunk_type == CHUNK_BIN {
            bin_chunk.get_or_insert(chunk);
        }
        offset = data_end;
    }

    let json_chunk = json_chunk.ok_or_else(|| SceneError::Glb("GLB has no JSON chunk".into()))?;
    Ok((json_chunk, bin_chunk))
}

fn u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// Decoded view over one accessor's declaration.
struct Accessor {
    buffer_view: usize,
    byte_offset: usize,
    count: usize,
    component_type: u32,
    type_name: String,
    min: Option<f64>,
    max: Option<f64>,
}

fn parse_accessor(value: &Value) -> Result<Accessor, SceneError> {
    let err = |msg: &str| SceneError::Glb(msg.to_string());
    let component_type = value
        .get("componentType")
        .and_then(Value::as_u64)
        .ok_or_else(|| err("accessor missing componentType"))? as u32;
    let count = value
        .get("count")
        .and_then(Value::as_u64)
        .ok_or_else(|| err("accessor missing count"))? as usize;
    let type_name = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| err("accessor missing type"))?
        .to_string();
    let buffer_view = value
        .get("bufferView")
        .and_then(Value::as_u64)
        .ok_or_else(|| err("accessor missing bufferView"))? as usize;
    if value.get("sparse").is_some() {
        return Err(err("sparse accessors are not supported"));
    }
    let byte_offset = value.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let min = value
        .get("min")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_f64);
    let max = value
        .get("max")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_f64);
    Ok(Accessor {
        buffer_view,
        byte_offset,
        count,
        component_type,
        type_name,
        min,
        max,
    })
}

/// One bufferView: always buffer 0, the GLB BIN chunk.
struct BufferView {
    byte_offset: usize,
    byte_length: usize,
    byte_stride: Option<usize>,
}

fn buffer_view(root: &Value, index: usize) -> Result<BufferView, SceneError> {
    let views = root
        .get("bufferViews")
        .and_then(Value::as_array)
        .ok_or_else(|| SceneError::Glb("glTF has no bufferViews".into()))?;
    let view = views
        .get(index)
        .ok_or_else(|| SceneError::Glb(format!("bufferView {index} out of range")))?;
    let buffer = view
        .get("buffer")
        .and_then(Value::as_u64)
        .ok_or_else(|| SceneError::Glb("bufferView missing buffer".into()))?;
    if buffer != 0 {
        return Err(SceneError::Glb(format!(
            "external buffer {buffer} is not supported"
        )));
    }
    let byte_offset = view.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let byte_length = view
        .get("byteLength")
        .and_then(Value::as_u64)
        .ok_or_else(|| SceneError::Glb("bufferView missing byteLength".into()))?
        as usize;
    let byte_stride = view
        .get("byteStride")
        .and_then(Value::as_u64)
        .map(|s| s as usize);
    Ok(BufferView {
        byte_offset,
        byte_length,
        byte_stride,
    })
}

fn read_primitives(root: &Value, bin: Option<&[u8]>) -> Result<Vec<GlbPrimitive>, SceneError> {
    let bin = bin.ok_or_else(|| SceneError::Glb("GLB has no BIN chunk".into()))?;
    let accessors = root
        .get("accessors")
        .and_then(Value::as_array)
        .ok_or_else(|| SceneError::Glb("glTF has no accessors".into()))?;
    let meshes = root
        .get("meshes")
        .and_then(Value::as_array)
        .ok_or_else(|| SceneError::Glb("glTF has no meshes".into()))?;

    let mut primitives = Vec::new();
    for mesh in meshes {
        let mesh_primitives = mesh
            .get("primitives")
            .and_then(Value::as_array)
            .ok_or_else(|| SceneError::Glb("mesh missing primitives".into()))?;
        for primitive in mesh_primitives {
            let attributes = primitive
                .get("attributes")
                .and_then(Value::as_object)
                .ok_or_else(|| SceneError::Glb("primitive missing attributes".into()))?;
            let attribute = |name: &str| {
                attributes
                    .get(name)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| SceneError::Glb(format!("primitive missing {name}")))
                    .map(|i| i as usize)
            };
            let position_index = attribute("POSITION")?;
            // NORMAL is optional in glTF, and a renderer is expected to shade a
            // primitive without one from its own winding. Refusing the package
            // instead would reject a spec-valid export over an attribute Kiriko
            // can derive, so an absent NORMAL is filled with flat facet normals.
            let normal_index = attributes
                .get("NORMAL")
                .and_then(Value::as_u64)
                .map(|index| index as usize);
            let feature_id_index = attribute("_FEATURE_ID_0")?;

            let position_accessor =
                parse_accessor(accessors.get(position_index).ok_or_else(|| {
                    SceneError::Glb(format!("accessor {position_index} out of range"))
                })?)?;
            let normal_accessor = match normal_index {
                Some(index) => Some(parse_accessor(accessors.get(index).ok_or_else(|| {
                    SceneError::Glb(format!("accessor {index} out of range"))
                })?)?),
                None => None,
            };
            let feature_id_accessor =
                parse_accessor(accessors.get(feature_id_index).ok_or_else(|| {
                    SceneError::Glb(format!("accessor {feature_id_index} out of range"))
                })?)?;

            check_constant_feature_id(&feature_id_accessor)?;
            let feature_id = read_scalar_element(&feature_id_accessor, root, bin, 0)?;

            let (positions, normals, indices_were_identity) =
                match primitive.get("indices").and_then(Value::as_u64) {
                    Some(index) => {
                        let index = index as usize;
                        let index_accessor =
                            parse_accessor(accessors.get(index).ok_or_else(|| {
                                SceneError::Glb(format!("accessor {index} out of range"))
                            })?)?;
                        let indices = read_scalar_all(&index_accessor, root, bin)?;
                        let positions = read_vec3_f32(&position_accessor, root, bin)?;
                        let normals = match &normal_accessor {
                            Some(accessor) => read_vec3_f32(accessor, root, bin)?,
                            None => flat_normals(&positions),
                        };
                        let identity = indices.len() == positions.len()
                            && indices
                                .iter()
                                .enumerate()
                                .all(|(i, &value)| value as usize == i);
                        if identity {
                            (positions, normals, true)
                        } else {
                            // Gather into triangle-list order; never drop a
                            // non-identity buffer silently.
                            let mut gathered_positions = Vec::with_capacity(indices.len());
                            let mut gathered_normals = Vec::with_capacity(indices.len());
                            for &value in &indices {
                                let p = positions
                                    .get(value as usize)
                                    .ok_or_else(|| SceneError::Glb("index out of range".into()))?;
                                let n = normals
                                    .get(value as usize)
                                    .ok_or_else(|| SceneError::Glb("index out of range".into()))?;
                                gathered_positions.push(*p);
                                gathered_normals.push(*n);
                            }
                            (gathered_positions, gathered_normals, false)
                        }
                    }
                    None => {
                        let positions = read_vec3_f32(&position_accessor, root, bin)?;
                        let normals = match &normal_accessor {
                            Some(accessor) => read_vec3_f32(accessor, root, bin)?,
                            None => flat_normals(&positions),
                        };
                        (positions, normals, true)
                    }
                };

            primitives.push(GlbPrimitive {
                positions,
                normals,
                feature_id,
                indices_were_identity,
            });
        }
    }
    Ok(primitives)
}

/// The measured asset holds one constant id per primitive. When the accessor
/// declares both `min` and `max`, they must agree or a future non-constant
/// asset fails loudly instead of rendering wrong picks.
fn check_constant_feature_id(accessor: &Accessor) -> Result<(), SceneError> {
    if let (Some(min), Some(max)) = (accessor.min, accessor.max)
        && min != max
    {
        return Err(SceneError::Glb(format!(
            "_FEATURE_ID_0 accessor is not constant (min {min}, max {max})"
        )));
    }
    Ok(())
}

/// Flat facet normals for triangle-list positions, for a primitive that omits
/// `NORMAL`. A degenerate facet gets an up normal rather than a NaN one, so one
/// bad triangle cannot poison a whole batch's shading.
fn flat_normals(positions: &[[f32; 3]]) -> Vec<[f32; 3]> {
    let mut normals = Vec::with_capacity(positions.len());
    for facet in positions.chunks(3) {
        let normal = match facet {
            [a, b, c] => {
                let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let cross = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                let length =
                    (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
                if length <= f32::EPSILON {
                    [0.0, 0.0, 1.0]
                } else {
                    [cross[0] / length, cross[1] / length, cross[2] / length]
                }
            }
            // A trailing partial facet is not a triangle; it shades as up rather
            // than failing the whole primitive.
            _ => [0.0, 0.0, 1.0],
        };
        for _ in facet {
            normals.push(normal);
        }
    }
    normals
}

/// Read a `VEC3` f32 accessor into triangle-list positions or normals.
fn read_vec3_f32(
    accessor: &Accessor,
    root: &Value,
    bin: &[u8],
) -> Result<Vec<[f32; 3]>, SceneError> {
    if accessor.component_type != COMPONENT_F32 {
        return Err(SceneError::Glb(format!(
            "unsupported componentType {} for VEC3",
            accessor.component_type
        )));
    }
    if accessor.type_name != "VEC3" {
        return Err(SceneError::Glb(format!(
            "expected VEC3 accessor, found {}",
            accessor.type_name
        )));
    }
    let view = buffer_view(root, accessor.buffer_view)?;
    let stride = view.byte_stride.unwrap_or(12);
    if stride < 12 {
        return Err(SceneError::Glb(format!(
            "byteStride {stride} too small for VEC3 f32"
        )));
    }
    let start = view.byte_offset + accessor.byte_offset;
    let view_end = view.byte_offset + view.byte_length;
    if view_end > bin.len() {
        return Err(SceneError::Glb("bufferView exceeds the BIN chunk".into()));
    }
    let mut out = Vec::with_capacity(accessor.count);
    for i in 0..accessor.count {
        let base = start + i * stride;
        if base + 12 > view_end {
            return Err(SceneError::Glb(
                "accessor data exceeds its bufferView".into(),
            ));
        }
        let data = &bin[base..base + 12];
        out.push([
            f32::from_le_bytes([data[0], data[1], data[2], data[3]]),
            f32::from_le_bytes([data[4], data[5], data[6], data[7]]),
            f32::from_le_bytes([data[8], data[9], data[10], data[11]]),
        ]);
    }
    Ok(out)
}

/// Read every element of a SCALAR u32/u16/u8 accessor.
fn read_scalar_all(accessor: &Accessor, root: &Value, bin: &[u8]) -> Result<Vec<u32>, SceneError> {
    let mut out = Vec::with_capacity(accessor.count);
    for i in 0..accessor.count {
        out.push(read_scalar_element(accessor, root, bin, i)?);
    }
    Ok(out)
}

/// Read one element of a SCALAR u32/u16/u8 accessor.
fn read_scalar_element(
    accessor: &Accessor,
    root: &Value,
    bin: &[u8],
    element: usize,
) -> Result<u32, SceneError> {
    if element >= accessor.count {
        return Err(SceneError::Glb(format!(
            "scalar accessor element {element} out of range (count {})",
            accessor.count
        )));
    }
    if accessor.type_name != "SCALAR" {
        return Err(SceneError::Glb(format!(
            "expected SCALAR accessor, found {}",
            accessor.type_name
        )));
    }
    let width = match accessor.component_type {
        COMPONENT_U32 => 4,
        COMPONENT_U16 => 2,
        COMPONENT_U8 => 1,
        other => {
            return Err(SceneError::Glb(format!(
                "unsupported scalar componentType {other}"
            )));
        }
    };
    let view = buffer_view(root, accessor.buffer_view)?;
    let stride = view.byte_stride.unwrap_or(width);
    if stride < width {
        return Err(SceneError::Glb(format!(
            "byteStride {stride} too small for component size {width}"
        )));
    }
    let start = view.byte_offset + accessor.byte_offset;
    let view_end = view.byte_offset + view.byte_length;
    if view_end > bin.len() {
        return Err(SceneError::Glb("bufferView exceeds the BIN chunk".into()));
    }
    let base = start + element * stride;
    if base + width > view_end {
        return Err(SceneError::Glb(
            "accessor data exceeds its bufferView".into(),
        ));
    }
    let data = &bin[base..base + width];
    let value = match width {
        4 => u32::from_le_bytes([data[0], data[1], data[2], data[3]]),
        2 => u32::from(u16::from_le_bytes([data[0], data[1]])),
        _ => u32::from(data[0]),
    };
    Ok(value)
}

fn read_property_tables(
    root: &Value,
    bin: Option<&[u8]>,
) -> Result<Vec<GlbFeatureRow>, SceneError> {
    let Some(bin) = bin else {
        return Ok(Vec::new());
    };
    let Some(extension) = root
        .get("extensions")
        .and_then(|e| e.get("EXT_structural_metadata"))
    else {
        return Ok(Vec::new());
    };
    let Some(tables) = extension.get("propertyTables").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let schema = extension.get("schema");

    // Feature ids are table-local, and `GlbPrimitive` records no table index, so
    // concatenating several tables would silently misattribute every row past
    // the first. Refuse instead: wrong picks are worse than an unsupported
    // asset. The measured Tokyo, Shinjuku, and LumineEst assets each ship one
    // table, so this costs nothing today.
    if tables.len() > 1 {
        return Err(SceneError::Glb(format!(
            "glb declares {} property tables; only one is supported because feature ids are table-local",
            tables.len()
        )));
    }

    let mut rows = Vec::new();
    for table in tables {
        let class_name = table
            .get("class")
            .and_then(Value::as_str)
            .ok_or_else(|| SceneError::Glb("property table missing class".into()))?;
        let count = table
            .get("count")
            .and_then(Value::as_u64)
            .ok_or_else(|| SceneError::Glb("property table missing count".into()))?
            as usize;
        let properties = table
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| SceneError::Glb("property table missing properties".into()))?;
        let class_properties = schema
            .and_then(|s| s.get("classes"))
            .and_then(|c| c.get(class_name))
            .and_then(|c| c.get("properties"));

        for row in 0..count {
            let mut feature = GlbFeatureRow::default();
            for (name, spec) in properties {
                let type_info = class_properties.and_then(|p| p.get(name));
                match name.as_str() {
                    "revitUniqueId" => {
                        feature.revit_unique_id =
                            read_string_field(spec, type_info, row, count, root, bin)?
                    }
                    "category" => {
                        feature.category =
                            read_string_field(spec, type_info, row, count, root, bin)?
                    }
                    "levelKey" => {
                        feature.level_key =
                            read_string_field(spec, type_info, row, count, root, bin)?
                    }
                    "levelName" => {
                        feature.level_name =
                            read_string_field(spec, type_info, row, count, root, bin)?
                    }
                    "levelElevationMeters" => {
                        feature.level_elevation_meters =
                            read_scalar_field(spec, type_info, row, root, bin)?
                    }
                    "minZMeters" => {
                        feature.min_z = read_scalar_field(spec, type_info, row, root, bin)?
                    }
                    "maxZMeters" => {
                        feature.max_z = read_scalar_field(spec, type_info, row, root, bin)?
                    }
                    "sourceDocument" => {
                        feature.source_document =
                            read_string_field(spec, type_info, row, count, root, bin)?
                    }
                    "sourceLinkName" => {
                        feature.source_link_name =
                            read_string_field(spec, type_info, row, count, root, bin)?
                    }
                    // Unknown properties are ignored.
                    _ => {}
                }
            }
            rows.push(feature);
        }
    }
    Ok(rows)
}

fn read_string_field(
    spec: &Value,
    type_info: Option<&Value>,
    row: usize,
    count: usize,
    root: &Value,
    bin: &[u8],
) -> Result<String, SceneError> {
    if let Some(type_info) = type_info
        && type_info.get("type").and_then(Value::as_str) != Some("STRING")
    {
        return Err(SceneError::Glb(
            "property declared non-STRING but read as a string".into(),
        ));
    }
    read_string_property(spec, row, count, root, bin)
}

fn read_scalar_field(
    spec: &Value,
    type_info: Option<&Value>,
    row: usize,
    root: &Value,
    bin: &[u8],
) -> Result<f32, SceneError> {
    if let Some(type_info) = type_info {
        if type_info.get("type").and_then(Value::as_str) != Some("SCALAR") {
            return Err(SceneError::Glb(
                "property declared non-SCALAR but read as f32".into(),
            ));
        }
        if let Some(component_type) = type_info.get("componentType").and_then(Value::as_str)
            && component_type != "FLOAT32"
        {
            return Err(SceneError::Glb(format!(
                "unsupported SCALAR componentType {component_type}"
            )));
        }
    }
    read_f32_property(spec, row, root, bin)
}

/// STRING property: `values` holds UTF-8 bytes, `stringOffsets` holds u32
/// offsets with `count + 1` entries (UINT32 is the spec default; the Tokyo
/// asset declares no `stringOffsetType`).
fn read_string_property(
    spec: &Value,
    row: usize,
    count: usize,
    root: &Value,
    bin: &[u8],
) -> Result<String, SceneError> {
    if let Some(offset_type) = spec.get("stringOffsetType").and_then(Value::as_str)
        && offset_type != "UINT32"
    {
        return Err(SceneError::Glb(format!(
            "unsupported stringOffsetType {offset_type}"
        )));
    }
    let values_view = spec
        .get("values")
        .and_then(Value::as_u64)
        .ok_or_else(|| SceneError::Glb("STRING property missing values".into()))?
        as usize;
    let offsets_view = spec
        .get("stringOffsets")
        .and_then(Value::as_u64)
        .ok_or_else(|| SceneError::Glb("STRING property missing stringOffsets".into()))?
        as usize;

    let values = buffer_view(root, values_view)?;
    let values_data = bin
        .get(values.byte_offset..values.byte_offset + values.byte_length)
        .ok_or_else(|| SceneError::Glb("string values bufferView exceeds the BIN chunk".into()))?;
    let offsets = read_u32_view(root, offsets_view, count + 1, bin)?;

    let lo = offsets[row] as usize;
    let hi = offsets[row + 1] as usize;
    if hi < lo || hi > values_data.len() {
        return Err(SceneError::Glb("string offset out of bounds".into()));
    }
    std::str::from_utf8(&values_data[lo..hi])
        .map(str::to_string)
        .map_err(|e| SceneError::Glb(format!("invalid UTF-8 in string property: {e}")))
}

/// SCALAR FLOAT32 property: a single `values` bufferView, one f32 per row.
fn read_f32_property(
    spec: &Value,
    row: usize,
    root: &Value,
    bin: &[u8],
) -> Result<f32, SceneError> {
    let values_view = spec
        .get("values")
        .and_then(Value::as_u64)
        .ok_or_else(|| SceneError::Glb("SCALAR property missing values".into()))?
        as usize;
    let view = buffer_view(root, values_view)?;
    let start = view.byte_offset + row * 4;
    if row * 4 + 4 > view.byte_length {
        return Err(SceneError::Glb(
            "scalar property row exceeds its bufferView".into(),
        ));
    }
    let data = bin.get(start..start + 4).ok_or_else(|| {
        SceneError::Glb("scalar property bufferView exceeds the BIN chunk".into())
    })?;
    Ok(f32::from_le_bytes([data[0], data[1], data[2], data[3]]))
}

fn read_u32_view(
    root: &Value,
    buffer_view_index: usize,
    count: usize,
    bin: &[u8],
) -> Result<Vec<u32>, SceneError> {
    let view = buffer_view(root, buffer_view_index)?;
    if count * 4 > view.byte_length {
        return Err(SceneError::Glb(
            "offset bufferView is smaller than count + 1 u32 entries".into(),
        ));
    }
    let start = view.byte_offset;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let base = start + i * 4;
        let data = bin
            .get(base..base + 4)
            .ok_or_else(|| SceneError::Glb("offset bufferView exceeds the BIN chunk".into()))?;
        out.push(u32::from_le_bytes([data[0], data[1], data[2], data[3]]));
    }
    Ok(out)
}
