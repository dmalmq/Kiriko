import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  FilterSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";
import type { ViewerTheme } from "../theme/types";

/**
 * Unit fill paint: honor a per-feature `color2` fill (`__unit_color`) when the
 * feature carries one, else fall back to the category theme color.
 */
function unitFillColor(themeColor: string): ExpressionSpecification {
  return ["coalesce", ["get", "__unit_color"], themeColor];
}

/** Single GeoJSON source for the selected level + venue context. */
export const INDOOR_SOURCE_ID = "indoor-features";

export const BACKGROUND_LAYER_ID = "indoor-background";

export const LAYER_CONTEXT_FILL = "indoor-context-fill";
export const LAYER_CONTEXT_OUTLINE = "indoor-context-outline";
export const LAYER_SELECTABLE_CONTEXT_FILL = "indoor-selectable-context-fill";
export const LAYER_WALKWAY_FILL = "indoor-walkway-fill";
export const LAYER_WALKWAY_OUTLINE = "indoor-walkway-outline";
export const LAYER_ROOM_FILL = "indoor-room-fill";
export const LAYER_ROOM_OUTLINE = "indoor-room-outline";
export const LAYER_UNENCLOSED_FILL = "indoor-unenclosed-fill";
export const LAYER_UNENCLOSED_OUTLINE = "indoor-unenclosed-outline";
export const LAYER_TRANSIT_FILL = "indoor-transit-fill";
export const LAYER_TRANSIT_OUTLINE = "indoor-transit-outline";
export const LAYER_RESTROOM_FILL = "indoor-restroom-fill";
export const LAYER_RESTROOM_OUTLINE = "indoor-restroom-outline";
export const LAYER_NONPUBLIC_FILL = "indoor-nonpublic-fill";
export const LAYER_NONPUBLIC_OUTLINE = "indoor-nonpublic-outline";
export const LAYER_STRUCTURE_FILL = "indoor-structure-fill";
export const LAYER_STRUCTURE_OUTLINE = "indoor-structure-outline";
export const LAYER_RESTRICTED_FILL = "indoor-restricted-fill";
export const LAYER_RESTRICTED_OUTLINE = "indoor-restricted-outline";
export const LAYER_FIXTURE_FILL = "indoor-fixture-fill";
export const LAYER_FIXTURE_OUTLINE = "indoor-fixture-outline";
export const LAYER_KIOSK_FILL = "indoor-kiosk-fill";
export const LAYER_KIOSK_OUTLINE = "indoor-kiosk-outline";
export const LAYER_DETAIL_LINE = "indoor-detail-line";
export const LAYER_OPENING_LINE = "indoor-opening-line";
export const LAYER_AMENITY_CIRCLE = "indoor-amenity-circle";
export const LAYER_OCCUPANT_CIRCLE = "indoor-occupant-circle";
export const LAYER_HOVER_OUTLINE = "indoor-hover-outline";
export const LAYER_SELECTED_OUTLINE = "indoor-selected-outline";
export const LAYER_ISSUE_HIGHLIGHT_OUTLINE = "indoor-issue-highlight-outline";
export const LAYER_ISSUE_HIGHLIGHT_POINT = "indoor-issue-highlight-point";

/** Separate GeoJSON source for the directions overlay (route + endpoints). */
export const ROUTE_SOURCE_ID = "indoor-route";
export const LAYER_ROUTE = "indoor-route-line";
export const LAYER_ROUTE_ENDPOINT = "indoor-route-endpoint";
export const LAYER_ROUTE_CONNECTOR = "indoor-route-connector";

/** Separate GeoJSON source for the point-facility symbol overlay (§7). */
export const FACILITY_SOURCE_ID = "indoor-facilities";
export const LAYER_FACILITY_SYMBOL = "indoor-facility-symbol";

