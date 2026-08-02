# 3D indoor-navigation interaction patterns

Date: 2026-08-02

Decision ticket: [Survey proven 3D indoor-navigation interaction patterns](https://github.com/dmalmq/imdf-map-application/issues/21)

## Question and scope

Which interaction patterns documented by established indoor-mapping products best preserve orientation across camera movement, floor focus, and cross-floor route transitions, and what should Kiriko test before choosing an interaction model?

This review covers first-party documentation and product material from Mappedin, ArcGIS Indoors, Mapbox Indoor, and MapsIndoors, plus W3C accessibility guidance. It does not copy a vendor's visual identity, choose Kiriko's final interaction model, or propose production implementation.

The sources describe shipped capabilities and recommended configurations, not comparative usability studies. Accordingly:

- **Observed** means a first-party source documents the behavior or option.
- **Recommendation / inference** means the proposed Kiriko behavior follows from comparing those observations; it is not claimed as a measured product outcome.
- No secondary commentary is used.

## Executive answer

The strongest recurring model is not “show everything in 3D.” It is a stable focus hierarchy:

1. keep one floor unambiguously active and detailed;
2. retain only enough subdued building or adjacent-floor structure to preserve vertical context;
3. make floor identity and vertical connectors explicit, synchronized controls;
4. constrain the camera and always provide a predictable recovery action;
5. treat stacked floors as an overview or inspection mode, not the default turn-by-turn view;
6. segment a cross-floor route around its connector and clearly hand off to the next floor;
7. keep labels prioritized and floor-scoped;
8. make every gesture-backed operation available through a simple control; and
9. preserve equivalent navigation state in reduced-motion and 2D modes.

The first seven points recur in documented product behavior. The last two are accessibility and resilience requirements inferred from W3C guidance and from gaps in the products' 3D documentation.

## First-party observations

### Active-floor emphasis and adjacent-floor context

**Observed — Mappedin.** Mappedin's Multi Floor View places all floors below the active floor, renders the active floor fully, and represents lower floors as semi-transparent footprints. The feature is enabled by default, exposes a configurable floor gap, and can update camera elevation when the active floor changes. By default, labels, markers, paths, and images remain enabled only on the active floor even when multiple floor geometries are visible. [Mappedin, “Multi Floor View & Stacked Maps”](https://developer.mappedin.com/web-sdk/stacked-maps#multi-floor-view)

**Observed — Mappedin.** For multi-building venues, Dynamic Focus swaps between an exterior facade and an indoor floor as the camera pans and crosses indoor/outdoor zoom thresholds. It can automatically focus the most centered building and set that building's floor. [Mappedin, “Dynamic Focus”](https://developer.mappedin.com/web-sdk/dynamic-focus)

**Observed — ArcGIS Indoors.** A 3D floor-aware scene can either show the selected floor plus every floor below it or show the selected floor alone. In Single Facility filtering, the selected facility may show a different level while other facilities remain on their ground floors; Multi Facility filtering instead applies the same vertical order across facilities. [Esri, “Prepare a scene for Indoors Viewer”](https://doc.arcgis.com/en/indoors/latest/viewer/prepare-a-scene-for-indoor-viewer.htm)

**Observed — Mapbox Indoor.** The Android indoor selector populates as the user pans to a building with indoor data. Its state exposes the available floors and selected floor, and selecting `null` returns to a building overview. The API is explicitly experimental. [Mapbox, “Indoor mapping”](https://docs.mapbox.com/android/maps/guides/indoor/)

**Recommendation / inference.** Kiriko should give the active floor full geometry, route, connector, and label emphasis. Adjacent floors should provide structure—not competing detail—through low-opacity silhouettes or selected nearby route floors. Showing detailed content on multiple overlapping floors should be an explicit inspection state rather than the default.

### Exploded and stacked views

**Observed — Mappedin.** Stacked Maps is assembled by making floors visible and assigning each a different altitude. The example offers animated and instant expansion/collapse, changes the camera to an elevation pan mode while expanded, and supports a developer-chosen distance between floors. Mappedin warns that navigation and Dynamic Focus otherwise hide non-active floors unless manual floor visibility is enabled. [Mappedin, “Multi Floor View & Stacked Maps”](https://developer.mappedin.com/web-sdk/stacked-maps#stacked-maps)

**Observed — ArcGIS Indoors.** ArcGIS's documented 3D alternative is cumulative visibility—selected floor plus all floors below—rather than a user-controlled exploded gap. Selected-floor-only remains available. [Esri, “Prepare a scene for Indoors Viewer”](https://doc.arcgis.com/en/indoors/latest/viewer/prepare-a-scene-for-indoor-viewer.htm)

**Recommendation / inference.** Kiriko should treat “stacked” as an overview for understanding building structure or the floors touched by a route. Active navigation should collapse back to a single detailed floor. If an overview includes many floors, only route-bearing floors and connector endpoints should receive high-contrast route detail.

### Floor controls

**Observed — Mappedin.** Mappedin exposes an initial floor, the current floor, runtime `setFloor`, and a `floor-change` event. Its example keeps a floor select element synchronized even when another interaction—such as selecting a navigation connection—changes the floor. [Mappedin, “Building & Floor Selection”](https://developer.mappedin.com/web-sdk/level-selection)

**Observed — Mapbox Indoor.** Mapbox supplies an indoor selector plugin, a floor-selected event, and programmatic floor selection. The selector's available floors update with the building in view. [Mapbox, “Indoor mapping”](https://docs.mapbox.com/android/maps/guides/indoor/#indoor-selector-plugin)

**Recommendation / inference.** Kiriko's floor control should remain visible whenever indoor content is active, use venue-authored floor names rather than assuming numeric ordinals, expose the active floor in text, and update for both manual and route-driven changes. A route transition must not change the map while leaving the floor control stale.

### Camera constraints and recovery

**Observed — Mappedin.** The camera can set or animate bearing, center, pitch, and zoom; `focusOn` fits one or more targets. Animation exposes duration and easing. Mappedin does not provide a single default-reset call; its documented reset pattern stores the initial transform and later restores it. [Mappedin, “Camera”](https://developer.mappedin.com/web-sdk/camera)

**Observed — Mappedin.** The stacked-map example raises maximum pitch to 88 degrees and switches to elevation panning while floors are expanded, demonstrating that an exploded view may need a camera policy distinct from ordinary map navigation. These values are example choices, not published usability guidance. [Mappedin, “Multi Floor View & Stacked Maps”](https://developer.mappedin.com/web-sdk/stacked-maps#stacked-maps)

**Observed — ArcGIS Maps SDK.** Keyboard navigation is supported for both 2D maps and 3D scenes. [Esri, “Accessibility”](https://developers.arcgis.com/javascript/latest/accessibility/#keyboard-navigation)

**Recommendation / inference.** Kiriko should clamp pitch, zoom, and pan to keep a useful floor footprint in view; preserve bearing and local center during a floor handoff unless a route leg cannot fit; and expose a persistent compass/reset plus “recenter on me” when a position exists. Reset, north-up, venue-fit, route-fit, and user-location recenter are different intentions and should not be hidden behind one ambiguous action.

### Cross-floor route transitions and connector cues

**Observed — Mappedin.** Navigation draws a departure figure, route with optional animated directional arrows and pulses, destination pin, and customizable connection markers. For multi-floor wayfinding, an interactive tooltip identifies the connection type, such as elevator or stairs; clicking or tapping it switches the map to the destination floor. [Mappedin, “Wayfinding”](https://developer.mappedin.com/web-sdk/wayfinding#multi-floor-wayfinding)

**Observed — Mappedin.** The same wayfinding API can produce textual turn-by-turn instructions, and an accessible-route option requests a route that avoids stairs and escalators in favor of ramps or elevators. [Mappedin, “Wayfinding”](https://developer.mappedin.com/web-sdk/wayfinding#wayfinding-using-accessible-routes)

**Recommendation / inference.** Split a multi-floor route into floor legs. At the end of the active leg, show the connector type, action, and destination floor in both icon and text. On transition, keep the connector near the same visual anchor, update the floor control, then reveal the next leg and its departure direction. Kiriko should prototype both explicit “continue on floor …” activation and automatic handoff; the source material does not establish which is better for Kiriko's positioning accuracy or use contexts.

### Route progress and recentering

**Observed — Mappedin.** Tethered route tracking removes the route behind the user and can draw a dashed connector back to the route when the position is outside a threshold. Travelled mode instead retains the full route and recolors the completed portion. [Mappedin, “Wayfinding”](https://developer.mappedin.com/web-sdk/wayfinding#illustrating-navigation-progress)

**Observed — Mappedin.** `focusOn` can fit a target, while restoring a saved camera transform supplies a reset pattern. [Mappedin, “Camera”](https://developer.mappedin.com/web-sdk/camera#resetting-the-camera)

**Recommendation / inference.** Manual camera movement should suspend follow mode rather than fight the user; a visible recenter action should restore it. Off-route state should remain distinguishable from ordinary camera displacement: moving the map is not the same as leaving the route.

### Labels

**Observed — Mappedin.** Labels rotate and appear or disappear according to priority and zoom. Collision ranking decides which overlapping label is retained, and labels can be enabled conditionally at zoom levels. When multiple floors are visible, labels are active-floor-only by default. [Mappedin, “Labels”](https://developer.mappedin.com/web-sdk/labels), [Mappedin, “Multi Floor View & Stacked Maps”](https://developer.mappedin.com/web-sdk/stacked-maps#multi-floor-view)

**Recommendation / inference.** Keep readable labels on the active floor, suppress ordinary labels on contextual floors, and reserve the highest rank for current instruction, connector, destination, and safety/accessibility information. Labels should remain screen-readable under bearing and pitch changes; 3D perspective should not be allowed to make instruction text illegible.

### Mobile gestures and alternatives

**Observed — Mappedin.** The React Native map can be zoomed, panned, and rotated with mouse or fingers. [Mappedin, “Getting Started”](https://developer.mappedin.com/react-native-sdk/getting-started)

**Observed — W3C.** WCAG 2.2 Success Criterion 2.5.1 requires functionality using multipoint or path-based gestures to have a single-pointer alternative unless the complex gesture is essential. W3C's own map example pairs pinch zoom with plus/minus buttons. [W3C, “Understanding SC 2.5.1: Pointer Gestures”](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)

**Recommendation / inference.** Conventional one-finger pan, pinch zoom, and two-finger rotate/tilt may remain available, but floor change, zoom, rotation reset, pitch reset, recenter, and stacked-mode entry/exit need tappable controls. Kiriko should not require a precise swipe, pinch, or two-finger gesture for any navigation-critical outcome.

### Reduced motion

**Observed — Mappedin.** Camera and stacked-floor APIs support zero-duration state changes as well as animations; the navigation illustration may animate arrows and pulses. Mappedin's reviewed first-party guides do not document honoring `prefers-reduced-motion`. [Mappedin, “Camera”](https://developer.mappedin.com/web-sdk/camera#animation), [Mappedin, “Multi Floor View & Stacked Maps”](https://developer.mappedin.com/web-sdk/stacked-maps#stacked-maps), [Mappedin, “Wayfinding”](https://developer.mappedin.com/web-sdk/wayfinding#drawing-navigation)

**Observed — ArcGIS Maps SDK.** ArcGIS honors `prefers-reduced-motion` for 2D `MapView`: navigation animations are reduced and pan momentum is disabled. The documentation explicitly scopes these controls to 2D; it does not claim equivalent behavior for 3D `SceneView`. [Esri, “Accessibility”](https://developers.arcgis.com/javascript/latest/accessibility/#reduced-motion)

**Observed — W3C.** WCAG 2.2's Animation from Interactions guidance says interaction-triggered nonessential motion must be disableable, recommends respecting the operating-system preference, and identifies `prefers-reduced-motion` as a sufficient technique. [W3C, “Understanding SC 2.3.3: Animation from Interactions”](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

**Recommendation / inference.** Kiriko's reduced-motion path should replace camera flights, inertial movement, floor separation, route pulses, and animated arrows with instant state changes or short non-spatial fades. Floor identity, route direction, and connector state must remain available without animation. This needs an explicit 3D prototype because no reviewed indoor product documents a complete reduced-motion 3D interaction model.

### Graceful 2D fallback

**Observed — ArcGIS Indoors.** A 2D web map is required when creating Indoors Viewer; a 3D web scene is optional. Indoors Viewer supports 3D mode only when an accompanying web map exists. [Esri, “Create the Indoors Viewer app”](https://doc.arcgis.com/en/indoors/latest/viewer/create-a-web-app-for-indoor-viewer.htm), [Esri, “Prepare a scene for Indoors Viewer”](https://doc.arcgis.com/en/indoors/latest/viewer/prepare-a-scene-for-indoor-viewer.htm)

**Observed — MapsIndoors.** MapsIndoors 3D requires its v4 SDK, the Mapbox provider, and product enablement; it is presented as an alternative to a flat 2D map rather than the only rendering mode. [MapsPeople, “3D Maps”](https://docs.mapsindoors.com/sdks-and-frameworks/web/map-visualization/3d-maps)

**Observed — Mapbox Indoor.** Indoor rendering is a feature flag within Mapbox Standard and is disabled by default; disabling it leaves the ordinary map style in place. [Mapbox, “Indoor mapping”](https://docs.mapbox.com/android/maps/guides/indoor/)

**Evidence gap.** None of the reviewed current first-party sources documents an automatic runtime switch from failed or underperforming 3D/WebGL rendering to an equivalent 2D indoor route.

**Recommendation / inference.** Treat 2D as a first-class view over the same selected venue, floor, route leg, position, and connector state—not a restart or reduced-data error screen. Offer an explicit 2D control and define automatic fallback triggers separately. The prototype should verify that switching modes preserves route and floor state and that a failed 3D initialization can still enter 2D.

## Recurring patterns worth carrying into a Kiriko prototype

These are recommendations, not a final interaction decision:

| Pattern | Prototype expression | Evidence behind it |
| --- | --- | --- |
| One dominant active floor | Full-detail active floor; contextual floors reduced to silhouettes | Mappedin active-floor content scoping; ArcGIS selected-only/cumulative modes |
| Explicit, synchronized floor identity | Persistent floor control updated by taps, route connectors, and building focus | Mappedin floor-change synchronization; Mapbox selector state |
| Stacked overview as a reversible mode | Enter/exit control; route floors emphasized; active guidance collapses to one floor | Mappedin expand/collapse and separate elevation pan mode |
| Bounded, recoverable camera | Pitch/zoom/pan limits; north/reset, venue-fit, route-fit, and location recenter are explicit | Mappedin camera transforms, focus, and saved reset; ArcGIS keyboard navigation |
| Connector-centered route handoff | Icon + text + destination floor; next-floor leg revealed after a clear transition | Mappedin interactive connection tooltip and textual directions |
| Floor-scoped label hierarchy | Route and connector labels outrank POIs; contextual-floor labels suppressed | Mappedin collision ranking and active-floor defaults |
| Gesture plus visible control | Gestures for fluency; buttons for every navigation-critical result | Mappedin touch interaction; WCAG pointer-gesture requirement |
| Equivalent reduced-motion mode | No flights, inertial pan, route pulses, or exploded animation | W3C motion guidance; ArcGIS 2D behavior; Mappedin's instant state APIs |
| State-preserving 2D mode | Same route, floor, connector, and position when 3D is unavailable or unwanted | ArcGIS required 2D map/optional 3D scene; documented industry fallback gap |

## Product-specific choices not to copy blindly

- **Mappedin's exact floor gap, opacity, pitch, elevation pan mode, route figure, pulses, arrows, and connector tooltip are configurable product choices**, not demonstrated universal optima. Kiriko should borrow the information hierarchy, not the visual vocabulary. [Mappedin, “Multi Floor View & Stacked Maps”](https://developer.mappedin.com/web-sdk/stacked-maps), [Mappedin, “Wayfinding”](https://developer.mappedin.com/web-sdk/wayfinding)
- **ArcGIS's “selected floor plus all below” rule reflects its floor-aware scene model.** A tall venue may become visually dense, and a route may need context above rather than below. [Esri, “Prepare a scene for Indoors Viewer”](https://doc.arcgis.com/en/indoors/latest/viewer/prepare-a-scene-for-indoor-viewer.htm)
- **Mapbox's selector appearing for the building under the panned camera is coupled to its map-wide discovery model**, and the API is experimental. A known Kiriko venue may benefit from a persistent selector rather than discovery through panning. [Mapbox, “Indoor mapping”](https://docs.mapbox.com/android/maps/guides/indoor/)
- **MapsIndoors' Mapbox-only 3D requirement is a provider constraint**, not an interaction recommendation. [MapsPeople, “3D Maps”](https://docs.mapsindoors.com/sdks-and-frameworks/web/map-visualization/3d-maps)
- **Animated direction pulses and camera flights should not define route comprehension.** They are absent in reduced motion and therefore cannot carry unique information. [Mappedin, “Wayfinding”](https://developer.mappedin.com/web-sdk/wayfinding#drawing-navigation), [W3C, “Understanding SC 2.3.3”](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

## Failure modes to avoid

1. **Floor ambiguity:** multiple fully detailed floors, equally strong labels, or a floor change that is not reflected in the control.
2. **Connector discontinuity:** a route ends at stairs/elevator and resumes elsewhere without naming the connector, destination floor, or direction on exit.
3. **Camera disorientation:** automatic floor changes also reset bearing, zoom, and center without a recovery control.
4. **Occlusion masquerading as realism:** walls, upper floors, or labels hide the route and current position at useful pitches.
5. **Gesture-only operation:** essential zoom, rotate, floor, or recenter actions require multipoint or path gestures.
6. **Motion-dependent meaning:** animated arrows, pulses, or floor flight are the only indication of travel direction or transition.
7. **Follow-mode conflict:** the camera repeatedly recenters while a user is intentionally inspecting the map.
8. **False 2D fallback:** switching to 2D loses the route, selected floor, progress, accessibility preference, or destination.
9. **Vendor identity leakage:** copying branded icons, colors, character markers, easing, or control layout rather than the underlying orientation cues.

## Questions the Kiriko prototype must answer

The reviewed sources do not answer these for Kiriko's venue data, users, or positioning quality:

1. Does a single-floor route view plus faint neighboring silhouettes orient users better than selected-floor-only?
2. Should stacked overview show every floor, only adjacent floors, or only floors touched by the route?
3. Should arrival at a connector require an explicit tap to change floors, change automatically from route progress, or offer both?
4. Which camera properties should persist through a floor change, and when should the next route leg be fit automatically?
5. What pitch and zoom bounds keep routes legible on phone, tablet, and desktop without making 3D feel inert?
6. When manual pan/rotate suspends follow mode, what cue and recenter action make recovery obvious?
7. Which connector information must remain visible before and after the handoff, especially for stairs-versus-elevator accessible routing?
8. How much label suppression is needed at different pitches, and which route/connector labels must never collide away?
9. Does instant reduced-motion switching preserve orientation, or is a short cross-fade preferable?
10. What performance, capability, user-preference, or render-failure condition should trigger 2D automatically, and how is that explained without interrupting navigation?
11. Can all navigation-critical outcomes be completed with tap controls, keyboard input, and assistive technology as well as gestures?

## Decision boundary

This research supports a prototype brief, not a final UI decision: test a focused active-floor mode, a reversible route-aware stacked overview, explicit connector handoffs, constrained camera recovery, synchronized labels and floor controls, reduced-motion behavior, and state-preserving 2D. Choose final behavior only after the prototype tests the unanswered questions above with representative multi-floor routes and device sizes.
