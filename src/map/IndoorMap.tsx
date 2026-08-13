import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { SceneLayer, SCENE_DIAGNOSTICS_KEY } from "./scene/sceneLayer";
import { useSceneLabels } from "./scene/useSceneLabels";
import { CONTEXT_HANDOFF_MS } from "./scene/scenePolicy";
import type { SceneView } from "./scene/sceneFormat";
import {
  FLOOR_ELEVATION_PROTOCOL,
  FLOOR_ELEVATION_SOURCE_ID,
  createFloorElevationProtocol,
  floorElevationTileUrl,
  floorElevationSource,
} from "./scene/floorElevation";
import {
  resolveSceneFloorState,
  type SceneFloorState,
} from "./scene/sceneFloorState";
import maplibregl, {
  type GeoJSONSource,
  type GeoJSONSourceDiff,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type PointLike,
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
  LAYER_NETWORK_JUNCTION_HIT,
  LAYER_NETWORK_PATH_HIT,
  LAYER_NETWORK_VERTICAL_LINK_HIT,
  ROUTE_SOURCE_ID,
  NETWORK_SOURCE_ID,
} from "./featureLayers";
import { LAYER_GROUP_IDS, type LayerVisibility } from "./layerGroups";
import { buildRouteFeatures } from "./routeFeatures";
import { registerVerticalLinkLabelImages } from "./verticalLinkLabels";
import {
  buildNetworkFeatures,
  type NetworkConnectionId,
  type NetworkRenderState,
  type ParsedNetwork,
} from "./networkFeatures";
import type { NetworkEditTool, NetworkMapPick, NetworkSelection } from "./networkEditor";
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

/**
 * Network-editing projection owned by App. While present, map taps report
 * semantic {@link NetworkMapPick}s through `onPick` (junction/connection when a
 * hit layer is under the pointer, otherwise a bare coordinate) and ordinary
 * feature selection is suppressed. Add/Move tools always report a coordinate so
 * points can be placed precisely; other tools hit-test junctions then paths.
 */
export interface NetworkEditingMapProps {
  tool: NetworkEditTool;
  selection: NetworkSelection;
  pendingNodeId: number | null;
  onPick: (pick: NetworkMapPick) => void;
  /** Localized label for the keyboard-operable map-center pick action. */
  centerActionLabel: string;
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
  /** Active network-editing controller; null when not editing. */
  networkEditing?: NetworkEditingMapProps | null;
  /**
   * The venue's 3D scene, when one is loaded and 3D was chosen. `null` keeps
   * the viewer exactly 2D — no layer is created and the camera stays flat.
   */
  scene?: SceneView | null;
  /** The GL context was lost; 3D is down until it returns. */
  onSceneContextLost?: () => void;
  /** The context came back and the scene layer was re-established. */
  onSceneContextRestored?: () => void;
  /** The layer could not be created on this context. */
  onSceneAttachFailed?: () => void;
  /**
   * Keep the WebGL drawing buffer readable after each frame, so a test can
   * assert on the pixels the renderer produced (#26 section 5). Costs frame
   * time, so it is opt-in and off for reviewers.
   */
  preserveDrawingBuffer?: boolean;
}

/**
 * Whether the map's style can carry a layer right now. A context loss leaves
 * MapLibre rebuilding its style, and calling into it during that window throws
 * from inside the library rather than returning false.
 */
function styleReady(map: MapLibreMap): boolean {
  try {
    return map.isStyleLoaded() === true;
  } catch {
    return false;
  }
}

/** The scene layer's id; also the handle the e2e harness reads stats through. */
const SCENE_LAYER_ID = "kiriko-scene";

/** #23 D7: MapLibre keeps the camera, and 60° stays its ceiling. */
const SCENE_MAX_PITCH = 60;

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

function sceneFloorSourcesReady(map: MapLibreMap): boolean {
  try {
    return (
      map.isSourceLoaded(FLOOR_ELEVATION_SOURCE_ID) === true &&
      map.isSourceLoaded(INDOOR_SOURCE_ID) === true
    );
  } catch {
    return false;
  }
}

function whenFloorElevationReady(
  map: MapLibreMap,
  fn: () => void,
): () => void {
  let settled = false;
  const runWhenReady = (): void => {
    if (settled || !sceneFloorSourcesReady(map)) {
      return;
    }
    settled = true;
    map.off("sourcedata", onSourceData);
    fn();
  };
  const onSourceData = (event: {
    sourceId?: string;
    isSourceLoaded?: boolean;
    dataType?: string;
  }): void => {
    if (
      (event.sourceId === FLOOR_ELEVATION_SOURCE_ID ||
        event.sourceId === INDOOR_SOURCE_ID) &&
      event.isSourceLoaded === true &&
      (event.dataType === "source" || event.dataType === undefined)
    ) {
      runWhenReady();
    }
  };

  map.on("sourcedata", onSourceData);
  runWhenReady();

  return () => {
    settled = true;
    map.off("sourcedata", onSourceData);
  };
}


const EMPTY_SCENE_FLOOR_STATE: SceneFloorState = {
  activeLevelIndices: [],
  contextLevelIndices: [],
  activePlaneM: null,
};

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
  const active = directions?.active === true && ordinal !== null;
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
  render: NetworkRenderState | undefined,
): void {
  const source = getNetworkSource(map);
  if (source == null) {
    return;
  }
  const ordinal = activeOrdinalFor(venue, levelId);
  const features = buildNetworkFeatures(
    ordinal === null ? null : network ?? null,
    ordinal ?? 0,
    render,
  );
  // The indoor style ships no glyphs, so vertical-link labels are registered
  // style images (one per direction/floor pair) referenced via `labelImage`.
  registerVerticalLinkLabelImages(map, features.features);
  source.setData(features);
}

