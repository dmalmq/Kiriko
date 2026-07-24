//! `kvb1` bundle codec: envelope/directory byte-layout tests, determinism,
//! the corruption matrix, and the committed golden fixture.

mod support;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use kiriko_bundle::{
    BundleDocument, BundleErrorCode, BundleMetadata, BundleStats, CompileError, compile_imdf,
    compile_imdf_with_network, decode_bundle, encode_bundle, export_network, inspect_bundle,
};

fn metadata() -> BundleMetadata {
    BundleMetadata {
        dataset_id: "test-bundle".to_string(),
        version: 1,
    }
}

fn compile_minimal() -> Vec<u8> {
    let source = support::build_minimal_imdf_zip();
    compile_imdf(&source, metadata())
        .expect("minimal fixture must compile")
        .bytes
}

fn decompress_payload(bytes: &[u8]) -> Vec<u8> {
    let declared_len = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
    let frame = &bytes[52..];
    let payload = zstd::decode_all(frame)
        .expect("a valid frame must decompress with the crate's own decoder");
    assert_eq!(
        payload.len() as u64,
        declared_len,
        "declared length must match the frame's content"
    );
    payload
}

// -- Network graph embedding (kiriko-route-slice Task 3) -------------------

// Task 1 (kiriko-route) GeoJSON constants: three junctions (two on F1, one
// on F2 — ordinals 0 and 1, both present in the minimal fixture) and three
// paths, one of which dangles to the missing NODEID 99.
const NETWORK_JUNCTIONS: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
  {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
  {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F2"},"geometry":{"type":"Point","coordinates":[139.001,35.0]}}]}"#;
const NETWORK_PATHS: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.0,35.0],[139.001,35.0]]]}},
  {"type":"Feature","properties":{"FNODEID":2,"TNODEID":3,"cost":5000},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.001,35.0]]]}},
  {"type":"Feature","properties":{"FNODEID":2,"TNODEID":99,"cost":10},"geometry":{"type":"MultiLineString","coordinates":[[[139.001,35.0],[139.002,35.0]]]}}]}"#;

#[test]
fn compile_with_network_embeds_graph_section() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(
        &source,
        metadata(),
        Some(NETWORK_JUNCTIONS),
        Some(NETWORK_PATHS),
        None,
        false,
    )
    .expect("fixture + network compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");

    let graph = document.graph.expect("network must embed a graph section");
    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.edges.len(), 2, "the dangling edge must be dropped");
    assert!(
        compiled
            .warnings
            .iter()
            .any(|w| w.code.as_str() == "route_build" && w.message.contains("dangling_edge")),
        "build warnings must fold into the compile warning channel"
    );
}

#[test]
fn compile_without_network_has_no_graph() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf(&source, metadata()).expect("fixture compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");
    assert!(document.graph.is_none());
}

#[test]
fn compile_with_malformed_network_is_a_route_error() {
    let source = support::build_minimal_imdf_zip();
    let err = compile_imdf_with_network(
        &source,
        metadata(),
        Some("not geojson"),
        Some(NETWORK_PATHS),
        None,
        false,
    )
    .expect_err("malformed network GeoJSON must fail the compile");
    assert_eq!(err.code_str(), "route_build_failed");
    assert!(matches!(err, CompileError::Route(_)));
}

#[test]
fn compile_with_synthesize_network_derives_a_graph_from_venue_geometry() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(&source, metadata(), None, None, None, true)
        .expect("fixture compiles with synthesis");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");
    let graph = document
        .graph
        .expect("synthesis must embed a graph section from the venue's own geometry");
    assert!(!graph.nodes.is_empty(), "synthesized graph has nodes");
    assert!(!graph.edges.is_empty(), "synthesized graph has edges");
}

#[test]
fn compile_with_synthesis_disabled_and_no_network_has_no_graph() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(&source, metadata(), None, None, None, false)
        .expect("fixture compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");
    assert!(document.graph.is_none());
}

// -- Facilities embedding (point-facility-poi Task 4) ----------------------

