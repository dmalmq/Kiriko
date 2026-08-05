//! `kvb1` bundle codec: envelope/directory byte-layout tests, determinism,
//! the corruption matrix, and the committed golden fixture.

mod support;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use kiriko_bundle::{
    BundleDocument, BundleErrorCode, BundleMetadata, BundleStats, CapabilityReport, CompileError,
    ResolutionProfile, SectionCapability, compile_imdf, compile_imdf_with_network, decode_bundle,
    encode_bundle, export_network, inspect_bundle,
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
        false,
        None,
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
        false,
        None,
    )
    .expect_err("malformed network GeoJSON must fail the compile");
    assert_eq!(err.code_str(), "route_build_failed");
    assert!(matches!(err, CompileError::Route(_)));
}

#[test]
fn compile_with_synthesize_network_derives_a_graph_from_venue_geometry() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(&source, metadata(), None, None, None, true, false, None)
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
    let compiled = compile_imdf_with_network(&source, metadata(), None, None, None, false, false, None)
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
        false,
        None,
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
        false,
        None,
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
fn reports_optional_sections_as_available_or_absent() {
    let source = support::build_minimal_imdf_zip();

    let with_both = compile_imdf_with_network(
        &source,
        metadata(),
        Some(NETWORK_JUNCTIONS),
        Some(NETWORK_PATHS),
        Some(FACILITIES),
        false,
        false,
        None,
    )
    .expect("fixture + network + facilities compiles");
    let document = decode_bundle(&with_both.bytes).expect("bundle decodes");
    assert_eq!(
        document.capabilities.graph(),
        SectionCapability::Available,
        "a bundle carrying a graph must report the graph capability available"
    );
    assert_eq!(
        document.capabilities.facilities(),
        SectionCapability::Available,
        "a bundle carrying facilities must report the facilities capability available"
    );

    let with_neither =
        compile_imdf_with_network(&source, metadata(), None, None, None, false, false, None)
            .expect("fixture alone compiles");
    let document = decode_bundle(&with_neither.bytes).expect("bundle decodes");
    assert_eq!(
        document.capabilities.graph(),
        SectionCapability::Absent,
        "absent must be distinguishable from present-but-unreadable"
    );
    assert_eq!(
        document.capabilities.facilities(),
        SectionCapability::Absent,
        "absent must be distinguishable from present-but-unreadable"
    );
}

#[test]
fn inspection_carries_the_capability_report() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(
        &source,
        metadata(),
        Some(NETWORK_JUNCTIONS),
        Some(NETWORK_PATHS),
        None,
        false,
        false,
        None,
    )
    .expect("fixture + network compiles");

    let inspection = inspect_bundle(&compiled.bytes).expect("bundle inspects");

    assert_eq!(
        inspection.capabilities.graph(),
        SectionCapability::Available,
        "the server-side projection must carry the same capabilities the decoder found"
    );
    assert_eq!(
        inspection.capabilities.facilities(),
        SectionCapability::Absent,
        "a venue with no facilities must be distinguishable from one whose facilities are broken"
    );
}

#[test]
fn compile_with_facilities_but_no_network_warns_once_and_leaves_anchors_unset() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(
        &source,
        metadata(),
        None,
        None,
        Some(FACILITIES),
        false,
        false,
        None,
    )
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
    let err = compile_imdf_with_network(
        &source,
        metadata(),
        None,
        None,
        Some("not geojson"),
        false,
        false,
        None,
    )
    .expect_err("malformed facilities GeoJSON must fail the compile");
    assert_eq!(err.code_str(), "facility_build_failed");
    assert!(matches!(err, CompileError::Facility(_)));
}

// -- Building-scoped clipping (gdb-building-scoped-network-clipping Task 3) -

// Two junctions inside the minimal fixture's 1F level polygon
// (139.7660,35.6800)-(139.7680,35.6820), plus a small chain of six junctions
// placed far outside every level/unit polygon in the fixture. The far chain
// is large enough that clipping it away shrinks the compiled bundle by more
// than the added clip-warning text costs, so the byte-count assertion below
// is a genuine signal, not noise.
const CLIP_JUNCTIONS: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.7665,35.6805]}},
  {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.7670,35.6810]}},
  {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.900,35.900]}},
  {"type":"Feature","properties":{"NODEID":4,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.901,35.901]}},
  {"type":"Feature","properties":{"NODEID":5,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.902,35.902]}},
  {"type":"Feature","properties":{"NODEID":6,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.903,35.903]}},
  {"type":"Feature","properties":{"NODEID":7,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.904,35.904]}},
  {"type":"Feature","properties":{"NODEID":8,"FLOOR":"F1"},"geometry":{"type":"Point","coordinates":[139.905,35.905]}}]}"#;