/** Per-floor highlight state from the App-owned editing projection. */
function networkRenderState(editing: NetworkEditingMapProps): NetworkRenderState {
  const { selection, tool, pendingNodeId } = editing;
  return {
    selectedJunctionId: selection?.kind === "junction" ? selection.nodeId : null,
    selectedConnection: selection?.kind === "connection" ? selection.connectionId : null,
    // Amber pending marker is a connect-origin affordance only.
    pendingJunctionId: tool === "connect" ? pendingNodeId : null,
  };
}
/**
 * Resolve a click/center point to a semantic network pick. Move (and, for a
 * bare click, Add) want a coordinate; every other tool hit-tests the wide
 * junction layer, then the translated vertical marker, then the wide path
 * layer, before falling back to a coordinate. Connection picks normalize the
 * reciprocal id pair so `pathId < reversePathId` always holds.
 */
function networkPickAt(
  map: MapLibreMap,
  point: PointLike,
  lngLat: { lng: number; lat: number },
  tool: NetworkEditTool,
): NetworkMapPick {
  if (tool !== "move-junction") {
    const junctionHits = map.queryRenderedFeatures(point, { layers: [LAYER_NETWORK_JUNCTION_HIT] });
    const nodeId = junctionHits[0]?.properties?.["NODEID"];
    if (typeof nodeId === "number") {
      return { kind: "junction", nodeId };
    }
    const verticalHits = map.queryRenderedFeatures(point, {
      layers: [LAYER_NETWORK_VERTICAL_LINK_HIT],
    });
    const verticalProps = verticalHits[0]?.properties;
    const verticalPathId = verticalProps?.["PATHID"];
    const verticalReversePathId = verticalProps?.["RPATHID"];
    if (typeof verticalPathId === "number" && typeof verticalReversePathId === "number") {
      return {
        kind: "connection",
        connectionId: {
          pathId: Math.min(verticalPathId, verticalReversePathId),
          reversePathId: Math.max(verticalPathId, verticalReversePathId),
        },
      };
    }
    const pathHits = map.queryRenderedFeatures(point, { layers: [LAYER_NETWORK_PATH_HIT] });
    const props = pathHits[0]?.properties;
    const pathId = props?.["PATHID"];
    const reversePathId = props?.["RPATHID"];
    if (typeof pathId === "number" && typeof reversePathId === "number") {
      const connectionId: NetworkConnectionId = {
        pathId: Math.min(pathId, reversePathId),
        reversePathId: Math.max(pathId, reversePathId),
      };
      return { kind: "connection", connectionId };
    }
  }
  return { kind: "map", longitude: lngLat.lng, latitude: lngLat.lat };
}

/** Cursor feedback for the active editing tool over the wide hit layers. */
function updateNetworkCursor(
  map: MapLibreMap,
  point: PointLike,
  tool: NetworkEditTool,
): void {
  const canvas = map.getCanvas();
  if (tool === "add-junction" || tool === "move-junction") {
    canvas.style.cursor = "crosshair";
    return;
  }
  const overData =
    map.queryRenderedFeatures(point, { layers: [LAYER_NETWORK_JUNCTION_HIT] }).length > 0 ||
    map.queryRenderedFeatures(point, { layers: [LAYER_NETWORK_VERTICAL_LINK_HIT] }).length > 0 ||
    map.queryRenderedFeatures(point, { layers: [LAYER_NETWORK_PATH_HIT] }).length > 0;
  if (tool === "delete") {
    canvas.style.cursor = overData ? "pointer" : "not-allowed";
    return;
  }
  canvas.style.cursor = overData ? "pointer" : "";
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
  const bounds: [[number, number], [number, number]] = [
    [west, south],
    [east, north],
  ];
  const reduced = prefersReducedMotion();
  const options = {
    padding: FIT_PADDING,
    maxZoom: FIT_MAX_ZOOM,
    duration: reduced ? 0 : FIT_DURATION_MS,
  };

  // Re-fitting an already exact camera still makes MapLibre expire and rebuild
  // the visible GeoJSON tiles. Floors in one building commonly share bounds,
  // so avoid that no-op invalidation while retaining the normal refit after a
  // user pan or for a floor whose bounds differ.
  const camera = map.cameraForBounds(bounds, options);
  if (
    camera?.center != null &&
    typeof camera.zoom === "number" &&
    typeof camera.bearing === "number"
  ) {
    const center = map.getCenter();
    const targetLng = Array.isArray(camera.center)
      ? camera.center[0]
      : "lng" in camera.center
        ? camera.center.lng
        : camera.center.lon;
    const targetLat = Array.isArray(camera.center) ? camera.center[1] : camera.center.lat;
    const epsilon = 1e-7;
    if (
      Math.abs(center.lng - targetLng) <= epsilon &&
      Math.abs(center.lat - targetLat) <= epsilon &&
      Math.abs(map.getZoom() - camera.zoom) <= epsilon &&
      Math.abs(map.getBearing() - camera.bearing) <= epsilon
    ) {
      return;
    }
  }

  map.fitBounds(bounds, options);
}

interface IndoorSourceState {
  venue: LoadedVenue;
  data: GeoJSON.FeatureCollection;
}

function renderFeatureId(feature: GeoJSON.Feature): string | number | null {
  if (typeof feature.id === "string" || typeof feature.id === "number") {
    return feature.id;
  }
  const promoted = feature.properties?.["__feature_id"];
  return typeof promoted === "string" || typeof promoted === "number" ? promoted : null;
}

