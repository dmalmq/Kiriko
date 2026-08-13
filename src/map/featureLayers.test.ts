import { describe, expect, it } from "vitest";
import type {
  CircleLayerSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";
import { themes } from "../theme/presets";
import { buildIndoorStyle } from "./buildIndoorStyle";
import { FLOOR_ELEVATION_SOURCE_ID } from "./scene/floorElevation";
import {
  applyThemePaintProperties,
  buildFeatureLayers,
  buildNetworkLayers,
  buildRouteLayers,
  CLICKABLE_LAYER_IDS,
  LAYER_ROUTE,
  LAYER_ROUTE_ENDPOINT,
  LAYER_ROUTE_CONNECTOR,
  NETWORK_SOURCE_ID,
  LAYER_NETWORK_VERTICAL_LINK,
  LAYER_NETWORK_VERTICAL_LINK_HIT,
  LAYER_NETWORK_VERTICAL_LINK_LABEL,
  LAYER_NETWORK_VERTICAL_LINK_SELECTED,
  ROUTE_SOURCE_ID,
  LAYER_ISSUE_HIGHLIGHT_OUTLINE,
  LAYER_ISSUE_HIGHLIGHT_POINT,
  LAYER_SELECTED_OUTLINE,
  LAYER_SELECTABLE_CONTEXT_FILL,
  LAYER_CONTEXT_FILL,
  LAYER_NONPUBLIC_FILL,
  LAYER_NONPUBLIC_OUTLINE,
  LAYER_OPENING_LINE,
  LAYER_RESTROOM_FILL,
  LAYER_RESTROOM_OUTLINE,
  LAYER_ROOM_FILL,
  LAYER_STRUCTURE_FILL,
  LAYER_TRANSIT_FILL,
  LAYER_TRANSIT_OUTLINE,
  LAYER_UNENCLOSED_FILL,
  LAYER_UNENCLOSED_OUTLINE,
  LAYER_WALKWAY_FILL,
  NONPUBLIC_CATEGORIES,
  TRANSIT_CATEGORIES,
  UNENCLOSED_CATEGORIES,
  WALKWAY_CATEGORIES,
} from "./featureLayers";

const theme = themes.kiriko;

function findLayer(id: string) {
  const layer = buildFeatureLayers(theme).find((candidate) => candidate.id === id);
  expect(layer, `layer ${id} exists`).toBeDefined();
  return layer!;
}

function fillColor(id: string): unknown {
  const layer = findLayer(id);
  expect(layer.type).toBe("fill");
  return (layer as import("maplibre-gl").FillLayerSpecification).paint?.["fill-color"];
}

describe("category sets", () => {
  it("assigns conveyances to transit, not walkway", () => {
    expect([...TRANSIT_CATEGORIES]).toEqual([
      "elevator",
      "escalator",
      "stairs",
      "steps",
      "movingwalkway",
    ]);
    expect(WALKWAY_CATEGORIES).not.toContain("movingwalkway");
  });

  it("covers both dark-area categories", () => {
    expect([...UNENCLOSED_CATEGORIES]).toEqual(["unenclosedarea", "opentobelow"]);
  });

  it("keeps nonpublic in its own beige bucket", () => {
    expect([...NONPUBLIC_CATEGORIES]).toEqual(["nonpublic"]);
  });
});

describe("buildFeatureLayers category coloring", () => {
  it("paints each bucket with its theme token", () => {
    const c = theme.colors;
    expect(fillColor(LAYER_TRANSIT_FILL)).toEqual(["coalesce", ["get", "__unit_color"], c.unitTransit]);
    expect(fillColor(LAYER_RESTROOM_FILL)).toEqual(["coalesce", ["get", "__unit_color"], c.unitRestroom]);
    expect(fillColor(LAYER_UNENCLOSED_FILL)).toEqual(["coalesce", ["get", "__unit_color"], c.unitUnenclosed]);
    expect(fillColor(LAYER_NONPUBLIC_FILL)).toEqual(["coalesce", ["get", "__unit_color"], c.unitNonPublic]);
    expect(fillColor(LAYER_ROOM_FILL)).toEqual(["coalesce", ["get", "__unit_color"], c.unit]);
    expect(fillColor(LAYER_WALKWAY_FILL)).toEqual(["coalesce", ["get", "__unit_color"], c.walkway]);
  });

  it("filters transit units by category and non-restricted state", () => {
    expect(findLayer(LAYER_TRANSIT_FILL).filter).toEqual([
      "all",
      ["==", ["get", "__feature_type"], "unit"],
      ["!=", ["get", "__restricted"], true],
      ["in", ["get", "__category"], ["literal", [...TRANSIT_CATEGORIES]]],
    ]);
  });

  it("matches restrooms by 8-char category prefix", () => {
    expect(findLayer(LAYER_RESTROOM_FILL).filter).toEqual([
      "all",
      ["==", ["get", "__feature_type"], "unit"],
      ["!=", ["get", "__restricted"], true],
      ["==", ["slice", ["to-string", ["get", "__category"]], 0, 8], "restroom"],
    ]);
  });

  it("excludes the new buckets from the structure fallback", () => {
    const filter = JSON.stringify(findLayer("indoor-structure-fill").filter);
    expect(filter).toContain("movingwalkway");
    expect(filter).toContain("unenclosedarea");
    expect(filter).toContain("restroom");
    expect(filter).toContain("nonpublic");
  });

  it("registers the new fills as clickable", () => {
    expect(CLICKABLE_LAYER_IDS).toContain(LAYER_UNENCLOSED_FILL);
    expect(CLICKABLE_LAYER_IDS).toContain(LAYER_TRANSIT_FILL);
    expect(CLICKABLE_LAYER_IDS).toContain(LAYER_RESTROOM_FILL);
    expect(CLICKABLE_LAYER_IDS).toContain(LAYER_NONPUBLIC_FILL);
  });

  it("renders openings as a single clickable line layer, no endpoint circles", () => {
    const openingLayers = buildFeatureLayers(theme).filter(
      (layer) => JSON.stringify(layer.filter ?? null).includes('"opening"'),
    );
    expect(openingLayers.map((layer) => layer.type)).toEqual(["line"]);
    expect(openingLayers[0]!.id).toBe(LAYER_OPENING_LINE);
    expect(CLICKABLE_LAYER_IDS).toContain(LAYER_OPENING_LINE);
  });

  it("hides venue/building/level polygons by default, tinting only the selected one", () => {
    // Venue dropped from the always-on context layer (footprint stays).
    expect(JSON.stringify(findLayer(LAYER_CONTEXT_FILL).filter)).not.toContain("venue");
    // Level no longer paints the walkway floor plate.
    expect(JSON.stringify(findLayer(LAYER_WALKWAY_FILL).filter)).not.toContain("level");

    const sel = findLayer(LAYER_SELECTABLE_CONTEXT_FILL);
    expect(sel.type).toBe("fill");
    const filterJson = JSON.stringify(sel.filter);
    expect(filterJson).toContain("building");
    expect(filterJson).toContain("venue");
    expect(filterJson).toContain("level");
    // Fill is transparent until the feature is the selected one.
    const opacity = (sel as FillLayerSpecification).paint?.["fill-opacity"];
    expect(JSON.stringify(opacity)).toContain("selected");
    // Search-only: never part of the map hit-test set.
    expect(CLICKABLE_LAYER_IDS).not.toContain(LAYER_SELECTABLE_CONTEXT_FILL);
  });
});

describe("route layers", () => {
  it("draws the route as an accent line plus endpoint circles on the route source", () => {
    const c = theme.colors;
    const layers = buildRouteLayers(theme);

    const line = layers.find((layer) => layer.id === LAYER_ROUTE);
    expect(line).toBeDefined();
    expect(line!.type).toBe("line");
    expect(line!.source).toBe(ROUTE_SOURCE_ID);
    expect((line as LineLayerSpecification).paint?.["line-color"]).toBe(c.accent);
    expect(line!.filter).toEqual(["==", ["get", "kind"], "segment"]);

    const endpoints = layers.find((layer) => layer.id === LAYER_ROUTE_ENDPOINT);
    expect(endpoints).toBeDefined();
    expect(endpoints!.type).toBe("circle");
    expect(endpoints!.source).toBe(ROUTE_SOURCE_ID);
    expect((endpoints as CircleLayerSpecification).paint?.["circle-color"]).toBe(c.accent);
    expect(endpoints!.filter).toEqual([
      "in",
      ["get", "kind"],
      ["literal", ["origin", "destination"]],
    ]);
  });

  it("keeps route layers out of the clickable hit-test set", () => {
    expect(CLICKABLE_LAYER_IDS).not.toContain(LAYER_ROUTE);
    expect(CLICKABLE_LAYER_IDS).not.toContain(LAYER_ROUTE_ENDPOINT);
  });

  it("adds a dashed connector line filtered to connector features, kept out of hit-testing", () => {
    const connector = buildRouteLayers(theme).find((l) => l.id === LAYER_ROUTE_CONNECTOR) as LineLayerSpecification;
    expect(connector.filter).toEqual(["==", ["get", "kind"], "connector"]);
    expect(connector.paint?.["line-dasharray"]).toEqual([1.5, 1.5]);
    expect(CLICKABLE_LAYER_IDS).not.toContain(LAYER_ROUTE_CONNECTOR);
  });

  it("registers the route source and layers in the indoor style", () => {
    const style = buildIndoorStyle(theme);
    expect(style.sources[ROUTE_SOURCE_ID]).toMatchObject({ type: "geojson" });
    expect(style.sources[FLOOR_ELEVATION_SOURCE_ID]).toMatchObject({
      type: "raster-dem",
      encoding: "terrarium",
    });
    expect(style.terrain).toBeUndefined();
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).toContain(LAYER_ROUTE);
    expect(ids).toContain(LAYER_ROUTE_ENDPOINT);
    // Route renders above every feature layer.
    expect(ids.indexOf(LAYER_ROUTE)).toBeGreaterThan(ids.indexOf(LAYER_ISSUE_HIGHLIGHT_POINT));
  });
});

