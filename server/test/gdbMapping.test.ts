import { describe, expect, it } from "vitest";
import {
  buildGdbImdf,
  collectGdbConversionFailures,
  extractGdbFloorOrdinal,
  GdbConversionError,
  gdbTargetTypesForGeometry,
  isGdbTargetGeometryCompatible,
  layerNameFloorOrdinal,
  normalizeGdbPlan,
  normalizeGdbUuid,
  resolveGdbImdfWithExclusions,
  structuredFloorOrdinal,
  suggestGdbMapping,
} from "../src/gdb/mapping";
import type {
  GdbConvertedLayer,
  GdbGeometryFamily,
  GdbInspection,
  GdbLayerDescriptor,
  GdbMappingPlan,
} from "../src/gdb/types";

function layer(
  layerName: string,
  geometryFamily: GdbGeometryFamily,
  featureCount: number,
  fieldNames: readonly string[] = [],
  databaseId = "gdb-1",
): GdbLayerDescriptor {
  return {
    key: { databaseId, layerName },
    databaseName: `${databaseId}.gdb`,
    featureCount,
    geometryFamily,
    fields: fieldNames.map((name) => ({ name, type: "String" })),
  };
}

function inspect(layers: GdbLayerDescriptor[], sourceName = "Venue.gdb"): GdbInspection {
  return {
    sourceName,
    databases: [{ id: "gdb-1", name: "gdb-1.gdb" }],
    layers,
    warnings: [],
  };
}

function feature(
  geometry: GeoJSON.Geometry,
  props: Record<string, unknown>,
  id = "00000000-0000-4000-8000-000000000000",
): GeoJSON.Feature {
  return { type: "Feature", id, geometry, properties: props };
}

function polygon(): GeoJSON.Polygon {
  return {
    type: "Polygon",
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  };
}

function convert(layers: GdbLayerDescriptor[], name: string): GdbConvertedLayer {
  return {
    key: layers[0]!.key,
    featureCollection: { type: "FeatureCollection", features: [feature(polygon(), { id: name })] },
    skippedGeometryCount: 0,
  };
}

describe("extractGdbFloorOrdinal", () => {
  it("accepts numbers and structured layer tokens", () => {
    expect(extractGdbFloorOrdinal(3)).toBe(3);
    expect(extractGdbFloorOrdinal("B2FL(1FL)_extra")).toBe(-2);
    expect(extractGdbFloorOrdinal("3F_extra")).toBe(2);
  });
  it("resolves synonyms and basement aliases", () => {
    expect(extractGdbFloorOrdinal("KB3")).toBe(-3);
    expect(extractGdbFloorOrdinal("SB4F")).toBe(-4);
    expect(extractGdbFloorOrdinal("M2")).toBe(2);
    expect(extractGdbFloorOrdinal("R")).toBeNull();
  });
  // docs/gdb-data-reference.md: `F<n>` → `n - 1`, `B<n>` → `-n`, `M<n>` → `n`.
  // Must stay identical to Rust `kiriko_route::floor_to_ordinal`, or network
  // and facility floors land on ordinals the venue does not have.
  it("is 0-based, matching kiriko_route::floor_to_ordinal", () => {
    expect(extractGdbFloorOrdinal("F1")).toBe(0);
    expect(extractGdbFloorOrdinal("F2")).toBe(1);
    expect(extractGdbFloorOrdinal("F36")).toBe(35);
    expect(extractGdbFloorOrdinal("1F")).toBe(0);
    expect(extractGdbFloorOrdinal("2F")).toBe(1);
    expect(extractGdbFloorOrdinal("1階")).toBe(0);
    expect(extractGdbFloorOrdinal("GF")).toBe(0);
    expect(extractGdbFloorOrdinal("B1")).toBe(-1);
    expect(extractGdbFloorOrdinal("B2")).toBe(-2);
  });
});

