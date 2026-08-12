# Network Vertical Link Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a cross-floor graph connection as an offset endpoint marker with target-floor direction instead of a misleading plan-view diagonal line, while preserving selection and deletion by canonical connection identity.

**Architecture:** `buildNetworkFeatures` remains the source-neutral projection seam. It recognizes exporter-guaranteed vertical metadata, collapses reciprocal rows, resolves the active-floor endpoint from junctions, and emits one semantic point. Dedicated MapLibre layers draw and hit-test that point; `IndoorMap` adds the translated marker between junction and horizontal-path picking precedence.

**Tech Stack:** React 19, TypeScript strict mode, MapLibre GL style expressions, GeoJSON, Vitest, Testing Library, Vite production build.

## Global Constraints

- Execute after the three Rust plans for the documented sequence; no bundle-format or exporter change is required.
- Treat a path as vertical only when `HFLAG === 1`, `PATHID`, `RPATHID`, `FNODEID`, and `TNODEID` are finite numbers, `FFLOOR` and `TFOOLR` are recognized floor strings, and both endpoint junctions resolve to `Point` geometry.
- `passage_type: 1` means only “vertical”; do not label stairs, escalator, or elevator because the graph does not preserve that category.
- Emit no vertical `LineString` on any floor.
- Emit one marker per canonical reciprocal pair on either endpoint floor; no duplicate marker on one floor.
- The marker properties use normalized `pathId < reversePathId` identity.
- Use the endpoint's exact junction coordinate. Translate hit/marker circles by `[12, -12]` viewport pixels; never alter source geometry to create a fake horizontal segment.
- Pick order: junction center, translated vertical marker, ordinary path.
- Marker copy is only `↑ <targetFloor>` or `↓ <targetFloor>`; it introduces no localized prose and no icon dependency.
- Keep horizontal network projection, mutations, serialization, connectivity, and route rendering unchanged.
- Use LSP references before changing exported layer constants or `buildNetworkFeatures`.
- Follow TDD and commit each independently testable layer.
- Design source: `docs/superpowers/specs/2026-08-12-generated-network-offshoot-remediation-design.md` §§7 and 9.2.

---

### Task 1: Project reciprocal vertical paths into one active-floor point

**Files:**
- Modify: `src/map/networkFeatures.ts:32-42`
- Modify: `src/map/networkFeatures.ts:123-178`
- Modify: `src/map/networkFeatures.ts:299-320`
- Test: `src/map/networkFeatures.test.ts:28-99`
- Test: `src/map/networkFeatures.test.ts:212-230`

**Interfaces:**
- Consumes: `ParsedNetwork`, raw exporter properties, `floorLabelToOrdinal`, `NetworkConnectionId`, and junction `Point` coordinates.
- Produces:

```typescript
export interface VerticalNetworkLink {
  kind: "vertical-link";
  pathId: number;
  reversePathId: number;
  endpointNodeId: number;
  targetNodeId: number;
  activeFloor: string;
  targetFloor: string;
  targetDirection: "up" | "down";
  passageType: number;
  coordinate: GeoJSON.Position;
  selected: boolean;
}
```

- Preserves: `buildNetworkFeatures(network, activeOrdinal, render?) -> GeoJSON.FeatureCollection` and all mutation APIs.

- [ ] **Step 1: Preview LSP references for the exported projection**

Run the LSP `references` operation on `buildNetworkFeatures` at `src/map/networkFeatures.ts:129`. Confirm the expected consumers are `IndoorMap.tsx` and `networkFeatures.test.ts`; do not rename the function.

- [ ] **Step 2: Add a vertical reciprocal-pair fixture and failing projection tests**

Add:

