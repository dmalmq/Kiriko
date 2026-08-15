# Renderer-neutral 3D visual language — design

Date: 2026-08-03  
Status: approved (design); prototype implementation planned
Issue: [#32 — Choose the renderer-neutral 3D visual language](https://github.com/dmalmq/imdf-map-application/issues/32)

## 1. Decision

Kiriko uses **Architectural Cutaway** as one semantic 3D visual language over
both detailed 3D Tiles and renderer-generated geometry.

The scene is a calm, matte architectural model: warm white navigable surfaces,
cool stone structure, restrained soft depth, selective semantic edges, and
screen-facing labels. Active-floor ceilings are removed. Only semantic
occluders that obstruct the current route, selection, or priority label fade.
Ai Indigo is reserved for interaction, selection, and route state.

Tiles and Generated 3D use the same material roles and state treatments. Their
actual geometry remains honestly different in detail. Normal navigation shows
a quiet localized source badge—**Detailed 3D** or **Generated 3D**—and selection
details expose provenance, association, confidence, assumptions, and overrides.
Kiriko does not tint Generated 3D as inferior, preserve arbitrary source
materials in navigation, or mix generated geometry into a Tiles scene to fill
holes.

This decision extends the existing Kiriko “Cut Glass” system into 3D without
creating a second product aesthetic. It preserves the scene-source contract in
issue #30, the geometry/elevation contract in issue #19, the diagnostic
semantics in issue #20, the KVB seam in issue #24, and the Guided transition
navigation model in issue #25.

## 2. Goals and boundaries

### Goals

- Make Tiles, Generated 3D, and universal 2D fallback feel like one Kiriko
  navigation product.
- Keep route, active floor, selection, and next action legible before model
  detail.
- Disclose source fidelity without turning normal navigation into QA software.
- Express visual meaning as renderer-neutral semantic roles and observable
  states, not MapLibre, WebGL, Three.js, or native-renderer objects.
- Preserve bilingual labels, keyboard/focus equivalence, non-color cues, and
  reduced-motion parity.
- Give producer diagnostics an exact, source-neutral point/segment/area visual
  vocabulary without restyling the venue.

### Non-goals

- Selecting the rendering architecture; issue #23 owns that boundary.
- Setting device, frame, decode, memory, and picking budgets; issue #26 owns
  those gates.
- Changing geometry generation, floor registration, source association,
  persistence, routing, or graph-editing semantics.
- Matching Revit or source-authored materials in normal navigation.
- Photorealism, day/night simulation, decorative animation, or arbitrary venue
  themes.

## 3. Renderer-neutral style contract

Every scene adapter consumes the same semantic state and maps it to its own
rendering primitives. An adapter must implement these inputs:

- semantic material role;
- canonical level and active/inactive/overview membership;
- surface, structure, ceiling, opening, portal, and conveyance roles;
- occlusion class and whether the object currently obstructs a protected visual
  corridor;
- canonical and source-object selection, hover, keyboard focus, and disabled
  state;
- route segment phase and connector role;
- diagnostic geometry, severity, selection, and exception state;
- label category, priority, locale, and anchor;
- scene-source kind, fidelity/provenance summary, and structured fallback state;
- motion preference.

Adapters may differ internally, but the observable hierarchy, semantic colors,
non-color state cues, occlusion outcome, and label order must match. Renderer
capabilities never become domain identity. Per-triangle wireframes, renderer
material indexes, GPU object IDs, and source shader parameters are not visual
semantics.

## 4. Semantic materials and palette

All colors use the existing Kiriko palette. Materials are matte and opaque by
default; opacity is a state treatment, not a source-fidelity signal.

| Role | Base treatment | Purpose |
|---|---|---|
| `scene.canvas` | `#EDEDEB` | Quiet cool-stone field behind the model |
| `surface.walkable` | `#FAFAF9` | Primary navigable floor and concourse surface |
| `surface.public` | `#E9EDF4` | Public room/unit surface |
| `surface.service` | `#F0EBE0` | Service and amenity room surface |
| `surface.restricted` | `#D5DAE3` | Restricted/non-public surface; semantics also appear in labels/details |
| `structure.primary` | `#D5DAE3` with `#C8CEDA` semantic edges | Walls, slabs, shafts, and columns |
| `structure.conveyance` | Neutral stone with per-kind tint and silhouette edge, at permanent see-through shell opacity | Elevator, escalator, stairs/steps, ramp, and generic conveyance shells; see section 9 |
| `structure.context` | `#D5DAE3` at contextual opacity | Nearby non-active or non-navigable mass |
| `surface.ceiling` | `#D5DAE3` | Classified ceiling; visibility follows section 6 |
| `opening.portal` | `#9AA3B2` edge/gap treatment | Door, opening, and portal evidence |
| `state.selectedSoft` | `#EEF2FF` | Hover/selection fill reinforcement |
| `state.indigo` | `#4F46E5` | Route, interaction, focus, and selection only |
| `diagnostic.defect` | `#DC2626` | Deterministic contradiction, paired with diamond/solid pattern |
| `diagnostic.review` | `#B45309` | Inferred/contextual review, paired with triangle/dashed pattern |
| `diagnostic.advisory` | `#78716C` | Uncertainty/coverage, paired with circle/dotted pattern |

The review amber is `#B45309` (amber-700), not the lighter `#D97706`: prototype
verification measured `#D97706` at 3.19:1 as 12 px severity text on panel white
and ~2.6:1 as a scene marker, failing the WCAG AA and 1.4.11 floors this design
commits to in section 14. Hue, meaning, and the triangle/dashed pattern pairing
are unchanged.

Original Tiles materials remain provenance and may be inspected in a dedicated
producer source-material view. They do not appear in normal navigation because
arbitrary source colors would break hierarchy, source parity, and the One
Indigo Rule. Generated geometry is not hatched or tinted in normal navigation.
Provenance overlays are producer-QA filters only.

Where a renderer supports physically based materials, the semantic surfaces
use high roughness and negligible metallic/specular response. A non-PBR
renderer must produce the equivalent matte appearance rather than emulate PBR
parameters literally.

## 5. Lighting and depth

Lighting explains form without becoming content:

- one world-stable soft key from above and geographic northwest;
- broad ambient/hemisphere fill so no navigable face becomes unreadably dark;
- restrained contact shadow or ambient occlusion at wall/floor and
  conveyance/floor junctions;
- no environment reflections, glossy highlights, colored lighting, time-of-day
  changes, bloom, fog, depth-of-field, or dramatic sun shadows.

The key contributes roughly one-third and ambient fill roughly two-thirds of
perceived illumination. Renderer implementations may tune their numeric light
models, but cast/contact darkness must remain at or below approximately 12% over
the receiving surface and must never encode state. Light direction is stable in
world space during camera movement so surfaces do not “swim.”

Depth comes from source geometry, level separation, muted face-value changes,
contact shadow, and selective edges—in that order. Kiriko does not draw every
mesh or triangle edge. Adapters derive only semantic boundaries, openings,
silhouette edges, selected outlines, and diagnostic geometry. Fine Tiles detail
may remain visible through form and shadow; it does not receive heavier styling
than Generated 3D.

## 6. Ceilings, cutaway, and occlusion

### Normal navigation

- The active canonical floor's classified ceiling surfaces are hidden.
- Adjacent route floors are hidden, matching the Guided transition model.
- Context outside the active navigation floor may remain as a low-opacity
  silhouette when it helps orientation and cannot block the route or labels.
- A classified wall, slab edge, ceiling remnant, shaft shell, or contextual
  element fades only while it intersects a protected camera corridor to the
  active route, canonical selection, next-action conveyance, destination, or
  priority label.
- In ordinary single-floor navigation, navigable floor surfaces and the active
  route never fade because of camera occlusion.

When a cross-floor connection view shows a pair of floors, the lower floor of
the pair renders at full semantic opacity and the higher floor renders
see-through at roughly 25% opacity, including its navigable floor surfaces.
Elevation, not selection, decides the see-through treatment. This is a
deliberate exception to the ordinary single-floor rules above: an opaque upper
floor makes the inter-floor connector unreadable, which was a real reported
defect.

A faded semantic occluder targets 12–18% opacity. Ordinary contextual mass
targets 20–28%. In ordinary single-floor navigation, the active floor's
navigable surfaces and non-obstructing structure stay at full semantic opacity.
Opacity changes use a short 140–180 ms ease in normal motion and switch
immediately under reduced motion.

### Route overview and floor handoff

Route overview may show all route floors and the inter-floor connector. The
current floor remains full opacity; other route floors use 24–32% venue opacity,
and their route legs use 40–50% Ai Indigo opacity. During Guided transition,
the destination floor enters with this overview treatment, then becomes the
active full-opacity floor only when route state switches.

Kiriko never crossfades two independently fitted scene sources or displays
Tiles and Generated geometry together to disguise gaps. A source fallback uses
a brief canvas-colored veil, replaces the source, updates the source badge, and
reveals the new scene while preserving route, floor, camera target, and
canonical selection. Reduced motion replaces it immediately.

### Activation consequence

An opaque Tiles primitive must be assignable to a canonical floor or an
explicit contextual occlusion class. A source that cannot provide the required
ceiling/filtering/occlusion outcome fails Tiles activation, as required by issue
#30. The renderer does not guess from depth-buffer behavior or source material
names at runtime.

## 7. Geometry emphasis

The visual hierarchy is:

1. active route and next action;
2. current floor, selected conveyance, destination, and canonical selection;
3. openings, walkable boundaries, and orientation landmarks;
4. ordinary rooms, structure, and fixtures;
5. contextual/inactive geometry;
6. producer diagnostics when QA mode is active.

Semantic structure edges use the existing cool `#C8CEDA` family and remain
subordinate to the route. Default edges are hairline-like and stable in screen
space where supported. No universal black outline, cartoon edge pass, or
source-mesh wireframe is permitted.

Generated geometry uses the most specific evidence-backed form available. When
inputs do not justify detailed doors, flights, machinery, shafts, or ramps, it
uses the category-specific neutral form from issue #19. The style does not add
fake detail to compensate.

## 8. Labels

Labels are screen-facing overlays, not textures baked into geometry. They use
Inter with Noto Sans JP fallback, locale-correct content, and an opaque or
near-opaque white halo/backplate sufficient to maintain WCAG AA text contrast
over every scene surface.

Collision and visibility priority is:

1. current next action;
2. route destination;
3. current canonical selection or keyboard focus;
4. selected/next conveyance and destination floor;
5. exits and route-critical entrances;
6. major orientation landmarks;
7. facilities and ordinary room labels.

Lower-priority labels yield rather than overlap higher-priority labels. Labels
are horizontal in screen space, limited to two lines, and truncate only after
category fallback and locale-aware fitting. Machine IDs and measured values use
IBM Plex Mono in producer details, not on the normal navigation canvas.

A label anchor may follow its associated object, but it cannot bob, rotate,
scale continuously, or disappear behind the model. If its anchor is occluded,
the semantic occluder fades or a bounded leader line moves the label to the
nearest clear screen-space position. A label never becomes visible by rendering
through unrelated geometry without a leader or fade cue.

## 9. Conveyance treatment

Elevator, escalator, stairs/steps, ramp, landing, shaft, and portal each have a
stable category silhouette plus the existing JIS pictogram where available.
The renderer may use detailed source geometry when present, but the semantic
identity comes from the category silhouette/pictogram, not machinery detail.
Neutral conveyance shells — elevator, escalator, stairs/steps, ramp, and
generic conveyance volumes — render as permanently see-through shells with a
per-kind tint and a silhouette edge. A shell is never opaque: it exists to
explain the routing graph it encloses, and opacity would hide that graph. The
see-through state is a constant material treatment, not an occlusion-driven
fade; dynamic fading of otherwise-opaque structure still follows section 6.

- **Elevator:** neutral shaft/door frame plus elevator pictogram.
- **Escalator:** inclined neutral bed or footprint with aligned chevrons and
  escalator pictogram.
- **Stairs/steps:** stepped or ladder-like neutral form with stairs pictogram.
- **Ramp:** inclined plane/footprint with slope chevron and accessible-route
  semantics when supported by canonical data.
- **Landing:** neutral continuation surface, not a separate decorative color.
- **Portal/opening:** deliberate gap or threshold edge; a closed door leaf is
  shown only when source evidence supports it.

Direction is always encoded by a static arrow or chevron, and only from graph
evidence: a chevron is drawn when the routing graph states an up/down
connection for that feature, and direction is never inferred from geometry,
names, or category when the graph does not state it. Animation may reinforce
direction in a future navigation implementation, but it cannot be the only
direction cue and is absent under reduced motion. A route-selected conveyance
uses Ai Indigo outline/mist treatment; amber is not a route-handoff color
because it is reserved for Review/warning semantics.

## 10. Interaction states

- **Default:** semantic base material and edge.
- **Hover:** Indigo Mist reinforcement and a restrained Ai Indigo edge; pointer
  hover is supplemental and has no exclusive action.
- **Keyboard focus:** the selected treatment plus a visible white separation and
  Ai Indigo outer focus line. The focused object is announced with its label,
  category, floor, and source/fidelity summary.
- **Selected canonical object:** Indigo Mist fill plus a 2–3 device-independent
  pixel Ai Indigo semantic outline; related labels/details become priority.
- **Selected source-only object:** permitted in producer QA only; the same
  selection treatment appears with an explicit unassociated-source label. It
  cannot impersonate a canonical feature.
- **Disabled/unavailable:** retains shape and text with reduced neutral emphasis;
  no disabled state is represented only by opacity.

Selection, hover, and focus are state overlays. They do not mutate or replace
the base material role. A diagnostic object retains its severity shape/pattern
when selected; an outer Ai Indigo selection halo is added around it.

## 11. Route states and floor storytelling

The existing Guided transition decision remains authoritative.

### Route geometry

- Route core: Ai Indigo, approximately 4 device-independent pixels on desktop
  and 5 on mobile, with a white casing approximately 4 pixels wider overall.
- Current leg: 100% opacity.
- Future leg on the active floor: 55–65% opacity until it becomes current.
- Completed leg: 28–36% opacity.
- Inter-floor connector: the same indigo with a stable dash pattern and
  conveyance symbol; no second hue.
- Direction: static white cut-in chevrons or arrowheads spaced sparsely enough
  to preserve line continuity.
- Origin: white centre with Ai Indigo ring.
- Destination: Ai Indigo centre with white separation ring.
- Live position/progress, when available: a distinct concentric point and
  accessible text, never color alone.

Route geometry stays above venue geometry and beneath labels/focus rings. It is
not venue-pickable. Route interaction belongs to the directions flow.

### Cross-floor behavior

At a connector, Kiriko pulls back, reveals the destination route floor in
context opacity, emphasizes the selected conveyance, switches canonical active
floor, and settles on the next leg. Manual floor exploration pauses automatic
following and exposes Return to route. Route overview is reversible and does
not change progress. Replay floor change repeats the state sequence.

Under reduced motion, the same route, floor, selection, announcement, and focus
states change in the same order without camera interpolation, opacity tween,
animated dash, pulse, or chevron motion.

## 12. Diagnostic states

Producer QA overlays compact semantic geometry on the unchanged Architectural
Cutaway scene:

| State | Color | Non-color cue | Line/area cue |
|---|---|---|---|
| Defect | `#DC2626` | Diamond | Solid |
| Review | `#B45309` | Triangle | Dashed |
| Advisory | `#78716C` | Circle | Dotted |
| Accepted exception | Stone neutral | Check/outlined badge | Muted source pattern |
| Selected finding | Existing severity plus Ai Indigo outer halo | Focus ring and synchronized panel row | Severity pattern retained |

Point, segment, and area markers carry the same finding identity as the grouped
panel. Selecting either representation focuses the same evidence. Defect and
Review are visible by default in QA; Advisory, Not evaluated, and accepted
exceptions remain summarized and filterable as decided in issue #20. Not
evaluated is not drawn as a passed or failed scene state.

Provenance/confidence overlays use neutral hatch or stipple plus explicit labels
inside producer QA only. They never recolor normal navigation and never promote
an inferred conflict to Defect styling.

## 13. Fidelity disclosure and fallback

Normal navigation shows one compact, neutral, locale-specific badge:

- `sceneSource.detailed`: **Detailed 3D** / **詳細 3D**
- `sceneSource.generated`: **Generated 3D** / **生成 3D**
- `sceneSource.twoDimensional`: **2D map** / **2D マップ**

The badge communicates what the user is seeing without exposing a technical
renderer selector. Selection details expose source asset/object, canonical
association, provenance, confidence, assumptions, and producer override. The
producer QA surface adds registration profile, evidence, composite tile level,
and source-material inspection.

Runtime fallback follows issue #30: one bounded Tiles retry, then one-way Tiles
to Generated 3D to 2D for that session. The notice is concise, non-blocking,
bilingual, and offers one explicit Retry detailed 3D action. The visual state
and badge change; routing results and publication state do not.

## 14. Accessibility, reduced motion, and 2D parity

- Meaning never depends on color, transparency, shadow, texture, or motion
  alone.
- Labels and control copy meet WCAG AA contrast against their actual backplate.
- Every pickable semantic object has a keyboard-equivalent focus/select path or
  a synchronized list/panel path.
- Focus remains visible over every material and diagnostic state.
- JIS pictograms supplement localized accessible names; they never replace
  names.
- The active locale is declared, and mixed Japanese/English strings use the
  existing Inter/Noto Sans JP stack and CJK-safe line height.
- Reduced motion removes camera interpolation, source-replacement veil,
  crossfades, pulses, animated dashes, and directional animation. State changes,
  announcements, focus movement, route progress, and floor selection remain
  identical.
- Universal 2D fallback reuses semantic fills, Indigo/white route casing,
  origin/destination markers, conveyance pictograms, diagnostic shapes/patterns,
  selection/focus rules, label priority, and the source badge.

A 3D view is never the only way to inspect a selection or finding. The
synchronized panel/2D path remains usable when geometry is occluded, 3D is
unsupported, or depth perception is difficult.

## 15. Adapter and data responsibilities

Rust/KVB supplies closed semantic roles, canonical/source associations,
provenance, level membership, resolved floor planes, occlusion classes,
conveyance categories, route/diagnostic identity, and structured capability
failure. TypeScript/native platform code owns renderer adaptation, screen-space
labeling, interaction gestures, camera presentation, source fetching, and
ephemeral visual state.

The adapter may cache material instances and renderer objects, but must not
infer domain semantics from Revit names, source material indexes, raw GDB
property keys, triangle topology, or colors. A missing semantic role degrades
to the neutral context treatment and a structured capability/coverage result;
it never silently invents a canonical feature or detailed conveyance.

## 16. Verification contract

A later implementation/prototype must demonstrate the same state matrix over a
deterministic multi-floor fixture and the registered Tokyo Tiles/GDB pair:

- Tiles and Generated 3D show equivalent material roles, route hierarchy,
  selection, labels, conveyance identity, and diagnostics without mixing
  geometry.
- Geometry-detail differences remain visible and each source badge is accurate.
- Active-floor ceilings are absent; protected route/selection/label corridors
  remain readable from representative camera headings and pitches.
- Route current/future/completed, origin/destination, connector, overview,
  manual exploration, Return to route, replay, pause, and fallback states
  preserve the issue #25 state model.
- Defect, Review, Advisory, accepted exception, Not evaluated, and selected
  finding states retain both severity and non-color cues.
- Hover, pointer selection, keyboard focus/selection, and synchronized panel
  selection identify the same semantic object.
- Japanese and English labels fit and collide according to the same priority.
- Reduced motion produces identical final route/floor/selection/fallback state
  with no camera interpolation, pulse, animated dash, or opacity tween.
- 2D fallback preserves the semantic hierarchy and all critical actions.
- Visual checks cover desktop `1440×900`, compact desktop `1180×720`, and mobile
  `390×844`; producer QA remains desktop-only as decided in issue #27.
- Automated snapshots/goldens cover semantic state combinations, while browser
  smoke scenarios prove camera occlusion, label placement, focus, and source
  fallback behavior. Exact performance budgets come from issue #26.

## 17. Alternatives rejected

### Luminous Blueprint

Cool translucency and persistent linework expose topology well, but dense Tokyo
geometry becomes visually noisy and reads as engineering/GIS software. Blended
transparency is also renderer-sensitive and weakens source parity.

### Physical Miniature

Richer source materials, taller solids, and stronger cast shadows make Tiles
feel tangible, but they amplify the fidelity gap with Generated 3D, worsen
occlusion, and compete with route and diagnostic state.

### Seamless source disclosure only in the inspector

This produces the cleanest canvas but can imply that detailed Tiles and inferred
Generated 3D carry equal source fidelity. The quiet always-visible badge is the
smallest honest disclosure.

### Source-specific scene tint

Tinting or hatching Generated 3D in normal navigation makes provenance obvious
but creates a visibly secondary product and lets source kind outrank navigation.
Provenance treatments therefore remain available only in producer QA.
