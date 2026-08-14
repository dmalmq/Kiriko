/**
 * Label layout for the 3D scene (#32, label and conveyance hierarchy).
 *
 * A pitched 3D view is a hostile place for labels: anchors bunch up as the
 * camera flattens, and the 2D viewer's answer — place every marker, up to two
 * hundred of them — becomes an unreadable pile. So the scene labels are capped
 * (four in navigation, six in overview), ordered by what the reviewer is doing,
 * and displaced deterministically when they collide, with a leader line once a
 * label has moved far enough that its anchor is no longer obvious.
 *
 * Determinism is a requirement rather than a nicety: the same camera must
 * produce the same layout, or a visual test can only ever assert that
 * *something* was drawn.
 *
 * This module is pure. Projection and DOM live with the overlay that calls it.
 */
import type { ConveyanceDirection } from "./conveyanceDirection";

/**
 * Priority tiers, highest first. `nextAction` and `destination` belong to guided
 * navigation (Stage 5) and are declared here so that arriving does not reorder
 * everything below them.
 */
export const LABEL_TIERS = [
  "nextAction",
  "destination",
  "selection",
  "conveyance",
  "exit",
  "landmark",
] as const;

export type LabelTier = (typeof LABEL_TIERS)[number];

const TIER_ORDER: Record<LabelTier, number> = {
  nextAction: 0,
  destination: 1,
  selection: 2,
  conveyance: 3,
  exit: 4,
  landmark: 5,
};

/** How many labels each mode may show at once (#32). */
export const LABEL_CAPS = { navigation: 4, overview: 6 } as const;

export type LabelMode = keyof typeof LABEL_CAPS;

/**
 * Displacement beyond this many pixels earns a leader line — measured from the
 * label's *resting* place, not from its anchor. A pill sits above the point it
 * names by design, so measuring from the anchor would draw a leader on every
 * label and tell the reviewer nothing.
 */
export const LEADER_THRESHOLD_PX = 18;

/** Gap kept between a label box and its anchor point. */
const ANCHOR_GAP_PX = 10;

/** Margin from the viewport edge; labels never touch the frame. */
const EDGE_MARGIN_PX = 4;

/**
 * The displacement ladder, in label-height steps. Deterministic and ordered so
 * a crowded cluster resolves the same way every frame: straight up first (the
 * least surprising place for a label), then the diagonals, then sideways, then
 * below.
 */
const LADDER: readonly (readonly [number, number])[] = [
  [0, -1],
  [0.5, -1.4],
  [-0.5, -1.4],
  [1, -0.8],
  [-1, -0.8],
  [0, -2],
  [1.2, -2],
  [-1.2, -2],
  [1.6, 0],
  [-1.6, 0],
  [0, 1.2],
  [1, 1.6],
  [-1, 1.6],
  [0, 2.4],
  // Far rungs, for a label whose anchor sits under a panel or the floor
  // selector: the leader keeps the association readable at this distance, and
  // the alternative is dropping a label the reviewer asked for.
  [2.5, -1],
  [-2.5, -1],
  [2.5, 1],
  [-2.5, 1],
  [0, -3.4],
  [0, 3.4],
  [3.5, 0],
  [-3.5, 0],
];

export interface LabelCandidate {
  id: string;
  tier: LabelTier;
  text: string;
  /** Screen position of the anchor, or `null` when the camera cannot see it. */
  screen: { x: number; y: number } | null;
  size: { width: number; height: number };
  /**
   * Survives the cap. The selected object and the conveyance a reviewer is
   * about to take are the subject of the view, not decoration.
   */
  protected: boolean;
  /** Inline SVG for a badge label, when this candidate is a conveyance. */
  icon?: string;
  /**
   * Graph-evidenced direction for a conveyance badge: the arrow plus the
   * target floor token, present only when a vertical network path matched
   * this feature's footprint. Absent otherwise — never a placeholder.
   */
  direction?: ConveyanceDirection;
}

export interface PlacedLabel {
  id: string;
  tier: LabelTier;
  text: string;
  icon?: string;
  /** Carried through from the candidate so the overlay can render the chevron. */
  direction?: ConveyanceDirection;
  anchor: { x: number; y: number };
  box: { x: number; y: number; width: number; height: number };
  /** Anchor-to-box line, present only when displacement earned one. */
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
}