/** Separate GeoJSON source for the network-review overlay (net_path/net_junction). */
export const NETWORK_SOURCE_ID = "indoor-network";
export const LAYER_NETWORK_PATH = "indoor-network-path";
export const LAYER_NETWORK_JUNCTION = "indoor-network-junction";
/** Wide, near-invisible hit targets for precise network editing clicks. */
export const LAYER_NETWORK_PATH_HIT = "indoor-network-path-hit";
export const LAYER_NETWORK_JUNCTION_HIT = "indoor-network-junction-hit";
/** Offset semantic marker for cross-floor links (hit, base, selected, label). */
export const LAYER_NETWORK_VERTICAL_LINK_HIT = "indoor-network-vertical-link-hit";
export const LAYER_NETWORK_VERTICAL_LINK = "indoor-network-vertical-link";
export const LAYER_NETWORK_VERTICAL_LINK_SELECTED = "indoor-network-vertical-link-selected";
export const LAYER_NETWORK_VERTICAL_LINK_LABEL = "indoor-network-vertical-link-label";

/** Layers that participate in click / hover hit-testing. */
export const CLICKABLE_LAYER_IDS: readonly string[] = [
  LAYER_CONTEXT_FILL,
  LAYER_WALKWAY_FILL,
  LAYER_ROOM_FILL,
  LAYER_UNENCLOSED_FILL,
  LAYER_TRANSIT_FILL,
  LAYER_RESTROOM_FILL,
  LAYER_NONPUBLIC_FILL,
  LAYER_STRUCTURE_FILL,
  LAYER_RESTRICTED_FILL,
  LAYER_FIXTURE_FILL,
  LAYER_KIOSK_FILL,
  LAYER_DETAIL_LINE,
  LAYER_OPENING_LINE,
  LAYER_AMENITY_CIRCLE,
  LAYER_OCCUPANT_CIRCLE,
];

export const WALKWAY_CATEGORIES = [
  "walkway",
  "corridor",
  "opentowalkway",
  "ramp",
  "sidewalk",
] as const;

export const ROOM_CATEGORIES = ["room"] as const;

export const TRANSIT_CATEGORIES = [
  "elevator",
  "escalator",
  "stairs",
  "steps",
  "movingwalkway",
] as const;

export const UNENCLOSED_CATEGORIES = ["unenclosedarea", "opentobelow"] as const;

export const NONPUBLIC_CATEGORIES = ["nonpublic"] as const;

/** First 8 chars of `__category`; "restroom" covers all 11 restroom.* enum values. */
const restroomPrefix: ExpressionSpecification = [
  "slice",
  ["to-string", ["get", "__category"]],
  0,
  8,
];

type AnyLayer =
  | FillLayerSpecification
  | LineLayerSpecification
  | CircleLayerSpecification
  | SymbolLayerSpecification;

/**
 * Fixed layer order (plan §3):
 * 1. venue/footprint context fill+outline
 * 2. walkable units and rooms (+ level floor)
 * 3. structures, restricted units, fixtures, polygonal kiosks, details
 * 4. openings and entrances
 * 5. amenity and derived occupant points
 * 6. hover and selected-feature outlines
 */
