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
    let mut entries = multi_floor_entries();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    write_zip_entries(&entries)
}

/// The same multi-floor fixture with the ZIP entries in reverse order — the
/// importer sorts entries, so both orders must compile byte-identically.
pub fn build_multi_floor_imdf_zip_reversed() -> Vec<u8> {
    let mut entries = multi_floor_entries();
    entries.reverse();
    write_zip_entries(&entries)
}

/// The multi-floor fixture's zip entries: manifest, venue, address, four
/// levels, three units (one with a source height, one stairs category), one
/// opening, and one standalone detail drawing.
fn multi_floor_entries() -> Vec<(&'static str, String)> {
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
    let unit = |id: &str, level_id: &str, ring: &str, extra: &str| {
        format!(
            r#"{{"id":"{id}","type":"Feature","feature_type":"unit","geometry":{{"type":"Polygon","coordinates":{ring}}},"properties":{{"category":"walkway","level_id":"{level_id}"{extra}}}}}"#
        )
    };
    let units = format!(
        r#"{{"type":"FeatureCollection","features":[
            {},
            {},
            {}
        ]}}"#,
        unit(
            "c1000001-0000-4000-8000-000000000001",
            "b1000003-0000-4000-8000-000000000003",
            "[[[139.7662,35.6806],[139.7678,35.6806],[139.7678,35.6810],[139.7662,35.6810],[139.7662,35.6806]]]",
            r#","height":3.5"#,
        ),
        unit(
            "c1000002-0000-4000-8000-000000000002",
            "b1000003-0000-4000-8000-000000000003",
            "[[[139.7662,35.6810],[139.7678,35.6810],[139.7678,35.6814],[139.7662,35.6814],[139.7662,35.6810]]]",
            "",
        ),
        unit(
            "c1000003-0000-4000-8000-000000000003",
            "b1000004-0000-4000-8000-000000000004",
            "[[[139.7662,35.6802],[139.7678,35.6802],[139.7678,35.6806],[139.7662,35.6806],[139.7662,35.6802]]]",
            r#","category":"stairs""#,
        ),
    );
    let openings = r#"{"type":"FeatureCollection","features":[
        {"id":"d1000001-0000-4000-8000-000000000001","type":"Feature","feature_type":"opening",
          "geometry":{"type":"LineString","coordinates":[[139.7670,35.6810],[139.7672,35.6810]]},
          "properties":{"category":"pedestrian.transit","level_id":"b1000003-0000-4000-8000-000000000003"}},
        {"id":"d1000002-0000-4000-8000-000000000002","type":"Feature","feature_type":"opening",
          "geometry":{"type":"LineString","coordinates":[[139.7672,35.6810],[139.7673,35.6810]]},
          "properties":{"category":"pedestrian.transit","level_id":"b1000003-0000-4000-8000-000000000003"}}
    ]}"#;
    let drawings = r#"{"type":"FeatureCollection","features":[
        {"id":"e1000001-0000-4000-8000-000000000001","type":"Feature","feature_type":"drawing",
          "geometry":{"type":"LineString","coordinates":[[139.7665,35.6808],[139.7675,35.6812]]},
          "properties":{"category":"detail","level_id":"b1000003-0000-4000-8000-000000000003"}}
    ]}"#;
    vec![
        ("manifest.json", manifest.to_string()),
        ("venue.geojson", venue),
        ("address.geojson", address),
        ("level.geojson", levels),
        ("unit.geojson", units),
        ("opening.geojson", openings.to_string()),
        ("drawing.geojson", drawings.to_string()),
    ]
}

