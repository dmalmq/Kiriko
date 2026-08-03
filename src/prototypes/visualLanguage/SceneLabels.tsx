import type { ScenarioId, SceneLabelFixture } from "./visualLanguage";

export interface ProjectedLabelAnchor {
  readonly x: number;
  readonly y: number;
}

export interface ProjectedSceneLabel {
  readonly id: string;
  readonly category: SceneLabelFixture["category"];
  readonly label: string;
  readonly anchor: ProjectedLabelAnchor;
  readonly protected: boolean;
  readonly selected: boolean;
}

export interface SceneLabelsProps {
  readonly labels: readonly ProjectedSceneLabel[];
  readonly scenario: ScenarioId;
}

const LABEL_PRIORITY = {
  nextAction: 0,
  destination: 1,
  selection: 2,
  conveyance: 3,
  exit: 4,
  landmark: 5,
} as const;

const LABEL_OFFSETS: Readonly<Record<string, readonly [number, number]>> = {
  "next-action": [0, -30],
  destination: [18, -24],
  "selected-escalator": [-12, -38],
  "yaesu-exit": [16, -16],
  "marunouchi-landmark": [-12, -18],
};

function prioritizedLabels(
  labels: readonly ProjectedSceneLabel[],
  limit: number,
): readonly ProjectedSceneLabel[] {
  const sorted = [...labels].sort((left, right) => {
    const categoryOrder = LABEL_PRIORITY[left.category] - LABEL_PRIORITY[right.category];
    if (categoryOrder !== 0) {
      return categoryOrder;
    }
    if (left.protected !== right.protected) {
      return left.protected ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const retained = sorted.slice(0, limit);

  for (const protectedLabel of sorted) {
    if (!protectedLabel.protected || retained.some(({ id }) => id === protectedLabel.id)) {
      continue;
    }
    for (let index = retained.length - 1; index >= 0; index -= 1) {
      if (!retained[index]!.protected) {
        retained[index] = protectedLabel;
        break;
      }
    }
  }

  return retained.sort((left, right) => {
    const categoryOrder = LABEL_PRIORITY[left.category] - LABEL_PRIORITY[right.category];
    if (categoryOrder !== 0) {
      return categoryOrder;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function SceneLabels({ labels, scenario }: SceneLabelsProps) {
  const limit = scenario === "overview" || scenario === "diagnostics" ? 6 : 4;
  const visibleLabels = prioritizedLabels(labels, limit);

  return (
    <g className="vl-scene-labels">
      {visibleLabels.map((label) => {
        const [offsetX, offsetY] = LABEL_OFFSETS[label.id] ?? [0, -20];
        const x = label.anchor.x + offsetX;
        const y = label.anchor.y + offsetY;
        const distance = Math.hypot(offsetX, offsetY);
        const leaderInset = Math.min(8, distance);
        const leaderScale = distance === 0 ? 0 : leaderInset / distance;
        const leaderX = x - offsetX * leaderScale;
        const leaderY = y - offsetY * leaderScale;
        const className = [
          "vl-scene-label",
          `vl-label-${label.category}`,
          label.protected ? "is-protected" : "",
          label.selected ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <g
            key={label.id}
            className={className}
            data-label-id={label.id}
            transform={`translate(${x} ${y})`}
          >
            {distance > 18 ? (
              <line
                className="vl-scene-label__leader"
                x1={label.anchor.x - x}
                y1={label.anchor.y - y}
                x2={leaderX - x}
                y2={leaderY - y}
                aria-hidden="true"
              />
            ) : null}
            <text className="vl-scene-label__text" textAnchor="middle">
              {label.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