```typescript
function verticalNetwork(): ParsedNetwork {
  return {
    junctions: [
      jn(10, 139.7000, 35.6000, 0),
      jn(20, 139.7008, 35.6004, 1),
    ],
    paths: [
      {
        ordinal: 0,
        geometry: { type: "LineString", coordinates: [[139.7000, 35.6000], [139.7008, 35.6004]] },
        properties: {
          FNODEID: 10,
          TNODEID: 20,
          FLOOR: "F1",
          PATHID: 8,
          RPATHID: 7,
          HFLAG: 1,
          FFLOOR: "F1",
          TFOOLR: "F2",
          passage_type: 1,
        },
      },
      {
        ordinal: 0,
        geometry: { type: "LineString", coordinates: [[139.7008, 35.6004], [139.7000, 35.6000]] },
        properties: {
          FNODEID: 20,
          TNODEID: 10,
          FLOOR: "F1",
          PATHID: 7,
          RPATHID: 8,
          HFLAG: 1,
          FFLOOR: "F2",
          TFOOLR: "F1",
          passage_type: 1,
        },
      },
    ],
  };
}
```

Add tests:

```typescript
it("projects a reciprocal vertical pair as one lower-floor marker and no line", () => {
  const collection = buildNetworkFeatures(verticalNetwork(), 0);
  const links = collection.features.filter((feature) => feature.properties?.kind === "vertical-link");
  expect(links).toHaveLength(1);
  expect(collection.features.filter((feature) => feature.properties?.kind === "path")).toHaveLength(0);
  expect(links[0]).toMatchObject({
    properties: {
      PATHID: 7,
      RPATHID: 8,
      endpointNodeId: 10,
      targetNodeId: 20,
      activeFloor: "F1",
      targetFloor: "F2",
      targetDirection: "up",
      passageType: 1,
      selected: false,
    },
    geometry: { type: "Point", coordinates: [139.7, 35.6] },
  });
});

it("moves the same vertical link to the upper endpoint", () => {
  const links = buildNetworkFeatures(verticalNetwork(), 1).features.filter(
    (feature) => feature.properties?.kind === "vertical-link",
  );
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({
    properties: {
      endpointNodeId: 20,
      targetNodeId: 10,
      activeFloor: "F2",
      targetFloor: "F1",
      targetDirection: "down",
    },
    geometry: { type: "Point", coordinates: [139.7008, 35.6004] },
  });
});

it("selects a vertical marker by canonical reciprocal identity", () => {
  const links = buildNetworkFeatures(verticalNetwork(), 0, {
    selectedJunctionId: null,
    selectedConnection: { pathId: 7, reversePathId: 8 },
    pendingJunctionId: null,
  }).features.filter((feature) => feature.properties?.kind === "vertical-link");
  expect(links[0]?.properties?.selected).toBe(true);
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
pnpm exec vitest run src/map/networkFeatures.test.ts -t "vertical"
```

Expected: fail because both directed rows are still emitted as `kind: "path"` on the lower floor and no upper-floor feature exists.

- [ ] **Step 4: Implement typed vertical parsing at the projection seam**

Export `VerticalNetworkLink`. Add private helpers:

```typescript
function pointCoordinate(feature: NetworkFeature | undefined): GeoJSON.Position | null {
  return feature?.geometry.type === "Point" ? feature.geometry.coordinates : null;
}

function isVerticalPath(path: NetworkFeature): boolean {
  return path.properties.HFLAG === 1;
}
```

Build a `Map<number, NetworkFeature>` from finite junction `NODEID`s before iterating paths. Keep `connectionIdOf` as the only path-ID normalizer.

For each path with `HFLAG === 1`:

1. Require `connectionIdOf(path)` and skip if its `pair:<lo>:<hi>` key was already emitted.
2. Parse from/to node IDs, `FFLOOR`, `TFOOLR`, and their ordinals. Set `passageType` to finite `passage_type` when present, otherwise to `1`, because `HFLAG === 1` is the authoritative vertical flag.
3. Require both junction points.
4. If active ordinal equals the from floor, choose from as endpoint and to as target. If it equals the to floor, reverse those roles. Otherwise emit nothing.
5. Build `VerticalNetworkLink`, add the canonical key to `emittedVertical`, and push a Point feature.

