## Resolved: [Choose the renderer-neutral 3D visual language](https://github.com/dmalmq/imdf-map-application/issues/32)

## Decision

Kiriko adopts **Architectural Cutaway** as the single semantic 3D visual language over both scene sources. The scene is a calm, matte architectural model: warm white navigable surfaces, cool stone structure, restrained soft depth, selective semantic edges, and screen-facing labels. Tiles-backed and generated scenes are rendered by one style; only geometry fidelity and provenance differ.

Design: [`docs/superpowers/specs/2026-08-03-renderer-neutral-3d-visual-language-design.md`](https://github.com/dmalmq/imdf-map-application/blob/prototype/renderer-neutral-3d-visual-language/docs/superpowers/specs/2026-08-03-renderer-neutral-3d-visual-language-design.md)

### Shared semantic materials and the normal-navigation source override

Both sources use the same semantic palette — walkable `#FAFAF9`, public `#E9EDF4`, service `#F0EBE0`, structure `#D5DAE3` with `#C8CEDA` semantic edges, openings as `#9AA3B2` gaps. Source materials never reach normal navigation: original Tiles materials stay provenance-only, and generated geometry is never hatched or tinted to look inferior. One world-stable soft key plus hemisphere fill; contact darkness stays at or below ~12%; no environment reflections, bloom, or time-of-day.

### Quiet source badges and inspectable provenance

Each viewport carries a quiet source badge plus one provenance line (`3D Tiles · source-authored detail` / `Kiriko generated · evidence-backed approximation` / `Universal 2D fallback`). Compare mode adds a neutral disclosure: *Same semantic style. Different source geometry and provenance.* Deeper provenance (neutral hatch plus source-property caption) appears only under producer QA source-material inspection and never recolors route, selection, labels, or diagnostics.

### Ceiling and occlusion rules

The active floor's classified ceilings are hidden; adjacent floors are hidden in guidance/selection/diagnostics and enter as low-opacity context during floor handoff and route overview. Only objects classified as protected-corridor occluders fade (15%), and only when they would obstruct the route, selection, or a priority label. Nothing else is dissolved for the camera.

### Label and conveyance hierarchy

Labels are screen-facing with a white halo, priority-ordered (next action → destination → selection → conveyance → exit → landmark), capped at four in navigation and six in overview/diagnostics, deterministically displaced on collision with a bounded leader past 18 px, and the selected/next conveyance label always survives. Conveyances use JIS pictograms (`markerIconFor`) inside screen-facing badges; a ramp with no JIS asset gets a neutral inclined plane with one static slope chevron.

### Indigo-only interaction and route states

Ai Indigo `#4F46E5` is the only interaction color: hover, focus, pointer selection, synchronized panel selection, route casing/core, origin/destination markers, and the connector. Route phases are current `1`, future `.6`, completed `.32`; overview drops other-floor legs to `.45`; the connector uses a static `7 5` dash with no dash animation. Amber is never a route or handoff color — it is reserved for Review semantics.

### Shape-and-pattern diagnostic states

| State | Color | Non-color cue | Line/area cue |
|---|---|---|---|
| Defect | `#DC2626` | Diamond | Solid |
| Review | `#B45309` | Triangle | Dashed |
| Advisory | `#78716C` | Circle | Dotted |
| Accepted exception | Stone neutral | Outlined check badge | Muted hatch |
| Selected finding | Severity retained + Ai Indigo outer halo | Focus ring + synchronized panel row | Severity pattern retained |

Default QA shows Defect and Review; `All findings` adds Advisory and accepted exceptions. Findings are filtered by severity, never by active floor — they are QA overlays carrying their own floor identity. Not evaluated exists only as panel copy, never as a scene marker.

**Spec amendment from verification:** the review amber moved from `#D97706` to `#B45309`. Measured in the prototype, `#D97706` was 3.19:1 as 12 px severity text and ~2.6:1 as a scene marker, below the WCAG AA and 1.4.11 floors this design commits to. `#B45309` measures 5.02:1 as text and 4.28–4.81:1 as a marker. Hue, meaning, and pattern pairing are unchanged.

### Reduced motion and 2D parity

Normal motion is limited to 140–180 ms opacity/transform transitions for occluder fade, source veil, and state emphasis; no orbit, pulse, or dash animation. Reduced motion produces the same route, floor, selection, and announcement states in the same order with no interpolation and no source veil (the source is replaced immediately). The 2D map keeps identical semantic roles, route phases, markers, labels, and diagnostic cues on a flattened projection.

### Source switching never mixes geometry

Kiriko never crossfades two independently fitted sources. A fallback covers the canvas with a brief canvas-colored veil, replaces the source, updates badge and provenance, and preserves route, floor, and selection. Verified frame-by-frame: no frame ever contains both Detailed and Generated geometry, and entering Fallback collapses Compare to a single source so a live Detailed viewport can never sit beside a "Detailed 3D is unavailable" notice.

## Prototype

- Branch: https://github.com/dmalmq/imdf-map-application/tree/prototype/renderer-neutral-3d-visual-language (head `2dd0d1e`)
- Entry: `git switch prototype/renderer-neutral-3d-visual-language && pnpm install && pnpm dev`, then open `http://localhost:5173/?prototype=visual-language`
- Plan: [`docs/superpowers/plans/2026-08-03-renderer-neutral-3d-visual-language-prototype.md`](https://github.com/dmalmq/imdf-map-application/blob/prototype/renderer-neutral-3d-visual-language/docs/superpowers/plans/2026-08-03-renderer-neutral-3d-visual-language-prototype.md)

### Evidence

| Scenario | Image |
|---|---|
| Source parity, Compare + Guidance, 1440×900 | [source-parity.webp](https://raw.githubusercontent.com/dmalmq/imdf-map-application/prototype/renderer-neutral-3d-visual-language/docs/superpowers/prototypes/2026-08-03-3d-visual-language-source-parity.webp) |
| Floor handoff, destination-floor context, 1440×900 | [route-handoff.webp](https://raw.githubusercontent.com/dmalmq/imdf-map-application/prototype/renderer-neutral-3d-visual-language/docs/superpowers/prototypes/2026-08-03-3d-visual-language-route-handoff.webp) |
| Diagnostics, all findings + source material, 1180×720 | [diagnostics.webp](https://raw.githubusercontent.com/dmalmq/imdf-map-application/prototype/renderer-neutral-3d-visual-language/docs/superpowers/prototypes/2026-08-03-3d-visual-language-diagnostics.webp) |
| Japanese + 2D + reduced motion, 390×844 | [mobile.webp](https://raw.githubusercontent.com/dmalmq/imdf-map-application/prototype/renderer-neutral-3d-visual-language/docs/superpowers/prototypes/2026-08-03-3d-visual-language-mobile.webp) |

### Verification

Commands: `pnpm exec tsc --noEmit` (0 diagnostics), `pnpm exec vite build` (success), `pnpm exec vitest run` (44 files / 894 tests, unchanged from baseline).

Browser matrix — Guidance, Selection, Floor handoff, Route overview, Diagnostics, and Fallback exercised at each viewport; automated overlap audit (panels vs. captions, badges, labels, each other) reports zero collisions and zero horizontal overflow:

| Viewport | Result |
|---|---|
| 1440×900 | All six scenarios clean; compare viewports 619–766 px |
| 1180×720 | All six scenarios clean; stacked compare viewports 220–586 px |
| 390×844 | All six scenarios clean; compare viewports ≥280 px, region scrolls, all controls ≥44 px |

Also verified: handoff phase order `walk-b1 → announce-escalator → pull-back → show-destination-floor → switch-floor (1F) → settle-1f` with bilingual polite announcements, identical under reduced motion; pointer selection and the synchronized HTML lists resolve to the same object in both compared sources; keyboard focus reaches every control with a visible white-plus-indigo ring.

Defects the browser pass caught and fixed: 42 faces rendered as selected when nothing was selected (`null === null` on canonical IDs), priority labels overlapping, the advisory finding unreachable in the scene, the next-action card burying priority labels (now an in-flow bar), inspector and findings panels covering captions, the review amber failing AA, overview legs at the wrong opacity, and the accepted-exception hatch suppressed by a CSS `fill`.

## Scope

This prototype is disposable UI code on a disposable branch; nothing here is promoted to production and the branch is not merged into `main`. Production implementation waits on [#23 (rendering architecture)](https://github.com/dmalmq/imdf-map-application/issues/23) and [#26 (3D capability, accessibility, and performance gates)](https://github.com/dmalmq/imdf-map-application/issues/26).