const CLIP_PATHS: &str = r#"{"type":"FeatureCollection","features":[
  {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":200,"FLOOR":"F1"},
   "geometry":{"type":"LineString","coordinates":[[139.7665,35.6805],[139.7670,35.6810]]}},
  {"type":"Feature","properties":{"FNODEID":2,"TNODEID":3,"cost":200,"FLOOR":"F1"},
   "geometry":{"type":"LineString","coordinates":[[139.7670,35.6810],[139.900,35.900]]}},
  {"type":"Feature","properties":{"FNODEID":3,"TNODEID":4,"cost":200,"FLOOR":"F1"},
   "geometry":{"type":"LineString","coordinates":[[139.900,35.900],[139.901,35.901]]}},
  {"type":"Feature","properties":{"FNODEID":4,"TNODEID":5,"cost":200,"FLOOR":"F1"},
   "geometry":{"type":"LineString","coordinates":[[139.901,35.901],[139.902,35.902]]}},
  {"type":"Feature","properties":{"FNODEID":5,"TNODEID":6,"cost":200,"FLOOR":"F1"},
   "geometry":{"type":"LineString","coordinates":[[139.902,35.902],[139.903,35.903]]}},
  {"type":"Feature","properties":{"FNODEID":6,"TNODEID":7,"cost":200,"FLOOR":"F1"},
   "geometry":{"type":"LineString","coordinates":[[139.903,35.903],[139.904,35.904]]}},
  {"type":"Feature","properties":{"FNODEID":7,"TNODEID":8,"cost":200,"FLOOR":"F1"},
   "geometry":{"type":"LineString","coordinates":[[139.904,35.904],[139.905,35.905]]}}]}"#;