The pushed feature is:

```typescript
features.push({
  type: "Feature",
  properties: {
    kind: link.kind,
    PATHID: link.pathId,
    RPATHID: link.reversePathId,
    endpointNodeId: link.endpointNodeId,
    targetNodeId: link.targetNodeId,
    activeFloor: link.activeFloor,
    targetFloor: link.targetFloor,
    targetDirection: link.targetDirection,
    passageType: link.passageType,
    selected: link.selected,
  },
  geometry: { type: "Point", coordinates: link.coordinate },
});
```

For non-vertical paths, preserve the active-ordinal filter and LineString geometry. When IDs parse, write canonical `PATHID` and `RPATHID` into the projected properties so every map pick honors `NetworkConnectionId`'s documented normalization.

- [ ] **Step 5: Reject malformed vertical metadata without falling back to a line**

Add a test that deletes `TFOOLR` from both fixture rows and expects zero `vertical-link` and zero `path` features. Add another that changes an endpoint junction to non-Point geometry and expects the same. This guards the source-honesty rule: malformed semantic edges disappear from the floor overlay rather than becoming fake horizontal paths.

- [ ] **Step 6: Prove deletion removes the underlying reciprocal vertical pair**

Extend the existing `deleteConnection removes exactly one of two parallel connections` area with:

```typescript
it("deletes a vertical reciprocal pair by the marker's canonical identity", () => {
  const net = verticalNetwork();
  const result = deleteConnection(net, { pathId: 8, reversePathId: 7 });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.network.paths).toHaveLength(0);
  expect(result.network.junctions.map((junction) => junction.properties.PATH_COUNT)).toEqual([0, 0]);
});
```

- [ ] **Step 7: Run projection and mutation tests**

Run:

```bash
pnpm exec vitest run src/map/networkFeatures.test.ts
pnpm exec tsc --noEmit
```

Expected: pass; existing horizontal projection and mutation tests remain unchanged.

- [ ] **Step 8: Commit the semantic projection**

```bash
git add src/map/networkFeatures.ts src/map/networkFeatures.test.ts
git commit -m "feat(map): project vertical network links as markers"
```

---

### Task 2: Add translated marker, label, hit, and selection layers

**Files:**
- Modify: `src/map/featureLayers.ts:66-72`
- Modify: `src/map/featureLayers.ts:656-748`
- Test: `src/map/featureLayers.test.ts:1-36`
- Test: `src/map/featureLayers.test.ts:146-197`

**Interfaces:**
- Consumes: GeoJSON properties `kind`, `targetFloor`, `targetDirection`, and `selected` from Task 1.
- Produces exported constants `LAYER_NETWORK_VERTICAL_LINK_HIT`, `LAYER_NETWORK_VERTICAL_LINK`, `LAYER_NETWORK_VERTICAL_LINK_SELECTED`, and `LAYER_NETWORK_VERTICAL_LINK_LABEL` plus four MapLibre layers.
- Preserves: `buildNetworkLayers() -> AnyLayer[]` and existing source/style construction.

- [ ] **Step 1: Preview LSP references for network layer constants**

Run LSP `references` for `LAYER_NETWORK_PATH_HIT` and `buildNetworkLayers` in `featureLayers.ts`. Confirm `IndoorMap.tsx`, `IndoorMap.test.tsx`, `buildIndoorStyle.ts`, and layer tests are the relevant consumers.

- [ ] **Step 2: Add failing layer-contract tests**

Import `buildNetworkLayers`, `NETWORK_SOURCE_ID`, and the four new constants. Add:

