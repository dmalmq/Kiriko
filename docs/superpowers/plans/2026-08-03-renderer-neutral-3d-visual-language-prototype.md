# Renderer-Neutral 3D Visual Language Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a disposable, browser-verifiable Kiriko prototype that proves the approved Architectural Cutaway visual language across Detailed 3D, Generated 3D, and 2D source fidelity; route and floor-handoff states; selection; diagnostics; fallback; bilingual copy; and reduced motion.

**Architecture:** Add an isolated `/?prototype=visual-language` React entry that never mounts or modifies the production viewer. A typed, renderer-neutral fixture model supplies semantic primitives, route state, labels, diagnostics, and source provenance to one SVG projection adapter; the same adapter renders intentionally different Detailed and Generated source geometry with identical semantic styling. A reducer-owned controller drives deterministic handoff and fallback phases, while a prototype-only shell exposes source, scenario, locale, reduced-motion, and diagnostic controls.

**Tech Stack:** React 19, TypeScript 7, CSS, inline SVG, existing JIS pictograms, Vite 8, Chromium browser verification.

## Global Constraints

- Implement on an isolated branch/worktree named `prototype/renderer-neutral-3d-visual-language`; do not merge disposable prototype code into `main`.
- Approved design source: `docs/superpowers/specs/2026-08-03-renderer-neutral-3d-visual-language-design.md`.
- Production `App`, `IndoorMap`, route DTOs, KVB, Rust, server, APIs, persistence, and production style behavior remain unchanged.
- The prototype route is exactly `/?prototype=visual-language`; all existing viewer/gallery routing remains unchanged for every other URL.
- Do not add runtime or development dependencies, network requests, tile loading, WebGL libraries, persistence, fake production adapters, or new production abstractions.
- Use the same semantic state for Detailed 3D, Generated 3D, and 2D; source fixtures may differ only in honest geometry detail and provenance.
- Never display Detailed and Generated geometry in one scene. Compare mode renders two separately labelled viewports.
- Normal navigation overrides arbitrary source materials. Generated geometry receives no inferiority tint or hatch. Producer provenance filters are the only place source-confidence patterns appear.
- Scene palette: canvas `#EDEDEB`; walkable `#FAFAF9`; public `#E9EDF4`; service `#F0EBE0`; restricted/structure `#D5DAE3`; semantic edge `#C8CEDA`; opening `#9AA3B2`; selected soft `#EEF2FF`; interaction/route `#4F46E5`; Defect `#DC2626`; Review `#D97706`; Advisory `#78716C`.
- Ai Indigo is reserved for interaction, selection, focus, and route. Amber is never a conveyance or route-handoff color.
- Active-floor ceilings are absent. Protected route, selection, conveyance, destination, and priority-label corridors remain readable through semantic occluder classes, not depth-buffer guesses.
- Route core is approximately 4 device-independent pixels on desktop and 5 on mobile, with a white casing approximately 4 pixels wider overall. Current, future, and completed phases use one indigo hue at `100%`, `55–65%`, and `28–36%` opacity.
- Detailed source badge copy: `Detailed 3D` / `詳細 3D`. Generated source badge copy: `Generated 3D` / `生成 3D`. 2D badge copy: `2D map` / `2D マップ`.
- Every user-visible string exists in Japanese and English. Use Inter/Noto Sans JP for prose and IBM Plex Mono for machine state and measured values.
- Every interactive control has a visible focus state and a minimum `44×44` pixel mobile target. State meaning never relies on color, shadow, opacity, texture, or motion alone.
- Reduced motion preserves the identical phase order, active floor, route state, announcements, selection, and fallback destination while removing camera interpolation, opacity tween, pulse, animated dash, and directional motion.
- Validate desktop `1440×900`, compact desktop `1180×720`, and mobile `390×844`. Producer diagnostics may remain desktop-oriented, but the mobile navigation/fallback surface must remain operable.
- Browser behavior and visual proof are the prototype acceptance method. Do not add automated tests for disposable SVG/CSS presentation; run existing TypeScript and build checks once after the behavior works.
- Exact renderer architecture and performance budgets remain out of scope for issues #23 and #26.

---

### Task 1: Renderer-neutral fixture contract

**Files:**
- Create: `src/prototypes/visualLanguage/visualLanguage.ts`
- Create: `src/prototypes/visualLanguage/visualLanguageFixtures.ts`

**Interfaces:**
- Produces `PrototypeLocale`, `SceneSourceKind`, `SourceLayout`, `ScenarioId`, `FloorId`, `HandoffPhaseId`, `SemanticRole`, `OcclusionClass`, `DiagnosticSeverity`, `LocalizedText`, `Point3`, `ScenePrimitive`, `RouteSegmentFixture`, `SceneLabelFixture`, `DiagnosticFixture`, `SceneSourceFixture`, `VisualLanguageFixture`, `COPY`, `HANDOFF_PHASES`, and `VISUAL_LANGUAGE_FIXTURE`.
- `visualLanguageFixtures.ts` is pure deterministic data. It imports only types from `visualLanguage.ts` and exports one immutable fixture.
- Later components consume semantic roles and source identity; they never branch on source-specific object IDs to choose colors or interaction states.

- [ ] **Step 1: Define the closed prototype vocabulary**

Create `src/prototypes/visualLanguage/visualLanguage.ts` with these exact public types:

```ts
export type PrototypeLocale = "en" | "ja";
export type SceneSourceKind = "detailed" | "generated" | "twoDimensional";
export type SourceLayout = "compare" | "single";
export type ScenarioId =
  | "guidance"
  | "selection"
  | "handoff"
  | "overview"
  | "diagnostics"
  | "fallback";
export type FloorId = "B1" | "1F";
export type HandoffPhaseId =
  | "walk-b1"
  | "announce-escalator"
  | "pull-back"
  | "show-destination-floor"
  | "switch-floor"
  | "settle-1f";
export type SemanticRole =
  | "walkable"
  | "public"
  | "service"
  | "restricted"
  | "structure"
  | "context"
  | "ceiling"
  | "opening"
  | "elevator"
  | "escalator"
  | "stairs"
  | "ramp";
export type OcclusionClass = "never" | "protectedCorridor" | "context";
export type DiagnosticSeverity = "defect" | "review" | "advisory" | "accepted";
export interface LocalizedText { readonly en: string; readonly ja: string }
export interface Point3 { readonly x: number; readonly y: number; readonly z: number }
export interface SurfacePrimitive {
  readonly kind: "surface";
  readonly id: string;
  readonly role: SemanticRole;
  readonly floor: FloorId;
  readonly ring: readonly Point3[];
  readonly occlusion: OcclusionClass;
  readonly canonicalId: string | null;
  readonly sourceObjectId: string;
}
export interface BoxPrimitive {
  readonly kind: "box";
  readonly id: string;
  readonly role: SemanticRole;
  readonly floor: FloorId;
  readonly origin: Point3;
  readonly size: Point3;
  readonly occlusion: OcclusionClass;
  readonly canonicalId: string | null;
  readonly sourceObjectId: string;
}
export type ScenePrimitive = SurfacePrimitive | BoxPrimitive;
export interface RouteSegmentFixture {
  readonly id: string;
  readonly floor: FloorId | "connector";
  readonly phase: "completed" | "current" | "future" | "connector";
  readonly points: readonly Point3[];
}
export interface SceneLabelFixture {
  readonly id: string;
  readonly floor: FloorId;
  readonly category: "nextAction" | "destination" | "selection" | "conveyance" | "exit" | "landmark";
  readonly text: LocalizedText;
  readonly anchor: Point3;
}
export interface DiagnosticFixture {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly floor: FloorId;
  readonly geometry: "point" | "segment" | "area";
  readonly points: readonly Point3[];
  readonly summary: LocalizedText;
}
export interface SceneSourceFixture {
  readonly kind: SceneSourceKind;
  readonly badge: LocalizedText;
  readonly provenance: LocalizedText;
  readonly primitives: readonly ScenePrimitive[];
}
export interface VisualLanguageFixture {
  readonly sources: Readonly<Record<SceneSourceKind, SceneSourceFixture>>;
  readonly route: readonly RouteSegmentFixture[];
  readonly labels: readonly SceneLabelFixture[];
  readonly diagnostics: readonly DiagnosticFixture[];
}
```