describe("vertical network link layers", () => {
  it("draws and hit-tests an offset semantic marker", () => {
    const layers = buildNetworkLayers();
    const byId = (id: string) => layers.find((layer) => layer.id === id);
    const hit = byId(LAYER_NETWORK_VERTICAL_LINK_HIT) as CircleLayerSpecification;
    const marker = byId(LAYER_NETWORK_VERTICAL_LINK) as CircleLayerSpecification;
    const selected = byId(LAYER_NETWORK_VERTICAL_LINK_SELECTED) as CircleLayerSpecification;

    for (const layer of [hit, marker, selected]) {
      expect(layer.source).toBe(NETWORK_SOURCE_ID);
      expect(JSON.stringify(layer.filter)).toContain("vertical-link");
      expect(layer.paint?.["circle-translate"]).toEqual([12, -12]);
      expect(layer.paint?.["circle-translate-anchor"]).toBe("viewport");
    }
    expect(hit.paint?.["circle-radius"]).toBe(12);
    expect(marker.paint?.["circle-radius"]).toBe(5);
    expect(selected.paint?.["circle-radius"]).toBe(8);
    expect(JSON.stringify(selected.filter)).toContain("selected");
  });

  it("labels only supported direction and target-floor facts", () => {
    const label = buildNetworkLayers().find(
      (layer) => layer.id === LAYER_NETWORK_VERTICAL_LINK_LABEL,
    ) as SymbolLayerSpecification | undefined;
    expect(label?.type).toBe("symbol");
    expect(label?.source).toBe(NETWORK_SOURCE_ID);
    // Glyph-independent: the indoor style has no `glyphs` source, so the
    // visible copy must be a registered style image picked by feature
    // property — never a style-glyph text-field.
    expect(label?.layout?.["icon-image"]).toEqual(["get", "labelImage"]);
    expect(label?.layout?.["text-field"]).toBeUndefined();
    expect(JSON.stringify(label)).not.toMatch(/stairs|escalator|elevator/i);
  });
});

