import { useId } from "react";
import { ConveyanceBadge, type ConveyanceCategory } from "./ConveyanceBadge";
import {
  SceneDiagnostics,
  type ProjectedDiagnosticFinding,
} from "./SceneDiagnostics";
import { SceneLabels, type ProjectedSceneLabel } from "./SceneLabels";
import type { DiagnosticFilter } from "./useVisualLanguagePrototype";
import {
  COPY,
  type BoxPrimitive,
  type FloorId,
  type HandoffPhaseId,
  type Point3,
  type PrototypeLocale,
  type RouteSegmentFixture,
  type ScenarioId,
  type ScenePrimitive,
  type SceneSourceKind,
  type SemanticRole,
  type VisualLanguageFixture,
} from "./visualLanguage";

export interface VisualLanguageSceneProps {
  readonly fixture: VisualLanguageFixture;
  readonly sourceKind: SceneSourceKind;
  readonly scenario: ScenarioId;
  readonly activeFloor: FloorId;
  readonly handoffPhase: HandoffPhaseId;
  readonly locale: PrototypeLocale;
  readonly selectedId: string | null;
  readonly diagnosticFilter: DiagnosticFilter;
  readonly sourceMaterialInspection: boolean;
  readonly reducedMotion: boolean;
  readonly onSelectObject: (id: string) => void;
}

export interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
}

interface SceneVisibilityState {
  readonly scenario: ScenarioId;
  readonly activeFloor: FloorId;
  readonly handoffPhase: HandoffPhaseId;
  readonly selectedId: string | null;
  readonly sourceMaterialInspection: boolean;
}

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 430;
const SCALE = 8.2;

const ROLE_COPY: Readonly<Record<SemanticRole, { readonly en: string; readonly ja: string }>> = {
  walkable: { en: "Walkable floor", ja: "歩行可能な床" },
  public: { en: "Public area", ja: "公共エリア" },
  service: { en: "Service area", ja: "サービスエリア" },
  restricted: { en: "Restricted area", ja: "制限エリア" },
  structure: { en: "Structure", ja: "構造物" },
  context: { en: "Context geometry", ja: "周辺形状" },
  ceiling: { en: "Ceiling", ja: "天井" },
  opening: COPY.opening,
  elevator: COPY.elevator,
  escalator: COPY.selectedEscalator,
  stairs: COPY.stairs,
  ramp: COPY.ramp,
};

const EMPTY_SELECTION = { en: "None", ja: "なし" } as const;

function projectPoint(point: Point3, twoDimensional: boolean): ProjectedPoint {
  if (twoDimensional) {
    return { x: 110 + point.x * 12, y: 380 - point.y * 12 };
  }
  return {
    x: VIEW_WIDTH / 2 + (point.x - point.y) * SCALE,
    y: 92 + (point.x + point.y) * SCALE * 0.46 - point.z * SCALE,
  };
}

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

const roleClass = (role: SemanticRole): string => `vl-role-${role}`;

function showsDestinationContext(scenario: ScenarioId, phase: HandoffPhaseId): boolean {
  return (
    scenario === "overview" ||
    (scenario === "handoff" &&
      (phase === "show-destination-floor" ||
        phase === "switch-floor" ||
        phase === "settle-1f"))
  );
}

function isFloorVisible(
  floor: FloorId,
  { scenario, activeFloor, handoffPhase }: SceneVisibilityState,
): boolean {
  return floor === activeFloor || showsDestinationContext(scenario, handoffPhase);
}

function isPrimitiveVisible(
  primitive: ScenePrimitive,
  state: SceneVisibilityState,
): boolean {
  if (primitive.role === "ceiling" && primitive.floor === state.activeFloor) {
    return false;
  }
  return isFloorVisible(primitive.floor, state);
}

function visibilityClass(
  primitive: ScenePrimitive,
  state: SceneVisibilityState,
): string {
  const hasProtectedTarget =
    state.scenario === "guidance" ||
    state.scenario === "handoff" ||
    (state.scenario === "selection" && state.selectedId !== null);
  return [
    primitive.floor !== state.activeFloor &&
    showsDestinationContext(state.scenario, state.handoffPhase)
      ? "vl-inactive-route-floor"
      : "",
    primitive.occlusion === "protectedCorridor" && hasProtectedTarget
      ? "vl-occluder-faded"
      : "",
    primitive.occlusion === "context" ? "vl-context" : "",
    state.scenario === "diagnostics" && state.sourceMaterialInspection
      ? "vl-source-material"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

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

function isRouteSegmentVisible(
  segment: RouteSegmentFixture,
  state: SceneVisibilityState,
): boolean {
  if (state.scenario === "overview") {
    return true;
  }
  if (segment.floor === "connector") {
    return showsDestinationContext(state.scenario, state.handoffPhase);
  }
  return isFloorVisible(segment.floor, state);
}

function chevronPath(start: ProjectedPoint, end: ProjectedPoint): string {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) {
    return "";
  }
  const unitX = deltaX / length;
  const unitY = deltaY / length;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const backX = midX - unitX * 6;
  const backY = midY - unitY * 6;
  const normalX = -unitY * 4;
  const normalY = unitX * 4;
  return `M ${backX + normalX} ${backY + normalY} L ${midX} ${midY} L ${backX - normalX} ${backY - normalY}`;
}

function primitiveAnchor(primitive: ScenePrimitive): Point3 {
  if (primitive.kind === "box") {
    return {
      x: primitive.origin.x + primitive.size.x / 2,
      y: primitive.origin.y + primitive.size.y / 2,
      z: primitive.origin.z + primitive.size.z,
    };
  }
  const total = primitive.ring.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, z: sum.z + point.z }),
    { x: 0, y: 0, z: 0 },
  );
  const count = Math.max(primitive.ring.length, 1);
  return { x: total.x / count, y: total.y / count, z: total.z / count };
}