#[test]
fn clipping_drops_network_nodes_outside_the_venue() {
    let source = support::build_minimal_imdf_zip();

    let unclipped = compile_imdf_with_network(
        &source,
        metadata(),
        Some(CLIP_JUNCTIONS),
        Some(CLIP_PATHS),
        None,
        false,
        false,
        None,
    )
    .expect("fixture + network compiles unclipped");
    let clipped = compile_imdf_with_network(
        &source,
        metadata(),
        Some(CLIP_JUNCTIONS),
        Some(CLIP_PATHS),
        None,
        false,
        true,
        None,
    )
    .expect("fixture + network compiles clipped");

    // The clipped bundle must be strictly smaller and carry a RouteBuild
    // warning naming the drop.
    assert!(
        clipped.bytes.len() < unclipped.bytes.len(),
        "clipping must drop bytes from the compiled bundle"
    );
    assert!(
        clipped
            .warnings
            .iter()
            .any(|w| w.message.contains("clipped")),
        "expected a clip warning, got {:?}",
        clipped.warnings
    );

    let unclipped_document = decode_bundle(&unclipped.bytes).expect("unclipped bundle decodes");
    let unclipped_graph = unclipped_document
        .graph
        .expect("unclipped compile embeds a graph section");
    assert_eq!(
        unclipped_graph.nodes.len(),
        8,
        "all eight junctions survive unclipped"
    );

    let clipped_document = decode_bundle(&clipped.bytes).expect("clipped bundle decodes");
    let clipped_graph = clipped_document
        .graph
        .expect("clipped compile still embeds a graph section for the surviving nodes");
    assert_eq!(
        clipped_graph.nodes.len(),
        2,
        "the far-outside junction chain must be dropped by clipping"
    );
    assert_eq!(
        clipped_graph.edges.len(),
        1,
        "every edge reaching a dropped junction must be dropped too"
    );
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
fn directory_is_sorted_fixed_width_and_emits_the_spatial_context_section() {
    let bytes = compile_minimal();
    let payload = decompress_payload(&bytes);

    let count = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    assert_eq!(
        count, 4,
        "a compiled venue emits manifest, geometry, stores, and the spatial context section"
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
        vec![1, 2, 3, 8],
        "manifest(1), geometry(2), stores(3), and spatial context(8) are emitted"
    );
    assert_eq!(
        cursor,
        payload.len(),
        "sections must fill the payload with no trailing bytes"
    );
}

// -- Step 2/3: section round trip and determinism --------------------------

#[test]
fn compile_emits_a_spatial_context_frame_from_the_venue_bounds() {
    let bytes = compile_minimal();
    let document = decode_bundle(&bytes).expect("bundle decodes");
    let context = document
        .spatial_context
        .expect("a compiled venue with geometry must carry a spatial context section");
    assert_eq!(
        document.capabilities.spatial_context(),
        SectionCapability::Available
    );

    // The fixture venue polygon spans 139.766..139.768 / 35.680..35.682, so
    // the canonical horizontal-bounds centre is exactly the display point.
    assert_eq!(context.frame.anchor, [139.767, 35.681]);
    assert_eq!(
        context.frame.ecef_origin,
        kiriko_model::spatial::wgs84_ecef(139.767, 35.681, 0.0),
        "the ECEF transform must be exactly the WGS84 conversion of the anchor"
    );
    assert_eq!(
        context.frame.enu_basis_ecef,
        kiriko_model::spatial::enu_basis_ecef(139.767, 35.681),
        "the world transform rotation must be the ENU basis at the anchor"
    );
    assert_eq!(context.frame.world_translation, context.frame.ecef_origin);
    assert_eq!(context.frame.axes, kiriko_model::spatial::Axes::EastNorthUp);
    assert_eq!(context.frame.unit, kiriko_model::spatial::LengthUnit::Millimetre);

    // The declared datum and the anchor's registration evidence are
    // registered, and the frame references them by index.
    assert_eq!(context.registries.datums.len(), 1);
    assert_eq!(context.registries.datums[0].name, "WGS84");
    assert_eq!(
        context.registries.locators[0].value,
        "a1000001-0000-4000-8000-000000000001",
        "the venue locator stays first (index 0)"
    );
    assert_eq!(
        context.registries.registration_evidence[0].method,
        kiriko_model::spatial::EvidenceMethod::DerivedFromVenueGeometry,
        "the anchor evidence stays first (index 0)"
    );
    assert_eq!(context.frame.datum_ref, 0);
    assert_eq!(context.frame.anchor_evidence_ref, 0);

    // Floor-plane resolution: the fixture has no elevations and no network,
    // so all three levels resolve by nominal spacing off ordinal 0 (4.0 m
    // per step), normalised so the lowest plane (B1, ordinal −1) lands at 0.
    assert_eq!(
        context.frame.vertical_normalisation_offset_mm, -4000,
        "the normalisation offset is derived from the resolved planes, not a constant"
    );
    assert_eq!(context.levels.len(), 3, "one record per canonical level");
    let by_id: BTreeMap<&str, &kiriko_model::spatial::LevelRecord> =
        context.levels.iter().map(|l| (l.level_id.as_str(), l)).collect();
    let b1 = by_id["b1000001-0000-4000-8000-0000000000b1"];
    assert_eq!(b1.method, kiriko_model::spatial::ResolutionMethod::NominalSpacing);
    assert_eq!(b1.resolved_scene_z_mm, 0, "lowest plane at scene Z 0");
    assert_eq!(b1.source_elevation_m, None);
    assert!(
        context.levels.iter().all(|l| l.method == kiriko_model::spatial::ResolutionMethod::NominalSpacing),
        "every level is flagged assumed — a scene never presents a guess as a measurement"
    );
    for level in &context.levels {
        assert!(
            (level.confidence_ref as usize) < context.registries.confidence.len(),
            "every level's confidence reference must resolve"
        );
        for evidence_ref in &level.evidence_refs {
            assert!(
                (*evidence_ref as usize) < context.registries.registration_evidence.len(),
                "every level's evidence references must resolve"
            );
        }
        assert!(
            level.resolved_scene_z_mm >= 0,
            "scene Z is normalised non-negative"
        );
    }
}

#[test]
fn spatial_context_round_trips_through_reencode() {
    let bytes = compile_minimal();
    let document = decode_bundle(&bytes).expect("bundle decodes");
    let context = document
        .spatial_context
        .clone()
        .expect("compiled bundle carries spatial context");

    let reencoded = encode_bundle(&document).expect("decoded document re-encodes");
    let redoc = decode_bundle(&reencoded).expect("re-encoded bundle decodes");
    assert_eq!(redoc.spatial_context, Some(context));
    assert_eq!(redoc.capabilities.spatial_context(), SectionCapability::Available);
}

#[test]
fn multi_floor_resolution_exercises_all_three_precedence_branches() {
    use kiriko_model::spatial::{
        AssumptionKind, ConfidenceKind, EvidenceMethod, ResolutionMethod,
    };

    let source = support::build_multi_floor_imdf_zip();
    // A custom profile proves the nominal spacing is configurable, not a
    // global constant.
    let profile = ResolutionProfile {
        nominal_floor_spacing_m: 4.5,
        ..ResolutionProfile::default()
    };

    // Three close junctions on F2 (ordinal 1) and three on B1 (ordinal −1).
    const JUNCTIONS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"NODEID":1,"FLOOR":"F2","altitude":14.0},"geometry":{"type":"Point","coordinates":[139.7665,35.6805]}},
      {"type":"Feature","properties":{"NODEID":2,"FLOOR":"F2","altitude":14.1},"geometry":{"type":"Point","coordinates":[139.7670,35.6805]}},
      {"type":"Feature","properties":{"NODEID":3,"FLOOR":"F2","altitude":14.2},"geometry":{"type":"Point","coordinates":[139.7675,35.6805]}},
      {"type":"Feature","properties":{"NODEID":4,"FLOOR":"B1","altitude":6.5},"geometry":{"type":"Point","coordinates":[139.7665,35.6810]}},
      {"type":"Feature","properties":{"NODEID":5,"FLOOR":"B1","altitude":6.5},"geometry":{"type":"Point","coordinates":[139.7670,35.6810]}},
      {"type":"Feature","properties":{"NODEID":6,"FLOOR":"B1","altitude":6.6},"geometry":{"type":"Point","coordinates":[139.7675,35.6810]}}]}"#;
    const PATHS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"FNODEID":1,"TNODEID":2,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.7665,35.6805],[139.7670,35.6805]]]}},
      {"type":"Feature","properties":{"FNODEID":2,"TNODEID":3,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.7670,35.6805],[139.7675,35.6805]]]}},
      {"type":"Feature","properties":{"FNODEID":4,"TNODEID":5,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.7665,35.6810],[139.7670,35.6810]]]}},
      {"type":"Feature","properties":{"FNODEID":5,"TNODEID":6,"cost":100},"geometry":{"type":"MultiLineString","coordinates":[[[139.7670,35.6810],[139.7675,35.6810]]]}}]}"#;

    let compiled = compile_imdf_with_network(
        &source,
        metadata(),
        Some(JUNCTIONS),
        Some(PATHS),
        None,
        false,
        false,
        Some(&profile),
    )
    .expect("multi-floor fixture compiles");
    let document = decode_bundle(&compiled.bytes).expect("bundle decodes");
    assert_eq!(document.capabilities.spatial_context(), SectionCapability::Available);
    assert_eq!(
        document.capabilities.graph(),
        SectionCapability::Available,
        "the network graph embeds alongside the §8 resolution"
    );
    let context = document.spatial_context.expect("spatial context present");
    assert_eq!(context.levels.len(), 4, "one record per canonical level");

    let by_id: BTreeMap<&str, &kiriko_model::spatial::LevelRecord> = context
        .levels
        .iter()
        .map(|l| (l.level_id.as_str(), l))
        .collect();

    let l1 = by_id["b1000003-0000-4000-8000-000000000003"]; // F1, explicit elevation 10.0
    assert_eq!(l1.method, ResolutionMethod::ImportedElevation);
    assert_eq!(l1.source_elevation_m, Some(10.0));
    assert_eq!(l1.network_difference_mm, None, "no network on F1");
    assert_eq!(l1.resolved_scene_z_mm, 4000, "10000 − offset 6000");

    let l2 = by_id["b1000002-0000-4000-8000-000000000002"]; // F2, three close junction altitudes
    assert_eq!(l2.method, ResolutionMethod::NetworkAltitude);
    assert_eq!(l2.source_elevation_m, None);
    assert_eq!(l2.resolved_scene_z_mm, 8100, "median 14.1 → 14100 − offset 6000");

    let l3 = by_id["b1000001-0000-4000-8000-000000000001"]; // F3, nothing → nominal
    assert_eq!(l3.method, ResolutionMethod::NominalSpacing);
    assert_eq!(
        l3.resolved_scene_z_mm, 13500,
        "6.0 + configured 4.5 m × 3 (off the lowest real plane, B1) − offset 6000"
    );

    let b1 = by_id["b1000004-0000-4000-8000-000000000004"]; // B1, elevation 6.0 + network 6.5
    assert_eq!(b1.method, ResolutionMethod::ImportedElevation, "imported wins the precedence");
    assert_eq!(b1.source_elevation_m, Some(6.0));
    assert_eq!(
        b1.network_difference_mm,
        Some(500),
        "the disagreement is recorded as a difference, nothing is overwritten"
    );
    assert_eq!(b1.resolved_scene_z_mm, 0, "lowest plane lands at scene Z 0");
    assert_eq!(context.frame.vertical_normalisation_offset_mm, 6000);

    // Confidence class follows the method: measured / estimated / assumed.
    let confidence_kind =
        |idx: u32| context.registries.confidence[idx as usize].kind;
    assert_eq!(confidence_kind(l1.confidence_ref), ConfidenceKind::Measured);
    assert_eq!(confidence_kind(l2.confidence_ref), ConfidenceKind::Estimated);
    assert_eq!(
        confidence_kind(l3.confidence_ref),
        ConfidenceKind::Assumed,
        "a nominal plane is identifiable as assumed, never presented as a measurement"
    );

    // Every evidence reference resolves; the nominal record's evidence names
    // the shared nominal assumption, and B1's two sources are both recorded.
    for level in &context.levels {
        for evidence_ref in &level.evidence_refs {
            assert!(
                (*evidence_ref as usize) < context.registries.registration_evidence.len(),
                "every evidence reference must resolve"
            );
        }
    }
    assert_eq!(b1.evidence_refs.len(), 2, "imported elevation + preserved network altitude");
    let l3_evidence = &context.registries.registration_evidence[l3.evidence_refs[0] as usize];
    assert_eq!(l3_evidence.method, EvidenceMethod::NominalSpacing);
    let assumption = l3_evidence
        .assumption_ref
        .expect("nominal evidence references the shared assumption");
    assert_eq!(context.registries.assumptions[assumption as usize].kind, AssumptionKind::Nominal);
    assert!(
        context.registries.assumptions[assumption as usize]
            .detail
            .contains("4.5"),
        "the profile value rides in the assumption detail"
    );
}

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
        spatial_context: None,
        capabilities: CapabilityReport::default(),
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
    let file_hash = fields
        .next()
        .expect("checksum file must carry a hash field");
    let file_path = fields
        .next()
        .expect("checksum file must carry a path field");
    assert!(
        fields.next().is_none(),
        "checksum file must carry exactly two fields"
    );
    assert_eq!(
        file_hash, hex,
        "the committed sha256 must match the golden bytes"
    );
    assert_eq!(
        file_path, "tests/fixtures/minimal.kvb",
        "the committed sha256 line must name the golden bundle"
    );
}