export function buildFeatureLayers(theme: ViewerTheme): AnyLayer[] {
  const c = theme.colors;

  const matchFeatureType = (...types: string[]): FilterSpecification => {
    if (types.length === 1) {
      return ["==", ["get", "__feature_type"], types[0]!];
    }
    return ["in", ["get", "__feature_type"], ["literal", types]];
  };

  const matchWalkwayUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["!=", ["get", "__restricted"], true],
    ["in", ["get", "__category"], ["literal", [...WALKWAY_CATEGORIES]]],
  ];

  const matchRoomUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["!=", ["get", "__restricted"], true],
    ["in", ["get", "__category"], ["literal", [...ROOM_CATEGORIES]]],
  ];

  const matchTransitUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["!=", ["get", "__restricted"], true],
    ["in", ["get", "__category"], ["literal", [...TRANSIT_CATEGORIES]]],
  ];

  const matchUnenclosedUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["!=", ["get", "__restricted"], true],
    ["in", ["get", "__category"], ["literal", [...UNENCLOSED_CATEGORIES]]],
  ];

  const matchRestroomUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["!=", ["get", "__restricted"], true],
    ["==", restroomPrefix, "restroom"],
  ];

  const matchNonPublicUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["!=", ["get", "__restricted"], true],
    ["in", ["get", "__category"], ["literal", [...NONPUBLIC_CATEGORIES]]],
  ];

  const matchStructureUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["!=", ["get", "__restricted"], true],
    ["!", ["in", ["get", "__category"], ["literal", [...WALKWAY_CATEGORIES]]]],
    ["!", ["in", ["get", "__category"], ["literal", [...ROOM_CATEGORIES]]]],
    ["!", ["in", ["get", "__category"], ["literal", [...TRANSIT_CATEGORIES]]]],
    ["!", ["in", ["get", "__category"], ["literal", [...UNENCLOSED_CATEGORIES]]]],
    ["!", ["in", ["get", "__category"], ["literal", [...NONPUBLIC_CATEGORIES]]]],
    ["!=", restroomPrefix, "restroom"],
  ];

  const matchRestrictedUnit: FilterSpecification = [
    "all",
    ["==", ["get", "__feature_type"], "unit"],
    ["==", ["get", "__restricted"], true],
  ];

  const layers: AnyLayer[] = [
    // 1. Context
    {
      id: LAYER_CONTEXT_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("footprint"),
      paint: {
        "fill-color": c.unit,
        "fill-opacity": 0.55,
      },
    },
    {
      id: LAYER_CONTEXT_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("footprint"),
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1.5,
      },
    },
    // Venue/building/level polygons are hidden by default (search-only). Each
    // tints only while it is the selected feature; its outline comes from
    // LAYER_SELECTED_OUTLINE (feature-state driven, unfiltered). Not in
    // CLICKABLE_LAYER_IDS — these are reached via search, not map taps.
    {
      id: LAYER_SELECTABLE_CONTEXT_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("building", "venue", "level"),
      paint: {
        "fill-color": c.selected,
        "fill-opacity": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          0.12,
          0,
        ],
      },
    },

    // 2. Walkable units / rooms
    {
      id: LAYER_WALKWAY_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchWalkwayUnit,
      paint: {
        "fill-color": unitFillColor(c.walkway),
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_WALKWAY_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchWalkwayUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 0.75,
      },
    },
    {
      id: LAYER_ROOM_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchRoomUnit,
      paint: {
        "fill-color": unitFillColor(c.unit),
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_ROOM_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchRoomUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1,
      },
    },
    {
      id: LAYER_UNENCLOSED_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchUnenclosedUnit,
      paint: {
        "fill-color": unitFillColor(c.unitUnenclosed),
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_UNENCLOSED_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchUnenclosedUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1,
      },
    },
    {
      id: LAYER_TRANSIT_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchTransitUnit,
      paint: {
        "fill-color": unitFillColor(c.unitTransit),
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_TRANSIT_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchTransitUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1,
      },
    },
    {
      id: LAYER_RESTROOM_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchRestroomUnit,
      paint: {
        "fill-color": unitFillColor(c.unitRestroom),
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_RESTROOM_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchRestroomUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1,
      },
    },
    {
      id: LAYER_NONPUBLIC_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchNonPublicUnit,
      paint: {
        "fill-color": unitFillColor(c.unitNonPublic),
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_NONPUBLIC_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchNonPublicUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1,
      },
    },

    // 3. Structures, restricted, fixtures, kiosks, details
    {
      id: LAYER_STRUCTURE_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchStructureUnit,
      paint: {
        "fill-color": unitFillColor(c.unit),
        "fill-opacity": 0.92,
      },
    },
    {
      id: LAYER_STRUCTURE_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchStructureUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1,
      },
    },
    {
      id: LAYER_RESTRICTED_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchRestrictedUnit,
      paint: {
        "fill-color": c.restricted,
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_RESTRICTED_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchRestrictedUnit,
      paint: {
        "line-color": c.unitOutline,
        "line-width": 1,
      },
    },
    {
      id: LAYER_FIXTURE_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("fixture"),
      paint: {
        "fill-color": c.unitOutline,
        "fill-opacity": 0.85,
      },
    },
    {
      id: LAYER_FIXTURE_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("fixture"),
      paint: {
        "line-color": c.muted,
        "line-width": 0.75,
      },
    },
    {
      id: LAYER_KIOSK_FILL,
      type: "fill",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("kiosk"),
      paint: {
        "fill-color": c.accentSoft,
        "fill-opacity": 1,
      },
    },
    {
      id: LAYER_KIOSK_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("kiosk"),
      paint: {
        "line-color": c.accent,
        "line-width": 1,
      },
    },
    {
      id: LAYER_DETAIL_LINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("detail"),
      paint: {
        "line-color": c.muted,
        "line-width": 0.8,
        "line-opacity": 0.8,
      },
    },

    // 4. Openings
    {
      id: LAYER_OPENING_LINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("opening"),
      paint: {
        "line-color": c.opening,
        "line-width": 2.5,
      },
    },

    // 5. Amenity + occupant points
    {
      id: LAYER_AMENITY_CIRCLE,
      type: "circle",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("amenity"),
      paint: {
        "circle-radius": 4.5,
        "circle-color": c.accent,
        "circle-stroke-width": 1.25,
        "circle-stroke-color": c.panel,
      },
    },
    {
      id: LAYER_OCCUPANT_CIRCLE,
      type: "circle",
      source: INDOOR_SOURCE_ID,
      filter: matchFeatureType("occupant"),
      paint: {
        "circle-radius": 4.5,
        "circle-color": c.accent,
        "circle-stroke-width": 1.25,
        "circle-stroke-color": c.panel,
      },
    },

    // 6. Hover / selected outlines. Feature-state expressions are not
    // allowed in filters, so both layers cover all features and gate
    // visibility through state-driven line-opacity.
    {
      id: LAYER_HOVER_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      paint: {
        "line-color": c.accent,
        "line-width": 2,
        "line-opacity": [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          0.85,
          0,
        ],
      },
    },
    {
      id: LAYER_SELECTED_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      paint: {
        "line-color": c.selected,
        "line-width": 3.5,
        "line-opacity": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          1,
          0,
        ],
      },
    },
    // Issue-review highlight: independent of hover/selected feature-state so an
    // opened issue can outline its feature without driving map selection.
    {
      id: LAYER_ISSUE_HIGHLIGHT_OUTLINE,
      type: "line",
      source: INDOOR_SOURCE_ID,
      paint: {
        "line-color": c.warning,
        "line-width": 3.5,
        "line-opacity": [
          "case",
          ["boolean", ["feature-state", "issueHighlight"], false],
          1,
          0,
        ],
      },
    },
    // Point-geometry issue highlight: the line outline above renders nothing on
    // amenity/occupant Point features, so gate a warning ring on the same
    // feature-state, still independent of hover/selected.
    {
      id: LAYER_ISSUE_HIGHLIGHT_POINT,
      type: "circle",
      source: INDOOR_SOURCE_ID,
      paint: {
        "circle-radius": 9,
        "circle-color": c.warning,
        "circle-opacity": [
          "case",
          ["boolean", ["feature-state", "issueHighlight"], false],
          0.2,
          0,
        ],
        "circle-stroke-color": c.warning,
        "circle-stroke-width": 2.5,
        "circle-stroke-opacity": [
          "case",
          ["boolean", ["feature-state", "issueHighlight"], false],
          1,
          0,
        ],
      },
    },
  ];

  return layers;
}

