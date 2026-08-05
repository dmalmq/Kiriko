//! Builds raw IMDF ZIP bytes from `tests/fixtures/minimal-imdf/` for the
//! kiriko-bundle integration tests, in either the default (bytewise
//! ascending) root-filename order or reversed order. `kiriko-model` sorts
//! entries before validation/import, so both orders must produce an
//! identical canonical model -- and therefore an identical bundle.

#![allow(dead_code)]

use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Path to the shared cross-language IMDF fixture directory.
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/minimal-imdf")
}

fn root_entry_names() -> Vec<String> {
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
    names
}

fn write_zip_in_order(order: &[String]) -> Vec<u8> {
    let dir = fixtures_dir();
    let mut cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(&mut cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    for name in order {
        let data = fs::read(dir.join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
        writer.start_file(name, options).expect("start zip entry");
        writer.write_all(&data).expect("write zip entry");
    }
    writer.finish().expect("finish zip");
    cursor.into_inner()
}

/// The minimal fixture ZIP with root entries in bytewise-ascending filename
/// order (the same canonical order `kiriko-model`'s own tests use).
pub fn build_minimal_imdf_zip() -> Vec<u8> {
    write_zip_in_order(&root_entry_names())
}

/// The same fixture files written in reverse bytewise filename order.
pub fn build_minimal_imdf_zip_reversed() -> Vec<u8> {
    let mut order = root_entry_names();
    order.reverse();
    write_zip_in_order(&order)
}

const POLYGON: &str = r#"{"type":"Polygon","coordinates":[[[139.7660,35.6800],[139.7680,35.6800],[139.7680,35.6820],[139.7660,35.6820],[139.7660,35.6800]]]}"#;

fn feature(id: &str, feature_type: &str, properties: &str, geometry: Option<&str>) -> String {
    format!(
        r#"{{"id":"{id}","type":"Feature","feature_type":"{feature_type}","geometry":{geometry},"properties":{properties}}}"#,
        geometry = geometry.unwrap_or("null")
    )
}

/// An in-memory multi-floor IMDF zip exercising every floor-plane resolution
/// branch: `L1` and `B1` carry an explicit `elevation` property, `L2`/`L3`
/// carry none (the network and nominal branches supply those).
pub fn build_multi_floor_imdf_zip() -> Vec<u8> {
    let manifest = r#"{"version":"1.0.0","created":"2026-01-01T00:00:00Z","language":"en","generated_by":"kiriko-bundle-fixture","extensions":[]}"#;
    let venue = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000001-0000-4000-8000-000000000001",
            "venue",
            r#"{"category":"transit","name":{"en":"Multi Floor Venue"},"address_id":"a1000002-0000-4000-8000-000000000002"}"#,
            Some(POLYGON),
        )
    );
    let address = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000002-0000-4000-8000-000000000002",
            "address",
            r#"{"address":"1 Test Way"}"#,
            None,
        )
    );
    let level = |id: &str, name: &str, ordinal: i64, elevation: Option<f64>| {
        let mut properties = format!(
            r#"{{"category":"unspecified","ordinal":{ordinal},"name":{{"en":"{name}"}},"short_name":{{"en":"{name}"}}}}"#
        );
        if let Some(elevation) = elevation {
            // Trim the closing brace, insert the elevation field, re-close.
            properties.pop();
            properties.push_str(&format!(r#","elevation":{elevation}}}"#));
        }
        feature(id, "level", &properties, Some(POLYGON))
    };
    let levels = format!(
        r#"{{"type":"FeatureCollection","features":[{},{},{},{}]}}"#,
        level("b1000001-0000-4000-8000-000000000001", "F3", 2, None),
        level("b1000002-0000-4000-8000-000000000002", "F2", 1, None),
        level("b1000003-0000-4000-8000-000000000003", "F1", 0, Some(10.0)),
        level("b1000004-0000-4000-8000-000000000004", "B1", -1, Some(6.0)),
    );

    let entries: &[(&str, String)] = &[
        ("manifest.json", manifest.to_string()),
        ("venue.geojson", venue),
        ("address.geojson", address),
        ("level.geojson", levels),
    ];

    let mut cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(&mut cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    for (name, content) in entries {
        writer
            .start_file(*name, options)
            .expect("start zip entry");
        writer
            .write_all(content.as_bytes())
            .expect("write zip entry");
    }
    writer.finish().expect("finish zip");
    cursor.into_inner()
}
