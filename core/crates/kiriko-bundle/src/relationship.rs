//! Optional IMDF Relationship records for doorway travel direction.
//!
//! Origin / destination are Unit feature ids; intermediary is an Opening.
//! `direction` is `"directed"` or `"undirected"` (default undirected).
//! Hours are OSM `opening_hours` strings — this module does **not** parse them.
//! Relationship geometry is ignored (no extra graph edges).

use std::collections::HashMap;

use kiriko_model::canonical::{Object, Value};
use kiriko_model::model::{FeatureType, VenueFeature};
use kiriko_route::TravelDirection;

/// Parsed Relationship properties used at graph-build time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Relationship {
    pub origin: Option<String>,
    pub destination: Option<String>,
    pub intermediary: Option<String>,
    pub directed: bool,
}

/// Collect Relationship features. Geometry is ignored (no extra edges).
#[must_use]
pub(crate) fn parse_relationships(features: &[VenueFeature]) -> Vec<Relationship> {
    features
        .iter()
        .filter(|f| f.feature_type == FeatureType::Relationship)
        .map(parse_one)
        .collect()
}

fn parse_one(f: &VenueFeature) -> Relationship {
    Relationship {
        origin: feature_ref(&f.source_properties, "origin"),
        destination: feature_ref(&f.source_properties, "destination"),
        intermediary: feature_ref(&f.source_properties, "intermediary"),
        directed: f
            .source_properties
            .get("direction")
            .and_then(Value::as_str)
            .is_some_and(|s| s.eq_ignore_ascii_case("directed")),
    }
}