// One facility on F1 (icon derived from `image`), one on F2, and one on an
// unmappable floor that must be dropped with a `facility_build` warning. F1 and
// F2 both carry network nodes, so each mapped facility anchors to its OWN
// position (the router snaps to the nearest node at query time).
const FACILITIES: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"name":"Store A","floor":"F1","image":"/marker/ticket.png"},"geometry":{"type":"Point","coordinates":[139.0,35.0]}},
  {"type":"Feature","properties":{"name":"Store B","floor":"F2","image":""},"geometry":{"type":"Point","coordinates":[139.001,35.0]}},
  {"type":"Feature","properties":{"name":"Bad","floor":"garbage","image":""},"geometry":{"type":"Point","coordinates":[139.0,35.0]}}]}"#;

#[test]
fn compile_with_facilities_embeds_facilities_section() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(
        &source,
        metadata(),
        Some(NETWORK_JUNCTIONS),
        Some(NETWORK_PATHS),
        Some(FACILITIES),
        false,
    )
    .expect("fixture + network + facilities compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");

    let facilities = document
        .facilities
        .expect("facilities GeoJSON must embed a facilities section");
    assert_eq!(facilities.items.len(), 2, "the bad-floor facility drops");
    let store_a = facilities
        .items
        .iter()
        .find(|f| f.name == "Store A")
        .expect("Store A must be present");
    assert_eq!(store_a.icon, "ticket");
    assert_eq!(
        store_a.anchor,
        Some(kiriko_facilities::FacilityAnchor {
            lon: 139.0,
            lat: 35.0,
            ordinal: 0.0,
        }),
        "F1 carries network, so Store A anchors to its own position"
    );
    let store_b = facilities
        .items
        .iter()
        .find(|f| f.name == "Store B")
        .expect("Store B must be present");
    assert_eq!(
        store_b.anchor,
        Some(kiriko_facilities::FacilityAnchor {
            lon: 139.001,
            lat: 35.0,
            ordinal: 1.0,
        }),
        "F2 carries a network node, so Store B anchors to its own position"
    );
    assert!(
        compiled
            .warnings
            .iter()
            .any(|w| w.code.as_str() == "facility_build" && w.message.contains("unmapped_floor")),
        "facility build warnings must fold into the compile warning channel"
    );
}

#[test]
fn compile_without_facilities_has_no_facilities_section() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(
        &source,
        metadata(),
        Some(NETWORK_JUNCTIONS),
        Some(NETWORK_PATHS),
        None,
        false,
    )
    .expect("fixture + network compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");
    assert!(document.facilities.is_none());
    assert!(
        !compiled
            .warnings
            .iter()
            .any(|w| w.code.as_str() == "facility_build"),
        "no facilities input must produce no facility warnings"
    );
}

#[test]
fn compile_with_facilities_but_no_network_warns_once_and_leaves_anchors_unset() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(&source, metadata(), None, None, Some(FACILITIES), false)
        .expect("fixture + facilities compiles without a network");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");

    let facilities = document
        .facilities
        .expect("facilities must embed even without a graph");
    let store_a = facilities
        .items
        .iter()
        .find(|f| f.name == "Store A")
        .expect("Store A must be present");
    assert_eq!(store_a.anchor, None, "no graph means no resolved anchor");
    let no_graph_warnings: Vec<_> = compiled
        .warnings
        .iter()
        .filter(|w| w.code.as_str() == "facility_build" && w.message.contains("no route graph"))
        .collect();
    assert_eq!(
        no_graph_warnings.len(),
        1,
        "the missing-graph warning fires exactly once"
    );
}

#[test]
fn compile_with_malformed_facilities_is_a_facility_error() {
    let source = support::build_minimal_imdf_zip();
    let err = compile_imdf_with_network(&source, metadata(), None, None, Some("not geojson"), false)
        .expect_err("malformed facilities GeoJSON must fail the compile");
    assert_eq!(err.code_str(), "facility_build_failed");
    assert!(matches!(err, CompileError::Facility(_)));
}

// -- Step 1: format byte-layout tests -------------------------------------

#[test]
fn envelope_matches_documented_byte_layout() {
    let bytes = compile_minimal();
    assert!(
        bytes.len() > 52,
        "an envelope plus a zstd frame must be produced"
    );
    assert_eq!(&bytes[0..4], b"KVB\0", "magic");
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 1, "major");
    assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 0, "minor");
    let flags = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    assert_eq!(flags & 1, 1, "bit 0 must indicate zstd");
    let uncompressed_len = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
    assert!(uncompressed_len > 0);
    assert_eq!(bytes[20..52].len(), 32, "sha-256 occupies exactly 32 bytes");
}

