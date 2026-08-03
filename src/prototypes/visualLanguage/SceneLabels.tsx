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

interface LabelBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface PlacedSceneLabel extends ProjectedSceneLabel {
  readonly x: number;
  readonly y: number;
  readonly displacement: number;
}

const LABEL_HEIGHT = 18;
const LABEL_PADDING = 12;
const LABEL_GUTTER = 2;
const WIDE_GLYPH = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;
const DISPLACEMENT_STEPS = [0, -20, 20, -40, 40, -60, 60];

function labelBox(x: number, y: number, text: string): LabelBox {
  const width =
    [...text].reduce((sum, glyph) => sum + (WIDE_GLYPH.test(glyph) ? 13 : 6.6), 0) +
    LABEL_PADDING;
  return {
    left: x - width / 2,
    right: x + width / 2,
    top: y - LABEL_HEIGHT + 5,
    bottom: y + 5,
  };
}

function overlaps(left: LabelBox, right: LabelBox): boolean {
  return (
    left.left < right.right + LABEL_GUTTER &&
    right.left < left.right + LABEL_GUTTER &&
    left.top < right.bottom + LABEL_GUTTER &&
    right.top < left.bottom + LABEL_GUTTER
  );
}

/**
 * Places labels in priority order, displacing lower-priority labels vertically
 * until they clear already-placed boxes. Protected labels always survive; an
 * unplaceable unprotected label is trimmed instead of drawn over its neighbour.
 */
function placeLabels(labels: readonly ProjectedSceneLabel[]): readonly PlacedSceneLabel[] {
  const placed: PlacedSceneLabel[] = [];
  const boxes: LabelBox[] = [];

  for (const label of labels) {
    const [offsetX, offsetY] = LABEL_OFFSETS[label.id] ?? [0, -20];
    const x = label.anchor.x + offsetX;
    const baseY = label.anchor.y + offsetY;
    const step = DISPLACEMENT_STEPS.find(
      (candidate) =>
        !boxes.some((box) => overlaps(box, labelBox(x, baseY + candidate, label.label))),
    );

    if (step === undefined && !label.protected) {
      continue;
    }

    const y = baseY + (step ?? 0);
    boxes.push(labelBox(x, y, label.label));
    placed.push({
      ...label,
      x,
      y,
      displacement: Math.hypot(x - label.anchor.x, y - label.anchor.y),
    });
  }

  return placed;
}

export function SceneLabels({ labels, scenario }: SceneLabelsProps) {
  const limit = scenario === "overview" || scenario === "diagnostics" ? 6 : 4;
  const visibleLabels = placeLabels(prioritizedLabels(labels, limit));

  return (
    <g className="vl-scene-labels">
      {visibleLabels.map((label) => {
        const { x, y, displacement } = label;
        const leaderInset = Math.min(8, displacement);
        const leaderScale = displacement === 0 ? 0 : leaderInset / displacement;
        const leaderX = (label.anchor.x - x) * leaderScale;
        const leaderY = (label.anchor.y - y) * leaderScale;
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
            {displacement > 18 ? (
              <line
                className="vl-scene-label__leader"
                x1={label.anchor.x - x}
                y1={label.anchor.y - y}
                x2={leaderX}
                y2={leaderY}
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