describe("normalizeGdbUuid", () => {
  it("preserves valid hyphenated v4 lowercased", () => {
    expect(normalizeGdbUuid("B1000001-0000-4000-8000-0000000000B1")).toBe(
      "b1000001-0000-4000-8000-0000000000b1",
    );
  });
  it("hyphenates 32-hex v4", () => {
    expect(normalizeGdbUuid("b10000010000400080000000000000b1".toUpperCase())).toBe(
      "b1000001-0000-4000-8000-0000000000b1",
    );
  });
  it("rejects non-v4 / wrong-variant", () => {
    expect(normalizeGdbUuid("not-a-uuid")).toBeNull();
    expect(normalizeGdbUuid("00000000-0000-1000-0000-000000000000")).toBeNull();
  });
});

describe("structured/layer-name floor ordinal", () => {
  it("uses ONLY the structured token", () => {
    expect(structuredFloorOrdinal("Station_2_R_level")).toBeNull();
    expect(structuredFloorOrdinal("Station_2_0_level")).toBe(0);
    expect(structuredFloorOrdinal("Station_2_B1_unit")).toBe(-1);
  });
  it("falls back to loose token parse for non-structured names", () => {
    expect(layerNameFloorOrdinal("ShinjukuSt_B1_link")).toBe(-1);
    expect(layerNameFloorOrdinal("Camera_1_nw")).toBe(0);
  });
});

describe("geometry compatibility", () => {
  it("classifies target types by required family", () => {
    expect(isGdbTargetGeometryCompatible("level", "polygon")).toBe(true);
    expect(isGdbTargetGeometryCompatible("level", "line")).toBe(false);
    expect(isGdbTargetGeometryCompatible("amenity", "point")).toBe(true);
    expect(isGdbTargetGeometryCompatible("amenity", "polygon")).toBe(false);
    expect(gdbTargetTypesForGeometry("line")).toEqual(["opening", "detail"]);
    expect(gdbTargetTypesForGeometry("mixed")).toEqual([]);
  });
});

describe("suggestGdbMapping", () => {
  it("derives buildings from structured prefixes and assigns target types", () => {
    const inspection = inspect([
      layer("StationA_1_Floor", "polygon", 2, ["id", "name"]),
      layer("StationA_1_Space", "polygon", 3, ["id", "category", "floor_id"]),
      layer("StationA_1_Opening", "line", 1, ["id", "floor_id"]),
      layer("StationB_1_Floor", "polygon", 1, ["id"]),
    ]);
    const plan = suggestGdbMapping(inspection);

    expect(plan.venueName).toBe("Venue");
    expect(plan.buildings.map((b) => b.name)).toEqual(["StationA", "StationB"]);
    const floorA = plan.layers.find((l) => l.key.layerName === "StationA_1_Floor")!;
    expect(floorA.targetType).toBe("level");
    expect(floorA.included).toBe(true);
    expect(floorA.buildingId).toBe("building-1");
    expect(floorA.levelRule).toEqual({ kind: "layer-name" });

    const space = plan.layers.find((l) => l.key.layerName === "StationA_1_Space")!;
    expect(space.targetType).toBe("unit");
    expect(space.levelRule).toEqual({ kind: "source-reference", field: "floor_id" });

    const opening = plan.layers.find((l) => l.key.layerName === "StationA_1_Opening")!;
    expect(opening.targetType).toBe("opening");
    expect(opening.buildingId).toBe("building-1");
  });

  it("strips archive suffixes from venue name", () => {
    const inspection = inspect([layer("Station_1_Floor", "polygon", 1)], "JR.gdb.zip");
    expect(suggestGdbMapping(inspection).venueName).toBe("JR");
  });

  it("excludes cross-floor `_to_` edges as details", () => {
    const inspection = inspect([layer("Station_1_to_2_nw", "line", 1)]);
    const plan = suggestGdbMapping(inspection);
    const row = plan.layers[0]!;
    expect(row.targetType).toBe("detail");
    expect(row.included).toBe(false);
  });

  it("does not auto-include unstructured amenity without level/floor id field", () => {
    const inspection = inspect([
      layer("Free_shuttle_bus_busstop_Facility", "point", 3, ["id", "name", "category"]),
      layer("Station_1_Floor", "polygon", 2, ["id", "ordinal"]),
    ]);
    const plan = suggestGdbMapping(inspection);
    const shuttle = plan.layers.find((l) => l.key.layerName === "Free_shuttle_bus_busstop_Facility")!;
    expect(shuttle.targetType).toBe("amenity");
    expect(shuttle.included).toBe(false);
    expect(shuttle.buildingId).toBeNull();
  });

  it("may auto-include unstructured amenity when floor_id is present", () => {
    const inspection = inspect([
      layer("Free_shuttle_bus_busstop_Facility", "point", 3, ["id", "floor_id", "name"]),
      layer("Station_1_Floor", "polygon", 2, ["id", "ordinal"]),
    ]);
    const plan = suggestGdbMapping(inspection);
    const shuttle = plan.layers.find((l) => l.key.layerName === "Free_shuttle_bus_busstop_Facility")!;
    expect(shuttle.levelRule).toEqual({ kind: "source-reference", field: "floor_id" });
    expect(shuttle.included).toBe(true);
    expect(shuttle.buildingId).toBeNull();
  });
});