/// Two walkways sharing a 10 m-class boundary, but only one unit splits that
/// edge with a mid-edge vertex. An opening that straddles the split must still
/// connect both surfaces.
pub fn build_split_shared_edge_opening_imdf_zip() -> Vec<u8> {
    let manifest = r#"{"version":"1.0.0","created":"2026-01-01T00:00:00Z","language":"en","generated_by":"kiriko-bundle-fixture","extensions":[]}"#;
    let venue = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000001-0000-4000-8000-000000000031",
            "venue",
            r#"{"category":"transit","name":{"en":"Split Edge Venue"},"address_id":"a1000002-0000-4000-8000-000000000032"}"#,
            Some(POLYGON),
        )
    );
    let address = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000002-0000-4000-8000-000000000032",
            "address",
            r#"{"address":"1 Split Way"}"#,
            None,
        )
    );
    let level_id = "b1000001-0000-4000-8000-000000000031";
    let levels = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            level_id,
            "level",
            r#"{"category":"unspecified","ordinal":0,"name":{"en":"F1"},"short_name":{"en":"F1"},"elevation":10.0}"#,
            Some(POLYGON),
        )
    );
    let units = format!(
        r#"{{"type":"FeatureCollection","features":[
            {{"id":"c1000001-0000-4000-8000-000000000031","type":"Feature","feature_type":"unit","geometry":{{"type":"Polygon","coordinates":[[[139.7662,35.6806],[139.7678,35.6806],[139.7678,35.6810],[139.7662,35.6810],[139.7662,35.6806]]]}},"properties":{{"category":"walkway","level_id":"{level_id}"}}}},
            {{"id":"c1000002-0000-4000-8000-000000000032","type":"Feature","feature_type":"unit","geometry":{{"type":"Polygon","coordinates":[[[139.7662,35.6810],[139.7670,35.6810],[139.7678,35.6810],[139.7678,35.6814],[139.7662,35.6814],[139.7662,35.6810]]]}},"properties":{{"category":"walkway","level_id":"{level_id}"}}}}
        ]}}"#
    );
    let openings = format!(
        r#"{{"type":"FeatureCollection","features":[
            {{"id":"d1000001-0000-4000-8000-000000000031","type":"Feature","feature_type":"opening","geometry":{{"type":"LineString","coordinates":[[139.7668,35.6810],[139.7672,35.6810]]}},"properties":{{"category":"pedestrian.transit","level_id":"{level_id}"}}}}
        ]}}"#
    );
    write_zip_entries(&[
        ("manifest.json", manifest.to_string()),
        ("venue.geojson", venue),
        ("address.geojson", address),
        ("level.geojson", levels),
        ("unit.geojson", units),
        ("opening.geojson", openings),
    ])
}

/// One F1 with a lone platform, plus F2 with a platform sharing an edge with a shop.
pub fn build_platform_wall_imdf_zip() -> Vec<u8> {
    let manifest = r#"{"version":"1.0.0","created":"2026-01-01T00:00:00Z","language":"en","generated_by":"kiriko-bundle-fixture","extensions":[]}"#;
    let venue = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000001-0000-4000-8000-000000000011",
            "venue",
            r#"{"category":"transit","name":{"en":"Platform Wall Venue"},"address_id":"a1000002-0000-4000-8000-000000000012"}"#,
            Some(POLYGON),
        )
    );
    let address = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000002-0000-4000-8000-000000000012",
            "address",
            r#"{"address":"1 Platform Way"}"#,
            None,
        )
    );
    let f1 = "b1000001-0000-4000-8000-000000000011";
    let f2 = "b1000002-0000-4000-8000-000000000012";
    let levels = format!(
        r#"{{"type":"FeatureCollection","features":[{},{}]}}"#,
        feature(
            f1,
            "level",
            r#"{"category":"unspecified","ordinal":0,"name":{"en":"F1"},"short_name":{"en":"F1"},"elevation":10.0}"#,
            Some(POLYGON),
        ),
        feature(
            f2,
            "level",
            r#"{"category":"unspecified","ordinal":1,"name":{"en":"F2"},"short_name":{"en":"F2"},"elevation":14.0}"#,
            Some(POLYGON),
        ),
    );
    let units = format!(
        r#"{{"type":"FeatureCollection","features":[
            {{"id":"c1000001-0000-4000-8000-000000000011","type":"Feature","feature_type":"unit","geometry":{{"type":"Polygon","coordinates":[[[139.7660,35.6800],[139.7680,35.6800],[139.7680,35.6810],[139.7660,35.6810],[139.7660,35.6800]]]}},"properties":{{"category":"platform","level_id":"{f1}"}}}},
            {{"id":"c1000002-0000-4000-8000-000000000012","type":"Feature","feature_type":"unit","geometry":{{"type":"Polygon","coordinates":[[[139.7660,35.6800],[139.7680,35.6800],[139.7680,35.6810],[139.7660,35.6810],[139.7660,35.6800]]]}},"properties":{{"category":"platform","level_id":"{f2}"}}}},
            {{"id":"c1000003-0000-4000-8000-000000000013","type":"Feature","feature_type":"unit","geometry":{{"type":"Polygon","coordinates":[[[139.7660,35.6810],[139.7680,35.6810],[139.7680,35.6820],[139.7660,35.6820],[139.7660,35.6810]]]}},"properties":{{"category":"shop","level_id":"{f2}"}}}}
        ]}}"#
    );
    let openings = format!(
        r#"{{"type":"FeatureCollection","features":[
            {{"id":"d1000001-0000-4000-8000-000000000011","type":"Feature","feature_type":"opening","geometry":{{"type":"LineString","coordinates":[[139.7668,35.6800],[139.7672,35.6800]]}},"properties":{{"category":"pedestrian.transit","level_id":"{f1}"}}}}
        ]}}"#
    );
    write_zip_entries(&[
        ("manifest.json", manifest.to_string()),
        ("venue.geojson", venue),
        ("address.geojson", address),
        ("level.geojson", levels),
        ("unit.geojson", units),
        ("opening.geojson", openings),
    ])
}

