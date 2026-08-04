//! Gate 7 measurement helper: export one level's `Walkable` (optionally also
//! `Structure`) geometry from a `.kscene` as EPSG:4326 GeoJSON.
//!
//! The frame origin is read from the scene header (`frame_origin_ecef`) and
//! converted to geodetic WGS84; batch positions are dequantized to venue-local
//! ENU metres (`local = origin + position * scale`) and then projected to
//! lng/lat with a flat-earth tangent-plane approximation about the frame
//! origin — adequate at station scale (see the gate 7 report section).
//!
//! Output: one GeoJSON `Polygon` per triangle (closed 2D ring, `[lng, lat]`,
//! projected with the flat-earth contract formula) plus per-feature
//! `e_m`/`n_m` arrays carrying the native venue-local ENU metres (exact, the
//! coordinates the renderer uses) and a JSON stats sidecar `<out>.stats.json`
//! with vertex/triangle counts and bounding boxes in both local ENU metres and
//! lng/lat.
//!
//! Run: cargo run --release --manifest-path core/Cargo.toml -p kiriko-scene \
//!        --example export_level_outline -- <scene.kscene> <level-selector> <out.geojson> [--structure] [--roles Walkable,Stairs]
//!
//! Role selection: without flags, only `Walkable` batches are exported;
//! `--structure` adds `Structure`; `--roles A,B,C` (comma-separated, case-
//! insensitive) selects an explicit list and overrides both defaults.
//!
//! `level-selector` is resolved in order: exact `source_level_key` match, then
//! a 0-based level index, then a substring against the level's source key /
//! name / canonical id (first match wins).

use std::{env, fs, path::PathBuf};

use kiriko_scene::{decode_scene, SemanticRole};

/// All twelve semantic roles, in declaration order (used for `--roles`).
const ALL_ROLES: [SemanticRole; 12] = [
    SemanticRole::Walkable,
    SemanticRole::Public,
    SemanticRole::Service,
    SemanticRole::Restricted,
    SemanticRole::Structure,
    SemanticRole::Ceiling,
    SemanticRole::Opening,
    SemanticRole::Elevator,
    SemanticRole::Escalator,
    SemanticRole::Stairs,
    SemanticRole::Ramp,
    SemanticRole::Context,
];

const ROLE_LIST: &str = "Walkable, Public, Service, Restricted, Structure, Ceiling, Opening, Elevator, Escalator, Stairs, Ramp, Context";

/// Stable role names (the `Debug` spelling), independent of any display layer.
fn role_name(role: SemanticRole) -> String {
    format!("{role:?}")
}

/// WGS84 ellipsoid (used only to turn the header's ECEF origin into geodetic
/// coordinates; the flat-earth projection below is independent of this).
const WGS84_A: f64 = 6_378_137.0;
const WGS84_E2: f64 = 6.694_379_990_14e-3;

