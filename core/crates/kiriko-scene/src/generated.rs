//! The Generated scene producer: a bundle's §9 semantic primitives plus §8
//! spatial context compiled into the KSC1 render document the Tiles deriver
//! also emits. One render format means one renderer, so a source can never
//! fork the visual language (issue #23, decision D4).
//!
//! The one thing this module derives is doorway voids: a portal's opening
//! quad states where its host wall is passable, so the wall compiles with
//! that span actually missing — full-height side pieces and a lintel above
//! the opening — instead of hiding a solid quad behind the portal's
//! translucent marker. Everything else this module does *not* do is as
//! load-bearing as what it does. It resolves no elevation (§8 already did,
//! with recorded method and confidence), interprets no source property, and
//! guesses no transport type: a conveyance whose canonical unit is unknown
//! compiles to [`SemanticRole::Conveyance`], never to an escalator that looks
//! authored. Provenance beyond what the renderer draws stays in the semantic
//! projection (issue #53), which is the authority the UI reads.

use std::collections::BTreeMap;

use kiriko_model::model::{FeatureType, VenueFeature};
use kiriko_model::scene::{Mesh, PrimitiveGeometry, PrimitiveRole, ScenePrimitive, SceneSection};
use kiriko_model::spatial::SpatialContext;
use sha2::{Digest, Sha256};

use crate::SceneError;
use crate::format::{
    SceneBatch, SceneDocument, SceneFeature, SceneHeader, SceneLevel, SemanticRole,
};
use crate::quantize::{encode_normal_oct, quantize_positions};
use crate::roles::occlusion_for_role;

/// Bumped when this producer's output changes for unchanged input.
const GENERATED_PRODUCER_VERSION: u16 = 5;

/// The render format this producer writes.
const SCENE_FORMAT_VERSION: u16 = 1;

const MM_PER_M: f32 = 1_000.0;

/// One primitive's triangle-list geometry in venue-local metres, plus the
/// vertical extent the pick pass and floor filtering read.
struct Triangles {
    /// Triangle-list vertices; every three form one facet.
    vertices: Vec<[f32; 3]>,
    /// Per-vertex normal, flat across each facet.
    normals: Vec<[f32; 3]>,
    min_z: f32,
    max_z: f32,
}

/// How far a portal's endpoints may sit off a wall's line and still count as
/// doorways in it. §8 accepts an opening whose endpoints lie on a unit
/// boundary within its corroboration tolerance (200 mm in the default
/// profile), so this matches that acceptance with margin; it stays far below
/// any plausible distance between two parallel walls.
const DOORWAY_LINE_TOLERANCE_MM: f64 = 250.0;

/// Wall pieces narrower than this are dropped rather than drawn: a sliver
/// between two nearly-touching doorways reads as rendering dirt, not as wall.
const MIN_WALL_PIECE_MM: i64 = 10;

/// A doorway void a portal declares over its level plane, in millimetres.
struct Doorway {
    /// The opening's base segment endpoints, venue-local.
    a: [i64; 2],
    b: [i64; 2],
    /// The void's top edge above the level plane.
    top_z_mm: i64,
}