```typescript
describe("vertical network link layers", () => {
  it("draws and hit-tests an offset semantic marker", () => {
    const layers = buildNetworkLayers();
    const byId = (id: string) => layers.find((layer) => layer.id === id);
    const hit = byId(LAYER_NETWORK_VERTICAL_LINK_HIT) as CircleLayerSpecification;
    const marker = byId(LAYER_NETWORK_VERTICAL_LINK) as CircleLayerSpecification;
    const selected = byId(LAYER_NETWORK_VERTICAL_LINK_SELECTED) as CircleLayerSpecification;

    for (const layer of [hit, marker, selected]) {
      expect(layer.source).toBe(NETWORK_SOURCE_ID);
      expect(JSON.stringify(layer.filter)).toContain("vertical-link");
      expect(layer.paint?.["circle-translate"]).toEqual([12, -12]);
      expect(layer.paint?.["circle-translate-anchor"]).toBe("viewport");
    }
    expect(hit.paint?.["circle-radius"]).toBe(12);
    expect(marker.paint?.["circle-radius"]).toBe(5);
    expect(selected.paint?.["circle-radius"]).toBe(8);
    expect(JSON.stringify(selected.filter)).toContain("selected");
  });

  it("labels only supported direction and target-floor facts", () => {
    const label = buildNetworkLayers().find(
      (layer) => layer.id === LAYER_NETWORK_VERTICAL_LINK_LABEL,
    ) as SymbolLayerSpecification | undefined;
    expect(label?.type).toBe("symbol");
    expect(label?.source).toBe(NETWORK_SOURCE_ID);
    expect(JSON.stringify(label?.layout?.["text-field"])).toContain("targetDirection");
    expect(JSON.stringify(label?.layout?.["text-field"])).toContain("targetFloor");
    expect(JSON.stringify(label)).not.toMatch(/stairs|escalator|elevator/i);
  });
});
```

Add `SymbolLayerSpecification` to the type-only MapLibre import if the test accesses symbol-only layout fields.

- [ ] **Step 3: Run the layer tests and verify missing exports fail**

Run:

```bash
pnpm exec vitest run src/map/featureLayers.test.ts -t "vertical network link"
```

Expected: module import or assertions fail because the constants/layers do not exist.

- [ ] **Step 4: Add constants and layers in deterministic draw order**

Add:

```typescript
export const LAYER_NETWORK_VERTICAL_LINK_HIT = "indoor-network-vertical-link-hit";
export const LAYER_NETWORK_VERTICAL_LINK = "indoor-network-vertical-link";
export const LAYER_NETWORK_VERTICAL_LINK_SELECTED = "indoor-network-vertical-link-selected";
export const LAYER_NETWORK_VERTICAL_LINK_LABEL = "indoor-network-vertical-link-label";
```

Insert the hit layer beside the existing path/junction hit layers. Insert visible, selected, and label layers after the base path and before junction selection/pending overlays. Use:

```typescript
const verticalLinkFilter = (): FilterSpecification => [
  "==",
  ["get", "kind"],
  "vertical-link",
];
const verticalTranslate: [number, number] = [12, -12];
```

The exact styles are:

```typescript
{
  id: LAYER_NETWORK_VERTICAL_LINK_HIT,
  type: "circle",
  source: NETWORK_SOURCE_ID,
  filter: verticalLinkFilter(),
  paint: {
    "circle-radius": 12,
    "circle-color": "#000000",
    "circle-opacity": 0.01,
    "circle-translate": verticalTranslate,
    "circle-translate-anchor": "viewport",
  },
},
{
  id: LAYER_NETWORK_VERTICAL_LINK,
  type: "circle",
  source: NETWORK_SOURCE_ID,
  filter: verticalLinkFilter(),
  paint: {
    "circle-radius": 5,
    "circle-color": "#d81b8c",
    "circle-stroke-width": 1,
    "circle-stroke-color": "#ffffff",
    "circle-translate": verticalTranslate,
    "circle-translate-anchor": "viewport",
  },
},
{
  id: LAYER_NETWORK_VERTICAL_LINK_SELECTED,
  type: "circle",
  source: NETWORK_SOURCE_ID,
  filter: ["all", verticalLinkFilter(), ["==", ["get", "selected"], true]],
  paint: {
    "circle-radius": 8,
    "circle-color": "#4F46E5",
    "circle-stroke-width": 1.5,
    "circle-stroke-color": "#ffffff",
    "circle-translate": verticalTranslate,
    "circle-translate-anchor": "viewport",
  },
},
{
  id: LAYER_NETWORK_VERTICAL_LINK_LABEL,
  type: "symbol",
  source: NETWORK_SOURCE_ID,
  filter: verticalLinkFilter(),
  layout: {
    "text-field": [
      "concat",
      ["case", ["==", ["get", "targetDirection"], "up"], "↑ ", "↓ "],
      ["get", "targetFloor"],
    ],
    "text-size": 11,
    "text-offset": [1.2, -1.2],
    "text-anchor": "left",
    "text-allow-overlap": true,
  },
  paint: {
    "text-color": "#d81b8c",
    "text-halo-color": "#ffffff",
    "text-halo-width": 1,
  },
},
```


