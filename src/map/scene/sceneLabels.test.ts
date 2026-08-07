import { describe, expect, it } from "vitest";
import {
  LABEL_CAPS,
  LEADER_THRESHOLD_PX,
  layoutSceneLabels,
  type LabelCandidate,
} from "./sceneLabels";

const VIEWPORT = { width: 1440, height: 900 };

function candidate(overrides: Partial<LabelCandidate> & { id: string }): LabelCandidate {
  return {
    tier: "landmark",
    text: overrides.id,
    screen: { x: 700, y: 400 },
    size: { width: 120, height: 24 },
    protected: false,
    ...overrides,
  };
}

/** Do two placed boxes overlap at all? */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("layoutSceneLabels", () => {
  it("keeps the priority order: selection, then conveyance, then exit, then landmark", () => {
    const placed = layoutSceneLabels(
      [
        candidate({ id: "landmark", tier: "landmark", screen: { x: 100, y: 100 } }),
        candidate({ id: "exit", tier: "exit", screen: { x: 300, y: 100 } }),
        candidate({ id: "conveyance", tier: "conveyance", screen: { x: 500, y: 100 } }),
        candidate({ id: "selection", tier: "selection", screen: { x: 700, y: 100 } }),
      ],
      { viewport: VIEWPORT, mode: "navigation" },
    );
    expect(placed.map((label) => label.id)).toEqual([
      "selection",
      "conveyance",
      "exit",
      "landmark",
    ]);
  });

  it("caps navigation at four and overview at six", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      candidate({ id: `l-${index}`, screen: { x: 80 + index * 100, y: 200 } }),
    );
    expect(layoutSceneLabels(many, { viewport: VIEWPORT, mode: "navigation" })).toHaveLength(
      LABEL_CAPS.navigation,
    );
    expect(layoutSceneLabels(many, { viewport: VIEWPORT, mode: "overview" })).toHaveLength(
      LABEL_CAPS.overview,
    );
    expect(LABEL_CAPS.navigation).toBe(4);
    expect(LABEL_CAPS.overview).toBe(6);
  });

  it("never drops a protected label to make room for the cap", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      candidate({ id: `l-${index}`, screen: { x: 80 + index * 100, y: 200 } }),
    );
    // The selected object, and the conveyance a reviewer is about to take, must
    // survive a crowded floor — the cap drops landmarks, never the subject.
    const withProtected = [
      ...many,
      candidate({
        id: "keep-me",
        tier: "conveyance",
        protected: true,
        screen: { x: 1200, y: 700 },
      }),
    ];
    const placed = layoutSceneLabels(withProtected, {
      viewport: VIEWPORT,
      mode: "navigation",
    });
    expect(placed.map((label) => label.id)).toContain("keep-me");
    expect(placed).toHaveLength(LABEL_CAPS.navigation);
  });

  it("displaces colliding labels instead of stacking them", () => {
    const stacked = [
      candidate({ id: "a", tier: "selection", screen: { x: 700, y: 400 } }),
      candidate({ id: "b", tier: "conveyance", screen: { x: 705, y: 404 } }),
      candidate({ id: "c", tier: "exit", screen: { x: 710, y: 408 } }),
    ];
    const placed = layoutSceneLabels(stacked, { viewport: VIEWPORT, mode: "navigation" });
    expect(placed).toHaveLength(3);
    for (let outer = 0; outer < placed.length; outer += 1) {
      for (let inner = outer + 1; inner < placed.length; inner += 1) {
        expect(
          overlaps(placed[outer]!.box, placed[inner]!.box),
          `${placed[outer]!.id} overlaps ${placed[inner]!.id}`,
        ).toBe(false);
      }
    }
  });

  it("is deterministic: the same input lays out identically", () => {
    const input = [
      candidate({ id: "a", tier: "conveyance", screen: { x: 700, y: 400 } }),
      candidate({ id: "b", tier: "conveyance", screen: { x: 702, y: 402 } }),
      candidate({ id: "c", tier: "landmark", screen: { x: 704, y: 404 } }),
    ];
    const first = layoutSceneLabels(input, { viewport: VIEWPORT, mode: "overview" });
    const second = layoutSceneLabels([...input], { viewport: VIEWPORT, mode: "overview" });
    expect(second).toEqual(first);
  });

  it("draws a leader only once a label has moved far enough to need one", () => {
    const placed = layoutSceneLabels(
      [
        candidate({ id: "anchored", tier: "selection", screen: { x: 700, y: 400 } }),
        candidate({ id: "nudged", tier: "conveyance", screen: { x: 700, y: 404 } }),
      ],
      { viewport: VIEWPORT, mode: "navigation" },
    );
    const anchored = placed.find((label) => label.id === "anchored")!;
    const nudged = placed.find((label) => label.id === "nudged")!;

    // The first label sits on its anchor, so it needs no leader.
    expect(anchored.leader).toBeNull();

    // The second was pushed clear of it. Displacement is measured from the
    // anchor to the box centre — the same quantity the leader would draw.
    const displaced = Math.hypot(
      nudged.box.x + nudged.box.width / 2 - nudged.anchor.x,
      nudged.box.y + nudged.box.height / 2 - nudged.anchor.y,
    );
    expect(displaced).toBeGreaterThan(LEADER_THRESHOLD_PX);
    expect(nudged.leader).toEqual({
      x1: nudged.anchor.x,
      y1: nudged.anchor.y,
      x2: nudged.box.x + nudged.box.width / 2,
      y2: nudged.box.y + nudged.box.height / 2,
    });
  });

  it("keeps every label inside the viewport, with no horizontal overflow", () => {
    const edges = [
      candidate({ id: "left", tier: "selection", screen: { x: 4, y: 400 } }),
      candidate({ id: "right", tier: "conveyance", screen: { x: 1436, y: 400 } }),
      candidate({ id: "top", tier: "exit", screen: { x: 700, y: 2 } }),
      candidate({ id: "bottom", tier: "landmark", screen: { x: 700, y: 898 } }),
    ];
    for (const label of layoutSceneLabels(edges, { viewport: VIEWPORT, mode: "navigation" })) {
      expect(label.box.x).toBeGreaterThanOrEqual(0);
      expect(label.box.y).toBeGreaterThanOrEqual(0);
      expect(label.box.x + label.box.width).toBeLessThanOrEqual(VIEWPORT.width);
      expect(label.box.y + label.box.height).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });

  it("fits a narrow phone viewport without overflowing it", () => {
    const phone = { width: 390, height: 844 };
    const crowded = Array.from({ length: 8 }, (_, index) =>
      candidate({
        id: `p-${index}`,
        tier: index === 0 ? "selection" : "conveyance",
        screen: { x: 180 + index * 6, y: 400 + index * 4 },
        size: { width: 160, height: 24 },
      }),
    );
    const placed = layoutSceneLabels(crowded, { viewport: phone, mode: "navigation" });
    for (const label of placed) {
      expect(label.box.x).toBeGreaterThanOrEqual(0);
      expect(label.box.x + label.box.width).toBeLessThanOrEqual(phone.width);
    }
    for (let outer = 0; outer < placed.length; outer += 1) {
      for (let inner = outer + 1; inner < placed.length; inner += 1) {
        expect(overlaps(placed[outer]!.box, placed[inner]!.box)).toBe(false);
      }
    }
  });

  it("drops a label it cannot place rather than overlapping one it already placed", () => {
    // A viewport with room for one box and a pile of candidates on the same
    // point: the ones that cannot find clear space are dropped, not stacked.
    const tiny = { width: 200, height: 60 };
    const pile = Array.from({ length: 6 }, (_, index) =>
      candidate({
        id: `t-${index}`,
        tier: index === 0 ? "selection" : "landmark",
        screen: { x: 100, y: 30 },
        size: { width: 120, height: 24 },
      }),
    );
    const placed = layoutSceneLabels(pile, { viewport: tiny, mode: "navigation" });
    expect(placed.length).toBeGreaterThan(0);
    expect(placed[0]!.id).toBe("t-0");
    for (let outer = 0; outer < placed.length; outer += 1) {
      for (let inner = outer + 1; inner < placed.length; inner += 1) {
        expect(overlaps(placed[outer]!.box, placed[inner]!.box)).toBe(false);
      }
    }
  });

  it("treats the viewer's own chrome as taken space", () => {
    // The floor selector sits on the right edge; a label anchored under it must
    // move rather than hide behind it.
    const reserved = [{ x: 1300, y: 340, width: 120, height: 220 }];
    const placed = layoutSceneLabels(
      [candidate({ id: "under-chrome", tier: "selection", screen: { x: 1360, y: 450 } })],
      { viewport: VIEWPORT, mode: "navigation", reserved },
    );
    expect(placed).toHaveLength(1);
    expect(overlaps(placed[0]!.box, reserved[0]!)).toBe(false);
  });

  it("ignores candidates the camera cannot see", () => {
    const placed = layoutSceneLabels(
      [
        candidate({ id: "visible", screen: { x: 700, y: 400 } }),
        candidate({ id: "behind", screen: null }),
      ],
      { viewport: VIEWPORT, mode: "overview" },
    );
    expect(placed.map((label) => label.id)).toEqual(["visible"]);
  });
});
