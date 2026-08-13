//! Tiny metre-scale geometry helpers shared by the A* query and route
//! smoothing.
//!
//! No `geo` crate: the WASM bundle must not grow `netgen`. Great-circle
//! distances use a spherical Earth; local projections use equirectangular
//! scaling at the point of interest's latitude, the same numeric idea as
//! `kiriko-bundle::synth`.

use std::f64::consts::PI;

/// Mean Earth radius in metres (great-circle distances).
pub const EARTH_RADIUS_M: f64 = 6_371_000.0;

/// Great-circle distance in metres between `(lon1, lat1)` and `(lon2, lat2)`,
/// both in degrees.
#[must_use]
pub fn haversine_m(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> f64 {
    let (lat1, lat2) = (lat1.to_radians(), lat2.to_radians());
    let dlat = lat2 - lat1;
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().asin()
}

/// Minimum distance (metres, equirectangular at `p`'s latitude) from `p` to
/// segment `a`–`b`.
#[must_use]
pub fn point_seg_dist_m(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let m_per_deg_lat = EARTH_RADIUS_M * PI / 180.0;
    let m_per_deg_lon = m_per_deg_lat * p[1].to_radians().cos();
    let proj = |q: [f64; 2]| [(q[0] - p[0]) * m_per_deg_lon, (q[1] - p[1]) * m_per_deg_lat];
    let pa = proj(a);
    let pb = proj(b);
    let dx = pb[0] - pa[0];
    let dy = pb[1] - pa[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (pa[0] * pa[0] + pa[1] * pa[1]).sqrt();
    }
    // Project the origin (p in local metres) onto the segment, clamped.
    let t = ((-pa[0] * dx - pa[1] * dy) / len2).clamp(0.0, 1.0);
    let cx = pa[0] + t * dx;
    let cy = pa[1] + t * dy;
    (cx * cx + cy * cy).sqrt()
}