/// Compile a bundle's §9 scene into the shared render document.
///
/// `features` supplies the canonical venue features whose IMDF categories
/// refine a primitive's semantic role; a primitive with no canonical feature
/// keeps the role its §9 class alone can justify.
///
/// # Errors
///
/// Returns [`SceneError::UnplaceablePrimitive`] when a primitive names a level
/// the spatial context does not carry: a scene Kiriko cannot place is not
/// renderable, and silently dropping the geometry would hide a real defect.
pub fn compile_generated_scene(
    scene: &SceneSection,
    spatial: &SpatialContext,
    features: &[VenueFeature],
) -> Result<SceneDocument, SceneError> {
    let levels = compile_levels(spatial);
    let level_indices: BTreeMap<&str, u32> = spatial
        .levels
        .iter()
        .enumerate()
        .map(|(index, record)| (record.level_id.as_str(), index as u32))
        .collect();
    let categories: BTreeMap<&str, (FeatureType, Option<&str>)> = features
        .iter()
        .map(|feature| {
            (
                feature.id.as_str(),
                (feature.feature_type, feature.category.as_deref()),
            )
        })
        .collect();

    // Geometry accumulates per (level, role) so a visible floor draws in a
    // handful of calls rather than once per primitive.
    let mut batched: BTreeMap<(u32, u8), BatchAccumulator> = BTreeMap::new();
    let mut scene_features: Vec<SceneFeature> = Vec::with_capacity(scene.primitives.len());
    let mut bounds_min = [f32::INFINITY; 3];
    let mut bounds_max = [f32::NEG_INFINITY; 3];
    // Doorway voids per level, collected before batching so a wall compiles
    // with the gaps its openings state rather than under their translucent
    // markers. A portal whose opening is not the authored vertical quad adds
    // nothing: cutting never guesses about shapes it was not built to see.
    let mut doorways: BTreeMap<&str, Vec<Doorway>> = BTreeMap::new();
    for primitive in &scene.primitives {
        if let PrimitiveGeometry::Portal { opening, .. } = &primitive.geometry {
            if let Some((a, b, _, top_z_mm)) = vertical_quad(opening) {
                doorways
                    .entry(primitive.level_id.as_str())
                    .or_default()
                    .push(Doorway { a, b, top_z_mm });
            }
        }
    }

    for primitive in &scene.primitives {
        let level_index = *level_indices
            .get(primitive.level_id.as_str())
            .ok_or_else(|| SceneError::UnplaceablePrimitive {
                primitive: primitive.id.clone(),
                level: primitive.level_id.clone(),
            })?;

        let role = semantic_role(primitive, &categories);
        // Walls compile with their portals' voids cut out; evidenced
        // conveyances compile as illustrative forms (stepped stairs, an
        // inclined escalator, an elevator shaft). Everything else contributes
        // exactly the mesh §9 carries.
        let shaped;
        let mesh_ref: &Mesh = match primitive.role {
            PrimitiveRole::Wall => {
                let doorways = doorways
                    .get(primitive.level_id.as_str())
                    .map_or(&[][..], Vec::as_slice);
                shaped = cut_doorways(mesh_of(primitive), doorways);
                &shaped
            }
            PrimitiveRole::Conveyance => {
                shaped = reshape_conveyance(primitive, role, spatial)
                    .unwrap_or_else(|| mesh_of(primitive).clone());
                &shaped
            }
            _ => mesh_of(primitive),
        };
        let triangles = triangulate(mesh_ref);
        let expanded_colors = match &primitive.geometry {
            PrimitiveGeometry::TintedMesh {
                mesh,
                vertex_colors,
            } => {
                if vertex_colors.len() != mesh.positions.len() {
                    return Err(SceneError::InvalidIllustrationTint {
                        primitive: primitive.id.clone(),
                    });
                }
                Some(expand_vertex_colors(mesh, vertex_colors))
            }
            _ => None,
        };
        let feature_index = scene_features.len() as u32;

        scene_features.push(SceneFeature {
            source_object_id: primitive.id.clone(),
            canonical_id: primitive.canonical_feature_id.clone(),
            level_index,
            role,
            occlusion: occlusion_for_role(role),
            confidence: confidence_byte(spatial, primitive.confidence_ref),
            min_z: triangles.min_z,
            max_z: triangles.max_z,
        });

        for vertex in &triangles.vertices {
            for axis in 0..3 {
                bounds_min[axis] = bounds_min[axis].min(vertex[axis]);
                bounds_max[axis] = bounds_max[axis].max(vertex[axis]);
            }
        }

        let accumulator = batched
            .entry((level_index, role_key(role)))
            .or_insert_with(|| BatchAccumulator::new(role));
        accumulator.push(&triangles, feature_index, expanded_colors.as_deref());
    }

    if scene_features.is_empty() {
        bounds_min = [0.0; 3];
        bounds_max = [0.0; 3];
    }

    let batches: Vec<SceneBatch> = batched
        .into_iter()
        .map(|((level_index, _), accumulator)| accumulator.finish(level_index))
        .collect();

    let header = SceneHeader {
        format_version: SCENE_FORMAT_VERSION,
        deriver_version: GENERATED_PRODUCER_VERSION,
        source_hash: source_hash(scene, spatial),
        frame_origin_ecef: spatial.frame.ecef_origin,
        world_transform: world_transform(spatial),
        bounds_min,
        bounds_max,
    };

    Ok(SceneDocument {
        header,
        levels,
        features: scene_features,
        batches,
    })
}

/// §8's resolved planes, in the order §8 records them — that order is this
/// document's level index space.
fn compile_levels(spatial: &SpatialContext) -> Vec<SceneLevel> {
    spatial
        .levels
        .iter()
        .map(|record| SceneLevel {
            canonical_id: record.level_id.clone(),
            // The generated source has no composite source level: it is
            // compiled from the venue's own features, so there is no source
            // document, layer, or level key to carry. §8's resolution method
            // and evidence are the provenance, read through issue #53's
            // projection.
            source_level_key: String::new(),
            source_level_name: String::new(),
            source_document: String::new(),
            source_link_name: String::new(),
            source_elevation_meters: record.source_elevation_m.map(|metres| metres as f32),
            resolved_plane_z: record.resolved_scene_z_mm as f32 / MM_PER_M,
            quantized_elevation_dm: (record.resolved_scene_z_mm / 100) as i32,
        })
        .collect()
}

/// The §9 geometry a primitive contributes to the scene. A portal renders its
/// opening; the topology pair it also carries is a relation, not geometry.
fn mesh_of(primitive: &ScenePrimitive) -> &Mesh {
    match &primitive.geometry {
        PrimitiveGeometry::Mesh(mesh) => mesh,
        PrimitiveGeometry::Portal { opening, .. } => opening,
        PrimitiveGeometry::Conveyance { mesh, .. } => mesh,
        PrimitiveGeometry::TintedMesh { mesh, .. } => mesh,
    }
}