function sameRenderFeature(left: GeoJSON.Feature, right: GeoJSON.Feature): boolean {
  if (left === right) {
    return true;
  }
  if (left.geometry !== right.geometry) {
    return false;
  }
  const leftProperties = left.properties ?? {};
  const rightProperties = right.properties ?? {};
  const leftKeys = Object.keys(leftProperties);
  const rightKeys = Object.keys(rightProperties);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(leftProperties[key], rightProperties[key]))
  );
}

/**
 * Build an ID-based floor delta for one immutable venue. Shared context and
 * same-ordinal features stay in the worker index; only departed/arriving or
 * changed features are removed/added. null falls back to a full setData when
 * IDs are missing or duplicated.
 */
export function buildIndoorSourceDiff(
  previous: GeoJSON.FeatureCollection,
  next: GeoJSON.FeatureCollection,
): GeoJSONSourceDiff | null {
  const previousById = new Map<string | number, GeoJSON.Feature>();
  const nextById = new Map<string | number, GeoJSON.Feature>();
  for (const [features, byId] of [
    [previous.features, previousById],
    [next.features, nextById],
  ] as const) {
    for (const feature of features) {
      const id = renderFeatureId(feature);
      if (id === null || byId.has(id)) {
        return null;
      }
      byId.set(id, feature);
    }
  }

  const remove: Array<string | number> = [];
  const add: GeoJSON.Feature[] = [];
  for (const [id, previousFeature] of previousById) {
    const nextFeature = nextById.get(id);
    if (nextFeature === undefined || !sameRenderFeature(previousFeature, nextFeature)) {
      remove.push(id);
    }
  }
  for (const [id, nextFeature] of nextById) {
    const previousFeature = previousById.get(id);
    if (previousFeature === undefined || !sameRenderFeature(previousFeature, nextFeature)) {
      add.push(nextFeature);
    }
  }
  return {
    ...(remove.length > 0 ? { remove } : {}),
    ...(add.length > 0 ? { add } : {}),
  };
}

function setSourceData(
  map: MapLibreMap,
  venue: LoadedVenue,
  levelId: string,
): GeoJSON.FeatureCollection | null {
  const source = getIndoorSource(map);
  if (source == null) {
    return null;
  }
  const data = buildRenderFeatures(venue, levelId);
  source.setData(data);
  return data;
}