// -- Phase Three Task 2: pure bundle inspection ------------------------------

/// SHA-256 of the complete committed golden bundle file (envelope included),
/// i.e. the exact content of `tests/fixtures/minimal.kvb.sha256`.
const GOLDEN_BUNDLE_HASH: &str = "70eb1a88ad66fa0e7e441fe701da63b2c268dd35dcca69e65e67acbcab207f77";

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
        spatial_context: None,
        capabilities: CapabilityReport::default(),
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
            RouteNode {
                lon: 139.70,
                lat: 35.69,
                ordinal: 0.0,
            },
            RouteNode {
                lon: 139.701,
                lat: 35.69,
                ordinal: 0.0,
            },
            RouteNode {
                lon: 139.70,
                lat: 35.69,
                ordinal: 1.0,
            },
        ],
        edges: vec![
            RouteEdge {
                from: 0,
                to: 1,
                weight: 90_000.0,
                ordinal: 0.0,
                interior: Vec::new(),
            },
            RouteEdge {
                from: 0,
                to: 2,
                weight: 5_000.0,
                ordinal: 0.0,
                interior: Vec::new(),
            },
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
    assert_eq!(
        g1, g0,
        "costs, geometry, and integer ordinals survive one cycle"
    );

    let net2 = export_network(&bundle_with_graph(g1.clone())).expect("second export");
    let g2 = kiriko_route::build_route_graph(&net2.junctions, &net2.paths, &ordinals)
        .expect("re-import cycle 2")
        .graph;
    assert_eq!(g2, g1, "the second cycle is a fixed point");
    assert_eq!(net2, net1, "re-export is identical");
}

