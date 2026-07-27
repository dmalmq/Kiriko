import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FacilityDto, RouteEndpoint, RouteResultDto } from "../bundle/wasm";
import type { LocaleCode, LoadedVenue } from "../imdf/types";
import type { ViewerTheme } from "../theme/types";
import { buildIndoorStyle, INDOOR_SOURCE_ID } from "./buildIndoorStyle";
import { buildRenderFeatures } from "./buildRenderFeatures";
import {
  applyThemePaintProperties,
  CLICKABLE_LAYER_IDS,
  FACILITY_SOURCE_ID,
  LAYER_FACILITY_SYMBOL,
  LAYER_NETWORK_JUNCTION,
  LAYER_NETWORK_PATH,
  ROUTE_SOURCE_ID,
  NETWORK_SOURCE_ID,
} from "./featureLayers";
import { LAYER_GROUP_IDS, type LayerVisibility } from "./layerGroups";
import { buildRouteFeatures } from "./routeFeatures";
import { buildNetworkFeatures, type ParsedNetwork } from "./networkFeatures";
import { buildFacilityFeatures } from "./facilityFeatures";
import { FACILITY_PIN_IMAGE, MARKER_ICON_URLS } from "./facilityIcons";
import { useFeatureMarkers } from "./useFeatureMarkers";
import { useIssuePins, type MapIssuePin } from "./useIssuePins";
import { levelIdsForOrdinal, ordinalOfLevel } from "../state/floorGroups";

const PLACE_AT_CENTER_LABEL = {
  ja: "地図の中心に配置",
  en: "Place at map center",
} as const;

/** Imperative camera controls exposed to the Kiriko zoom cluster. */
export interface IndoorMapControls {
  zoomIn: () => void;
  zoomOut: () => void;
  fitLevel: () => void;
}

/** Anchor captured when a review issue is placed on the map. */
export interface IssuePlacementAnchor {
  levelId: string;
  longitude: number;
  latitude: number;
  featureId: string | null;
}

/**
 * Single nullable boundary for the review-issue feature. Task 11 passes
 * `null` from App; Task 12 supplies a live controller projection. Keeping it
 * one explicit object avoids optional transitional props and no-op callbacks.
 */
export interface IssueReviewMapProps {
  placementMode: boolean;
  onPlaceIssue: (anchor: IssuePlacementAnchor) => void;
  pins: MapIssuePin[];
  selectedIssueId: string | null;
  onSelectIssue: (issueId: string) => void;
  /** Feature highlighted for the selected issue; separate from map selection. */
  featureId: string | null;
  /** Keyed, race-safe request to center on an issue anchor. */
  cameraRequest: { key: number; levelId: string; longitude: number; latitude: number } | null;
}

/**
 * Directions-mode projection owned by App. While `active`, map taps report
 * raw points through `onPickPoint` (snapping happens in wasm) and ordinary
 * feature selection is suppressed. `route` carries every node; this
 * component segments it per floor so only the active level's parts render.
 */
export interface DirectionsMapProps {
  active: boolean;
  origin: RouteEndpoint | null;
  destination: RouteEndpoint | null;
  route: RouteResultDto | null;
  onPickPoint: (point: { longitude: number; latitude: number }) => void;
}

export interface IndoorMapProps {
  venue: LoadedVenue;
  levelId: string;
  selectedFeatureId: string | null;
  locale: LocaleCode;
  theme: ViewerTheme;
  layerVisibility: LayerVisibility;
  /** null = background click */
  onSelectFeature: (featureId: string | null) => void;
  /** null in Task 11; live review controller in Task 12. */
  issueReview: IssueReviewMapProps | null;
  /** null when the bundle has no §5 graph or Directions is off. */
  directions?: DirectionsMapProps | null;
  /** Receives camera controls once the map exists; null on teardown. */
  onControls?: (controls: IndoorMapControls | null) => void;
  /** Point facilities (§7) to render as symbol markers; empty when absent. */
  facilities?: FacilityDto[];
  /** Invoked when a facility symbol is tapped (outside directions picking). */
  onSelectFacility?: (facility: FacilityDto) => void;
  /** Parsed generated network for floor-by-floor review; null when off. */
  network?: ParsedNetwork | null;
  /** Junction NODEIDs to highlight while editing the review network. */
  selectedJunctions?: ReadonlySet<number> | undefined;
  /** Review edit mode: report a picked network junction or edge on map click. */
  onNetworkPick?: ((pick: { junctionId: number } | { edge: [number, number] }) => void) | undefined;
}