function updateSourceData(
  map: MapLibreMap,
  venue: LoadedVenue,
  levelId: string,
  previous: IndoorSourceState | null,
): IndoorSourceState | null {
  const source = getIndoorSource(map);
  if (source == null) {
    return null;
  }
  const data = buildRenderFeatures(venue, levelId);
  const diff = previous?.venue === venue ? buildIndoorSourceDiff(previous.data, data) : null;
  if (diff === null) {
    source.setData(data);
  } else if (diff.remove !== undefined || diff.add !== undefined || diff.update !== undefined) {
    source.updateData(diff);
  }
  return { venue, data };
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

const EMPTY_FACILITIES: FacilityDto[] = [];

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
  facilities = EMPTY_FACILITIES,
  onSelectFacility,
  network,
  networkEditing = null,
  scene = null,
  onSceneContextLost,
  onSceneContextRestored,
  onSceneAttachFailed,
  preserveDrawingBuffer = false,
}: IndoorMapProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelectFeature);
  const sceneLayerRef = useRef<SceneLayer | null>(null);
  // The attached layer as state, so the label overlay re-runs when it appears
  // or goes away; the ref stays for the event handlers that fire per frame.
  const [sceneLabelLayer, setSceneLabelLayer] = useState<SceneLayer | null>(null);
  const scenePickPendingRef = useRef(false);
  const scenePointRef = useRef<{ x: number; y: number } | null>(null);
  // Read through a ref: the map is created once, and this must not re-create it.
  const preserveDrawingBufferRef = useRef(preserveDrawingBuffer);
  const onSceneAttachFailedRef = useRef(onSceneAttachFailed);
  const onSceneContextLostRef = useRef(onSceneContextLost);
  const onSceneContextRestoredRef = useRef(onSceneContextRestored);
  const selectedFeatureIdRef = useRef(selectedFeatureId);
  const venueRef = useRef(venue);
  const levelIdRef = useRef(levelId);
  const sceneRef = useRef(scene);
  const selectedIdRef = useRef(selectedFeatureId);
  const floorElevationUrlRef = useRef<string | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  const appliedSelectedRef = useRef<string | null>(null);
  const floorElevationAttachedUrlRef = useRef<string | null>(null);
  const desiredSceneFloorStateRef = useRef<SceneFloorState>(
    EMPTY_SCENE_FLOOR_STATE,
  );
  const mapStyleAvailableRef = useRef(false);
  const initialMapLoadCompleteRef = useRef(false);
  const appliedIssueHighlightRef = useRef<string | null>(null);
  const appliedCameraKeyRef = useRef<number | null>(null);
  const themeIdRef = useRef(theme.id);
  const cancelReadyRef = useRef<(() => void) | null>(null);
  const floorElevationReadyCancelRef = useRef<(() => void) | null>(null);
  const cameraCancelRef = useRef<(() => void) | null>(null);
  const issueHighlightCancelRef = useRef<(() => void) | null>(null);
  const visibilityRef = useRef(layerVisibility);
  const onControlsRef = useRef(onControls);
  const issueReviewRef = useRef(issueReview);
  const directionsRef = useRef(directions);
  const networkRef = useRef(network);
  const networkEditingRef = useRef(networkEditing);
  const routeSourceActiveRef = useRef(directions?.active === true);
  const networkSourceActiveRef = useRef(network != null || networkEditing != null);
  const facilitySourceActiveRef = useRef(facilities.length > 0);
  const indoorSourceStateRef = useRef<IndoorSourceState | null>(null);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);

  onSelectRef.current = onSelectFeature;
  networkEditingRef.current = networkEditing;
  venueRef.current = venue;
  levelIdRef.current = levelId;
  selectedFeatureIdRef.current = selectedFeatureId;
  onSceneAttachFailedRef.current = onSceneAttachFailed;
  onSceneContextLostRef.current = onSceneContextLost;
  onSceneContextRestoredRef.current = onSceneContextRestored;
  selectedIdRef.current = selectedFeatureId;
  visibilityRef.current = layerVisibility;
  onControlsRef.current = onControls;
  issueReviewRef.current = issueReview;
  directionsRef.current = directions;
  networkRef.current = network;
  sceneRef.current = scene;
  const facilitiesRef = useRef(facilities);
  const onSelectFacilityRef = useRef(onSelectFacility);
  facilitiesRef.current = facilities;
  onSelectFacilityRef.current = onSelectFacility;

  const overlayStyleWaitingRef = useRef(false);
  const overlayWaiterRef = useRef<(() => void) | null>(null);

  const syncSceneFloorState = useCallback(
    (
      map: MapLibreMap,
      currentScene: SceneView | null,
      currentLevelId: string,
      route: RouteResultDto | null,
      currentVenue: LoadedVenue,
    ): SceneFloorState => {
      const floorState =
        currentScene === null
          ? EMPTY_SCENE_FLOOR_STATE
          : resolveSceneFloorState(
              currentScene,
              currentVenue.levels,
              currentLevelId,
              route,
            );
      desiredSceneFloorStateRef.current = floorState;
      const applyDesiredSceneLevels = (): void => {
        const desired = desiredSceneFloorStateRef.current;
        sceneLayerRef.current?.setActiveLevels(desired.activeLevelIndices);
        sceneLayerRef.current?.setContextLevels(desired.contextLevelIndices);
      };

      // `isStyleLoaded()` also becomes false for transient source work. Once
      // the initial style exists, source replacement and terrain mutation stay
      // legal; only initial construction or context loss blocks style calls.
      if (!styleReady(map) && !mapStyleAvailableRef.current) {
        return floorState;
      }

      const tileUrl = floorElevationTileUrl(floorState.activePlaneM ?? Number.NaN);
      const attachTerrain = (): void => {
        if (
          floorElevationUrlRef.current !== tileUrl ||
          tileUrl === null ||
          floorElevationTileUrl(
            desiredSceneFloorStateRef.current.activePlaneM ?? Number.NaN,
          ) !== tileUrl
        ) {
          return;
        }
        floorElevationReadyCancelRef.current = null;
        map.setTerrain({
          source: FLOOR_ELEVATION_SOURCE_ID,
          exaggeration: 1,
        });
        floorElevationAttachedUrlRef.current = tileUrl;
        applyDesiredSceneLevels();
        map.triggerRepaint();
      };

      if (tileUrl === null) {
        floorElevationReadyCancelRef.current?.();
        floorElevationReadyCancelRef.current = null;
        if (floorElevationAttachedUrlRef.current !== null) {
          map.setTerrain(null);
          floorElevationAttachedUrlRef.current = null;
        }
        floorElevationUrlRef.current = null;
        applyDesiredSceneLevels();
      } else if (floorElevationUrlRef.current !== tileUrl) {
        floorElevationReadyCancelRef.current?.();
        floorElevationReadyCancelRef.current = null;
        if (floorElevationAttachedUrlRef.current !== null) {
          map.setTerrain(null);
          floorElevationAttachedUrlRef.current = null;
        }
        floorElevationUrlRef.current = tileUrl;
        // Arm the waiter before mutating: a synchronous `sourcedata` from the
        // mutation must land on it. The source is never removed to swap — it
        // is retargeted in place — because MapLibre answers `isSourceLoaded`
        // against the live manager map, and a remove/add window makes that
        // probe throw from inside the library's own render loop.
        floorElevationReadyCancelRef.current = whenFloorElevationReady(
          map,
          attachTerrain,
        );
        const existing = map.getSource(FLOOR_ELEVATION_SOURCE_ID);
        if (existing != null && "setTiles" in existing) {
          (existing as { setTiles: (tiles: string[]) => void }).setTiles([tileUrl]);
        } else {
          if (existing != null) {
            map.removeSource(FLOOR_ELEVATION_SOURCE_ID);
          }
          map.addSource(FLOOR_ELEVATION_SOURCE_ID, {
            ...floorElevationSource(),
            tiles: [tileUrl],
          });
        }
      } else if (floorElevationAttachedUrlRef.current === tileUrl) {
        applyDesiredSceneLevels();
      } else if (floorElevationReadyCancelRef.current === null) {
        floorElevationReadyCancelRef.current = whenFloorElevationReady(
          map,
          attachTerrain,
        );
      }
      map.triggerRepaint();
      return floorState;
    },
    [],
  );
  // False until onLoad finishes its one-time source/overlay initialization.
  // The unified overlay effect must not arm a sourcedata waiter (or write)
  // before that, or onLoad and the waiter can each apply the same data.

  // Applies every overlay from the latest refs; each overlay keeps its
  // "update only while active, clear exactly once" guard. Call only when the
  // style is fully loaded.
  const applyOverlays = useCallback((): void => {
    const map = mapRef.current;
    if (map == null || !map.isStyleLoaded()) {
      return;
    }
    const venue = venueRef.current;
    const levelId = levelIdRef.current;

    const dirs = directionsRef.current;
    const routeActive = dirs?.active === true;
    if (routeActive || routeSourceActiveRef.current) {
      setRouteSourceData(map, venue, levelId, dirs);
      routeSourceActiveRef.current = routeActive;
    }

    const net = networkRef.current;
    const editing = networkEditingRef.current;
    const networkActive = net != null || editing != null;
    if (networkActive || networkSourceActiveRef.current) {
      setNetworkSourceData(
        map,
        venue,
        levelId,
        net,
        editing == null ? undefined : networkRenderState(editing),
      );
      networkSourceActiveRef.current = networkActive;
    }

    const facilityActive = facilitiesRef.current.length > 0;
    if (facilityActive || facilitySourceActiveRef.current) {
      setFacilitySourceData(map, venue, levelId, facilitiesRef.current);
      facilitySourceActiveRef.current = facilityActive;
    }

    applyLayerVisibility(map, visibilityRef.current);
    syncSceneFloorState(
      map,
      sceneRef.current,
      levelId,
      dirs?.route ?? null,
      venue,
    );
  }, [syncSceneFloorState]);

  // Applies overlays now when the style is ready, otherwise exactly once when
  // a geojson source finishes loading. A floor change keeps the style busy
  // while the indoor source reloads; updates made in that window queue behind
  // a single `sourcedata` subscription instead of being dropped. Re-entry
  // re-checks isStyleLoaded and re-subscribes if another source is still busy.
  // No-ops until onLoad has performed the initial overlay write path.
  const syncOverlays = useCallback((): void => {
    const map = mapRef.current;
    if (map == null || !initialMapLoadCompleteRef.current) {
      return;
    }
    if (map.isStyleLoaded()) {
      applyOverlays();
      return;
    }
    if (!overlayStyleWaitingRef.current) {
      overlayStyleWaitingRef.current = true;
      const onSourceData = (): void => {
        overlayWaiterRef.current = null;
        overlayStyleWaitingRef.current = false;
        syncOverlays();
      };
      overlayWaiterRef.current = onSourceData;
      map.once("sourcedata", onSourceData);
    }
  }, [applyOverlays]);

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

  const onNetworkCenterPick = useCallback(() => {
    const map = mapRef.current;
    const editing = networkEditingRef.current;
    if (map == null || editing == null) {
      return;
    }
    const center = map.getCenter();
    editing.onPick(networkPickAt(map, map.project([center.lng, center.lat]), center, editing.tool));
  }, []);

  // One label system at a time. The flat overlay shows up to two hundred
  // markers on the map plane; the scene overlay shows a capped, prioritized set
  // placed on each feature's own floor. Both at once would double every name.
  useFeatureMarkers({
    map: mapInstance,
    venue,
    levelId,
    locale,
    selectedFeatureId,
    enabled: layerVisibility.labels && sceneLabelLayer === null,
    onSelect: onMarkerSelect,
  });

  useSceneLabels({
    map: mapInstance,
    layer: sceneLabelLayer,
    venue,
    levelId,
    locale,
    selectedFeatureId,
    // Guidance is a tighter frame than review: four labels against six (#32).
    mode: directions?.active === true ? "navigation" : "overview",
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

    maplibregl.addProtocol(
      FLOOR_ELEVATION_PROTOCOL,
      createFloorElevationProtocol(),
    );
    const initialScene = sceneRef.current;
    const initialFloorState =
      initialScene === null
        ? EMPTY_SCENE_FLOOR_STATE
        : resolveSceneFloorState(
            initialScene,
            venueRef.current.levels,
            levelIdRef.current,
            directionsRef.current?.route ?? null,
          );
    const initialFloorUrl = floorElevationTileUrl(
      initialFloorState.activePlaneM ?? Number.NaN,
    );
    const style = buildIndoorStyle(theme);
    const initialFloorSource = style.sources[FLOOR_ELEVATION_SOURCE_ID];
    if (
      initialFloorUrl !== null &&
      typeof initialFloorSource === "object" &&
      initialFloorSource !== null &&
      initialFloorSource.type === "raster-dem"
    ) {
      initialFloorSource.tiles = [initialFloorUrl];
      floorElevationUrlRef.current = initialFloorUrl;
    }
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style,
        ...(preserveDrawingBufferRef.current
          ? { canvasContextAttributes: { preserveDrawingBuffer: true } }
          : {}),
        attributionControl: false,
        // Pitch rides the rotate gesture, but `maxPitch: 0` clamps it away
        // until a scene raises the ceiling: in 2D the handler is disabled and
        // has no range, so this changes nothing until 3D is on.
        pitchWithRotate: true,
        dragRotate: false,
        maxPitch: 0,
        center: [0, 0],
        zoom: 1,
      });
    } catch {
      maplibregl.removeProtocol(FLOOR_ELEVATION_PROTOCOL);
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
      const sceneLayer = sceneLayerRef.current;
      const scenePick = sceneLayer?.pickAt(event.point.x, event.point.y) ?? null;
      // Where the click landed. MapLibre unprojects a pointer onto the map plane
      // at zero elevation, which is the right answer in 2D and the wrong one on
      // a pitched 3D camera — a click on an upper floor reports a position
      // metres from the surface actually clicked. The pick pass measured that
      // surface, so when it hit, its position is the truth.
      const clicked =
        scenePick !== null && sceneLayer != null
          ? sceneLayer.localToLngLat(scenePick.localPoint)
          : { lng: event.lngLat.lng, lat: event.lngLat.lat };
      const review = issueReviewRef.current;
      if (review?.placementMode === true) {
        // Placement captures the clicked point (plus any feature under it) and
        // suppresses ordinary feature selection.
        review.onPlaceIssue({
          // The clicked feature's own level (grouped same-ordinal levels all
          // render) beats the representative level; bare clicks use representative.
          levelId:
            scenePick?.levelId ?? readLevelId(features[0]?.properties) ?? levelIdRef.current,
          longitude: clicked.lng,
          latitude: clicked.lat,
          featureId: scenePick === null ? featureId : scenePick.canonicalFeatureId,
        });
        return;
      }
      const dirs = directionsRef.current;
      if (dirs?.active === true) {
        // Directions captures the raw point (snapping happens in wasm) and
        // suppresses ordinary feature selection.
        dirs.onPickPoint({ longitude: clicked.lng, latitude: clicked.lat });
        return;
      }

      const editing = networkEditingRef.current;
      if (editing != null) {
        // Editing suppresses ordinary feature/facility selection and reports a
        // semantic pick (junction/connection/coordinate) to the App reducer.
        // The graph's own wide hit targets keep their tolerances and their
        // precedence — junction before path — and only a click that misses both
        // falls through to a coordinate, which the scene pick makes accurate on
        // a pitched camera.
        editing.onPick(networkPickAt(map, event.point, clicked, editing.tool));
        return;
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
      if (scenePick !== null) {
        // The scene is what the reviewer can see, and its depth buffer already
        // resolved which floor and which surface that is — so it decides,
        // rather than the 2D fills hidden behind it.
        //
        // Two surfaces select nothing. One is a surface with no canonical
        // feature — a wall, an opening — which must never stand in for the
        // feature it happens to sit beside. The other is contextual mass: a
        // level's floor plate carries the level as its canonical feature, and
        // clicking bare floor clears the selection in 2D, so it means the same
        // thing here rather than selecting a whole storey.
        onSelectRef.current(
          scenePick.role === "Context" ? null : scenePick.canonicalFeatureId,
        );
        return;
      }
      onSelectRef.current(featureId);
    };

    const onMouseMove = (event: MapMouseEvent): void => {
      const editing = networkEditingRef.current;
      if (editing != null) {
        updateNetworkCursor(map, event.point, editing.tool);
        return;
      }
      const sceneLayer = sceneLayerRef.current;
      if (sceneLayer != null) {
        scenePointRef.current = { x: event.point.x, y: event.point.y };
        // While the camera moves, the pointer is dragging the map rather than
        // hovering its contents, and a synchronous readback would have to wait
        // out the frame already in flight — measured at 30 ms mid-drag against
        // 2 ms at rest. Hover is re-evaluated when the camera settles.
        if (map.isMoving()) {
          sceneLayer.setHoveredFeature(-1);
          return;
        }
        // One pick per frame at most: each one is a GPU readback that stalls
        // the pipeline, and a drag fires mousemove far faster than that.
        if (scenePickPendingRef.current) {
          return;
        }
        scenePickPendingRef.current = true;
        requestAnimationFrame(() => {
          scenePickPendingRef.current = false;
          const hit = sceneLayer.pickAt(event.point.x, event.point.y);
          const hoverable = hit !== null && hit.role !== "Context";
          sceneLayer.setHoveredFeature(hoverable ? hit.featureIndex : -1);
          const canonical = hoverable ? hit.canonicalFeatureId : null;
          const previous = hoverIdRef.current;
          if (previous !== canonical) {
            if (previous != null) {
              clearFeatureState(map, previous, "hover");
            }
            if (canonical != null) {
              applyFeatureState(map, canonical, { hover: true });
            }
            hoverIdRef.current = canonical;
          }
          map.getCanvas().style.cursor = canonical != null ? "pointer" : "";
        });
        return;
      }
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

    // The camera settled: whatever is under the pointer now is what the
    // reviewer is hovering, even though the pointer never moved.
    const onMoveEnd = (): void => {
      const sceneLayer = sceneLayerRef.current;
      const point = scenePointRef.current;
      if (sceneLayer == null || point == null) {
        return;
      }
      const hit = sceneLayer.pickAt(point.x, point.y);
      const hoverable = hit !== null && hit.role !== "Context";
      sceneLayer.setHoveredFeature(hoverable ? hit.featureIndex : -1);
      const canonical = hoverable ? hit.canonicalFeatureId : null;
      const previous = hoverIdRef.current;
      if (previous !== canonical) {
        if (previous != null) {
          clearFeatureState(map, previous, "hover");
        }
        if (canonical != null) {
          applyFeatureState(map, canonical, { hover: true });
        }
        hoverIdRef.current = canonical;
      }
      map.getCanvas().style.cursor = canonical != null ? "pointer" : "";
    };

    const onMouseLeave = (): void => {
      scenePointRef.current = null;
      sceneLayerRef.current?.setHoveredFeature(-1);
      if (hoverIdRef.current != null) {
        clearFeatureState(map, hoverIdRef.current, "hover");
        hoverIdRef.current = null;
      }
      map.getCanvas().style.cursor = "";
    };

    const onLoad = (): void => {
      mapStyleAvailableRef.current = true;
      const indoorData = setSourceData(map, venueRef.current, levelIdRef.current);
      indoorSourceStateRef.current =
        indoorData === null ? null : { venue: venueRef.current, data: indoorData };
      setRouteSourceData(map, venueRef.current, levelIdRef.current, directionsRef.current);
      routeSourceActiveRef.current = directionsRef.current?.active === true;
      setNetworkSourceData(
        map,
        venueRef.current,
        levelIdRef.current,
        networkRef.current,
        networkEditingRef.current == null ? undefined : networkRenderState(networkEditingRef.current),
      );
      networkSourceActiveRef.current =
        networkRef.current != null || networkEditingRef.current != null;
      registerFacilityImages(map);
      setFacilitySourceData(map, venueRef.current, levelIdRef.current, facilitiesRef.current);
      facilitySourceActiveRef.current = facilitiesRef.current.length > 0;
      applyLayerVisibility(map, visibilityRef.current);
      syncSceneFloorState(
        map,
        sceneRef.current,
        levelIdRef.current,
        directionsRef.current?.route ?? null,
        venueRef.current,
      );
      fitLevelBounds(map, venueRef.current, levelIdRef.current);
      // Mark after the one-time overlay writes so any sourcedata fired by those
      // writes cannot re-enter syncOverlays and duplicate them. Later prop/floor
      // changes re-run the overlay effect against this flag.
      initialMapLoadCompleteRef.current = true;
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
    map.on("moveend", onMoveEnd);
    map.on("mouseout", onMouseLeave);

    const markIdle = (): void => {
      container.dataset.mapIdle = "true";
    };
    const clearIdle = (): void => {
      delete container.dataset.mapIdle;
    };
    const markLoadedRenderIdle = (): void => {
      // Firefox can dispatch late dataloading/move notifications after the
      // corresponding idle event. Reconcile on render as well: loaded() means
      // all requested style/source work is complete, while isMoving() keeps
      // animation frames from being reported as settled.
      if (map.loaded() && !map.isMoving()) {
        markIdle();
      }
    };
    map.on("idle", markIdle);
    map.on("render", markLoadedRenderIdle);
    map.on("dataloading", clearIdle);
    // A movement always starts with movestart. Do not also clear on every
    // move: Firefox can deliver its final move notification after idle, which
    // would erase the settled marker with no later idle event to restore it.
    map.on("movestart", clearIdle);

    return () => {
      cancelReadyRef.current?.();
      cancelReadyRef.current = null;
      cameraCancelRef.current?.();
      cameraCancelRef.current = null;
      issueHighlightCancelRef.current?.();
      issueHighlightCancelRef.current = null;
      floorElevationReadyCancelRef.current?.();
      floorElevationReadyCancelRef.current = null;
      const overlayWaiter = overlayWaiterRef.current;
      if (overlayWaiter != null) {
        map.off("sourcedata", overlayWaiter);
        overlayWaiterRef.current = null;
      }
      overlayStyleWaitingRef.current = false;
      initialMapLoadCompleteRef.current = false;
      map.off("load", onLoad);
      map.off("click", onClick);
      map.off("mousemove", onMouseMove);
      map.off("moveend", onMoveEnd);
      map.off("mouseout", onMouseLeave);
      map.off("idle", markIdle);
      map.off("render", markLoadedRenderIdle);
      floorElevationUrlRef.current = null;
      floorElevationAttachedUrlRef.current = null;
      mapStyleAvailableRef.current = false;
      map.off("dataloading", clearIdle);
      map.off("movestart", clearIdle);
      onControlsRef.current?.(null);
      if (styleReady(map)) {
        map.setTerrain(null);
      }
      map.remove();
      maplibregl.removeProtocol(FLOOR_ELEVATION_PROTOCOL);
      mapRef.current = null;
      setMapInstance(null);
      hoverIdRef.current = null;
      appliedSelectedRef.current = null;
      appliedIssueHighlightRef.current = null;
      appliedCameraKeyRef.current = null;
      indoorSourceStateRef.current = null;
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

    // Move the camera first so MapLibre computes the floor delta only for the
    // final viewport. Updating the source before fitBounds makes the worker
    // parse tiles for both the departing and arriving viewports.
    fitLevelBounds(map, venue, levelId);
    indoorSourceStateRef.current = updateSourceData(
      map,
      venue,
      levelId,
      indoorSourceStateRef.current,
    );

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

  // Overlays (route, network, facilities, layer visibility): re-filter to the
  // active floor and apply prop changes, deferring to `sourcedata` while the
  // style is busy (e.g. right after the indoor source swap on a floor
  // change). onLoad initializes every source, so a null map is a no-op.
  useEffect(() => {
    syncOverlays();
  }, [directions, network, networkEditing, facilities, layerVisibility, venue, levelId, syncOverlays]);

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

  // The 3D scene layer. Adding it is the only thing that changes how a venue
  // renders, so it happens exactly when a scene is supplied and is fully undone
  // when one is not: the 2D viewer below is untouched either way.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null || scene == null) {
      return;
    }

    let layer: SceneLayer | null = null;

    const attach = (): void => {
      if (layer != null || !styleReady(map) || map.getLayer(SCENE_LAYER_ID) != null) {
        return;
      }
      mapStyleAvailableRef.current = true;
      try {
        const initialFloorState = resolveSceneFloorState(
          scene,
          venueRef.current.levels,
          levelIdRef.current,
          directionsRef.current?.route ?? null,
        );
        layer = new SceneLayer(scene, {
          id: SCENE_LAYER_ID,
          activeLevelIndex: initialFloorState.activeLevelIndices[0] ?? 0,
          contextLevelIndices: initialFloorState.contextLevelIndices,
        });
        if (
          floorElevationAttachedUrlRef.current ===
          floorElevationTileUrl(initialFloorState.activePlaneM ?? Number.NaN)
        ) {
          layer.setActiveLevels(initialFloorState.activeLevelIndices);
        } else {
          layer.setActiveLevels([]);
        }
        map.addLayer(layer);
        // A 3D scene needs a camera that can look at it (#23 D7); MapLibre
        // keeps owning the camera, this only lifts the 2D constraints.
        map.setMaxPitch(SCENE_MAX_PITCH);
        map.dragRotate.enable();
        map.touchZoomRotate.enableRotation();
        layer.setSelectedCanonicalFeature(selectedFeatureIdRef.current);
        sceneLayerRef.current = layer;
        syncSceneFloorState(
          map,
          scene,
          levelIdRef.current,
          directionsRef.current?.route ?? null,
          venueRef.current,
        );
        setSceneLabelLayer(layer);
        Reflect.set(window, SCENE_DIAGNOSTICS_KEY, layer.diagnostics());
      } catch (error) {
        // A context that cannot carry the layer leaves the 2D map exactly as it
        // was, and the source machine hears about it rather than the viewer
        // silently rendering nothing.
        layer = null;
        sceneLayerRef.current = null;
        if (import.meta.env.DEV) {
          console.warn("scene layer attach failed", error);
        }
        onSceneAttachFailedRef.current?.();
      }
    };

    if (styleReady(map)) {
      attach();
    } else {
      // `load` fires once per map; after a context restore only `idle` comes
      // again, so both are awaited and `attach` is idempotent.
      map.once("load", attach);
      map.once("idle", attach);
    }

    return () => {
      map.off("idle", attach);
      map.off("load", attach);
      sceneLayerRef.current = null;
      floorElevationReadyCancelRef.current?.();
      floorElevationReadyCancelRef.current = null;
      if (
        (styleReady(map) || mapStyleAvailableRef.current) &&
        floorElevationAttachedUrlRef.current !== null
      ) {
        map.setTerrain(null);
      }
      floorElevationAttachedUrlRef.current = null;
      floorElevationUrlRef.current = null;
      setSceneLabelLayer(null);
      Reflect.deleteProperty(window, SCENE_DIAGNOSTICS_KEY);
      // A context loss leaves MapLibre with no style, and reaching into it then
      // throws from inside the library — during an effect cleanup, which React
      // treats as a failed commit and unmounts the tree over. The layer is
      // already gone in that case; MapLibre drops custom layers itself.
      if (styleReady(map) && map.getLayer(SCENE_LAYER_ID) != null) {
        map.removeLayer(SCENE_LAYER_ID);
      }
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.setPitch(0);
      map.setBearing(0);
      map.setMaxPitch(0);
    };
  }, [scene, syncSceneFloorState]);

  // Context loss and recovery (#26). These listeners belong to the map, not to
  // any one scene: the layer is torn down the moment the context dies, and the
  // effect that owns the layer unmounts with it — so if the restore listener
  // lived there, the event that matters would arrive with nobody listening.
  useEffect(() => {
    const map = mapRef.current;
    if (map == null) {
      return;
    }
    const canvas = map.getCanvas();

    const onContextLost = (event: Event): void => {
      // Without preventDefault the browser will never restore this context.
      event.preventDefault();
      sceneLayerRef.current?.markContextLost();
      mapStyleAvailableRef.current = false;
      sceneLayerRef.current = null;
      setSceneLabelLayer(null);
      Reflect.deleteProperty(window, SCENE_DIAGNOSTICS_KEY);
      onSceneContextLostRef.current?.();
    };

    const onContextRestored = (): void => {
      // Recovery has exactly one driver: this reports the event, the source
      // machine decides whether to spend a retry, and the scene arriving back
      // in props is what re-attaches the layer — which also restores the active
      // level and the selection, because attaching seeds both from props.
      onSceneContextRestoredRef.current?.();
    };

    canvas.addEventListener("webglcontextlost", onContextLost, false);
    canvas.addEventListener("webglcontextrestored", onContextRestored, false);
    return () => {
      canvas.removeEventListener("webglcontextlost", onContextLost, false);
      canvas.removeEventListener("webglcontextrestored", onContextRestored, false);
    };
  }, []);

  // Selection is one thing whether it arrived from the canvas, a panel row, or
  // the keyboard: the scene highlights whatever the app considers selected.
  useEffect(() => {
    sceneLayerRef.current?.setSelectedCanonicalFeature(selectedFeatureId);
  }, [selectedFeatureId, scene]);

  // Floor changes drive both renderers from the same resolved floor state:
  // the scene's active batches and MapLibre's constant-elevation terrain use
  // one `resolvedPlaneZ`. Route context is persistent and independent of the
  // short all-floor handoff, so clearing a route cannot strand a context floor.
  useEffect(() => {
    const map = mapRef.current;
    const layer = sceneLayerRef.current;
    if (map == null) {
      return;
    }
    const previousIndices = layer?.diagnostics().activeLevelIndices() ?? [];
    const floorState = syncSceneFloorState(
      map,
      scene,
      levelId,
      directions?.route ?? null,
      venue,
    );
    if (layer == null) {
      return;
    }

    const activeFloorChanged =
      previousIndices.length !== floorState.activeLevelIndices.length ||
      previousIndices.some(
        (index, position) => index !== floorState.activeLevelIndices[position],
      );
    layer.setShowContextLevels(false);

    if (!activeFloorChanged || prefersReducedMotion()) {
      map.triggerRepaint();
      return;
    }

    layer.setShowContextLevels(true);
    map.triggerRepaint();
    const timer = window.setTimeout(() => {
      sceneLayerRef.current?.setShowContextLevels(false);
      mapRef.current?.triggerRepaint();
    }, CONTEXT_HANDOFF_MS);
    return () => {
      window.clearTimeout(timer);
      sceneLayerRef.current?.setShowContextLevels(false);
    };
  }, [directions?.route, levelId, scene, syncSceneFloorState, venue]);

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
      ) : networkEditing != null ? (
        <button type="button" className="issue-place-center" onClick={onNetworkCenterPick}>
          {networkEditing.centerActionLabel}
        </button>
      ) : null}
    </>
  );
}