/// The vertical quad a §9 wall or portal opening compiles from: base
/// segment endpoints plus the z extent. `None` for any other shape — a mesh
/// with more than two distinct ground points is not the quad these
/// primitives are authored as, and cutting never guesses.
fn vertical_quad(mesh: &Mesh) -> Option<([i64; 2], [i64; 2], i64, i64)> {
    if mesh.positions.len() != 4 {
        return None;
    }
    let mut ends: Vec<[i64; 2]> = Vec::with_capacity(2);
    let (mut z_min, mut z_max) = (i64::MAX, i64::MIN);
    for position in &mesh.positions {
        z_min = z_min.min(position[2]);
        z_max = z_max.max(position[2]);
        let ground = [position[0], position[1]];
        if !ends.contains(&ground) {
            ends.push(ground);
        }
    }
    match ends.as_slice() {
        [a, b] => Some((*a, *b, z_min, z_max)),
        _ => None,
    }
}

/// Subtract doorway voids from a wall quad: full-height pieces where no
/// doorway stands, and a lintel above each doorway up to the wall top. A
/// wall no doorway lies on comes back unchanged; a wall a doorway fully
/// covers comes back empty.
fn cut_doorways(mesh: &Mesh, doorways: &[Doorway]) -> Mesh {
    let Some((a, b, z_bottom, z_top)) = vertical_quad(mesh) else {
        return mesh.clone();
    };
    let dir = [b[0] - a[0], b[1] - a[1]];
    let len2 = i128::from(dir[0]) * i128::from(dir[0]) + i128::from(dir[1]) * i128::from(dir[1]);
    if len2 == 0 {
        return mesh.clone();
    }
    let length = (len2 as f64).sqrt();

    // Each doorway's covered span as arc length along the wall, or skip: an
    // opening off the wall's line or off its extent cuts nothing.
    let mut voids: Vec<(f64, f64, i64)> = Vec::new();
    for doorway in doorways {
        let on_line = |p: [i64; 2]| -> bool {
            let rel = [
                i128::from(p[0]) - i128::from(a[0]),
                i128::from(p[1]) - i128::from(a[1]),
            ];
            let cross = rel[0] * i128::from(dir[1]) - rel[1] * i128::from(dir[0]);
            (cross as f64).abs() / length <= DOORWAY_LINE_TOLERANCE_MM
        };
        if !on_line(doorway.a) || !on_line(doorway.b) {
            continue;
        }
        let along = |p: [i64; 2]| -> f64 {
            let dot = (i128::from(p[0]) - i128::from(a[0])) * i128::from(dir[0])
                + (i128::from(p[1]) - i128::from(a[1])) * i128::from(dir[1]);
            (dot as f64 / len2 as f64).clamp(0.0, 1.0) * length
        };
        let (s0, s1) = (along(doorway.a), along(doorway.b));
        let (start, end) = (s0.min(s1), s0.max(s1));
        if end - start < MIN_WALL_PIECE_MM as f64 {
            continue;
        }
        voids.push((start, end, doorway.top_z_mm.clamp(z_bottom, z_top)));
    }
    if voids.is_empty() {
        return mesh.clone();
    }
    voids.sort_by(|left, right| left.0.total_cmp(&right.0));

    // Overlapping doorways merge into one span open to the taller top, so
    // two competing lintels never stand in the same gap — and spans separated
    // by less than a survivable wall piece merge too, since no pillar could
    // stand in a gap that thin.
    let mut merged: Vec<(f64, f64, i64)> = Vec::new();
    for (start, end, top) in voids {
        match merged.last_mut() {
            Some(last) if start - last.1 <= MIN_WALL_PIECE_MM as f64 => {
                last.1 = last.1.max(end);
                last.2 = last.2.max(top);
            }
            _ => merged.push((start, end, top)),
        }
    }

    let point = |offset: f64| -> [i64; 2] {
        let t = offset / length;
        [
            a[0] + (i128::from(dir[0]) as f64 * t).round() as i64,
            a[1] + (i128::from(dir[1]) as f64 * t).round() as i64,
        ]
    };

    let mut positions: Vec<[i64; 3]> = Vec::new();
    let mut faces: Vec<[u32; 3]> = Vec::new();
    {
        let mut quad = |p: [i64; 2], q: [i64; 2], bottom: i64, top: i64| {
            let base = positions.len() as u32;
            positions.extend([
                [p[0], p[1], bottom],
                [q[0], q[1], bottom],
                [q[0], q[1], top],
                [p[0], p[1], top],
            ]);
            faces.extend([[base, base + 1, base + 2], [base, base + 2, base + 3]]);
        };
        let mut cursor = 0.0_f64;
        for (start, end, top) in merged {
            if (start - cursor) as i64 >= MIN_WALL_PIECE_MM {
                quad(point(cursor), point(start), z_bottom, z_top);
            }
            if z_top - top >= MIN_WALL_PIECE_MM {
                quad(point(start), point(end), top, z_top);
            }
            cursor = cursor.max(end);
        }
        if (length - cursor) as i64 >= MIN_WALL_PIECE_MM {
            quad(point(cursor), point(length), z_bottom, z_top);
        }
    }
    Mesh { positions, faces }
}

