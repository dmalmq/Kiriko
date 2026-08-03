# 3D Rendering Architecture Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Burn down spike gates 1–7 of `docs/superpowers/specs/2026-08-03-3d-rendering-architecture-design.md` with measured evidence, so issue #23 can close and issue #26 can set numeric budgets.

**Architecture:** A new Rust crate `kiriko-scene` derives a GPU-ready batch format from a 3D Tiles GLB (quantized, merged by semantic role and level, zstd-compressed). `kiriko-wasm` gains a `decodeScene` export. A disposable TypeScript spike renders that format through a WebGL2 `CustomLayerInterface` inside MapLibre, with a feature-ID pick pass and a measurement HUD.

**Tech Stack:** Rust 2024 (serde_json, postcard, zstd, sha2 — all already in the workspace), wasm-bindgen, TypeScript 7 strict, MapLibre GL JS 5.24, raw WebGL2, Vite 8, Vitest 4.

## Global Constraints

- **Quality split:** `core/crates/kiriko-scene/` and the `kiriko-wasm` export are production-quality code with tests. Everything under `src/spikes/` is disposable spike code — it is never imported by production modules and is deleted or promoted after issue #23 closes.
- **No new dependencies.** Use only workspace deps: `serde`, `serde_json`, `postcard`, `zstd`, `sha2`, `thiserror`, `wasm-bindgen`, `serde-wasm-bindgen`. Parse the GLB container directly; do not add the `gltf` crate.
- **Strict TypeScript, no `any`.** `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **Bilingual UI rule does not apply to the spike HUD** — it is producer diagnostics, English-only, and never ships.
- **Semantic roles are exactly these twelve** (issue #32): `walkable`, `public`, `service`, `restricted`, `structure`, `ceiling`, `opening`, `elevator`, `escalator`, `stairs`, `ramp`, `context`.
- **Hit affordances to preserve:** paths `12` px, junctions `10` px, junctions queried before paths (`src/map/IndoorMap.tsx:258–266`).
- **Camera:** MapLibre owns it; `maxPitch` stays `60`.
- **Fixtures** (all local, read-only — never modify):
  - `C:/cesium/tokyo 3dtiles/` — 171.6 MB GLB, 90 levels, 22,387 features, 23,556 primitives (worst case)
  - `C:/cesium/shinjuku 3dtiles/` — 161.4 MB GLB (second heavy case)
  - `C:/cesium/LumineEst 3dtiles/` — 12.8 MB GLB (easy case)
- **Measured baseline facts** (do not re-derive, cite them): Tokyo GLB = 21.5 MB JSON chunk + 150.1 MB BIN; 4,702,167 vertices; 1.57 M triangles; 72 materials; 0 textures; every primitive carries a constant `_FEATURE_ID_0`; busiest level 2,698 elements; median level 126.
- **Commit per task.** Branch `spike/3d-rendering-architecture`, never merged to `main`.

---

## File Structure

**Rust — production quality**

| File | Responsibility |
|---|---|
| `core/crates/kiriko-scene/Cargo.toml` | Crate manifest, workspace deps only |
| `core/crates/kiriko-scene/src/lib.rs` | Public API surface, `SceneError` |
| `core/crates/kiriko-scene/src/format.rs` | Format types, postcard + zstd container encode/decode |
| `core/crates/kiriko-scene/src/quantize.rs` | Position quantization, octahedral normal encoding |
| `core/crates/kiriko-scene/src/glb.rs` | GLB container reader, glTF JSON structs, accessor readers, `EXT_structural_metadata` property-table decode |
| `core/crates/kiriko-scene/src/roles.rs` | Revit `category` → semantic role mapping |
| `core/crates/kiriko-scene/src/derive.rs` | GLB → merged batches → `SceneDocument` |
| `core/crates/kiriko-scene/tests/roundtrip.rs` | Format round-trip, quantization error bounds, role mapping |
| `core/crates/kiriko-scene/tests/derive.rs` | Deriver against a synthetic GLB built in-test |
| `core/crates/kiriko-scene/examples/derive_tiles.rs` | CLI: tileset dir → `.kscene` + `stats.json` (gate 1 measurement) |
| `core/crates/kiriko-wasm/src/lib.rs` | Add `decodeScene` export |

**TypeScript — disposable spike**

| File | Responsibility |
|---|---|
| `src/spikes/renderer/sceneFormat.ts` | Decode `.kscene` via wasm, expose typed views per batch |
| `src/spikes/renderer/glUtil.ts` | Program/VAO/texture helpers, GL state save/restore |
| `src/spikes/renderer/sceneLayer.ts` | `CustomLayerInterface`, batch draw, per-feature state texture, floor filter, pick pass |
| `src/spikes/renderer/pick.ts` | GPU readback decode + CPU graph screen-space index with precedence |
| `src/spikes/renderer/measure.ts` | Frame-time percentiles, decode timing, pick latency |
| `src/spikes/renderer/RendererSpike.tsx` | Spike route: map, layer, controls, HUD |
| `src/spikes/renderer/pick.test.ts` | Precedence + screen-space index unit tests |
| `src/spikes/renderer/sceneFormat.test.ts` | Decode against a committed small fixture |
| `src/main.tsx` | Add `?spike=renderer` entry |
| `docs/superpowers/reports/2026-08-03-3d-rendering-spike-report.md` | Gate results |

---

## Task 1: Scene format and quantization

**Files:**
- Create: `core/crates/kiriko-scene/Cargo.toml`
- Create: `core/crates/kiriko-scene/src/lib.rs`
- Create: `core/crates/kiriko-scene/src/format.rs`
- Create: `core/crates/kiriko-scene/src/quantize.rs`
- Create: `core/crates/kiriko-scene/tests/roundtrip.rs`
- Modify: `core/Cargo.toml` (add `crates/kiriko-scene` to `members`)

**Interfaces:**
- Produces: `SceneDocument`, `SceneHeader`, `SceneLevel`, `SceneFeature`, `SceneBatch`, `SemanticRole`, `OcclusionClass`, `encode_scene(&SceneDocument) -> Result<Vec<u8>, SceneError>`, `decode_scene(&[u8]) -> Result<SceneDocument, SceneError>`, `quantize_positions(&[[f32; 3]]) -> (Vec<[u16; 3]>, [f32; 3], [f32; 3])`, `encode_normal_oct(normal: [f32; 3]) -> [i16; 2]`, `decode_normal_oct([i16; 2]) -> [f32; 3]`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing round-trip test**

Create `core/crates/kiriko-scene/tests/roundtrip.rs`:

```rust
use kiriko_scene::{
    decode_scene, encode_scene, OcclusionClass, SceneBatch, SceneDocument, SceneFeature,
    SceneHeader, SceneLevel, SemanticRole,
};