// -- Stage 0: §8 capability and dependency matrix --------------------------

/// Rebuilds the uncompressed payload of a compiled bundle under a modified
/// section directory: `mutate` receives `(id, version, bytes)` in
/// id-ascending order and may bump versions, replace bytes, or append rows
/// (which must keep ids ascending). Rows are repacked contiguously, so the
/// result is a well-formed directory around hand-crafted section content.
fn rebuild_payload(
    payload: &[u8],
    mutate: impl FnOnce(&mut Vec<(u16, u16, Vec<u8>)>),
) -> Vec<u8> {
    let count = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let mut sections: Vec<(u16, u16, Vec<u8>)> = Vec::with_capacity(count);
    for i in 0..count {
        let base = 2 + i * 20;
        let id = u16::from_le_bytes([payload[base], payload[base + 1]]);
        let version = u16::from_le_bytes([payload[base + 2], payload[base + 3]]);
        let offset =
            u64::from_le_bytes(payload[base + 4..base + 12].try_into().unwrap()) as usize;
        let length =
            u64::from_le_bytes(payload[base + 12..base + 20].try_into().unwrap()) as usize;
        sections.push((id, version, payload[offset..offset + length].to_vec()));
    }
    mutate(&mut sections);

    let mut out = Vec::new();
    out.extend_from_slice(&(sections.len() as u16).to_le_bytes());
    let dir_len = 2 + sections.len() * 20;
    let mut cursor = dir_len as u64;
    for (id, version, bytes) in &sections {
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&version.to_le_bytes());
        out.extend_from_slice(&cursor.to_le_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        cursor += bytes.len() as u64;
    }
    for (_, _, bytes) in &sections {
        out.extend_from_slice(bytes);
    }
    out
}