describe("buildGdbImdf", () => {
  it("synthesizes one venue, one building, the imported level, and the unit", () => {
    const floor = layer("Station_1_Floor", "polygon", 1, ["id", "name"]);
    const space = layer("Station_1_Space", "polygon", 1, ["id", "category", "floor_id"]);
    const inspection = inspect([floor, space]);
    const plan = suggestGdbMapping(inspection);
    // Fill in the source UUIDs the unit references.
    const floorId = "b1000001-0000-4000-8000-0000000000b1";
    const spaceId = "b2000002-0000-4000-8000-0000000000b2";
    const floorLayer: GdbConvertedLayer = {
      key: floor.key,
      featureCollection: {
        type: "FeatureCollection",
        features: [feature(polygon(), { id: floorId, name: "1F" }, floorId)],
      },
      skippedGeometryCount: 0,
    };
    const spaceLayer: GdbConvertedLayer = {
      key: space.key,
      featureCollection: {
        type: "FeatureCollection",
        features: [
          feature(polygon(), { id: spaceId, category: "room", floor_id: floorId }, spaceId),
        ],
      },
      skippedGeometryCount: 0,
    };

    const archive = buildGdbImdf(
      { layers: [floorLayer, spaceLayer], warnings: [] },
      plan,
    );

    expect(archive.manifest).toEqual({ version: "1.0.0", language: "ja" });
    expect(archive.collections.venue?.features).toHaveLength(1);
    expect(archive.collections.building?.features).toHaveLength(1);
    expect(archive.collections.level?.features).toHaveLength(1);
    const levelFeature = archive.collections.level!.features[0]!;
    expect((levelFeature.properties as Record<string, unknown>).ordinal).toBe(0);
    expect((levelFeature.properties as Record<string, unknown>)["__gdb_database"]).toBe("gdb-1");
    const unitFeature = archive.collections.unit!.features[0]!;
    // Source floor_id reference must resolve to the imported level id.
    expect((unitFeature.properties as Record<string, unknown>).level_id).toBe(levelFeature.id);
    // Source UUIDs that are count-one must be preserved on both level and unit.
    expect(levelFeature.id).toBe(floorId);
    expect(unitFeature.id).toBe(spaceId);
  });

  // Observed in the JR East source: every Floor layer carries a consistent
  // `floor` label (`F<n>`), but the `ordinal` attribute mixes conventions —
  // JRTakanawaGatewaySta_2_Floor has ordinal 2 for `F2` while
  // LinkPillar1_2_Floor has ordinal 1 for `F2`. Trusting the attribute put
  // Takanawa 1F and LinkPillar 2F on the same ordinal, so the floor selector
  // and the network overlay (which filter by ordinal alone) drew two
  // different physical floors together.
  it("derives the level ordinal from the floor label, not a conflicting ordinal field", () => {
    const floor = layer("LinkPillar1_2_Floor", "polygon", 1, [
      "id",
      "name",
      "ordinal",
      "floor",
    ]);
    const plan = suggestGdbMapping(inspect([floor]));
    const levelPlan = plan.layers.find((l) => l.key.layerName === "LinkPillar1_2_Floor")!;
    expect(levelPlan.ordinalField).toBe("ordinal");
    expect(levelPlan.levelRule).toEqual({ kind: "property", field: "floor" });

    const floorId = "b1000001-0000-4000-8000-0000000000b1";
    const floorLayer: GdbConvertedLayer = {
      key: floor.key,
      featureCollection: {
        type: "FeatureCollection",
        features: [
          // `ordinal` says 1 (0-based); `floor` says F2. The label wins.
          feature(polygon(), { id: floorId, name: "2F", ordinal: 1, floor: "F2" }, floorId),
        ],
      },
      skippedGeometryCount: 0,
    };

    const archive = buildGdbImdf({ layers: [floorLayer], warnings: [] }, plan);
    const levelFeature = archive.collections.level!.features[0]!;
    expect((levelFeature.properties as Record<string, unknown>).ordinal).toBe(1);
  });

  it("falls back to the ordinal field when no label parses", () => {
    const floor = layer("Tower_1_Floor", "polygon", 1, ["id", "name", "ordinal", "floor"]);
    const plan = suggestGdbMapping(inspect([floor]));
    const floorId = "b1000001-0000-4000-8000-0000000000b1";
    const floorLayer: GdbConvertedLayer = {
      key: floor.key,
      featureCollection: {
        type: "FeatureCollection",
        features: [
          feature(polygon(), { id: floorId, name: "Roof", ordinal: 7, floor: "R" }, floorId),
        ],
      },
      skippedGeometryCount: 0,
    };
    const archive = buildGdbImdf({ layers: [floorLayer], warnings: [] }, plan);
    const levelFeature = archive.collections.level!.features[0]!;
    expect((levelFeature.properties as Record<string, unknown>).ordinal).toBe(7);
  });

  it("fails when no layers are included", () => {
    expect(() => buildGdbImdf({ layers: [], warnings: [] }, { venueName: "x", buildings: [], layers: [] }))
      .toThrow();
  });

  it("collectGdbConversionFailures excludes blamed layers until it converts", () => {
    const ok = layer("Station_1_Floor", "polygon", 1, ["id"]);
    const bad = layer("Station_1_Space", "polygon", 1, ["id"]);
    const plan = suggestGdbMapping(inspect([ok, bad]));
    // Empty Space geometry will force "empty or geometry-less layer".
    const convertedOk = convert([ok], "id1");
    const emptyBad: GdbConvertedLayer = {
      key: bad.key,
      featureCollection: { type: "FeatureCollection", features: [] },
      skippedGeometryCount: 0,
    };
    const failures = collectGdbConversionFailures(
      { layers: [convertedOk, emptyBad], warnings: [] },
      plan,
    );
    expect(failures.map((f) => f.layer)).toEqual(["Station_1_Space"]);
    expect(failures[0]?.reason).toBe("empty or geometry-less layer");
  });
});

