//! Tile-package ingestion: what Kiriko will accept, and what it refuses.
//!
//! A package is untrusted input that arrives as a URI graph, so most of these
//! tests are about rejection. Each hostile case is a separate assertion because
//! "the package was rejected" is not the same guarantee as "the package was
//! rejected for the reason we think".

use kiriko_scene::{TileMemberKind, TilePackageError, validate_tile_package};
use serde_json::json;
use support::{synthetic_glb, tileset_json, zip_package};

mod support;

/// The smallest package Kiriko accepts: a root tileset and one glTF content.
fn minimal_package() -> Vec<u8> {
    zip_package(&[
        ("tileset.json", tileset_json("content/model.glb")),
        ("content/model.glb", synthetic_glb()),
    ])
}

fn expect_error(zip: &[u8]) -> TilePackageError {
    validate_tile_package(zip).expect_err("package must be rejected")
}

#[test]
fn accepts_a_minimal_package_and_records_every_member() {
    let report = validate_tile_package(&minimal_package()).expect("package is valid");

    assert_eq!(report.root_tileset, "tileset.json");
    assert_eq!(report.members.len(), 2);

    // Members are sorted by path, so the record is stable across runs.
    let paths: Vec<&str> = report.members.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(paths, vec!["content/model.glb", "tileset.json"]);

    let tileset = report
        .members
        .iter()
        .find(|m| m.path == "tileset.json")
        .expect("tileset member");
    assert_eq!(tileset.kind, TileMemberKind::Tileset);
    assert_eq!(tileset.content_type, "application/json");
    assert!(tileset.byte_size > 0);
    assert_eq!(tileset.sha256.len(), 64);

    let content = report
        .members
        .iter()
        .find(|m| m.path == "content/model.glb")
        .expect("content member");
    assert_eq!(content.kind, TileMemberKind::Content);
    assert_eq!(content.content_type, "model/gltf-binary");

    // The package's own identity, and the extensions it declares.
    assert_eq!(report.source_hash.len(), 64);
    assert_eq!(report.asset_versions, vec!["1.1".to_string()]);
    assert_eq!(report.total_bytes, tileset.byte_size + content.byte_size);
}

