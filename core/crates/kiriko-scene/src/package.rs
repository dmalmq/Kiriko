//! Tile-package ingestion: resolving a package's URI graph and deciding
//! whether Kiriko will accept it (#30 section 2).
//!
//! A package is untrusted input, and the shape of the input is what makes it
//! dangerous: a tileset is a *graph* of references, each of which is a chance
//! to point somewhere it should not. So this module is written as a refusal
//! machine. It resolves every reference inside the package, and anything that
//! escapes, dangles, or cannot be decoded stops ingestion with a typed reason
//! rather than being tolerated and rendered later.
//!
//! Two rules keep it honest:
//!
//! - **No network, no filesystem.** The only input is the package's bytes. A
//!   reference with a scheme, an authority, or an absolute path is rejected
//!   rather than fetched, which is what makes ingestion reproducible.
//! - **The record describes the bytes actually read.** Member hashes are taken
//!   from the bytes ingestion accepted, so an archive whose reader resolved some
//!   ambiguity (a duplicate name, say) cannot produce a record describing a copy
//!   Kiriko never saw.
//! - **Members are what the graph asks for.** An entry no tileset references is
//!   reported and not stored: storing it would serve bytes nothing requests and
//!   bloat every version that shares the package.
//!
//! The result is a pure function of the package bytes, so the same package
//! always produces the same record — which is what lets a later version reuse
//! content hashes (#30 section 6).

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::glb::read_glb;

/// Tileset `asset.version` values this implementation understands.
const SUPPORTED_ASSET_VERSIONS: &[&str] = &["1.0", "1.1"];

/// Extensions Kiriko can honour. An extension outside this set is refused
/// rather than ignored: ignoring a required extension renders the wrong
/// geometry, which is worse than rendering none.
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "3DTILES_content_gltf",
    "EXT_mesh_features",
    "EXT_structural_metadata",
];

/// Bounds on a package, so a hostile archive cannot exhaust memory before any
/// validation runs.
const MAX_MEMBERS: usize = 10_000;
const MAX_MEMBER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TILESET_DEPTH: usize = 8;

/// The one traversal feature Kiriko refuses by name, so the refusal and the
/// check cannot drift apart.
const IMPLICIT_TILING: &str = "implicitTiling";

/// What a member is in the graph: a tileset to traverse, or content to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TileMemberKind {
    Tileset,
    Content,
}

/// One accepted member: its path inside the package, its content address, and
/// what it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileMember {
    pub path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub content_type: String,
    pub kind: TileMemberKind,
}

/// The record ingestion produces for an accepted package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TilePackageReport {
    /// Content address of the package bytes as uploaded.
    pub source_hash: String,
    /// Path of the root tileset inside the package.
    pub root_tileset: String,
    /// Distinct `asset.version` values the package's tilesets declare.
    pub asset_versions: Vec<String>,
    /// Extensions the package declares, used or required.
    pub extensions: Vec<String>,
    /// Every member the graph references, sorted by path.
    pub members: Vec<TileMember>,
    /// Entries the graph never references; reported, never stored.
    pub ignored: Vec<String>,
    pub total_bytes: u64,
}

/// Why a package was refused. Every variant carries what a producer needs to
/// find the problem in their export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase", tag = "code")]
pub enum TilePackageError {
    #[error("the package has no root tileset.json")]
    MissingRootTileset,
    #[error("{path} is not a readable tileset: {detail}")]
    MalformedTileset { path: String, detail: String },
    #[error("{path} declares tileset version {found}, which this build cannot read")]
    UnsupportedAssetVersion { path: String, found: String },
    #[error("{path} declares extension {name}, which this build cannot honour")]
    UnsupportedExtension { path: String, name: String },
    #[error("{path} uses {feature}, which this build cannot traverse")]
    UnsupportedFeature { path: String, feature: String },
    #[error("{from} references {uri}, which escapes the package")]
    PathTraversal { from: String, uri: String },
    #[error("{from} references the absolute path {uri}")]
    AbsolutePath { from: String, uri: String },
    #[error("{from} references {uri}, which is outside the package")]
    ExternalReference { from: String, uri: String },
    #[error("{from} references {uri}, which the package does not contain")]
    UnresolvedMember { from: String, uri: String },
    #[error("{path} is content in a format this build cannot read")]
    UnsupportedContentFormat { path: String },
    #[error("{path} does not decode as glTF: {detail}")]
    UndecodableContent { path: String, detail: String },
    #[error("the tileset graph at {path} references itself")]
    TilesetCycle { path: String },
    #[error("the tileset graph nests deeper than {limit} levels")]
    TilesetTooDeep { limit: usize },
    #[error("{path} declares {declared} bytes but carries {actual}")]
    SizeMismatch {
        path: String,
        declared: u64,
        actual: u64,
    },
    #[error("{path} is {size} bytes, over the {limit}-byte member limit")]
    MemberTooLarge { path: String, size: u64, limit: u64 },
    #[error("the package holds {count} entries, over the {limit} limit")]
    TooManyMembers { count: usize, limit: usize },
    #[error("the package is {size} bytes, over the {limit}-byte limit")]
    PackageTooLarge { size: u64, limit: u64 },
    #[error("the package is not a readable archive: {detail}")]
    UnreadableArchive { detail: String },
}