describe("normalizeGdbPlan", () => {
  it("coerces empty-string buildingId to null and leaves real ids", () => {
    const plan = {
      venueName: "V",
      buildings: [{ id: "building-1", name: "A" }],
      layers: [
        {
          key: { databaseId: "gdb-1", layerName: "A_1_Floor" },
          included: true,
          targetType: "level" as const,
          buildingId: "",
          levelRule: { kind: "layer-name" as const },
          idField: "id",
          ordinalField: null,
          shortNameField: null,
          nameField: null,
          categoryField: null,
        },
        {
          key: { databaseId: "gdb-1", layerName: "A_1_Space" },
          included: true,
          targetType: "unit" as const,
          buildingId: "building-1",
          levelRule: { kind: "layer-name" as const },
          idField: "id",
          ordinalField: null,
          shortNameField: null,
          nameField: null,
          categoryField: null,
        },
      ],
    };
    const out = normalizeGdbPlan(plan);
    expect(out.layers[0]!.buildingId).toBeNull();
    expect(out.layers[1]!.buildingId).toBe("building-1");
    // Does not mutate input
    expect(plan.layers[0]!.buildingId).toBe("");
  });

  it("coerces empty-string field selectors to null (ajv null->'' footgun)", () => {
    const plan = {
      venueName: "V",
      buildings: [],
      layers: [
        {
          key: { databaseId: "gdb-1", layerName: "A_1_Space" },
          included: true,
          targetType: "unit" as const,
          buildingId: null,
          levelRule: { kind: "layer-name" as const },
          idField: "id",
          ordinalField: "",
          shortNameField: "",
          nameField: "",
          categoryField: "",
        },
      ],
    };
    const out = normalizeGdbPlan(plan);
    const row = out.layers[0]!;
    expect(row.ordinalField).toBeNull();
    expect(row.shortNameField).toBeNull();
    expect(row.nameField).toBeNull();
    expect(row.categoryField).toBeNull();
    expect(row.idField).toBe("id");
  });

  it("normalizes clipToSelection to a strict boolean", () => {
    const base: GdbMappingPlan = {
      venueName: "Station",
      buildings: [{ id: "b1", name: "Station" }],
      layers: [],
    };
    expect(normalizeGdbPlan(base).clipToSelection).toBe(false);
    expect(normalizeGdbPlan({ ...base, clipToSelection: true }).clipToSelection).toBe(true);
  });
});