#[test]
fn spatial_context_at_an_unreadable_version_degrades_alone() {
    let payload = decompress_payload(&compile_minimal());
    let crafted = wrap_payload_for_test(&rebuild_payload(&payload, |sections| {
        for (id, version, _) in sections.iter_mut() {
            if *id == 8 {
                *version = 2;
            }
        }
    }));

    let document = decode_bundle(&crafted).expect("the venue still opens");
    assert_eq!(
        document.capabilities.spatial_context(),
        SectionCapability::UnsupportedVersion {
            declared: 2,
            supported: 1,
        },
        "the report must name both versions so a reader can say what is needed"
    );
    assert!(
        document.spatial_context.is_none(),
        "bytes at an unreadable version are never interpreted"
    );
    assert_eq!(document.capabilities.graph(), SectionCapability::Absent);
    assert_eq!(document.venue_id, "a1000001-0000-4000-8000-000000000001");
}

#[test]
fn garbage_spatial_context_bytes_report_invalid_and_the_venue_opens() {
    let payload = decompress_payload(&compile_minimal());
    let crafted = wrap_payload_for_test(&rebuild_payload(&payload, |sections| {
        for (id, _, bytes) in sections.iter_mut() {
            if *id == 8 {
                *bytes = vec![0x00, 0xFF, 0x7F];
            }
        }
    }));

    let document = decode_bundle(&crafted).expect("the venue still opens");
    assert!(
        matches!(document.capabilities.spatial_context(), SectionCapability::Invalid { .. }),
        "a section that fails validation is reported invalid, not trusted"
    );
    assert!(document.spatial_context.is_none());
    assert_eq!(document.capabilities.scene_sources(), SectionCapability::Absent);
}

