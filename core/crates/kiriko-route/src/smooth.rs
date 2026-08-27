//! Query-time greedy-LOS string-pull against venue walkable floors.
//!
//! [`smooth_route`] takes a [`Route`](crate::query::Route) produced by A* and
//! pulls each segment's geometry tight: from every kept vertex, the farthest
//! later vertex whose chord stays inside the floor's walkable union (sampled
//! every ≤ 0.5 m) and that does not skip a door lock becomes the next kept
//! vertex. This is Mappedin's published greedy-LOS pass; `total_weight` is
//! untouched because smoothing is geometry, not graph cost.

use crate::geo_math::{haversine_m, point_seg_dist_m};
use crate::query::{Route, RouteSegment};

/// A walkable polygon: an exterior ring plus optional holes (kiosks, columns,
/// unenclosed areas). Rings are `[lon, lat]` pairs; a closed ring repeats its
/// first vertex, but an unclosed ring is treated as implicitly closed.
#[derive(Debug, Clone, PartialEq)]
pub struct WalkablePolygon {
    pub exterior: Vec<[f64; 2]>,
    pub holes: Vec<Vec<[f64; 2]>>,
}

/// One floor's walkable geometry plus the door-lock / transit points that a
/// smoothed chord must not skip. Empty `polygons` makes nothing walkable.
#[derive(Debug, Clone, PartialEq)]
pub struct WalkableFloor {
    pub ordinal: f64,
    pub polygons: Vec<WalkablePolygon>,
    pub locks: Vec<[f64; 2]>,
}

/// Chord samples may fall up to this far outside the exterior ring and still
/// count as inside. It never applies to holes: a point inside a hole is not
/// walkable even when within this distance of the hole boundary.
const SEGMENT_OUTSIDE_TOL_M: f64 = 0.3;

/// A lock within this distance of an intermediate vertex blocks any chord
/// that would skip that vertex.
const DOOR_LOCK_M: f64 = 0.4;

/// Maximum spacing between samples along a candidate chord (spec §5).
const CHORD_SAMPLE_M: f64 = 0.5;

/// Pull each segment's interior vertices to the farthest visible chord.
/// Segments whose ordinal has no matching floor are left untouched, so empty
/// `floors` makes every segment untouched (identity). Segments are never
/// added, removed, or merged, and `total_weight` is unchanged.
pub fn smooth_route(route: Route, floors: &[WalkableFloor]) -> Route {
    Route {
        segments: route
            .segments
            .into_iter()
            .map(|seg| smooth_segment(seg, floors))
            .collect(),
        total_weight: route.total_weight,
        origin_projected: route.origin_projected,
        dest_projected: route.dest_projected,
    }
}

/// Greedy scan over one segment's coordinates: from the current kept vertex,
/// keep the farthest later vertex whose chord is legal; when no later chord
/// is legal, keep the immediately following vertex (the original polyline).
fn smooth_segment(seg: RouteSegment, floors: &[WalkableFloor]) -> RouteSegment {
    let Some(floor) = floors.iter().find(|f| f.ordinal == seg.ordinal) else {
        return seg;
    };
    let coords = seg.coordinates;
    let mut out = Vec::with_capacity(coords.len());
    out.push(coords[0]);
    let mut i = 0;
    while i + 1 < coords.len() {
        let mut next = i + 1;
        for j in (i + 2..coords.len()).rev() {
            if chord_ok(&coords, i, j, floor) {
                next = j;
                break;
            }
        }
        out.push(coords[next]);
        i = next;
    }
    RouteSegment {
        ordinal: seg.ordinal,
        coordinates: out,
    }
}