/// One F1 with a two-island MultiPolygon walkway (the shape 2D already draws).
pub fn build_multipolygon_unit_imdf_zip() -> Vec<u8> {
    let manifest = r#"{"version":"1.0.0","created":"2026-01-01T00:00:00Z","language":"en","generated_by":"kiriko-bundle-fixture","extensions":[]}"#;
    let venue = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000001-0000-4000-8000-000000000021",
            "venue",
            r#"{"category":"transit","name":{"en":"MultiPolygon Venue"},"address_id":"a1000002-0000-4000-8000-000000000022"}"#,
            Some(POLYGON),
        )
    );
    let address = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            "a1000002-0000-4000-8000-000000000022",
            "address",
            r#"{"address":"1 Multi Way"}"#,
            None,
        )
    );
    let level_id = "b1000001-0000-4000-8000-000000000021";
    let unit_id = "c1000001-0000-4000-8000-000000000021";
    let levels = format!(
        r#"{{"type":"FeatureCollection","features":[{}]}}"#,
        feature(
            level_id,
            "level",
            r#"{"category":"unspecified","ordinal":0,"name":{"en":"F1"},"short_name":{"en":"F1"},"elevation":10.0}"#,
            Some(
                r#"{"type":"MultiPolygon","coordinates":[[[[139.7660,35.6800],[139.7668,35.6800],[139.7668,35.6808],[139.7660,35.6808],[139.7660,35.6800]]],[[[139.7672,35.6812],[139.7680,35.6812],[139.7680,35.6820],[139.7672,35.6820],[139.7672,35.6812]]]]}"#
            ),
        )
    );
    let units = format!(
        r#"{{"type":"FeatureCollection","features":[{{"id":"{unit_id}","type":"Feature","feature_type":"unit","geometry":{{"type":"MultiPolygon","coordinates":[[[[139.7660,35.6800],[139.7668,35.6800],[139.7668,35.6808],[139.7660,35.6808],[139.7660,35.6800]]],[[[139.7673,35.6812],[139.7679,35.6812],[139.7679,35.6819],[139.7673,35.6819],[139.7673,35.6812]]]]}},"properties":{{"category":"walkway","level_id":"{level_id}"}}}}]}}"#
    );
    let openings = format!(
        r#"{{"type":"FeatureCollection","features":[
            {{"id":"d1000001-0000-4000-8000-000000000021","type":"Feature","feature_type":"opening","geometry":{{"type":"LineString","coordinates":[[139.7674,35.6812],[139.7676,35.6812]]}},"properties":{{"category":"pedestrian.transit","level_id":"{level_id}"}}}}
        ]}}"#
    );
    write_zip_entries(&[
        ("manifest.json", manifest.to_string()),
        ("venue.geojson", venue),
        ("address.geojson", address),
        ("level.geojson", levels),
        ("unit.geojson", units),
        ("opening.geojson", openings),
    ])
}

/// Writes `(name, content)` entries into a zip in the given order.
fn write_zip_entries(entries: &[(&str, String)]) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(&mut cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    for (name, content) in entries {
        writer.start_file(name, options).expect("start zip entry");
        writer
            .write_all(content.as_bytes())
            .expect("write zip entry");
    }
    writer.finish().expect("finish zip");
    cursor.into_inner()
}
