# Navigation and route-storytelling prototype design

## Status

Approved for throwaway prototyping on `prototype/navigation-route-storytelling`. This artifact resolves the interaction question in [Choose the navigation and route-storytelling model](https://github.com/dmalmq/imdf-map-application/issues/25); it is not a production implementation plan.

## Question

How should Kiriko's optional polished navigation mode communicate active-floor context, labels, conveyances, camera movement, floor changes, and cross-floor routes without asking a first-time viewer to understand an indoor routing graph?

## Locked inputs

- Optimize for knowing the next action, not persistent whole-route comprehension or unrestricted exploration.
- Show only the active floor during ordinary navigation.
- At a route connector, automatically announce the conveyance and destination floor, pull the camera back, change floors, and settle on the next leg.
- Keep a reversible route overview and replay/recovery controls.
- Preserve the same route state in reduced motion; replace continuous movement with discrete scene changes.
- Use one renderer-neutral interaction model. The prototype must not depend on whether the scene is backed by registered 3D Tiles or generated GDB/GeoJSON geometry.
- Keep the existing 2D viewer and production code unchanged.

## Prototype scenario

Use a synthetic but credible Tokyo Station journey:

1. Start on the B1 concourse near a selected origin.
2. Follow a corridor leg to a selected escalator.
3. Announce `Escalator to 1F`, pull back, change active floor, and settle on 1F.
4. Follow the final leg to the Marunouchi exit.

Stairs and an elevator appear as unselected alternatives so conveyance differentiation can be judged. The route data is illustrative and must be labelled as prototype data.

## Compared models

### A. Guided leg card — recommended

A compact instruction card at the lower left owns the current action. A restrained route strip shows completed, current, connector, and remaining legs. The map remains dominant. During a connector transition, the card becomes a clear handoff state and offers pause/replay after the automatic movement.

**Strength:** clearest next action with the least map occlusion.

**Risk:** overall route structure is less prominent unless the user opens route overview.

### B. Vertical journey rail

A right-side rail combines floor identity, route progress, connector type, and remaining legs into a spatial ladder. The current floor and next connector align with the scene.

**Strength:** strongest mental model of movement through floors.

**Risk:** competes with Kiriko's existing FloorStack and narrows the scene.

### C. Route scrubber

A bottom timeline presents walking legs and floor transitions as a sequence. Automatic playback advances through the route; users can scrub, pause, replay, or jump to a leg.

**Strength:** best replay and recovery model.

**Risk:** consumes map area and may feel like media playback rather than navigation.

## Shared scene and state

The prototype uses one synthetic scene model shared by all three layouts:

- route status: `ready | playing | paused | complete`
- active leg: B1 walk, connector transition, or 1F walk
- active floor: B1 or 1F
- camera phase: close, pull-back, floor-change, or settle
- route overview: open or closed
- locale: Japanese or English
- reduced motion: on or off

Every variant renders the full current state in a compact prototype inspector. Variant switching preserves the state so comparison is about presentation rather than setup.

## Interaction behavior

- **Start route:** begins with the B1 walking leg.
- **Automatic connector handoff:** pauses briefly on the connector label, then performs pull-back, floor change, and settle phases.
- **Pause:** freezes route progression without discarding state.
- **Replay transition:** replays only the connector handoff.
- **Route overview:** reveals both route floors as a temporary stack; closing it restores the active-floor camera.
- **Floor choice:** manual floor selection is allowed for exploration, but the next-action UI keeps the route's current leg explicit and offers Return to route.
- **Reduced motion:** changes floors with a labelled cross-fade/discrete swap and no camera interpolation.
- **Keyboard:** all controls are ordinary buttons with visible focus; route state announcements use a polite live region.

## Visual contract

- Extend Kiriko's established visual system rather than inventing a prototype-only brand.
- The scene is the loudest surface; chrome floats above it.
- Ai Indigo marks only the selected route, active controls, and current floor.
- Use warm neutral surfaces, 1 px hairlines, existing radii, and the existing two shadow levels.
- Use `Inter / Noto Sans JP` for interface text and `IBM Plex Mono` for route distance, floor codes, and state values.
- Keep labels bilingual and test both English and Japanese.
- Avoid desktop-GIS chrome, dense legends, gradients, glass effects, or permanent multi-floor clutter.

## Prototype implementation boundary

- Isolated throwaway route and styles on the prototype branch.
- No production data adapters, persistence, KVB changes, renderer integration, API calls, or tests.
- A schematic SVG/CSS scene is sufficient because this ticket tests comprehension and control behavior, not rendering feasibility.
- Reuse incumbent shell conventions and tokens; do not mutate real data.
- Provide a floating bottom variant switcher as required by the UI prototype workflow.

## Evaluation

The user should be able to answer, for each variant:

1. What should I do next?
2. Which floor am I on?
3. Which conveyance will move me between floors?
4. What just happened after the automatic floor change?
5. How do I see the whole route, pause it, or recover from an unwanted camera move?
6. Does the interface still feel like Kiriko on desktop and mobile?

The ticket resolves when one model, or a precise combination of elements, is selected and its camera, floor, label, overview, conveyance, reduced-motion, and recovery behavior are recorded in the issue resolution.
