//! Deterministic floor-plane resolution for the §8 spatial context.
//!
//! Given the venue levels, per-level explicit elevations, per-ordinal
//! network junction altitudes, and a versioned [`ResolutionProfile`], this
//! module applies the fixed precedence — explicit imported or trusted mapped
//! elevation, then a preserved routing-network altitude where trustworthy,
//! then configurable nominal floor spacing — and produces, per level, the
//! resolution method, the resolved plane as checked integer millimetres, and
//! the normalisation offset that puts the lowest plane at scene Z 0.
//!
//! Everything here is deterministic: the same inputs always produce the same
//! records and the same bytes (f64 → mm is `(x * 1000.0).round()`, round half
//! away from zero, applied exactly once per value).

use std::collections::BTreeMap;

use kiriko_model::model::ViewerLevel;
use kiriko_model::spatial::ResolutionMethod;

/// Versioned resolution profile: the configurable mappings, tolerances, and
/// defaults the resolution pass applies. Deliberately not global constants —
/// producers pass their own profile (or the default) and the version rides
/// along so a later reader can tell which profile produced a record.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolutionProfile {
    pub profile_version: u32,
    /// Source-property key the explicit elevation is read from (the "trusted
    /// mapped elevation field"). The GDB mapping writes this key when it
    /// preserves a source elevation.
    pub elevation_property_key: String,
    /// Floor-to-floor spacing assumed when neither source is usable, metres.
    pub nominal_floor_spacing_m: f64,
    /// A level's network altitude needs at least this many junction
    /// altitudes to be trustworthy.
    pub network_min_nodes_per_level: usize,
    /// Maximum spread (max − min) of a level's junction altitudes for the
    /// network source to be trustworthy, metres.
    pub network_altitude_tolerance_m: f64,
}

impl Default for ResolutionProfile {
    /// The versioned default profile (v1).
    fn default() -> Self {
        Self {
            profile_version: 1,
            elevation_property_key: "elevation".to_string(),
            nominal_floor_spacing_m: 4.0,
            network_min_nodes_per_level: 3,
            network_altitude_tolerance_m: 1.0,
        }
    }
}

/// Per-level explicit elevations (level id → metres), parsed from the level
/// feature's `source_properties[elevation_property_key]`.
pub(crate) type LevelElevations = BTreeMap<String, f64>;

/// Per-ordinal network junction altitudes (metres), grouped from
/// `RouteGraphBuild.node_altitudes` by node ordinal. Looked up by exact
/// ordinal equality — the graph build resolves node ordinals from the very
/// level ordinals passed to it, so a matching node's ordinal is bit-identical.
pub(crate) type NetworkAltitudes = Vec<(f64, Vec<f64>)>;

/// One level's resolution result, before registry assembly.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedLevel {
    pub level_id: String,
    pub ordinal: f64,
    /// The elevation that produced the resolved plane, metres (imported,
    /// network, or nominal-derived).
    pub resolved_elevation_m: f64,
    /// Original source elevation, full precision, when one existed.
    pub source_elevation_m: Option<f64>,
    /// The preserved network altitude, when one was present and trustworthy.
    pub network_altitude_m: Option<f64>,
    pub method: ResolutionMethod,
    /// Network minus imported, checked integer millimetres, when both existed.
    pub network_difference_mm: Option<i64>,
    /// Resolved plane as checked integer millimetres, non-negative.
    pub scene_z_mm: i64,
}

/// The resolution outcome: per-level records in `levels` order, plus the
/// normalisation offset that puts the lowest resolved plane at scene Z 0.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolutionOutcome {
    pub levels: Vec<ResolvedLevel>,
    pub normalisation_offset_mm: i64,
}

/// metres → checked integer millimetres, round half away from zero.
fn to_mm(metres: f64) -> i64 {
    (metres * 1000.0).round() as i64
}

/// The trustworthy network altitude for an ordinal: the median of its
/// junction altitudes, when at least `network_min_nodes_per_level` exist and
/// their spread is within `network_altitude_tolerance_m`. `None` otherwise —
/// an untrustworthy network source is treated as absent (nominal wins).
fn trustworthy_network_altitude(
    ordinal: f64,
    network: &NetworkAltitudes,
    profile: &ResolutionProfile,
) -> Option<f64> {
    let (_, altitudes) = network.iter().find(|(o, _)| *o == ordinal)?;
    let mut altitudes = altitudes.clone();
    if altitudes.len() < profile.network_min_nodes_per_level {
        return None;
    }
    altitudes.sort_by(|a, b| a.total_cmp(b));
    let spread = altitudes[altitudes.len() - 1] - altitudes[0];
    if spread > profile.network_altitude_tolerance_m {
        return None;
    }
    let mid = altitudes.len() / 2;
    Some(if altitudes.len() % 2 == 1 {
        altitudes[mid]
    } else {
        (altitudes[mid - 1] + altitudes[mid]) / 2.0
    })
}

