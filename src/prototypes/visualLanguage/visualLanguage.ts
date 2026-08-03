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

export interface LocalizedText {
  readonly en: string;
  readonly ja: string;
}

export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

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
  readonly category:
    | "nextAction"
    | "destination"
    | "selection"
    | "conveyance"
    | "exit"
    | "landmark";
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