/// `true` when the chord `coords[i]` → `coords[j]` may replace the polyline
/// between them: every sample (≤ [`CHORD_SAMPLE_M`], endpoints included) lies
/// in the floor's walkable union, and no lock sits within [`DOOR_LOCK_M`] of
/// an intermediate vertex that the chord would skip.
pub(crate) fn chord_ok(coords: &[[f64; 2]], i: usize, j: usize, floor: &WalkableFloor) -> bool {
    for c in coords.iter().take(j).skip(i + 1) {
        if floor
            .locks
            .iter()
            .any(|lock| haversine_m(c[0], c[1], lock[0], lock[1]) < DOOR_LOCK_M)
        {
            return false;
        }
    }
    let (a, b) = (coords[i], coords[j]);
    let len_m = haversine_m(a[0], a[1], b[0], b[1]);
    let steps = (len_m / CHORD_SAMPLE_M).ceil().max(1.0) as usize;
    for s in 0..=steps {
        let t = s as f64 / steps as f64;
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if !walkable(p, floor) {
            return false;
        }
    }
    true
}

/// `true` when `p` is walkable: inside (or within [`SEGMENT_OUTSIDE_TOL_M`] of)
/// some polygon's exterior ring, and strictly outside every hole of that
/// polygon. Holes never shrink — the tolerance is exterior-only.
pub(crate) fn walkable(p: [f64; 2], floor: &WalkableFloor) -> bool {
    floor.polygons.iter().any(|poly| {
        if !point_in_ring(&poly.exterior, p)
            && dist_to_ring_m(p, &poly.exterior) > SEGMENT_OUTSIDE_TOL_M
        {
            return false;
        }
        poly.holes.iter().all(|hole| !point_in_ring(hole, p))
    })
}

/// Even-odd point-in-ring test (ray cast). `p` is `[lon, lat]`.
fn point_in_ring(ring: &[[f64; 2]], p: [f64; 2]) -> bool {
    let (px, py) = (p[0], p[1]);
    let mut inside = false;
    for (a, b) in ring_edges(ring) {
        let (xi, yi) = (a[0], a[1]);
        let (xj, yj) = (b[0], b[1]);
        if (yi > py) != (yj > py) && px < xi + (py - yi) * (xj - xi) / (yj - yi) {
            inside = !inside;
        }
    }
    inside
}

/// Minimum distance (metres) from `p` to any edge of `ring`.
fn dist_to_ring_m(p: [f64; 2], ring: &[[f64; 2]]) -> f64 {
    ring_edges(ring)
        .map(|(a, b)| point_seg_dist_m(p, a, b))
        .fold(f64::INFINITY, f64::min)
}