/// ECEF → geodetic WGS84 by fixed-point iteration on the parametric latitude.
fn ecef_to_geodetic(x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let lon = y.atan2(x);
    let p = (x * x + y * y).sqrt();
    let mut lat = z.atan2(p);
    let mut h = 0.0;
    for _ in 0..16 {
        let n = WGS84_A / (1.0 - WGS84_E2 * lat.sin() * lat.sin()).sqrt();
        h = p / lat.cos() - n;
        lat = z.atan2(p * (1.0 - WGS84_E2 * n / (n + h)));
    }
    (lon.to_degrees(), lat.to_degrees(), h)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!(
            "usage: export_level_outline <scene.kscene> <level-selector> <out.geojson> [--structure] [--roles Walkable,Stairs,...]"
        );
        std::process::exit(2);
    }
    let scene_path = PathBuf::from(&args[0]);
    let selector = &args[1];
    let out_path = PathBuf::from(&args[2]);
    let include_structure = args.iter().any(|arg| arg == "--structure");

    // `--roles A,B,C` overrides the default role selection; `--structure` is
    // kept for backward compatibility and is subsumed by an explicit list.
    let roles_flag = args.iter().position(|arg| arg == "--roles");
    let mut roles: Vec<SemanticRole> = match roles_flag {
        Some(idx) => {
            let list = args.get(idx + 1).map(|s| s.as_str()).unwrap_or("");
            let mut parsed = Vec::new();
            for name in list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let role = ALL_ROLES.iter().find(|role| {
                    role_name(**role).eq_ignore_ascii_case(name)
                });
                match role {
                    Some(role) => parsed.push(*role),
                    None => {
                        eprintln!("unknown role {:?} in --roles (valid: {})", name, ROLE_LIST);
                        std::process::exit(2);
                    }
                }
            }
            if parsed.is_empty() {
                eprintln!("--roles requires at least one role name");
                std::process::exit(2);
            }
            parsed
        }
        None => {
            if include_structure {
                vec![SemanticRole::Walkable, SemanticRole::Structure]
            } else {
                vec![SemanticRole::Walkable]
            }
        }
    };
    roles.dedup();

    let bytes = fs::read(&scene_path)?;
    let doc = decode_scene(&bytes)?;

    // Resolve the level: exact key match, then numeric index, then substring
    // against the composite source identity fields.
    let level_index = doc
        .levels
        .iter()
        .position(|level| level.source_level_key == *selector)
        .or_else(|| selector.parse::<usize>().ok())
        .or_else(|| {
            doc.levels
                .iter()
                .position(|level| {
                    level.source_level_key.contains(selector)
                        || level.source_level_name.contains(selector)
                        || level.canonical_id.contains(selector)
                })
                .or_else(|| {
                    doc.levels
                        .iter()
                        .position(|level| level.source_level_key.eq_ignore_ascii_case(selector))
                })
        });
    let level_index = match level_index {
        Some(index) if index < doc.levels.len() => index,
        _ => {
            eprintln!(
                "level selector {:?} matched no level ({} levels available)",
                selector,
                doc.levels.len()
            );
            for (index, level) in doc.levels.iter().enumerate() {
                eprintln!("  {index}: {} — {}", level.source_level_key, level.source_level_name);
            }
            std::process::exit(3);
        }
    };
    let level = &doc.levels[level_index];

    // Geodetic frame origin.
    let (lng0, lat0, altitude) = ecef_to_geodetic(
        doc.header.frame_origin_ecef[0],
        doc.header.frame_origin_ecef[1],
        doc.header.frame_origin_ecef[2],
    );
    let lat0_rad = lat0.to_radians();
    let m_per_deg_lat = 110_540.0;
    let m_per_deg_lng = 111_320.0 * lat0_rad.cos();

    // Collect the level's batches for the requested roles.
    let batches: Vec<&kiriko_scene::SceneBatch> = doc
        .batches
        .iter()
        .filter(|batch| batch.level_index as usize == level_index && roles.contains(&batch.role))
        .collect();
    if batches.is_empty() {
        eprintln!(
            "level {} has no {:?} batches",
            level.source_level_key, roles
        );
        std::process::exit(4);
    }

    // Dequantize → ENU metres → lng/lat, emitting one Polygon per triangle.
    let mut features: Vec<serde_json::Value> = Vec::new();
    let mut min_e = f64::INFINITY;
    let mut max_e = f64::NEG_INFINITY;
    let mut min_n = f64::INFINITY;
    let mut max_n = f64::NEG_INFINITY;
    let mut vertices = 0usize;
    let mut triangles = 0usize;
    for batch in &batches {
        let origin = batch.quantization_origin;
        let scale = batch.quantization_scale;
        let mut ring: Vec<[f64; 2]> = Vec::with_capacity(4);
        // `feature_indices` runs parallel to `positions` (one entry per
        // vertex, set by the deriver), so each triangle's source feature is
        // `doc.features[batch.feature_indices[first_vertex]]`.
        let mut vertex_in_batch = 0usize;
        for chunk in batch.positions.chunks_exact(3) {
            let feature_index = batch
                .feature_indices
                .get(vertex_in_batch)
                .map(|&idx| idx as usize)
                .filter(|&idx| idx < doc.features.len())
                .unwrap_or(usize::MAX);
            let source_id = doc
                .features
                .get(feature_index)
                .map(|f| f.source_object_id.as_str())
                .unwrap_or("");
            let mut z_sum = 0.0_f64;
            let mut enu: Vec<[f64; 2]> = Vec::with_capacity(3);
            for quantized in chunk {
                vertex_in_batch += 1;
                let local_x = origin[0] + f32::from(quantized[0]) * scale[0];
                let local_y = origin[1] + f32::from(quantized[1]) * scale[1];
                let local_z = origin[2] + f32::from(quantized[2]) * scale[2];
                let east = local_x as f64;
                let north = local_y as f64;
                let lng = lng0 + east / m_per_deg_lng;
                let lat = lat0 + north / m_per_deg_lat;
                min_e = min_e.min(east);
                max_e = max_e.max(east);
                min_n = min_n.min(north);
                max_n = max_n.max(north);
                z_sum += f64::from(local_z);
                enu.push([east, north]);
                ring.push([lng, lat]);
            }
            ring.push(ring[0]);
            features.push(serde_json::json!({
                "type": "Feature",
                "properties": {
                    "role": format!("{:?}", batch.role),
                    "level_key": level.source_level_key,
                    "level_name": level.source_level_name,
                    "elevation_m": level.source_elevation_meters,
                    "resolved_plane_z": level.resolved_plane_z,
                    // Source feature identity (per triangle): the index into
                    // the scene's feature table and the GLB revitUniqueId it
                    // was derived from, empty when the batch has no mapping.
                    "feature_index": if feature_index == usize::MAX { -1i64 } else { feature_index as i64 },
                    "source_id": source_id,
                    "z_m": z_sum / 3.0,
                    // Native venue-local ENU metres (frame origin = header's
                    // frame_origin_ecef). These are the exact coordinates the
                    // renderer uses; the GeoJSON ring is the flat-earth display
                    // projection of them (contract formula).
                    "e_m": enu.iter().map(|p| p[0]).collect::<Vec<_>>(),
                    "n_m": enu.iter().map(|p| p[1]).collect::<Vec<_>>(),
                },
                "geometry": { "type": "Polygon", "coordinates": [ring] },
            }));
            ring.clear();
            triangles += 1;
            vertices += 3;
        }
    }

    let collection = serde_json::json!({
        "type": "FeatureCollection",
        "properties": {
            "level_index": level_index,
            "level_key": level.source_level_key,
            "level_name": level.source_level_name,
            "frame_origin": { "lng": lng0, "lat": lat0, "altitude_m": altitude },
            "resolved_plane_z": level.resolved_plane_z,
            "roles": roles.iter().map(|r| role_name(*r)).collect::<Vec<_>>(),
        },
        "features": features,
    });

    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&out_path, serde_json::to_vec(&collection)?)?;

    let stats = serde_json::json!({
        "level_index": level_index,
        "level_key": level.source_level_key,
        "level_name": level.source_level_name,
        "frame_origin_lng": lng0,
        "frame_origin_lat": lat0,
        "frame_origin_altitude_m": altitude,
        "resolved_plane_z": level.resolved_plane_z,
        "roles": roles.iter().map(|r| role_name(*r)).collect::<Vec<_>>(),
        "vertices": vertices,
        "triangles": triangles,
        "bbox_local_en_m": [min_e, min_n, max_e, max_n],
        "bbox_lnglat": [
            lng0 + min_e / m_per_deg_lng,
            lat0 + min_n / m_per_deg_lat,
            lng0 + max_e / m_per_deg_lng,
            lat0 + max_n / m_per_deg_lat,
        ],
    });
    let stats_path = out_path.with_extension("stats.json");
    fs::write(&stats_path, serde_json::to_vec_pretty(&stats)?)?;

    println!(
        "level {} ({}): {} triangles, {} vertices",
        level.source_level_key, level.source_level_name, triangles, vertices
    );
    println!("frame origin: lng {lng0}, lat {lat0}, altitude {altitude} m");
    println!("local ENU bbox: E [{min_e}, {max_e}] m, N [{min_n}, {max_n}] m");
    Ok(())
}
