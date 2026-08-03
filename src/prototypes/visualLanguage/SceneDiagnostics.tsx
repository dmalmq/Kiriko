import { useId, type ReactElement } from "react";
import type { DiagnosticFilter } from "./useVisualLanguagePrototype";
import type { DiagnosticFixture, DiagnosticSeverity } from "./visualLanguage";

export interface ProjectedDiagnosticPoint {
  readonly x: number;
  readonly y: number;
}

export interface ProjectedDiagnosticFinding {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly geometry: DiagnosticFixture["geometry"];
  readonly points: readonly ProjectedDiagnosticPoint[];
  readonly severityLabel: string;
  readonly summary: string;
}

export interface SceneDiagnosticsProps {
  readonly findings: readonly ProjectedDiagnosticFinding[];
  readonly filter: DiagnosticFilter;
  readonly selectedId: string | null;
  readonly onSelectFinding: (id: string) => void;
}

const outlineClassFor = (severity: DiagnosticSeverity): string => {
  switch (severity) {
    case "defect":
      return "is-solid";
    case "review":
      return "is-dashed";
    case "advisory":
      return "is-dotted";
    case "accepted":
      return "is-muted-pattern";
  }
};

function SeverityMarker({
  severity,
  position,
}: {
  readonly severity: DiagnosticSeverity;
  readonly position: ProjectedDiagnosticPoint;
}): ReactElement {
  const { x, y } = position;
  switch (severity) {
    case "defect":
      return (
        <polygon
          className="vl-diagnostic-marker vl-diagnostic-marker--diamond"
          points={`${x},${y - 6} ${x + 6},${y} ${x},${y + 6} ${x - 6},${y}`}
        />
      );
    case "review":
      return (
        <polygon
          className="vl-diagnostic-marker vl-diagnostic-marker--triangle"
          points={`${x},${y - 7} ${x + 7},${y + 6} ${x - 7},${y + 6}`}
        />
      );
    case "advisory":
      return <circle className="vl-diagnostic-marker vl-diagnostic-marker--circle" cx={x} cy={y} r={6} />;
    case "accepted":
      return (
        <g className="vl-diagnostic-marker vl-diagnostic-marker--accepted">
          <circle cx={x} cy={y} r={7} />
          <path d={`M ${x - 3.5} ${y} L ${x - 0.5} ${y + 3} L ${x + 4.5} ${y - 3}`} />
        </g>
      );
  }
}


export function SceneDiagnostics({
  findings,
  filter,
  selectedId,
  onSelectFinding,
}: SceneDiagnosticsProps) {
  const patternId = `vl-accepted-pattern-${useId().replaceAll(":", "")}`;
  const visibleFindings = findings.filter(
    ({ severity }) =>
      severity === "defect" || severity === "review" || filter === "all",
  );

  return (
    <g className="vl-scene-diagnostics">
      <defs>
        <pattern id={patternId} width={8} height={8} patternUnits="userSpaceOnUse">
          <path className="vl-diagnostic-pattern" d="M -2 8 L 8 -2 M 2 10 L 10 2" />
        </pattern>
      </defs>
      {visibleFindings.map((finding) => {
        const markerPosition = finding.points.reduce(
          (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
          { x: 0, y: 0 },
        );
        const pointCount = Math.max(finding.points.length, 1);
        const marker = {
          x: markerPosition.x / pointCount,
          y: markerPosition.y / pointCount,
        };
        const points = finding.points.map(({ x, y }) => `${x},${y}`).join(" ");
        const selected = finding.id === selectedId;
        const outlineClass = `vl-diagnostic-outline ${outlineClassFor(finding.severity)}`;
        const className = [
          "vl-diagnostic",
          `vl-diagnostic-${finding.severity}`,
          selected ? "vl-diagnostic-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <g
            key={finding.id}
            className={className}
            data-finding-id={finding.id}
            onClick={() => {
              onSelectFinding(finding.id);
            }}
          >
            <title>{`${finding.severityLabel}: ${finding.summary}`}</title>
            {selected && finding.geometry === "point" ? (
              <circle className="vl-diagnostic-selection-halo" cx={marker.x} cy={marker.y} r={11} />
            ) : null}
            {selected && finding.geometry === "segment" ? (
              <polyline className="vl-diagnostic-selection-halo" points={points} />
            ) : null}
            {selected && finding.geometry === "area" ? (
              <polygon className="vl-diagnostic-selection-halo" points={points} />
            ) : null}
            {finding.geometry === "segment" ? (
              <polyline className={outlineClass} points={points} />
            ) : null}
            {finding.geometry === "area" ? (
              <polygon
                className={outlineClass}
                points={points}
                fill={finding.severity === "accepted" ? `url(#${patternId})` : undefined}
              />
            ) : null}
            <SeverityMarker severity={finding.severity} position={marker} />
          </g>
        );
      })}
    </g>
  );
}
