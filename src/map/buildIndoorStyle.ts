import type { StyleSpecification } from "maplibre-gl";
import type { ViewerTheme } from "../theme/types";
import {
  BACKGROUND_LAYER_ID,
  buildFacilityLayers,
  buildFeatureLayers,
  buildNetworkLayers,
  buildRouteLayers,
  FACILITY_SOURCE_ID,
  INDOOR_SOURCE_ID,
  NETWORK_SOURCE_ID,
  ROUTE_SOURCE_ID,
} from "./featureLayers";
import {
  FLOOR_ELEVATION_SOURCE_ID,
  floorElevationSource,
} from "./scene/floorElevation";

export { BACKGROUND_LAYER_ID, INDOOR_SOURCE_ID };

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Neutral-canvas style with promoted-id GeoJSON overlays and one dormant,
 * in-memory floor-elevation source. No source reaches the network.
 */
export function buildIndoorStyle(theme: ViewerTheme): StyleSpecification {
  return {
    version: 8,
    name: "imdf-indoor",
    sources: {
      [INDOOR_SOURCE_ID]: {
        type: "geojson",
        data: EMPTY_COLLECTION,
        promoteId: "__feature_id",
      },
      [ROUTE_SOURCE_ID]: {
        type: "geojson",
        data: EMPTY_COLLECTION,
      },
      [FACILITY_SOURCE_ID]: {
        type: "geojson",
        data: EMPTY_COLLECTION,
      },
      [NETWORK_SOURCE_ID]: {
        type: "geojson",
        data: EMPTY_COLLECTION,
      },
      [FLOOR_ELEVATION_SOURCE_ID]: floorElevationSource(),
    },
    layers: [
      {
        id: BACKGROUND_LAYER_ID,
        type: "background",
        paint: {
          "background-color": theme.colors.canvas,
        },
      },
      ...buildFeatureLayers(theme),
      ...buildFacilityLayers(),
      ...buildRouteLayers(theme),
      ...buildNetworkLayers(),
    ],
  };
}
