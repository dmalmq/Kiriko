import { describe, expect, it } from "vitest";
import { mapCategoryCode } from "../src/gdb/categoryCodes";

describe("mapCategoryCode", () => {
  it("maps B-codes to unit categories", () => {
    expect(mapCategoryCode("B021")).toBe("stairs");
    expect(mapCategoryCode("B022")).toBe("elevator");
    expect(mapCategoryCode("B023")).toBe("escalator");
    expect(mapCategoryCode("B024")).toBe("walkway");
    expect(mapCategoryCode("B029")).toBe("walkway");
    expect(mapCategoryCode("B028")).toBe("platform");
    expect(mapCategoryCode("B001")).toBe("retail");
    expect(mapCategoryCode("B019")).toBe("room");
  });
  it("maps C-codes to fixture categories and A-codes to venue categories", () => {
    expect(mapCategoryCode("C010")).toBe("wall");
    expect(mapCategoryCode("C008")).toBe("obstruction");
    expect(mapCategoryCode("C104")).toBe("ticketgate");
    expect(mapCategoryCode("A001")).toBe("transitstation");
  });
  it("falls back to the table default for unknown codes and passes non-codes through", () => {
    expect(mapCategoryCode("B999")).toBe("unspecified");
    expect(mapCategoryCode("A999")).toBe("other");
    expect(mapCategoryCode("room")).toBe("room");
    expect(mapCategoryCode("walkway")).toBe("walkway");
    expect(mapCategoryCode("")).toBe("");
  });
});