/// IMDF FeatureReference is `{ "id": "…", "feature_type": "…" }` or a bare id string.
fn feature_ref(props: &Object, key: &str) -> Option<String> {
    let v = props.get(key)?;
    if let Some(s) = v.as_str() {
        let t = s.trim();
        return if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
    }
    let obj = v.as_object()?;
    let id = obj.get("id").and_then(Value::as_str)?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Opening feature id → (origin unit id, destination unit id) for directed
/// relationships that name both endpoints. Conflicting records for the same
/// opening are dropped rather than guessed.
#[must_use]
pub(crate) fn directed_by_opening(rels: &[Relationship]) -> HashMap<String, (String, String)> {
    let mut map: HashMap<String, (String, String)> = HashMap::new();
    let mut conflict: HashMap<String, bool> = HashMap::new();
    for r in rels {
        if !r.directed {
            continue;
        }
        let Some(opening) = r.intermediary.clone() else {
            continue;
        };
        let (Some(origin), Some(dest)) = (r.origin.clone(), r.destination.clone()) else {
            continue;
        };
        let next = (origin, dest);
        if let Some(prev) = map.get(&opening) {
            if prev != &next {
                conflict.insert(opening, true);
            }
            continue;
        }
        map.insert(opening, next);
    }
    for k in conflict.keys() {
        map.remove(k);
    }
    map
}

/// Per-attach travel along a stored doorway edge `opening → unit`.
///
/// Conservative: Both unless origin and dest each claim at least one exclusive
/// attach and no attach sits in both units. Walking into dest is Forward;
/// walking into origin is Reverse.
#[must_use]
pub(crate) fn bind_doorway_directions(sides: &[(bool, bool)]) -> Vec<TravelDirection> {
    let n = sides.len();
    let both = vec![TravelDirection::Both; n];
    if n == 0 {
        return both;
    }
    let mut origin_only = 0usize;
    let mut dest_only = 0usize;
    for &(in_origin, in_dest) in sides {
        if in_origin && in_dest {
            return both;
        }
        if in_origin {
            origin_only += 1;
        }
        if in_dest {
            dest_only += 1;
        }
    }
    if origin_only == 0 || dest_only == 0 {
        return both;
    }
    sides
        .iter()
        .map(|&(in_origin, in_dest)| match (in_origin, in_dest) {
            (true, false) => TravelDirection::Reverse,
            (false, true) => TravelDirection::Forward,
            _ => TravelDirection::Both,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kiriko_model::canonical::Value;
    use kiriko_model::model::{FeatureType, VenueFeature};
    use std::collections::BTreeMap;

    fn rel(
        origin: Option<&str>,
        dest: Option<&str>,
        opening: Option<&str>,
        direction: Option<&str>,
    ) -> VenueFeature {
        let mut props = Object::new();
        if let Some(id) = origin {
            props.insert("origin".into(), Value::String(id.into()));
        }
        if let Some(id) = dest {
            props.insert("destination".into(), Value::String(id.into()));
        }
        if let Some(id) = opening {
            let mut obj = Object::new();
            obj.insert("id".into(), Value::String(id.into()));
            obj.insert("feature_type".into(), Value::String("opening".into()));
            props.insert("intermediary".into(), Value::Object(obj));
        }
        if let Some(d) = direction {
            props.insert("direction".into(), Value::String(d.into()));
        }
        // OSM hours must not affect parse / direction.
        props.insert("hours".into(), Value::String("Mo-Fr 09:00-17:00".into()));
        VenueFeature {
            id: "rel-1".into(),
            feature_type: FeatureType::Relationship,
            level_id: None,
            geometry: None,
            center: None,
            labels: BTreeMap::new(),
            alt_labels: BTreeMap::new(),
            category: None,
            accessibility: Vec::new(),
            restriction: None,
            source_properties: props,
        }
    }

    #[test]
    fn relationship_without_direction_leaves_both() {
        let parsed = parse_relationships(&[rel(Some("u-a"), Some("u-b"), Some("op-1"), None)]);
        assert_eq!(parsed.len(), 1);
        assert!(!parsed[0].directed);
        assert!(directed_by_opening(&parsed).is_empty());
    }

    #[test]
    fn relationship_undirected_is_not_directed() {
        let parsed = parse_relationships(&[rel(
            Some("u-a"),
            Some("u-b"),
            Some("op-1"),
            Some("undirected"),
        )]);
        assert!(!parsed[0].directed);
        assert!(directed_by_opening(&parsed).is_empty());
    }

    #[test]
    fn relationship_directed_indexes_opening() {
        let parsed = parse_relationships(&[rel(
            Some("u-a"),
            Some("u-b"),
            Some("op-1"),
            Some("directed"),
        )]);
        let map = directed_by_opening(&parsed);
        assert_eq!(map.get("op-1"), Some(&("u-a".into(), "u-b".into())));
    }

    #[test]
    fn relationship_directed_missing_endpoint_is_ignored() {
        let parsed = parse_relationships(&[rel(Some("u-a"), None, Some("op-1"), Some("directed"))]);
        assert!(parsed[0].directed);
        assert!(directed_by_opening(&parsed).is_empty());
    }

    #[test]
    fn relationship_conflict_drops_opening() {
        let a = rel(Some("u-a"), Some("u-b"), Some("op-1"), Some("directed"));
        let mut b = rel(Some("u-b"), Some("u-a"), Some("op-1"), Some("directed"));
        b.id = "rel-2".into();
        let map = directed_by_opening(&parse_relationships(&[a, b]));
        assert!(!map.contains_key("op-1"));
    }

    #[test]
    fn relationship_hours_are_not_parsed() {
        let parsed = parse_relationships(&[rel(
            Some("u-a"),
            Some("u-b"),
            Some("op-1"),
            Some("directed"),
        )]);
        assert_eq!(parsed[0].origin.as_deref(), Some("u-a"));
        assert!(directed_by_opening(&parsed).contains_key("op-1"));
    }

    #[test]
    fn relationship_bind_requires_both_sides() {
        assert_eq!(
            bind_doorway_directions(&[(true, false), (false, true)]),
            vec![TravelDirection::Reverse, TravelDirection::Forward]
        );
        assert_eq!(
            bind_doorway_directions(&[(true, false), (true, false)]),
            vec![TravelDirection::Both, TravelDirection::Both]
        );
        assert_eq!(
            bind_doorway_directions(&[(false, true)]),
            vec![TravelDirection::Both]
        );
        assert_eq!(
            bind_doorway_directions(&[(true, true), (false, true)]),
            vec![TravelDirection::Both, TravelDirection::Both]
        );
    }
}
