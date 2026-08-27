//! Illustrative fixture geometry compiled into §9 at publish time.
//!
//! Catalog keys are canonical category tokens (`ticketgate`), never GDB
//! C-codes. The JR automatic-gate recipe is the only form that emits a mesh;
//! every other fixture is `Absent` and contributes no primitive.

use kiriko_model::scene::{Mesh, PrimitiveGeometry};

use crate::scene_compile::{SceneProfile, append_mesh, box_mesh};

/// Canonical category mapped to an illustrative 3D form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FixtureForm {
    Absent,
    JrAutomaticGate,
}

/// Paint used only on [`PrimitiveGeometry::TintedMesh`] vertices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GateFinish {
    Stainless,
    SkyBlue,
    SensorBlack,
    SignalYellow,
}

impl GateFinish {
    pub(crate) const fn rgb(self) -> [u8; 3] {
        match self {
            Self::Stainless => [205, 200, 189],
            Self::SkyBlue => [90, 176, 214],
            Self::SensorBlack => [28, 28, 32],
            Self::SignalYellow => [245, 208, 16],
        }
    }
}

/// Canonical category to form. Never matches GDB C-codes.
pub(crate) fn fixture_form(category: Option<&str>) -> FixtureForm {
    match category {
        Some("ticketgate") => FixtureForm::JrAutomaticGate,
        _ => FixtureForm::Absent,
    }
}

/// `None` if the form is Absent or the footprint cannot carry it.
pub(crate) fn illustrate_fixture(
    form: FixtureForm,
    ring_xy: &[[i64; 2]],
    z: i64,
    profile: &SceneProfile,
) -> Option<PrimitiveGeometry> {
    match form {
        FixtureForm::Absent => None,
        FixtureForm::JrAutomaticGate => jr_automatic_gate_row(ring_xy, z, profile).map(|tinted| {
            PrimitiveGeometry::TintedMesh {
                mesh: tinted.mesh,
                vertex_colors: tinted.vertex_colors,
            }
        }),
    }
}

struct TintedMeshBuf {
    mesh: Mesh,
    vertex_colors: Vec<[u8; 3]>,
}

struct GateAxes {
    origin: [f64; 2],
    u: [f64; 2],
    v: [f64; 2],
    row_span: f64,
    travel_span: f64,
}

const PLINTH_HEIGHT_MM: i64 = 40;
const SENSOR_HEIGHT_MM: i64 = 40;
const TRAVEL_MARGIN_MM: f64 = 80.0;
const MIN_TRAVEL_SPAN_MM: f64 = 400.0;
const MIN_HOUSING_LEN_MM: f64 = 400.0;
const INNER_FACE_THICKNESS_MM: f64 = 12.0;
const FLAP_INTO_LANE_MM: f64 = 20.0;
const FLAP_ALONG_TRAVEL_MM: f64 = 80.0;

fn aabb(ring_xy: &[[i64; 2]]) -> Option<([i64; 2], [i64; 2])> {
    ring_xy.iter().fold(None, |acc, p| {
        Some(match acc {
            None => (*p, *p),
            Some((lo, hi)) => (
                [lo[0].min(p[0]), lo[1].min(p[1])],
                [hi[0].max(p[0]), hi[1].max(p[1])],
            ),
        })
    })
}

/// Travel is the AABB axis nearer nominal housing length so a 6×2 m bank
/// points housings through the 2 m passenger path, not along the 6 m row.
fn row_and_travel(min: [i64; 2], max: [i64; 2], housing_length: f64) -> GateAxes {
    let dx = (max[0] - min[0]) as f64;
    let dy = (max[1] - min[1]) as f64;
    let dist_x = (dx - housing_length).abs();
    let dist_y = (dy - housing_length).abs();
    let x_is_travel = dist_x < dist_y || (dist_x == dist_y && dx <= dy);
    if x_is_travel {
        GateAxes {
            origin: [(min[0] + max[0]) as f64 / 2.0, min[1] as f64],
            u: [0.0, 1.0],
            v: [1.0, 0.0],
            row_span: dy,
            travel_span: dx,
        }
    } else {
        GateAxes {
            origin: [min[0] as f64, (min[1] + max[1]) as f64 / 2.0],
            u: [1.0, 0.0],
            v: [0.0, 1.0],
            row_span: dx,
            travel_span: dy,
        }
    }
}