// -- Illustrative conveyance forms ------------------------------------------

/// Nominal stair riser. Steps are an illustration, not a measurement: the
/// run divides so each step lands near this height.
const STAIR_RISER_MM: f64 = 175.0;
/// Escalator balustrade height above the deck.
const ESCALATOR_RAIL_H_MM: i64 = 950;
/// Fraction of the run given to a flat comb platform at each end.
const ESCALATOR_COMB_FRAC: f64 = 0.12;
/// Elevator door panel width and roof slab thickness.
const ELEVATOR_DOOR_W_MM: f64 = 1800.0;
const ELEVATOR_ROOF_MM: i64 = 120;

/// A conveyance footprint's run: centre-line endpoints and the half-width
/// vector, recovered from the ground outline of §9's neutral mesh. The
/// longest hull edge gives the axis; extents along it give the span. A
/// rectangle — the shape transit footprints come in — recovers exactly.
struct Run {
    /// Centre-line endpoints, venue-local millimetres.
    a: [f64; 2],
    b: [f64; 2],
    /// Half-width vector pointing to one side of the line.
    w: [f64; 2],
}

fn vsub(p: [f64; 2], q: [f64; 2]) -> [f64; 2] {
    [p[0] - q[0], p[1] - q[1]]
}
fn vadd(p: [f64; 2], q: [f64; 2]) -> [f64; 2] {
    [p[0] + q[0], p[1] + q[1]]
}
fn vscale(p: [f64; 2], s: f64) -> [f64; 2] {
    [p[0] * s, p[1] * s]
}
fn vlen(p: [f64; 2]) -> f64 {
    (p[0] * p[0] + p[1] * p[1]).sqrt()
}
fn vunit(p: [f64; 2]) -> [f64; 2] {
    let l = vlen(p);
    if l <= 0.0 {
        [1.0, 0.0]
    } else {
        vscale(p, 1.0 / l)
    }
}

/// The footprint `Run` of a mesh, or `None` when the ground outline is too
/// degenerate to illustrate.
fn footprint_run(mesh: &Mesh) -> Option<Run> {
    let z_min = mesh.positions.iter().map(|p| p[2]).min()?;
    let mut pts: Vec<[i64; 2]> = Vec::new();
    for position in &mesh.positions {
        if position[2] != z_min {
            continue;
        }
        let ground = [position[0], position[1]];
        if !pts.contains(&ground) {
            pts.push(ground);
        }
    }
    if pts.len() < 3 {
        return None;
    }
    // Monotone chain hull over the distinct ground points.
    pts.sort();
    let cross = |o: [i64; 2], a: [i64; 2], b: [i64; 2]| -> i128 {
        i128::from(a[0] - o[0]) * i128::from(b[1] - o[1])
            - i128::from(a[1] - o[1]) * i128::from(b[0] - o[0])
    };
    let mut lower: Vec<[i64; 2]> = Vec::new();
    for p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], *p) <= 0 {
            lower.pop();
        }
        lower.push(*p);
    }
    let mut upper: Vec<[i64; 2]> = Vec::new();
    for p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], *p) <= 0 {
            upper.pop();
        }
        upper.push(*p);
    }
    lower.pop();
    upper.pop();
    let hull: Vec<[i64; 2]> = lower.into_iter().chain(upper.into_iter()).collect();

    // Longest hull edge sets the run axis.
    let mut best: Option<([i64; 2], [i64; 2], u128)> = None;
    for i in 0..hull.len() {
        let s = hull[i];
        let t = hull[(i + 1) % hull.len()];
        let d = [i128::from(t[0] - s[0]), i128::from(t[1] - s[1])];
        let l2 = (d[0] * d[0] + d[1] * d[1]) as u128;
        if best.map_or(true, |(_, _, bl)| l2 > bl) {
            best = Some((s, t, l2));
        }
    }
    let (s, t, l2) = best?;
    if l2 == 0 {
        return None;
    }
    let s = [s[0] as f64, s[1] as f64];
    let u = vunit([t[0] as f64 - s[0], t[1] as f64 - s[1]]);
    let n = [-u[1], u[0]];
    let mut run_lo = f64::INFINITY;
    let mut run_hi = f64::NEG_INFINITY;
    let mut cross_lo = f64::INFINITY;
    let mut cross_hi = f64::NEG_INFINITY;
    for p in &hull {
        let rel = [p[0] as f64 - s[0], p[1] as f64 - s[1]];
        let along = rel[0] * u[0] + rel[1] * u[1];
        let across = rel[0] * n[0] + rel[1] * n[1];
        run_lo = run_lo.min(along);
        run_hi = run_hi.max(along);
        cross_lo = cross_lo.min(across);
        cross_hi = cross_hi.max(across);
    }
    let half_w = (cross_hi - cross_lo) / 2.0;
    if run_hi - run_lo < 500.0 || half_w < 200.0 {
        return None;
    }
    let centre_offset = vscale(n, (cross_lo + cross_hi) / 2.0);
    Some(Run {
        a: vadd(vadd(s, vscale(u, run_lo)), centre_offset),
        b: vadd(vadd(s, vscale(u, run_hi)), centre_offset),
        w: vscale(n, half_w),
    })
}