Add these deterministic transition phases and durations to the same file:

```ts
export const HANDOFF_PHASES = [
  { id: "walk-b1", floor: "B1", durationMs: 900 },
  { id: "announce-escalator", floor: "B1", durationMs: 1100 },
  { id: "pull-back", floor: "B1", durationMs: 850 },
  { id: "show-destination-floor", floor: "B1", durationMs: 950 },
  { id: "switch-floor", floor: "1F", durationMs: 700 },
  { id: "settle-1f", floor: "1F", durationMs: 1200 },
] as const satisfies readonly {
  id: HandoffPhaseId;
  floor: FloorId;
  durationMs: number;
}[];
```

- [ ] **Step 2: Define complete bilingual prototype copy**

Export `COPY` from `visualLanguage.ts` with these keys and exact values:

```ts
export const COPY = {
  title: { en: "Architectural Cutaway", ja: "建築カットアウェイ" },
  prototype: { en: "Visual language prototype", ja: "ビジュアル言語プロトタイプ" },
  compare: { en: "Compare sources", ja: "ソースを比較" },
  detailed: { en: "Detailed 3D", ja: "詳細 3D" },
  generated: { en: "Generated 3D", ja: "生成 3D" },
  twoDimensional: { en: "2D map", ja: "2D マップ" },
  guidance: { en: "Guidance", ja: "案内" },
  selection: { en: "Selection", ja: "選択" },
  handoff: { en: "Floor handoff", ja: "フロア移動" },
  overview: { en: "Route overview", ja: "ルート全体" },
  diagnostics: { en: "Diagnostics", ja: "診断" },
  fallback: { en: "Fallback", ja: "フォールバック" },
  scenario: { en: "Scenario", ja: "シナリオ" },
  sceneSource: { en: "Scene source", ja: "シーンソース" },
  openFindings: { en: "Defect and Review", ja: "不具合と要確認" },
  allFindings: { en: "All findings", ja: "すべての指摘" },
  inspector: { en: "Prototype state", ja: "プロトタイプ状態" },
  showInspector: { en: "Show state", ja: "状態を表示" },
  hideInspector: { en: "Hide state", ja: "状態を非表示" },
  currentFloor: { en: "Current floor", ja: "現在のフロア" },
  destinationFloor: { en: "Destination floor", ja: "移動先フロア" },
  remainingDistance: { en: "84 m remaining", ja: "残り 84 m" },
  playHandoff: { en: "Play floor change", ja: "フロア移動を再生" },
  pause: { en: "Pause", ja: "一時停止" },
  restart: { en: "Restart", ja: "最初から" },
  simulateFailure: { en: "Simulate detailed 3D failure", ja: "詳細 3D の障害を再現" },
  retryDetailed: { en: "Retry detailed 3D", ja: "詳細 3D を再試行" },
  fallbackNotice: {
    en: "Detailed 3D is unavailable. Showing generated geometry.",
    ja: "詳細 3D を利用できないため、生成ジオメトリを表示しています。",
  },
  sourceMaterial: { en: "Inspect source material", ja: "ソースマテリアルを確認" },
  reducedMotion: { en: "Reduced motion", ja: "視差効果を減らす" },
  language: { en: "Language", ja: "言語" },
  activeFloor: { en: "Active floor", ja: "表示中のフロア" },
  nextAction: { en: "Take the escalator to 1F", ja: "エスカレーターで 1F へ" },
  destination: { en: "Marunouchi Central Exit", ja: "丸の内中央口" },
  selectedEscalator: { en: "Escalator · B1 to 1F", ja: "エスカレーター・B1 から 1F" },
  elevator: { en: "Elevator · B1 to 1F", ja: "エレベーター・B1 から 1F" },
  stairs: { en: "Stairs · B1 to 1F", ja: "階段・B1 から 1F" },
  ramp: { en: "Ramp · B1", ja: "スロープ・B1" },
  opening: { en: "West passage opening", ja: "西通路の開口部" },
  defect: { en: "Defect", ja: "不具合" },
  review: { en: "Review", ja: "要確認" },
  advisory: { en: "Advisory", ja: "参考情報" },
  accepted: { en: "Accepted exception", ja: "承認済み例外" },
} as const satisfies Record<string, LocalizedText>;
```

- [ ] **Step 3: Build source fixtures with intentionally different fidelity**

Create `visualLanguageFixtures.ts`. Use a `p(x, y, z)` helper and define both floors in venue-local metres. Detailed and Generated must share canonical floor, route, label, and conveyance identities while carrying different source object identities and primitive counts.

Use these shared canonical surfaces:

```ts
const p = (x: number, y: number, z: number): Point3 => ({ x, y, z });

const sharedSurfaces: readonly ScenePrimitive[] = [
  {
    kind: "surface",
    id: "b1-walkable",
    role: "walkable",
    floor: "B1",
    ring: [p(0, 0, 0), p(34, 0, 0), p(34, 20, 0), p(0, 20, 0)],
    occlusion: "never",
    canonicalId: "level-b1",
    sourceObjectId: "canonical:b1",
  },
  {
    kind: "surface",
    id: "b1-service",
    role: "service",
    floor: "B1",
    ring: [p(3, 3, 0.03), p(12, 3, 0.03), p(12, 8, 0.03), p(3, 8, 0.03)],
    occlusion: "never",
    canonicalId: "unit-b1-service",
    sourceObjectId: "canonical:service",
  },
  {
    kind: "surface",
    id: "b1-public",
    role: "public",
    floor: "B1",
    ring: [p(22, 11, 0.03), p(31, 11, 0.03), p(31, 17, 0.03), p(22, 17, 0.03)],
    occlusion: "never",
    canonicalId: "unit-b1-public",
    sourceObjectId: "canonical:public",
  },
  {
    kind: "surface",
    id: "1f-walkable",
    role: "walkable",
    floor: "1F",
    ring: [p(5, 2, 4.2), p(32, 2, 4.2), p(32, 18, 4.2), p(5, 18, 4.2)],
    occlusion: "never",
    canonicalId: "level-1f",
    sourceObjectId: "canonical:1f",
  },
];
```

Add these helpers and exact source-specific primitive sets after `sharedSurfaces`:

```ts
const box = (
  id: string,
  role: SemanticRole,
  floor: FloorId,
  origin: Point3,
  size: Point3,
  occlusion: OcclusionClass,
  canonicalId: string | null,
): BoxPrimitive => ({
  kind: "box",
  id,
  role,
  floor,
  origin,
  size,
  occlusion,
  canonicalId,
  sourceObjectId: id,
});

const ceiling = (id: string, floor: FloorId, z: number): ScenePrimitive => ({
  kind: "surface",
  id,
  role: "ceiling",
  floor,
  ring: [p(0, 0, z), p(34, 0, z), p(34, 20, z), p(0, 20, z)],
  occlusion: "protectedCorridor",
  canonicalId: null,
  sourceObjectId: id,
});

const sourceObject = (source: "tiles" | "generated", primitive: ScenePrimitive): ScenePrimitive => ({
  ...primitive,
  sourceObjectId: `${source}:${primitive.id}`,
});

const detailedOnly: readonly ScenePrimitive[] = [
  box("b1-wall-n", "structure", "B1", p(0, 0, 0), p(34, 0.35, 3.2), "context", null),
  box("b1-wall-s", "structure", "B1", p(0, 19.65, 0), p(34, 0.35, 3.2), "protectedCorridor", null),
  box("b1-wall-e", "structure", "B1", p(33.65, 0, 0), p(0.35, 20, 3.2), "context", null),
  box("b1-wall-w", "structure", "B1", p(0, 0, 0), p(0.35, 20, 3.2), "protectedCorridor", null),
  box("b1-wall-service", "structure", "B1", p(12, 3, 0), p(0.25, 8, 2.8), "protectedCorridor", null),
  box("b1-wall-public", "structure", "B1", p(22, 10.8, 0), p(9, 0.25, 2.8), "context", null),
  box("b1-column-a", "structure", "B1", p(16, 5, 0), p(0.7, 0.7, 2.9), "protectedCorridor", null),
  box("b1-column-b", "structure", "B1", p(18.5, 14, 0), p(0.7, 0.7, 2.9), "context", null),
  box("1f-wall-n", "structure", "1F", p(5, 2, 4.2), p(27, 0.35, 3.1), "context", null),
  box("1f-wall-s", "structure", "1F", p(5, 17.65, 4.2), p(27, 0.35, 3.1), "protectedCorridor", null),
  box("1f-wall-e", "structure", "1F", p(31.65, 2, 4.2), p(0.35, 16, 3.1), "context", null),
  box("1f-wall-w", "structure", "1F", p(5, 2, 4.2), p(0.35, 16, 3.1), "protectedCorridor", null),
  box("1f-wall-interior", "structure", "1F", p(20, 7, 4.2), p(0.25, 8, 2.7), "protectedCorridor", null),
  box("escalator-b1-1f", "escalator", "B1", p(15, 8, 0.1), p(3.4, 7.2, 3.9), "never", "conveyance-escalator"),
  box("stairs-b1-1f", "stairs", "B1", p(9, 11, 0.1), p(3, 6, 3.9), "never", "conveyance-stairs"),
  box("elevator-b1-1f", "elevator", "B1", p(25, 4, 0), p(3.2, 3.2, 7.3), "context", "conveyance-elevator"),
  box("ramp-b1", "ramp", "B1", p(28, 14, 0.05), p(3.5, 4.5, 0.8), "never", "conveyance-ramp"),
  box("opening-b1-west", "opening", "B1", p(0, 8, 0), p(0.4, 2.4, 2.3), "never", "opening-b1-west"),
  box("opening-1f-south", "opening", "1F", p(25, 17.6, 4.2), p(2.6, 0.4, 2.3), "never", "opening-1f-south"),
  box("fixture-ticket-a", "structure", "B1", p(5, 13, 0), p(1.2, 2.2, 1.1), "context", "fixture-ticket-a"),
  box("fixture-ticket-b", "structure", "B1", p(7, 13, 0), p(1.2, 2.2, 1.1), "context", "fixture-ticket-b"),
  box("fixture-kiosk", "structure", "B1", p(27, 8, 0), p(2.3, 2.3, 2.4), "context", "fixture-kiosk"),
  box("fixture-information", "structure", "1F", p(10, 12, 4.2), p(1.6, 1.6, 1.3), "context", "fixture-information"),
  ceiling("b1-ceiling", "B1", 3.2),
  ceiling("1f-ceiling", "1F", 7.3),
];

const generatedOnly: readonly ScenePrimitive[] = [
  box("b1-wall-n", "structure", "B1", p(0, 0, 0), p(34, 0.35, 3), "context", null),
  box("b1-wall-s", "structure", "B1", p(0, 19.65, 0), p(34, 0.35, 3), "protectedCorridor", null),
  box("b1-wall-e", "structure", "B1", p(33.65, 0, 0), p(0.35, 20, 3), "context", null),
  box("b1-wall-w", "structure", "B1", p(0, 0, 0), p(0.35, 20, 3), "protectedCorridor", null),
  box("b1-wall-service", "structure", "B1", p(12, 3, 0), p(0.25, 8, 2.8), "protectedCorridor", null),
  box("b1-wall-public", "structure", "B1", p(22, 10.8, 0), p(9, 0.25, 2.8), "context", null),
  box("1f-wall-n", "structure", "1F", p(5, 2, 4.2), p(27, 0.35, 3), "context", null),
  box("1f-wall-s", "structure", "1F", p(5, 17.65, 4.2), p(27, 0.35, 3), "protectedCorridor", null),
  box("1f-wall-e", "structure", "1F", p(31.65, 2, 4.2), p(0.35, 16, 3), "context", null),
  box("1f-wall-w", "structure", "1F", p(5, 2, 4.2), p(0.35, 16, 3), "protectedCorridor", null),
  box("escalator-b1-1f", "escalator", "B1", p(15, 8, 0.1), p(3.4, 7.2, 3.9), "never", "conveyance-escalator"),
  box("stairs-b1-1f", "stairs", "B1", p(9, 11, 0.1), p(3, 6, 3.9), "never", "conveyance-stairs"),
  box("elevator-b1-1f", "elevator", "B1", p(25, 4, 0), p(3.2, 3.2, 7.2), "context", "conveyance-elevator"),
  box("ramp-b1", "ramp", "B1", p(28, 14, 0.05), p(3.5, 4.5, 0.8), "never", "conveyance-ramp"),
  ceiling("b1-ceiling", "B1", 3),
  ceiling("1f-ceiling", "1F", 7.2),
];

const detailedPrimitives = [...sharedSurfaces, ...detailedOnly].map((primitive) =>
  sourceObject("tiles", primitive),
);
const generatedPrimitives = [...sharedSurfaces, ...generatedOnly].map((primitive) =>
  sourceObject("generated", primitive),
);

const flattenPoint = (point: Point3): Point3 => ({ ...point, z: 0 });
const flattenPrimitive = (primitive: ScenePrimitive): ScenePrimitive =>
  primitive.kind === "surface"
    ? { ...primitive, ring: primitive.ring.map(flattenPoint) }
    : {
        ...primitive,
        origin: flattenPoint(primitive.origin),
        size: { ...primitive.size, z: 0 },
      };
const twoDimensionalPrimitives = generatedPrimitives.map(flattenPrimitive);
```

Add these exact route, label, and diagnostic fixtures:

```ts
const routeSegments: readonly RouteSegmentFixture[] = [
  {
    id: "route-b1",
    floor: "B1",
    phase: "current",
    points: [p(3, 17, 0.12), p(10, 15, 0.12), p(14.5, 12, 0.12), p(16.5, 10, 0.12)],
  },
  {
    id: "route-connector",
    floor: "connector",
    phase: "connector",
    points: [p(16.5, 10, 0.12), p(16.5, 10, 4.32)],
  },
  {
    id: "route-1f",
    floor: "1F",
    phase: "future",
    points: [p(16.5, 10, 4.32), p(23, 12, 4.32), p(29, 16, 4.32)],
  },
];

const sceneLabels: readonly SceneLabelFixture[] = [
  { id: "next-action", floor: "B1", category: "nextAction", text: COPY.nextAction, anchor: p(14.5, 12, 1.2) },
  { id: "destination", floor: "1F", category: "destination", text: COPY.destination, anchor: p(29, 16, 5.1) },
  { id: "selected-escalator", floor: "B1", category: "conveyance", text: COPY.selectedEscalator, anchor: p(16.5, 10, 2.4) },
  {
    id: "yaesu-exit",
    floor: "B1",
    category: "exit",
    text: { en: "Yaesu passage", ja: "八重洲通路" },
    anchor: p(31, 5, 0.8),
  },
  {
    id: "marunouchi-landmark",
    floor: "1F",
    category: "landmark",
    text: { en: "Marunouchi concourse", ja: "丸の内コンコース" },
    anchor: p(10, 15, 5),
  },
];

const diagnostics: readonly DiagnosticFixture[] = [
  {
    id: "finding-defect-wall",
    severity: "defect",
    floor: "B1",
    geometry: "segment",
    points: [p(10, 14, 0.18), p(12, 12.5, 0.18)],
    summary: { en: "Confirmed route crosses a wall", ja: "確定ルートが壁を横断しています" },
  },
  {
    id: "finding-review-snap",
    severity: "review",
    floor: "B1",
    geometry: "point",
    points: [p(16.5, 10, 0.18)],
    summary: { en: "Connector snap needs review", ja: "接続点のスナップを確認してください" },
  },
  {
    id: "finding-advisory-elevation",
    severity: "advisory",
    floor: "1F",
    geometry: "area",
    points: [p(21, 10, 4.34), p(26, 10, 4.34), p(26, 14, 4.34), p(21, 14, 4.34)],
    summary: { en: "Floor elevation is inferred", ja: "フロア標高は推定値です" },
  },
  {
    id: "finding-accepted-partition",
    severity: "accepted",
    floor: "B1",
    geometry: "point",
    points: [p(7, 6, 0.18)],
    summary: { en: "Intentional graph partition", ja: "意図されたグラフ分割です" },
  },
];
```