/**
 * Directions overlay layers, sourced from `ROUTE_SOURCE_ID` (not the indoor
 * feature source) so route updates never touch venue rendering. Appended
 * after every feature layer — a route always draws on top. Never clickable:
 * taps while picking a route belong to the directions flow, not selection.
 */
export function buildRouteLayers(theme: ViewerTheme): AnyLayer[] {
  const c = theme.colors;
  return [
    {
      id: LAYER_ROUTE_CONNECTOR,
      type: "line",
      source: ROUTE_SOURCE_ID,
      filter: ["==", ["get", "kind"], "connector"],
      paint: {
        "line-color": c.accent,
        "line-width": 2,
        "line-opacity": 0.7,
        "line-dasharray": [1.5, 1.5],
      },
    },
    {
      id: LAYER_ROUTE,
      type: "line",
      source: ROUTE_SOURCE_ID,
      filter: ["==", ["get", "kind"], "segment"],
      paint: {
        "line-color": c.accent,
        "line-width": 4,
        "line-opacity": 0.9,
      },
    },
    {
      id: LAYER_ROUTE_ENDPOINT,
      type: "circle",
      source: ROUTE_SOURCE_ID,
      filter: ["in", ["get", "kind"], ["literal", ["origin", "destination"]]],
      paint: {
        "circle-radius": 6.5,
        "circle-color": c.accent,
        "circle-stroke-width": 2,
        "circle-stroke-color": c.panel,
      },
    },
  ];
}

