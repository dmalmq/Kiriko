# 3D Graph-Editing Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a disposable, interactive synchronized repair cockpit that proves Kiriko's selected 3D graph-editing model across six synthetic B1↔1F repair stories.

**Architecture:** A pure prototype state module owns the synthetic graph, QA findings, staged operations, snap classification, structural preflight, synchronized history, and named actions. React view modules consume that small interface: one schematic exploded SVG scene, a findings queue, a selection inspector, and a full-screen shell. A query-param entry in `src/main.tsx` isolates the prototype from the production viewer and gallery.

**Tech Stack:** React 19, TypeScript 7, scoped CSS, inline SVG, Vite.

## Global Constraints

- Work only on branch `prototype/graph-editing-model` in `/home/apollo/dev/imdf-map-application/.worktrees/graph-editing-model`.
- This is throwaway prototype code. Do not change production App, map, network editor, renderer, API, persistence, Rust, KVB, or database behavior.
- Entry is `/?prototype=graph-editing`; the existing viewer/gallery condition remains unchanged when that parameter is absent.
- Implement only the selected **A — Synchronized repair cockpit**. Do not rebuild the rejected HUD or wizard layouts.
- Use a deterministic synthetic B1↔1F station fragment; do not load real GDB, KVB, MapLibre, 3D Tiles, or network APIs.
- Ordinary junctions remain floor-constrained. Pointer dragging changes XY only; floor/elevation changes require explicit inspector actions.
- Snap bands are provisional: unique same-floor candidate at $d \le 0.50\,\text{m}$ auto-snaps on release; $0.50 < d \le 3.0\,\text{m}$ requires acceptance; ambiguous and cross-floor candidates never auto-snap.
- Structural-invalid operations reject without graph/history mutation. Semantic Defect, Review, and Advisory findings remain non-blocking.
- Every user-facing string requires Japanese and English. Use Kiriko tokens and visual rules from `DESIGN.md`; all prototype selectors stay under `.graph-editing-prototype`.
- Desktop target only: 1440×900, with usable behavior down to 1180×720. No mobile composition.
- Reduced motion changes interpolation only, never graph or QA state.
- No automated tests or production-grade error handling. Verification is TypeScript, production build, and browser execution of all six proof stories.
- Commit each task separately. Do not merge the branch into `main`.

---

### Task 1: Deep Staged-State Module

**Files:**
- Create: `src/prototypes/graph-editing/graphEditingModel.ts`
- Create: `src/prototypes/graph-editing/useGraphEditingPrototype.ts`

**Interfaces:**
- Produces domain types `FloorId`, `GraphNode`, `GraphEdge`, `GraphFinding`, `GraphSelection`, `GraphEditorTool`, `GraphEditorPrototypeState`, and `GraphEditorPrototypeActions`.
- Produces `createGraphEditingPrototypeState(): GraphEditorPrototypeState` and `useGraphEditingPrototype(): { state: GraphEditorPrototypeState; actions: GraphEditorPrototypeActions }`.
- Hides fixture cloning, snap classification, structural preflight, local finding recomputation, snapshot history, and staged-change summarization inside the module.
- Later tasks must dispatch through `GraphEditorPrototypeActions`; they must not mutate graph, findings, profile, or history directly.

- [ ] **Step 1: Define the renderer-neutral prototype model and fixture identities**

Create `graphEditingModel.ts` with these public shapes and stable synthetic identities:

```ts
export type FloorId = "B1" | "1F";
export type FindingSeverity = "defect" | "review" | "advisory";
export type FindingState = "open" | "resolved" | "accepted" | "not-evaluated";
export type GraphEditorTool = "select" | "add" | "connect" | "delete" | "move";
export type ScenarioId =
  | "repair-endpoint"
  | "create-connector"
  | "reject-duplicate"
  | "resolve-uncertainty"
  | "delete-consequences"
  | "check-save";

export interface ScenePoint { x: number; y: number; z: number }
export interface GraphNode {
  id: string;
  floorId: FloorId;
  point: ScenePoint;
  sourceAltitude: number | null;
  provenance: "source" | "manual";
}
export interface GraphControlPoint extends ScenePoint { id: string; provenance: "manual" }
export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: "same-floor" | "connector";
  associationId: string | null;
  controlPoints: GraphControlPoint[];
}
export type GraphSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "control-point"; edgeId: string; id: string }
  | { kind: "venue"; id: string }
  | null;
export interface GraphFinding {
  id: "endpoint-off-stair" | "floor-drift" | "unassociated-lift";
  severity: FindingSeverity;
  state: FindingState;
  objectId: string;
  measuredM: number | null;
  toleranceM: number | null;
  exceptionReason: string | null;
}
```