/// A tile or tileset reference, as written in a tileset.
#[derive(Debug, Deserialize)]
struct ContentRef {
    uri: Option<String>,
    /// 3D Tiles 1.0 spelled this `url`; accepted for provenance and rejected
    /// only if it escapes, like any other reference.
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TileNode {
    content: Option<ContentRef>,
    #[serde(default)]
    contents: Vec<ContentRef>,
    #[serde(default)]
    children: Vec<TileNode>,
    implicit_tiling: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct AssetNode {
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TilesetDocument {
    asset: AssetNode,
    root: TileNode,
    #[serde(default)]
    extensions_used: Vec<String>,
    #[serde(default)]
    extensions_required: Vec<String>,
}

/// Validate a tile package's bytes: resolve its graph, check every member, and
/// produce the ingestion record.
///
/// # Errors
///
/// Returns the first refusal encountered. Refusals are ordered by how
/// fundamental they are — an unreadable archive before an unresolved reference —
/// so the reported reason is the one a producer should fix first.
pub fn validate_tile_package(package: &[u8]) -> Result<TilePackageReport, TilePackageError> {
    let size = package.len() as u64;
    if size > MAX_PACKAGE_BYTES {
        return Err(TilePackageError::PackageTooLarge {
            size,
            limit: MAX_PACKAGE_BYTES,
        });
    }

    let entries = read_entries(package)?;
    if entries.len() > MAX_MEMBERS {
        return Err(TilePackageError::TooManyMembers {
            count: entries.len(),
            limit: MAX_MEMBERS,
        });
    }

    let root = find_root_tileset(&entries).ok_or(TilePackageError::MissingRootTileset)?;

    let mut walk = Walk {
        entries: &entries,
        members: BTreeMap::new(),
        asset_versions: BTreeSet::new(),
        extensions: BTreeSet::new(),
    };
    walk.tileset(&root, 0)?;

    let members: Vec<TileMember> = walk.members.into_values().collect();
    let referenced: BTreeSet<&str> = members.iter().map(|m| m.path.as_str()).collect();
    let ignored: Vec<String> = entries
        .keys()
        .filter(|path| !referenced.contains(path.as_str()))
        .cloned()
        .collect();

    Ok(TilePackageReport {
        source_hash: hex_digest(package),
        root_tileset: root,
        asset_versions: walk.asset_versions.into_iter().collect(),
        extensions: walk.extensions.into_iter().collect(),
        total_bytes: members.iter().map(|member| member.byte_size).sum(),
        members,
        ignored,
    })
}

/// The graph walk. Holds the entry map and accumulates what it accepts.
struct Walk<'a> {
    entries: &'a BTreeMap<String, Vec<u8>>,
    members: BTreeMap<String, TileMember>,
    asset_versions: BTreeSet<String>,
    extensions: BTreeSet<String>,
}

impl Walk<'_> {
    fn tileset(&mut self, path: &str, depth: usize) -> Result<(), TilePackageError> {
        if depth > MAX_TILESET_DEPTH {
            return Err(TilePackageError::TilesetTooDeep {
                limit: MAX_TILESET_DEPTH,
            });
        }
        if self.members.contains_key(path) {
            // Already walked: a tileset reachable twice is a cycle, because a
            // finite package cannot legitimately need the same tileset twice.
            return Err(TilePackageError::TilesetCycle {
                path: path.to_string(),
            });
        }

        let bytes = self
            .entries
            .get(path)
            .ok_or_else(|| TilePackageError::UnresolvedMember {
                from: path.to_string(),
                uri: path.to_string(),
            })?;
        let document: TilesetDocument =
            serde_json::from_slice(bytes).map_err(|error| TilePackageError::MalformedTileset {
                path: path.to_string(),
                detail: error.to_string(),
            })?;

        if !SUPPORTED_ASSET_VERSIONS.contains(&document.asset.version.as_str()) {
            return Err(TilePackageError::UnsupportedAssetVersion {
                path: path.to_string(),
                found: document.asset.version,
            });
        }
        for name in document
            .extensions_required
            .iter()
            .chain(document.extensions_used.iter())
        {
            if !SUPPORTED_EXTENSIONS.contains(&name.as_str()) {
                return Err(TilePackageError::UnsupportedExtension {
                    path: path.to_string(),
                    name: name.clone(),
                });
            }
            self.extensions.insert(name.clone());
        }
        self.asset_versions.insert(document.asset.version.clone());

        self.members.insert(
            path.to_string(),
            member(path, bytes, "application/json", TileMemberKind::Tileset),
        );

        self.tile(path, &document.root, depth)
    }

    fn tile(&mut self, from: &str, node: &TileNode, depth: usize) -> Result<(), TilePackageError> {
        // Implicit tiling changes how the graph is traversed — availability
        // comes from subtree files rather than from `children` — so a package
        // using it would silently lose every tile Kiriko never walked to.
        if node.implicit_tiling.is_some() {
            return Err(TilePackageError::UnsupportedFeature {
                path: from.to_string(),
                feature: IMPLICIT_TILING.to_string(),
            });
        }
        for reference in node.content.iter().chain(node.contents.iter()) {
            let Some(uri) = reference.uri.as_deref().or(reference.url.as_deref()) else {
                continue;
            };
            let resolved = resolve(from, uri)?;
            if resolved.ends_with(".json") {
                self.tileset(&resolved, depth + 1)?;
            } else {
                self.content(from, &resolved)?;
            }
        }
        for child in &node.children {
            self.tile(from, child, depth)?;
        }
        Ok(())
    }

    fn content(&mut self, from: &str, path: &str) -> Result<(), TilePackageError> {
        if self.members.contains_key(path) {
            // Two tiles legitimately sharing one content member: already
            // recorded, and the content address makes the reuse free.
            return Ok(());
        }
        if !path.ends_with(".glb") {
            return Err(TilePackageError::UnsupportedContentFormat {
                path: path.to_string(),
            });
        }
        let bytes = self
            .entries
            .get(path)
            .ok_or_else(|| TilePackageError::UnresolvedMember {
                from: from.to_string(),
                uri: path.to_string(),
            })?;
        // Decode support is validated by decoding: a package that cannot be
        // read must fail here, not when a reviewer opens the venue.
        read_glb(bytes).map_err(|error| TilePackageError::UndecodableContent {
            path: path.to_string(),
            detail: error.to_string(),
        })?;
        self.members.insert(
            path.to_string(),
            member(path, bytes, "model/gltf-binary", TileMemberKind::Content),
        );
        Ok(())
    }
}

fn member(path: &str, bytes: &[u8], content_type: &str, kind: TileMemberKind) -> TileMember {
    TileMember {
        path: path.to_string(),
        sha256: hex_digest(bytes),
        byte_size: bytes.len() as u64,
        content_type: content_type.to_string(),
        kind,
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Read the archive into a path→bytes map, refusing anything that would make
/// "the member at this path" ambiguous or unbounded.
fn read_entries(package: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, TilePackageError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(package)).map_err(|error| {
        TilePackageError::UnreadableArchive {
            detail: error.to_string(),
        }
    })?;
    let mut entries: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry =
            archive
                .by_index(index)
                .map_err(|error| TilePackageError::UnreadableArchive {
                    detail: error.to_string(),
                })?;
        if entry.is_dir() {
            continue;
        }
        // The archive's own name, normalized to forward slashes. A name that
        // escapes is refused here rather than after resolution, because the
        // entry itself is the attack.
        let name = entry.name().replace('\\', "/");
        if name.starts_with('/') || name.contains("../") || name.starts_with("..") {
            return Err(TilePackageError::PathTraversal {
                from: "package".to_string(),
                uri: name,
            });
        }
        let declared = entry.size();
        if declared > MAX_MEMBER_BYTES {
            return Err(TilePackageError::MemberTooLarge {
                path: name,
                size: declared,
                limit: MAX_MEMBER_BYTES,
            });
        }
        let mut bytes = Vec::with_capacity(declared.min(MAX_MEMBER_BYTES) as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| TilePackageError::UnreadableArchive {
                detail: error.to_string(),
            })?;
        // A header that disagrees with the bytes is either corruption or a
        // spoofed archive; either way the record would be a lie.
        if declared != bytes.len() as u64 {
            return Err(TilePackageError::SizeMismatch {
                path: name,
                declared,
                actual: bytes.len() as u64,
            });
        }
        // The archive reader resolves a duplicate name to its last entry, so
        // that is the member Kiriko records and serves. The record carries the
        // hash of the bytes actually read, so it cannot describe a copy that was
        // never accepted.
        entries.insert(name, bytes);
    }
    Ok(entries)
}

/// The root tileset: `tileset.json` at the package root, or the only tileset at
/// the root when the export named it something else.
fn find_root_tileset(entries: &BTreeMap<String, Vec<u8>>) -> Option<String> {
    if entries.contains_key("tileset.json") {
        return Some("tileset.json".to_string());
    }
    let mut candidates = entries
        .keys()
        .filter(|path| !path.contains('/') && path.ends_with(".json"));
    let first = candidates.next()?;
    // More than one root-level tileset makes the entry point ambiguous, and
    // guessing would pick a different building on a different export.
    if candidates.next().is_some() {
        return None;
    }
    Some(first.clone())
}

/// Resolve `uri` relative to the tileset at `from`, refusing anything that
/// leaves the package. No scheme, no authority, no absolute path, no escape
/// above the root — and the result is a package-relative path.
fn resolve(from: &str, uri: &str) -> Result<String, TilePackageError> {
    if uri.contains("://") || uri.starts_with("//") || uri.starts_with("file:") {
        return Err(TilePackageError::ExternalReference {
            from: from.to_string(),
            uri: uri.to_string(),
        });
    }
    let normalized = uri.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(TilePackageError::AbsolutePath {
            from: from.to_string(),
            uri: uri.to_string(),
        });
    }
    if normalized.contains('{') {
        // Template URIs belong to implicit tiling, which is refused earlier;
        // reaching here means a template without the declaration.
        return Err(TilePackageError::UnsupportedFeature {
            path: from.to_string(),
            feature: IMPLICIT_TILING.to_string(),
        });
    }

    let base: Vec<&str> = from.rsplit_once('/').map_or(Vec::new(), |(dir, _)| {
        dir.split('/').filter(|part| !part.is_empty()).collect()
    });
    let mut parts: Vec<&str> = base;
    for segment in normalized.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(TilePackageError::PathTraversal {
                        from: from.to_string(),
                        uri: uri.to_string(),
                    });
                }
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(TilePackageError::PathTraversal {
            from: from.to_string(),
            uri: uri.to_string(),
        });
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_to_the_referencing_tileset() {
        assert_eq!(
            resolve("tileset.json", "content/a.glb").unwrap(),
            "content/a.glb"
        );
        assert_eq!(
            resolve("levels/child.json", "../content/a.glb").unwrap(),
            "content/a.glb"
        );
        assert_eq!(
            resolve("levels/child.json", "./a.glb").unwrap(),
            "levels/a.glb"
        );
    }

    #[test]
    fn refuses_to_resolve_above_the_package_root() {
        assert!(matches!(
            resolve("tileset.json", "../secrets"),
            Err(TilePackageError::PathTraversal { .. })
        ));
        assert!(matches!(
            resolve("levels/child.json", "../../secrets"),
            Err(TilePackageError::PathTraversal { .. })
        ));
    }
}