#[test]
fn directory_is_sorted_fixed_width_and_required_sections_only() {
    let bytes = compile_minimal();
    let payload = decompress_payload(&bytes);

    let count = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    assert_eq!(
        count, 3,
        "Phase Two emits exactly manifest, geometry, and stores"
    );

    let mut ids = Vec::new();
    let mut cursor = 2 + count * 20;
    for i in 0..count {
        let base = 2 + i * 20;
        let id = u16::from_le_bytes([payload[base], payload[base + 1]]);
        let version = u16::from_le_bytes([payload[base + 2], payload[base + 3]]);
        let offset = u64::from_le_bytes(payload[base + 4..base + 12].try_into().unwrap());
        let length = u64::from_le_bytes(payload[base + 12..base + 20].try_into().unwrap());

        assert_eq!(version, 1, "section {id} must declare version 1");
        assert_eq!(
            offset, cursor as u64,
            "sections must be packed contiguously in id order"
        );
        cursor += length as usize;
        ids.push(id);
    }
    assert_eq!(
        ids,
        vec![1, 2, 3],
        "only manifest(1), geometry(2), and stores(3) are emitted"
    );
    assert_eq!(
        cursor,
        payload.len(),
        "sections must fill the payload with no trailing bytes"
    );
}

// -- Step 2/3: section round trip and determinism --------------------------

#[test]
fn decode_roundtrip_preserves_every_feature_field_and_warning() {
    let source = support::build_minimal_imdf_zip();
    let venue = kiriko_model::import_imdf(&source).expect("fixture imports");
    let compiled = compile_imdf(&source, metadata()).expect("fixture compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");

    assert_eq!(document.venue_id, venue.venue_id);
    assert_eq!(document.manifest, venue.manifest);
    assert_eq!(document.levels, venue.levels);
    assert_eq!(
        document.features, venue.features,
        "every normalized feature field must round-trip"
    );
    assert_eq!(document.bounds_by_level, venue.bounds_by_level);
    assert_eq!(
        document.warnings, venue.warnings,
        "every warning must round-trip"
    );
    assert_eq!(document.stats.levels as usize, venue.levels.len());
    assert_eq!(document.stats.features as usize, venue.features.len());
    assert_eq!(document.metadata, metadata());
}

#[test]
fn compiling_the_same_fixture_twice_is_byte_identical() {
    let source = support::build_minimal_imdf_zip();
    let first = compile_imdf(&source, metadata()).expect("first compile");
    let second = compile_imdf(&source, metadata()).expect("second compile");
    assert_eq!(first.bytes, second.bytes);
}

#[test]
fn reversed_zip_record_order_is_byte_identical() {
    let forward = support::build_minimal_imdf_zip();
    let reversed = support::build_minimal_imdf_zip_reversed();
    assert_ne!(
        forward, reversed,
        "the two archives must actually differ in ZIP record order"
    );

    let a = compile_imdf(&forward, metadata()).expect("forward order compiles");
    let b = compile_imdf(&reversed, metadata()).expect("reversed order compiles");
    assert_eq!(
        a.bytes, b.bytes,
        "record order must not affect the compiled bundle bytes"
    );
}

// -- Step 4: corruption matrix ---------------------------------------------