Fixture floors are `B1` at `sceneZ: 0` and `1F` at `sceneZ: 4.86`. Include venue evidence `stair-main`, `lift-east`, and same-floor snap anchors. Include graph identities `b1-entry`, `b1-stair`, `f1-stair`, `f1-exit`, ordinary edges, connector `connector-8842`, and the three findings above.

- [ ] **Step 2: Define synchronized staged state and pending-operation unions**

Add immutable snapshot and UI-state shapes:

```ts
export interface ValidationProfile {
  autoSnapM: number;
  reviewSnapM: number;
  overrideReason: string | null;
}
export interface StagedSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  findings: GraphFinding[];
  profile: ValidationProfile;
  stagedChanges: string[];
}
export type PendingOperation =
  | { kind: "add"; floorId: FloorId; candidate: ScenePoint; snap: SnapPreview | null }
  | { kind: "move"; nodeId: string; candidate: ScenePoint; snap: SnapPreview | null }
  | {
      kind: "connect";
      fromNodeId: string;
      toNodeId: string | null;
      associationId: string | null;
      controlPoints: GraphControlPoint[];
    }
  | { kind: "delete"; selection: Exclude<GraphSelection, null>; consequences: string[] }
  | { kind: "exception"; findingId: GraphFinding["id"]; reason: string }
  | { kind: "profile"; autoSnapM: number; reviewSnapM: number; reason: string }
  | null;
export interface GraphEditorPrototypeState extends StagedSnapshot {
  baseline: StagedSnapshot;
  past: StagedSnapshot[];
  future: StagedSnapshot[];
  tool: GraphEditorTool;
  activeFloor: FloorId;
  selection: GraphSelection;
  selectedFindingId: GraphFinding["id"] | null;
  pending: PendingOperation;
  notice: "duplicate-connection" | "unusable-graph" | "invalid-geometry" | null;
  findingDelta: string | null;
  scenario: ScenarioId;
  checkState: "idle" | "checking" | "complete";
  saveState: "idle" | "confirming" | "saved";
  locale: "ja" | "en";
  reducedMotion: boolean;
  cameraPreset: "perspective" | "top";
}
```

Use `structuredClone` only when creating/resetting the small fixture. Normal reducer commits retain immutable arrays and snapshot references; do not JSON-clone on pointer movement.

- [ ] **Step 3: Implement snap classification and structural preflight inside the reducer module**

Use exact behavior:

```ts
export type SnapBand = "auto" | "review" | "ambiguous" | "none";
export interface SnapPreview {
  candidateId: string;
  distanceM: number;
  band: SnapBand;
  sameFloor: boolean;
  point: ScenePoint;
}

function snapBand(distanceM: number, candidateCount: number, sameFloor: boolean, profile: ValidationProfile): SnapBand {
  if (!sameFloor || distanceM > profile.reviewSnapM) return "none";
  if (candidateCount !== 1) return "ambiguous";
  return distanceM <= profile.autoSnapM ? "auto" : "review";
}
```

Duplicate edge, identical cross-floor endpoints, non-finite point, and deletion of the last usable edge return a notice and preserve the current snapshot and both history stacks. Valid commits append the previous snapshot to a 50-entry `past`, clear `future`, and recompute local findings.

- [ ] **Step 4: Implement named actions through one hook interface**

Create `useGraphEditingPrototype.ts`. Keep the reducer private and expose:

```ts
export interface GraphEditorPrototypeActions {
  selectFinding(id: GraphFinding["id"]): void;
  selectObject(selection: GraphSelection): void;
  setTool(tool: GraphEditorTool): void;
  setActiveFloor(floorId: FloorId): void;
  previewAdd(point: Pick<ScenePoint, "x" | "y">): void;
  commitAdd(mode: "snap" | "raw"): void;
  previewMove(nodeId: string, point: Pick<ScenePoint, "x" | "y">): void;
  commitMove(mode: "snap" | "raw"): void;
  beginConnection(nodeId: string): void;
  chooseConnectionEndpoint(nodeId: string): void;
  setDraftAssociation(associationId: string | null): void;
  addConnectorControlPoint(point: ScenePoint): void;
  nudgeControlPoint(edgeId: string, pointId: string, axis: "x" | "y" | "z", delta: number): void;
  commitConnection(): void;
  reassignNodeFloor(nodeId: string, floorId: FloorId): void;
  requestDelete(selection: Exclude<GraphSelection, null>): void;
  confirmDelete(): void;
  beginException(findingId: GraphFinding["id"]): void;
  updateExceptionReason(reason: string): void;
  acceptException(): void;
  updateProfileDraft(autoSnapM: number, reviewSnapM: number, reason: string): void;
  commitProfileOverride(): void;
  undo(): void;
  redo(): void;
  cancel(): void;
  resetScenario(scenario: ScenarioId): void;
  runCheck(): void;
  requestSave(): void;
  confirmSave(): void;
  setLocale(locale: "ja" | "en"): void;
  toggleReducedMotion(): void;
  setCameraPreset(preset: "perspective" | "top"): void;
}
```

`runCheck` may use one 450 ms timeout held by the hook; clear it on reset/unmount. It changes only check state and finding evaluation, not graph geometry.

- [ ] **Step 5: Verify the state contract compiles**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: zero diagnostics.

- [ ] **Step 6: Commit the state slice**

```bash
git add src/prototypes/graph-editing/graphEditingModel.ts src/prototypes/graph-editing/useGraphEditingPrototype.ts
git commit -m "prototype: model staged 3d graph repair"
```

---

### Task 2: Exploded Scene and Constrained Handles

**Files:**
- Create: `src/prototypes/graph-editing/GraphEditingScene.tsx`

**Interfaces:**
- Consumes `GraphEditorPrototypeState` and `GraphEditorPrototypeActions` from Task 1.
- Produces `GraphEditingScene({ state, actions }: GraphEditingSceneProps): ReactElement`.
- Owns only projection, SVG markup, pointer-to-floor coordinate conversion, and semantic scene controls. It must not classify snap bands or mutate findings.

- [ ] **Step 1: Create a stable floor projection and accessible SVG scene**

Use one projection function for all geometry:

```ts
function project(point: ScenePoint, floorId: FloorId, preset: "perspective" | "top"): [number, number] {
  const floorOffset = floorId === "1F" ? -150 : 90;
  if (preset === "top") return [point.x, point.y + floorOffset];
  return [point.x + point.y * 0.34, point.y * 0.62 + floorOffset - point.z * 4];
}
```

Render an SVG `viewBox="0 0 760 620"` with labelled B1 and 1F floor polygons, resolved elevation badges, venue stair/lift footprints, graph edges, connector/control-point paths, nodes, and point/segment/area finding overlays. Give each selectable object a `<button>` DOM equivalent in an adjacent `.graph-editing-scene__object-list` for keyboard and occlusion fallback.

- [ ] **Step 2: Render synchronized semantic selection and evidence emphasis**

Selected graph identities use indigo. Open Defect evidence uses red; Review uses amber; Advisory uses muted gray. Unrelated floors and graph objects fade to 35% while a finding is active, but remain rendered. `aria-current` and pressed states on DOM equivalents must mirror scene selection.

- [ ] **Step 3: Implement floor-constrained node movement**

For a selected node, render an XY handle on its assigned floor. Use pointer capture and inverse SVG transforms:

```ts
function localPointer(svg: SVGSVGElement, event: React.PointerEvent<SVGElement>): { x: number; y: number } {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(svg.getScreenCTM()?.inverse());
  return { x: local.x, y: local.y };
}
```

Convert the projected pointer back to bounded synthetic floor coordinates and call `actions.previewMove(nodeId, point)` during movement. On pointer up, call `actions.commitMove("snap")` for an Auto candidate, preserve the pending draft for a Review candidate, and call `actions.commitMove("raw")` for None/Ambiguous candidates. Never send Z or floor changes from the scene.

- [ ] **Step 4: Implement Add, Connect, and Delete scene gestures**

- Add: floor-plane click calls `actions.previewAdd({ x, y })`; `state.activeFloor` supplies floor identity. The inspector calls `commitAdd("snap")` or `commitAdd("raw")` after showing the placement evidence.
- Connect: node click calls `beginConnection` or `chooseConnectionEndpoint` depending on `state.pending`.
- Delete: selectable graph-object click calls `requestDelete`; venue evidence never does.
- Select: click calls `selectObject`.
- Escape calls `actions.cancel`; S/P/C/D tool shortcuts and Meta/Ctrl+Z/Shift+Z work unless the target is an input, textarea, select, button, or contenteditable element.