/**
 * Point-facility symbol overlay, sourced from `FACILITY_SOURCE_ID`. Icon-only
 * (the neutral style ships no glyphs, so the name surfaces in the tap popup,
 * not on the map). Each feature's `icon` property is a pre-resolved image id
 * (a staged marker basename or the pin fallback); `icon-allow-overlap` is
 * left false so MapLibre declutters the dense 2k-plus symbol set by zoom.
 */
export function buildFacilityLayers(): AnyLayer[] {
  return [
    {
      id: LAYER_FACILITY_SYMBOL,
      type: "symbol",
      source: FACILITY_SOURCE_ID,
      filter: ["==", ["get", "kind"], "facility"],
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": 0.5,
        "icon-anchor": "bottom",
        "icon-allow-overlap": false,
        "icon-optional": true,
      },
    },
  ];
}

/** Semantic `kind` gate shared by the four vertical marker layers. */
const verticalLinkFilter = (): FilterSpecification => [
  "==",
  ["get", "kind"],
  "vertical-link",
];

/** Viewport-space offset that keeps the marker clear of its junction. */
const verticalTranslate: [number, number] = [12, -12];

/**
 * Network-review overlay layers, sourced from `NETWORK_SOURCE_ID`. Fixed,
 * theme-independent colors (magenta paths, cyan junctions, magenta offset
 * markers for cross-floor links) keep the generated routing network visually
 * distinct from the directions route accent.
 */
