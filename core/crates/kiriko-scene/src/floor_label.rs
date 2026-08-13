//! Comparing a tile level's own label against a venue floor's (#81).
//!
//! Altitude decides which canonical floor a tile level is, and altitude alone
//! cannot catch a stack offset by roughly a storey: every level lands on its
//! neighbour, and where footprints repeat the residuals against the wrong floor
//! measure as small as against the right one.
//!
//! A label is the corroboration altitude lacks. It is deliberately **not** a
//! join key — #30 section 3 settles that `levelKey` never identifies a floor on
//! its own, and nothing here ever selects a mapping. It only agrees with the one
//! altitude chose, contradicts it by naming a different floor, or says nothing.
//!
//! Saying nothing is the common case and must stay cheap: two exports that share
//! no naming convention produce no evidence, which is not the same as producing
//! evidence of correctness.

use std::collections::BTreeSet;

/// Full-width ASCII sits exactly this far above its half-width twin.
const FULLWIDTH_OFFSET: u32 = 0xFEE0;

/// The comparable forms of one raw label.
///
/// Two, because floor labels in this data are often `<code> <place>` — "B1F
/// Yaesu" names the same floor as "B1F". The whole string and its first token are
/// both offered; a caller compares sets, so an extra candidate can only find
/// agreement that exists, never invent one.
#[must_use]
pub fn floor_label_candidates(raw: &str) -> BTreeSet<String> {
    let mut candidates = BTreeSet::new();
    let widened = half_width(raw);
    if let Some(whole) = reduce(&widened) {
        candidates.insert(whole);
    }
    if let Some(first) = widened.split_whitespace().next()
        && let Some(token) = reduce(first)
    {
        candidates.insert(token);
    }
    candidates
}

/// Full-width forms to their ASCII twins, and the ideographic space to a plain
/// one. Japanese station data carries both, and `Ｂ１Ｆ` names the floor `B1F`
/// does.
fn half_width(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - FULLWIDTH_OFFSET).unwrap_or(c),
            _ => c,
        })
        .collect()
}

/// One label reduced to its comparable form, or `None` when nothing usable is
/// left.
///
/// Every rule below exists for a form that actually occurs: Revit `L1` beside
/// IMDF `1F`, Revit `b1fl` beside IMDF `B1F`, Japanese `地下1階` beside `B1F`.
/// Nothing here parses an ordinal — `b1` and `1` stay different strings, and
/// deciding which is lower is exactly the inference #74 refuses.
fn reduce(raw: &str) -> Option<String> {
    let lowered = raw.to_lowercase().replace("地下", "b");
    let mut cleaned: String = lowered
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '階')
        .collect();

    // A storey suffix, only after a digit: `1f` is floor 1, but `roof` is not
    // `roo`, and `half` is not `hal`.
    for suffix in ["階", "floor", "fl", "f"] {
        if let Some(stem) = cleaned.strip_suffix(suffix)
            && stem.ends_with(|c: char| c.is_ascii_digit())
        {
            cleaned = stem.to_string();
            break;
        }
    }

    // A level prefix, only before a digit: `l1` is level 1, but `lobby` is not
    // `obby`.
    for prefix in ["level", "lvl", "l"] {
        if let Some(rest) = cleaned.strip_prefix(prefix)
            && rest.starts_with(|c: char| c.is_ascii_digit())
        {
            cleaned = rest.to_string();
            break;
        }
    }

    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned)
}

/// Whether a tile level's labels and a venue floor's labels name the same floor.
#[must_use]
pub fn labels_agree(tile: &BTreeSet<String>, venue: &BTreeSet<String>) -> bool {
    tile.intersection(venue).next().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates(raw: &str) -> Vec<String> {
        floor_label_candidates(raw).into_iter().collect()
    }

    #[test]
    fn a_revit_level_key_and_an_imdf_short_name_reduce_to_the_same_form() {
        // The pairs that occur in this data, and the whole point of the module.
        for (revit, imdf) in [
            ("L1", "1F"),
            ("b1fl", "B1F"),
            ("B1", "B1F"),
            ("M2F", "M2F"),
            ("LEVEL 2", "2F"),
        ] {
            let tile = floor_label_candidates(revit);
            let venue = floor_label_candidates(imdf);
            assert!(
                labels_agree(&tile, &venue),
                "{revit} and {imdf} should name one floor, got {tile:?} vs {venue:?}"
            );
        }
    }

    #[test]
    fn different_storeys_never_agree() {
        for (a, b) in [("1F", "2F"), ("B1", "1F"), ("B1F", "B2F"), ("M2F", "2F")] {
            assert!(
                !labels_agree(&floor_label_candidates(a), &floor_label_candidates(b)),
                "{a} and {b} are different floors"
            );
        }
    }

    #[test]
    fn full_width_and_japanese_forms_reduce_to_the_ascii_one() {
        assert!(labels_agree(
            &floor_label_candidates("Ｂ１Ｆ"),
            &floor_label_candidates("B1F"),
        ));
        assert!(labels_agree(
            &floor_label_candidates("地下1階"),
            &floor_label_candidates("B1F"),
        ));
        assert!(labels_agree(
            &floor_label_candidates("１階"),
            &floor_label_candidates("1F"),
        ));
    }

    #[test]
    fn a_qualified_name_still_names_its_floor() {
        // "B1F Yaesu" is the Yaesu end of B1F, not a different storey.
        assert!(labels_agree(
            &floor_label_candidates("B1F Yaesu"),
            &floor_label_candidates("B1F"),
        ));
        assert!(candidates("B1F Yaesu").contains(&"b1".to_string()));
    }

    #[test]
    fn a_storey_suffix_is_only_stripped_after_a_digit() {
        // Otherwise every word ending in f loses it, and unrelated labels start
        // agreeing with each other.
        assert_eq!(candidates("Roof"), vec!["roof".to_string()]);
        assert_eq!(candidates("Half"), vec!["half".to_string()]);
        assert!(!labels_agree(
            &floor_label_candidates("Roof"),
            &floor_label_candidates("Roo"),
        ));
    }

    #[test]
    fn a_level_prefix_is_only_stripped_before_a_digit() {
        assert_eq!(candidates("Lobby"), vec!["lobby".to_string()]);
        assert!(!labels_agree(
            &floor_label_candidates("Lobby"),
            &floor_label_candidates("obby"),
        ));
    }

    #[test]
    fn separators_and_case_do_not_make_two_floors_of_one() {
        assert!(labels_agree(
            &floor_label_candidates("b-1_f"),
            &floor_label_candidates("B1F"),
        ));
    }

    #[test]
    fn a_label_with_nothing_comparable_in_it_yields_no_candidates() {
        // Nothing to corroborate with is not a contradiction; the caller must see
        // an empty set rather than a string that accidentally matches something.
        assert!(floor_label_candidates("").is_empty());
        assert!(floor_label_candidates("   ").is_empty());
        assert!(floor_label_candidates("---").is_empty());
    }

    #[test]
    fn a_name_that_is_only_a_place_stays_that_place() {
        // No digit, no storey marker: still a label, still comparable, and it
        // agrees only with the same place.
        assert!(labels_agree(
            &floor_label_candidates("Concourse"),
            &floor_label_candidates("concourse"),
        ));
        assert!(!labels_agree(
            &floor_label_candidates("Concourse"),
            &floor_label_candidates("Platform"),
        ));
    }
}