Export the complete fixture exactly:

```ts
export const VISUAL_LANGUAGE_FIXTURE: VisualLanguageFixture = {
  sources: {
    detailed: {
      kind: "detailed",
      badge: COPY.detailed,
      provenance: {
        en: "3D Tiles · source-authored detail",
        ja: "3D Tiles・ソース由来の詳細",
      },
      primitives: detailedPrimitives,
    },
    generated: {
      kind: "generated",
      badge: COPY.generated,
      provenance: {
        en: "Kiriko generated · evidence-backed approximation",
        ja: "Kiriko 生成・根拠に基づく近似",
      },
      primitives: generatedPrimitives,
    },
    twoDimensional: {
      kind: "twoDimensional",
      badge: COPY.twoDimensional,
      provenance: {
        en: "Universal 2D fallback",
        ja: "ユニバーサル 2D フォールバック",
      },
      primitives: twoDimensionalPrimitives,
    },
  },
  route: routeSegments,
  labels: sceneLabels,
  diagnostics,
};
```

- [ ] **Step 4: Verify the fixture module compiles**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics; the new unreferenced modules compile under strict TypeScript without `any`.

- [ ] **Step 5: Commit the semantic fixture slice**

```bash
git add src/prototypes/visualLanguage/visualLanguage.ts src/prototypes/visualLanguage/visualLanguageFixtures.ts
git commit -m "prototype: define 3D visual language fixtures"
```

---

### Task 2: Deterministic prototype state controller

**Files:**
- Create: `src/prototypes/visualLanguage/useVisualLanguagePrototype.ts`

**Interfaces:**
- Consumes: `COPY`, `FloorId`, `HANDOFF_PHASES`, `HandoffPhaseId`, `PrototypeLocale`, `ScenarioId`, `SceneSourceKind`, and `SourceLayout` from `visualLanguage.ts`.
- Produces `DiagnosticFilter`, `FallbackPhase`, `PlaybackState`, `VisualLanguagePrototypeState`, `VisualLanguagePrototypeActions`, and `useVisualLanguagePrototype()`.
- The controller is the only owner of source selection, fallback state, handoff playback, active floor, scenario, selected semantic object, locale, and reduced-motion override.

- [ ] **Step 1: Define state and action contracts**

Create the following public state shape:

```ts
export type DiagnosticFilter = "default" | "all";
export type FallbackPhase = "idle" | "veil" | "generated";
export type PlaybackState = "ready" | "playing" | "paused" | "complete";
export interface VisualLanguagePrototypeState {
  readonly locale: PrototypeLocale;
  readonly sourceLayout: SourceLayout;
  readonly sourceKind: SceneSourceKind;
  readonly scenario: ScenarioId;
  readonly reducedMotion: boolean;
  readonly activeFloor: FloorId;
  readonly handoffIndex: number;
  readonly playback: PlaybackState;
  readonly fallbackPhase: FallbackPhase;
  readonly fallbackNoticeVisible: boolean;
  readonly selectedId: string | null;
  readonly diagnosticFilter: DiagnosticFilter;
  readonly sourceMaterialInspection: boolean;
}
export interface VisualLanguagePrototypeActions {
  readonly setLocale: (locale: PrototypeLocale) => void;
  readonly setSourceLayout: (layout: SourceLayout) => void;
  readonly setSourceKind: (kind: SceneSourceKind) => void;
  readonly setScenario: (scenario: ScenarioId) => void;
  readonly setReducedMotion: (value: boolean) => void;
  readonly playHandoff: () => void;
  readonly pauseHandoff: () => void;
  readonly restartHandoff: () => void;
  readonly simulateDetailedFailure: () => void;
  readonly retryDetailed: () => void;
  readonly selectObject: (id: string | null) => void;
  readonly setDiagnosticFilter: (filter: DiagnosticFilter) => void;
  readonly setSourceMaterialInspection: (value: boolean) => void;
}
```

- [ ] **Step 2: Implement one reducer with invariant-preserving transitions**

Use this closed action union and reducer:

```ts
type Action =
  | { readonly type: "set-locale"; readonly locale: PrototypeLocale }
  | { readonly type: "set-layout"; readonly layout: SourceLayout }
  | { readonly type: "set-source"; readonly source: SceneSourceKind }
  | { readonly type: "set-scenario"; readonly scenario: ScenarioId }
  | { readonly type: "set-reduced-motion"; readonly value: boolean }
  | { readonly type: "play-handoff" }
  | { readonly type: "pause-handoff" }
  | { readonly type: "restart-handoff" }
  | { readonly type: "advance-handoff" }
  | { readonly type: "simulate-failure" }
  | { readonly type: "complete-fallback" }
  | { readonly type: "retry-detailed" }
  | { readonly type: "select-object"; readonly id: string | null }
  | { readonly type: "set-diagnostic-filter"; readonly filter: DiagnosticFilter }
  | { readonly type: "set-source-material"; readonly value: boolean };

const initialState: VisualLanguagePrototypeState = {
  locale: "en",
  sourceLayout: "compare",
  sourceKind: "detailed",
  scenario: "guidance",
  reducedMotion: false,
  activeFloor: "B1",
  handoffIndex: 0,
  playback: "ready",
  fallbackPhase: "idle",
  fallbackNoticeVisible: false,
  selectedId: null,
  diagnosticFilter: "default",
  sourceMaterialInspection: false,
};

function reducer(
  state: VisualLanguagePrototypeState,
  action: Action,
): VisualLanguagePrototypeState {
  switch (action.type) {
    case "set-locale":
      return { ...state, locale: action.locale };
    case "set-layout":
      return {
        ...state,
        sourceLayout: action.layout,
        sourceKind:
          action.layout === "compare" && state.sourceKind === "twoDimensional"
            ? "detailed"
            : state.sourceKind,
      };
    case "set-source":
      return {
        ...state,
        sourceLayout: "single",
        sourceKind: action.source,
        fallbackPhase: "idle",
        fallbackNoticeVisible: false,
      };
    case "set-scenario":
      return {
        ...state,
        scenario: action.scenario,
        sourceLayout: action.scenario === "fallback" ? "single" : state.sourceLayout,
        sourceKind: action.scenario === "fallback" ? "detailed" : state.sourceKind,
        activeFloor: "B1",
        handoffIndex: 0,
        playback: "ready",
        fallbackPhase: "idle",
        fallbackNoticeVisible: false,
        selectedId: action.scenario === "selection" ? "escalator-b1-1f" : null,
        diagnosticFilter: "default",
        sourceMaterialInspection: false,
      };
    case "set-reduced-motion":
      return state.fallbackPhase === "veil" && action.value
        ? {
            ...state,
            reducedMotion: true,
            sourceKind: "generated",
            fallbackPhase: "generated",
            fallbackNoticeVisible: true,
          }
        : { ...state, reducedMotion: action.value };
    case "play-handoff":
      return {
        ...state,
        scenario: "handoff",
        playback: state.playback === "complete" ? "complete" : "playing",
      };
    case "pause-handoff":
      return { ...state, playback: "paused" };
    case "restart-handoff":
      return {
        ...state,
        scenario: "handoff",
        activeFloor: "B1",
        handoffIndex: 0,
        playback: "ready",
      };
    case "advance-handoff": {
      const lastIndex = HANDOFF_PHASES.length - 1;
      const nextIndex = Math.min(state.handoffIndex + 1, lastIndex);
      return {
        ...state,
        handoffIndex: nextIndex,
        activeFloor: HANDOFF_PHASES[nextIndex]!.floor,
        playback: nextIndex === lastIndex ? "complete" : "playing",
      };
    }
    case "simulate-failure":
      return state.reducedMotion
        ? {
            ...state,
            sourceKind: "generated",
            fallbackPhase: "generated",
            fallbackNoticeVisible: true,
          }
        : { ...state, fallbackPhase: "veil", fallbackNoticeVisible: true };
    case "complete-fallback":
      return {
        ...state,
        sourceKind: "generated",
        fallbackPhase: "generated",
        fallbackNoticeVisible: true,
      };
    case "retry-detailed":
      return {
        ...state,
        sourceKind: "detailed",
        fallbackPhase: "idle",
        fallbackNoticeVisible: false,
      };
    case "select-object":
      return { ...state, selectedId: action.id };
    case "set-diagnostic-filter":
      return { ...state, diagnosticFilter: action.filter };
    case "set-source-material":
      return {
        ...state,
        sourceMaterialInspection:
          state.scenario === "diagnostics" ? action.value : false,
      };
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}
```