function sceneObjectLabel(primitive: ScenePrimitive, locale: PrototypeLocale): string {
  return `${ROLE_COPY[primitive.role][locale]} · ${primitive.floor}`;
}

export function VisualLanguageScene(props: VisualLanguageSceneProps) {
  const {
    fixture,
    sourceKind,
    scenario,
    activeFloor,
    handoffPhase,
    locale,
    selectedId,
    diagnosticFilter,
    sourceMaterialInspection,
    reducedMotion,
    onSelectObject,
  } = props;
  const source = fixture.sources[sourceKind];
  const twoDimensional = source.kind === "twoDimensional";
  const visibilityState: SceneVisibilityState = {
    scenario,
    activeFloor,
    handoffPhase,
    selectedId,
    sourceMaterialInspection,
  };
  const visiblePrimitives = [...source.primitives]
    .filter((primitive) => isPrimitiveVisible(primitive, visibilityState))
    .sort((left, right) => primitiveDepth(left) - primitiveDepth(right));
  const visibleRoute = fixture.route.filter((segment) =>
    isRouteSegmentVisible(segment, visibilityState),
  );
  const projectedLabels: readonly ProjectedSceneLabel[] = fixture.labels
    .filter((label) => isFloorVisible(label.floor, visibilityState))
    .filter(
      (label) =>
        label.id !== "selected-escalator" ||
        scenario !== "selection" ||
        selectedId === "escalator-b1-1f",
    )
    .map((label) => ({
      id: label.id,
      category: label.category,
      label: label.text[locale],
      anchor: projectPoint(label.anchor, twoDimensional),
      protected:
        label.id === "selected-escalator" &&
        (selectedId === "escalator-b1-1f" ||
          scenario === "guidance" ||
          scenario === "handoff" ||
          scenario === "fallback"),
      selected:
        label.id === "selected-escalator" && selectedId === "escalator-b1-1f",
    }));
  const projectedFindings: readonly ProjectedDiagnosticFinding[] = fixture.diagnostics
    .filter((finding) => isFloorVisible(finding.floor, visibilityState))
    .map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      geometry: finding.geometry,
      points: finding.points.map((point) => projectPoint(point, twoDimensional)),
      severityLabel: COPY[finding.severity][locale],
      summary: finding.summary[locale],
    }));
  const conveyances = visiblePrimitives.filter(
    (primitive): primitive is ScenePrimitive & { readonly role: ConveyanceCategory } =>
      primitive.role === "elevator" ||
      primitive.role === "escalator" ||
      primitive.role === "stairs" ||
      primitive.role === "ramp",
  );
  const selectedPrimitive = source.primitives.find(
    (primitive) => primitive.id === selectedId || primitive.canonicalId === selectedId,
  );
  const selectedFinding = fixture.diagnostics.find(({ id }) => id === selectedId);
  const selectedLabel =
    selectedPrimitive !== undefined
      ? sceneObjectLabel(selectedPrimitive, locale)
      : selectedFinding?.summary[locale] ?? (selectedId ?? EMPTY_SELECTION[locale]);
  const routeOrigin = visibleRoute.find(({ id }) => id === "route-b1")?.points[0];
  const destinationSegment = visibleRoute.find(({ id }) => id === "route-1f");
  const routeDestination = destinationSegment?.points[destinationSegment.points.length - 1];
  const sourceInfoId = useId();
  const svgTitleId = useId();
  const captionId = useId();
  const svgTitle = `${COPY.title[locale]} — ${source.badge[locale]}`;
  const caption =
    locale === "ja"
      ? `${COPY.activeFloor.ja}: ${activeFloor} · ${COPY.sceneSource.ja}: ${source.badge.ja} · ${COPY.scenario.ja}: ${COPY[scenario].ja} · 選択: ${selectedLabel}`
      : `${COPY.activeFloor.en}: ${activeFloor} · ${COPY.sceneSource.en}: ${source.badge.en} · ${COPY.scenario.en}: ${COPY[scenario].en} · Selected: ${selectedLabel}`;

  return (
    <figure
      className="vl-scene"
      aria-labelledby={`${sourceInfoId} ${captionId}`}
      data-source={sourceKind}
      data-scenario={scenario}
      data-floor={activeFloor}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <div className="vl-scene__source" id={sourceInfoId}>
        <span className="vl-scene__source-label">{COPY.sceneSource[locale]}</span>
        <span className="vl-scene__source-badge">{source.badge[locale]}</span>
        <span className="vl-scene__provenance">{source.provenance[locale]}</span>
      </div>
      <svg
        className="vl-scene__canvas"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-labelledby={svgTitleId}
      >
        <title id={svgTitleId}>{svgTitle}</title>
        <rect className="vl-scene__canvas-field" width={VIEW_WIDTH} height={VIEW_HEIGHT} />
        <g className="vl-scene__geometry" data-source={sourceKind}>
          {visiblePrimitives.map((primitive) => {
            const selected =
              primitive.id === selectedId || primitive.canonicalId === selectedId;
            const semanticClasses = [
              "vl-semantic-face",
              roleClass(primitive.role),
              visibilityClass(primitive, visibilityState),
              selected ? "vl-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const canonical = primitive.canonicalId !== null;

            return (
              <g
                key={primitive.id}
                className={canonical ? "vl-scene-object vl-pickable" : "vl-scene-object"}
                data-object-id={canonical ? primitive.id : undefined}
                data-canonical-id={primitive.canonicalId ?? undefined}
                onClick={
                  canonical
                    ? () => {
                        onSelectObject(primitive.id);
                      }
                    : undefined
                }
              >
                {canonical ? <title>{sceneObjectLabel(primitive, locale)}</title> : null}
                {primitiveFaces(primitive, twoDimensional).map((face, faceIndex) => (
                  <polygon
                    key={`${primitive.id}-face-${faceIndex}`}
                    className={semanticClasses}
                    points={polygonPoints(face)}
                  />
                ))}
              </g>
            );
          })}
        </g>
        <g className="vl-scene__route">
          {visibleRoute.map((segment) => {
            const progress = routeProgress(segment, handoffPhase);
            const connector = segment.floor === "connector";
            const stateClasses = `is-${progress}${connector ? " is-connector" : ""}`;
            const points = polygonPoints(
              segment.points.map((point) => projectPoint(point, twoDimensional)),
            );
            return (
              <g key={segment.id} className="vl-route-segment" data-route-id={segment.id}>
                <polyline
                  className={`vl-route-casing ${stateClasses}`}
                  points={points}
                  strokeDasharray={connector ? "8 6" : undefined}
                />
                <polyline
                  className={`vl-route-core ${stateClasses}`}
                  points={points}
                  strokeDasharray={connector ? "8 6" : undefined}
                />
                {progress === "current" && !connector
                  ? segment.points.slice(0, -1).map((point, index) => {
                      const nextPoint = segment.points[index + 1]!;
                      return (
                        <path
                          key={`${segment.id}-chevron-${index}`}
                          className="vl-route-chevron"
                          d={chevronPath(
                            projectPoint(point, twoDimensional),
                            projectPoint(nextPoint, twoDimensional),
                          )}
                          aria-hidden="true"
                        />
                      );
                    })
                  : null}
              </g>
            );
          })}
          {routeOrigin !== undefined ? (
            <g className="vl-route-origin" aria-hidden="true">
              <circle
                className="vl-route-origin__ring"
                cx={projectPoint(routeOrigin, twoDimensional).x}
                cy={projectPoint(routeOrigin, twoDimensional).y}
                r={7}
              />
              <circle
                className="vl-route-origin__centre"
                cx={projectPoint(routeOrigin, twoDimensional).x}
                cy={projectPoint(routeOrigin, twoDimensional).y}
                r={3}
              />
            </g>
          ) : null}
          {routeDestination !== undefined ? (
            <g className="vl-route-destination" aria-hidden="true">
              <circle
                className="vl-route-destination__ring"
                cx={projectPoint(routeDestination, twoDimensional).x}
                cy={projectPoint(routeDestination, twoDimensional).y}
                r={7}
              />
              <circle
                className="vl-route-destination__centre"
                cx={projectPoint(routeDestination, twoDimensional).x}
                cy={projectPoint(routeDestination, twoDimensional).y}
                r={3}
              />
            </g>
          ) : null}
        </g>
        {scenario === "diagnostics" ? (
          <SceneDiagnostics
            findings={projectedFindings}
            filter={diagnosticFilter}
            selectedId={selectedId}
            onSelectFinding={onSelectObject}
          />
        ) : (
          <g className="vl-scene-diagnostics" />
        )}
        <g className="vl-scene__conveyances">
          {conveyances.map((primitive) => (
            <ConveyanceBadge
              key={`${primitive.id}-badge`}
              category={primitive.role}
              label={sceneObjectLabel(primitive, locale)}
              selected={
                primitive.id === selectedId || primitive.canonicalId === selectedId
              }
              screenPosition={projectPoint(primitiveAnchor(primitive), twoDimensional)}
            />
          ))}
        </g>
        <SceneLabels labels={projectedLabels} scenario={scenario} />
      </svg>
      <figcaption className="vl-scene__caption" id={captionId}>
        {caption}
      </figcaption>
    </figure>
  );
}