#[test]
fn an_invalid_spatial_context_leaves_routing_untouched() {
    let source = support::build_minimal_imdf_zip();
    let compiled = compile_imdf_with_network(
        &source,
        metadata(),
        Some(NETWORK_JUNCTIONS),
        Some(NETWORK_PATHS),
        None,
        false,
        false,
        None,
    )
    .expect("fixture + network compiles");
    let payload = decompress_payload(&compiled.bytes);
    let crafted = wrap_payload_for_test(&rebuild_payload(&payload, |sections| {
        for (id, _, bytes) in sections.iter_mut() {
            if *id == 8 {
                *bytes = vec![0x00, 0xFF];
            }
        }
    }));

    let document = decode_bundle(&crafted).expect("the venue still opens");
    assert!(matches!(document.capabilities.spatial_context(), SectionCapability::Invalid { .. }));
    assert_eq!(
        document.capabilities.graph(),
        SectionCapability::Available,
        "a broken spatial context must not disable the routing graph"
    );
    assert!(document.graph.is_some());
}

#[test]
fn a_section_whose_required_section_is_unavailable_is_disabled_end_to_end() {
    // The end-to-end proof #37 could not make: a bundle carrying a section
    // that depends on §8, with §8 unavailable. The dependent's bytes are
    // never interpreted — garbage is fine — and it reports exactly which
    // section it needs.
    let payload = decompress_payload(&compile_minimal());
    let crafted = wrap_payload_for_test(&rebuild_payload(&payload, |sections| {
        for (id, version, _) in sections.iter_mut() {
            if *id == 8 {
                *version = 2;
            }
        }
        sections.push((9, 1, vec![0xDE, 0xAD, 0xBE]));
    }));

    let document = decode_bundle(&crafted).expect("the venue still opens");
    assert_eq!(
        document.capabilities.spatial_context(),
        SectionCapability::UnsupportedVersion {
            declared: 2,
            supported: 1,
        }
    );
    assert_eq!(
        document.capabilities.scene_sources(),
        SectionCapability::DisabledByDependency { requires: 8 },
        "a present section whose required section is unavailable must be withheld, \
         naming the requirement"
    );
    assert_eq!(document.capabilities.canonical_graph(), SectionCapability::Absent);
    assert_eq!(document.capabilities.network_qa(), SectionCapability::Absent);
}

#[test]
fn a_dependent_section_with_its_requirement_available_has_no_decoder_yet() {
    let payload = decompress_payload(&compile_minimal());
    let crafted = wrap_payload_for_test(&rebuild_payload(&payload, |sections| {
        sections.push((9, 1, vec![0xDE, 0xAD]));
    }));

    let document = decode_bundle(&crafted).expect("the venue still opens");
    match document.capabilities.scene_sources() {
        SectionCapability::Invalid { reason } => {
            assert!(
                reason.contains("no decoder"),
                "the reason must say this build cannot read the section: {reason}"
            );
        }
        other => panic!("expected no-decoder invalid, got {other:?}"),
    }
}

#[test]
fn a_document_with_a_dangling_spatial_context_reference_cannot_be_encoded() {
    // Producer side of the invalid-cross-reference contract: the section
    // cannot be produced, but nothing else about the document fails.
    let mut document = decode_bundle(&compile_minimal()).expect("bundle decodes");
    document
        .spatial_context
        .as_mut()
        .expect("compiled bundle carries spatial context")
        .frame
        .datum_ref = 99;
    let err = encode_bundle(&document).expect_err("a dangling datum reference must not encode");
    assert_eq!(err.code, BundleErrorCode::InvalidBundle);
}

#[test]
fn a_required_section_at_an_unexpected_version_still_fails_the_bundle() {
    let payload = decompress_payload(&compile_minimal());
    let crafted = wrap_payload_for_test(&rebuild_payload(&payload, |sections| {
        for (id, version, _) in sections.iter_mut() {
            if *id == 2 {
                *version = 2;
            }
        }
    }));
    let err = decode_bundle(&crafted).expect_err("a required section at a new version must fail");
    assert_eq!(
        err.code,
        BundleErrorCode::UnsupportedBundleVersion,
        "required-section strictness is preserved: §8's optionality changes nothing about §1–3"
    );
}