Expose `VisualLanguagePrototypeActions` as memoized dispatch wrappers. `playHandoff`
must dispatch `restart-handoff` followed by `play-handoff` when playback is
complete; otherwise it dispatches `play-handoff` once.

- [ ] **Step 3: Add deterministic handoff and fallback timers**

In `useVisualLanguagePrototype()`, schedule one timeout only when `playback === "playing"`; use the current `HANDOFF_PHASES[state.handoffIndex].durationMs`. Reduced motion keeps these announcement dwell times but the view receives the `reducedMotion` class and performs discrete visual changes with no CSS interpolation.

Schedule the source veil for exactly `160 ms` only when `fallbackPhase === "veil"`. Clear every timer in the effect cleanup. Return a localized `liveMessage` composed from current phase, active floor, and fallback notice so the shell can expose one polite live region.

- [ ] **Step 4: Verify controller compilation**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics and no unreachable or non-exhaustive reducer branches.

- [ ] **Step 5: Commit the controller**

```bash
git add src/prototypes/visualLanguage/useVisualLanguagePrototype.ts
git commit -m "prototype: add visual language state controller"
```

---

### Task 3: Semantic SVG scene adapter

**Files:**
- Create: `src/prototypes/visualLanguage/VisualLanguageScene.tsx`
- Create: `src/prototypes/visualLanguage/SceneLabels.tsx`
- Create: `src/prototypes/visualLanguage/SceneDiagnostics.tsx`
- Create: `src/prototypes/visualLanguage/ConveyanceBadge.tsx`

**Interfaces:**
- `VisualLanguageScene` consumes `fixture`, `sourceKind`, `scenario`, `activeFloor`, `handoffPhase`, `locale`, `selectedId`, `diagnosticFilter`, `sourceMaterialInspection`, `reducedMotion`, and `onSelectObject(id)`.
- `SceneLabels` consumes already projected label anchors and enforces category priority.
- `SceneDiagnostics` consumes projected finding geometry, `selectedId`, and `onSelectFinding(id)` while retaining severity shape/pattern when selected.
- `ConveyanceBadge` consumes `category: "elevator" | "escalator" | "stairs" | "ramp"`, localized label, selected state, and screen position; it reuses `markerIconFor()` from `src/map/markerIcons.ts` where available.

- [ ] **Step 1: Implement one deterministic projection**

In `VisualLanguageScene.tsx`, define this projection for 3D modes:

```ts
interface ProjectedPoint { readonly x: number; readonly y: number }
const VIEW_WIDTH = 640;
const SCALE = 8.2;

function projectPoint(point: Point3, twoDimensional: boolean): ProjectedPoint {
  if (twoDimensional) {
    return { x: 110 + point.x * 12, y: 380 - point.y * 12 };
  }
  return {
    x: VIEW_WIDTH / 2 + (point.x - point.y) * SCALE,
    y: 92 + (point.x + point.y) * SCALE * 0.46 - point.z * SCALE,
  };
}
```

Use these exact helpers for geometry emission and painter ordering:

```ts
const polygonPoints = (points: readonly ProjectedPoint[]): string =>
  points.map(({ x, y }) => `${x},${y}`).join(" ");

function boxFaces(
  primitive: BoxPrimitive,
  twoDimensional: boolean,
): readonly (readonly ProjectedPoint[])[] {
  const { origin: o, size: s } = primitive;
  const c000 = projectPoint(o, twoDimensional);
  const c100 = projectPoint({ x: o.x + s.x, y: o.y, z: o.z }, twoDimensional);
  const c010 = projectPoint({ x: o.x, y: o.y + s.y, z: o.z }, twoDimensional);
  const c110 = projectPoint(
    { x: o.x + s.x, y: o.y + s.y, z: o.z },
    twoDimensional,
  );
  const c001 = projectPoint({ x: o.x, y: o.y, z: o.z + s.z }, twoDimensional);
  const c101 = projectPoint(
    { x: o.x + s.x, y: o.y, z: o.z + s.z },
    twoDimensional,
  );
  const c011 = projectPoint(
    { x: o.x, y: o.y + s.y, z: o.z + s.z },
    twoDimensional,
  );
  const c111 = projectPoint(
    { x: o.x + s.x, y: o.y + s.y, z: o.z + s.z },
    twoDimensional,
  );
  if (twoDimensional || s.z === 0) {
    return [[c000, c100, c110, c010]];
  }
  return [
    [c001, c101, c111, c011],
    [c010, c110, c111, c011],
    [c100, c110, c111, c101],
  ];
}

function primitiveFaces(
  primitive: ScenePrimitive,
  twoDimensional: boolean,
): readonly (readonly ProjectedPoint[])[] {
  return primitive.kind === "surface"
    ? [primitive.ring.map((point) => projectPoint(point, twoDimensional))]
    : boxFaces(primitive, twoDimensional);
}

function primitiveDepth(primitive: ScenePrimitive): number {
  if (primitive.kind === "box") {
    return (
      primitive.origin.x +
      primitive.origin.y +
      primitive.origin.z +
      primitive.size.x / 2 +
      primitive.size.y / 2
    );
  }
  const total = primitive.ring.reduce(
    (sum, point) => sum + point.x + point.y + point.z,
    0,
  );
  return total / primitive.ring.length;
}

const visiblePrimitives = [...source.primitives]
  .filter((primitive) => isPrimitiveVisible(primitive, props))
  .sort((left, right) => primitiveDepth(left) - primitiveDepth(right));
```

Render every returned face as a `<polygon points={polygonPoints(face)}>` with
the primitive's semantic role and state classes. Use the same helper for all
three source kinds.

- [ ] **Step 2: Map semantic roles to classes without source branches**

Use `roleClass(role)` to return `vl-role-${role}`. Use `visibilityClass(primitive, props)` to add only semantic state classes:

- omit `ceiling` on the active floor;
- omit non-active floors in guidance/selection/diagnostics;
- show the destination floor with `vl-inactive-route-floor` during `show-destination-floor` and route overview;
- show the destination floor as active after `switch-floor`;
- add `vl-occluder-faded` only to `protectedCorridor` objects in selection, handoff, or guidance with a protected target;
- add `vl-context` only from `occlusion === "context"`;
- add `vl-source-material` only when producer diagnostics and source-material inspection are both active.