- [ ] **Step 5: Run layer and style tests**

Run:

```bash
pnpm exec vitest run src/map/featureLayers.test.ts
pnpm exec tsc --noEmit
```

Expected: pass; `buildIndoorStyle` includes the new layers automatically through `buildNetworkLayers`.

- [ ] **Step 6: Commit the visual layers**

```bash
git add src/map/featureLayers.ts src/map/featureLayers.test.ts
git commit -m "feat(map): style vertical network link markers"
```

---

### Task 3: Add marker picking and cursor behavior

**Files:**
- Modify: `src/map/IndoorMap.tsx:35-55`
- Modify: `src/map/IndoorMap.tsx:352-400`
- Test: `src/map/IndoorMap.test.tsx:1-16`
- Test: `src/map/IndoorMap.test.tsx:1661-1767`

**Interfaces:**
- Consumes: `LAYER_NETWORK_VERTICAL_LINK_HIT` and canonical `PATHID`/`RPATHID` properties from Tasks 1–2.
- Produces: existing `NetworkMapPick { kind: "connection", connectionId }` for marker clicks.
- Preserves: junction priority, horizontal-path picks, coordinate fallback, move-tool behavior, and cursor semantics.

- [ ] **Step 1: Add failing marker-pick, precedence, and cursor tests**

Import `LAYER_NETWORK_VERTICAL_LINK_HIT`. Add:

```typescript
it("reports a connection pick from a translated vertical marker", () => {
  const net = editing();
  const { map } = renderMap(baseProps({ networkEditing: net }));
  map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [];
  map.queryByLayer[LAYER_NETWORK_VERTICAL_LINK_HIT] = [
    { properties: { PATHID: 7, RPATHID: 8 } },
  ];
  map.queryByLayer[LAYER_NETWORK_PATH_HIT] = [];
  act(() => {
    map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
  });
  expect(net.onPick).toHaveBeenCalledWith({
    kind: "connection",
    connectionId: { pathId: 7, reversePathId: 8 },
  });
});

it("keeps a junction ahead of a vertical marker at the same query point", () => {
  const net = editing();
  const { map } = renderMap(baseProps({ networkEditing: net }));
  map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [{ properties: { NODEID: 10 } }];
  map.queryByLayer[LAYER_NETWORK_VERTICAL_LINK_HIT] = [
    { properties: { PATHID: 7, RPATHID: 8 } },
  ];
  act(() => {
    map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
  });
  expect(net.onPick).toHaveBeenCalledWith({ kind: "junction", nodeId: 10 });
});

it("uses a pointer cursor over a vertical marker", () => {
  const { map } = renderMap(baseProps({ networkEditing: editing({ tool: "select" }) }));
  map.queryByLayer[LAYER_NETWORK_VERTICAL_LINK_HIT] = [
    { properties: { PATHID: 7, RPATHID: 8 } },
  ];
  act(() => {
    map.emit("mousemove", { point: { x: 1, y: 1 } });
  });
  expect(map.canvas.style.cursor).toBe("pointer");
});
```

- [ ] **Step 2: Run the focused tests and verify marker clicks fall through**

Run:

