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
    let out_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../../tests/fixtures/{name}.kvb"));
    fs::write(&out_path, bytes).unwrap_or_else(|e| panic!("write {out_path:?}: {e}"));
    println!(
        "{}  tests/fixtures/{name}.kvb",
        hex_lower(&Sha256::digest(bytes))
    );
    eprintln!(
        "wrote {} bytes to {} ({note})",
        bytes.len(),
        out_path.display()
    );
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

/// Compresses `payload` with the crate's exact deterministic framing (level 9,
/// checksum, content size, single-threaded) so crafted bundles decode with
/// the same integrity checks as compiler-produced ones.
fn zstd_compress(payload: &[u8]) -> Vec<u8> {
    use zstd::stream::raw::{CParameter, Encoder as RawEncoder};

    let mut raw = RawEncoder::new(9).expect("zstd encoder init");
    raw.set_parameter(CParameter::ChecksumFlag(true))
        .expect("checksum flag");
    raw.set_parameter(CParameter::ContentSizeFlag(true))
        .expect("content-size flag");
    raw.set_parameter(CParameter::NbWorkers(0))
        .expect("single-threaded");
    raw.set_pledged_src_size(Some(payload.len() as u64))
        .expect("pledged size");

    let mut encoder = zstd::stream::write::Encoder::with_encoder(Vec::new(), raw);
    encoder.write_all(payload).expect("write payload");
    encoder.finish().expect("finish frame")
}

/// Wraps a raw uncompressed payload in a valid `kvb1` envelope (the same
/// layout `format.rs` documents): magic, major 1, minor 0, the zstd flag, the
/// declared length, the payload's sha256, and one deterministic zstd frame.
fn wrap_payload(payload: &[u8]) -> Vec<u8> {
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&Sha256::digest(payload));
    let compressed = zstd_compress(payload);
    let mut out = Vec::new();
    out.extend_from_slice(b"KVB\0");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&hash);
    out.extend_from_slice(&compressed);
    out
}

/// Decompresses a compiled bundle's payload, lets `mutate` rewrite the
/// `(id, version, bytes)` section list, rebuilds the directory (id-ascending)
/// and envelope, and writes the result as a committed fixture. Mirrors
/// `format.rs`'s `build_payload`/`encode_payload`.
fn craft_fixture(
    name: &str,
    base: &[u8],
    mutate: impl FnOnce(&mut Vec<(u16, u16, Vec<u8>)>),
    note: &str,
) {
    let declared_len = u64::from_le_bytes(base[12..20].try_into().unwrap());
    let payload = zstd::stream::decode_all(&base[52..]).expect("base payload decompresses");
    assert_eq!(payload.len() as u64, declared_len);

    let count = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let mut sections: Vec<(u16, u16, Vec<u8>)> = Vec::with_capacity(count);
    for i in 0..count {
        let row = 2 + i * 20;
        let id = u16::from_le_bytes([payload[row], payload[row + 1]]);
        let version = u16::from_le_bytes([payload[row + 2], payload[row + 3]]);
        let offset = u64::from_le_bytes(payload[row + 4..row + 12].try_into().unwrap()) as usize;
        let length = u64::from_le_bytes(payload[row + 12..row + 20].try_into().unwrap()) as usize;
        sections.push((id, version, payload[offset..offset + length].to_vec()));
    }
    mutate(&mut sections);
    sections.sort_by_key(|(id, _, _)| *id);

    let count = sections.len();
    let dir_len = 2 + count * 20;
    let mut rebuilt = Vec::new();
    rebuilt.extend_from_slice(&(count as u16).to_le_bytes());
    let mut cursor = dir_len as u64;
    for (id, version, bytes) in &sections {
        rebuilt.extend_from_slice(&id.to_le_bytes());
        rebuilt.extend_from_slice(&version.to_le_bytes());
        rebuilt.extend_from_slice(&cursor.to_le_bytes());
        rebuilt.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        cursor += bytes.len() as u64;
    }
    for (_, _, bytes) in &sections {
        rebuilt.extend_from_slice(bytes);
    }
    write_fixture(name, &wrap_payload(&rebuilt), note);
}

fn main() {
    let source = build_minimal_imdf_zip();
    let metadata = BundleMetadata {
        dataset_id: "minimal".to_string(),
        version: 1,
    };
    let compiled = compile_imdf(&source, metadata.clone()).expect("minimal fixture must compile");
    write_fixture(
        "minimal",
        &compiled.bytes,
        &format!(
            "levels={}, features={}",
            compiled.stats.levels, compiled.stats.features
        ),
    );

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
        None,
    )
    .expect("stage0 fixture must compile");
    write_fixture(
        "stage0",
        &stage0.bytes,
        "network + facilities + spatial context",
    );

    // One crafted bundle per remaining capability outcome, frozen as bytes so
    // the cross-adapter parity test can feed identical bytes to both adapters.
    craft_fixture(
        "stage0-unsupported",
        &stage0.bytes,
        |sections| {
            for (id, version, _) in sections.iter_mut() {
                if *id == 8 {
                    *version = 2;
                }
            }
        },
        "§8 at an unreadable version",
    );
    craft_fixture(
        "stage0-invalid",
        &stage0.bytes,
        |sections| {
            for (id, _, bytes) in sections.iter_mut() {
                if *id == 8 {
                    *bytes = vec![0x00, 0xFF, 0x7F];
                }
            }
        },
        "§8 with garbage bytes",
    );
    craft_fixture(
        "stage0-disabled",
        &stage0.bytes,
        |sections| {
            for (id, version, _) in sections.iter_mut() {
                if *id == 8 {
                    *version = 2;
                }
            }
            // The stage0 bundle now carries a real §9; its bytes are never
            // interpreted while its required §8 is unavailable.
            for (id, _, bytes) in sections.iter_mut() {
                if *id == 9 {
                    *bytes = vec![0xDE, 0xAD, 0xBE];
                }
            }
        },
        "§8 unavailable + real §9 present",
    );
}
