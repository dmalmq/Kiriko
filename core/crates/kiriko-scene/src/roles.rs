use crate::SemanticRole;

/// Map a Revit category onto one of the twelve semantic roles. Matching is
/// case-insensitive and substring-based because exporters vary
/// ("Floors", "floor", "Revit Floors"). Unknown categories become `Context`:
/// contextual mass never becomes navigable surface by accident.
pub fn role_for_category(category: &str) -> SemanticRole {
    let normalized = category.to_ascii_lowercase();
    const RULES: &[(&str, SemanticRole)] = &[
        ("escalator", SemanticRole::Escalator),
        ("elevator", SemanticRole::Elevator),
        ("lift", SemanticRole::Elevator),
        ("stair", SemanticRole::Stairs),
        ("ramp", SemanticRole::Ramp),
        // Revit stair components are the walkable stair geometry itself
        // (Runs, Landings) and structural stair/mechanical supports
        // (Supports). Kept after the conveyance rules so `escalator`,
        // `elevator`, and `stair` still win on any compound category.
        ("run", SemanticRole::Stairs),
        ("landing", SemanticRole::Stairs),
        ("support", SemanticRole::Structure),
        ("door", SemanticRole::Opening),
        ("opening", SemanticRole::Opening),
        ("window", SemanticRole::Opening),
        ("ceiling", SemanticRole::Ceiling),
        ("roof", SemanticRole::Ceiling),
        ("floor", SemanticRole::Walkable),
        ("slab", SemanticRole::Walkable),
        ("wall", SemanticRole::Structure),
        ("column", SemanticRole::Structure),
        ("structural", SemanticRole::Structure),
        ("stair rail", SemanticRole::Structure),
        ("railing", SemanticRole::Structure),
        ("room", SemanticRole::Public),
        ("retail", SemanticRole::Public),
        ("shop", SemanticRole::Public),
        ("office", SemanticRole::Service),
        ("mechanical", SemanticRole::Service),
        ("plumbing", SemanticRole::Service),
        ("electrical", SemanticRole::Service),
        ("restricted", SemanticRole::Restricted),
        ("staff", SemanticRole::Restricted),
    ];
    for (needle, role) in RULES {
        if normalized.contains(needle) {
            return *role;
        }
    }
    SemanticRole::Context
}

/// Ceilings and unknown contextual mass may occlude; navigable and conveyance
/// surfaces never do (issue #32 section 6).
pub fn occlusion_for_role(role: SemanticRole) -> crate::OcclusionClass {
    match role {
        SemanticRole::Ceiling => crate::OcclusionClass::ProtectedCorridor,
        SemanticRole::Structure | SemanticRole::Context => crate::OcclusionClass::Context,
        _ => crate::OcclusionClass::Never,
    }
}