- [ ] **Step 5: Add explicit connector control-point handles and camera presets**

Connector endpoint handles reuse floor-constrained node movement. Interior control points render diamond handles with visible X/Y/Z labels; their prototype movement uses inspector buttons (`X−/X+`, `Y−/Y+`, `Z−/Z+`) that call `nudgeControlPoint`, rather than an ambiguous free pointer drag. Scene controls switch Perspective and Top without changing graph state.

- [ ] **Step 6: Verify and commit the scene slice**

Run `pnpm exec tsc --noEmit`, then:

```bash
git add src/prototypes/graph-editing/GraphEditingScene.tsx
git commit -m "prototype: render constrained exploded graph scene"
```

---

### Task 3: Findings Queue and Selection Inspector

**Files:**
- Create: `src/prototypes/graph-editing/GraphFindingsQueue.tsx`
- Create: `src/prototypes/graph-editing/GraphSelectionInspector.tsx`

**Interfaces:**
- Both consume the Task 1 state/action interface.
- Produces `GraphFindingsQueue({ state, actions }): ReactElement` and `GraphSelectionInspector({ state, actions }): ReactElement`.
- Queue owns no selection state. Inspector drafts call named actions and never write snapshots directly.

- [ ] **Step 1: Build the finding-first queue**

Render severity groups in Defect → Review → Advisory order. Each row includes bilingual title, state, confidence/evidence label, affected floors, measured value, and version status. `endpoint-off-stair` is selected on initial load. Selecting a row calls only `actions.selectFinding(id)`.

Include filters for Open and All. Accepted exceptions remain visible under All. Do not hide Not evaluated as a pass.

- [ ] **Step 2: Build selected graph identity and elevation evidence**

The inspector header names the selected node/edge/connector/control point/venue evidence. The definition list shows assigned floor, floor-plane scene Z, source altitude, source-vs-plane delta, provenance, endpoints, association, and selected finding evidence. Use IBM Plex Mono only for machine values.

- [ ] **Step 3: Build pending fix and snap controls**

When `pending.kind` is `add` or `move`, show before/candidate coordinates, snap source, exact distance, `auto/review/ambiguous/none` band, and the invariant `Floor remains <floor>`. Auto candidates offer Apply snap; Review candidates offer Accept candidate or Keep raw position; ambiguous candidates explain why only raw placement can commit.

- [ ] **Step 4: Build connector draft and association controls**

When `pending.kind === "connect"`, show explicit From and To floor badges. Cross-floor drafts list stair/lift candidates with source and confidence, plus `Leave unassociated`. After association selection, show `Add landing handle` and `Commit connector`. Same-floor drafts show `Commit connection` without conveyance controls.

- [ ] **Step 5: Build explicit floor, exception, profile, delete, Check, and Save workflows**

- Floor reassignment: show before/after floor and scene Z, preserve source altitude, and call `reassignNodeFloor` only after Confirm.
- Exception: `beginException` opens a draft; textarea reason is required before `acceptException` enables.
- Profile override: numeric auto/review inputs call `updateProfileDraft`; require a reason and enforce `0 < autoSnapM < reviewSnapM` before `commitProfileOverride` enables.
- Delete: show incident edges and finding consequences before `confirmDelete`.
- Check: show structural status, semantic counts, and pending broad-rule status.
- Fake Save: confirmation states that production would create a new immutable version; no API call.

- [ ] **Step 6: Verify and commit the panel slice**

Run `pnpm exec tsc --noEmit`, then:

```bash
git add src/prototypes/graph-editing/GraphFindingsQueue.tsx src/prototypes/graph-editing/GraphSelectionInspector.tsx
git commit -m "prototype: add synchronized graph repair panels"
```

---

### Task 4: Full-Screen Cockpit, Kiriko Styling, and Browser Proof

**Files:**
- Create: `src/prototypes/graph-editing/GraphEditingPrototype.tsx`
- Create: `src/prototypes/graph-editing/graphEditingPrototype.css`
- Modify: `src/main.tsx:6-20`

**Interfaces:**
- `GraphEditingPrototype` calls `useGraphEditingPrototype()` once and passes the same state/actions to scene, queue, inspector, toolbar, and prototype-state panel.
- `src/main.tsx` mounts it only when `new URLSearchParams(window.location.search).get("prototype") === "graph-editing"`.

- [ ] **Step 1: Compose the synchronized cockpit shell**