fn sample_document() -> SceneDocument {
    SceneDocument {
        header: SceneHeader {
            format_version: 1,
            deriver_version: 1,
            source_hash: "sha256:abc".to_string(),
            frame_origin_ecef: [-3_959_720.400_616_091_7, 3_350_435.954_423_757_7, 3_699_347.113_056_253_6],
            world_transform: [
                -0.645_931_378_009_025_9, -0.763_395_477_392_524_9, 0.0, 0.0,
                0.445_240_265_906_090_45, -0.376_730_891_155_057_09, 0.812_302_247_482_666, 0.0,
                -0.620_107_862_004_050_66, 0.524_691_510_076_307_21, 0.583_236_709_008_109, 0.0,
                0.0, 0.0, 0.0, 1.0,
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
```

- [ ] **Step 2: Write the failing quantization test**

Append to `core/crates/kiriko-scene/tests/roundtrip.rs`:

```rust
use kiriko_scene::{decode_normal_oct, encode_normal_oct, quantize_positions};

#[test]
fn quantized_positions_stay_within_one_millimetre() {
    let input = vec![[0.0_f32, 0.0, 0.0], [12.5, -3.25, 7.125], [650.0, 1108.0, 115.65]];
    let (quantized, origin, scale) = quantize_positions(&input);
    for (index, source) in input.iter().enumerate() {
        let q = quantized[index];
        for axis in 0..3 {
            let restored = origin[axis] + f32::from(q[axis]) * scale[axis];
            let error = (restored - source[axis]).abs();
            let extent = 1108.0_f32;
            // u16 over the largest extent gives ~17 mm; assert the bound explicitly.
            assert!(error <= extent / 65_535.0 + 1e-4, "axis {axis} error {error}");
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-scene`
Expected: FAIL — crate `kiriko-scene` does not exist.

- [ ] **Step 4: Create the crate manifest and register it**

Create `core/crates/kiriko-scene/Cargo.toml`:

```toml
[package]
name = "kiriko-scene"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
postcard.workspace = true
zstd.workspace = true
sha2.workspace = true
thiserror.workspace = true
```

In `core/Cargo.toml`, add `"crates/kiriko-scene",` to `members` immediately after `"crates/kiriko-facilities",`.

- [ ] **Step 5: Implement the format types**

Create `core/crates/kiriko-scene/src/format.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::SceneError;

/// Container magic. Bumped only when the byte layout changes incompatibly.
pub const SCENE_MAGIC: &[u8; 4] = b"KSC1";

/// Twelve semantic roles from the renderer-neutral visual language (issue #32).
/// The renderer styles these; it never sees a source material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SemanticRole {
    Walkable,
    Public,
    Service,
    Restricted,
    Structure,
    Ceiling,
    Opening,
    Elevator,
    Escalator,
    Stairs,
    Ramp,
    Context,
}

/// Whether an object may occlude the route, selection, or a priority label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OcclusionClass {
    Never,
    ProtectedCorridor,
    Context,
}

/// Immutable scene identity plus the venue-local metric frame (issue #19).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneHeader {
    pub format_version: u16,
    pub deriver_version: u16,
    pub source_hash: String,
    /// ECEF translation of the venue-local frame origin, double precision.
    pub frame_origin_ecef: [f64; 3],
    /// Column-major 4x4 tileset transform, retained unchanged (issue #31).
    pub world_transform: [f64; 16],
    pub bounds_min: [f32; 3],
    pub bounds_max: [f32; 3],
}

/// One canonical level and the composite source identity issue #30 requires.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneLevel {
    pub canonical_id: String,
    pub source_level_key: String,
    pub source_level_name: String,
    pub source_document: String,
    pub source_link_name: String,
    /// Source elevation retained as provenance, never placement authority.
    pub source_elevation_meters: f32,
    /// Plane resolved from tile surfaces (issue #31).
    pub resolved_plane_z: f32,
    /// Elevation quantized to decimetres, part of the composite identity.
    pub quantized_elevation_dm: i32,
}

/// One pickable source object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneFeature {
    pub source_object_id: String,
    pub canonical_id: Option<String>,
    pub level_index: u32,
    pub role: SemanticRole,
    pub occlusion: OcclusionClass,
    /// 0-255 confidence; 255 = source-authored certainty.
    pub confidence: u8,
    pub min_z: f32,
    pub max_z: f32,
}

/// Merged geometry for one `(level, role)` pair. Vertices are triangle-list
/// order; no index buffer, because the source indexes 1:1 with vertices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneBatch {
    pub level_index: u32,
    pub role: SemanticRole,
    pub quantization_origin: [f32; 3],
    pub quantization_scale: [f32; 3],
    pub vertex_count: u32,
    pub positions: Vec<[u16; 3]>,
    pub normals: Vec<[i16; 2]>,
    pub feature_indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneDocument {
    pub header: SceneHeader,
    pub levels: Vec<SceneLevel>,
    pub features: Vec<SceneFeature>,
    pub batches: Vec<SceneBatch>,
}

/// `KSC1` magic followed by zstd-compressed postcard.
pub fn encode_scene(document: &SceneDocument) -> Result<Vec<u8>, SceneError> {
    let raw = postcard::to_allocvec(document)?;
    let compressed = zstd::encode_all(raw.as_slice(), 19)?;
    let mut out = Vec::with_capacity(compressed.len() + 4);
    out.extend_from_slice(SCENE_MAGIC);
    out.extend_from_slice(&compressed);
    Ok(out)
}

pub fn decode_scene(bytes: &[u8]) -> Result<SceneDocument, SceneError> {
    let Some(body) = bytes.strip_prefix(SCENE_MAGIC) else {
        return Err(SceneError::Magic);
    };
    let raw = zstd::decode_all(body)?;
    Ok(postcard::from_bytes(&raw)?)
}
```

- [ ] **Step 6: Implement quantization**

Create `core/crates/kiriko-scene/src/quantize.rs`:

```rust
/// Quantize positions to `u16` per axis inside the batch's own bounds.
/// Returns the quantized vertices plus the origin and scale needed to restore
/// them: `restored = origin + q * scale`.
pub fn quantize_positions(positions: &[[f32; 3]]) -> (Vec<[u16; 3]>, [f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for position in positions {
        for axis in 0..3 {
            min[axis] = min[axis].min(position[axis]);
            max[axis] = max[axis].max(position[axis]);
        }
    }
    if positions.is_empty() {
        return (Vec::new(), [0.0; 3], [1.0; 3]);
    }

    let mut scale = [1.0_f32; 3];
    for axis in 0..3 {
        let extent = max[axis] - min[axis];
        scale[axis] = if extent > 0.0 { extent / 65_535.0 } else { 1.0 };
    }

    let quantized = positions
        .iter()
        .map(|position| {
            let mut out = [0_u16; 3];
            for axis in 0..3 {
                let normalized = (position[axis] - min[axis]) / scale[axis];
                out[axis] = normalized.round().clamp(0.0, 65_535.0) as u16;
            }
            out
        })
        .collect();

    (quantized, min, scale)
}

/// Octahedral normal encoding to two signed 16-bit channels.
pub fn encode_normal_oct(normal: [f32; 3]) -> [i16; 2] {
    let length = (normal[0].abs() + normal[1].abs() + normal[2].abs()).max(f32::EPSILON);
    let mut x = normal[0] / length;
    let mut y = normal[1] / length;
    if normal[2] < 0.0 {
        let previous_x = x;
        x = (1.0 - y.abs()) * if previous_x >= 0.0 { 1.0 } else { -1.0 };
        y = (1.0 - previous_x.abs()) * if y >= 0.0 { 1.0 } else { -1.0 };
    }
    [
        (x.clamp(-1.0, 1.0) * 32_767.0).round() as i16,
        (y.clamp(-1.0, 1.0) * 32_767.0).round() as i16,
    ]
}

pub fn decode_normal_oct(encoded: [i16; 2]) -> [f32; 3] {
    let x = f32::from(encoded[0]) / 32_767.0;
    let y = f32::from(encoded[1]) / 32_767.0;
    let z = 1.0 - x.abs() - y.abs();
    let (x, y) = if z < 0.0 {
        (
            (1.0 - y.abs()) * if x >= 0.0 { 1.0 } else { -1.0 },
            (1.0 - x.abs()) * if y >= 0.0 { 1.0 } else { -1.0 },
        )
    } else {
        (x, y)
    };
    let length = (x * x + y * y + z * z).sqrt().max(f32::EPSILON);
    [x / length, y / length, z / length]
}
```

- [ ] **Step 7: Implement the crate root and error type**

Create `core/crates/kiriko-scene/src/lib.rs`:

```rust
//! Kiriko scene format: one GPU-ready batch layout that both scene sources
//! compile to (design: docs/superpowers/specs/2026-08-03-3d-rendering-architecture-design.md).

mod format;
mod quantize;

pub use format::{
    decode_scene, encode_scene, OcclusionClass, SceneBatch, SceneDocument, SceneFeature,
    SceneHeader, SceneLevel, SemanticRole, SCENE_MAGIC,
};
pub use quantize::{decode_normal_oct, encode_normal_oct, quantize_positions};

#[derive(Debug, thiserror::Error)]
pub enum SceneError {
    #[error("scene container magic missing or unrecognized")]
    Magic,
    #[error("postcard codec failure: {0}")]
    Postcard(#[from] postcard::Error),
    #[error("io failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("glb: {0}")]
    Glb(String),
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-scene`
Expected: PASS — 5 tests.

- [ ] **Step 9: Commit**

```bash
git add core/Cargo.toml core/crates/kiriko-scene
git commit -m "feat(scene): add scene format and quantization"
```

---

## Task 2: GLB reader with feature metadata

**Files:**
- Create: `core/crates/kiriko-scene/src/glb.rs`
- Create: `core/crates/kiriko-scene/tests/derive.rs`
- Modify: `core/crates/kiriko-scene/src/lib.rs`

**Interfaces:**
- Consumes: `SceneError` from Task 1.
- Produces: `GlbScene`, `GlbPrimitive`, `GlbFeatureRow`, `read_glb(bytes: &[u8]) -> Result<GlbScene, SceneError>`. `GlbScene` exposes `primitives: Vec<GlbPrimitive>` (each with `positions: Vec<[f32; 3]>`, `normals: Vec<[f32; 3]>`, `feature_id: u32`) and `features: Vec<GlbFeatureRow>` (with `revit_unique_id`, `category`, `level_key`, `level_name`, `level_elevation_meters`, `min_z`, `max_z`, `source_document`, `source_link_name`).

- [ ] **Step 1: Write the failing test with a synthetic GLB**

Create `core/crates/kiriko-scene/tests/derive.rs`:

```rust
use kiriko_scene::read_glb;
use serde_json::json;

/// Build a two-triangle GLB with one property table row per triangle.
/// Layout: positions f32x3, normals f32x3, feature ids u32, then the
/// EXT_structural_metadata string data and offsets.
fn synthetic_glb() -> Vec<u8> {
    let positions: [[f32; 3]; 6] = [
        [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0],
        [0.0, 0.0, 3.0], [1.0, 0.0, 3.0], [0.0, 1.0, 3.0],
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
    while bin.len() % 4 != 0 {
        bin.push(0);
    }

    let gltf = json!({
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

    let mut json_chunk = serde_json::to_vec(&gltf).expect("serialize gltf");
    while json_chunk.len() % 4 != 0 {
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-scene --test derive`
Expected: FAIL — `read_glb` not found.

- [ ] **Step 3: Implement the GLB reader**

Create `core/crates/kiriko-scene/src/glb.rs`. Parse in this order: container header (`glTF` magic, version 2, chunk walk collecting `JSON` and `BIN\0`), then `serde_json::Value` for the glTF, then per-primitive accessor reads, then the property table.

Required behaviors, each load-bearing:

- Container: reject when magic is not `glTF`, version is not `2`, or a chunk length exceeds the remaining buffer. Error text must contain `glb`.
- Accessor reads: support `componentType` `5126` (f32) for `VEC3`, and `5125` (u32) / `5123` (u16) / `5121` (u8) for `SCALAR` feature ids. Honor `bufferView.byteOffset`, `accessor.byteOffset`, and `bufferView.byteStride` when present (default to tightly packed).
- Per-primitive feature id: read the first element of `_FEATURE_ID_0`. The measured asset holds one constant id per primitive; assert that by checking the accessor's `min`/`max` when both are present and returning `SceneError::Glb` if they differ, so a future non-constant asset fails loudly instead of rendering wrong picks.
- Property table: for `STRING` properties read `values` plus `stringOffsets` (u32 offsets, `count + 1` entries) and slice UTF-8; for `SCALAR`/`FLOAT32` read f32; treat a missing property as an empty string or `0.0`.
- Read exactly these property names when present: `revitUniqueId`, `category`, `levelKey`, `levelName`, `levelElevationMeters`, `minZMeters`, `maxZMeters`, `sourceDocument`, `sourceLinkName`.

Public types:

```rust
#[derive(Debug, Clone)]
pub struct GlbPrimitive {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub feature_id: u32,
}

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

#[derive(Debug, Clone)]
pub struct GlbScene {
    pub primitives: Vec<GlbPrimitive>,
    pub features: Vec<GlbFeatureRow>,
}
```

- [ ] **Step 4: Export from the crate root**

In `core/crates/kiriko-scene/src/lib.rs` add `mod glb;` and
`pub use glb::{read_glb, GlbFeatureRow, GlbPrimitive, GlbScene};`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-scene`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add core/crates/kiriko-scene
git commit -m "feat(scene): read GLB feature metadata"
```

---

## Task 3: Deriver, role mapping, and the gate 1 CLI

**Files:**
- Create: `core/crates/kiriko-scene/src/roles.rs`
- Create: `core/crates/kiriko-scene/src/derive.rs`
- Create: `core/crates/kiriko-scene/examples/derive_tiles.rs`
- Modify: `core/crates/kiriko-scene/src/lib.rs`
- Modify: `core/crates/kiriko-scene/tests/derive.rs`

**Interfaces:**
- Consumes: `read_glb`, `GlbScene`, format types, `quantize_positions`, `encode_normal_oct`.
- Produces: `role_for_category(category: &str) -> SemanticRole`, `derive_scene(glb: &[u8], levels_json: &[u8], source_hash: &str, world_transform: [f64; 16]) -> Result<SceneDocument, SceneError>`.

- [ ] **Step 1: Write the failing role-mapping and deriver tests**

Append to `core/crates/kiriko-scene/tests/derive.rs`:

```rust
use kiriko_scene::{derive_scene, role_for_category, SemanticRole};

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-scene --test derive`
Expected: FAIL — `derive_scene` and `role_for_category` not found.

- [ ] **Step 3: Implement role mapping**

Create `core/crates/kiriko-scene/src/roles.rs`:

```rust
use crate::SemanticRole;

/// Map a Revit category onto one of the twelve semantic roles. Matching is
/// case-insensitive and substring-based because exporters vary
/// ("Floors", "floor", "Revit Floors"). Unknown categories become `Context`:
/// contextual mass never becomes navigable surface by accident.
pub fn role_for_category(category: &str) -> SemanticRole {
    let normalized = category.to_ascii_lowercase();
    const RULES: &[(&str, SemanticRole)] = &[
        ("escalator", SemanticRole::Escalator),
        ("elevator", SemanticRole::Elevator),
        ("lift", SemanticRole::Elevator),
        ("stair", SemanticRole::Stairs),
        ("ramp", SemanticRole::Ramp),
        ("door", SemanticRole::Opening),
        ("opening", SemanticRole::Opening),
        ("window", SemanticRole::Opening),
        ("ceiling", SemanticRole::Ceiling),
        ("roof", SemanticRole::Ceiling),
        ("floor", SemanticRole::Walkable),
        ("slab", SemanticRole::Walkable),
        ("wall", SemanticRole::Structure),
        ("column", SemanticRole::Structure),
        ("structural", SemanticRole::Structure),
        ("stair rail", SemanticRole::Structure),
        ("railing", SemanticRole::Structure),
        ("room", SemanticRole::Public),
        ("retail", SemanticRole::Public),
        ("shop", SemanticRole::Public),
        ("office", SemanticRole::Service),
        ("mechanical", SemanticRole::Service),
        ("plumbing", SemanticRole::Service),
        ("electrical", SemanticRole::Service),
        ("restricted", SemanticRole::Restricted),
        ("staff", SemanticRole::Restricted),
    ];
    for (needle, role) in RULES {
        if normalized.contains(needle) {
            return *role;
        }
    }
    SemanticRole::Context
}

/// Ceilings and unknown contextual mass may occlude; navigable and conveyance
/// surfaces never do (issue #32 section 6).
pub fn occlusion_for_role(role: SemanticRole) -> crate::OcclusionClass {
    match role {
        SemanticRole::Ceiling => crate::OcclusionClass::ProtectedCorridor,
        SemanticRole::Structure | SemanticRole::Context => crate::OcclusionClass::Context,
        _ => crate::OcclusionClass::Never,
    }
}
```

- [ ] **Step 4: Implement the deriver**

Create `core/crates/kiriko-scene/src/derive.rs`. Behavior, in order:

1. `read_glb(glb)`.
2. Parse `levels_json` into level records (`levelKey`, `levelName`, `levelElevationMeters`, `minZMeters`, `maxZMeters`). Build a `HashMap<String, usize>` from `levelKey` to level index. `quantized_elevation_dm = (level_elevation_meters * 10.0).round() as i32`. `resolved_plane_z` = `minZMeters` from the level record, because tile surfaces are placement authority and `levelElevationMeters` is provenance (issue #31).
3. Build `SceneFeature` rows from `GlbFeatureRow` in property-table order: `role = role_for_category(&row.category)`, `occlusion = occlusion_for_role(role)`, `level_index` from the `levelKey` map (features whose key is absent get a synthesized level appended with `canonical_id = format!("level-unmapped-{key}")` so nothing is silently dropped), `canonical_id = None` — canonical association is issue #30's ingestion concern, not the deriver's, `confidence = 255` for source-authored geometry.
4. Group primitives by `(level_index, role)` of their feature. For each group concatenate positions and normals in triangle-list order, recording each vertex's feature index.
5. Per group call `quantize_positions`, `encode_normal_oct` per normal, and emit one `SceneBatch`.
6. `bounds_min`/`bounds_max` from all positions before quantization. `frame_origin_ecef` = the last column of `world_transform` (`[world_transform[12], world_transform[13], world_transform[14]]`).
7. Return the `SceneDocument`.

- [ ] **Step 5: Export from the crate root**

In `core/crates/kiriko-scene/src/lib.rs` add `mod derive;` and `mod roles;` plus
`pub use derive::derive_scene;` and `pub use roles::{occlusion_for_role, role_for_category};`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --manifest-path core/Cargo.toml -p kiriko-scene`
Expected: PASS — 10 tests.

- [ ] **Step 7: Write the measurement CLI**

Create `core/crates/kiriko-scene/examples/derive_tiles.rs`:

```rust
//! Gate 1 measurement: derive a tileset directory and report the numbers.
//!
//! Run: cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene \
//!        --example derive_tiles -- "C:/cesium/tokyo 3dtiles" target/spike/tokyo
use std::{collections::BTreeMap, env, fs, path::PathBuf, time::Instant};

use kiriko_scene::{derive_scene, encode_scene, SemanticRole};
use sha2::{Digest, Sha256};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let input = PathBuf::from(args.next().expect("usage: derive_tiles <tileset dir> <out prefix>"));
    let out_prefix = PathBuf::from(args.next().expect("usage: derive_tiles <tileset dir> <out prefix>"));

    let tileset: serde_json::Value = serde_json::from_slice(&fs::read(input.join("tileset.json"))?)?;
    let transform_values = tileset["root"]["transform"]
        .as_array()
        .expect("tileset root transform");
    let mut world_transform = [0.0_f64; 16];
    for (index, value) in transform_values.iter().enumerate() {
        world_transform[index] = value.as_f64().expect("transform component");
    }
    let content_uri = tileset["root"]["content"]["uri"].as_str().unwrap_or("content.glb");

    let glb = fs::read(input.join(content_uri))?;
    let levels_json = fs::read(input.join("levels.json"))?;
    let source_hash = format!("sha256:{:x}", Sha256::digest(&glb));

    let derive_start = Instant::now();
    let document = derive_scene(&glb, &levels_json, &source_hash, world_transform)?;
    let derive_ms = derive_start.elapsed().as_millis();

    let encode_start = Instant::now();
    let bytes = encode_scene(&document)?;
    let encode_ms = encode_start.elapsed().as_millis();

    if let Some(parent) = out_prefix.parent() {
        fs::create_dir_all(parent)?;
    }
    let scene_path = out_prefix.with_extension("kscene");
    fs::write(&scene_path, &bytes)?;

    let mut per_role: BTreeMap<String, usize> = BTreeMap::new();
    for batch in &document.batches {
        *per_role.entry(format!("{:?}", batch.role)).or_default() += 1;
    }
    let vertices: usize = document.batches.iter().map(|b| b.vertex_count as usize).sum();
    let busiest = document
        .batches
        .iter()
        .map(|b| b.vertex_count)
        .max()
        .unwrap_or(0);

    let stats = serde_json::json!({
        "input": input.to_string_lossy(),
        "sourceGlbBytes": glb.len(),
        "derivedBytes": bytes.len(),
        "compressionRatio": glb.len() as f64 / bytes.len() as f64,
        "deriveMs": derive_ms,
        "encodeMs": encode_ms,
        "levels": document.levels.len(),
        "features": document.features.len(),
        "batches": document.batches.len(),
        "batchesPerRole": per_role,
        "vertices": vertices,
        "largestBatchVertices": busiest,
        "unmappedRoleBatches": document.batches.iter()
            .filter(|b| b.role == SemanticRole::Context).count(),
    });
    let stats_path = out_prefix.with_extension("stats.json");
    fs::write(&stats_path, serde_json::to_vec_pretty(&stats)?)?;
    println!("{}", serde_json::to_string_pretty(&stats)?);
    Ok(())
}
```

- [ ] **Step 8: Run the CLI on all three fixtures — GATE 1**

```bash
cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene --example derive_tiles -- "C:/cesium/LumineEst 3dtiles" target/spike/lumine-est
cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene --example derive_tiles -- "C:/cesium/tokyo 3dtiles" target/spike/tokyo
cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene --example derive_tiles -- "C:/cesium/shinjuku 3dtiles" target/spike/shinjuku
```

Record `derivedBytes`, `compressionRatio`, `deriveMs`, `batches`, `largestBatchVertices` for each. **Falsifier:** Tokyo `derivedBytes` above ~50 MB means quantization or compression needs revisiting before issue #26 sets budgets — report it, do not silently continue.

- [ ] **Step 9: Commit**

```bash
git add core/crates/kiriko-scene
git commit -m "feat(scene): derive tiles into merged semantic batches"
```

---

## Task 4: Browser decode path

**Files:**
- Modify: `core/crates/kiriko-wasm/Cargo.toml`
- Modify: `core/crates/kiriko-wasm/src/lib.rs`
- Create: `src/spikes/renderer/sceneFormat.ts`
- Create: `src/spikes/renderer/sceneFormat.test.ts`
- Create: `src/spikes/renderer/fixtures/tiny.kscene` (generated, committed)

**Interfaces:**
- Consumes: `decode_scene` from Task 1, `derive_scene` from Task 3.
- Produces: wasm export `decodeScene(bytes: Uint8Array): { meta: string; payload: Uint8Array }`; TS `loadScene(bytes: Uint8Array): SceneView` where `SceneView` is `{ header: SceneHeaderView; levels: readonly SceneLevelView[]; features: readonly SceneFeatureView[]; batches: readonly SceneBatchView[] }` and `SceneBatchView` is `{ levelIndex: number; role: SemanticRoleName; quantizationOrigin: readonly [number, number, number]; quantizationScale: readonly [number, number, number]; vertexCount: number; positions: Uint16Array; normals: Int16Array; featureIndices: Uint32Array }`.

- [ ] **Step 1: Add the wasm export**

In `core/crates/kiriko-wasm/Cargo.toml` add `kiriko-scene = { path = "../kiriko-scene" }` to `[dependencies]`.

In `core/crates/kiriko-wasm/src/lib.rs` append:

```rust
/// Decoded scene split into a JSON description plus one packed payload.
/// The payload concatenates, per batch in order: positions (u16 x3), normals
/// (i16 x2), feature indices (u32). The JSON carries byte offsets so the
/// client can build typed-array views without re-parsing geometry.
#[wasm_bindgen]
pub struct DecodedScene {
    meta: String,
    payload: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedScene {
    #[wasm_bindgen(getter)]
    pub fn meta(&self) -> String {
        self.meta.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn payload(&self) -> Vec<u8> {
        self.payload.clone()
    }
}

#[wasm_bindgen(js_name = "decodeScene")]
pub fn decode_scene_js(bytes: &[u8]) -> Result<DecodedScene, JsError> {
    let document = kiriko_scene::decode_scene(bytes)
        .map_err(|error| JsError::new(&format!("{error}")))?;

    let mut payload: Vec<u8> = Vec::new();
    let mut batch_meta: Vec<serde_json::Value> = Vec::with_capacity(document.batches.len());
    for batch in &document.batches {
        let positions_offset = payload.len();
        for position in &batch.positions {
            for component in position {
                payload.extend_from_slice(&component.to_le_bytes());
            }
        }
        let normals_offset = payload.len();
        for normal in &batch.normals {
            for component in normal {
                payload.extend_from_slice(&component.to_le_bytes());
            }
        }
        let features_offset = payload.len();
        for index in &batch.feature_indices {
            payload.extend_from_slice(&index.to_le_bytes());
        }
        batch_meta.push(serde_json::json!({
            "levelIndex": batch.level_index,
            "role": format!("{:?}", batch.role),
            "quantizationOrigin": batch.quantization_origin,
            "quantizationScale": batch.quantization_scale,
            "vertexCount": batch.vertex_count,
            "positionsOffset": positions_offset,
            "normalsOffset": normals_offset,
            "featureIndicesOffset": features_offset,
        }));
    }

    let meta = serde_json::json!({
        "header": {
            "formatVersion": document.header.format_version,
            "deriverVersion": document.header.deriver_version,
            "sourceHash": document.header.source_hash,
            "frameOriginEcef": document.header.frame_origin_ecef,
            "worldTransform": document.header.world_transform,
            "boundsMin": document.header.bounds_min,
            "boundsMax": document.header.bounds_max,
        },
        "levels": document.levels.iter().map(|level| serde_json::json!({
            "canonicalId": level.canonical_id,
            "sourceLevelKey": level.source_level_key,
            "sourceLevelName": level.source_level_name,
            "sourceElevationMeters": level.source_elevation_meters,
            "resolvedPlaneZ": level.resolved_plane_z,
            "quantizedElevationDm": level.quantized_elevation_dm,
        })).collect::<Vec<_>>(),
        "features": document.features.iter().map(|feature| serde_json::json!({
            "sourceObjectId": feature.source_object_id,
            "canonicalId": feature.canonical_id,
            "levelIndex": feature.level_index,
            "role": format!("{:?}", feature.role),
            "occlusion": format!("{:?}", feature.occlusion),
            "minZ": feature.min_z,
            "maxZ": feature.max_z,
        })).collect::<Vec<_>>(),
        "batches": batch_meta,
    });

    Ok(DecodedScene {
        meta: serde_json::to_string(&meta).map_err(|error| JsError::new(&format!("{error}")))?,
        payload,
    })
}
```

- [ ] **Step 2: Generate the committed test fixture**

Add a `#[test]`-gated helper is not enough — the fixture must exist on disk for Vitest. Add to `core/crates/kiriko-scene/examples/derive_tiles.rs` a second binary instead: create `core/crates/kiriko-scene/examples/write_tiny_fixture.rs` that builds the same synthetic two-triangle GLB as `tests/derive.rs`, derives it, and writes `src/spikes/renderer/fixtures/tiny.kscene`. Run:

```bash
cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene --example write_tiny_fixture
```

- [ ] **Step 3: Write the failing decode test**

Create `src/spikes/renderer/sceneFormat.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadScene } from "./sceneFormat";

describe("loadScene", () => {
  it("decodes the tiny fixture into typed batch views", async () => {
    const bytes = new Uint8Array(readFileSync("src/spikes/renderer/fixtures/tiny.kscene"));
    const scene = await loadScene(bytes);

    expect(scene.levels).toHaveLength(2);
    expect(scene.features).toHaveLength(2);
    expect(scene.batches).toHaveLength(2);

    const batch = scene.batches[0]!;
    expect(batch.vertexCount).toBe(3);
    expect(batch.positions).toHaveLength(9);
    expect(batch.normals).toHaveLength(6);
    expect(batch.featureIndices).toHaveLength(3);
    for (const index of batch.featureIndices) {
      expect(index).toBeLessThan(scene.features.length);
    }
  });

  it("restores quantized positions within the batch bounds", async () => {
    const bytes = new Uint8Array(readFileSync("src/spikes/renderer/fixtures/tiny.kscene"));
    const scene = await loadScene(bytes);
    const batch = scene.batches[0]!;
    const [ox, oy, oz] = batch.quantizationOrigin;
    const [sx, sy, sz] = batch.quantizationScale;
    const x = ox + batch.positions[0]! * sx;
    const y = oy + batch.positions[1]! * sy;
    const z = oz + batch.positions[2]! * sz;
    expect(x).toBeGreaterThanOrEqual(scene.header.boundsMin[0] - 1e-3);
    expect(y).toBeGreaterThanOrEqual(scene.header.boundsMin[1] - 1e-3);
    expect(z).toBeGreaterThanOrEqual(scene.header.boundsMin[2] - 1e-3);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm exec vitest run src/spikes/renderer/sceneFormat.test.ts`
Expected: FAIL — `./sceneFormat` has no export `loadScene`.

- [ ] **Step 5: Rebuild wasm and implement the loader**

```bash
pnpm core:build:wasm
```

Create `src/spikes/renderer/sceneFormat.ts` exposing `loadScene`. It must:

- `await` the wasm module the same way `src/bundle/wasm.ts` does, call `decodeScene(bytes)`, `JSON.parse` the `meta` string, and take one `Uint8Array` copy of `payload`.
- Build per-batch views over that single buffer using the offsets in meta:
  `new Uint16Array(buffer, positionsOffset, vertexCount * 3)`,
  `new Int16Array(buffer, normalsOffset, vertexCount * 2)`,
  `new Uint32Array(buffer, featureIndicesOffset, vertexCount)`.
  Copy the payload into a fresh `ArrayBuffer` first so offsets are 4-byte aligned; assert alignment and throw a descriptive `Error` if an offset is misaligned.
- Type roles as `SemanticRoleName = "Walkable" | "Public" | "Service" | "Restricted" | "Structure" | "Ceiling" | "Opening" | "Elevator" | "Escalator" | "Stairs" | "Ramp" | "Context"` and validate the decoded string against that union, throwing on an unknown role rather than widening to `string`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/spikes/renderer/sceneFormat.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 7: Commit**

```bash
git add core/crates/kiriko-wasm core/crates/kiriko-scene src/spikes/renderer
git commit -m "feat(scene): decode scene format in the browser"
```

---

## Task 5: WebGL2 custom layer — gates 2, 5, 6

**Files:**
- Create: `src/spikes/renderer/glUtil.ts`
- Create: `src/spikes/renderer/sceneLayer.ts`

**Interfaces:**
- Consumes: `SceneView`, `SceneBatchView` from Task 4.
- Produces: `createSceneLayer(scene: SceneView, options: SceneLayerOptions): SceneLayer`, where `SceneLayer` implements MapLibre's `CustomLayerInterface` and additionally exposes `setActiveLevel(levelIndex: number): void`, `setFeatureState(featureIndex: number, state: FeatureStateFlags): void`, `pickAt(x: number, y: number): SurfacePick | null`, `stats(): { drawCalls: number; visibleBatches: number }`. `FeatureStateFlags` is `{ selected?: boolean; hovered?: boolean; diagnostic?: 0 | 1 | 2 | 3 }`. `SurfacePick` is `{ featureIndex: number; world: readonly [number, number, number] }`.

- [ ] **Step 1: Implement GL helpers**

Create `src/spikes/renderer/glUtil.ts` with:

- `compileProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram` — throws with the info log on failure.
- `createFeatureStateTexture(gl: WebGL2RenderingContext, featureCount: number): { texture: WebGLTexture; width: number; height: number; data: Uint8Array }` — square-ish RGBA8 texture sized `Math.ceil(Math.sqrt(featureCount))`; channel 0 = visibility, 1 = state flags, 2 = diagnostic severity, 3 = reserved.
- `saveGlState(gl: WebGL2RenderingContext): GlState` and `restoreGlState(gl: WebGL2RenderingContext, state: GlState): void` — capture and restore exactly: `DEPTH_TEST`, `DEPTH_WRITEMASK`, `DEPTH_FUNC`, `CULL_FACE`, `CULL_FACE_MODE`, `BLEND`, `BLEND_SRC_RGB`, `BLEND_DST_RGB`, `ARRAY_BUFFER_BINDING`, `VERTEX_ARRAY_BINDING`, `CURRENT_PROGRAM`, `ACTIVE_TEXTURE`, `TEXTURE_BINDING_2D`, `FRAMEBUFFER_BINDING`, `VIEWPORT`. This is gate 2's core evidence — MapLibre must render identically before and after our layer.

- [ ] **Step 2: Implement the layer**

Create `src/spikes/renderer/sceneLayer.ts`. Required behavior:

- `id`, `type: "custom"`, `renderingMode: "3d"`.
- `onAdd(map, gl)`: compile the surface program, upload one VBO per batch (interleave is unnecessary — three separate buffers per batch is fine for the spike), create one VAO per batch, create the feature-state texture, create the pick framebuffer with two color attachments (`RGBA8` for feature ID, `RGBA32F` for view-space position) plus a depth attachment, sized to the drawing buffer.
- `render(gl, args)`: save GL state, then for each batch whose level is visible under the current active-level policy, bind its VAO and draw `TRIANGLES`. Restore GL state before returning.
- **Precision (gate 5):** never upload absolute ECEF or mercator coordinates. Per frame compute `modelMatrix = mercatorMatrix(frameOrigin) * scale(quantizationScale) * translate(quantizationOrigin)` in double precision on the CPU, then downcast the final matrix to `Float32Array` for the uniform. Positions stay `u16` in the vertex buffer and are expanded in the shader as `origin + float(position) * scale`.
- **Floor filtering (gate 6):** visibility is per feature via the state texture, not per batch — the active level renders opaque, other levels render at context opacity only when the policy asks for it, and features whose `occlusion` is `ProtectedCorridor` fade to `0.15` when the active level is below them. Batches are still skipped wholesale when no feature in them is visible, to keep the draw-call count honest.
- Vertex shader outline:

```glsl
#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec3 u_quantOrigin;
uniform vec3 u_quantScale;
uniform sampler2D u_featureState;
uniform vec2 u_featureTexSize;
in vec3 a_position;   // u16 expanded by the attribute pointer
in vec2 a_normal;     // i16 oct-encoded, normalized
in float a_featureIndex;
out vec3 v_normal;
out vec4 v_state;
void main() {
  vec3 local = u_quantOrigin + a_position * u_quantScale;
  float index = a_featureIndex;
  vec2 texel = vec2(mod(index, u_featureTexSize.x), floor(index / u_featureTexSize.x));
  v_state = texture(u_featureState, (texel + 0.5) / u_featureTexSize);
  v_normal = vec3(a_normal, 1.0 - abs(a_normal.x) - abs(a_normal.y));
  gl_Position = u_matrix * vec4(local, 1.0);
}
```

- Fragment shader: discard when `v_state.r < 0.5`; otherwise output the role's base color modulated by one world-stable soft key from above and camera-left, contact darkness clamped at `0.12` (issue #32 section 5), and `v_state.g` driving the selection tint. In pick mode output the feature index packed into `RGBA8` on attachment 0 and view-space position on attachment 1.
- `onRemove(gl)`: delete every buffer, VAO, texture, framebuffer, and program.
- Handle `webglcontextlost` / `webglcontextrestored` on the map canvas by rebuilding all GL resources from the retained `SceneView` — gate 2's recovery evidence.

- [ ] **Step 3: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: zero diagnostics.

- [ ] **Step 4: Commit**

```bash
git add src/spikes/renderer
git commit -m "spike: render scene batches in a MapLibre custom layer"
```

---

## Task 6: Picking — gate 4

**Files:**
- Create: `src/spikes/renderer/pick.ts`
- Create: `src/spikes/renderer/pick.test.ts`

**Interfaces:**
- Consumes: `SurfacePick` from Task 5.
- Produces: `decodeFeatureId(rgba: Uint8Array): number`, `encodeFeatureId(index: number): [number, number, number, number]`, `createGraphIndex(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphIndex`, `GraphIndex.pickAt(x: number, y: number): GraphPick | null`. `GraphNode` is `{ id: number; screen: readonly [number, number] }`, `GraphEdge` is `{ id: number; from: readonly [number, number]; to: readonly [number, number] }`, `GraphPick` is `{ kind: "junction"; id: number } | { kind: "path"; id: number }`.

- [ ] **Step 1: Write the failing precedence tests**

Create `src/spikes/renderer/pick.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGraphIndex, decodeFeatureId, encodeFeatureId, JUNCTION_HIT_PX, PATH_HIT_PX } from "./pick";

describe("feature id packing", () => {
  it("round-trips every byte boundary", () => {
    for (const index of [0, 1, 255, 256, 65_535, 65_536, 22_386, 16_777_214]) {
      expect(decodeFeatureId(new Uint8Array(encodeFeatureId(index)))).toBe(index);
    }
  });

  it("reserves all-zero as no-hit", () => {
    expect(decodeFeatureId(new Uint8Array([0, 0, 0, 0]))).toBe(-1);
  });
});

describe("graph picking", () => {
  const nodes = [{ id: 7, screen: [100, 100] as const }];
  const edges = [{ id: 42, from: [0, 200] as const, to: [200, 200] as const }];
  const index = createGraphIndex(nodes, edges);

  it("preserves the shipped affordances", () => {
    expect(JUNCTION_HIT_PX).toBe(10);
    expect(PATH_HIT_PX).toBe(12);
  });

  it("hits a junction inside 10 px", () => {
    expect(index.pickAt(107, 100)).toEqual({ kind: "junction", id: 7 });
  });

  it("misses a junction outside 10 px", () => {
    expect(index.pickAt(115, 100)).toBeNull();
  });

  it("hits a path inside 12 px of the segment", () => {
    expect(index.pickAt(100, 209)).toEqual({ kind: "path", id: 42 });
  });

  it("prefers a junction over an overlapping path", () => {
    const overlapping = createGraphIndex(
      [{ id: 7, screen: [100, 200] as const }],
      [{ id: 42, from: [0, 200] as const, to: [200, 200] as const }],
    );
    expect(overlapping.pickAt(100, 200)).toEqual({ kind: "junction", id: 7 });
  });

  it("prefers the nearest junction when two are in range", () => {
    const twoNodes = createGraphIndex(
      [
        { id: 1, screen: [100, 100] as const },
        { id: 2, screen: [104, 100] as const },
      ],
      [],
    );
    expect(twoNodes.pickAt(103, 100)).toEqual({ kind: "junction", id: 2 });
  });

  it("ignores a point beyond a segment's ends", () => {
    expect(index.pickAt(-20, 200)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/spikes/renderer/pick.test.ts`
Expected: FAIL — `./pick` does not exist.

- [ ] **Step 3: Implement picking**

Create `src/spikes/renderer/pick.ts`:

- `export const JUNCTION_HIT_PX = 10;` and `export const PATH_HIT_PX = 12;` with a comment citing `src/map/featureLayers.ts` as the source of truth.
- `encodeFeatureId(index)` packs `index + 1` little-endian into RGB with A = 255; `decodeFeatureId` returns `-1` when all four bytes are zero, else the unpacked value minus one.
- `createGraphIndex` builds a uniform screen-space grid with cell size `Math.max(JUNCTION_HIT_PX, PATH_HIT_PX) * 2`, bucketing nodes and edge bounding boxes. `pickAt` queries the 3×3 cell neighborhood, returns the nearest junction within `JUNCTION_HIT_PX` first, otherwise the nearest segment within `PATH_HIT_PX` using point-to-segment distance clamped to the segment's ends, otherwise `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/spikes/renderer/pick.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/spikes/renderer
git commit -m "spike: add feature-id and graph picking"
```

---

## Task 7: Spike shell, measurement HUD, and the entry — gate 3

**Files:**
- Create: `src/spikes/renderer/measure.ts`
- Create: `src/spikes/renderer/RendererSpike.tsx`
- Create: `src/spikes/renderer/spike.css`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `loadScene`, `createSceneLayer`, `createGraphIndex`.
- Produces: `createFrameMeter(): FrameMeter` with `FrameMeter.sample(ms: number): void` and `FrameMeter.percentiles(): { p50: number; p95: number; count: number }`; React component `RendererSpike`.

- [ ] **Step 1: Implement the frame meter**

Create `src/spikes/renderer/measure.ts`. `createFrameMeter` keeps a ring buffer of the last 600 frame durations and computes exact percentiles by sorting a copy. Also export `measureOnce<T>(label: string, fn: () => T): { value: T; ms: number }` for decode and upload timings.

- [ ] **Step 2: Build the spike shell**

Create `src/spikes/renderer/RendererSpike.tsx`. It must:

- Create one MapLibre map with `maxPitch: 60`, a plain raster basemap style, centered on the scene's frame origin converted to lng/lat.
- Load a `.kscene` via `fetch` from a URL supplied by `?scene=` (default `/spike/tokyo.kscene`), timing decode and GPU upload with `measureOnce`.
- Add the custom layer, and expose native controls (plain HTML, no bilingual requirement): active-level select built from `scene.levels`, a "show all levels" toggle, a reduced-motion checkbox, a pick-mode readout, and a "simulate context loss" button that calls `WEBGL_lose_context.loseContext()`.
- Drive a `FrameMeter` from `map.on("render")` deltas, and display `p50`/`p95`, draw calls, visible batches, decode ms, upload ms, feature count, and level count in a fixed HUD.
- On pointer move, run `layer.pickAt` and show the resolved feature's `sourceObjectId`, `role`, `canonicalId`, and level name; on click, latch the selection through `setFeatureState`.

- [ ] **Step 3: Wire the entry**

In `src/main.tsx`, extend the existing prototype branch. The file currently reads a `prototype` parameter; add a sibling `spike` parameter so both stay independent:

```tsx
const spike = new URLSearchParams(window.location.search).get("spike");
const app =
  spike === "renderer" ? (
    <RendererSpike />
  ) : prototype === "visual-language" ? (
    <VisualLanguagePrototype />
  ) : showViewer ? (
    <App />
  ) : (
    <GalleryPage />
  );
```

- [ ] **Step 4: Stage the derived scenes for the dev server**

```bash
mkdir -p public/spike
cp target/spike/tokyo.kscene target/spike/shinjuku.kscene target/spike/lumine-est.kscene public/spike/
```

Add `public/spike/` to `.gitignore` — derived fixtures are reproducible and must not enter git.

- [ ] **Step 5: Verify compilation and build**

Run: `pnpm exec tsc --noEmit`
Expected: zero diagnostics.

Run: `pnpm exec vite build`
Expected: success.

- [ ] **Step 6: Run the measurement matrix — GATES 2, 3, 5, 6**

Start the dev server, then for each of `lumine-est`, `tokyo`, `shinjuku`:

1. Load `/?spike=renderer&scene=/spike/<name>.kscene` at 1440×900.
2. Record decode ms, upload ms, batches, draw calls.
3. Record `p50`/`p95` frame time for: the busiest single level; all levels visible; and a full 360° bearing sweep at pitch 60.
4. Repeat at a mid-tier mobile profile (CPU throttle 4×, 390×844) and record the same numbers.
5. **Gate 2:** confirm MapLibre's own layers still render correctly with the custom layer present, then press "simulate context loss" and confirm the scene rebuilds without a reload.
6. **Gate 5:** zoom to maximum on a wall corner and confirm no vertex jitter or z-fighting against the basemap.
7. **Gate 6:** switch active levels and confirm only that level's features are opaque, ceilings above the active level fade, and the draw-call count drops.

- [ ] **Step 7: Commit**

```bash
git add src/spikes/renderer src/main.tsx .gitignore
git commit -m "spike: add renderer spike shell and measurement HUD"
```

---

## Task 8: Registration against generated geometry — gate 7

**Files:**
- Modify: `src/spikes/renderer/RendererSpike.tsx`

**Interfaces:**
- Consumes: the published venue bundle already served by the dev server.

- [ ] **Step 1: Overlay the venue's 2D geometry**

Extend the spike shell with a `?venue=` parameter. When present, fetch that venue's bundle through the existing client path (`src/bundle/`), add its level geometry as a native MapLibre `fill` layer with 40% opacity beneath the custom layer, and add a control to toggle it.

- [ ] **Step 2: Measure registration**

Sample at least eight recognizable shared features (platform edges, concourse walls, stair openings) across at least three levels. For each, record the planar distance between the tiles surface and the generated polygon edge in metres, using the map's own `unproject` at a fixed zoom.

Report p50, p90, and max. **Falsifier:** a p90 above the `0.50 m` trusted residual from issue #31 reopens that issue's conclusion; a coherent shift above `1.0 m` in any spatially separated cluster is a blocking finding.

- [ ] **Step 3: Commit**

```bash
git add src/spikes/renderer
git commit -m "spike: overlay generated geometry for registration checks"
```

---

## Task 9: Report and issue evidence

**Files:**
- Create: `docs/superpowers/reports/2026-08-03-3d-rendering-spike-report.md`

- [ ] **Step 1: Write the report**

One section per gate, each with: what was measured, the numbers, the falsifier, and pass/fail/deferred. Include the three fixtures' gate 1 table, the desktop and mobile frame-time matrix, the registration residuals, and every deviation from the design spec discovered while building.

- [ ] **Step 2: Verify the whole branch**

```bash
cargo test --manifest-path core/Cargo.toml --workspace
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vite build
```

Expected: all pass. Record the counts in the report.

- [ ] **Step 3: Commit and push**

```bash
git add docs/superpowers/reports
git commit -m "docs(report): record 3D rendering spike evidence"
git push -u origin spike/3d-rendering-architecture
```

- [ ] **Step 4: Post gate evidence to issue #23**

Comment with the gate table, the measured numbers, whether any documented flip (D3 → three.js) or falsifier triggered, and the branch URL. Close #23 only if gates 1–5 report measured evidence. Hand the frame-time, decode, memory, and pick-latency numbers to issue #26 as its input, and note whether gate 7 confirmed or reopened issue #31.

---

## Self-Review

**Spec coverage.** Gate 1 → Task 3 step 8. Gate 2 → Task 5 steps 1–2 (state save/restore, context loss) verified in Task 7 step 6.5. Gate 3 → Task 7 step 6.3–6.4. Gate 4 → Task 6 plus Task 7 step 6 pick readout. Gate 5 → Task 5 step 2 precision rule, verified Task 7 step 6.6. Gate 6 → Task 5 step 2 filtering rule, verified Task 7 step 6.7. Gate 7 → Task 8. Format from D4 → Tasks 1–3. Decode path from D2 → Task 4. Composition D5: geometry and icons are in scope; **DOM text labels are deliberately deferred** — label placement was already proven in the issue #32 prototype and adds nothing to these gates. Camera D7 → Task 7 step 2 (`maxPitch: 60`).

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Tasks 5, 7, and 8 specify behavior in prose plus exact interfaces and shader source rather than complete file listings, because their correctness is established by the measurement steps rather than by unit tests; every required behavior is enumerated as a checklist item.

**Type consistency.** `SceneView`/`SceneBatchView` (Task 4) are consumed unchanged by Task 5. `SurfacePick` is produced by Task 5 and consumed by Task 7. `JUNCTION_HIT_PX`/`PATH_HIT_PX` (Task 6) are asserted against `featureLayers.ts` values `10`/`12`. `SemanticRole` variants in Rust serialize as `Debug` strings (`"Walkable"`) and Task 4's `SemanticRoleName` union matches those exact spellings.