/// Solid box from ground segment `p`–`q` widened by `w`: four walls plus a
/// lid, no bottom. Appends to `out`.
fn push_box(out: &mut Mesh, p: [f64; 2], q: [f64; 2], w: [f64; 2], z0: i64, z1: i64) {
    let g = |pt: [f64; 2]| [pt[0].round() as i64, pt[1].round() as i64];
    let corners = [vsub(p, w), vsub(q, w), vadd(q, w), vadd(p, w)];
    let base = out.positions.len() as u32;
    for c in corners {
        out.positions.push([g(c)[0], g(c)[1], z0]);
    }
    for c in corners {
        out.positions.push([g(c)[0], g(c)[1], z1]);
    }
    let t = base + 4;
    let mut quad = |a: u32, b: u32, c: u32, d: u32| {
        out.faces.push([a, b, c]);
        out.faces.push([a, c, d]);
    };
    quad(base, base + 1, t + 1, t);
    quad(base + 1, base + 2, t + 2, t + 1);
    quad(base + 2, base + 3, t + 3, t + 2);
    quad(base + 3, base, t, t + 3);
    quad(t, t + 1, t + 2, t + 3);
}

/// A stepped run rising from `z0` to `z1` along the footprint.
fn stair_mesh(run: &Run, z0: i64, z1: i64) -> Mesh {
    let rise = (z1 - z0).max(1) as f64;
    let steps = (rise / STAIR_RISER_MM).round().max(1.0);
    let mut mesh = Mesh {
        positions: Vec::new(),
        faces: Vec::new(),
    };
    for i in 0..(steps as i64) {
        let top = z0 + ((i + 1) as f64 / steps * rise).round() as i64;
        push_box(
            &mut mesh,
            vadd(run.a, vscale(vsub(run.b, run.a), i as f64 / steps)),
            vadd(run.a, vscale(vsub(run.b, run.a), (i + 1) as f64 / steps)),
            run.w,
            z0,
            top,
        );
    }
    mesh
}

/// An inclined deck with side balustrades and flat comb platforms at both
/// landings.
fn escalator_mesh(run: &Run, z0: i64, z1: i64) -> Mesh {
    let mut mesh = Mesh {
        positions: Vec::new(),
        faces: Vec::new(),
    };
    // Deck: one inclined quad, both sides visible (the renderer culls nothing).
    let base = mesh.positions.len() as u32;
    let deck_corners = [
        vsub(run.a, run.w),
        vadd(run.a, run.w),
        vadd(run.b, run.w),
        vsub(run.b, run.w),
    ];
    for (pt, z) in [
        (deck_corners[0], z0),
        (deck_corners[1], z0),
        (deck_corners[2], z1),
        (deck_corners[3], z1),
    ] {
        mesh.positions
            .push([pt[0].round() as i64, pt[1].round() as i64, z]);
    }
    mesh.faces.push([base, base + 1, base + 2]);
    mesh.faces.push([base, base + 2, base + 3]);
    // Balustrades: bands raised along both deck edges.
    let u = vunit(vsub(run.b, run.a));
    for s in [-1.0, 1.0] {
        let edge = vscale(run.w, s);
        let pa = vadd(run.a, edge);
        let pb = vadd(run.b, edge);
        let pb_base = mesh.positions.len() as u32;
        for (p, z) in [
            (pa, z0),
            (pb, z1),
            (pb, z1 + ESCALATOR_RAIL_H_MM),
            (pa, z0 + ESCALATOR_RAIL_H_MM),
        ] {
            mesh.positions
                .push([p[0].round() as i64, p[1].round() as i64, z]);
        }
        mesh.faces.push([pb_base, pb_base + 1, pb_base + 2]);
        mesh.faces.push([pb_base, pb_base + 2, pb_base + 3]);
    }
    // Comb platforms at both landings, slightly wider than the deck.
    let comb_len = vlen(vsub(run.b, run.a)) * ESCALATOR_COMB_FRAC;
    let wide = vscale(run.w, 1.08);
    push_box(
        &mut mesh,
        run.a,
        vadd(run.a, vscale(u, comb_len.max(400.0))),
        wide,
        z0,
        z0 + 100,
    );
    push_box(
        &mut mesh,
        vadd(run.b, vscale(u, -comb_len.max(400.0))),
        run.b,
        wide,
        z1,
        z1 + 100,
    );
    mesh
}