Do not inspect `sourceKind` inside role or state styling. `sourceKind` selects fixture geometry and projection mode only.

- [ ] **Step 3: Render route casing and phase states**

For every visible route segment, render two identical polylines: a white `.vl-route-casing` and an indigo `.vl-route-core`. Add `.is-current`, `.is-future`, `.is-completed`, or `.is-connector`; connector uses a stable dash pattern. Render sparse white chevrons as separate static paths on the current segment. Render origin as white centre/indigo ring and destination as indigo centre/white ring.

During normal guidance, show B1 current and hide 1F. During destination-floor context, show B1 current plus connector and 1F future at the approved opacity. After floor switch, classify B1 as completed and 1F as current. Route overview shows every leg without mutating `activeFloor`.

Derive progress independently from connector line style:

```ts
type RouteProgress = "current" | "future" | "completed";

function routeProgress(
  segment: RouteSegmentFixture,
  phase: HandoffPhaseId,
): RouteProgress {
  const destinationIsActive = phase === "switch-floor" || phase === "settle-1f";
  if (segment.id === "route-b1") {
    return destinationIsActive ? "completed" : "current";
  }
  if (segment.id === "route-1f") {
    return destinationIsActive ? "current" : "future";
  }
  if (phase === "walk-b1") {
    return "future";
  }
  return destinationIsActive ? "completed" : "current";
}
```

The connector always carries `.is-connector` in addition to its progress class.

- [ ] **Step 4: Implement labels and conveyance badges**

`SceneLabels.tsx` must sort by this fixed priority:

```ts
const LABEL_PRIORITY = {
  nextAction: 0,
  destination: 1,
  selection: 2,
  conveyance: 3,
  exit: 4,
  landmark: 5,
} as const;
```

Render at most four labels in normal navigation and at most six in overview/diagnostics. Use an SVG group with a white rounded backplate or `paint-order: stroke` white halo, never rotated with model faces. The selected/next conveyance label always survives collision trimming. Render a bounded leader line when the label is displaced more than `18` projected pixels from its anchor.

Use deterministic offsets for the fixed fixture:

```ts
const LABEL_OFFSETS: Readonly<Record<string, readonly [number, number]>> = {
  "next-action": [0, -30],
  destination: [18, -24],
  "selected-escalator": [-12, -38],
  "yaesu-exit": [16, -16],
  "marunouchi-landmark": [-12, -18],
};
```

Sort by `LABEL_PRIORITY`, keep the scenario limit, project the anchor, then add
the corresponding offset. Draw a leader when
`Math.hypot(offsetX, offsetY) > 18`.

`ConveyanceBadge.tsx` calls `markerIconFor(category)` and places the returned sanitized SVG in a screen-facing `foreignObject`. When `category === "ramp"` and no JIS asset exists, render a neutral inclined-plane outline with one static slope chevron rather than inventing machinery detail. Give the wrapper `role="img"` and the localized accessible label. The selected badge receives the same Indigo Mist and Ai Indigo treatment as canonical selection; its category silhouette remains visible without color.

- [ ] **Step 5: Implement diagnostic point, segment, and area cues**

`SceneDiagnostics.tsx` maps:

- Defect: red diamond plus solid segment/area outline;
- Review: amber triangle plus dashed outline;
- Advisory: stone circle plus dotted outline;
- Accepted exception: stone outlined check badge plus muted pattern;
- Selected finding: original severity cue plus an outer Ai Indigo halo.

Default filter renders Defect and Review. `all` additionally renders Advisory and accepted exception. Add a `<title>` with localized severity and summary to every marker. Not evaluated appears only in the diagnostics panel copy, never as a scene pass/fail marker.

- [ ] **Step 6: Compose accessible scene markup**

`VisualLanguageScene` returns a labelled `<figure>` containing:

- localized scene-source badge and provenance line;
- `<svg viewBox="0 0 640 430" role="img">` with a localized `<title>`;
- source-separated geometry, route, diagnostics, conveyance, and labels in that order;
- a caption naming active floor, source kind, scenario, and selected object.

Pointer selection wraps each canonical primitive in a group with
`data-object-id`, a localized `<title>`, and
`onClick={() => onSelectObject(primitive.id)}`. Diagnostic geometry calls
`onSelectFinding(finding.id)`. Keep the SVG exposed as one labelled image;
keyboard equivalence comes from synchronized HTML object/finding buttons in
Task 4 rather than unreliable focus traversal inside SVG.

Apply `data-source`, `data-scenario`, `data-floor`, and `data-reduced-motion` attributes for browser inspection. A veil state covers the canvas with `scene.canvas` and never overlaps old/new source geometry.

- [ ] **Step 7: Verify adapter compilation**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics; source fixture selection is the only source-kind branch in the scene adapter.

- [ ] **Step 8: Commit the scene adapter**

```bash
git add src/prototypes/visualLanguage/VisualLanguageScene.tsx src/prototypes/visualLanguage/SceneLabels.tsx src/prototypes/visualLanguage/SceneDiagnostics.tsx src/prototypes/visualLanguage/ConveyanceBadge.tsx
git commit -m "prototype: render semantic architectural cutaway scenes"
```

---

### Task 4: Prototype shell, controls, and isolated entry

**Files:**
- Create: `src/prototypes/visualLanguage/VisualLanguageToolbar.tsx`
- Create: `src/prototypes/visualLanguage/VisualLanguagePrototype.tsx`
- Modify: `src/main.tsx:1-20`

**Interfaces:**
- `VisualLanguageToolbar` consumes `state`, `actions`, and localized `COPY`; it contains scenario, source, locale, reduced-motion, handoff, fallback, and diagnostics controls.
- `VisualLanguagePrototype` owns `useVisualLanguagePrototype()`, source viewport composition, scene captions, live region, compact state inspector, and fallback notice.
- `main.tsx` mounts the prototype only when query parameter `prototype` equals `visual-language`.

- [ ] **Step 1: Build the toolbar with native controls**

Use `<button>`, `<fieldset>`, `<legend>`, and pressed/selected state instead of custom div controls. Scenario buttons appear in this fixed order: Guidance, Selection, Floor handoff, Route overview, Diagnostics, Fallback. Source controls expose Compare sources, Detailed 3D, Generated 3D, and 2D map; 2D selects single layout.

When scenario is Handoff, show Play/Pause and Restart. When scenario is Diagnostics, show default/all finding filter and source-material inspection toggle. When scenario is Fallback, show Simulate detailed 3D failure while Detailed is active and Retry detailed 3D after Generated fallback is active. Locale and reduced-motion controls remain available in every scenario.

Define the control descriptors once and render them with mapped native buttons:

```ts
const SCENARIOS = [
  ["guidance", "guidance"],
  ["selection", "selection"],
  ["handoff", "handoff"],
  ["overview", "overview"],
  ["diagnostics", "diagnostics"],
  ["fallback", "fallback"],
] as const satisfies readonly (readonly [ScenarioId, keyof typeof COPY])[];

const SOURCES = [
  ["compare", "compare"],
  ["detailed", "detailed"],
  ["generated", "generated"],
  ["twoDimensional", "twoDimensional"],
] as const;

const selectSource = (id: (typeof SOURCES)[number][0]): void => {
  if (id === "compare") {
    actions.setSourceLayout("compare");
    return;
  }
  actions.setSourceKind(id);
};

const showHandoffControls = state.scenario === "handoff";
const showDiagnosticControls = state.scenario === "diagnostics";
const showFallbackControls = state.scenario === "fallback";
const fallbackAction =
  state.sourceKind === "generated"
    ? actions.retryDetailed
    : actions.simulateDetailedFailure;
const fallbackLabel =
  state.sourceKind === "generated" ? COPY.retryDetailed : COPY.simulateFailure;
```

