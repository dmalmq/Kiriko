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

export interface ScenePoint {
  x: number;
  y: number;
  z: number;
}

export interface GraphNode {
  id: string;
  floorId: FloorId;
  point: ScenePoint;
  sourceAltitude: number | null;
  provenance: "source" | "manual";
}

export interface GraphControlPoint extends ScenePoint {
  id: string;
  provenance: "manual";
}

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

export type SnapBand = "auto" | "review" | "ambiguous" | "none";

export interface SnapPreview {
  candidateId: string;
  distanceM: number;
  band: SnapBand;
  sameFloor: boolean;
  point: ScenePoint;
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

const FIXTURE: StagedSnapshot = {
  nodes: [
    {
      id: "b1-entry",
      floorId: "B1",
      point: { x: 126, y: 406, z: 0 },
      sourceAltitude: -4.86,
      provenance: "source",
    },
    {
      id: "b1-stair",
      floorId: "B1",
      point: { x: 299.69, y: 300, z: 0 },
      sourceAltitude: -4.86,
      provenance: "source",
    },
    {
      id: "f1-stair",
      floorId: "1F",
      point: { x: 300, y: 300, z: 4.86 },
      sourceAltitude: 0,
      provenance: "source",
    },
    {
      id: "f1-exit",
      floorId: "1F",
      point: { x: 516, y: 186, z: 4.86 },
      sourceAltitude: 0,
      provenance: "source",
    },
    {
      id: "floor-drift-node",
      floorId: "B1",
      point: { x: 416, y: 328, z: 0 },
      sourceAltitude: 4.02,
      provenance: "source",
    },
  ],
  edges: [
    {
      id: "edge-b1-entry-stair",
      fromNodeId: "b1-entry",
      toNodeId: "b1-stair",
      kind: "same-floor",
      associationId: null,
      controlPoints: [],
    },
    {
      id: "edge-f1-stair-exit",
      fromNodeId: "f1-stair",
      toNodeId: "f1-exit",
      kind: "same-floor",
      associationId: null,
      controlPoints: [],
    },
    {
      id: "connector-8842",
      fromNodeId: "b1-stair",
      toNodeId: "f1-stair",
      kind: "connector",
      associationId: "stair-main",
      controlPoints: [
        { id: "connector-8842-landing", x: 316, y: 286, z: 2.43, provenance: "manual" },
      ],
    },
    {
      id: "edge-b1-drift",
      fromNodeId: "b1-entry",
      toNodeId: "floor-drift-node",
      kind: "same-floor",
      associationId: null,
      controlPoints: [],
    },
  ],
  findings: [
    {
      id: "endpoint-off-stair",
      severity: "defect",
      state: "open",
      objectId: "b1-stair",
      measuredM: 0.31,
      toleranceM: 0.5,
      exceptionReason: null,
    },
    {
      id: "floor-drift",
      severity: "review",
      state: "open",
      objectId: "floor-drift-node",
      measuredM: 0.84,
      toleranceM: 0.5,
      exceptionReason: null,
    },
    {
      id: "unassociated-lift",
      severity: "advisory",
      state: "not-evaluated",
      objectId: "lift-east",
      measuredM: null,
      toleranceM: null,
      exceptionReason: null,
    },
  ],
  profile: { autoSnapM: 0.5, reviewSnapM: 3, overrideReason: null },
  stagedChanges: [],
};

export function createGraphEditingPrototypeState(): GraphEditorPrototypeState {
  const baseline = structuredClone(FIXTURE);
  return {
    ...baseline,
    baseline,
    past: [],
    future: [],
    tool: "select",
    activeFloor: "B1",
    selection: null,
    selectedFindingId: null,
    pending: null,
    notice: null,
    findingDelta: null,
    scenario: "repair-endpoint",
    checkState: "idle",
    saveState: "idle",
    locale: "ja",
    reducedMotion: false,
    cameraPreset: "perspective",
  };
}