describe("applyThemePaintProperties", () => {
  it("repaints the category layers", () => {
    const c = themes.kiriko.colors;
    const calls: [string, string, unknown][] = [];
    applyThemePaintProperties((layerId, name, value) => {
      calls.push([layerId, name, value]);
    }, themes.kiriko);

    for (const expected of [
      [LAYER_UNENCLOSED_FILL, "fill-color", ["coalesce", ["get", "__unit_color"], c.unitUnenclosed]],
      [LAYER_UNENCLOSED_OUTLINE, "line-color", c.unitOutline],
      [LAYER_TRANSIT_FILL, "fill-color", ["coalesce", ["get", "__unit_color"], c.unitTransit]],
      [LAYER_TRANSIT_OUTLINE, "line-color", c.unitOutline],
      [LAYER_RESTROOM_FILL, "fill-color", ["coalesce", ["get", "__unit_color"], c.unitRestroom]],
      [LAYER_RESTROOM_OUTLINE, "line-color", c.unitOutline],
      [LAYER_NONPUBLIC_FILL, "fill-color", ["coalesce", ["get", "__unit_color"], c.unitNonPublic]],
      [LAYER_NONPUBLIC_OUTLINE, "line-color", c.unitOutline],
    ]) {
      expect(calls).toContainEqual(expected);
    }
  });
});