/// An elevator shaft with door panels on both long faces and a roof slab.
fn elevator_mesh(run: &Run, z0: i64, z1: i64) -> Mesh {
    let mut mesh = Mesh {
        positions: Vec::new(),
        faces: Vec::new(),
    };
    push_box(&mut mesh, run.a, run.b, run.w, z0, z1);
    let span = vsub(run.b, run.a);
    let u = vunit(span);
    let mid = vadd(run.a, vscale(span, 0.5));
    let door_w = (vlen(span) * 0.4).min(ELEVATOR_DOOR_W_MM).max(600.0);
    let wn = vunit(run.w);
    let wl = vlen(run.w);
    for s in [-1.0, 1.0] {
        let face_mid = vadd(mid, vscale(wn, wl * s));
        push_box(
            &mut mesh,
            vsub(face_mid, vscale(u, door_w / 2.0)),
            vadd(face_mid, vscale(u, door_w / 2.0)),
            vscale(wn, 60.0 * s),
            z0,
            (z0 + 2100).min(z1),
        );
    }
    push_box(
        &mut mesh,
        run.a,
        run.b,
        vscale(run.w, 1.06),
        z1,
        z1 + ELEVATOR_ROOF_MM,
    );
    mesh
}

/// Rebuild an evidenced conveyance as its illustrative form. Untyped forms,
/// ramps, and anything whose level has no plane above keep §9's neutral
/// geometry: the never-guess rule applies to shapes too.
fn reshape_conveyance(
    primitive: &ScenePrimitive,
    role: SemanticRole,
    spatial: &SpatialContext,
) -> Option<Mesh> {
    match role {
        SemanticRole::Stairs | SemanticRole::Escalator | SemanticRole::Elevator => {}
        _ => return None,
    }
    let mesh = mesh_of(primitive);
    let z_bottom = mesh.positions.iter().map(|p| p[2]).min()?;
    let current = spatial
        .levels
        .iter()
        .find(|l| l.level_id == primitive.level_id)?;
    let z_top = spatial
        .levels
        .iter()
        .map(|l| l.resolved_scene_z_mm)
        .filter(|z| *z > current.resolved_scene_z_mm)
        .min()?;
    let run = footprint_run(mesh)?;
    Some(match role {
        SemanticRole::Stairs => stair_mesh(&run, z_bottom, z_top),
        SemanticRole::Escalator => escalator_mesh(&run, z_bottom, z_top),
        _ => elevator_mesh(&run, z_bottom, z_top),
    })
}

/// A primitive's semantic role: its §9 class, refined by the canonical
/// feature's IMDF category when one is associated.
fn semantic_role(
    primitive: &ScenePrimitive,
    categories: &BTreeMap<&str, (FeatureType, Option<&str>)>,
) -> SemanticRole {
    let canonical = primitive
        .canonical_feature_id
        .as_deref()
        .and_then(|id| categories.get(id))
        .copied();

    match primitive.role {
        PrimitiveRole::Wall => SemanticRole::Structure,
        PrimitiveRole::Ceiling => SemanticRole::Ceiling,
        PrimitiveRole::Portal => SemanticRole::Opening,
        PrimitiveRole::Conveyance => match canonical.and_then(|(_, category)| category) {
            // Only a conveyance category the source actually states may type
            // the form; anything else stays an untyped conveyance.
            Some(category) => conveyance_role(category).unwrap_or(SemanticRole::Conveyance),
            None => SemanticRole::Conveyance,
        },
        PrimitiveRole::Surface => match canonical {
            // A level slab is the whole floor's plate: contextual mass, not a
            // claim that every square metre of it is navigable. It is also
            // coplanar with the unit finishes that sit on it, and the renderer
            // resolves that by drawing contextual mass first and biased back —
            // so the plate must not share a role with the finishes.
            Some((FeatureType::Level, _)) => SemanticRole::Context,
            Some((_, Some(category))) => surface_role(category),
            // A surface with no category to read is contextual mass; it never
            // becomes navigable by default.
            Some((_, None)) | None => SemanticRole::Context,
        },
        // A fixture compiles as its illustrative form — today, the fare-gate
        // row §9 emits for it.
        PrimitiveRole::Fixture => SemanticRole::TicketGate,
    }
}

/// IMDF unit categories that name a conveyance's transport type.
fn conveyance_role(category: &str) -> Option<SemanticRole> {
    match category {
        "elevator" => Some(SemanticRole::Elevator),
        "escalator" => Some(SemanticRole::Escalator),
        "stairs" | "steps" => Some(SemanticRole::Stairs),
        "ramp" | "movingwalkway" => Some(SemanticRole::Ramp),
        _ => None,
    }
}

/// Map an IMDF unit category onto a surface role. The IMDF category vocabulary
/// is closed, so this matches exact values rather than guessing at substrings;
/// an unlisted category is public floor rather than navigable walkway.
fn surface_role(category: &str) -> SemanticRole {
    if let Some(role) = conveyance_role(category) {
        return role;
    }
    match category {
        // Circulation: the surfaces a route may traverse.
        "walkway" | "pedestrian" | "concourse" | "corridor" | "lobby" | "plaza" | "footbridge"
        | "parkingcirculation" | "platform" | "walkwayisland" => SemanticRole::Walkable,
        // Public occupiable space.
        "room" | "shop" | "restaurant" | "restroom" | "restroom.female" | "restroom.male"
        | "restroom.unisex" | "restroom.family" | "waitingroom" | "auditorium" | "classroom"
        | "library" | "lounge" | "recreation" | "terrace" | "vegetation" | "exhibit"
        | "fieldofplay" | "foodservice" | "conferenceroom" | "privatelounge" => {
            SemanticRole::Public
        }
        // Building operations.
        "office" | "mechanicalroom" | "electricalroom" | "serverroom" | "storage" | "structure"
        | "utilityroom" | "serviceyard" | "loadingdock" | "phoneroom" | "smokingarea"
        | "laboratory" | "kitchen" => SemanticRole::Service,
        // Access-controlled space.
        "nonpublic" | "restricted" | "unenclosedarea" | "road" | "parking" | "driveway" => {
            SemanticRole::Restricted
        }
        _ => SemanticRole::Public,
    }
}

