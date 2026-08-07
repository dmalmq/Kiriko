# Renderer Core: the WebGL2 custom scene layer — implementation record

Ticket: [#60](https://github.com/dmalmq/imdf-map-application/issues/60) — first slice of Stage 2 ([#59](https://github.com/dmalmq/imdf-map-application/issues/59)).

## What shipped

The venue's compiled 3D scene now renders inside the existing MapLibre map, through one
renderer-owned WebGL2 custom layer fed by one source-neutral render format.

| Task | Landed |
| --- | --- |
| T1 | `kiriko-scene::compile_generated_scene` — §9 primitives + §8 planes → KSC1 render document |
| T2 | `generatedScene` wasm binding + `src/map/scene/sceneFormat.ts` typed views |
| T3 | `src/map/scene/sceneLayer.ts` — the custom layer; `sceneMath.ts` and `scenePolicy.ts` hold the testable decisions |
| T4 | Bundle-worker scene message, `loadKirikoScene`, viewer wiring behind `?scene`, camera and floor sync |
| T5 | `e2e/viewer.scene.spec.ts` browser proof, full gates |

## The seam

`kiriko-scene` already carried the KSC1 render format and the Tiles deriver (GLB → document,
Stage 3's producer). The generated scene had no producer, so this slice added one: the same
container, levels, features, and merged `(level, role)` batches, from §9 and §8 instead of a GLB.

That is the point of the decision it implements ([#23](https://github.com/dmalmq/imdf-map-application/issues/23) D4):

```
§9 + §8  ──compile_generated_scene──┐
                                    ├──►  KSC1 document ──► one renderer
GLB + tiles descriptor ──derive─────┘        (Stage 3)
```

The renderer receives `SceneView` and cannot tell which producer filled it. Provenance,
capability, and pick semantics stay in the semantic projection
([#53](https://github.com/dmalmq/imdf-map-application/issues/53)) — the render document carries
only what is drawn.

## Decisions worth keeping

**Roles come from the canonical category, never a guess.** A conveyance whose canonical unit is
unknown compiles to the new untyped `Conveyance` role rather than an escalator that would look
source-authored. IMDF's category vocabulary is closed, so the mapping matches exact values
instead of substring-sniffing the way the Revit path must.

**A level slab is contextual mass.** It is the floor plate of the whole level, not a claim that
every square metre is navigable — and it is coplanar with the unit finishes that sit on it, so it
must not share their role.

**Occlusion policy follows the role, not the source's opacity.** §9 states material opacity;
whether an object may fade for the camera is a visual-language decision, so ceilings may fade and
navigable surfaces never do.

**The compile runs in the bundle worker.** It is the heaviest wasm call the client makes; the
geometry payload transfers back rather than being cloned.

**3D is explicit until the preflight exists.** `?scene` opts in. The capability floor, the
fallback state machine, and automatic selection are [#62](https://github.com/dmalmq/imdf-map-application/issues/62).

## Three defects only a real frame could show

1. **Mercator scale.** MapLibre's `meterInMercatorCoordinateUnits` assumes a mean-radius sphere,
   but the venue frame is ellipsoidal ENU (the compiler projects every feature through WGS84
   ECEF). Using it drifted **2.26 m per kilometre** against the venue's own 2D features. The
   scale is now per-axis from the WGS84 radii of curvature — exact in east, ~14 mm half a
   kilometre north, and the anchor is the venue's bounds centre. `sceneMath.test.ts` pins both
   the registration and the regression.
2. **Nobody could tilt.** The viewer was constructed with `pitchWithRotate: false`, so a 3D venue
   could never be looked at. Pitch now rides the rotate gesture while `maxPitch: 0` clamps it
   away until a scene raises the ceiling: 2D behaviour is unchanged, and the e2e spec asserts the
   camera tilts with a scene and not without.
3. **The palette never showed.** The level plate and the unit finishes are coplanar, so at equal
   depth the plate won and every floor read as one flat colour. Contextual mass now paints first
   and is biased back, openings are biased forward of the walls they pierce, and contact darkness
   was corrected — a wall turned from the key rendered near-black instead of 12% below cool stone
   ([#32](https://github.com/dmalmq/imdf-map-application/issues/32) section 5).

## Follow-on: picking (#61)

Picking landed on this layer without changing the format, because the per-vertex feature index was
already uploaded. Notes worth keeping:

- **The pass is scissored to one pixel.** Rendering the full framebuffer to read a single pixel
  measured 16.8 ms; confining the clear and the rasterizer to the picked pixel brought the median
  to ~2 ms, inside the 8 ms budget.
- **The latency budget is a hardware number.** CI rasterizes in software (SwiftShader), where a
  synchronous readback measured 151 ms — the rasterizer's cost, not the pick's. The browser spec
  probes the renderer and asserts the 8 ms budget only on real hardware; every functional
  assertion runs everywhere.
- **The first pick of a session costs ~20 ms** of driver validation for the multi-target float
  path. It is warmed once during load, where nothing is waiting on it.
- **Hover picking stands aside while the camera moves.** A synchronous readback mid-drag has to
  wait out the frame already in flight — 30 ms measured — so hover is suppressed during motion and
  re-evaluated on `moveend`.
- **A pick is the placement authority in 3D.** MapLibre's pointer `lngLat` unprojects onto the map
  plane at zero elevation, so with pitch enabled a click on an upper floor reported a position
  metres from the surface clicked. Issue placement, directions picking, and network-edit
  coordinates now use the pick's measured position.
- **Contextual mass is not selectable.** A level's floor plate carries the level as its canonical
  feature; clicking it clears the selection, as bare floor does in 2D, rather than selecting a
  whole storey.
- **A selection tint made a latent z-fight visible.** The plate and the finishes on it were
  trading pixels at venue-wide zoom, invisible while both were near-white. Depth bias alone
  degrades as precision does, so contextual mass is now separated in world space — one centimetre
  below the finishes it carries, while the pick still reports the true surface position.

## Verification

- Rust: `cargo test --manifest-path core/Cargo.toml --workspace` (includes 12 producer tests and
  6 render-document tests on the real published fixture).
- Client: `pnpm exec vitest run` — the format reader runs against the built wasm and the frozen
  `stage0.kvb`; the math and policy suites need no GPU.
- Browser: `pnpm exec playwright test e2e/viewer.scene.spec.ts` — renders a published venue,
  proves ≤ 8 draw calls per floor, proves the scene changes pixels, follows the floor selector,
  tilts only with a scene, and leaves the 2D viewer untouched without one.

The ≥ 15× primitive-collapse floor is a property of station-scale data, not of the three-floor
fixture (which has too few objects to merge that far); it is asserted against the registered
Tokyo dataset in [#64](https://github.com/dmalmq/imdf-map-application/issues/64), together with
the decode and upload budgets.