describe("issue highlight outline", () => {
  it("gates a dedicated outline on the issueHighlight feature-state, distinct from selection", () => {
    const layer = findLayer(LAYER_ISSUE_HIGHLIGHT_OUTLINE) as LineLayerSpecification;
    expect(layer.type).toBe("line");
    expect(layer.paint?.["line-opacity"]).toEqual([
      "case",
      ["boolean", ["feature-state", "issueHighlight"], false],
      1,
      0,
    ]);
    expect(layer.paint?.["line-color"]).toBe(theme.colors.warning);

    const selected = findLayer(LAYER_SELECTED_OUTLINE) as LineLayerSpecification;
    expect(layer.paint?.["line-color"]).not.toBe(selected.paint?.["line-color"]);
    expect(JSON.stringify(selected.paint?.["line-opacity"])).not.toContain("issueHighlight");
  });

  it("gates a point-highlight circle on the issueHighlight feature-state for Point features", () => {
    const layer = findLayer(LAYER_ISSUE_HIGHLIGHT_POINT) as CircleLayerSpecification;
    expect(layer.type).toBe("circle");
    expect(layer.paint?.["circle-stroke-opacity"]).toEqual([
      "case",
      ["boolean", ["feature-state", "issueHighlight"], false],
      1,
      0,
    ]);
    expect(layer.paint?.["circle-stroke-color"]).toBe(theme.colors.warning);
    // Independent of map selection: the circle never keys off the selected state.
    expect(JSON.stringify(layer.paint?.["circle-stroke-opacity"])).not.toContain("selected");
  });

  it("repaints the point highlight color on theme switch", () => {
    const calls: [string, string, unknown][] = [];
    applyThemePaintProperties((layerId, name, value) => {
      calls.push([layerId, name, value]);
    }, theme);
    expect(calls).toContainEqual([LAYER_ISSUE_HIGHLIGHT_POINT, "circle-stroke-color", theme.colors.warning]);
  });

  it("repaints the issue highlight color on theme switch", () => {
    const calls: [string, string, unknown][] = [];
    applyThemePaintProperties((layerId, name, value) => {
      calls.push([layerId, name, value]);
    }, theme);
    expect(calls).toContainEqual([LAYER_ISSUE_HIGHLIGHT_OUTLINE, "line-color", theme.colors.warning]);
  });
});

describe("unit color2 fill coalesce", () => {
  const c = theme.colors;
  it("wraps each unit fill layer in a coalesce over __unit_color", () => {
    const expected: [string, string][] = [
      [LAYER_WALKWAY_FILL, c.walkway],
      [LAYER_ROOM_FILL, c.unit],
      [LAYER_UNENCLOSED_FILL, c.unitUnenclosed],
      [LAYER_TRANSIT_FILL, c.unitTransit],
      [LAYER_RESTROOM_FILL, c.unitRestroom],
      [LAYER_NONPUBLIC_FILL, c.unitNonPublic],
      [LAYER_STRUCTURE_FILL, c.unit],
    ];
    for (const [id, themeColor] of expected) {
      expect(fillColor(id)).toEqual(["coalesce", ["get", "__unit_color"], themeColor]);
    }
  });
});
