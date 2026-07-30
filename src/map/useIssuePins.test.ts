import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { LocaleCode, ViewerLevel } from "../imdf/types";
import type { IssueStatus, ReviewIssue } from "../issues/types";
import { MARKER_OVERLAY_CLASS } from "./useFeatureMarkers";
import {
  ISSUE_PIN_OVERLAY_CLASS,
  ISSUE_PIN_SELECTED_CLASS,
  projectPins,
  useIssuePins,
  type MapIssuePin,
  type UseIssuePinsArgs,
} from "./useIssuePins";

function issue(
  id: string,
  pinNumber: number,
  levelId: string,
  overrides: {
    status?: IssueStatus;
    deletedAt?: string | null;
    body?: string | null;
    longitude?: number;
    latitude?: number;
  } = {},
): ReviewIssue {
  const deletedAt = overrides.deletedAt ?? null;
  const fields = {
    id,
    pinNumber,
    rowVersion: 1,
    anchor: {
      levelId,
      longitude: overrides.longitude ?? 139.7,
      latitude: overrides.latitude ?? 35.6,
    },
    status: overrides.status ?? ("open" as IssueStatus),
    author: { id: 2, username: "member1" },
    assignee: null,
    dueDate: null,
    createdAt: "2026-07-18T10:00:00Z",
    updatedAt: "2026-07-18T10:00:00Z",
    replies: [],
  };
  if (deletedAt === null) {
    return { ...fields, bodyMarkdown: overrides.body ?? "Body", attachments: [], deletedAt: null };
  }
  return { ...fields, bodyMarkdown: null, attachments: [], deletedAt };
}

/** Minimal controllable MapLibre stand-in for the DOM overlay. */
class FakeMap {
  readonly container = document.createElement("div");
  readonly handlers = new Map<string, Set<(event?: unknown) => void>>();
  projectImpl: (lngLat: [number, number]) => { x: number; y: number } = ([lng, lat]) => ({
    x: lng,
    y: lat,
  });

  getContainer(): HTMLElement {
    return this.container;
  }

  project(lngLat: [number, number]): { x: number; y: number } {
    return this.projectImpl(lngLat);
  }

  on(type: string, fn: (event?: unknown) => void): void {
    let set = this.handlers.get(type);
    if (set == null) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
  }

  off(type: string, fn: (event?: unknown) => void): void {
    this.handlers.get(type)?.delete(fn);
  }

  emit(type: string, event?: unknown): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      fn(event);
    }
  }
}

const LEVELS: ViewerLevel[] = [
  { id: "1f", ordinal: 0, label: { en: "Level 1", ja: "1階" }, shortName: { en: "1F", ja: "1F" } },
  { id: "2f", ordinal: 1, label: { en: "Level 2", ja: "2階" }, shortName: { en: "2F", ja: "2F" } },
];

function pins(): MapIssuePin[] {
  return [
    { id: "i1", pinNumber: 1, levelId: "1f", longitude: 10, latitude: 20, summary: "Gate blocked", status: "open" },
    { id: "i4", pinNumber: 4, levelId: "1f", longitude: 30, latitude: 40, summary: "Sign", status: "in_review" },
    { id: "i9", pinNumber: 9, levelId: "2f", longitude: 50, latitude: 60, summary: "Other floor", status: "open" },
  ];
}

function mountPins(overrides: Partial<UseIssuePinsArgs> = {}): {
  map: FakeMap;
  onSelect: Mock;
  unmount: () => void;
} {
  const map = new FakeMap();
  const onSelect = (overrides.onSelect as Mock | undefined) ?? vi.fn();
  const args: UseIssuePinsArgs = {
    map: map as unknown as MapLibreMap,
    levelId: "1f",
    pins: pins(),
    selectedIssueId: null,
    locale: "en",
    levels: LEVELS,
    onSelect,
    ...overrides,
  };
  const { unmount } = renderHook(() => useIssuePins(args));
  return { map, onSelect, unmount };
}

describe("projectPins", () => {
  const issues = [
    issue("i1", 1, "1f", { status: "open" }),
    issue("i2", 2, "2f", { status: "open" }),
    issue("i3", 3, "1f", { status: "closed" }),
    issue("i4", 4, "1f", { status: "in_review" }),
    issue("i5", 5, "1f", { deletedAt: "2026-07-18T11:00:00Z" }),
  ];

  it("projects active roots on the current floor in pin-number order", () => {
    expect(projectPins(issues, ["1f"], "active").map((pin) => pin.pinNumber)).toEqual([1, 4]);
  });

  it("excludes closed and deleted roots by default", () => {
    const numbers = projectPins(issues, ["1f"], "active").map((pin) => pin.pinNumber);
    expect(numbers).not.toContain(3);
    expect(numbers).not.toContain(5);
  });

  it("shows closed and deleted roots under the closed filter", () => {
    expect(projectPins(issues, ["1f"], "closed").map((pin) => pin.pinNumber)).toEqual([3, 5]);
  });

  it("unions roots across every level id in the ordinal group", () => {
    expect(projectPins(issues, ["1f", "2f"], "active").map((pin) => pin.pinNumber)).toEqual([1, 2, 4]);
  });

  it("keeps deterministic pin order regardless of input order", () => {
    const shuffled = [issues[3]!, issues[0]!, issues[2]!];
    expect(projectPins(shuffled, ["1f"], "active").map((pin) => pin.pinNumber)).toEqual([1, 4]);
  });

  it("carries anchor coordinates, status, and summary onto the pin", () => {
    const [pin] = projectPins(
      [issue("i1", 1, "1f", { body: "Gate blocked", longitude: 1, latitude: 2 })],
      ["1f"],
      "active",
    );
    expect(pin).toMatchObject({
      id: "i1",
      pinNumber: 1,
      levelId: "1f",
      longitude: 1,
      latitude: 2,
      summary: "Gate blocked",
      status: "open",
    });
  });
});