export function buildNetworkLayers(): AnyLayer[] {
  return [
    // Wide, near-invisible hit targets sit beneath the thin visible overlay so
    // editing clicks land on 1.5px paths / 2.5px junctions reliably.
    {
      id: LAYER_NETWORK_PATH_HIT,
      type: "line",
      source: NETWORK_SOURCE_ID,
      filter: ["==", ["get", "kind"], "path"],
      paint: {
        "line-color": "#000000",
        "line-width": 12,
        "line-opacity": 0.01,
      },
    },
    {
      id: LAYER_NETWORK_JUNCTION_HIT,
      type: "circle",
      source: NETWORK_SOURCE_ID,
      filter: ["==", ["get", "kind"], "junction"],
      paint: {
        "circle-radius": 10,
        "circle-color": "#000000",
        "circle-opacity": 0.01,
      },
    },
    {
      id: LAYER_NETWORK_VERTICAL_LINK_HIT,
      type: "circle",
      source: NETWORK_SOURCE_ID,
      filter: verticalLinkFilter(),
      paint: {
        "circle-radius": 12,
        "circle-color": "#000000",
        "circle-opacity": 0.01,
        "circle-translate": verticalTranslate,
        "circle-translate-anchor": "viewport",
      },
    },
    {
      id: LAYER_NETWORK_PATH,
      type: "line",
      source: NETWORK_SOURCE_ID,
      filter: ["==", ["get", "kind"], "path"],
      paint: {
        "line-color": "#d81b8c",
        "line-width": 1.5,
        "line-opacity": 0.85,
      },
    },
    {
      // Selected connection highlight (Ai Indigo), over the base path overlay.
      id: "indoor-network-path-selected",
      type: "line",
      source: NETWORK_SOURCE_ID,
      filter: ["all", ["==", ["get", "kind"], "path"], ["==", ["get", "selected"], true]],
      paint: {
        "line-color": "#4F46E5",
        "line-width": 3,
        "line-opacity": 0.9,
      },
    },
    {
      id: LAYER_NETWORK_VERTICAL_LINK,
      type: "circle",
      source: NETWORK_SOURCE_ID,
      filter: verticalLinkFilter(),
      paint: {
        "circle-radius": 5,
        "circle-color": "#d81b8c",
        "circle-stroke-width": 1,
        "circle-stroke-color": "#ffffff",
        "circle-translate": verticalTranslate,
        "circle-translate-anchor": "viewport",
      },
    },
    {
      id: LAYER_NETWORK_VERTICAL_LINK_SELECTED,
      type: "circle",
      source: NETWORK_SOURCE_ID,
      filter: ["all", ["==", ["get", "kind"], "vertical-link"], ["==", ["get", "selected"], true]],
      paint: {
        "circle-radius": 8,
        "circle-color": "#4F46E5",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
        "circle-translate": verticalTranslate,
        "circle-translate-anchor": "viewport",
      },
    },
    {
      id: LAYER_NETWORK_VERTICAL_LINK_LABEL,
      type: "symbol",
      source: NETWORK_SOURCE_ID,
      filter: verticalLinkFilter(),
      layout: {
        // Glyph-independent label: the indoor style ships no `glyphs` source,
        // so the visible copy is a canvas-rasterized image per (direction,
        // floor) pair, selected through the feature's `labelImage` id (see
        // verticalLinkLabels.ts). 12px right / 12px up keeps it beside the
        // [12,-12]-translated marker.
        "icon-image": ["get", "labelImage"],
        "icon-anchor": "left",
        "icon-offset": [12, -12],
        "icon-allow-overlap": true,
      },
      paint: {},
    },
    {
      id: LAYER_NETWORK_JUNCTION,
      type: "circle",
      source: NETWORK_SOURCE_ID,
      filter: ["==", ["get", "kind"], "junction"],
      paint: {
        "circle-radius": 2.5,
        "circle-color": "#0aa5ff",
        "circle-stroke-width": 0.5,
        "circle-stroke-color": "#ffffff",
      },
    },
    {
      // Selected junction (Ai Indigo, white ring).
      id: "indoor-network-selected",
      type: "circle",
      source: NETWORK_SOURCE_ID,
      filter: ["all", ["==", ["get", "kind"], "junction"], ["==", ["get", "selected"], true]],
      paint: {
        "circle-radius": 5,
        "circle-color": "#4F46E5",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
      },
    },
    {
      // Pending connection origin (Amber) while picking the second endpoint.
      id: "indoor-network-pending",
      type: "circle",
      source: NETWORK_SOURCE_ID,
      filter: ["all", ["==", ["get", "kind"], "junction"], ["==", ["get", "pending"], true]],
      paint: {
        "circle-radius": 6,
        "circle-color": "#D97706",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    },
  ];
}

/** Paint property updates applied on theme switch without rebuilding the style. */
export function applyThemePaintProperties(
  setPaintProperty: (layerId: string, name: string, value: unknown) => void,
  theme: ViewerTheme,
): void {
  const c = theme.colors;

  setPaintProperty(LAYER_CONTEXT_FILL, "fill-color", c.unit);
  setPaintProperty(LAYER_CONTEXT_OUTLINE, "line-color", c.unitOutline);

  setPaintProperty(LAYER_WALKWAY_FILL, "fill-color", unitFillColor(c.walkway));
  setPaintProperty(LAYER_WALKWAY_OUTLINE, "line-color", c.unitOutline);
  setPaintProperty(LAYER_ROOM_FILL, "fill-color", unitFillColor(c.unit));
  setPaintProperty(LAYER_ROOM_OUTLINE, "line-color", c.unitOutline);
  setPaintProperty(LAYER_UNENCLOSED_FILL, "fill-color", unitFillColor(c.unitUnenclosed));
  setPaintProperty(LAYER_UNENCLOSED_OUTLINE, "line-color", c.unitOutline);
  setPaintProperty(LAYER_TRANSIT_FILL, "fill-color", unitFillColor(c.unitTransit));
  setPaintProperty(LAYER_TRANSIT_OUTLINE, "line-color", c.unitOutline);
  setPaintProperty(LAYER_RESTROOM_FILL, "fill-color", unitFillColor(c.unitRestroom));
  setPaintProperty(LAYER_RESTROOM_OUTLINE, "line-color", c.unitOutline);
  setPaintProperty(LAYER_NONPUBLIC_FILL, "fill-color", unitFillColor(c.unitNonPublic));
  setPaintProperty(LAYER_NONPUBLIC_OUTLINE, "line-color", c.unitOutline);

  setPaintProperty(LAYER_STRUCTURE_FILL, "fill-color", unitFillColor(c.unit));
  setPaintProperty(LAYER_STRUCTURE_OUTLINE, "line-color", c.unitOutline);
  setPaintProperty(LAYER_RESTRICTED_FILL, "fill-color", c.restricted);
  setPaintProperty(LAYER_RESTRICTED_OUTLINE, "line-color", c.unitOutline);
  setPaintProperty(LAYER_FIXTURE_FILL, "fill-color", c.unitOutline);
  setPaintProperty(LAYER_FIXTURE_OUTLINE, "line-color", c.muted);
  setPaintProperty(LAYER_KIOSK_FILL, "fill-color", c.accentSoft);
  setPaintProperty(LAYER_KIOSK_OUTLINE, "line-color", c.accent);
  setPaintProperty(LAYER_DETAIL_LINE, "line-color", c.muted);

  setPaintProperty(LAYER_OPENING_LINE, "line-color", c.opening);

  setPaintProperty(LAYER_AMENITY_CIRCLE, "circle-color", c.accent);
  setPaintProperty(LAYER_AMENITY_CIRCLE, "circle-stroke-color", c.panel);
  setPaintProperty(LAYER_OCCUPANT_CIRCLE, "circle-color", c.accent);
  setPaintProperty(LAYER_OCCUPANT_CIRCLE, "circle-stroke-color", c.panel);

  setPaintProperty(LAYER_HOVER_OUTLINE, "line-color", c.accent);
  setPaintProperty(LAYER_SELECTED_OUTLINE, "line-color", c.selected);
  setPaintProperty(LAYER_SELECTABLE_CONTEXT_FILL, "fill-color", c.selected);
  setPaintProperty(LAYER_ISSUE_HIGHLIGHT_OUTLINE, "line-color", c.warning);
  setPaintProperty(LAYER_ISSUE_HIGHLIGHT_POINT, "circle-color", c.warning);
  setPaintProperty(LAYER_ISSUE_HIGHLIGHT_POINT, "circle-stroke-color", c.warning);

  setPaintProperty(LAYER_ROUTE, "line-color", c.accent);
  setPaintProperty(LAYER_ROUTE_CONNECTOR, "line-color", c.accent);
  setPaintProperty(LAYER_ROUTE_ENDPOINT, "circle-color", c.accent);
  setPaintProperty(LAYER_ROUTE_ENDPOINT, "circle-stroke-color", c.panel);

  setPaintProperty(BACKGROUND_LAYER_ID, "background-color", c.canvas);
}