/// The ring's edges, treating an unclosed ring as closed; the zero-length
/// closing segment of an already-closed ring is skipped.
fn ring_edges(ring: &[[f64; 2]]) -> impl Iterator<Item = ([f64; 2], [f64; 2])> + '_ {
    let n = ring.len();
    (0..n).filter_map(move |i| {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        (a != b).then_some((a, b))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1° of latitude ≈ 111_194.93 m; 1° of longitude ≈ 91_083.5 m at 35°N.
    const M_PER_DEG_LAT: f64 = 111_194.93;
    const M_PER_DEG_LON: f64 = 91_083.5;

    /// `[lon, lat]` of a point `x` metres east / `y` metres north of
    /// (139.0, 35.0).
    fn pt(x: f64, y: f64) -> [f64; 2] {
        [139.0 + x / M_PER_DEG_LON, 35.0 + y / M_PER_DEG_LAT]
    }

    /// Metres between two lon/lat points.
    fn m(a: [f64; 2], b: [f64; 2]) -> f64 {
        haversine_m(a[0], a[1], b[0], b[1])
    }

    /// Closed `w × h` metre rectangle centred `x`/`y` metres east/north of the
    /// origin (last vertex repeats the first).
    fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<[f64; 2]> {
        let (hw, hh) = (w / 2.0, h / 2.0);
        vec![
            pt(x - hw, y - hh),
            pt(x + hw, y - hh),
            pt(x + hw, y + hh),
            pt(x - hw, y + hh),
            pt(x - hw, y - hh),
        ]
    }

    /// 20 m × 4 m hall along lon, no holes, no locks.
    fn hall() -> WalkableFloor {
        WalkableFloor {
            ordinal: 0.0,
            polygons: vec![WalkablePolygon {
                exterior: rect(0.0, 0.0, 20.0, 4.0),
                holes: vec![],
            }],
            locks: vec![],
        }
    }

    /// Hall with a 2 m × 2 m kiosk hole in the middle.
    fn hall_with_hole() -> WalkableFloor {
        WalkableFloor {
            ordinal: 0.0,
            polygons: vec![WalkablePolygon {
                exterior: rect(0.0, 0.0, 20.0, 4.0),
                holes: vec![rect(0.0, 0.0, 2.0, 2.0)],
            }],
            locks: vec![],
        }
    }

    /// Sawtooth along the hall: three colinear vertices plus a north detour.
    fn jagged_route() -> Route {
        Route {
            segments: vec![RouteSegment {
                ordinal: 0.0,
                coordinates: vec![
                    pt(-8.0, 0.0),
                    pt(-4.0, 0.0),
                    pt(0.0, 1.5),
                    pt(4.0, 0.0),
                    pt(8.0, 0.0),
                ],
            }],
            total_weight: 42.0,
            origin_projected: [139.0, 35.0, 0.0],
            dest_projected: [139.0, 35.0, 0.0],
        }
    }

    #[test]
    fn empty_floors_is_identity() {
        let r = jagged_route();
        assert_eq!(smooth_route(r.clone(), &[]), r);
    }

    #[test]
    fn pulls_a_sawtooth_to_the_chord_inside_a_hall() {
        let r = jagged_route();
        let out = smooth_route(r.clone(), &[hall()]);
        assert!(
            out.segments[0].coordinates.len() < r.segments[0].coordinates.len(),
            "the sawtooth interior vertices are pulled away"
        );
        assert_eq!(out.total_weight, r.total_weight);
    }

    #[test]
    fn does_not_skip_a_door_lock() {
        let door = pt(0.0, 1.5); // midpoint of an opening on the path
        let mut floor = hall();
        floor.locks.push(door);
        let out = smooth_route(jagged_route(), &[floor]);
        assert!(
            out.segments[0]
                .coordinates
                .iter()
                .any(|c| m(*c, door) < 0.4),
            "the vertex near the door lock must survive smoothing"
        );
    }

    #[test]
    fn does_not_cross_a_hole() {
        let out = smooth_route(jagged_route(), &[hall_with_hole()]);
        assert!(
            chord_misses_hole(&out),
            "a smoothed chord must stay outside the kiosk hole"
        );
    }

    /// Binding ruling: `SEGMENT_OUTSIDE_TOL_M` never applies inside holes. The
    /// straight chord v0→v4 runs along y = +0.75 m, which is 0.25 m inside the
    /// hole's top edge (y = +1.0): within tolerance of the boundary but
    /// strictly inside the hole, so the chord must be rejected.
    #[test]
    fn tolerance_never_applies_inside_a_hole() {
        let route = Route {
            segments: vec![RouteSegment {
                ordinal: 0.0,
                coordinates: vec![
                    pt(-8.0, 0.75),
                    pt(-2.0, 0.75),
                    pt(0.0, 1.5),
                    pt(2.0, 0.75),
                    pt(8.0, 0.75),
                ],
            }],
            total_weight: 42.0,
            origin_projected: [139.0, 35.0, 0.0],
            dest_projected: [139.0, 35.0, 0.0],
        };
        let out = smooth_route(route, &[hall_with_hole()]);
        assert!(
            chord_misses_hole(&out),
            "a chord passing within tolerance *inside* the hole is illegal"
        );
        assert_eq!(
            out.segments[0].coordinates.len(),
            3,
            "greedy keeps the detour vertex; the through-hole chord is not taken"
        );
    }

    /// Every sample (≤ 0.25 m apart) of every output segment stays strictly
    /// outside the kiosk hole.
    fn chord_misses_hole(route: &Route) -> bool {
        let hole = rect(0.0, 0.0, 2.0, 2.0);
        route.segments[0].coordinates.windows(2).all(|w| {
            let (a, b) = (w[0], w[1]);
            let steps = (m(a, b) / 0.25).ceil().max(1.0) as usize;
            (0..=steps).all(|s| {
                let t = s as f64 / steps as f64;
                !point_in_ring(&hole, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
            })
        })
    }
}