export interface LayoutOptions {
  viewport: { width: number; height: number };
  mode: LabelMode;
  /**
   * Regions the viewer's own chrome already occupies — floor selector, panels,
   * the source badge. Labels treat them as taken space, because a label the
   * reviewer cannot read because a panel covers it is not a placed label.
   */
  reserved?: readonly { x: number; y: number; width: number; height: number }[];
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Clamp a box inside the viewport, keeping the edge margin. */
function clampToViewport(box: Box, viewport: { width: number; height: number }): Box {
  const maxX = Math.max(EDGE_MARGIN_PX, viewport.width - box.width - EDGE_MARGIN_PX);
  const maxY = Math.max(EDGE_MARGIN_PX, viewport.height - box.height - EDGE_MARGIN_PX);
  return {
    ...box,
    x: Math.min(Math.max(box.x, EDGE_MARGIN_PX), maxX),
    y: Math.min(Math.max(box.y, EDGE_MARGIN_PX), maxY),
  };
}

/**
 * Lay out labels for one frame: order by tier, keep what the cap allows plus
 * everything protected, then place each one clear of the labels already placed.
 * A label that cannot find clear space is dropped — overlapping text is worse
 * than one fewer label.
 */
export function layoutSceneLabels(
  candidates: readonly LabelCandidate[],
  options: LayoutOptions,
): PlacedLabel[] {
  const visible = candidates.filter(
    (candidate): candidate is LabelCandidate & { screen: { x: number; y: number } } =>
      candidate.screen !== null,
  );

  const ordered = [...visible].sort((left, right) => {
    const byTier = TIER_ORDER[left.tier] - TIER_ORDER[right.tier];
    if (byTier !== 0) {
      return byTier;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const cap = LABEL_CAPS[options.mode];
  const selected: (LabelCandidate & { screen: { x: number; y: number } })[] = [];
  for (const candidate of ordered) {
    if (selected.length < cap) {
      selected.push(candidate);
      continue;
    }
    if (!candidate.protected) {
      continue;
    }
    // A protected label displaces the lowest-priority unprotected one rather
    // than growing the cap.
    const victim = [...selected]
      .reverse()
      .find((existing) => !existing.protected);
    if (victim === undefined) {
      continue;
    }
    selected.splice(selected.indexOf(victim), 1);
    selected.push(candidate);
  }
  selected.sort((left, right) => {
    const byTier = TIER_ORDER[left.tier] - TIER_ORDER[right.tier];
    return byTier !== 0 ? byTier : left.id < right.id ? -1 : 1;
  });

  const placed: PlacedLabel[] = [];
  const taken: Box[] = [...(options.reserved ?? [])];

  for (const candidate of selected) {
    const anchor = candidate.screen;
    const { width, height } = candidate.size;

    let chosen: Box | null = null;
    let rest: Box | null = null;
    for (const [dx, dy] of LADDER) {
      const raw: Box = {
        x: anchor.x - width / 2 + dx * width * 0.5,
        y: anchor.y - height / 2 + dy * (height + ANCHOR_GAP_PX),
        width,
        height,
      };
      const box = clampToViewport(raw, options.viewport);
      rest ??= box;
      if (!taken.some((existing) => overlaps(existing, box))) {
        chosen = box;
        break;
      }
    }
    if (chosen === null || rest === null) {
      // No clear space on the ladder: this label is not drawn this frame.
      continue;
    }

    const centre = { x: chosen.x + width / 2, y: chosen.y + height / 2 };
    const moved = Math.hypot(chosen.x - rest.x, chosen.y - rest.y);
    placed.push({
      id: candidate.id,
      tier: candidate.tier,
      text: candidate.text,
      ...(candidate.icon === undefined ? {} : { icon: candidate.icon }),
      ...(candidate.direction === undefined ? {} : { direction: candidate.direction }),
      anchor,
      box: chosen,
      leader:
        moved > LEADER_THRESHOLD_PX
          ? { x1: anchor.x, y1: anchor.y, x2: centre.x, y2: centre.y }
          : null,
    });
    taken.push(chosen);
  }

  return placed;
}