const FIT_PADDING = 48;
const FIT_MAX_ZOOM = 20;
const EASE_DURATION_MS = 450;
const FIT_DURATION_MS = 500;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readFeatureId(
  properties: GeoJSON.GeoJsonProperties | null | undefined,
): string | null {
  if (properties == null) {
    return null;
  }
  const raw = properties["__feature_id"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readLevelId(
  properties: GeoJSON.GeoJsonProperties | null | undefined,
): string | null {
  if (properties == null) {
    return null;
  }
  const raw = properties["__level_id"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function getIndoorSource(map: MapLibreMap): GeoJSONSource | null {
  const source = map.getSource(INDOOR_SOURCE_ID);
  if (source == null || source.type !== "geojson") {
    return null;
  }
  return source as GeoJSONSource;
}

function getRouteSource(map: MapLibreMap): GeoJSONSource | null {
  const source = map.getSource(ROUTE_SOURCE_ID);
  if (source == null || source.type !== "geojson") {
    return null;
  }
  return source as GeoJSONSource;
}

function activeOrdinalFor(venue: LoadedVenue, levelId: string): number | null {
  return venue.levels.find((level) => level.id === levelId)?.ordinal ?? null;
}

function setRouteSourceData(
  map: MapLibreMap,
  venue: LoadedVenue,
  levelId: string,
  directions: DirectionsMapProps | null | undefined,
): void {
  const source = getRouteSource(map);
  if (source == null) {
    return;
  }
  const ordinal = activeOrdinalFor(venue, levelId);
  const active = directions != null && ordinal !== null;
  source.setData(
    buildRouteFeatures(
      active ? { origin: directions.origin, destination: directions.destination, route: directions.route } : null,
      ordinal ?? 0,
    ),
  );
}

function getNetworkSource(map: MapLibreMap): GeoJSONSource | null {
  const source = map.getSource(NETWORK_SOURCE_ID);
  if (source == null || source.type !== "geojson") {
    return null;
  }
  return source as GeoJSONSource;
}

function setNetworkSourceData(
  map: MapLibreMap,
  venue: LoadedVenue,
  levelId: string,
  network: ParsedNetwork | null | undefined,
  selectedJunctions: ReadonlySet<number> | undefined,
): void {
  const source = getNetworkSource(map);
  if (source == null) {
    return;
  }
  const ordinal = activeOrdinalFor(venue, levelId);
  source.setData(
    buildNetworkFeatures(ordinal === null ? null : network ?? null, ordinal ?? 0, selectedJunctions),
  );
}

function getFacilitySource(map: MapLibreMap): GeoJSONSource | null {
  const source = map.getSource(FACILITY_SOURCE_ID);
  if (source == null || source.type !== "geojson") {
    return null;
  }
  return source as GeoJSONSource;
}

function setFacilitySourceData(
  map: MapLibreMap,
  venue: LoadedVenue,
  levelId: string,
  facilities: readonly FacilityDto[],
): void {
  const source = getFacilitySource(map);
  if (source == null) {
    return;
  }
  const ordinal = activeOrdinalFor(venue, levelId);
  source.setData(
    ordinal === null
      ? { type: "FeatureCollection", features: [] }
      : buildFacilityFeatures(facilities, ordinal),
  );
}

/** A neutral round pin used when a facility's icon has no staged asset. */
function buildPinImage(): { width: number; height: number; data: Uint8Array } {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = 6;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (Math.hypot(x - cx, y - cy) <= r) {
        data[i] = 0x4f;
        data[i + 1] = 0x46;
        data[i + 2] = 0xe5;
        data[i + 3] = 0xff;
      }
    }
  }
  return { width: size, height: size, data };
}

/**
 * Register the staged marker icons (and the pin fallback) as MapLibre images.
 * Idempotent: skips ids already present. PNGs load asynchronously; a symbol
 * referencing an image that has not finished loading is simply not drawn yet
 * (`icon-optional`), then appears once the image resolves.
 */
function registerFacilityImages(map: MapLibreMap): void {
  if (!map.hasImage(FACILITY_PIN_IMAGE)) {
    map.addImage(FACILITY_PIN_IMAGE, buildPinImage());
  }
  for (const [name, url] of Object.entries(MARKER_ICON_URLS)) {
    if (map.hasImage(name)) {
      continue;
    }
    void map
      .loadImage(url)
      .then((result) => {
        if (result != null && !map.hasImage(name)) {
          map.addImage(name, result.data);
        }
      })
      .catch(() => {
        /* a missing icon falls back to the pin via icon-image resolution */
      });
  }
}

function fitLevelBounds(
  map: MapLibreMap,
  venue: LoadedVenue,
  levelId: string,
): void {
  // Union bounds across every level sharing this floor's ordinal so a
  // multi-building floor frames all buildings, not just one.
  const ordinal = ordinalOfLevel(venue.levels, levelId);
  const groupLevelIds =
    ordinal === null ? [levelId] : levelIdsForOrdinal(venue.levels, ordinal);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const id of groupLevelIds) {
    const b = venue.boundsByLevel.get(id);
    if (b == null) {
      continue;
    }
    if (b[0] < west) west = b[0];
    if (b[1] < south) south = b[1];
    if (b[2] > east) east = b[2];
    if (b[3] > north) north = b[3];
  }
  if (west === Infinity) {
    return;
  }
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north)
  ) {
    return;
  }
  const reduced = prefersReducedMotion();
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    {
      padding: FIT_PADDING,
      maxZoom: FIT_MAX_ZOOM,
      duration: reduced ? 0 : FIT_DURATION_MS,
    },
  );
}