Every mapped button uses `type="button"`, `aria-pressed`, localized visible
text, and the corresponding action. The diagnostics source-material control is
a native checkbox labelled with `COPY.sourceMaterial`.

- [ ] **Step 2: Compose source-separated viewports**

`VisualLanguagePrototype.tsx` uses this source selection rule:

```ts
const visibleSources: readonly SceneSourceKind[] =
  state.sourceLayout === "compare"
    ? ["detailed", "generated"]
    : [state.sourceKind];
```

Map each source to its own `VisualLanguageScene`. Never pass primitives from one source into another viewport. In Compare mode, synchronize scenario, active floor, handoff phase, route, selection, diagnostics, locale, and reduced-motion state between the two scenes.

Add a neutral fidelity explanation below Compare mode:

- English: `Same semantic style. Different source geometry and provenance.`
- Japanese: `同じセマンティックスタイルで、ソース形状と来歴のみが異なります。`

- [ ] **Step 3: Add navigation card, fallback notice, and state inspector**

Render a compact Guided transition card over the scene with localized next action, current/destination floor, destination, and remaining distance. It must not duplicate the full route-storytelling prototype; it exists only to establish label and route hierarchy.

Fallback notice uses `role="status"` and contains the localized notice plus Retry detailed 3D. Add one visually hidden `aria-live="polite"` region containing `liveMessage`.

Add a collapsible prototype inspector with IBM Plex Mono values for `sourceLayout`, `sourceKind`, `scenario`, `handoffPhase`, `activeFloor`, `playback`, `fallbackPhase`, `selectedId`, `diagnosticFilter`, `locale`, and `reducedMotion`. Inspector strings still have localized field labels.

In Selection, render a synchronized HTML list with these IDs and copy keys:

```ts
const SELECTABLE_OBJECTS = [
  ["escalator-b1-1f", "selectedEscalator"],
  ["elevator-b1-1f", "elevator"],
  ["stairs-b1-1f", "stairs"],
  ["ramp-b1", "ramp"],
  ["opening-b1-west", "opening"],
] as const satisfies readonly (readonly [string, keyof typeof COPY])[];
```

Each list button calls `actions.selectObject(id)`, uses `aria-pressed` from
`state.selectedId === id`, and carries the same visible focus treatment as
scene selection. In Diagnostics, render buttons from
`VISUAL_LANGUAGE_FIXTURE.diagnostics` with localized summary and severity;
each calls `actions.selectObject(finding.id)`. These lists are the keyboard and
screen-reader equivalent of pointer selection in the SVG.

- [ ] **Step 4: Wire the isolated query-param entry**

Modify `src/main.tsx` to import the prototype and route before production viewer/gallery selection:

```tsx
import { VisualLanguagePrototype } from "./prototypes/visualLanguage/VisualLanguagePrototype";

const prototype = new URLSearchParams(window.location.search).get("prototype");
const app =
  prototype === "visual-language" ? (
    <VisualLanguagePrototype />
  ) : showViewer ? (
    <App />
  ) : (
    <GalleryPage />
  );

createRoot(root).render(<StrictMode>{app}</StrictMode>);
```

Keep existing font and production stylesheet imports. `VisualLanguagePrototype.tsx` imports its own scoped CSS added in Task 5.

- [ ] **Step 5: Verify shell compilation**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics and existing non-prototype URL behavior remains represented by the unchanged `showViewer` expression.

- [ ] **Step 6: Commit the shell and route**

```bash
git add src/main.tsx src/prototypes/visualLanguage/VisualLanguageToolbar.tsx src/prototypes/visualLanguage/VisualLanguagePrototype.tsx
git commit -m "prototype: add visual language comparison shell"
```

---

### Task 5: Kiriko styling, responsive behavior, and motion parity

**Files:**
- Create: `src/prototypes/visualLanguage/visualLanguagePrototype.css`
- Modify: `src/prototypes/visualLanguage/VisualLanguagePrototype.tsx`
- Modify: `src/prototypes/visualLanguage/VisualLanguageToolbar.tsx`

**Interfaces:**
- Every selector is scoped below `.visual-language-prototype`.
- Scene semantic classes are stable: `.vl-role-*`, `.vl-route-*`, `.vl-occluder-faded`, `.vl-context`, `.vl-inactive-route-floor`, `.vl-source-material`, and `.vl-diagnostic-*`.
- Responsive targets: desktop compare at `1440×900`, compact compare at `1180×720`, and stacked/single-source mobile at `390×844`.

- [ ] **Step 1: Load the UI craft rules before styling**

Read `skill://impeccable`, `DESIGN.md`, and `PRODUCT.md`. Enforce Kiriko's One Indigo Rule, Hairline Rule, Mono Data Rule, Float Rule, bilingual typography, and 44 pixel mobile target contract. Do not introduce gradients, glassmorphism, a third shadow, generic dashboard cards, or toolbar forests.

- [ ] **Step 2: Define scoped semantic tokens**

Start the CSS file with:

```css
.visual-language-prototype {
  --vl-canvas: #ededeb;
  --vl-panel: #ffffff;
  --vl-ink: #1c1917;
  --vl-muted: #78716c;
  --vl-hairline: #e7e5e4;
  --vl-indigo: #4f46e5;
  --vl-indigo-soft: #eef2ff;
  --vl-walkable: #fafaf9;
  --vl-public: #e9edf4;
  --vl-service: #f0ebe0;
  --vl-structure: #d5dae3;
  --vl-edge: #c8ceda;
  --vl-opening: #9aa3b2;
  --vl-defect: #dc2626;
  --vl-review: #d97706;
  --vl-advisory: #78716c;
  min-height: 100dvh;
  overflow: hidden;
  background: var(--vl-canvas);
  color: var(--vl-ink);
  font-family: "Inter Variable", "Noto Sans JP Variable", sans-serif;
}
```

Use one flat 64 pixel context bar, one compact 320 pixel control panel on desktop, and the existing floating shadow `0 4px 24px rgba(0, 0, 0, 0.08)`. Panels inside the control panel remain flat with hairline separation.

- [ ] **Step 3: Style semantic scene roles and depth**

Map classes exactly:

```css
.vl-role-walkable { fill: var(--vl-walkable); }
.vl-role-public { fill: var(--vl-public); }
.vl-role-service { fill: var(--vl-service); }
.vl-role-restricted,
.vl-role-structure,
.vl-role-elevator,
.vl-role-escalator,
.vl-role-stairs,
.vl-role-ramp { fill: var(--vl-structure); }
.vl-role-opening { fill: none; stroke: var(--vl-opening); }
.vl-semantic-face { stroke: var(--vl-edge); stroke-width: 1; vector-effect: non-scaling-stroke; }
.vl-context { opacity: 0.24; }
.vl-inactive-route-floor { opacity: 0.28; }
.vl-occluder-faded { opacity: 0.15; }
.vl-selected { fill: var(--vl-indigo-soft); stroke: var(--vl-indigo); stroke-width: 2.5; }
.vl-pickable:hover .vl-semantic-face { stroke: var(--vl-indigo); stroke-width: 1.5; }
.vl-object-button[aria-pressed="true"] { color: var(--vl-indigo); background: var(--vl-indigo-soft); }
.vl-object-button:focus-visible {
  outline: 2px solid #ffffff;
  box-shadow: 0 0 0 4px var(--vl-indigo);
}
```

Use a single SVG drop-shadow filter with darkness no greater than 12%. Do not add per-triangle or black silhouette edges. Give Detailed and Generated viewports identical canvas, lighting/filter, role CSS, and camera transform.

- [ ] **Step 4: Style route, labels, diagnostics, and provenance inspection**

Route casing/core use non-scaling strokes. Desktop core is 4 pixels and mobile core is 5; casing is 8 and 9. Current/future/completed opacity is `1`, `.6`, and `.32`. Connector uses `stroke-dasharray: 7 5` but no dash animation. Labels use 13/18 medium text with white halo/backplate; priority is controlled in React, not z-index guessing.

