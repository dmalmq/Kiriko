//! Compiles `tests/fixtures/minimal-imdf/` into the committed golden bundle
//! `tests/fixtures/minimal.kvb` and prints its lowercase SHA-256 hex digest.
//!
//! Run once per Task 3 Step 5:
//!
//! ```bash
//! cargo run --manifest-path core/Cargo.toml -p kiriko-bundle --example compile_fixture
//! ```
//!
//! then write `<printed hash>  tests/fixtures/minimal.kvb\n` to
//! `tests/fixtures/minimal.kvb.sha256` and commit both files. Any later
//! byte change to the golden bundle requires rerunning this example and
//! reviewing the diff.

use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;

use kiriko_bundle::{BundleMetadata, compile_imdf, compile_imdf_with_network};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/minimal-imdf")
}

/// Bytewise-ascending root filename order, matching `kiriko-model`'s own
/// deterministic fixture builder. Order does not affect the compiled bytes
/// (`kiriko-model` sorts entries before import), but the golden bundle is
/// still generated deterministically for reviewability.
fn build_minimal_imdf_zip() -> Vec<u8> {
    let dir = fixtures_dir();
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read fixtures dir {dir:?}: {e}"))
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_string_lossy().into_owned();
            if name.starts_with('.') {
                None
            } else {
                Some(name)
            }
        })
        .collect();
    names.sort();

    let mut cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(&mut cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    for name in &names {
        let data = fs::read(dir.join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
        writer.start_file(name, options).expect("start zip entry");
        writer.write_all(&data).expect("write zip entry");
    }
    writer.finish().expect("finish zip");
    cursor.into_inner()
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes `bytes` to `tests/fixtures/<name>.kvb` and prints its sha256 line
/// (to be written into `<name>.kvb.sha256`).
fn write_fixture(name: &str, bytes: &[u8], note: &str) {
    let out_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../tests/fixtures/{name}.kvb"));
    fs::write(&out_path, bytes).unwrap_or_else(|e| panic!("write {out_path:?}: {e}"));
    println!(
        "{}  tests/fixtures/{name}.kvb",
        hex_lower(&Sha256::digest(bytes))
    );
    eprintln!("wrote {} bytes to {} ({note})", bytes.len(), out_path.display());
}

/// The Stage 0 fixture's routing network and point facilities — the same
/// values the bundle integration tests use (`NETWORK_JUNCTIONS`/`NETWORK_PATHS`/
/// `FACILITIES` in `tests/bundle.rs`), inlined because an example cannot
/// import test code.
const STAGE0_JUNCTIONS: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
  {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
  {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F2"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}}]}"#;
const STAGE0_PATHS: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}},
  {"type":"Feature","properties":{"FNODEID":2,"TNODEID":3,"cost":5000},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.001,35.0]]]}},
  {"type":"Feature","properties":{"FNODEID":2,"TNODEID":99,"cost":10},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.002,35.0]]]}}]}"#;
const STAGE0_FACILITIES: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"name":"Store A","floor":"F1","image":"/marker/ticket.png"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
  {"type":"Feature","properties":{"name":"Store B","floor":"F2","image":""},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
  {"type":"Feature","properties":{"name":"Bad","floor":"garbage","image":""},"geometry":{"type":"Point","coordinates":[139.0,35.0]}}]}"#;

fn main() {
    let source = build_minimal_imdf_zip();
    let metadata = BundleMetadata {
        dataset_id: "minimal".to_string(),
        version: 1,
    };
    let compiled = compile_imdf(&source, metadata.clone()).expect("minimal fixture must compile");
    write_fixture("minimal", &compiled.bytes, &format!("levels={}, features={}", compiled.stats.levels, compiled.stats.features));

    // Stage 0's final-shape fixture: required sections + routing graph +
    // point facilities + spatial context, cut once against the final schema.
    let stage0 = compile_imdf_with_network(
        &source,
        metadata,
        Some(STAGE0_JUNCTIONS),
        Some(STAGE0_PATHS),
        Some(STAGE0_FACILITIES),
        false,
        false,
        None,
        &[],
    )
    .expect("stage0 fixture must compile");
    write_fixture("stage0", &stage0.bytes, "network + facilities + spatial context");
}