Create one `<main className="graph-editing-prototype" lang={state.locale}>` with:

```tsx
<header className="graph-editing-prototype__header" />
<section className="graph-editing-prototype__toolbar" aria-label={copy.toolbarLabel[state.locale]} />
<GraphFindingsQueue state={state} actions={actions} />
<GraphEditingScene state={state} actions={actions} />
<GraphSelectionInspector state={state} actions={actions} />
<aside className="graph-editing-prototype__state" aria-label={copy.prototypeState[state.locale]} />
<div className="sr-only" aria-live="polite" aria-atomic="true" />
```

Header controls: Japanese/English, reduced motion, scenario picker, Reset. Toolbar: Select/Add/Connect/Delete, Undo/Redo, active floor B1/1F, Check, Save as new version.

- [ ] **Step 2: Render the full prototype state and bilingual announcements**

State panel fields: scenario, tool, active floor, selection, selected finding, pending operation, snap band/distance, history depth, future depth, staged change count, finding delta, Check state, Save state, locale, reduced motion, camera preset. The live region announces every commit/reject/undo/redo/check/save transition and current floor.

- [ ] **Step 3: Add the query-param entry without changing normal routing**

Modify `src/main.tsx` to preserve the existing `showViewer` calculation and use:

```tsx
const prototype = new URLSearchParams(window.location.search).get("prototype");

createRoot(root).render(
  <StrictMode>
    {prototype === "graph-editing" ? (
      <GraphEditingPrototype />
    ) : showViewer ? (
      <App />
    ) : (
      <GalleryPage />
    )}
  </StrictMode>,
);
```

- [ ] **Step 4: Implement scoped Kiriko desktop styling**

Import `graphEditingPrototype.css` from the prototype component. Scope every selector under `.graph-editing-prototype`. Reuse `src/app/app.css` tokens for washi canvas, panel white, Sumi text, Ai Indigo interaction, semantic warning colors, typography, 1 px hairlines, 8/12/pill radii, Floating/Raised shadows, spacing, control heights, focus ring, and motion durations.

At 1440×900 use columns `280px minmax(0, 1fr) 340px`; keep the toolbar above the scene and the prototype-state panel compact at the scene bottom. At 1180–1279 px reduce left/right columns to `240px`/`300px`; do not collapse into a mobile sheet. All panels use internal scrolling and the document has no page-level overflow.

Under `.graph-editing-prototype--reduced-motion` and `prefers-reduced-motion: reduce`, set scene/camera transitions to `0.01ms` and remove interpolated transforms without hiding state changes.

- [ ] **Step 5: Run static verification**

Run:

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both pass. The existing Vite large-chunk advisory is non-blocking.

- [ ] **Step 6: Exercise all six stories in a real browser**

Start `pnpm dev --host 127.0.0.1` and open `http://127.0.0.1:5173/?prototype=graph-editing` at 1440×900. Verify:

1. repair endpoint resolves at 0.31 m and Undo/Redo restores synchronized finding state;
2. Add lands on the explicit floor, cross-floor Connect requires endpoint identities and association, and a landing handle can be added;
3. duplicate edge rejects without history change;
4. floor reassignment, accepted exception, and profile override require explicit values/reasons;
5. delete consequence preview commits and Undo restores the graph;
6. Check completes and fake Save confirms a new immutable version without network traffic.

Also verify Japanese copy, `lang`, keyboard focus, S/P/C/D and Undo/Redo shortcuts, reduced-motion state preservation, stable floor/elevation labels, zero overlap, and zero page-level horizontal/vertical overflow at 1440×900 and 1180×720.

- [ ] **Step 7: Run one bounded visual finish pass**

Run `npx impeccable detect src/prototypes/graph-editing`, fix mechanical findings in one batch, capture one 1440×900 screenshot for the endpoint repair and connector draft states, obtain one fresh finish review, apply only Critical/Important corrections, recapture once, and stop polishing.

- [ ] **Step 8: Commit the verified cockpit**

```bash
git add src/main.tsx src/prototypes/graph-editing
git commit -m "prototype: compare 3d graph repair interactions"
```

- [ ] **Step 9: Publish the disposable branch and attach its pointer**

```bash
git push -u origin prototype/graph-editing-model
```

Attach the branch URL, `/?prototype=graph-editing`, screenshots, and the selected behavior verdict to [Choose the full 3D graph-editing model](https://github.com/dmalmq/imdf-map-application/issues/27). Do not merge the branch into `main`.