```bash
pnpm exec vitest run src/map/IndoorMap.test.tsx -t "vertical marker"
```

Expected: fail because `IndoorMap` never queries the new layer.

- [ ] **Step 3: Query the marker between junctions and paths**

Import the new hit-layer constant. In `networkPickAt`, after the junction block and before the path block, query:

```typescript
const verticalHits = map.queryRenderedFeatures(point, {
  layers: [LAYER_NETWORK_VERTICAL_LINK_HIT],
});
const verticalProps = verticalHits[0]?.properties;
const verticalPathId = verticalProps?.["PATHID"];
const verticalReversePathId = verticalProps?.["RPATHID"];
if (typeof verticalPathId === "number" && typeof verticalReversePathId === "number") {
  return {
    kind: "connection",
    connectionId: {
      pathId: Math.min(verticalPathId, verticalReversePathId),
      reversePathId: Math.max(verticalPathId, verticalReversePathId),
    },
  };
}
```

Normalize the existing horizontal path pick the same way, satisfying the documented `NetworkConnectionId` invariant even for hand-authored rows.

Add the vertical hit query to `updateNetworkCursor`'s `overData` expression between junction and path queries.

- [ ] **Step 4: Run map tests and client type checking**

Run:

```bash
pnpm exec vitest run src/map/IndoorMap.test.tsx -t "network editing"
pnpm exec tsc --noEmit
```

Expected: all network-editing tests pass, including existing junction/path behavior.

- [ ] **Step 5: Commit interaction support**

```bash
git add src/map/IndoorMap.tsx src/map/IndoorMap.test.tsx
git commit -m "feat(map): pick vertical network link markers"
```

---

### Task 4: Verify the complete client behavior in a real browser

**Files:**
- Verify only: `src/map/networkFeatures.ts`
- Verify only: `src/map/featureLayers.ts`
- Verify only: `src/map/IndoorMap.tsx`

**Interfaces:**
- Consumes: a generated multi-floor venue exposed through existing network-review mode.
- Produces: browser evidence that source projection, style, and interaction agree end to end.

- [ ] **Step 1: Run complete automated client/server gates**

Run:

```bash
pnpm exec vitest run src/map/networkFeatures.test.ts src/map/featureLayers.test.ts src/map/IndoorMap.test.tsx
pnpm exec tsc --noEmit
pnpm --dir server exec tsc --noEmit
pnpm exec vitest run
pnpm --dir server exec vitest run
pnpm build
```

Expected: every command exits zero. The existing Vite chunk-size advisory is not a failure.

- [ ] **Step 2: Launch the app and open a generated multi-floor network review**

Start the backend first with the repository's development credentials, then Vite:

```bash
pnpm dev:server
pnpm dev
```

Open the gallery, choose a venue with a generated graph spanning floors, and enter **Review network** in English. Use the browser harness rather than screenshots alone so click behavior is exercised.

- [ ] **Step 3: Verify visual truthfulness on both endpoint floors**

On the lower endpoint floor, observe:

- same-floor graph edges remain magenta lines;
- the cross-floor edge has no diagonal plan-view line;
- one magenta marker appears offset from its junction with an `↑` target-floor label.

Switch to the upper endpoint floor and observe one offset marker at the other junction with a `↓` label naming the lower target floor. Confirm the same link is not duplicated on either floor.

- [ ] **Step 4: Verify selection, junction precedence, and deletion**

In Select mode, click the endpoint junction center: the point inspector opens. Click the offset vertical marker: the connection inspector opens and the marker receives the Ai Indigo selected treatment. In Delete mode, click the offset marker and confirm the selected reciprocal connection is removed while both endpoint junctions remain. Undo the deletion and confirm the marker returns.

- [ ] **Step 5: Stop dev processes and record evidence in the final change report**

Stop both development processes. Record the venue/floors exercised and the observed up/down target labels in the PR or issue comment; do not add a repository screenshot or new documentation file unless the ticket explicitly requires one.