describe("resolveGdbImdfWithExclusions", () => {
  it("returns empty excludedLayers when the plan already converts", () => {
    const ok = layer("Station_1_Floor", "polygon", 1, ["id"]);
    const plan = suggestGdbMapping(inspect([ok]));
    // ensure included
    const resolved = resolveGdbImdfWithExclusions(
      { layers: [convert([ok], "id1")], warnings: [] },
      plan,
    );
    expect(resolved.excludedLayers).toEqual([]);
    expect(resolved.archive.collections.level?.features.length).toBeGreaterThan(0);
  });

  it("prunes blamed layers and returns exclusions", () => {
    const ok = layer("Station_1_Floor", "polygon", 1, ["id"]);
    const bad = layer("Station_1_Space", "polygon", 1, ["id"]);
    const plan = suggestGdbMapping(inspect([ok, bad]));
    const convertedOk = convert([ok], "id1");
    const emptyBad = {
      key: bad.key,
      featureCollection: { type: "FeatureCollection" as const, features: [] },
      skippedGeometryCount: 0,
    };
    const resolved = resolveGdbImdfWithExclusions(
      { layers: [convertedOk, emptyBad], warnings: [] },
      plan,
    );
    expect(resolved.excludedLayers.map((f) => f.layer)).toEqual(["Station_1_Space"]);
    expect(resolved.archive.collections.level?.features.length).toBeGreaterThan(0);
  });

  it("throws when every included layer is blamed", () => {
    const bad = layer("Station_1_Floor", "polygon", 1, ["id"]);
    const plan = suggestGdbMapping(inspect([bad]));
    const emptyBad = {
      key: bad.key,
      featureCollection: { type: "FeatureCollection" as const, features: [] },
      skippedGeometryCount: 0,
    };
    expect(() =>
      resolveGdbImdfWithExclusions({ layers: [emptyBad], warnings: [] }, plan),
    ).toThrow(GdbConversionError);
  });
});