fn point(axes: &GateAxes, row_mm: f64, travel_mm: f64) -> [i64; 2] {
    [
        (axes.origin[0] + axes.u[0] * row_mm + axes.v[0] * travel_mm).round() as i64,
        (axes.origin[1] + axes.u[1] * row_mm + axes.v[1] * travel_mm).round() as i64,
    ]
}

fn rect_at(
    axes: &GateAxes,
    row_c: f64,
    travel_c: f64,
    half_row: f64,
    half_travel: f64,
) -> Vec<[i64; 2]> {
    vec![
        point(axes, row_c - half_row, travel_c - half_travel),
        point(axes, row_c + half_row, travel_c - half_travel),
        point(axes, row_c + half_row, travel_c + half_travel),
        point(axes, row_c - half_row, travel_c + half_travel),
    ]
}

fn append_tinted_box(
    dst: &mut TintedMeshBuf,
    ring: &[[i64; 2]],
    z0: i64,
    z1: i64,
    finish: GateFinish,
) {
    let mesh = box_mesh(ring, ring, z0, z1);
    let rgb = finish.rgb();
    dst.vertex_colors
        .extend(std::iter::repeat_n(rgb, mesh.positions.len()));
    append_mesh(&mut dst.mesh, mesh);
}

fn jr_automatic_gate_row(
    ring_xy: &[[i64; 2]],
    z: i64,
    profile: &SceneProfile,
) -> Option<TintedMeshBuf> {
    let (min, max) = aabb(ring_xy)?;
    let axes = row_and_travel(min, max, profile.gate_housing_length_mm as f64);
    let width = profile.gate_housing_width_mm as f64;
    if axes.row_span < width || axes.travel_span < MIN_TRAVEL_SPAN_MM {
        return None;
    }
    let housing_len = profile
        .gate_housing_length_mm
        .min((axes.travel_span - 2.0 * TRAVEL_MARGIN_MM) as i64) as f64;
    if housing_len < MIN_HOUSING_LEN_MM {
        return None;
    }

    let machines = ((axes.row_span / profile.gate_pitch_mm as f64).round() as usize).max(1);
    let half_w = width / 2.0;
    let half_l = housing_len / 2.0;
    let height = profile.gate_height_mm;
    let body_top = z + height - SENSOR_HEIGHT_MM;

    let mut dst = TintedMeshBuf {
        mesh: Mesh {
            positions: Vec::new(),
            faces: Vec::new(),
        },
        vertex_colors: Vec::new(),
    };

    for i in 0..machines {
        let row_c = (i as f64 + 0.5) / machines as f64 * axes.row_span;
        let footprint = rect_at(&axes, row_c, 0.0, half_w, half_l);
        append_tinted_box(
            &mut dst,
            &footprint,
            z,
            z + PLINTH_HEIGHT_MM,
            GateFinish::SensorBlack,
        );
        append_tinted_box(
            &mut dst,
            &footprint,
            z + PLINTH_HEIGHT_MM,
            body_top,
            GateFinish::Stainless,
        );

        for sign in [-1.0, 1.0] {
            let face = rect_at(
                &axes,
                row_c + sign * (half_w - INNER_FACE_THICKNESS_MM / 2.0),
                0.0,
                INNER_FACE_THICKNESS_MM / 2.0,
                half_l,
            );
            append_tinted_box(&mut dst, &face, z + 180, body_top, GateFinish::SkyBlue);
            let flap = rect_at(
                &axes,
                row_c + sign * (half_w + FLAP_INTO_LANE_MM / 2.0),
                0.0,
                FLAP_INTO_LANE_MM / 2.0,
                FLAP_ALONG_TRAVEL_MM / 2.0,
            );
            append_tinted_box(&mut dst, &flap, z + 500, z + 620, GateFinish::SkyBlue);
        }

        let sensor = rect_at(&axes, row_c, 0.0, half_w * 0.45, half_l * 0.92);
        append_tinted_box(&mut dst, &sensor, body_top, z + height, GateFinish::SensorBlack);

        let pad = rect_at(&axes, row_c, half_l - 100.0, 90.0, 100.0);
        append_tinted_box(&mut dst, &pad, z + height, z + height + 25, GateFinish::SkyBlue);

        let plaque = rect_at(&axes, row_c, half_l + 6.0, 40.0, 8.0);
        append_tinted_box(&mut dst, &plaque, z + 380, z + 520, GateFinish::SignalYellow);
    }

    if dst.mesh.positions.is_empty() {
        None
    } else {
        Some(dst)
    }
}
