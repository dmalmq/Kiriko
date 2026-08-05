//! Gate 1 measurement: derive a tileset directory and report the numbers.
//!
//! Run: cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene \
//!        --example derive_tiles -- "C:/cesium/tokyo 3dtiles" target/spike/tokyo
use std::{collections::BTreeMap, env, fs, path::PathBuf, time::Instant};

use kiriko_scene::{SemanticRole, derive_scene_with_report, encode_scene};
use sha2::{Digest, Sha256};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let input = PathBuf::from(
        args.next()
            .expect("usage: derive_tiles <tileset dir> <out prefix>"),
    );
    let out_prefix = PathBuf::from(
        args.next()
            .expect("usage: derive_tiles <tileset dir> <out prefix>"),
    );

    let tileset: serde_json::Value =
        serde_json::from_slice(&fs::read(input.join("tileset.json"))?)?;
    let transform_values = tileset["root"]["transform"]
        .as_array()
        .expect("tileset root transform");
    let mut world_transform = [0.0_f64; 16];
    for (index, value) in transform_values.iter().enumerate() {
        world_transform[index] = value.as_f64().expect("transform component");
    }
    let content_uri = tileset["root"]["content"]["uri"]
        .as_str()
        .unwrap_or("content.glb");

    let glb = fs::read(input.join(content_uri))?;
    let levels_json = fs::read(input.join("levels.json"))?;
    let source_hash = format!("sha256:{:x}", Sha256::digest(&glb));

    let derive_start = Instant::now();
    let report = derive_scene_with_report(&glb, &levels_json, &source_hash, world_transform)?;
    let document = &report.document;
    let derive_ms = derive_start.elapsed().as_millis();

    let encode_start = Instant::now();
    let bytes = encode_scene(document)?;
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
    let vertices: usize = document
        .batches
        .iter()
        .map(|b| b.vertex_count as usize)
        .sum();
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
        "gatheredPrimitives": report.gathered_primitives,
        "unmappedRoleBatches": document.batches.iter()
            .filter(|b| b.role == SemanticRole::Context).count(),
    });
    let stats_path = out_prefix.with_extension("stats.json");
    fs::write(&stats_path, serde_json::to_vec_pretty(&stats)?)?;
    println!("{}", serde_json::to_string_pretty(&stats)?);
    Ok(())
}
