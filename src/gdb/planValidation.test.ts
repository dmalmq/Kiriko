import { describe, expect, it } from "vitest";
import {
  collectBlockingIssues,
  gdbTargetTypesForGeometry,
  isGdbTargetGeometryCompatible,
  layerNameFloorOrdinal,
} from "./planValidation";
import { gdbLayerKeyString, type GdbLayerDescriptor, type GdbMappingPlan } from "./types";

function descriptor(name: string, family: GdbLayerDescriptor["geometryFamily"], fields: string[]): GdbLayerDescriptor {
  return {
    key: { databaseId: "gdb-1", layerName: name },
    databaseName: "db",
    featureCount: 1,
    geometryFamily: family,
    fields: fields.map((f) => ({ name: f, type: "String" })),
  };
}

describe("geometry compatibility", () => {
  it("matches target types to geometry families", () => {
    expect(isGdbTargetGeometryCompatible("level", "polygon")).toBe(true);
    expect(isGdbTargetGeometryCompatible("level", "point")).toBe(false);
    expect(gdbTargetTypesForGeometry("point")).toEqual(["amenity", "occupant"]);
    expect(gdbTargetTypesForGeometry("mixed")).toEqual([]);
  });
});

describe("floor ordinal", () => {
  // Ordinals are 0-based: `F1` (ground) is ordinal 0, matching Rust
  // `kiriko_route::floor_to_ordinal` and the server's copy of this parser in
  // `server/src/gdb/mapping.ts`. Basements keep `B<n>` -> `-n`.
  it("reads the structured floor token as a 0-based ordinal", () => {
    expect(layerNameFloorOrdinal("Station_B1_Floor")).toBe(-1);
    expect(layerNameFloorOrdinal("Station_1_Floor")).toBe(0);
    expect(layerNameFloorOrdinal("Station_5_Space")).toBe(4);
    expect(layerNameFloorOrdinal("Station_R_Floor")).toBeNull();
  });

  it("agrees with the server parser that F1, GF and F0 are all ordinal 0", () => {
    expect(layerNameFloorOrdinal("Station_0_Floor")).toBe(0);
    expect(layerNameFloorOrdinal("GF")).toBe(0);
  });
});

describe("collectBlockingIssues", () => {
  const d = descriptor("Station_1_Floor", "polygon", ["id"]);
  const map = new Map([[gdbLayerKeyString(d.key), d]]);
  const basePlan: GdbMappingPlan = {
    venueName: "Station",
    buildings: [{ id: "b1", name: "Station" }],
    layers: [
      {
        key: d.key, included: true, targetType: "level", buildingId: "b1",
        levelRule: { kind: "layer-name" }, idField: "id",
        ordinalField: null, shortNameField: null, nameField: null, categoryField: null,
      },
    ],
  };

  it("returns no issues for a resolvable level", () => {
    expect(collectBlockingIssues(basePlan, map, "en")).toEqual([]);
  });

  it("flags a level with no assigned building", () => {
    const plan = { ...basePlan, layers: [{ ...basePlan.layers[0]!, buildingId: null }] };
    expect(collectBlockingIssues(plan, map, "en").length).toBe(1);
  });

  it("flags a target type incompatible with the geometry", () => {
    const plan = { ...basePlan, layers: [{ ...basePlan.layers[0]!, targetType: "amenity" as const }] };
    expect(collectBlockingIssues(plan, map, "en")[0]).toContain("incompatible");
  });

  it("treats empty-string buildingId as missing on levels", () => {
    const plan = {
      ...basePlan,
      layers: [{ ...basePlan.layers[0]!, buildingId: "" }],
    };
    expect(collectBlockingIssues(plan, map, "en").some((m) => m.includes("building"))).toBe(true);
  });

  it("allows source-reference non-level with null buildingId", () => {
    const amenity = descriptor("POI", "point", ["id", "floor_id"]);
    const amenityMap = new Map([[gdbLayerKeyString(amenity.key), amenity]]);
    const plan: GdbMappingPlan = {
      venueName: "Station",
      buildings: [{ id: "b1", name: "Station" }],
      layers: [
        basePlan.layers[0]!,
        {
          key: amenity.key,
          included: true,
          targetType: "amenity",
          buildingId: null,
          levelRule: { kind: "source-reference", field: "floor_id" },
          idField: "id",
          ordinalField: null,
          shortNameField: null,
          nameField: null,
          categoryField: null,
        },
      ],
    };
    const issues = collectBlockingIssues(plan, amenityMap, "en");
    expect(issues.some((m) => m.includes("POI") && m.includes("building"))).toBe(false);
  });

  it("flags non-source-reference non-level with empty buildingId", () => {
    const unit = descriptor("Station_1_Space", "polygon", ["id"]);
    const unitMap = new Map([
      [gdbLayerKeyString(basePlan.layers[0]!.key), descriptor("Station_1_Floor", "polygon", ["id"])],
      [gdbLayerKeyString(unit.key), unit],
    ]);
    const plan: GdbMappingPlan = {
      venueName: "Station",
      buildings: [{ id: "b1", name: "Station" }],
      layers: [
        basePlan.layers[0]!,
        {
          key: unit.key,
          included: true,
          targetType: "unit",
          buildingId: "",
          levelRule: { kind: "layer-name" },
          idField: "id",
          ordinalField: null,
          shortNameField: null,
          nameField: null,
          categoryField: null,
        },
      ],
    };
    const issues = collectBlockingIssues(plan, unitMap, "en");
    expect(issues.some((m) => m.includes("Space"))).toBe(true);
  });
  it("treats empty-string field selectors as unset (not a missing field)", () => {
    const plan = {
      ...basePlan,
      layers: [
        {
          ...basePlan.layers[0]!,
          ordinalField: "",
          shortNameField: "",
          nameField: "",
          categoryField: "",
        },
      ],
    };
    expect(collectBlockingIssues(plan, map, "en")).toEqual([]);
  });

});