#[test]
fn resolves_the_uri_graph_transitively() {
    // A root tileset referencing a child tileset referencing content: every
    // member has to be enumerated, or serving would 404 mid-flight.
    let child = serde_json::to_vec(&json!({
        "asset": { "version": "1.1" },
        "geometricError": 0.0,
        "root": {
            "boundingVolume": { "box": [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
            "geometricError": 0.0,
            "refine": "ADD",
            "content": { "uri": "../content/model.glb" },
        },
    }))
    .expect("serialize child");

    let zip = zip_package(&[
        ("tileset.json", tileset_json("levels/child.json")),
        ("levels/child.json", child),
        ("content/model.glb", synthetic_glb()),
    ]);
    let report = validate_tile_package(&zip).expect("package is valid");

    let paths: Vec<&str> = report.members.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["content/model.glb", "levels/child.json", "tileset.json"]
    );
    assert_eq!(
        report
            .members
            .iter()
            .filter(|m| m.kind == TileMemberKind::Tileset)
            .count(),
        2
    );
}

#[test]
fn identical_bytes_produce_an_identical_record() {
    let first = validate_tile_package(&minimal_package()).expect("first");
    let second = validate_tile_package(&minimal_package()).expect("second");
    assert_eq!(first, second);
    assert_eq!(first.source_hash, second.source_hash);
}

#[test]
fn rejects_a_package_with_no_root_tileset() {
    let zip = zip_package(&[("content/model.glb", synthetic_glb())]);
    assert!(matches!(
        expect_error(&zip),
        TilePackageError::MissingRootTileset
    ));
}

#[test]
fn rejects_traversal_out_of_the_package() {
    let zip = zip_package(&[
        ("tileset.json", tileset_json("../../etc/passwd")),
        ("content/model.glb", synthetic_glb()),
    ]);
    let error = expect_error(&zip);
    assert!(
        matches!(&error, TilePackageError::PathTraversal { uri, .. } if uri.contains("..")),
        "expected traversal rejection, got {error:?}"
    );
}

#[test]
fn rejects_an_absolute_reference() {
    let zip = zip_package(&[
        ("tileset.json", tileset_json("/var/data/model.glb")),
        ("content/model.glb", synthetic_glb()),
    ]);
    assert!(matches!(
        expect_error(&zip),
        TilePackageError::AbsolutePath { .. }
    ));
}

#[test]
fn rejects_a_reference_outside_the_package() {
    for uri in [
        "https://tiles.example.com/model.glb",
        "http://tiles.example.com/model.glb",
        "//tiles.example.com/model.glb",
        "file:///model.glb",
    ] {
        let zip = zip_package(&[
            ("tileset.json", tileset_json(uri)),
            ("content/model.glb", synthetic_glb()),
        ]);
        let error = expect_error(&zip);
        assert!(
            matches!(&error, TilePackageError::ExternalReference { .. }),
            "{uri} must be rejected as external, got {error:?}"
        );
    }
}

#[test]
fn rejects_a_reference_the_package_does_not_contain() {
    let zip = zip_package(&[("tileset.json", tileset_json("content/missing.glb"))]);
    assert!(matches!(
        expect_error(&zip),
        TilePackageError::UnresolvedMember { .. }
    ));
}

#[test]
fn rejects_an_unsupported_tileset_version() {
    let tileset = serde_json::to_vec(&json!({
        "asset": { "version": "0.0" },
        "geometricError": 0.0,
        "root": {
            "boundingVolume": { "box": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
            "geometricError": 0.0,
            "content": { "uri": "content/model.glb" },
        },
    }))
    .expect("serialize");
    let zip = zip_package(&[
        ("tileset.json", tileset),
        ("content/model.glb", synthetic_glb()),
    ]);
    assert!(matches!(
        expect_error(&zip),
        TilePackageError::UnsupportedAssetVersion { .. }
    ));
}

#[test]
fn rejects_an_extension_the_renderer_cannot_honour() {
    // A required extension Kiriko does not implement would render wrong rather
    // than not at all, which is the worse failure.
    let tileset = serde_json::to_vec(&json!({
        "asset": { "version": "1.1" },
        "geometricError": 0.0,
        "extensionsRequired": ["3DTILES_draco_point_compression"],
        "root": {
            "boundingVolume": { "box": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
            "geometricError": 0.0,
            "content": { "uri": "content/model.glb" },
        },
    }))
    .expect("serialize");
    let zip = zip_package(&[
        ("tileset.json", tileset),
        ("content/model.glb", synthetic_glb()),
    ]);
    let error = expect_error(&zip);
    assert!(
        matches!(&error, TilePackageError::UnsupportedExtension { name, .. }
            if name == "3DTILES_draco_point_compression"),
        "got {error:?}"
    );
}

#[test]
fn rejects_a_content_format_the_deriver_cannot_read() {
    let zip = zip_package(&[
        ("tileset.json", tileset_json("content/model.b3dm")),
        ("content/model.b3dm", b"b3dm\x01\x00\x00\x00".to_vec()),
    ]);
    assert!(matches!(
        expect_error(&zip),
        TilePackageError::UnsupportedContentFormat { .. }
    ));
}

#[test]
fn rejects_content_that_does_not_decode() {
    let zip = zip_package(&[
        ("tileset.json", tileset_json("content/model.glb")),
        ("content/model.glb", b"not a glb at all".to_vec()),
    ]);
    let error = expect_error(&zip);
    assert!(
        matches!(&error, TilePackageError::UndecodableContent { path, .. }
            if path == "content/model.glb"),
        "got {error:?}"
    );
}

#[test]
fn rejects_a_malformed_tileset() {
    let zip = zip_package(&[
        ("tileset.json", b"{ not json".to_vec()),
        ("content/model.glb", synthetic_glb()),
    ]);
    assert!(matches!(
        expect_error(&zip),
        TilePackageError::MalformedTileset { .. }
    ));
}

#[test]
fn rejects_a_tileset_graph_that_references_itself() {
    let zip = zip_package(&[("tileset.json", tileset_json("tileset.json"))]);
    assert!(matches!(
        expect_error(&zip),
        TilePackageError::TilesetCycle { .. }
    ));
}

#[test]
fn reports_entries_the_graph_never_references_without_storing_them() {
    let zip = zip_package(&[
        ("tileset.json", tileset_json("content/model.glb")),
        ("content/model.glb", synthetic_glb()),
        ("NOTES.txt", b"scratch file left in the export".to_vec()),
    ]);
    let report = validate_tile_package(&zip).expect("package is valid");

    // An unreferenced entry is not a member: storing it would bloat the version
    // and serve bytes no tileset asks for.
    assert_eq!(report.members.len(), 2);
    assert_eq!(report.ignored, vec!["NOTES.txt".to_string()]);
}

#[test]
fn rejects_a_package_with_implicit_tiling_it_cannot_traverse() {
    let tileset = serde_json::to_vec(&json!({
        "asset": { "version": "1.1" },
        "geometricError": 0.0,
        "root": {
            "boundingVolume": { "box": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
            "geometricError": 0.0,
            "implicitTiling": {
                "subdivisionScheme": "QUADTREE",
                "subtreeLevels": 2,
                "availableLevels": 2,
                "subtrees": { "uri": "subtrees/{level}/{x}/{y}.subtree" },
            },
            "content": { "uri": "content/{level}_{x}_{y}.glb" },
        },
    }))
    .expect("serialize");
    let zip = zip_package(&[("tileset.json", tileset)]);
    let error = expect_error(&zip);
    assert!(
        matches!(&error, TilePackageError::UnsupportedFeature { feature, .. }
            if feature == "implicitTiling"),
        "got {error:?}"
    );
}

#[test]
fn enumerates_every_content_of_a_multi_content_tile() {
    // 3D Tiles 1.1 allows several contents per tile; missing one would serve a
    // partial building.
    let tileset = serde_json::to_vec(&json!({
        "asset": { "version": "1.1" },
        "geometricError": 0.0,
        "root": {
            "boundingVolume": { "box": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
            "geometricError": 0.0,
            "contents": [
                { "uri": "content/a.glb" },
                { "uri": "content/b.glb" },
            ],
        },
    }))
    .expect("serialize");
    let zip = zip_package(&[
        ("tileset.json", tileset),
        ("content/a.glb", synthetic_glb()),
        ("content/b.glb", synthetic_glb()),
    ]);
    let report = validate_tile_package(&zip).expect("package is valid");
    let paths: Vec<&str> = report.members.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["content/a.glb", "content/b.glb", "tileset.json"]
    );

    // Identical content bytes hash identically, so storage stores them once.
    assert_eq!(report.members[0].sha256, report.members[1].sha256);
}

#[test]
fn walks_child_tiles_not_only_the_root() {
    let tileset = serde_json::to_vec(&json!({
        "asset": { "version": "1.1" },
        "geometricError": 0.0,
        "root": {
            "boundingVolume": { "box": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
            "geometricError": 0.0,
            "children": [
                {
                    "boundingVolume": { "box": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
                    "geometricError": 0.0,
                    "content": { "uri": "content/deep.glb" },
                },
            ],
        },
    }))
    .expect("serialize");
    let zip = zip_package(&[
        ("tileset.json", tileset),
        ("content/deep.glb", synthetic_glb()),
    ]);
    let report = validate_tile_package(&zip).expect("package is valid");
    assert!(report.members.iter().any(|m| m.path == "content/deep.glb"));
}