function setSourceData(
  map: MapLibreMap,
  venue: LoadedVenue,
  levelId: string,
): void {
  const source = getIndoorSource(map);
  if (source == null) {
    return;
  }
  source.setData(buildRenderFeatures(venue, levelId));
}

type FeatureStateKey = "hover" | "selected" | "issueHighlight";

function clearFeatureState(
  map: MapLibreMap,
  featureId: string | null,
  key: FeatureStateKey,
): void {
  if (featureId == null) {
    return;
  }
  try {
    map.removeFeatureState({ source: INDOOR_SOURCE_ID, id: featureId }, key);
  } catch {
    // Source may not be ready yet; ignore.
  }
}

function applyFeatureState(
  map: MapLibreMap,
  featureId: string,
  state: { hover?: boolean; selected?: boolean; issueHighlight?: boolean },
): void {
  try {
    map.setFeatureState({ source: INDOOR_SOURCE_ID, id: featureId }, state);
  } catch {
    // Source may not be ready yet; ignore.
  }
}

/**
 * Wait until the indoor GeoJSON source has finished loading after setData,
 * then run `fn`. Falls back to map idle if sourcedata never reports loaded.
 */
function whenSourceReady(map: MapLibreMap, fn: () => void): () => void {
  let settled = false;
  const run = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    map.off("sourcedata", onSourceData);
    map.off("idle", onIdle);
    fn();
  };

  const onSourceData = (event: {
    sourceId?: string;
    isSourceLoaded?: boolean;
    dataType?: string;
  }): void => {
    if (
      event.sourceId === INDOOR_SOURCE_ID &&
      event.isSourceLoaded === true &&
      (event.dataType === "source" || event.dataType === undefined)
    ) {
      run();
    }
  };

  const onIdle = (): void => {
    run();
  };

  map.on("sourcedata", onSourceData);
  map.once("idle", onIdle);

  // If the source is already loaded (sync setData path), fire on next frame.
  if (map.isSourceLoaded(INDOOR_SOURCE_ID)) {
    queueMicrotask(run);
  }

  return () => {
    settled = true;
    map.off("sourcedata", onSourceData);
    map.off("idle", onIdle);
  };
}

