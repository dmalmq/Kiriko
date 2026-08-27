import { describe, expect, it } from "vitest";
import {
  DRAG_LONGTASK_CI_MS,
  DRAG_LONGTASK_WORKSTATION_MS,
  LEVEL_CHANGE_CI_MEDIAN_MS,
  LEVEL_CHANGE_CI_P95_MS,
  LEVEL_CHANGE_WORKSTATION_P95_MS,
  longTasksOverBudget,
  percentileNearestRank,
} from "./performanceStats";

// Linux acceptance 33043534217 (feat/jr-ticket-gate, passed).
const TICKET_GATE_LEVEL_CHANGE_MS = [
  129.9, 71.4, 70.5, 72.9, 73.9, 76.5, 128.1, 71.6, 78.5, 71.6, 74.3, 73.9, 74.7, 129.3,
  16.0, 71.9, 68.2, 70.1, 65.6, 74.6, 71.6, 70.0, 70.2, 126.6, 76.3, 77.4, 129.0, 68.8,
  73.3, 70.9,
];

// Linux acceptance 33053796337 (this branch, failed the 150ms P95 gate).
const CONVEYANCE_LEVEL_CHANGE_MS = [
  153.9, 82.8, 86.6, 85.4, 86.9, 162.3, 15.9, 84.4, 88.2, 91.9, 89.4, 89.4, 86.9, 86.5,
  86.2, 85.4, 85.4, 83.7, 86.4, 87.2, 85.7, 162.3, 79.6, 87.8, 85.1, 86.7, 81.2, 83.4,
  83.9, 93.7,
];

describe("percentileNearestRank", () => {
  it("uses nearest-rank P95 as the 2nd-worst of 30 samples", () => {
    const samples = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(percentileNearestRank(samples, 0.95)).toBe(29);
  });
});

describe("level-change CI budget", () => {
  it("keeps the ticket-gate GHA series inside the workstation P95", () => {
    const p95 = percentileNearestRank(TICKET_GATE_LEVEL_CHANGE_MS, 0.95);
    const median = percentileNearestRank(TICKET_GATE_LEVEL_CHANGE_MS, 0.5);
    expect(p95).toBe(129.3);
    expect(p95).toBeLessThanOrEqual(LEVEL_CHANGE_WORKSTATION_P95_MS);
    expect(median).toBeLessThanOrEqual(LEVEL_CHANGE_CI_MEDIAN_MS);
  });

  it("documents that the conveyance GHA series missed 150ms on the 2nd-worst sample", () => {
    const p95 = percentileNearestRank(CONVEYANCE_LEVEL_CHANGE_MS, 0.95);
    const median = percentileNearestRank(CONVEYANCE_LEVEL_CHANGE_MS, 0.5);
    expect(p95).toBe(162.3);
    expect(p95).toBeGreaterThan(LEVEL_CHANGE_WORKSTATION_P95_MS);
    expect(median).toBeLessThanOrEqual(LEVEL_CHANGE_CI_MEDIAN_MS);
    expect(p95).toBeLessThanOrEqual(LEVEL_CHANGE_CI_P95_MS);
  });
});

// Linux acceptance 33053796337 (this branch, drag passed).
const CONVEYANCE_DRAG_PASSED_MS = [
  82, 71, 69, 70, 71, 70, 70, 74, 73, 71, 71, 71, 71, 70, 71, 69, 70, 70, 71, 69, 70, 73,
  71, 73, 71, 71, 69, 69, 70, 68, 68, 67, 69, 67, 63, 62, 91,
];

// Linux acceptance 33056034476 attempt 1 (drag failed: one 101ms task).
const CONVEYANCE_DRAG_FAILED_MS = [
  82, 74, 69, 68, 69, 67, 70, 101, 73, 70, 68, 69, 70, 68, 68, 69, 67, 68, 68, 67, 70, 70,
  71, 71, 71, 70, 70, 72, 68, 68, 67, 66, 67, 67, 66, 65, 70, 65, 65, 62, 63, 65, 63, 66,
];

describe("drag longtask CI budget", () => {
  it("keeps the passing GHA series inside the workstation cap", () => {
    expect(longTasksOverBudget(CONVEYANCE_DRAG_PASSED_MS, DRAG_LONGTASK_WORKSTATION_MS)).toEqual(
      [],
    );
  });

  it("documents that a 101ms observer overage missed 100ms and stays inside 120ms", () => {
    expect(longTasksOverBudget(CONVEYANCE_DRAG_FAILED_MS, DRAG_LONGTASK_WORKSTATION_MS)).toEqual(
      [101],
    );
    expect(longTasksOverBudget(CONVEYANCE_DRAG_FAILED_MS, DRAG_LONGTASK_CI_MS)).toEqual([]);
  });
});