/// §8's registered confidence as the render document's byte scale. A missing
/// registry entry reads as no confidence rather than as certainty.
fn confidence_byte(spatial: &SpatialContext, confidence_ref: u32) -> u8 {
    let value = spatial
        .registries
        .confidence
        .get(confidence_ref as usize)
        .map_or(0.0, |confidence| confidence.value);
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Column-major 4x4 world transform: the ENU basis vectors as columns, the
/// frame's ECEF translation last — `p_ecef = translation + basis · p_local`.
fn world_transform(spatial: &SpatialContext) -> [f64; 16] {
    let basis = spatial.frame.enu_basis_ecef;
    let translation = spatial.frame.world_translation;
    [
        basis[0][0],
        basis[0][1],
        basis[0][2],
        0.0,
        basis[1][0],
        basis[1][1],
        basis[1][2],
        0.0,
        basis[2][0],
        basis[2][1],
        basis[2][2],
        0.0,
        translation[0],
        translation[1],
        translation[2],
        1.0,
    ]
}

/// A deterministic identity for the compiled input: the frame anchor plus
/// every primitive's identity, class, level, and vertex count. Two bundles
/// whose §9 content differs anywhere hash differently; the same bundle always
/// hashes the same, so the value is usable as a cache key.
fn source_hash(scene: &SceneSection, spatial: &SpatialContext) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kiriko-generated-scene\0");
    digest.update(GENERATED_PRODUCER_VERSION.to_le_bytes());
    for component in spatial.frame.ecef_origin {
        digest.update(component.to_le_bytes());
    }
    digest.update(spatial.frame.vertical_normalisation_offset_mm.to_le_bytes());
    for record in &spatial.levels {
        digest.update(record.level_id.as_bytes());
        digest.update(b"\0");
        digest.update(record.resolved_scene_z_mm.to_le_bytes());
    }
    for primitive in &scene.primitives {
        digest.update(primitive.id.as_bytes());
        digest.update(b"\0");
        digest.update(primitive.level_id.as_bytes());
        digest.update(b"\0");
        digest.update([role_class(primitive.role)]);
        let mesh = mesh_of(primitive);
        digest.update((mesh.positions.len() as u64).to_le_bytes());
        digest.update((mesh.faces.len() as u64).to_le_bytes());
        for position in &mesh.positions {
            for component in position {
                digest.update(component.to_le_bytes());
            }
        }
        if let PrimitiveGeometry::TintedMesh { vertex_colors, .. } = &primitive.geometry {
            digest.update((vertex_colors.len() as u64).to_le_bytes());
            for rgb in vertex_colors {
                digest.update(rgb);
            }
        }
    }
    format!("{:x}", digest.finalize())
}

/// Expand an indexed mesh into triangle-list vertices with flat facet
/// normals. Millimetres become metres here — the render format's unit — and
/// the vertical extent is recorded for floor filtering and picking.
fn triangulate(mesh: &Mesh) -> Triangles {
    let mut vertices = Vec::with_capacity(mesh.faces.len() * 3);
    let mut normals = Vec::with_capacity(mesh.faces.len() * 3);
    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;

    for face in &mesh.faces {
        let corners: Option<Vec<[f32; 3]>> = face
            .iter()
            .map(|index| mesh.positions.get(*index as usize).map(metres))
            .collect();
        // A face indexing past its own positions is not geometry; skipping it
        // keeps the rest of the primitive renderable.
        let Some(corners) = corners else { continue };

        let normal = facet_normal(&corners);
        for corner in corners {
            min_z = min_z.min(corner[2]);
            max_z = max_z.max(corner[2]);
            vertices.push(corner);
            normals.push(normal);
        }
    }

    if vertices.is_empty() {
        min_z = 0.0;
        max_z = 0.0;
    }

    Triangles {
        vertices,
        normals,
        min_z,
        max_z,
    }
}

fn metres(position: &[i64; 3]) -> [f32; 3] {
    [
        position[0] as f32 / MM_PER_M,
        position[1] as f32 / MM_PER_M,
        position[2] as f32 / MM_PER_M,
    ]
}