describe("useIssuePins", () => {
  it("renders a distinct overlay independent of the Labels marker overlay", () => {
    const { map } = mountPins();
    expect(map.container.querySelector(`.${ISSUE_PIN_OVERLAY_CLASS}`)).toBeTruthy();
    expect(ISSUE_PIN_OVERLAY_CLASS).not.toBe(MARKER_OVERLAY_CLASS);
    expect(map.container.querySelector(`.${MARKER_OVERLAY_CLASS}`)).toBeNull();
  });

  it("renders only current-floor pins as buttons in pin-number order", () => {
    const { map } = mountPins();
    const buttons = [...map.container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["1", "4"]);
  });

  it("renders pins from sibling levels sharing the selected ordinal", () => {
    const levels: ViewerLevel[] = [
      { id: "1f", ordinal: 0, label: { en: "1F" }, shortName: { en: "1F" } },
      { id: "1f-b", ordinal: 0, label: { en: "1F" }, shortName: { en: "1F" } },
      { id: "2f", ordinal: 1, label: { en: "2F" }, shortName: { en: "2F" } },
    ];
    const merged: MapIssuePin[] = [
      { id: "i1", pinNumber: 1, levelId: "1f", longitude: 10, latitude: 20, summary: "A", status: "open" },
      { id: "i2", pinNumber: 2, levelId: "1f-b", longitude: 30, latitude: 40, summary: "B", status: "open" },
      { id: "i9", pinNumber: 9, levelId: "2f", longitude: 50, latitude: 60, summary: "C", status: "open" },
    ];
    const { map } = mountPins({ levels, pins: merged, levelId: "1f" });
    const buttons = [...map.container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["1", "2"]);
  });

  it("gives each pin an accessible name with number, summary, status, and floor", () => {
    const { map } = mountPins();
    const label = map.container.querySelector("button")!.getAttribute("aria-label") ?? "";
    expect(label).toContain("Issue #1");
    expect(label).toContain("Gate blocked");
    expect(label).toContain("Level 1");
  });

  it("localizes the floor context in the accessible name", () => {
    const { map } = mountPins({ locale: "ja" as LocaleCode });
    const label = map.container.querySelector("button")!.getAttribute("aria-label") ?? "";
    expect(label).toContain("1階");
    expect(label).toContain("課題 #1");
    expect(label).not.toContain("Issue #1");
  });

  it("falls back to the raw level id when the floor is unknown", () => {
    const orphan: MapIssuePin[] = [
      { id: "iX", pinNumber: 2, levelId: "b1", longitude: 1, latitude: 2, summary: "S", status: "open" },
    ];
    const { map } = mountPins({ levelId: "b1", pins: orphan, levels: [] });
    const label = map.container.querySelector("button")!.getAttribute("aria-label") ?? "";
    expect(label).toContain("b1");
  });

  it("marks the selected pin through ARIA state", () => {
    const { map } = mountPins({ selectedIssueId: "i4" });
    const buttons = [...map.container.querySelectorAll("button")];
    const selected = buttons.find((b) => b.textContent === "4")!;
    const other = buttons.find((b) => b.textContent === "1")!;
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.classList.contains(ISSUE_PIN_SELECTED_CLASS)).toBe(true);
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("selects on click and stops propagation to the map", () => {
    const background = vi.fn();
    const { map, onSelect } = mountPins();
    map.container.addEventListener("click", background);
    const first = map.container.querySelector("button")!;
    first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith("i1");
    expect(background).not.toHaveBeenCalled();
  });

  it("repositions pins on map move using integral translate", () => {
    const { map } = mountPins();
    const first = map.container.querySelector("button")!;
    expect(first.style.transform).toBe("translate(10px, 20px)");
    map.projectImpl = () => ({ x: 100, y: 200 });
    map.emit("move");
    expect(first.style.transform).toBe("translate(100px, 200px)");
  });

  it("removes the overlay and listeners on unmount", () => {
    const { map, unmount } = mountPins();
    expect(map.container.querySelector(`.${ISSUE_PIN_OVERLAY_CLASS}`)).toBeTruthy();
    unmount();
    expect(map.container.querySelector(`.${ISSUE_PIN_OVERLAY_CLASS}`)).toBeNull();
    expect(map.handlers.get("move")?.size ?? 0).toBe(0);
  });
});
