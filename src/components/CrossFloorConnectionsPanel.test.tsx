import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NetworkConnectionId, NetworkFeature, ParsedNetwork } from "../map/networkFeatures";
import { CrossFloorConnectionsPanel } from "./CrossFloorConnectionsPanel";

function junction(nodeId: number, ordinal: number): NetworkFeature {
  return {
    ordinal,
    geometry: { type: "Point", coordinates: [139 + nodeId * 0.001, 35] },
    properties: { NODEID: nodeId },
  };
}

function path(options: {
  pathId: number;
  reversePathId: number;
  from: number;
  to: number;
  fromFloor: string;
  toFloor: string;
  category?: string;
}): NetworkFeature {
  const { pathId, reversePathId, from, to, fromFloor, toFloor, category } = options;
  return {
    ordinal: null,
    geometry: { type: "LineString", coordinates: [[139, 35], [139.001, 35]] },
    properties: {
      PATHID: pathId,
      RPATHID: reversePathId,
      FNODEID: from,
      TNODEID: to,
      FFLOOR: fromFloor,
      TFOOLR: toFloor,
      HFLAG: 1,
      ...(category === undefined ? {} : { TRANSITION_CATEGORY: category }),
    },
  };
}

/** F1 ↔ F2 elevator and an unnamed F1 ↔ B1 connection, both touching floor 0. */
const CROSS_FLOOR_NET: ParsedNetwork = {
  junctions: [junction(1, 0), junction(2, 1), junction(3, -1)],
  paths: [
    path({
      pathId: 4,
      reversePathId: 5,
      from: 1,
      to: 2,
      fromFloor: "F1",
      toFloor: "F2",
      category: "elevator",
    }),
    path({ pathId: 7, reversePathId: 8, from: 1, to: 3, fromFloor: "F1", toFloor: "B1" }),
  ],
};

/** One unnamed cross-floor connection only. */
const UNNAMED_ONLY: ParsedNetwork = {
  junctions: [junction(1, 0), junction(3, -1)],
  paths: [
    path({ pathId: 7, reversePathId: 8, from: 1, to: 3, fromFloor: "F1", toFloor: "B1" }),
  ],
};

/** A category the panel has no label for: the raw graph string must surface. */
const UNKNOWN_KIND: ParsedNetwork = {
  junctions: [junction(1, 0), junction(2, 1)],
  paths: [
    path({
      pathId: 9,
      reversePathId: 14,
      from: 1,
      to: 2,
      fromFloor: "F1",
      toFloor: "F2",
      category: "tunnel",
    }),
  ],
};

/** Cross-floor links exist, but none on the active floor (ordinal 0). */
const OTHER_FLOORS_ONLY: ParsedNetwork = {
  junctions: [junction(2, 1), junction(3, -1)],
  paths: [
    path({
      pathId: 10,
      reversePathId: 11,
      from: 3,
      to: 2,
      fromFloor: "B1",
      toFloor: "F2",
      category: "stairs",
    }),
  ],
};

/** A graph whose paths never leave their floor: zero cross-floor links. */
const SAME_FLOOR_ONLY: ParsedNetwork = {
  junctions: [junction(1, 0), junction(4, 0)],
  paths: [
    {
      ordinal: null,
      geometry: { type: "LineString", coordinates: [[139, 35], [139.001, 35]] },
      properties: {
        PATHID: 12,
        RPATHID: 13,
        FNODEID: 1,
        TNODEID: 4,
        FFLOOR: "F1",
        TFOOLR: "F1",
        HFLAG: 0,
      },
    },
  ],
};

const ELEVATOR_ID: NetworkConnectionId = { pathId: 4, reversePathId: 5 };
const UNNAMED_ID: NetworkConnectionId = { pathId: 7, reversePathId: 8 };

function renderPanel(
  props: Partial<
    React.ComponentProps<typeof CrossFloorConnectionsPanel>
  > = {},
) {
  return render(
    <CrossFloorConnectionsPanel
      network={CROSS_FLOOR_NET}
      activeOrdinal={0}
      selected={null}
      locale="en"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("CrossFloorConnectionsPanel", () => {
  it("lists the active floor's links with the graph-stated transport, direction, and target floor", () => {
    renderPanel();
    // Elevator row reaches F2: the same `↑ F2` token vocabulary the map
    // markers use (verticalLinkLabels.ts).
    expect(screen.getByRole("button", { name: /Elevator/ })).toBeTruthy();
    expect(screen.getByText("↑ F2")).toBeTruthy();
    expect(screen.getByText("↓ B1")).toBeTruthy();
  });

  it("never guesses a kind for an unnamed connection", () => {
    renderPanel({ network: UNNAMED_ONLY });
    expect(screen.getByText("Unnamed connection")).toBeTruthy();
    expect(screen.queryByText(/Stairs|Escalator|Elevator/)).toBeNull();
  });

  it("shows the raw graph category when it has no label", () => {
    renderPanel({ network: UNKNOWN_KIND });
    expect(screen.getByText("tunnel")).toBeTruthy();
  });

  it("marks the selected row and leaves the others unmarked", () => {
    renderPanel({ selected: ELEVATOR_ID });
    expect(
      screen.getByRole("button", { name: /Elevator/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /Unnamed connection/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("reports a row click with the connection id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPanel({ onSelect });
    await user.click(screen.getByRole("button", { name: /Elevator/ }));
    expect(onSelect).toHaveBeenCalledWith(ELEVATOR_ID);
    await user.click(screen.getByRole("button", { name: /Unnamed connection/ }));
    expect(onSelect).toHaveBeenCalledWith(UNNAMED_ID);
  });

  it("deselects when the selected row is clicked again", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPanel({ selected: ELEVATOR_ID, onSelect });
    await user.click(screen.getByRole("button", { name: /Elevator/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("distinguishes a missing network from one with zero cross-floor links", () => {
    renderPanel({ network: null });
    expect(screen.getByText("No network loaded")).toBeTruthy();
    renderPanel({ network: SAME_FLOOR_ONLY });
    expect(screen.getByText("The graph links no floors")).toBeTruthy();
  });

  it("says in words when the graph links floors but not the active one", () => {
    renderPanel({ network: OTHER_FLOORS_ONLY });
    expect(screen.getByText("No connections on this floor")).toBeTruthy();
  });

  it("localizes rows, empty states, and the title", () => {
    renderPanel({ network: UNNAMED_ONLY, locale: "ja" });
    expect(screen.getByText("接続フロア")).toBeTruthy();
    expect(screen.getByText("名称なしの接続")).toBeTruthy();
    renderPanel({ network: SAME_FLOOR_ONLY, locale: "ja" });
    expect(screen.getByText("グラフに階をまたぐ接続はありません")).toBeTruthy();
    renderPanel({ network: null, locale: "ja" });
    expect(screen.getByText("ネットワーク未読み込み")).toBeTruthy();
  });

  it("uses the same direction token for the unnamed connection's target floor", () => {
    renderPanel({ network: UNNAMED_ONLY });
    expect(screen.getByText("↓ B1")).toBeTruthy();
  });
});
