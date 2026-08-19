import { describe, expect, it } from "vitest";
import { BOX_SELECT_THRESHOLD_PX, boxSelectRect } from "./boxSelectRect";

describe("boxSelectRect", () => {
  it("returns null until the drag reaches the commit threshold", () => {
    expect(boxSelectRect({ x: 10, y: 10 }, { x: 12, y: 10 })).toBeNull();
    expect(BOX_SELECT_THRESHOLD_PX).toBe(4);
  });

  it("returns the axis-aligned pixel box once the drag is long enough", () => {
    expect(boxSelectRect({ x: 10, y: 20 }, { x: 40, y: 8 })).toEqual({
      left: 10,
      top: 8,
      width: 30,
      height: 12,
    });
  });
});