/// Resolve every level's floor plane by the fixed precedence.
pub(crate) fn resolve_level_planes(
    levels: &[ViewerLevel],
    elevations: &LevelElevations,
    network: &NetworkAltitudes,
    profile: &ResolutionProfile,
) -> ResolutionOutcome {
    // Pass 1: pick the winning source per level by precedence.
    let mut resolved: Vec<ResolvedLevel> = Vec::with_capacity(levels.len());
    for level in levels {
        let source_elevation_m = elevations.get(&level.id).copied();
        let network_altitude_m =
            trustworthy_network_altitude(level.ordinal, network, profile);
        let (resolved_elevation_m, method, network_difference_mm) = match source_elevation_m {
            Some(imported) => (
                imported,
                ResolutionMethod::ImportedElevation,
                network_altitude_m
                    .map(|network_altitude| to_mm(network_altitude - imported)),
            ),
            None => match network_altitude_m {
                Some(network_altitude) => {
                    (network_altitude, ResolutionMethod::NetworkAltitude, None)
                }
                None => (0.0, ResolutionMethod::NominalSpacing, None),
            },
        };
        resolved.push(ResolvedLevel {
            level_id: level.id.clone(),
            ordinal: level.ordinal,
            resolved_elevation_m,
            source_elevation_m,
            network_altitude_m,
            method,
            network_difference_mm,
            scene_z_mm: 0,
        });
    }

    // Pass 2: nominal levels measure the configured spacing off the lowest
    // level with a real plane; with no real plane anywhere, off ordinal 0 at
    // elevation 0.
    let base = resolved
        .iter()
        .filter(|l| l.method != ResolutionMethod::NominalSpacing)
        .min_by(|a, b| a.ordinal.total_cmp(&b.ordinal))
        .map(|l| (l.ordinal, l.resolved_elevation_m))
        .unwrap_or((0.0, 0.0));
    for level in &mut resolved {
        if level.method == ResolutionMethod::NominalSpacing {
            level.resolved_elevation_m =
                base.1 + profile.nominal_floor_spacing_m * (level.ordinal - base.0);
        }
    }

    // Pass 3: checked integer millimetre scene Z, normalised non-negative.
    let offset_mm = resolved
        .iter()
        .map(|l| to_mm(l.resolved_elevation_m))
        .min()
        .unwrap_or(0);
    for level in &mut resolved {
        level.scene_z_mm = to_mm(level.resolved_elevation_m) - offset_mm;
    }

    ResolutionOutcome {
        levels: resolved,
        normalisation_offset_mm: offset_mm,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use kiriko_model::model::ViewerLevel;
    use kiriko_model::spatial::ResolutionMethod;

    use super::{ResolutionProfile, resolve_level_planes};

    fn level(id: &str, ordinal: f64) -> ViewerLevel {
        ViewerLevel {
            id: id.to_string(),
            ordinal,
            label: BTreeMap::new(),
            short_name: BTreeMap::new(),
        }
    }

    fn default_profile() -> ResolutionProfile {
        ResolutionProfile::default()
    }

    #[test]
    fn all_three_precedence_branches_resolve_and_normalise() {
        // L1: explicit elevation wins. L2: preserved network altitude wins
        // (3 close junctions). L3: nothing → nominal spacing off the lowest
        // real plane. B1: both → imported wins, difference recorded.
        let levels = vec![
            level("L3", 2.0),
            level("L2", 1.0),
            level("L1", 0.0),
            level("B1", -1.0),
        ];
        let elevations = BTreeMap::from([("L1".to_string(), 10.0), ("B1".to_string(), 6.0)]);
        let network = vec![
            (1.0, vec![14.0, 14.1, 14.2]),
            (-1.0, vec![6.5, 6.5, 6.6]),
        ];

        let outcome = resolve_level_planes(&levels, &elevations, &network, &default_profile());

        let by_id: BTreeMap<&str, _> = outcome
            .levels
            .iter()
            .map(|l| (l.level_id.as_str(), l))
            .collect();

        let l1 = by_id["L1"];
        assert_eq!(l1.method, ResolutionMethod::ImportedElevation);
        assert_eq!(l1.source_elevation_m, Some(10.0));
        assert_eq!(l1.network_difference_mm, None, "no network on L1");
        assert_eq!(l1.scene_z_mm, 4000);

        let l2 = by_id["L2"];
        assert_eq!(l2.method, ResolutionMethod::NetworkAltitude);
        assert_eq!(l2.network_altitude_m, Some(14.1), "median of 14.0/14.1/14.2");
        assert_eq!(l2.source_elevation_m, None);
        assert_eq!(l2.scene_z_mm, 8100, "14100 − offset 6000");

        let l3 = by_id["L3"];
        assert_eq!(l3.method, ResolutionMethod::NominalSpacing);
        assert_eq!(
            l3.resolved_elevation_m, 18.0,
            "10.0 + default 4.0 spacing × (2 − 0), off the lowest real plane L1"
        );
        assert_eq!(l3.scene_z_mm, 12000, "18000 − offset 6000");

        let b1 = by_id["B1"];
        assert_eq!(b1.method, ResolutionMethod::ImportedElevation, "precedence: imported beats network");
        assert_eq!(b1.source_elevation_m, Some(6.0));
        assert_eq!(b1.network_altitude_m, Some(6.5));
        assert_eq!(
            b1.network_difference_mm,
            Some(500),
            "network minus imported, 0.5 m, as checked integer millimetres"
        );
        assert_eq!(b1.scene_z_mm, 0, "lowest plane lands at 0");

        assert_eq!(outcome.normalisation_offset_mm, 6000);
    }

    #[test]
    fn all_nominal_levels_measure_spacing_from_ordinal_zero() {
        let levels = vec![level("F1", 1.0), level("G", 0.0), level("B1", -1.0)];
        let outcome = resolve_level_planes(&levels, &BTreeMap::new(), &Vec::new(), &default_profile());
        assert_eq!(outcome.normalisation_offset_mm, -4000);
        assert_eq!(outcome.levels[0].scene_z_mm, 8000, "4.0 × 1 − (−4000)");
        assert_eq!(outcome.levels[1].scene_z_mm, 4000, "4.0 × 0 − (−4000)");
        assert_eq!(outcome.levels[2].scene_z_mm, 0, "4.0 × −1 − (−4000)");
        assert!(
            outcome.levels.iter().all(|l| l.method == ResolutionMethod::NominalSpacing),
            "every level is flagged assumed when nothing real exists"
        );
    }

    #[test]
    fn a_network_source_with_too_few_nodes_is_not_trustworthy() {
        let levels = vec![level("F1", 0.0)];
        let network = vec![(0.0, vec![10.0, 10.5])];
        let outcome = resolve_level_planes(&levels, &BTreeMap::new(), &network, &default_profile());
        assert_eq!(
            outcome.levels[0].method,
            ResolutionMethod::NominalSpacing,
            "2 junctions is below the default minimum of 3"
        );
    }

    #[test]
    fn a_network_source_with_a_wide_spread_is_not_trustworthy() {
        let levels = vec![level("F1", 0.0)];
        let network = vec![(0.0, vec![10.0, 10.1, 12.5])];
        let outcome = resolve_level_planes(&levels, &BTreeMap::new(), &network, &default_profile());
        assert_eq!(
            outcome.levels[0].method,
            ResolutionMethod::NominalSpacing,
            "spread 2.5 m exceeds the default 1.0 m tolerance"
        );
    }

    #[test]
    fn a_custom_profile_drives_the_nominal_spacing() {
        let levels = vec![level("L3", 2.0), level("L1", 0.0)];
        let elevations = BTreeMap::from([("L1".to_string(), 10.0)]);
        let profile = ResolutionProfile {
            nominal_floor_spacing_m: 4.5,
            ..ResolutionProfile::default()
        };
        let outcome = resolve_level_planes(&levels, &elevations, &Vec::new(), &profile);
        assert_eq!(outcome.levels[0].method, ResolutionMethod::NominalSpacing);
        assert_eq!(
            outcome.levels[0].resolved_elevation_m, 19.0,
            "10.0 + configured 4.5 m × 2 — the profile, not a constant"
        );
    }

    #[test]
    fn empty_levels_produce_an_empty_outcome_with_zero_offset() {
        let outcome = resolve_level_planes(&[], &BTreeMap::new(), &Vec::new(), &default_profile());
        assert!(outcome.levels.is_empty());
        assert_eq!(outcome.normalisation_offset_mm, 0);
    }

    #[test]
    fn the_default_profile_is_version_one() {
        let profile = ResolutionProfile::default();
        assert_eq!(profile.profile_version, 1);
        assert_eq!(profile.elevation_property_key, "elevation");
        assert_eq!(profile.nominal_floor_spacing_m, 4.0);
        assert_eq!(profile.network_min_nodes_per_level, 3);
        assert_eq!(profile.network_altitude_tolerance_m, 1.0);
    }
}