function applyLayerVisibility(map: MapLibreMap, visibility: LayerVisibility): void {
  for (const [group, layerIds] of Object.entries(LAYER_GROUP_IDS)) {
    const visible = visibility[group as keyof LayerVisibility];
    for (const layerId of layerIds) {
      if (map.getLayer(layerId) != null) {
        map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
    }
  }
}

export function IndoorMap({
  venue,
  levelId,
  selectedFeatureId,
  locale,
  theme,
  layerVisibility,
  onSelectFeature,
  issueReview,
  directions = null,
  onControls,
  facilities = [],
  onSelectFacility,
  network,
  selectedJunctions,
  onNetworkPick,
}: IndoorMapProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelectFeature);
  const venueRef = useRef(venue);
  const levelIdRef = useRef(levelId);
  const selectedIdRef = useRef(selectedFeatureId);
  const hoverIdRef = useRef<string | null>(null);
  const appliedSelectedRef = useRef<string | null>(null);
  const appliedIssueHighlightRef = useRef<string | null>(null);
  const appliedCameraKeyRef = useRef<number | null>(null);
  const themeIdRef = useRef(theme.id);
  const cancelReadyRef = useRef<(() => void) | null>(null);
  const cameraCancelRef = useRef<(() => void) | null>(null);
  const issueHighlightCancelRef = useRef<(() => void) | null>(null);
  const visibilityRef = useRef(layerVisibility);
  const onControlsRef = useRef(onControls);
  const issueReviewRef = useRef(issueReview);
  const directionsRef = useRef(directions);
  const networkRef = useRef(network);
  const selectedJunctionsRef = useRef(selectedJunctions);
  const onNetworkPickRef = useRef(onNetworkPick);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);

  onSelectRef.current = onSelectFeature;
  onNetworkPickRef.current = onNetworkPick;
  venueRef.current = venue;
  levelIdRef.current = levelId;
  selectedIdRef.current = selectedFeatureId;
  visibilityRef.current = layerVisibility;
  onControlsRef.current = onControls;
  issueReviewRef.current = issueReview;
  directionsRef.current = directions;
  networkRef.current = network;
  selectedJunctionsRef.current = selectedJunctions;
  const facilitiesRef = useRef(facilities);
  const onSelectFacilityRef = useRef(onSelectFacility);
  facilitiesRef.current = facilities;
  onSelectFacilityRef.current = onSelectFacility;

  const onMarkerSelect = useCallback((featureId: string, center: [number, number]) => {
    const review = issueReviewRef.current;
    if (review?.placementMode === true) {
      review.onPlaceIssue({
        // Grouped floors render markers per building level; the clicked feature's
        // own level is authoritative, falling back to the representative level.
        levelId: venueRef.current.featuresById.get(featureId)?.levelId ?? levelIdRef.current,
        longitude: center[0],
        latitude: center[1],
        featureId,
      });
      return;
    }
    onSelectRef.current(featureId);
  }, []);

  const onIssueSelect = useCallback((issueId: string) => {
    issueReviewRef.current?.onSelectIssue(issueId);
  }, []);

  const onPlaceAtCenter = useCallback(() => {
    const map = mapRef.current;
    const review = issueReviewRef.current;
    if (map == null || review == null) {
      return;
    }
    const center = map.getCenter();
    const features = map.queryRenderedFeatures(map.project([center.lng, center.lat]), {
      layers: [...CLICKABLE_LAYER_IDS],
    });
    review.onPlaceIssue({
      // A feature under the map center owns its level; else the representative.
      levelId: readLevelId(features[0]?.properties) ?? levelIdRef.current,
      longitude: center.lng,
      latitude: center.lat,
      featureId: readFeatureId(features[0]?.properties),
    });
  }, []);

  useFeatureMarkers({
    map: mapInstance,
    venue,
    levelId,
    locale,
    selectedFeatureId,
    enabled: layerVisibility.labels,
    onSelect: onMarkerSelect,
  });

  useIssuePins({
    map: mapInstance,
    levelId,
    pins: issueReview?.pins ?? [],
    selectedIssueId: issueReview?.selectedIssueId ?? null,
    locale,
    levels: venue.levels,
    onSelect: onIssueSelect,
  });

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (container == null || mapRef.current != null) {
      return;
    }

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: buildIndoorStyle(theme),
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        maxPitch: 0,
        center: [0, 0],
        zoom: 1,
      });
    } catch {
      // WebGL unavailable (e.g. jsdom) — leave the empty container.
      return;
    }

    map.touchZoomRotate.disableRotation();

    mapRef.current = map;

    // Kiriko chrome owns zoom/fit and attribution; no MapLibre controls.
    onControlsRef.current?.({
      zoomIn: () => {
        map.zoomIn({ duration: prefersReducedMotion() ? 0 : 200 });
      },
      zoomOut: () => {
        map.zoomOut({ duration: prefersReducedMotion() ? 0 : 200 });
      },
      fitLevel: () => {
        fitLevelBounds(map, venueRef.current, levelIdRef.current);
      },
    });

    const onClick = (event: MapMouseEvent): void => {
      const features = map.queryRenderedFeatures(event.point, {
        layers: [...CLICKABLE_LAYER_IDS],
      });
      const featureId = readFeatureId(features[0]?.properties);
      const review = issueReviewRef.current;
      if (review?.placementMode === true) {
        // Placement captures the clicked point (plus any feature under it) and
        // suppresses ordinary feature selection.
        review.onPlaceIssue({
          // The clicked feature's own level (grouped same-ordinal levels all
          // render) beats the representative level; bare clicks use representative.
          levelId: readLevelId(features[0]?.properties) ?? levelIdRef.current,
          longitude: event.lngLat.lng,
          latitude: event.lngLat.lat,
          featureId,
        });
        return;
      }
      const dirs = directionsRef.current;
      if (dirs?.active === true) {
        // Directions captures the raw point (snapping happens in wasm) and
        // suppresses ordinary feature selection.
        dirs.onPickPoint({ longitude: event.lngLat.lng, latitude: event.lngLat.lat });
        return;
      }

      const netPick = onNetworkPickRef.current;
      if (netPick != null) {
        const hits = map.queryRenderedFeatures(event.point, {
          layers: [LAYER_NETWORK_JUNCTION, LAYER_NETWORK_PATH],
        });
        const props = hits[0]?.properties;
        const nodeId = props?.["NODEID"];
        if (typeof nodeId === "number") {
          netPick({ junctionId: nodeId });
          return;
        }
        const fromId = props?.["FNODEID"];
        const toId = props?.["TNODEID"];
        if (typeof fromId === "number" && typeof toId === "number") {
          netPick({ edge: [fromId, toId] });
          return;
        }
      }
      const facilityHit = map.queryRenderedFeatures(event.point, {
        layers: [LAYER_FACILITY_SYMBOL],
      });
      const facIndex = facilityHit[0]?.properties?.["index"];
      if (typeof facIndex === "number") {
        const facility = facilitiesRef.current[facIndex];
        if (facility !== undefined) {
          onSelectFacilityRef.current?.(facility);
          return;
        }
      }
      onSelectRef.current(featureId);
    };

    const onMouseMove = (event: MapMouseEvent): void => {
      const features = map.queryRenderedFeatures(event.point, {
        layers: [...CLICKABLE_LAYER_IDS],
      });
      const nextId = readFeatureId(features[0]?.properties);
      const prevId = hoverIdRef.current;
      if (prevId === nextId) {
        map.getCanvas().style.cursor = nextId != null ? "pointer" : "";
        return;
      }
      if (prevId != null) {
        clearFeatureState(map, prevId, "hover");
      }
      if (nextId != null) {
        applyFeatureState(map, nextId, { hover: true });
        map.getCanvas().style.cursor = "pointer";
      } else {
        map.getCanvas().style.cursor = "";
      }
      hoverIdRef.current = nextId;
    };

    const onMouseLeave = (): void => {
      if (hoverIdRef.current != null) {
        clearFeatureState(map, hoverIdRef.current, "hover");
        hoverIdRef.current = null;
      }
      map.getCanvas().style.cursor = "";
    };

    const onLoad = (): void => {
      setSourceData(map, venueRef.current, levelIdRef.current);
      setRouteSourceData(map, venueRef.current, levelIdRef.current, directionsRef.current);
      setNetworkSourceData(map, venueRef.current, levelIdRef.current, networkRef.current, selectedJunctionsRef.current);
      registerFacilityImages(map);
      setFacilitySourceData(map, venueRef.current, levelIdRef.current, facilitiesRef.current);
      applyLayerVisibility(map, visibilityRef.current);
      fitLevelBounds(map, venueRef.current, levelIdRef.current);
      setMapInstance(map);

      const selected = selectedIdRef.current;
      if (selected != null) {
        cancelReadyRef.current?.();
        cancelReadyRef.current = whenSourceReady(map, () => {
          applyFeatureState(map, selected, { selected: true });
          appliedSelectedRef.current = selected;
        });
      }
    };

    map.on("load", onLoad);
    map.on("click", onClick);
    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseLeave);

    const markIdle = (): void => {
      container.dataset.mapIdle = "true";
    };
    const clearIdle = (): void => {
      delete container.dataset.mapIdle;
    };
    map.on("idle", markIdle);
    map.on("dataloading", clearIdle);
    map.on("movestart", clearIdle);
    map.on("move", clearIdle);

    return () => {
      cancelReadyRef.current?.();
      cancelReadyRef.current = null;
      cameraCancelRef.current?.();
      cameraCancelRef.current = null;
      issueHighlightCancelRef.current?.();
      issueHighlightCancelRef.current = null;
      map.off("load", onLoad);
      map.off("click", onClick);
      map.off("mousemove", onMouseMove);
      map.off("mouseout", onMouseLeave);
      map.off("idle", markIdle);
      map.off("dataloading", clearIdle);
      map.off("movestart", clearIdle);
      map.off("move", clearIdle);
      onControlsRef.current?.(null);
      map.remove();
      mapRef.current = null;
      setMapInstance(null);
      hoverIdRef.current = null;
      appliedSelectedRef.current = null;
      appliedIssueHighlightRef.current = null;
      appliedCameraKeyRef.current = null;
    };
    // Map is created once; theme/venue/level are applied via later effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Level or venue change: replace source data and fit bounds.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }

    cancelReadyRef.current?.();
    cancelReadyRef.current = null;

    // Clear prior selection state before data swap.
    if (appliedSelectedRef.current != null) {
      clearFeatureState(map, appliedSelectedRef.current, "selected");
      appliedSelectedRef.current = null;
    }
    if (hoverIdRef.current != null) {
      clearFeatureState(map, hoverIdRef.current, "hover");
      hoverIdRef.current = null;
    }

    setSourceData(map, venue, levelId);
    setNetworkSourceData(map, venue, levelId, network, selectedJunctions);
    fitLevelBounds(map, venue, levelId);

    const selected = selectedIdRef.current;
    if (selected != null) {
      cancelReadyRef.current = whenSourceReady(map, () => {
        const feature = venueRef.current.featuresById.get(selected);
        if (feature == null || feature.center == null) {
          return;
        }
        applyFeatureState(map, selected, { selected: true });
        appliedSelectedRef.current = selected;

        const reduced = prefersReducedMotion();
        if (reduced) {
          map.jumpTo({ center: feature.center });
        } else {
          map.easeTo({
            center: feature.center,
            duration: EASE_DURATION_MS,
          });
        }
      });
    }
  }, [venue, levelId]);

  // Selection change (same level): update feature-state + camera.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }

    const prev = appliedSelectedRef.current;
    if (prev === selectedFeatureId) {
      return;
    }

    if (prev != null) {
      clearFeatureState(map, prev, "selected");
      appliedSelectedRef.current = null;
    }

    if (selectedFeatureId == null) {
      return;
    }

    const feature = venue.featuresById.get(selectedFeatureId);
    if (feature == null) {
      return;
    }

    const applySelection = (): void => {
      // null center → retain camera and render no highlight
      if (feature.center == null) {
        return;
      }
      applyFeatureState(map, selectedFeatureId, { selected: true });
      appliedSelectedRef.current = selectedFeatureId;

      const reduced = prefersReducedMotion();
      if (reduced) {
        map.jumpTo({ center: feature.center });
      } else {
        map.easeTo({
          center: feature.center,
          duration: EASE_DURATION_MS,
        });
      }
    };

    // If the feature is on another level, the level effect owns reapplication
    // after source replacement. When already on the feature's level (or null
    // levelId keeps current), apply immediately once the source is ready.
    if (feature.levelId != null && feature.levelId !== levelId) {
      return;
    }

    cancelReadyRef.current?.();
    cancelReadyRef.current = whenSourceReady(map, applySelection);
  }, [selectedFeatureId, venue, levelId]);

  // Issue feature highlight: separate feature-state from map selection, so
  // opening an issue never drives viewerReducer.selectedFeatureId / Inspector.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }

    // Cancel any pending readiness work before clearing/reapplying so a
    // superseded highlight can never fire late.
    issueHighlightCancelRef.current?.();
    issueHighlightCancelRef.current = null;

    const nextId = issueReview?.featureId ?? null;
    if (appliedIssueHighlightRef.current != null) {
      clearFeatureState(map, appliedIssueHighlightRef.current, "issueHighlight");
      appliedIssueHighlightRef.current = null;
    }
    if (nextId == null) {
      return;
    }

    issueHighlightCancelRef.current = whenSourceReady(map, () => {
      // Re-check the current requested feature + active floor so a stale source
      // event cannot set an obsolete highlight after the selection changed.
      if ((issueReviewRef.current?.featureId ?? null) !== nextId) {
        return;
      }
      if (levelIdRef.current !== levelId) {
        return;
      }
      applyFeatureState(map, nextId, { issueHighlight: true });
      appliedIssueHighlightRef.current = nextId;
    });
  }, [issueReview?.featureId, venue, levelId]);

  // Keyed anchor-camera request: switch floor first (App owns levelId), then
  // center only after the new floor's source is ready. Reduced motion jumps.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }

    // Cancel any pending readiness work before every early return / key / floor
    // change, so a superseded or wrong-floor request can never center late.
    cameraCancelRef.current?.();
    cameraCancelRef.current = null;

    const request = issueReview?.cameraRequest ?? null;
    if (request == null || request.key === appliedCameraKeyRef.current) {
      return;
    }
    // Wait for App to select the requested floor; this effect reruns when
    // `levelId` updates and then centers once the source has applied.
    if (request.levelId !== levelId) {
      return;
    }

    cameraCancelRef.current = whenSourceReady(map, () => {
      // Re-check against the live request + active floor. A stale source event
      // must not center wrong-floor coordinates, and the key is marked applied
      // only here so an interrupted request can still retry later.
      const current = issueReviewRef.current?.cameraRequest ?? null;
      if (current == null || current.key !== request.key) {
        return;
      }
      if (levelIdRef.current !== request.levelId) {
        return;
      }
      appliedCameraKeyRef.current = request.key;
      const center: [number, number] = [request.longitude, request.latitude];
      if (prefersReducedMotion()) {
        map.jumpTo({ center });
      } else {
        map.easeTo({ center, duration: EASE_DURATION_MS });
      }
    });
  }, [issueReview?.cameraRequest, levelId]);

  // Directions overlay: re-segment the route per active floor whenever the
  // route, endpoints, floor, or venue change; empty when Directions is off.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }
    setRouteSourceData(map, venue, levelId, directions);
  }, [directions, venue, levelId]);

  // Network-review overlay: re-filter the generated network to the active
  // floor whenever it, the floor, or the venue changes; empty when off.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }
    setNetworkSourceData(map, venue, levelId, network, selectedJunctions);
  }, [network, selectedJunctions, venue, levelId]);

  // Facility symbols: refresh per active floor (and when the facility set or
  // venue changes). Icons are registered once on load.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }
    setFacilitySourceData(map, venue, levelId, facilities);
  }, [facilities, venue, levelId]);

  // Layer-group visibility toggles (Layers panel).
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }
    applyLayerVisibility(map, layerVisibility);
  }, [layerVisibility]);

  // Theme switch: paint properties only — never rebuild style/map.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }
    if (themeIdRef.current === theme.id) {
      // Still apply paints so token-level edits refresh even if id is reused.
    }
    themeIdRef.current = theme.id;
    applyThemePaintProperties((layerId, name, value) => {
      if (map.getLayer(layerId) != null) {
        map.setPaintProperty(layerId, name, value);
      }
    }, theme);
  }, [theme]);

  return (
    <>
      <div
        ref={containerRef}
        className="indoor-map"
        role="application"
        aria-label="Indoor map"
        style={{ width: "100%", height: "100%" }}
      />
      {issueReview?.placementMode === true ? (
        <button type="button" className="issue-place-center" onClick={onPlaceAtCenter}>
          {PLACE_AT_CENTER_LABEL[locale]}
        </button>
      ) : null}
    </>
  );
}