/// The facet's outward normal from its winding. A degenerate facet (zero
/// area) gets an up normal rather than a NaN one.
fn facet_normal(corners: &[[f32; 3]]) -> [f32; 3] {
    let (a, b, c) = (corners[0], corners[1], corners[2]);
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let normal = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
    if length <= f32::EPSILON {
        return [0.0, 0.0, 1.0];
    }
    [normal[0] / length, normal[1] / length, normal[2] / length]
}

/// Replicate indexed-mesh tints onto triangle-list vertices, same order as
/// [`triangulate`].
fn expand_vertex_colors(mesh: &Mesh, tints: &[[u8; 3]]) -> Vec<[u8; 3]> {
    let mut colors = Vec::with_capacity(mesh.faces.len() * 3);
    for face in &mesh.faces {
        let Some(rgb) = face
            .iter()
            .map(|index| tints.get(*index as usize).copied())
            .collect::<Option<Vec<[u8; 3]>>>()
        else {
            continue;
        };
        colors.extend(rgb);
    }
    colors
}

/// Stable ordering key for a role, so batch order depends on the role itself
/// and not on the order primitives happened to arrive in.
fn role_key(role: SemanticRole) -> u8 {
    match role {
        SemanticRole::Walkable => 0,
        SemanticRole::Public => 1,
        SemanticRole::Service => 2,
        SemanticRole::Restricted => 3,
        SemanticRole::Structure => 4,
        SemanticRole::Ceiling => 5,
        SemanticRole::Opening => 6,
        SemanticRole::Elevator => 7,
        SemanticRole::Escalator => 8,
        SemanticRole::Stairs => 9,
        SemanticRole::Ramp => 10,
        SemanticRole::Context => 11,
        SemanticRole::Conveyance => 12,
        SemanticRole::TicketGate => 13,
    }
}
fn role_class(role: PrimitiveRole) -> u8 {
    match role {
        PrimitiveRole::Surface => 0,
        PrimitiveRole::Wall => 1,
        PrimitiveRole::Ceiling => 2,
        PrimitiveRole::Portal => 3,
        PrimitiveRole::Conveyance => 4,
        PrimitiveRole::Fixture => 5,
    }
}

/// Brushed-metal fallback matching `GateFinish::Stainless` /
/// `ROLE_COLORS.TicketGate`.
const TICKET_GATE_STAINLESS: [u8; 3] = [205, 200, 189];

/// Accumulates one `(level, role)` batch before quantization.
struct BatchAccumulator {
    role: SemanticRole,
    vertices: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    feature_indices: Vec<u32>,
    colors: Option<Vec<[u8; 3]>>,
}

impl BatchAccumulator {
    fn new(role: SemanticRole) -> Self {
        Self {
            role,
            vertices: Vec::new(),
            normals: Vec::new(),
            feature_indices: Vec::new(),
            colors: None,
        }
    }

    fn push(
        &mut self,
        triangles: &Triangles,
        feature_index: u32,
        tints: Option<&[[u8; 3]]>,
    ) {
        let n = triangles.vertices.len();
        if let Some(tints) = tints {
            match &mut self.colors {
                None => {
                    let mut colors = vec![TICKET_GATE_STAINLESS; self.vertices.len()];
                    colors.extend_from_slice(tints);
                    self.colors = Some(colors);
                }
                Some(colors) => colors.extend_from_slice(tints),
            }
        } else if let Some(colors) = &mut self.colors {
            colors.extend(std::iter::repeat_n(TICKET_GATE_STAINLESS, n));
        }
        self.vertices.extend_from_slice(&triangles.vertices);
        self.normals.extend_from_slice(&triangles.normals);
        self.feature_indices
            .extend(std::iter::repeat_n(feature_index, n));
    }

    fn finish(self, level_index: u32) -> SceneBatch {
        let (positions, quantization_origin, quantization_scale) =
            quantize_positions(&self.vertices);
        SceneBatch {
            level_index,
            role: self.role,
            quantization_origin,
            quantization_scale,
            vertex_count: positions.len() as u32,
            positions,
            normals: self.normals.into_iter().map(encode_normal_oct).collect(),
            feature_indices: self.feature_indices,
            colors: self.colors,
        }
    }
}

#[cfg(test)]
mod tests {
    use kiriko_model::scene::{
        Mesh, OcclusionClass, PrimitiveGeometry, PrimitiveRole, ScenePrimitive,
    };

    use super::mesh_of;

    #[test]
    fn mesh_of_reads_a_tinted_mesh() {
        let mesh = Mesh {
            positions: vec![[0, 0, 0], [1, 0, 0], [1, 1, 0]],
            faces: vec![[0, 1, 2]],
        };
        let primitive = ScenePrimitive {
            id: "fx".into(),
            role: PrimitiveRole::Fixture,
            level_id: "l1".into(),
            occlusion: OcclusionClass::Opaque,
            confidence_ref: 0,
            canonical_feature_id: None,
            source_locator_refs: Vec::new(),
            evidence_refs: Vec::new(),
            geometry: PrimitiveGeometry::TintedMesh {
                mesh,
                vertex_colors: vec![[205, 200, 189]; 3],
            },
        };
        assert_eq!(mesh_of(&primitive).positions.len(), 3);
    }
}