Diagnostic classes combine color and pattern:

- `.vl-diagnostic-defect`: solid red;
- `.vl-diagnostic-review`: amber with `7 5` dash;
- `.vl-diagnostic-advisory`: stone with `2 5` dot pattern;
- `.vl-diagnostic-accepted`: stone outline plus check glyph;
- `.vl-diagnostic-selected`: an outer 3 pixel indigo halo that does not replace the severity stroke.

Source-material inspection may use a restrained neutral hatch and source-property caption inside diagnostics only. It must never alter route, selection, label, or diagnostic colors.

- [ ] **Step 5: Style desktop, compact, and mobile layouts**

At widths above `1240px`, show 320 pixel controls plus two equal source viewports. At `900–1239px`, keep the 320 pixel controls and stack the two comparison scenes vertically within the remaining canvas. Below `900px`, turn controls into a raised bottom sheet and stack comparison viewports in a vertically scrollable `.vl-scenes` region. At `390×844`, each comparison viewport remains at least 280 pixels high; single-source modes fill the available scene region, while Compare keeps both sources separately labelled and reachable by vertical scrolling.

Ensure no horizontal overflow, every mobile control is at least 44 pixels high, the next-action card does not overlap bottom controls, and the source badge remains visible in every viewport.

- [ ] **Step 6: Implement normal and reduced-motion rules**

Normal motion may use only `140–180 ms` opacity/transform transitions for occluder fade, source veil, and state emphasis. Guided camera phase uses CSS custom properties keyed by `data-handoff-phase`; do not continuously rotate or orbit.

Add these exact class and system-preference rules:

```css
.visual-language-prototype.is-reduced-motion *,
.visual-language-prototype.is-reduced-motion *::before,
.visual-language-prototype.is-reduced-motion *::after {
  transition-duration: 0.001ms !important;
  animation-duration: 0.001ms !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
}

@media (prefers-reduced-motion: reduce) {
  .visual-language-prototype *,
  .visual-language-prototype *::before,
  .visual-language-prototype *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 7: Verify static structure once the prototype is complete**

Run: `pnpm exec tsc --noEmit`

Expected: zero diagnostics.

Run: `pnpm exec vite build`

Expected: Vite production build completes without rebuilding or changing Rust/WASM artifacts.

- [ ] **Step 8: Commit responsive styling**

```bash
git add src/prototypes/visualLanguage
git commit -m "prototype: finish architectural cutaway styling"
```

---

### Task 6: Browser proof, evidence assets, and issue resolution

**Files:**
- Create: `docs/superpowers/prototypes/2026-08-03-3d-visual-language-source-parity.webp`
- Create: `docs/superpowers/prototypes/2026-08-03-3d-visual-language-route-handoff.webp`
- Create: `docs/superpowers/prototypes/2026-08-03-3d-visual-language-diagnostics.webp`
- Create: `docs/superpowers/prototypes/2026-08-03-3d-visual-language-mobile.webp`
- Modify only if browser evidence exposes a real defect: files under `src/prototypes/visualLanguage/`

**Interfaces:**
- Prototype URL: `http://127.0.0.1:5173/?prototype=visual-language`.
- Evidence images correspond to source parity, floor handoff, diagnostics, and mobile/reduced-motion states.
- The issue resolution records the approved visual language and prototype evidence without promoting prototype code to production.

- [ ] **Step 1: Start the prototype and smoke the route**

Start Vite through the harness process manager:

```bash
pnpm exec vite --host 127.0.0.1
```

Open `/?prototype=visual-language` in Chromium. Confirm the production gallery still opens at `/` and forced viewer routing still follows current behavior for non-prototype query parameters.

- [ ] **Step 2: Exercise source parity and fidelity disclosure**

At `1440×900`, keep Compare sources active and Guidance selected. Verify:

- Detailed and Generated scenes have intentionally different primitive detail but identical role colors, lighting, route casing, labels, selected conveyance, floor state, and camera;
- each viewport has the correct localized source badge and provenance;
- neither source appears tinted as preferred/inferior;
- active-floor ceilings are absent;
- source-material inspection is unavailable outside Diagnostics;
- keyboard tab order reaches source/scenario controls and scene-linked selection controls with visible focus.

Capture `2026-08-03-3d-visual-language-source-parity.webp`.

- [ ] **Step 3: Exercise handoff, overview, selection, and fallback**

Play the complete B1 to 1F handoff. Verify phase order, active floor, current/future/completed route opacity, dashed connector, conveyance emphasis, destination-floor context, and final settled state. Pause and restart once. Switch to Route overview and confirm all route floors appear without changing active floor.

Switch to Selection and verify the escalator keeps its neutral category silhouette plus Indigo Mist/outline and screen-facing label. Switch to Fallback, simulate Detailed failure, confirm no frame mixes Detailed and Generated geometry, the neutral veil lasts only in normal motion, badge/provenance update to Generated, route/floor/selection remain stable, the bilingual notice appears, and Retry detailed 3D restores Detailed.

Capture the floor-context phase as `2026-08-03-3d-visual-language-route-handoff.webp`.

- [ ] **Step 4: Exercise diagnostic and source-material states**

At `1180×720`, select Diagnostics. Verify default filter shows Defect and Review only. Enable all to show Advisory and accepted exception. Select each finding from the panel and scene; severity shape/pattern remains while the Indigo outer selection halo appears. Confirm Not evaluated appears only in panel text. Enable source-material inspection and confirm neutral provenance hatch does not recolor route, selection, labels, or diagnostics.

Capture `2026-08-03-3d-visual-language-diagnostics.webp`.

- [ ] **Step 5: Exercise Japanese, mobile, 2D, and reduced motion**

At `390×844`, switch to Japanese, select 2D map, and enable Reduced motion. Verify all visible copy changes locale, no horizontal overflow, controls meet 44 pixel targets, route/markers/diagnostic non-color cues match 3D, and source badge reads `2D マップ`.

Replay floor handoff and fallback. Confirm the same phase order and final state with discrete camera/opacity changes, no pulse, no dash motion, no source veil, and intact polite announcements. Capture `2026-08-03-3d-visual-language-mobile.webp`.

- [ ] **Step 6: Run one bounded visual finish pass**

Use Impeccable once against the prototype route and the four screenshots. Fix only Critical or Important visual/accessibility findings in one batch. Re-run `pnpm exec tsc --noEmit`, `pnpm exec vite build`, and the affected browser scenario once. Do not expand prototype scope or refactor production code.

- [ ] **Step 7: Commit verified evidence**

```bash
git add src/prototypes/visualLanguage docs/superpowers/prototypes/2026-08-03-3d-visual-language-source-parity.webp docs/superpowers/prototypes/2026-08-03-3d-visual-language-route-handoff.webp docs/superpowers/prototypes/2026-08-03-3d-visual-language-diagnostics.webp docs/superpowers/prototypes/2026-08-03-3d-visual-language-mobile.webp
git commit -m "prototype: verify renderer-neutral 3D visual language"
```

- [ ] **Step 8: Publish the disposable branch and resolve issue #32**

Push `prototype/renderer-neutral-3d-visual-language`. Add an issue comment with:

- decision: Architectural Cutaway;
- shared semantic materials and normal-navigation source override;
- quiet source badges and inspectable provenance;
- ceiling and protected-corridor occlusion rules;
- label and conveyance hierarchy;
- indigo-only interaction/route states;
- shape/pattern diagnostic states;
- reduced-motion and 2D parity;
- branch URL, prototype entry URL, and four evidence image URLs;
- verification commands and browser viewport/state matrix;
- explicit statement that prototype code is disposable and production implementation waits for renderer architecture issue #23 and capability/performance issue #26.

Close issue #32 only after the issue comment and evidence URLs resolve. Do not merge the prototype branch into `main`.