#[test]
fn corrupted_magic_is_invalid_bundle() {
    let mut bytes = compile_minimal();
    bytes[0] ^= 0xFF;
    let err = decode_bundle(&bytes).expect_err("corrupted magic must fail");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn unsupported_major_is_rejected_before_section_interpretation() {
    let mut bytes = compile_minimal();
    bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
    // Also corrupt the last frame byte: if major were (incorrectly) checked
    // after section interpretation, this would instead surface
    // bundle_integrity_failed, proving major-version precedence.
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    let err = decode_bundle(&bytes).expect_err("unsupported major must fail");
    assert_eq!(err.code, BundleErrorCode::UnsupportedBundleVersion);
}

#[test]
fn zero_major_is_rejected() {
    let mut bytes = compile_minimal();
    bytes[4..6].copy_from_slice(&0u16.to_le_bytes());
    let err = decode_bundle(&bytes).expect_err("major 0 must fail");
    assert_eq!(err.code, BundleErrorCode::UnsupportedBundleVersion);
}

#[test]
fn newer_minor_version_is_tolerated() {
    let mut bytes = compile_minimal();
    bytes[6..8].copy_from_slice(&9999u16.to_le_bytes());
    let document = decode_bundle(&bytes)
        .expect("a newer minor with understood required sections must still decode");
    assert!(!document.venue_id.is_empty());
}

#[test]
fn cleared_zstd_flag_is_invalid_bundle() {
    let mut bytes = compile_minimal();
    bytes[8] &= 0xFE;
    let err = decode_bundle(&bytes).expect_err("clearing the zstd flag must fail");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn declared_length_mismatch_is_integrity_failure() {
    let mut bytes = compile_minimal();
    let original = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
    bytes[12..20].copy_from_slice(&(original + 1).to_le_bytes());
    let err = decode_bundle(&bytes).expect_err("a lying declared length must fail");
    assert_eq!(err.code, BundleErrorCode::BundleIntegrityFailed);
}

#[test]
fn declared_length_above_512_mib_is_bundle_too_large() {
    let mut bytes = compile_minimal();
    bytes[12..20].copy_from_slice(&(512u64 * 1024 * 1024 + 1).to_le_bytes());
    let err = decode_bundle(&bytes)
        .expect_err("a declared length above 512 MiB must fail before allocation");
    assert_eq!(err.code, BundleErrorCode::BundleTooLarge);
}

#[test]
fn corrupted_hash_is_integrity_failure() {
    let mut bytes = compile_minimal();
    bytes[20] ^= 0xFF;
    let err = decode_bundle(&bytes).expect_err("a corrupted hash must fail");
    assert_eq!(err.code, BundleErrorCode::BundleIntegrityFailed);
}

#[test]
fn truncated_envelope_is_invalid_bundle() {
    let bytes = compile_minimal();
    let err = decode_bundle(&bytes[..10]).expect_err("a truncated envelope must fail");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn envelope_with_no_frame_data_is_integrity_failure() {
    let bytes = compile_minimal();
    let err = decode_bundle(&bytes[..52]).expect_err("an envelope with no frame bytes must fail");
    assert_eq!(err.code, BundleErrorCode::BundleIntegrityFailed);
}

#[test]
fn corrupted_frame_byte_is_integrity_failure() {
    let mut bytes = compile_minimal();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    let err = decode_bundle(&bytes).expect_err("a corrupted zstd frame byte must fail");
    assert_eq!(err.code, BundleErrorCode::BundleIntegrityFailed);
}

fn zstd_frame_bytes(payload: &[u8]) -> Vec<u8> {
    let mut raw = zstd::stream::raw::Encoder::new(9).expect("zstd encoder init");
    raw.set_parameter(zstd::stream::raw::CParameter::ChecksumFlag(true))
        .expect("checksum flag");
    raw.set_parameter(zstd::stream::raw::CParameter::ContentSizeFlag(true))
        .expect("content-size flag");
    raw.set_pledged_src_size(Some(payload.len() as u64))
        .expect("pledged size");
    let mut encoder = zstd::stream::write::Encoder::with_encoder(Vec::new(), raw);
    encoder.write_all(payload).expect("write payload");
    encoder.finish().expect("finish frame")
}

/// Hand-wraps a raw uncompressed payload into a valid `kvb1` envelope so a
/// malformed section directory can be exercised through the public
/// `decode_bundle` API (payload-level directory corruption is covered
/// exhaustively by `format`'s own unit tests; this proves the end-to-end
/// wiring surfaces the same stable code through the public API).
fn wrap_payload_for_test(payload: &[u8]) -> Vec<u8> {
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&Sha256::digest(payload));
    let mut out = Vec::new();
    out.extend_from_slice(b"KVB\0");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&hash);
    out.extend_from_slice(&zstd_frame_bytes(payload));
    out
}

fn directory_row(id: u16, version: u16, offset: u64, length: u64) -> Vec<u8> {
    let mut row = Vec::with_capacity(20);
    row.extend_from_slice(&id.to_le_bytes());
    row.extend_from_slice(&version.to_le_bytes());
    row.extend_from_slice(&offset.to_le_bytes());
    row.extend_from_slice(&length.to_le_bytes());
    row
}

#[test]
fn decode_bundle_rejects_a_missing_required_section_via_the_public_api() {
    // Only manifest + geometry; stores (id 3) is missing entirely.
    let dir_len: u64 = 2 + 2 * 20;
    let mut payload = Vec::new();
    payload.extend_from_slice(&2u16.to_le_bytes());
    payload.extend_from_slice(&directory_row(1, 1, dir_len, 0));
    payload.extend_from_slice(&directory_row(2, 1, dir_len, 0));

    let bundle = wrap_payload_for_test(&payload);
    let err = decode_bundle(&bundle).expect_err("a missing required section must fail");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn decode_bundle_rejects_a_concatenated_second_zstd_frame() {
    // A legitimate single-frame bundle's uncompressed payload, obtained by
    // decompressing an already-valid encoded bundle.
    let valid = compile_minimal();
    let payload = decompress_payload(&valid);

    // A well-formed envelope + first frame (hash and declared length both
    // match `payload` exactly), with a second, independently valid frame
    // for the very same payload appended after it.
    let mut bytes = wrap_payload_for_test(&payload);
    bytes.extend_from_slice(&zstd_frame_bytes(&payload));

    let err = decode_bundle(&bytes).expect_err("a concatenated second zstd frame must be rejected");
    assert_eq!(
        err.code,
        BundleErrorCode::BundleIntegrityFailed,
        "trailing frame data after a complete, hash-matching first frame is treated as a corrupted/tampered \
         frame (bundle_integrity_failed), not a structural directory problem (invalid_bundle)"
    );
}

fn minimal_feature(
    id: &str,
    feature_type: kiriko_model::model::FeatureType,
) -> kiriko_model::model::VenueFeature {
    kiriko_model::model::VenueFeature {
        id: id.to_string(),
        feature_type,
        level_id: None,
        geometry: None,
        center: None,
        labels: BTreeMap::new(),
        alt_labels: BTreeMap::new(),
        category: None,
        accessibility: Vec::new(),
        restriction: None,
        source_properties: BTreeMap::new(),
    }
}

fn minimal_document(features: Vec<kiriko_model::model::VenueFeature>) -> BundleDocument {
    BundleDocument {
        metadata: metadata(),
        manifest: kiriko_model::model::ImdfManifest {
            version: "1.0.0".to_string(),
            language: "en".to_string(),
            rest: BTreeMap::new(),
        },
        venue_id: "venue-1".to_string(),
        levels: Vec::new(),
        features,
        bounds_by_level: BTreeMap::new(),
        warnings: Vec::new(),
        stats: BundleStats {
            levels: 0,
            features: 0,
        },
        graph: None,
        facilities: None,
    }
}

#[test]
fn decode_bundle_rejects_misordered_geometry_features_via_the_public_api() {
    use kiriko_model::model::FeatureType;
    // `split_features` only filters by occupant/non-occupant membership; it
    // does not re-sort. A document whose non-occupant features are already
    // out of canonical feature-type order (Venue, order 15, before Address,
    // order 0) therefore encodes exactly as given, and must be rejected on
    // decode.
    let document = minimal_document(vec![
        minimal_feature("f1", FeatureType::Venue),
        minimal_feature("f2", FeatureType::Address),
    ]);
    let bytes =
        encode_bundle(&document).expect("encode does not itself validate feature-type order");
    let err = decode_bundle(&bytes).expect_err("misordered geometry features must be rejected");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn decode_bundle_rejects_a_duplicate_feature_id_across_sections_via_the_public_api() {
    use kiriko_model::model::FeatureType;
    // Address (non-occupant) lands in geometry, Occupant lands in stores;
    // both legitimately carry the same id through `split_features`, so this
    // is a cross-section duplicate producible via the public encode API.
    let document = minimal_document(vec![
        minimal_feature("dup", FeatureType::Address),
        minimal_feature("dup", FeatureType::Occupant),
    ]);
    let bytes = encode_bundle(&document)
        .expect("encode does not itself validate cross-section id uniqueness");
    let err =
        decode_bundle(&bytes).expect_err("a duplicate feature id across sections must be rejected");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn encode_bundle_normalizes_negative_zero_to_identical_bytes() {
    let with_negative_zero = minimal_document(vec![]);
    let mut with_negative_zero = with_negative_zero;
    with_negative_zero
        .levels
        .push(kiriko_model::model::ViewerLevel {
            id: "level-1".to_string(),
            ordinal: -0.0,
            label: BTreeMap::new(),
            short_name: BTreeMap::new(),
        });

    let mut with_positive_zero = minimal_document(vec![]);
    with_positive_zero
        .levels
        .push(kiriko_model::model::ViewerLevel {
            id: "level-1".to_string(),
            ordinal: 0.0,
            label: BTreeMap::new(),
            short_name: BTreeMap::new(),
        });

    let negative_bytes = encode_bundle(&with_negative_zero).expect("encodes");
    let positive_bytes = encode_bundle(&with_positive_zero).expect("encodes");
    assert_eq!(
        negative_bytes, positive_bytes,
        "documents differing only by -0.0 vs 0.0 must encode to identical bytes"
    );
}

// -- Step 5: golden fixture -------------------------------------------------

#[test]
fn golden_fixture_matches_committed_bytes_and_checksum() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let committed = fs::read(repo_root.join("tests/fixtures/minimal.kvb")).expect(
        "tests/fixtures/minimal.kvb must be committed (run `cargo run -p kiriko-bundle --example compile_fixture`)",
    );
    let checksum_file = fs::read_to_string(repo_root.join("tests/fixtures/minimal.kvb.sha256"))
        .expect("tests/fixtures/minimal.kvb.sha256 must be committed");

    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf(
        &source,
        BundleMetadata {
            dataset_id: "minimal".to_string(),
            version: 1,
        },
    )
    .expect("minimal fixture must compile");

    assert_eq!(
        compiled.bytes, committed,
        "compiling tests/fixtures/minimal-imdf/ must reproduce the committed golden bytes exactly"
    );

    let mut digest = [0u8; 32];
    digest.copy_from_slice(&Sha256::digest(&compiled.bytes));
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    // Parse the `<sha256>  <path>` line independent of the trailing line ending
    // (LF vs CRLF varies by platform and git checkout) without weakening the
    // exact hash or path assertions.
    let mut fields = checksum_file.split_whitespace();
    let file_hash = fields.next().expect("checksum file must carry a hash field");
    let file_path = fields.next().expect("checksum file must carry a path field");
    assert!(fields.next().is_none(), "checksum file must carry exactly two fields");
    assert_eq!(file_hash, hex, "the committed sha256 must match the golden bytes");
    assert_eq!(
        file_path, "tests/fixtures/minimal.kvb",
        "the committed sha256 line must name the golden bundle"
    );
}

// -- Phase Three Task 2: pure bundle inspection ------------------------------

/// SHA-256 of the complete committed golden bundle file (envelope included),
/// i.e. the exact content of `tests/fixtures/minimal.kvb.sha256`.
const GOLDEN_BUNDLE_HASH: &str = "3e1add8208f77c98fdddf5253c98bb18f533e5b3bf3d35d92ac444525080e136";

const LEVEL_B1: &str = "b1000001-0000-4000-8000-0000000000b1";
const LEVEL_1F: &str = "b1000002-0000-4000-8000-00000000001f";
const LEVEL_2F: &str = "b1000003-0000-4000-8000-00000000002f";

fn golden_bytes() -> Vec<u8> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    fs::read(repo_root.join("tests/fixtures/minimal.kvb"))
        .expect("tests/fixtures/minimal.kvb must be committed")
}

fn level_row(id: &str, ordinal: f64) -> kiriko_model::model::ViewerLevel {
    kiriko_model::model::ViewerLevel {
        id: id.to_string(),
        ordinal,
        label: BTreeMap::new(),
        short_name: BTreeMap::new(),
    }
}

#[test]
fn inspect_bundle_projects_the_committed_golden_fixture() {
    let bytes = golden_bytes();
    let inspected = inspect_bundle(&bytes).expect("golden inspection");

    // Whole-file hash, not the envelope's payload digest.
    assert_eq!(inspected.bundle_hash, GOLDEN_BUNDLE_HASH);

    // Level rows in canonical decoded order (ordinal descending: 1, 0, -1).
    assert_eq!(inspected.level_ids, vec![LEVEL_2F, LEVEL_1F, LEVEL_B1]);
    assert_eq!(inspected.level_ids.len(), 3);

    // One entry per decoded feature, in canonical decoded order.
    let document = decode_bundle(&bytes).expect("golden bundle decodes");
    assert_eq!(inspected.feature_levels.len(), 27);
    assert_eq!(
        inspected
            .feature_levels
            .iter()
            .map(|(feature, _)| feature.as_str())
            .collect::<Vec<_>>(),
        document
            .features
            .iter()
            .map(|f| f.id.as_str())
            .collect::<Vec<_>>(),
        "feature_levels must preserve the canonical decoded feature order"
    );

    // Every level feature maps to its own id.
    for level_id in [LEVEL_2F, LEVEL_1F, LEVEL_B1] {
        assert!(
            inspected
                .feature_levels
                .iter()
                .any(|(feature, level)| feature == level_id && level.as_deref() == Some(level_id)),
            "level feature {level_id} must map to its own id"
        );
    }
    assert!(
        inspected
            .feature_levels
            .iter()
            .any(|(feature, level)| level.as_deref() == Some(feature.as_str())),
        "at least the level features must self-map"
    );

    // A direct feature -> level mapping from the fixture's unit collection.
    assert!(inspected.feature_levels.contains(&(
        "c1000001-0000-4000-8000-0000000000b1".to_string(),
        Some(LEVEL_B1.to_string()),
    )));

    // Level-independent features map to null.
    assert!(
        inspected
            .feature_levels
            .contains(&("a1000001-0000-4000-8000-000000000001".to_string(), None)),
        "the venue feature is level-independent"
    );
    assert!(
        inspected
            .feature_levels
            .contains(&("a1000002-0000-4000-8000-000000000002".to_string(), None)),
        "the address feature is level-independent"
    );
}

#[test]
fn inspect_bundle_rejects_duplicate_level_rows() {
    use kiriko_model::model::FeatureType;
    let mut document = minimal_document(vec![minimal_feature("l1", FeatureType::Level)]);
    document.levels = vec![level_row("l1", 1.0), level_row("l1", 0.0)];
    let bytes = encode_bundle(&document).expect("encode does not validate level semantics");
    let err = inspect_bundle(&bytes).expect_err("duplicate level rows must be rejected");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn inspect_bundle_rejects_a_level_feature_without_a_level_row() {
    use kiriko_model::model::FeatureType;
    let document = minimal_document(vec![minimal_feature("l1", FeatureType::Level)]);
    let bytes = encode_bundle(&document).expect("encode does not validate level semantics");
    let err = inspect_bundle(&bytes).expect_err("a level feature without a row must be rejected");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn inspect_bundle_rejects_a_level_row_without_a_level_feature() {
    let mut document = minimal_document(vec![]);
    document.levels = vec![level_row("l1", 0.0)];
    let bytes = encode_bundle(&document).expect("encode does not validate level semantics");
    let err = inspect_bundle(&bytes).expect_err("a level row without a feature must be rejected");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn inspect_bundle_rejects_a_feature_referencing_an_unknown_level() {
    use kiriko_model::model::FeatureType;
    let mut unit = minimal_feature("u1", FeatureType::Unit);
    unit.level_id = Some("nope".to_string());
    let mut document = minimal_document(vec![minimal_feature("l1", FeatureType::Level), unit]);
    document.levels = vec![level_row("l1", 0.0)];
    let bytes = encode_bundle(&document).expect("encode does not validate level semantics");
    let err = inspect_bundle(&bytes).expect_err("an unknown level reference must be rejected");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn inspect_bundle_rejects_a_level_feature_carrying_an_unknown_level_id() {
    use kiriko_model::model::FeatureType;
    // A Level feature self-maps, but a non-null `level_id` it carries is
    // still a level reference and must resolve to an existing level row.
    let mut level = minimal_feature("l1", FeatureType::Level);
    level.level_id = Some("nope".to_string());
    let mut document = minimal_document(vec![level]);
    document.levels = vec![level_row("l1", 0.0)];
    let bytes = encode_bundle(&document).expect("encode does not validate level semantics");
    let err = inspect_bundle(&bytes)
        .expect_err("a level feature with an unknown level_id must be rejected");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn inspect_bundle_accepts_a_semantically_consistent_document() {
    use kiriko_model::model::FeatureType;
    let mut unit = minimal_feature("u1", FeatureType::Unit);
    unit.level_id = Some("l1".to_string());
    let mut document = minimal_document(vec![minimal_feature("l1", FeatureType::Level), unit]);
    document.levels = vec![level_row("l1", 0.0)];
    let bytes = encode_bundle(&document).expect("encodes");
    let inspected = inspect_bundle(&bytes).expect("consistent document inspects");
    assert_eq!(inspected.level_ids, vec!["l1"]);
    assert_eq!(
        inspected.feature_levels,
        vec![
            ("l1".to_string(), Some("l1".to_string())),
            ("u1".to_string(), Some("l1".to_string())),
        ]
    );
}

#[test]
fn inspect_bundle_propagates_all_four_decode_error_codes() {
    let golden = golden_bytes();

    let mut magic = golden.clone();
    magic[0] ^= 0xFF;
    assert_eq!(
        inspect_bundle(&magic).expect_err("corrupted magic").code,
        BundleErrorCode::InvalidBundle
    );

    let mut major = golden.clone();
    major[4..6].copy_from_slice(&2u16.to_le_bytes());
    assert_eq!(
        inspect_bundle(&major).expect_err("unsupported major").code,
        BundleErrorCode::UnsupportedBundleVersion
    );

    let mut frame = golden.clone();
    let last = frame.len() - 1;
    frame[last] ^= 0xFF;
    assert_eq!(
        inspect_bundle(&frame).expect_err("corrupted frame").code,
        BundleErrorCode::BundleIntegrityFailed
    );

    let mut oversized = golden;
    oversized[12..20].copy_from_slice(&(512u64 * 1024 * 1024 + 1).to_le_bytes());
    assert_eq!(
        inspect_bundle(&oversized)
            .expect_err("oversized declared length")
            .code,
        BundleErrorCode::BundleTooLarge
    );
}

// -- Task 1: network round-trip stability -----------------------------------

fn bundle_with_graph(graph: kiriko_route::RouteGraph) -> Vec<u8> {
    let doc = BundleDocument {
        metadata: BundleMetadata {
            dataset_id: "t/v".to_string(),
            version: 1,
        },
        manifest: kiriko_model::model::ImdfManifest {
            version: "1.0.0".to_string(),
            language: "en".to_string(),
            rest: BTreeMap::new(),
        },
        venue_id: "v".to_string(),
        levels: vec![level_row("l0", 0.0), level_row("l1", 1.0)],
        features: Vec::new(),
        bounds_by_level: BTreeMap::new(),
        warnings: Vec::new(),
        stats: BundleStats {
            levels: 2,
            features: 0,
        },
        graph: Some(graph),
        facilities: None,
    };
    encode_bundle(&doc).expect("bundle with graph encodes")
}

#[test]
fn network_round_trip_is_stable_across_two_export_build_cycles() {
    use kiriko_route::{RouteEdge, RouteGraph, RouteNode};
    // Integer millimetre costs and integer ordinals: a horizontal edge on F1
    // and a vertical edge up to F2.
    let g0 = RouteGraph {
        nodes: vec![
            RouteNode { lon: 139.70, lat: 35.69, ordinal: 0.0 },
            RouteNode { lon: 139.701, lat: 35.69, ordinal: 0.0 },
            RouteNode { lon: 139.70, lat: 35.69, ordinal: 1.0 },
        ],
        edges: vec![
            RouteEdge { from: 0, to: 1, weight: 90_000.0, ordinal: 0.0, interior: Vec::new() },
            RouteEdge { from: 0, to: 2, weight: 5_000.0, ordinal: 0.0, interior: Vec::new() },
        ],
    };

    let ordinals = [0.0, 1.0];
    let net1 = export_network(&bundle_with_graph(g0.clone())).expect("first export");
    let g1 = kiriko_route::build_route_graph(&net1.junctions, &net1.paths, &ordinals)
        .expect("re-import cycle 1")
        .graph;
    // Reciprocal PATHID/RPATHID pairs collapse back to one logical edge each —
    // no doubling across the round-trip.
    assert_eq!(g1.edges.len(), g0.edges.len(), "edge count is stable");
    assert_eq!(g1, g0, "costs, geometry, and integer ordinals survive one cycle");

    let net2 = export_network(&bundle_with_graph(g1.clone())).expect("second export");
    let g2 = kiriko_route::build_route_graph(&net2.junctions, &net2.paths, &ordinals)
        .expect("re-import cycle 2")
        .graph;
    assert_eq!(g2, g1, "the second cycle is a fixed point");
    assert_eq!(net2, net1, "re-export is identical");
}
