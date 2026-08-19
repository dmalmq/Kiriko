# Scene floor elevation alignment — design

**Status:** approved 2026-08-12.

## Problem

Kiriko currently uses two vertical datums in the same pitched map. `SceneLayer`
renders generated 3D geometry at each `SceneLevel.resolvedPlaneZ`, while the
ordinary MapLibre fill, line, circle, symbol, and hit-test layers remain on the
map's zero-elevation plane. The geometries share longitude and latitude, so they
coincide in plan view and diverge as soon as the camera pitches.

The live Shibuya B1 reproduction made the split measurable: the generated scene
plane was at `8.0 m`, the MapLibre floor was at `0.0 m`, and the same venue point
landed 85.08 CSS pixels apart at 60 degrees pitch. Waiting for idle and changing
floors did not change the result. Projecting the scene at `z = 0` agreed with
MapLibre to less than 0.001 pixels, ruling out registration, active-floor state,
and the scene's local-to-world transform.

This is not a visual-offset problem. A screen-space translation would become
wrong with camera pitch, bearing, zoom, and floor. The two renderers must consume
the same floor datum.

## Decision

While a 3D scene is attached, `IndoorMap` gives MapLibre one constant-elevation
terrain surface whose height is the active scene floor's
`SceneLevel.resolvedPlaneZ`. Every existing MapLibre layer then follows the same
world plane as the active `SceneLayer` level through MapLibre's native elevation
path.

The surface is a generated 256 by 256 Terrarium raster-dem tile. A private
MapLibre protocol returns the same in-memory PNG for every requested tile of a
particular quantized height. `IndoorMap` owns the protocol, raster-dem source,
and terrain attachment as map lifecycle state:

1. Register the private protocol before creating the map.
2. Include one internal raster-dem source in the initial style.
3. When a scene is attached, select the active scene level, encode its
   `resolvedPlaneZ`, update the source tile URL, and attach terrain with
   exaggeration `1`.
4. On an active-floor change, update the existing source URL. Do not recreate the
   map or source.
5. When the scene is removed or 3D is disabled, detach terrain. The ordinary 2D
   map returns to its existing zero-elevation behavior.
6. Remove the protocol when the owning map is destroyed.

`resolvedPlaneZ` remains the only datum. The feature source, route source,
facility source, network source, scene geometry, and persisted bundle are not
rewritten.

## Two-floor vertical-route context

A cross-floor route may reveal exactly one additional scene floor while retaining
one explicit active floor. This is the automatic route-context behavior selected
for vertical network inspection and the production form of Wayfinder #27's
approved “one active editing floor inside an exploded two-floor scene” model.

When directions contain segments on more than one ordinal, the active route
floor is shown at full opacity and the next route floor in traversal order is
shown at context opacity. On the final route floor, the immediately preceding
route floor is the context. The context ends when the route is cleared, 3D is
disabled, the scene changes, or the active floor is not part of that route.

The second floor:

- remains at its own `resolvedPlaneZ`; it is never flattened onto the active
  terrain plane;
- uses the existing 22% scene context treatment, with its ceiling at the
  protected-corridor fade;
- is not pickable or editable;
- does not change the canonical active floor, FloorStack selection, route
  progress, or map terrain;
- is limited to the registered scene levels mapped to that one canonical floor.

The MapLibre plan, facility, route, and edit-hit layers remain active-floor
overlays on the active terrain plane. The **context floor** additionally receives
a translucent, non-pickable indoor fill-extrusion overlay and same-floor network
ribbons in the scene layer, both at the partner `resolvedPlaneZ` (2026-08-19).
They exist so a selected vertical connection can be checked against the partner
plan and graph. Terrain stays on the active floor. Facilities and issue pins are
not duplicated.

A normal floor transition still uses the existing 160 ms all-floor handoff. When
that handoff settles, route context returns to exactly the active/context pair.
Reduced motion skips the handoff but keeps the same final two-floor state.

## Why native terrain

A live probe against the running application reduced the measured Shibuya B1
split from 85.08 pixels to 0.16 pixels while MapLibre reported the same `8.0 m`
elevation as the scene. Updating the raster source URL changed the queried
terrain elevation to the next floor without rebuilding the map.

Native terrain preserves behavior that already belongs to MapLibre:

- fill, line, circle, and symbol styling;
- route, facility, and network overlays;
- wide invisible network hit targets;
- feature-state hover and selection;
- query-rendered-features picking;
- camera and floor transitions.

The rejected alternative was to copy every 2D overlay into `SceneLayer`. That
would duplicate MapLibre's styling, decluttering, feature state, and picking
contracts, creating a second renderer for no product gain. `setCenterElevation`
was also rejected: it changes the camera target rather than the layers' world
plane and increased the measured split.

## Height encoding and ownership

The protocol URL carries a signed millimetre integer, not floating-point text.
Millimetre quantization matches the scene contract and avoids cache keys that
differ only by formatting. The protocol validates and bounds the encoded height
before generating a tile.

Terrarium encodes elevation as:

`(R * 256 + G + B / 256) - 32768` metres.

The generated tile uses one RGB triplet for every pixel. Tiles are cached by the
signed millimetre key for the map's lifetime, so a floor revisited during a
session does not allocate or encode another PNG.

The protocol and source identifiers are internal implementation details. They do
not enter KVB, venue state, source selection, server URLs, or the browser cache.

## State and failures

The active elevation is derived from the same scene state already used for floor
visibility:

- no scene, no active level, or 2D mode: terrain detached;
- one generated scene level for the canonical floor: use that level's plane;
- one or more registered composite tile levels for the canonical floor: require
  one shared resolved plane and use it;
- floor transition: change the DEM URL before repainting the new active level;
- scene source swap: recompute from the incoming `SceneView`; never retain the
  old source's height.

A missing, non-finite, or contradictory active plane is a contract failure, not
a silent zero. The map leaves terrain detached rather than manufacture agreement
at zero. A context floor with no registered scene level is omitted; it never
causes the active floor to disappear.

## Tests and proof

Unit coverage owns the lifecycle contract with a MapLibre map double:

- the style contains the internal raster-dem source;
- attaching a scene sets terrain to its active level's quantized plane;
- changing floors updates the source tiles and retains terrain;
- removing the scene detaches terrain;
- teardown removes the registered protocol;
- invalid, absent, or contradictory active planes never become zero-height
  successes;
- a cross-floor route retains exactly the next/previous route floor as
  non-pickable context;
- clearing the route clears persistent context while preserving floor handoff.

Browser proof exercises a pitched generated scene and compares one canonical
surface point through MapLibre projection and `SceneLayer.projectLocal`. The
screen-space distance must remain within rendering tolerance on at least two
floors. It then loads a cross-floor route and confirms that exactly two floor
levels remain visible after the handoff, at their distinct resolved planes, while
only the active floor remains canonical and pickable. Returning to 2D detaches
terrain.

The affected client typecheck and test suites remain the regression gate. No
server, Rust, bundle-format, or bilingual-copy change is required.
