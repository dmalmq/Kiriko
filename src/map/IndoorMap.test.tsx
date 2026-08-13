import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedVenue, ViewerFeature } from "../imdf/types";
import type { RouteResultDto } from "../bundle/wasm";
import { kirikoTheme } from "../theme/presets";
import {
  FACILITY_SOURCE_ID,
  INDOOR_SOURCE_ID,
  LAYER_NETWORK_JUNCTION_HIT,
  LAYER_NETWORK_PATH_HIT,
  LAYER_NETWORK_VERTICAL_LINK_HIT,
  NETWORK_SOURCE_ID,
  ROUTE_SOURCE_ID,
} from "./featureLayers";
import { defaultLayerVisibility } from "./layerGroups";
import { buildIndoorSourceDiff, IndoorMap, type IndoorMapProps } from "./IndoorMap";
import type { MapIssuePin } from "./useIssuePins";
import {
  FLOOR_ELEVATION_PROTOCOL,
  FLOOR_ELEVATION_SOURCE_ID,
} from "./scene/floorElevation";
import {
  SceneLayer,
  SCENE_DIAGNOSTICS_KEY,
  type SceneDiagnostics,
} from "./scene/sceneLayer";
import type { SceneView } from "./scene/sceneFormat";

interface FakeMapEvent {
  point?: { x: number; y: number };
  lngLat?: { lng: number; lat: number };
  sourceId?: string;
  isSourceLoaded?: boolean;
  dataType?: string;
  sourceDataChanged?: boolean;
}

const mapState = vi.hoisted(() => {
  const instances: unknown[] = [];
  const protocolAdds: string[] = [];
  const protocolRemovals: string[] = [];
  const lifecycleEvents: string[] = [];
  let initialStyleLoaded = true;
  let flipStyleLoadedOnIndoorWrite = false;
  let loadFloorSourceOnAdd = true;
  class FakeMap {
    readonly container: HTMLElement;
    readonly handlers = new Map<string, Set<(event?: FakeMapEvent) => void>>();
    readonly onceHandlers = new Map<string, Set<(event?: FakeMapEvent) => void>>();
    // The real canvas carries the WebGL context-loss events the viewer listens
    // for; the double records the listeners so a test can fire them.
    readonly canvasListeners = new Map<string, Set<(event: Event) => void>>();
    readonly canvas = {
      style: { cursor: "" },
      addEventListener: (type: string, listener: (event: Event) => void): void => {
        const listeners = this.canvasListeners.get(type) ?? new Set();
        listeners.add(listener);
        this.canvasListeners.set(type, listeners);
      },
      removeEventListener: (type: string, listener: (event: Event) => void): void => {
        this.canvasListeners.get(type)?.delete(listener);
      },
    };

    /** Fire a canvas event the way the browser would. */
    emitCanvas(type: string): void {
      const event = { type, preventDefault: () => {} } as unknown as Event;
      for (const listener of this.canvasListeners.get(type) ?? []) {
        listener(event);
      }
    }
    readonly touchZoomRotate = {
      disableRotation(): void {},
      enableRotation(): void {},
    };
    readonly dragRotate = {
      disable(): void {},
      enable(): void {},
    };
    readonly featureStates: Array<{ id: string; state: Record<string, unknown> }> = [];
    readonly removedStates: Array<{ id: string; key: string }> = [];
    readonly easeToCalls: Array<{ center: [number, number]; duration?: number }> = [];
    readonly jumpToCalls: Array<{ center: [number, number] }> = [];
    readonly sourceData: unknown[] = [];
    readonly sourceDataDiffs: unknown[] = [];
    readonly indoorFloorOperations: Array<"fit" | "update"> = [];
    indoorSourceData: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
    readonly routeSourceData: unknown[] = [];
    readonly facilitySourceData: unknown[] = [];
    readonly networkSourceData: unknown[] = [];
    readonly floorTileUrls: string[][] = [];
    readonly initialFloorStyleTiles: string[];
    readonly floorSourceOperations: Array<
      { kind: "remove" } | { kind: "add"; tiles: string[] }
    > = [];
    readonly terrainCalls: Array<{
      source: string;
      exaggeration: number;
    } | null> = [];
    readonly customLayers = new Map<string, { id: string }>();
    queryResult: Array<{ properties: Record<string, unknown> }> = [];
    queryByLayer: Record<string, Array<{ properties: Record<string, unknown> }>> = {};
    styleLoaded = initialStyleLoaded;
    styleAvailable = initialStyleLoaded;
    sourceLoaded = true;
    floorSourceLoaded = true;
    center = { lng: 0, lat: 0 };
    zoom = 0;
    removed = false;

    constructor(options: {
      container: HTMLElement;
      style?: { sources?: Record<string, unknown> };
    }) {
      this.container = options.container;
      const floorSource = options.style?.sources?.[FLOOR_ELEVATION_SOURCE_ID];
      this.initialFloorStyleTiles =
        typeof floorSource === "object" &&
        floorSource !== null &&
        "tiles" in floorSource &&
        Array.isArray(floorSource.tiles)
          ? floorSource.tiles.filter(
              (tile): tile is string => typeof tile === "string",
            )
          : [];
      instances.push(this);
    }

    on(type: string, fn: (event?: FakeMapEvent) => void): this {
      let set = this.handlers.get(type);
      if (set == null) {
        set = new Set();
        this.handlers.set(type, set);
      }
      set.add(fn);
      return this;
    }

    once(type: string, fn: (event?: FakeMapEvent) => void): this {
      let set = this.onceHandlers.get(type);
      if (set == null) {
        set = new Set();
        this.onceHandlers.set(type, set);
      }
      set.add(fn);
      return this;
    }

    off(type: string, fn: (event?: FakeMapEvent) => void): this {
      this.handlers.get(type)?.delete(fn);
      this.onceHandlers.get(type)?.delete(fn);
      return this;
    }

    emit(type: string, event?: FakeMapEvent): void {
      if (type === "load") {
        this.styleAvailable = true;
      }
      for (const fn of [...(this.handlers.get(type) ?? [])]) {
        fn(event);
      }
      const once = this.onceHandlers.get(type);
      if (once != null) {
        for (const fn of [...once]) {
          fn(event);
        }
        once.clear();
      }
    }

    getContainer(): HTMLElement {
      return this.container;
    }

    getCanvas(): typeof this.canvas {
      return this.canvas;
    }

    queryRenderedFeatures(
      _point?: unknown,
      options?: { layers?: string[] },
    ): Array<{ properties: Record<string, unknown> }> {
      for (const layer of options?.layers ?? []) {
        const hit = this.queryByLayer[layer];
        if (hit !== undefined) return hit;
      }
      return this.queryResult;
    }

    getSource(id?: string): {
      type: string;
      setData: (data: unknown) => void;
      updateData: (diff: { remove?: Array<string | number>; add?: GeoJSON.Feature[] }) => void;
      setTiles: (tiles: string[]) => void;
    } {
      return {
        type: "geojson",
        setData: (data: unknown) => {
          const bucket =
            id === ROUTE_SOURCE_ID
              ? this.routeSourceData
              : id === FACILITY_SOURCE_ID
                ? this.facilitySourceData
                : id === NETWORK_SOURCE_ID
                  ? this.networkSourceData
                  : this.sourceData;
          bucket.push(data);
          if (id === INDOOR_SOURCE_ID) {
            this.indoorSourceData = data as GeoJSON.FeatureCollection;
            if (flipStyleLoadedOnIndoorWrite) {
              this.styleLoaded = false;
            }
          }
        },
        updateData: (diff) => {
          if (id !== INDOOR_SOURCE_ID) {
            return;
          }
          this.sourceDataDiffs.push(diff);
          this.indoorFloorOperations.push("update");
          const removed = new Set(diff.remove ?? []);
          const retained = this.indoorSourceData.features.filter((feature) => {
            const featureId = feature.id ?? feature.properties?.["__feature_id"];
            return !removed.has(featureId as string | number);
          });
          this.indoorSourceData = {
            type: "FeatureCollection",
            features: [...retained, ...(diff.add ?? [])],
          };
          if (flipStyleLoadedOnIndoorWrite) {
            this.styleLoaded = false;
          }
        },
        setTiles: (tiles) => {
          if (id === FLOOR_ELEVATION_SOURCE_ID) {
            this.floorTileUrls.push(tiles);
            this.emit("sourcedata", {
              sourceId: FLOOR_ELEVATION_SOURCE_ID,
              isSourceLoaded: true,
              dataType: "source",
              sourceDataChanged: true,
            });
          }
        },
      };
    }
    removeSource(id: string): void {
      if (id === FLOOR_ELEVATION_SOURCE_ID) {
        this.floorSourceLoaded = false;
        this.floorSourceOperations.push({ kind: "remove" });
      }
    }

    addSource(id: string, source: { tiles?: string[] }): void {
      if (id !== FLOOR_ELEVATION_SOURCE_ID) {
        return;
      }
      this.floorSourceOperations.push({
        kind: "add",
        tiles: source.tiles ?? [],
      });
      if (loadFloorSourceOnAdd) {
        this.floorSourceLoaded = true;
        this.emit("sourcedata", {
          sourceId: FLOOR_ELEVATION_SOURCE_ID,
          isSourceLoaded: true,
          dataType: "source",
        });
      }
    }


    hasImage(): boolean {
      return true;
    }

    addImage(): void {}

    loadImage(): Promise<{ data: { width: number; height: number; data: Uint8Array } }> {
      return Promise.resolve({ data: { width: 1, height: 1, data: new Uint8Array(4) } });
    }

    isSourceLoaded(id?: string): boolean {
      return id === FLOOR_ELEVATION_SOURCE_ID
        ? this.floorSourceLoaded
        : this.sourceLoaded;
    }

    loaded(): boolean {
      return this.styleLoaded && this.sourceLoaded;
    }

    isMoving(): boolean {
      return false;
    }

    isStyleLoaded(): boolean {
      return this.styleLoaded;
    }

    setFeatureState(target: { id: string }, state: Record<string, unknown>): void {
      this.featureStates.push({ id: target.id, state });
    }

    removeFeatureState(target: { id: string }, key: string): void {
      this.removedStates.push({ id: target.id, key });
    }

    getLayer(id: string): Record<string, unknown> | undefined {
      return this.customLayers.get(id) ?? (id === "kiriko-scene" ? undefined : {});
    }

    addLayer(layer: { id: string }): void {
      this.customLayers.set(layer.id, layer);
    }

    removeLayer(id: string): void {
      this.customLayers.delete(id);
    }

    setTerrain(value: { source: string; exaggeration: number } | null): void {
      if (!this.styleAvailable) {
        throw new Error("Style is not done loading.");
      }
      this.terrainCalls.push(value);
    }

    setLayoutProperty(): void {}
    setPaintProperty(): void {}
    setPitch(): void {}
    setBearing(): void {}
    setMaxPitch(): void {}
    triggerRepaint(): void {}

    project([lng, lat]: [number, number]): { x: number; y: number } {
      return { x: lng, y: lat };
    }

    cameraForBounds(bounds: [[number, number], [number, number]]): {
      center: { lng: number; lat: number };
      zoom: number;
      bearing: number;
    } {
      return {
        center: {
          lng: (bounds[0][0] + bounds[1][0]) / 2,
          lat: (bounds[0][1] + bounds[1][1]) / 2,
        },
        zoom: 16,
        bearing: 0,
      };
    }

    fitBounds(bounds: [[number, number], [number, number]]): void {
      this.indoorFloorOperations.push("fit");
      const camera = this.cameraForBounds(bounds);
      this.center = camera.center;
      this.zoom = camera.zoom;
    }
    easeTo(options: { center: [number, number]; duration?: number }): void {
      this.easeToCalls.push(options);
    }
    jumpTo(options: { center: [number, number] }): void {
      this.jumpToCalls.push(options);
    }
    zoomIn(): void {}
    zoomOut(): void {}
    getCenter(): { lng: number; lat: number } {
      return this.center;
    }
    getZoom(): number {
      return this.zoom;
    }
    getBearing(): number {
      return 0;
    }
    remove(): void {
      lifecycleEvents.push("map.remove");
      this.removed = true;
    }
  }
  return {
    instances,
    protocolAdds,
    protocolRemovals,
    FakeMap,
    setInitialStyleLoaded(value: boolean) {
      initialStyleLoaded = value;
    },
    lifecycleEvents,
    setFlipStyleLoadedOnIndoorWrite(value: boolean) {
      flipStyleLoadedOnIndoorWrite = value;
    },
    setLoadFloorSourceOnAdd(value: boolean) {
      loadFloorSourceOnAdd = value;
    },
  };
});

type FakeMap = InstanceType<typeof mapState.FakeMap>;

vi.mock("maplibre-gl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("maplibre-gl")>();
  const MercatorCoordinate = actual.MercatorCoordinate;
  return {
    ...actual,
    default: {
      ...actual,
      Map: mapState.FakeMap,
      addProtocol: (name: string) => {
        mapState.protocolAdds.push(name);
      },
      removeProtocol: (name: string) => {
        mapState.lifecycleEvents.push(`protocol.remove:${name}`);
        mapState.protocolRemovals.push(name);
      },
    },
    MercatorCoordinate,
  };
});

function feature(id: string, overrides: Partial<ViewerFeature> = {}): ViewerFeature {
  return {
    id,
    featureType: "unit",
    levelId: "level-1",
    geometry: null,
    center: [139.7, 35.6],
    labels: { en: id },
    altLabels: {},
    category: "elevator",
    accessibility: [],
    restriction: null,
    sourceProperties: {},
    ...overrides,
  };
}

function baseVenue(features: ViewerFeature[] = []): LoadedVenue {
  return {
    manifest: { version: "1.0.0", language: "en" },
    venue: feature("venue", { featureType: "venue", category: null }),
    levels: [
      { id: "level-1", ordinal: 0, label: { en: "L1" }, shortName: { en: "1" } },
      { id: "level-2", ordinal: 1, label: { en: "L2" }, shortName: { en: "2" } },
    ],
    featuresById: new Map(features.map((f) => [f.id, f])),
    renderFeaturesByLevel: new Map(),
    searchEntries: [],
    boundsByLevel: new Map(),
    warnings: [],
  };
}

const DEFAULT_VENUE = baseVenue();

function sceneWithPlanes(
  levels: Array<readonly [canonicalId: string, resolvedPlaneZ: number]>,
): SceneView {
  return {
    header: {
      formatVersion: 1,
      deriverVersion: 1,
      sourceHash: "indoor-map-floor-elevation",
      frameOriginEcef: [6_378_137, 0, 0],
      worldTransform: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        6_378_137, 0, 0, 1,
      ],
      boundsMin: [0, 0, 0],
      boundsMax: [1, 1, 16],
    },
    levels: levels.map(([canonicalId, resolvedPlaneZ]) => ({
      canonicalId,
      sourceLevelKey: "",
      sourceLevelName: "",
      sourceElevationMeters: null,
      resolvedPlaneZ,
      quantizedElevationDm: Math.round(resolvedPlaneZ * 10),
    })),
    features: [],
    batches: [],
  };
}

function crossFloorDirections(route: RouteResultDto | null): NonNullable<IndoorMapProps["directions"]> {
  return {
    active: true,
    origin: null,
    destination: null,
    route,
    onPickPoint: vi.fn(),
  };
}

function currentSceneDiagnostics(): SceneDiagnostics {
  const diagnostics: unknown = Reflect.get(window, SCENE_DIAGNOSTICS_KEY);
  if (
    typeof diagnostics !== "object" ||
    diagnostics === null ||
    !("activeLevelIndices" in diagnostics) ||
    typeof diagnostics.activeLevelIndices !== "function" ||
    !("contextLevelIndices" in diagnostics) ||
    typeof diagnostics.contextLevelIndices !== "function"
  ) {
    throw new Error("scene diagnostics are not attached");
  }
  return diagnostics as SceneDiagnostics;
}

const CROSS_FLOOR_ROUTE: RouteResultDto = {
  segments: [
    {
      ordinal: 0,
      coordinates: [
        [139, 35],
        [139.001, 35],
      ],
    },
    {
      ordinal: 1,
      coordinates: [
        [139.001, 35],
        [139.002, 35],
      ],
    },
  ],
  totalWeight: 100,
  originProjected: [139, 35, 0],
  destProjected: [139.002, 35, 1],
};

function review(overrides: Partial<NonNullable<IndoorMapProps["issueReview"]>> = {}) {
  return {
    placementMode: false,
    onPlaceIssue: vi.fn(),
    pins: [] as MapIssuePin[],
    selectedIssueId: null,
    onSelectIssue: vi.fn(),
    featureId: null,
    cameraRequest: null,
    ...overrides,
  } satisfies NonNullable<IndoorMapProps["issueReview"]>;
}

function baseProps(overrides: Partial<IndoorMapProps> = {}): IndoorMapProps {
  return {
    venue: DEFAULT_VENUE,
    levelId: "level-1",
    selectedFeatureId: null,
    locale: "en",
    theme: kirikoTheme,
    layerVisibility: { ...defaultLayerVisibility, labels: false },
    onSelectFeature: vi.fn(),
    issueReview: null,
    ...overrides,
  };
}

function lastMap(): FakeMap {
  return mapState.instances.at(-1) as FakeMap;
}

function renderMap(props: IndoorMapProps): { map: FakeMap; rerender: (next: IndoorMapProps) => void } {
  const utils = render(<IndoorMap {...props} />);
  const map = lastMap();
  map.styleLoaded = true;
  act(() => {
    map.emit("load");
  });
  return {
    map,
    rerender: (next: IndoorMapProps) => {
      act(() => {
        utils.rerender(<IndoorMap {...next} />);
      });
    },
  };
}

const READY_EVENT: FakeMapEvent = {
  sourceId: INDOOR_SOURCE_ID,
  isSourceLoaded: true,
  dataType: "source",
};

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  mapState.instances.length = 0;
  mapState.protocolAdds.length = 0;
  mapState.protocolRemovals.length = 0;
  mapState.lifecycleEvents.length = 0;
  mapState.setInitialStyleLoaded(true);
  mapState.setFlipStyleLoadedOnIndoorWrite(false);
  mapState.setLoadFloorSourceOnAdd(true);
});

afterEach(() => {
  vi.clearAllMocks();
  window.matchMedia = originalMatchMedia;
});

describe("IndoorMap idle marker", () => {
  it("keeps the marker when a browser delivers a final move after idle", () => {
    const { map } = renderMap(baseProps());
    const container = screen.getByRole("application", { name: "Indoor map" });

    act(() => {
      map.emit("idle");
      map.emit("move");
    });
    expect(container.getAttribute("data-map-idle")).toBe("true");

    act(() => {
      map.emit("movestart");
    });
    expect(container.getAttribute("data-map-idle")).toBeNull();
  });

  it("recovers from a late data-loading notification on the next loaded render", () => {
    const { map } = renderMap(baseProps());
    const container = screen.getByRole("application", { name: "Indoor map" });

    act(() => {
      map.emit("idle");
      map.emit("dataloading");
    });
    expect(container.getAttribute("data-map-idle")).toBeNull();

    act(() => {
      map.emit("render");
    });
    expect(container.getAttribute("data-map-idle")).toBe("true");
  });
});

describe("IndoorMap placement", () => {
  it("captures the map point and queried feature on canvas click while placing", () => {
    const onSelectFeature = vi.fn();
    const placement = review({ placementMode: true });
    const { map } = renderMap(baseProps({ onSelectFeature, issueReview: placement }));

    map.queryResult = [{ properties: { __feature_id: "unit-9" } }];
    act(() => {
      map.emit("click", { point: { x: 3, y: 4 }, lngLat: { lng: 139.5, lat: 35.4 } });
    });

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-1",
      longitude: 139.5,
      latitude: 35.4,
      featureId: "unit-9",
    });
    expect(onSelectFeature).not.toHaveBeenCalled();
  });

  it("captures a bare map point when no feature is under the placement click", () => {
    const placement = review({ placementMode: true });
    const { map } = renderMap(baseProps({ issueReview: placement }));

    map.queryResult = [];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
    });

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-1",
      longitude: 1,
      latitude: 2,
      featureId: null,
    });
  });

  it("runs ordinary feature selection on canvas click outside placement mode", () => {
    const onSelectFeature = vi.fn();
    const { map } = renderMap(baseProps({ onSelectFeature, issueReview: review({ placementMode: false }) }));

    map.queryResult = [{ properties: { __feature_id: "unit-3" } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 0, lat: 0 } });
    });

    expect(onSelectFeature).toHaveBeenCalledWith("unit-3");
  });

  it("captures the marker center and id on a marker click while placing", async () => {
    const onSelectFeature = vi.fn();
    const placement = review({ placementMode: true });
    const venue = baseVenue([feature("unit-ele", { labels: { en: "Elevator A" } })]);
    renderMap(
      baseProps({
        venue,
        layerVisibility: { ...defaultLayerVisibility, labels: true },
        onSelectFeature,
        issueReview: placement,
      }),
    );

    const marker = await screen.findByRole("button", { name: "Elevator A" });
    await userEvent.click(marker);

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-1",
      longitude: 139.7,
      latitude: 35.6,
      featureId: "unit-ele",
    });
    expect(onSelectFeature).not.toHaveBeenCalled();
  });

  it("exposes a keyboard-operable Place at map center control while placing", async () => {
    const placement = review({ placementMode: true });
    const { map } = renderMap(baseProps({ issueReview: placement }));
    map.center = { lng: 12, lat: 34 };
    map.queryResult = [];

    const button = screen.getByRole("button", { name: "Place at map center" });
    button.focus();
    await userEvent.keyboard("{Enter}");

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-1",
      longitude: 12,
      latitude: 34,
      featureId: null,
    });
  });

  it("localizes the map-center placement control", () => {
    renderMap(
      baseProps({
        locale: "ja",
        issueReview: review({ placementMode: true }),
      }),
    );
    expect(screen.getByRole("button", { name: "地図の中心に配置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Place at map center" })).toBeNull();
  });

  it("hides the Place at map center control outside placement mode", () => {
    renderMap(baseProps({ issueReview: review({ placementMode: false }) }));
    expect(screen.queryByRole("button", { name: "Place at map center" })).toBeNull();
  });

  it("anchors a placement click to the clicked feature's own level, not the representative", () => {
    const placement = review({ placementMode: true });
    const { map } = renderMap(baseProps({ levelId: "level-1", issueReview: placement }));

    // Grouped same-ordinal floors all render, so the clicked feature can belong
    // to a level other than the selected representative "level-1".
    map.queryResult = [{ properties: { __feature_id: "unit-9", __level_id: "level-2" } }];
    act(() => {
      map.emit("click", { point: { x: 3, y: 4 }, lngLat: { lng: 139.5, lat: 35.4 } });
    });

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-2",
      longitude: 139.5,
      latitude: 35.4,
      featureId: "unit-9",
    });
  });

  it("anchors a Place-at-center click to the queried feature's own level", () => {
    const placement = review({ placementMode: true });
    const { map } = renderMap(baseProps({ levelId: "level-1", issueReview: placement }));
    map.center = { lng: 5, lat: 6 };
    map.queryResult = [{ properties: { __feature_id: "unit-7", __level_id: "level-2" } }];

    act(() => {
      screen.getByRole("button", { name: "Place at map center" }).click();
    });

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-2",
      longitude: 5,
      latitude: 6,
      featureId: "unit-7",
    });
  });

  it("falls back to the representative level for a bare Place-at-center click", () => {
    const placement = review({ placementMode: true });
    const { map } = renderMap(baseProps({ levelId: "level-1", issueReview: placement }));
    map.center = { lng: 8, lat: 9 };
    map.queryResult = [];

    act(() => {
      screen.getByRole("button", { name: "Place at map center" }).click();
    });

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-1",
      longitude: 8,
      latitude: 9,
      featureId: null,
    });
  });

  it("anchors a marker placement to the marker feature's own venue level", async () => {
    const placement = review({ placementMode: true });
    const ele = feature("unit-ele", { levelId: "level-1", labels: { en: "Elevator A" } });
    const venue = baseVenue([ele]);
    renderMap(
      baseProps({
        venue,
        levelId: "level-1",
        layerVisibility: { ...defaultLayerVisibility, labels: true },
        issueReview: placement,
      }),
    );

    const marker = await screen.findByRole("button", { name: "Elevator A" });
    // The feature actually belongs to a non-representative same-ordinal level;
    // the anchor must follow the feature's venue level, not levelIdRef.
    ele.levelId = "level-2";
    await userEvent.click(marker);

    expect(placement.onPlaceIssue).toHaveBeenCalledWith({
      levelId: "level-2",
      longitude: 139.7,
      latitude: 35.6,
      featureId: "unit-ele",
    });
  });
});

describe("IndoorMap anchor camera", () => {
  it("centers on the requested coordinate after the source reports ready", () => {
    const { map, rerender } = renderMap(baseProps({ issueReview: review({ cameraRequest: null }) }));
    map.sourceLoaded = false;

    rerender(
      baseProps({
        issueReview: review({ cameraRequest: { key: 1, levelId: "level-1", longitude: 5, latitude: 6 } }),
      }),
    );
    expect(map.easeToCalls).toHaveLength(0);

    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.easeToCalls).toEqual([{ center: [5, 6], duration: 450 }]);
  });

  it("defers cross-floor centering until the floor prop switches", () => {
    const { map, rerender } = renderMap(baseProps({ levelId: "level-1", issueReview: review({ cameraRequest: null }) }));
    map.sourceLoaded = false;

    const request = { key: 1, levelId: "level-2", longitude: 5, latitude: 6 };
    rerender(baseProps({ levelId: "level-1", issueReview: review({ cameraRequest: request }) }));
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.easeToCalls).toHaveLength(0);

    rerender(baseProps({ levelId: "level-2", issueReview: review({ cameraRequest: request }) }));
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.easeToCalls).toEqual([{ center: [5, 6], duration: 450 }]);
  });

  it("applies a repeated camera key only once after it has centered", () => {
    const { map, rerender } = renderMap(baseProps({ issueReview: review({ cameraRequest: null }) }));
    map.sourceLoaded = false;

    rerender(
      baseProps({
        issueReview: review({ cameraRequest: { key: 7, levelId: "level-1", longitude: 1, latitude: 2 } }),
      }),
    );
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });

    // A later render carrying the same key must not re-center, even with new coords.
    rerender(
      baseProps({
        issueReview: review({ cameraRequest: { key: 7, levelId: "level-1", longitude: 9, latitude: 9 } }),
      }),
    );
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });

    expect(map.easeToCalls).toEqual([{ center: [1, 2], duration: 450 }]);
  });

  it("jumps instead of easing when reduced motion is preferred", () => {
    window.matchMedia = ((query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;

    const { map, rerender } = renderMap(baseProps({ issueReview: review({ cameraRequest: null }) }));
    map.sourceLoaded = false;

    rerender(
      baseProps({
        issueReview: review({ cameraRequest: { key: 1, levelId: "level-1", longitude: 5, latitude: 6 } }),
      }),
    );
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });

    expect(map.jumpToCalls).toEqual([{ center: [5, 6] }]);
    expect(map.easeToCalls).toHaveLength(0);
  });

  it("survives floor2-wait -> floor1 -> stale ready -> floor2 without wrong-floor centering", () => {
    const request = { key: 1, levelId: "level-2", longitude: 5, latitude: 6 };
    const { map, rerender } = renderMap(
      baseProps({ levelId: "level-2", issueReview: review({ cameraRequest: null }) }),
    );
    map.sourceLoaded = false;

    // Request on floor 2 while its source is still loading.
    rerender(baseProps({ levelId: "level-2", issueReview: review({ cameraRequest: request }) }));

    // App switches to floor 1 before floor 2 became ready; a stale ready fires.
    rerender(baseProps({ levelId: "level-1", issueReview: review({ cameraRequest: request }) }));
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.easeToCalls).toHaveLength(0);

    // App returns to floor 2; the retry must still center once ready.
    rerender(baseProps({ levelId: "level-2", issueReview: review({ cameraRequest: request }) }));
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.easeToCalls).toEqual([{ center: [5, 6], duration: 450 }]);
  });
});

describe("IndoorMap issue highlight", () => {
  it("highlights the issue feature without opening the inspector selection", () => {
    const onSelectFeature = vi.fn();
    const { map, rerender } = renderMap(
      baseProps({ onSelectFeature, issueReview: review({ featureId: null }) }),
    );
    map.sourceLoaded = false;

    rerender(baseProps({ onSelectFeature, issueReview: review({ featureId: "unit-7" }) }));
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });

    expect(map.featureStates).toContainEqual({ id: "unit-7", state: { issueHighlight: true } });
    expect(onSelectFeature).not.toHaveBeenCalled();
  });

  it("clears the previous issue highlight when the feature changes", () => {
    const { map, rerender } = renderMap(baseProps({ issueReview: review({ featureId: "unit-7" }) }));
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });

    rerender(baseProps({ issueReview: review({ featureId: null }) }));

    expect(map.removedStates).toContainEqual({ id: "unit-7", key: "issueHighlight" });
  });

  it("does not apply an obsolete highlight after the feature is cleared before ready", () => {
    const { map, rerender } = renderMap(baseProps({ issueReview: review({ featureId: null }) }));
    map.sourceLoaded = false;

    rerender(baseProps({ issueReview: review({ featureId: "unit-A" }) }));
    rerender(baseProps({ issueReview: review({ featureId: null }) }));
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });

    expect(map.featureStates.some((s) => s.state.issueHighlight === true)).toBe(false);
  });
});

describe("IndoorMap floor source", () => {
  function floorRenderFeature(id: string, levelId: string, longitude: number): GeoJSON.Feature {
    return {
      type: "Feature",
      id,
      properties: {
        __feature_id: id,
        __feature_type: "unit",
        __level_id: levelId,
        __category: null,
        __restricted: false,
      },
      geometry: { type: "Point", coordinates: [longitude, 35.6] },
    };
  }

  it("applies one ID delta and leaves the final source on the selected floor", () => {
    const venue = baseVenue();
    venue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-1", "level-1", 139.1)],
    });
    venue.renderFeaturesByLevel.set("level-2", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-2", "level-2", 139.2)],
    });
    venue.boundsByLevel.set("level-1", [139.0, 35.5, 139.2, 35.7]);
    venue.boundsByLevel.set("level-2", [139.1, 35.5, 139.3, 35.7]);
    const { map, rerender } = renderMap(baseProps({ venue, levelId: "level-1" }));
    const fullUpdatesBeforeFloorChange = map.sourceData.length;
    const deltaUpdatesBeforeFloorChange = map.sourceDataDiffs.length;
    map.indoorFloorOperations.length = 0;

    rerender(baseProps({ venue, levelId: "level-2" }));

    expect(map.indoorFloorOperations).toEqual(["fit", "update"]);
    expect(map.sourceData).toHaveLength(fullUpdatesBeforeFloorChange);
    expect(map.sourceDataDiffs).toHaveLength(deltaUpdatesBeforeFloorChange + 1);
    expect(map.sourceDataDiffs.at(-1)).toEqual({
      remove: ["floor-1"],
      add: [venue.renderFeaturesByLevel.get("level-2")!.features[0]],
    });
    expect(map.indoorSourceData.features.map((feature) => feature.id)).toEqual(["floor-2"]);
  });

  it("does not refit shared bounds before applying the floor delta", () => {
    const venue = baseVenue();
    venue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-1", "level-1", 139.1)],
    });
    venue.renderFeaturesByLevel.set("level-2", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-2", "level-2", 139.2)],
    });
    const sharedBounds: [number, number, number, number] = [139.0, 35.5, 139.2, 35.7];
    venue.boundsByLevel.set("level-1", sharedBounds);
    venue.boundsByLevel.set("level-2", sharedBounds);
    const { map, rerender } = renderMap(baseProps({ venue, levelId: "level-1" }));
    map.indoorFloorOperations.length = 0;

    rerender(baseProps({ venue, levelId: "level-2" }));

    expect(map.indoorFloorOperations).toEqual(["update"]);
    expect(map.indoorSourceData.features.map((feature) => feature.id)).toEqual(["floor-2"]);
  });

  it("does not invalidate the source when grouped-floor render data is unchanged", () => {
    const venue = baseVenue();
    venue.levels[1]!.ordinal = 0;
    venue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-1", "level-1", 139.1)],
    });
    venue.renderFeaturesByLevel.set("level-2", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-2", "level-2", 139.2)],
    });
    const { map, rerender } = renderMap(baseProps({ venue, levelId: "level-1" }));
    const fullUpdatesBeforeRepresentativeChange = map.sourceData.length;
    const deltaUpdatesBeforeRepresentativeChange = map.sourceDataDiffs.length;

    rerender(baseProps({ venue, levelId: "level-2" }));

    expect(map.sourceData).toHaveLength(fullUpdatesBeforeRepresentativeChange);
    expect(map.sourceDataDiffs).toHaveLength(deltaUpdatesBeforeRepresentativeChange);
    expect(map.indoorSourceData.features.map((feature) => feature.id)).toEqual([
      "floor-1",
      "floor-2",
    ]);
  });

  it("fully replaces source data when the immutable venue changes", () => {
    const firstVenue = baseVenue();
    firstVenue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-1", "level-1", 139.1)],
    });
    const secondVenue = baseVenue();
    secondVenue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [floorRenderFeature("floor-1", "level-1", 140.1)],
    });
    const { map, rerender } = renderMap(baseProps({ venue: firstVenue }));
    const fullUpdatesBeforeVenueChange = map.sourceData.length;
    const deltaUpdatesBeforeVenueChange = map.sourceDataDiffs.length;

    rerender(baseProps({ venue: secondVenue }));

    expect(map.sourceData).toHaveLength(fullUpdatesBeforeVenueChange + 1);
    expect(map.sourceDataDiffs).toHaveLength(deltaUpdatesBeforeVenueChange);
    expect(map.indoorSourceData.features[0]?.geometry).toEqual({
      type: "Point",
      coordinates: [140.1, 35.6],
    });
  });

  it("falls back to a full replacement when a feature has no stable ID", () => {
    const unidentified: GeoJSON.Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 0] },
    };
    expect(
      buildIndoorSourceDiff(
        { type: "FeatureCollection", features: [] },
        { type: "FeatureCollection", features: [unidentified] },
      ),
    ).toBeNull();
  });
});

describe("IndoorMap directions", () => {
  function directions(
    overrides: Partial<NonNullable<IndoorMapProps["directions"]>> = {},
  ): NonNullable<IndoorMapProps["directions"]> {
    return {
      active: true,
      origin: null,
      destination: null,
      route: null,
      onPickPoint: vi.fn(),
      ...overrides,
    };
  }

  const CROSS_FLOOR_ROUTE: RouteResultDto = {
    segments: [
      { ordinal: 0, coordinates: [[139.0, 35.0], [139.001, 35.0]] },
      { ordinal: 1, coordinates: [[139.001, 35.001], [139.002, 35.002]] },
    ],
    totalWeight: 240,
    originProjected: [139.0, 35.0, 0],
    destProjected: [139.002, 35.002, 1],
  };

  function lastRouteData(map: FakeMap): GeoJSON.FeatureCollection {
    expect(map.routeSourceData.length).toBeGreaterThan(0);
    return map.routeSourceData.at(-1) as GeoJSON.FeatureCollection;
  }

  function segmentsOf(fc: GeoJSON.FeatureCollection): GeoJSON.Feature[] {
    return fc.features.filter((f) => f.properties?.["kind"] === "segment");
  }

  it("reports the tapped point and suppresses feature selection while picking", () => {
    const onSelectFeature = vi.fn();
    const dirs = directions();
    const { map } = renderMap(baseProps({ onSelectFeature, directions: dirs }));

    map.queryResult = [{ properties: { __feature_id: "unit-9" } }];
    act(() => {
      map.emit("click", { point: { x: 3, y: 4 }, lngLat: { lng: 139.5, lat: 35.4 } });
    });

    expect(dirs.onPickPoint).toHaveBeenCalledWith({ longitude: 139.5, latitude: 35.4 });
    expect(onSelectFeature).not.toHaveBeenCalled();
  });

  it("keeps ordinary feature selection when directions are inactive", () => {
    const onSelectFeature = vi.fn();
    const { map } = renderMap(
      baseProps({ onSelectFeature, directions: directions({ active: false }) }),
    );

    map.queryResult = [{ properties: { __feature_id: "unit-3" } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 0, lat: 0 } });
    });

    expect(onSelectFeature).toHaveBeenCalledWith("unit-3");
  });

  it("populates the route source with only the active floor's segments and endpoint", () => {
    const { map } = renderMap(
      baseProps({
        levelId: "level-1",
        directions: directions({
          origin: { longitude: 139.0, latitude: 35.0, ordinal: 0 },
          destination: { longitude: 139.002, latitude: 35.002, ordinal: 1 },
          route: CROSS_FLOOR_ROUTE,
        }),
      }),
    );

    const fc = lastRouteData(map);
    const segments = segmentsOf(fc);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [139.0, 35.0],
        [139.001, 35.0],
      ],
    });
    const nonSegments = fc.features
      .filter((f) => f.properties?.["kind"] !== "segment")
      .map((f) => f.properties?.["kind"])
      .sort();
    // Origin click is on this floor → its marker plus the dashed connector to
    // the projected origin; the destination lives on another floor.
    expect(nonSegments).toEqual(["connector", "origin"]);
  });

  it("re-segments the route source exactly once when the active floor changes", () => {
    const { map, rerender } = renderMap(
      baseProps({
        levelId: "level-1",
        directions: directions({ route: CROSS_FLOOR_ROUTE }),
      }),
    );
    expect(segmentsOf(lastRouteData(map))[0]!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [139.0, 35.0],
        [139.001, 35.0],
      ],
    });

    const updatesBeforeFloorChange = map.routeSourceData.length;
    rerender(
      baseProps({
        levelId: "level-2",
        directions: directions({ route: CROSS_FLOOR_ROUTE }),
      }),
    );

    expect(map.routeSourceData).toHaveLength(updatesBeforeFloorChange + 1);
    expect(segmentsOf(lastRouteData(map))[0]!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [139.001, 35.001],
        [139.002, 35.002],
      ],
    });
  });

  it("keeps the initial inactive route data without invalidating it on floor changes", () => {
    const inactiveDirections = directions({
      active: false,
      origin: { longitude: 139.0, latitude: 35.0, ordinal: 0 },
      route: CROSS_FLOOR_ROUTE,
    });
    const { map, rerender } = renderMap(
      baseProps({ directions: inactiveDirections, levelId: "level-1" }),
    );
    expect(lastRouteData(map).features).toEqual([]);
    const updatesBeforeFloorChange = map.routeSourceData.length;

    rerender(baseProps({ directions: inactiveDirections, levelId: "level-2" }));

    expect(map.routeSourceData).toHaveLength(updatesBeforeFloorChange);
    expect(lastRouteData(map).features).toEqual([]);
  });

  it("clears active route data exactly once when directions are cleared", () => {
    const { map, rerender } = renderMap(
      baseProps({
        directions: directions({
          origin: { longitude: 139.0, latitude: 35.0, ordinal: 0 },
          route: CROSS_FLOOR_ROUTE,
        }),
      }),
    );
    expect(lastRouteData(map).features.length).toBeGreaterThan(0);
    const updatesBeforeDirectionsOff = map.routeSourceData.length;

    rerender(baseProps({ directions: directions({ active: false }) }));

    expect(map.routeSourceData).toHaveLength(updatesBeforeDirectionsOff + 1);
    expect(lastRouteData(map)).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("defers the route overlay while the style is busy, applying it on sourcedata", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const venue = baseVenue();
    venue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-1",
          properties: { __feature_id: "floor-1" },
          geometry: { type: "Point", coordinates: [139.1, 35.6] },
        },
      ],
    });
    venue.renderFeaturesByLevel.set("level-2", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-2",
          properties: { __feature_id: "floor-2" },
          geometry: { type: "Point", coordinates: [139.2, 35.6] },
        },
      ],
    });
    const { map, rerender } = renderMap(
      baseProps({ venue, levelId: "level-1", directions: directions({ route: CROSS_FLOOR_ROUTE }) }),
    );
    const settle = (): void => {
      act(() => {
        map.styleLoaded = true;
        map.emit("sourcedata", READY_EVENT);
      });
    };
    settle();
    expect(segmentsOf(lastRouteData(map)).map((f) => f.geometry)).toEqual([
      { type: "LineString", coordinates: [[139.0, 35.0], [139.001, 35.0]] },
    ]);

    rerender(
      baseProps({ venue, levelId: "level-2", directions: directions({ route: CROSS_FLOOR_ROUTE }) }),
    );
    // The indoor swap kept the style busy: the overlay still shows floor 1.
    expect(segmentsOf(lastRouteData(map)).map((f) => f.geometry)).toEqual([
      { type: "LineString", coordinates: [[139.0, 35.0], [139.001, 35.0]] },
    ]);

    settle();
    expect(segmentsOf(lastRouteData(map)).map((f) => f.geometry)).toEqual([
      { type: "LineString", coordinates: [[139.001, 35.001], [139.002, 35.002]] },
    ]);
  });
});

describe("IndoorMap network review", () => {
  const NETWORK: NonNullable<IndoorMapProps["network"]> = {
    junctions: [
      { ordinal: 0, geometry: { type: "Point", coordinates: [139.0, 35.0] }, properties: { NODEID: 1, FLOOR: "F1" } },
      { ordinal: 1, geometry: { type: "Point", coordinates: [139.1, 35.1] }, properties: { NODEID: 2, FLOOR: "F2" } },
    ],
    paths: [
      {
        ordinal: 0,
        geometry: { type: "LineString", coordinates: [[139.0, 35.0], [139.01, 35.0]] },
        properties: { FNODEID: 1, TNODEID: 1, FLOOR: "F1" },
      },
      {
        ordinal: 1,
        geometry: { type: "LineString", coordinates: [[139.1, 35.1], [139.11, 35.1]] },
        properties: { FNODEID: 2, TNODEID: 2, FLOOR: "F2" },
      },
    ],
  };

  function lastNetworkData(map: FakeMap): GeoJSON.FeatureCollection {
    expect(map.networkSourceData.length).toBeGreaterThan(0);
    return map.networkSourceData.at(-1) as GeoJSON.FeatureCollection;
  }

  it("applies a network prop that arrives before the map style load event", () => {
    mapState.setInitialStyleLoaded(false);
    const utils = render(<IndoorMap {...baseProps({ network: NETWORK })} />);
    const map = lastMap();
    map.styleLoaded = true;

    act(() => {
      map.emit("load");
    });
    utils.unmount();

    expect(lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"])).toEqual([1, 1]);
  });

  it("does not arm overlay waiters or duplicate network writes before initial load", () => {
    mapState.setInitialStyleLoaded(false);
    const utils = render(<IndoorMap {...baseProps({ network: NETWORK, levelId: "level-1" })} />);
    const map = lastMap();

    // Pre-load sourcedata must not apply overlays or leave a deferred waiter that
    // replays after onLoad's initial write.
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.networkSourceData).toHaveLength(0);

    map.styleLoaded = true;
    act(() => {
      map.emit("load");
    });
    // Source completion after onLoad must not re-apply the same overlay data.
    act(() => {
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.networkSourceData).toHaveLength(1);
    expect(lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"])).toEqual([
      1, 1,
    ]);

    const writesAfterLoad = map.networkSourceData.length;
    act(() => {
      utils.rerender(<IndoorMap {...baseProps({ network: NETWORK, levelId: "level-2" })} />);
    });
    expect(map.networkSourceData).toHaveLength(writesAfterLoad + 1);
    expect(lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"])).toEqual([
      2, 2,
    ]);
    utils.unmount();
  });

  it("updates the network source exactly once with the active floor's data", () => {
    const { map, rerender } = renderMap(baseProps({ network: NETWORK, levelId: "level-1" }));
    expect(lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"])).toEqual([1, 1]);
    const updatesBeforeFloorChange = map.networkSourceData.length;

    rerender(baseProps({ network: NETWORK, levelId: "level-2" }));

    expect(map.networkSourceData).toHaveLength(updatesBeforeFloorChange + 1);
    expect(lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"])).toEqual([2, 2]);
  });

  it("keeps the initial empty network data without invalidating it on floor changes", () => {
    const { map, rerender } = renderMap(baseProps({ network: null, levelId: "level-1" }));
    expect(lastNetworkData(map).features).toEqual([]);
    const updatesBeforeFloorChange = map.networkSourceData.length;

    rerender(baseProps({ network: null, levelId: "level-2" }));

    expect(map.networkSourceData).toHaveLength(updatesBeforeFloorChange);
    expect(lastNetworkData(map).features).toEqual([]);
  });

  it("clears active network data exactly once when review is turned off", () => {
    const { map, rerender } = renderMap(baseProps({ network: NETWORK }));
    const updatesBeforeReviewOff = map.networkSourceData.length;

    rerender(baseProps({ network: null }));

    expect(map.networkSourceData).toHaveLength(updatesBeforeReviewOff + 1);
    expect(lastNetworkData(map).features).toEqual([]);
  });

  it("defers the network overlay while the style is busy, applying it on sourcedata", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const venue = baseVenue();
    venue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-1",
          properties: { __feature_id: "floor-1" },
          geometry: { type: "Point", coordinates: [139.1, 35.6] },
        },
      ],
    });
    venue.renderFeaturesByLevel.set("level-2", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-2",
          properties: { __feature_id: "floor-2" },
          geometry: { type: "Point", coordinates: [139.2, 35.6] },
        },
      ],
    });
    const ids = (map: FakeMap) =>
      lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"]);
    const { map, rerender } = renderMap(baseProps({ venue, network: NETWORK, levelId: "level-1" }));
    const settle = (): void => {
      act(() => {
        map.styleLoaded = true;
        map.emit("sourcedata", READY_EVENT);
      });
    };
    settle();
    expect(ids(map)).toEqual([1, 1]);

    rerender(baseProps({ venue, network: NETWORK, levelId: "level-2" }));
    expect(ids(map)).toEqual([1, 1]); // style busy: still floor 1

    settle();
    expect(ids(map)).toEqual([2, 2]);
  });

  it("applies only the newest floor once the style settles", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const venue = baseVenue();
    venue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-1",
          properties: { __feature_id: "floor-1" },
          geometry: { type: "Point", coordinates: [139.1, 35.6] },
        },
      ],
    });
    venue.renderFeaturesByLevel.set("level-2", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-2",
          properties: { __feature_id: "floor-2" },
          geometry: { type: "Point", coordinates: [139.2, 35.6] },
        },
      ],
    });
    const ids = (map: FakeMap) =>
      lastNetworkData(map).features.map((f) => f.properties?.["NODEID"] ?? f.properties?.["FNODEID"]);
    const { map, rerender } = renderMap(baseProps({ venue, network: NETWORK, levelId: "level-1" }));
    act(() => {
      map.styleLoaded = true;
      map.emit("sourcedata", READY_EVENT);
    });

    rerender(baseProps({ venue, network: NETWORK, levelId: "level-2" })); // busy; deferred
    rerender(baseProps({ venue, network: NETWORK, levelId: "level-1" })); // back before settle
    act(() => {
      map.styleLoaded = true;
      map.emit("sourcedata", READY_EVENT);
    });
    expect(ids(map)).toEqual([1, 1]);
  });
});

describe("IndoorMap issue pins", () => {
  it("renders current-floor pins from the issue-review projection", () => {
    const pins: MapIssuePin[] = [
      { id: "i1", pinNumber: 1, levelId: "level-1", longitude: 10, latitude: 20, summary: "Gate", status: "open" },
      { id: "i2", pinNumber: 2, levelId: "level-2", longitude: 30, latitude: 40, summary: "Sign", status: "open" },
    ];
    const { map } = renderMap(baseProps({ issueReview: review({ pins }) }));
    const overlay = map.container.querySelector(".issue-pin-overlay");
    expect(overlay).toBeTruthy();
    const buttons = [...map.container.querySelectorAll("button")].filter((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("Issue #"),
    );
    expect(buttons.map((b) => b.textContent)).toEqual(["1"]);
  });
});

describe("IndoorMap facilities", () => {
  const facilities = [
    { lon: 139.7, lat: 35.6, ordinal: 0, name: "Gate", icon: "ticket", anchor: { lon: 139.7, lat: 35.6, ordinal: 0 } },
    { lon: 139.8, lat: 35.7, ordinal: 1, name: "Upstairs shop", icon: "", anchor: null },
  ];

  it("updates the facility source exactly once with the active floor's markers", () => {
    const { map, rerender } = renderMap(baseProps({ facilities }));
    const first = map.facilitySourceData.at(-1) as GeoJSON.FeatureCollection;
    expect(first.features).toHaveLength(1);
    expect(first.features[0]?.properties?.["name"]).toBe("Gate");
    const updatesBeforeFloorChange = map.facilitySourceData.length;

    rerender(baseProps({ facilities, levelId: "level-2" }));

    expect(map.facilitySourceData).toHaveLength(updatesBeforeFloorChange + 1);
    const second = map.facilitySourceData.at(-1) as GeoJSON.FeatureCollection;
    expect(second.features).toHaveLength(1);
    expect(second.features[0]?.properties?.["name"]).toBe("Upstairs shop");
  });

  it("keeps the initial empty facility data without invalidating it on floor changes", () => {
    const { map, rerender } = renderMap(baseProps({ facilities: [], levelId: "level-1" }));
    const initial = map.facilitySourceData.at(-1) as GeoJSON.FeatureCollection;
    expect(initial.features).toEqual([]);
    const updatesBeforeFloorChange = map.facilitySourceData.length;

    rerender(baseProps({ facilities: [], levelId: "level-2" }));

    expect(map.facilitySourceData).toHaveLength(updatesBeforeFloorChange);
    const final = map.facilitySourceData.at(-1) as GeoJSON.FeatureCollection;
    expect(final.features).toEqual([]);
  });

  it("clears active facility data exactly once when facilities are removed", () => {
    const { map, rerender } = renderMap(baseProps({ facilities }));
    const updatesBeforeFacilitiesRemoved = map.facilitySourceData.length;

    rerender(baseProps({ facilities: [] }));

    expect(map.facilitySourceData).toHaveLength(updatesBeforeFacilitiesRemoved + 1);
    const final = map.facilitySourceData.at(-1) as GeoJSON.FeatureCollection;
    expect(final.features).toEqual([]);
  });

  it("reports a tapped facility through onSelectFacility", () => {
    const onSelectFacility = vi.fn();
    const { map } = renderMap(baseProps({ facilities, onSelectFacility }));

    map.queryResult = [{ properties: { kind: "facility", index: 0 } }];
    act(() => {
      map.emit("click", { point: { x: 2, y: 2 }, lngLat: { lng: 139.7, lat: 35.6 } });
    });

    expect(onSelectFacility).toHaveBeenCalledWith(facilities[0]);
  });

  it("defers facility markers while the style is busy, applying them on sourcedata", () => {
    mapState.setFlipStyleLoadedOnIndoorWrite(true);
    const venue = baseVenue();
    venue.renderFeaturesByLevel.set("level-1", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-1",
          properties: { __feature_id: "floor-1" },
          geometry: { type: "Point", coordinates: [139.1, 35.6] },
        },
      ],
    });
    venue.renderFeaturesByLevel.set("level-2", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "floor-2",
          properties: { __feature_id: "floor-2" },
          geometry: { type: "Point", coordinates: [139.2, 35.6] },
        },
      ],
    });
    const last = (map: FakeMap) => map.facilitySourceData.at(-1) as GeoJSON.FeatureCollection;
    const { map, rerender } = renderMap(baseProps({ venue, facilities, levelId: "level-1" }));
    const settle = (): void => {
      act(() => {
        map.styleLoaded = true;
        map.emit("sourcedata", READY_EVENT);
      });
    };
    settle();
    expect(last(map).features[0]?.properties?.["name"]).toBe("Gate");

    rerender(baseProps({ venue, facilities, levelId: "level-2" }));
    expect(last(map).features[0]?.properties?.["name"]).toBe("Gate"); // busy: stale

    settle();
    expect(last(map).features[0]?.properties?.["name"]).toBe("Upstairs shop");
  });
});

function editing(
  overrides: Partial<NonNullable<IndoorMapProps["networkEditing"]>> = {},
): NonNullable<IndoorMapProps["networkEditing"]> {
  return {
    tool: "select",
    selection: null,
    pendingNodeId: null,
    onPick: vi.fn(),
    centerActionLabel: "Pick at map center",
    ...overrides,
  };
}

describe("IndoorMap network editing", () => {
  it("reports a junction pick when a junction hit is under the click", () => {
    const net = editing();
    const { map } = renderMap(baseProps({ networkEditing: net }));
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [{ properties: { NODEID: 5 } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
    });
    expect(net.onPick).toHaveBeenCalledWith({ kind: "junction", nodeId: 5 });
  });

  it("reports a connection pick when only a path hit is under the click", () => {
    const net = editing();
    const { map } = renderMap(baseProps({ networkEditing: net }));
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [];
    map.queryByLayer[LAYER_NETWORK_PATH_HIT] = [{ properties: { PATHID: 1, RPATHID: 2 } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
    });
    expect(net.onPick).toHaveBeenCalledWith({
      kind: "connection",
      connectionId: { pathId: 1, reversePathId: 2 },
    });
  });

  it("prefers a junction over a connection under the same click", () => {
    const net = editing();
    const { map } = renderMap(baseProps({ networkEditing: net }));
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [{ properties: { NODEID: 8 } }];
    map.queryByLayer[LAYER_NETWORK_PATH_HIT] = [{ properties: { PATHID: 1, RPATHID: 2 } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
    });
    expect(net.onPick).toHaveBeenCalledWith({ kind: "junction", nodeId: 8 });
  });

  it("reports a connection pick from a translated vertical marker", () => {
    const net = editing();
    const { map } = renderMap(baseProps({ networkEditing: net }));
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [];
    map.queryByLayer[LAYER_NETWORK_VERTICAL_LINK_HIT] = [
      { properties: { PATHID: 7, RPATHID: 8 } },
    ];
    map.queryByLayer[LAYER_NETWORK_PATH_HIT] = [];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
    });
    expect(net.onPick).toHaveBeenCalledWith({
      kind: "connection",
      connectionId: { pathId: 7, reversePathId: 8 },
    });
  });

  it("keeps a junction ahead of a vertical marker at the same query point", () => {
    const net = editing();
    const { map } = renderMap(baseProps({ networkEditing: net }));
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [{ properties: { NODEID: 10 } }];
    map.queryByLayer[LAYER_NETWORK_VERTICAL_LINK_HIT] = [
      { properties: { PATHID: 7, RPATHID: 8 } },
    ];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } });
    });
    expect(net.onPick).toHaveBeenCalledWith({ kind: "junction", nodeId: 10 });
  });

  it("uses a pointer cursor over a vertical marker", () => {
    const { map } = renderMap(baseProps({ networkEditing: editing({ tool: "select" }) }));
    map.queryByLayer[LAYER_NETWORK_VERTICAL_LINK_HIT] = [
      { properties: { PATHID: 7, RPATHID: 8 } },
    ];
    act(() => {
      map.emit("mousemove", { point: { x: 1, y: 1 } });
    });
    expect(map.canvas.style.cursor).toBe("pointer");
  });

  it("reports a bare coordinate when nothing is under the click", () => {
    const net = editing({ tool: "add-junction" });
    const { map } = renderMap(baseProps({ networkEditing: net }));
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 139.5, lat: 35.4 } });
    });
    expect(net.onPick).toHaveBeenCalledWith({ kind: "map", longitude: 139.5, latitude: 35.4 });
  });

  it("move-junction reports a coordinate even over a junction hit", () => {
    const net = editing({ tool: "move-junction", pendingNodeId: 3 });
    const { map } = renderMap(baseProps({ networkEditing: net }));
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [{ properties: { NODEID: 9 } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 3, lat: 4 } });
    });
    expect(net.onPick).toHaveBeenCalledWith({ kind: "map", longitude: 3, latitude: 4 });
  });

  it("suppresses ordinary feature selection while editing", () => {
    const onSelectFeature = vi.fn();
    const net = editing();
    const { map } = renderMap(baseProps({ networkEditing: net, onSelectFeature }));
    map.queryResult = [{ properties: { __feature_id: "unit-3" } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 1 } });
    });
    expect(onSelectFeature).not.toHaveBeenCalled();
    expect(net.onPick).toHaveBeenCalled();
  });

  it("routes the map-center action through the same semantic pick", () => {
    const net = editing();
    const { map } = renderMap(baseProps({ networkEditing: net }));
    map.center = { lng: 10, lat: 20 };
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [{ properties: { NODEID: 7 } }];
    act(() => {
      screen.getByRole("button", { name: "Pick at map center" }).click();
    });
    expect(net.onPick).toHaveBeenCalledWith({ kind: "junction", nodeId: 7 });
  });

  it("shows the network map-center action only while editing", () => {
    renderMap(baseProps({ networkEditing: editing({ centerActionLabel: "接続点を選択" }) }));
    expect(screen.getByRole("button", { name: "接続点を選択" })).toBeTruthy();
  });

  it("uses a crosshair cursor for add and move tools", () => {
    const { map } = renderMap(baseProps({ networkEditing: editing({ tool: "add-junction" }) }));
    act(() => {
      map.emit("mousemove", { point: { x: 1, y: 1 } });
    });
    expect(map.canvas.style.cursor).toBe("crosshair");
  });

  it("uses a not-allowed cursor over empty map in delete tool", () => {
    const { map } = renderMap(baseProps({ networkEditing: editing({ tool: "delete" }) }));
    act(() => {
      map.emit("mousemove", { point: { x: 1, y: 1 } });
    });
    expect(map.canvas.style.cursor).toBe("not-allowed");
  });

  it("uses a pointer cursor over network data in select tool", () => {
    const { map } = renderMap(baseProps({ networkEditing: editing({ tool: "select" }) }));
    map.queryByLayer[LAYER_NETWORK_JUNCTION_HIT] = [{ properties: { NODEID: 1 } }];
    act(() => {
      map.emit("mousemove", { point: { x: 1, y: 1 } });
    });
    expect(map.canvas.style.cursor).toBe("pointer");
  });

  it("restores ordinary selection after editing ends", () => {
    const onSelectFeature = vi.fn();
    const { map, rerender } = renderMap(baseProps({ networkEditing: editing(), onSelectFeature }));
    rerender(baseProps({ networkEditing: null, onSelectFeature }));
    map.queryResult = [{ properties: { __feature_id: "unit-3" } }];
    act(() => {
      map.emit("click", { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 1 } });
    });
    expect(onSelectFeature).toHaveBeenCalledWith("unit-3");
  });
});

describe("IndoorMap scene context loss", () => {
  it("reports a lost context so the source machine can fall back", () => {
    const onSceneContextLost = vi.fn();
    const { map } = renderMap(baseProps({ onSceneContextLost }));

    act(() => {
      map.emitCanvas("webglcontextlost");
    });

    expect(onSceneContextLost).toHaveBeenCalledTimes(1);
  });

  it("reports a restored context, and keeps listening across the outage", () => {
    const onSceneContextLost = vi.fn();
    const onSceneContextRestored = vi.fn();
    const { map } = renderMap(baseProps({ onSceneContextLost, onSceneContextRestored }));

    // The listeners belong to the map, not to any one scene: a second outage
    // after a recovery must still be heard.
    act(() => {
      map.emitCanvas("webglcontextlost");
      map.emitCanvas("webglcontextrestored");
      map.emitCanvas("webglcontextlost");
      map.emitCanvas("webglcontextrestored");
    });

    expect(onSceneContextLost).toHaveBeenCalledTimes(2);
    expect(onSceneContextRestored).toHaveBeenCalledTimes(2);
  });

  it("stops listening once the map is gone", () => {
    const onSceneContextLost = vi.fn();
    const props = baseProps({ onSceneContextLost });
    const utils = render(<IndoorMap {...props} />);
    const map = lastMap();
    utils.unmount();

    act(() => {
      map.emitCanvas("webglcontextlost");
    });

    expect(onSceneContextLost).not.toHaveBeenCalled();
  });
});

describe("IndoorMap scene floor elevation", () => {
  const scene = sceneWithPlanes([
    ["level-1", 8],
    ["level-2", 12],
  ]);

  it("defers terrain until the initial style finishes loading", () => {
    mapState.setInitialStyleLoaded(false);

    const utils = render(<IndoorMap {...baseProps({ scene })} />);
    const map = lastMap();
    expect(map.initialFloorStyleTiles).toEqual([
      "kiriko-floor://8000/{z}/{x}/{y}",
    ]);
    expect(map.terrainCalls).toEqual([]);

    map.styleLoaded = true;
    act(() => {
      map.emit("load");
    });

    expect(map.floorTileUrls).toEqual([]);
    expect(map.terrainCalls.at(-1)).toEqual({
      source: FLOOR_ELEVATION_SOURCE_ID,
      exaggeration: 1,
    });
    utils.unmount();
  });
  it("does not recreate terrain when the active plane is unchanged", () => {
    const { map, rerender } = renderMap(baseProps({ scene, levelId: "level-1" }));

    expect(map.terrainCalls).toEqual([
      {
        source: FLOOR_ELEVATION_SOURCE_ID,
        exaggeration: 1,
      },
    ]);

    rerender(
      baseProps({
        scene,
        levelId: "level-1",
        directions: crossFloorDirections(CROSS_FLOOR_ROUTE),
      }),
    );

    expect(map.terrainCalls).toHaveLength(1);
  });
  it("waits for both floor and indoor sources before exposing a new scene floor", () => {
    const { map, rerender } = renderMap(baseProps({ scene, levelId: "level-1" }));
    mapState.setLoadFloorSourceOnAdd(false);
    map.sourceLoaded = false;
    map.styleLoaded = false;

    rerender(baseProps({ scene, levelId: "level-2" }));

    expect(map.styleLoaded).toBe(false);
    expect(map.floorSourceOperations).toEqual([
      { kind: "remove" },
      {
        kind: "add",
        tiles: ["kiriko-floor://12000/{z}/{x}/{y}"],
      },
    ]);
    expect(map.terrainCalls.at(-1)).toBeNull();
    expect(currentSceneDiagnostics().activeLevelIndices()).toEqual([0]);

    act(() => {
      map.floorSourceLoaded = true;
      map.emit("sourcedata", {
        sourceId: FLOOR_ELEVATION_SOURCE_ID,
        isSourceLoaded: true,
        dataType: "source",
      });
    });
    expect(map.terrainCalls.at(-1)).toBeNull();
    expect(currentSceneDiagnostics().activeLevelIndices()).toEqual([0]);

    act(() => {
      map.sourceLoaded = true;
      map.styleLoaded = true;
      map.emit("sourcedata", READY_EVENT);
    });
    expect(map.terrainCalls.at(-1)).toEqual({
      source: FLOOR_ELEVATION_SOURCE_ID,
      exaggeration: 1,
    });
    expect(currentSceneDiagnostics().activeLevelIndices()).toEqual([1]);
  });


  it("replaces a zero-plane source when the scene arrives after map creation", () => {
    const { map, rerender } = renderMap(baseProps({ scene: null }));
    expect(map.initialFloorStyleTiles).toEqual([
      "kiriko-floor://0/{z}/{x}/{y}",
    ]);

    rerender(baseProps({ scene, levelId: "level-1" }));

    expect(map.floorSourceOperations).toEqual([
      { kind: "remove" },
      {
        kind: "add",
        tiles: ["kiriko-floor://8000/{z}/{x}/{y}"],
      },
    ]);
    expect(map.floorTileUrls).toEqual([]);
    expect(map.terrainCalls.at(-1)).toEqual({
      source: FLOOR_ELEVATION_SOURCE_ID,
      exaggeration: 1,
    });
  });


  it("attaches terrain at the active scene plane and swaps floors in place", () => {
    const { map, rerender } = renderMap(baseProps({ scene, levelId: "level-1" }));

    expect(map.initialFloorStyleTiles).toEqual([
      "kiriko-floor://8000/{z}/{x}/{y}",
    ]);
    expect(map.floorTileUrls).toEqual([]);
    expect(map.terrainCalls.at(-1)).toEqual({
      source: FLOOR_ELEVATION_SOURCE_ID,
      exaggeration: 1,
    });

    rerender(baseProps({ scene, levelId: "level-2" }));

    expect(map.floorSourceOperations).toEqual([
      { kind: "remove" },
      {
        kind: "add",
        tiles: ["kiriko-floor://12000/{z}/{x}/{y}"],
      },
    ]);
    expect(map.terrainCalls.at(-1)).toEqual({
      source: FLOOR_ELEVATION_SOURCE_ID,
      exaggeration: 1,
    });

    rerender(
      baseProps({
        scene,
        levelId: "level-2",
        directions: crossFloorDirections(CROSS_FLOOR_ROUTE),
      }),
    );
    expect(map.floorSourceOperations).toHaveLength(2);
  });

  it("detaches terrain when the scene returns to 2D", () => {
    const { map, rerender } = renderMap(baseProps({ scene }));

    rerender(baseProps({ scene: null }));

    expect(map.terrainCalls.at(-1)).toBeNull();
  });

  it("does not manufacture a plane for contradictory composite levels", () => {
    const contradictory = sceneWithPlanes([
      ["level-1", 8],
      ["level-1", 8.002],
    ]);

    const { map } = renderMap(baseProps({ scene: contradictory }));

    expect(map.floorTileUrls).toEqual([]);
    expect(map.terrainCalls).toEqual([]);
  });

  it("owns the floor protocol for exactly the map lifetime", () => {
    const utils = render(<IndoorMap {...baseProps()} />);
    const map = lastMap();
    expect(mapState.protocolAdds).toEqual([FLOOR_ELEVATION_PROTOCOL]);

    utils.unmount();

    expect(map.removed).toBe(true);
    expect(mapState.protocolRemovals).toEqual([FLOOR_ELEVATION_PROTOCOL]);
    expect(mapState.lifecycleEvents).toEqual([
      "map.remove",
      `protocol.remove:${FLOOR_ELEVATION_PROTOCOL}`,
    ]);
  });

  it("retains the next route floor after the transient handoff and clears it with the route", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderMap(
        baseProps({
          scene,
          levelId: "level-1",
          directions: crossFloorDirections(CROSS_FLOOR_ROUTE),
        }),
      );

      rerender(
        baseProps({
          scene,
          levelId: "level-2",
          directions: crossFloorDirections(CROSS_FLOOR_ROUTE),
        }),
      );
      expect(currentSceneDiagnostics().activeLevelIndices()).toEqual([1]);
      expect(currentSceneDiagnostics().contextLevelIndices()).toEqual([0]);

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(currentSceneDiagnostics().contextLevelIndices()).toEqual([0]);

      rerender(
        baseProps({
          scene,
          levelId: "level-2",
          directions: crossFloorDirections(null),
        }),
      );
      expect(currentSceneDiagnostics().contextLevelIndices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains route context without a handoff under reduced motion", () => {
    window.matchMedia = ((query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const showContext = vi.spyOn(SceneLayer.prototype, "setShowContextLevels");
    const { rerender } = renderMap(
      baseProps({
        scene,
        levelId: "level-1",
        directions: crossFloorDirections(CROSS_FLOOR_ROUTE),
      }),
    );
    showContext.mockClear();

    rerender(
      baseProps({
        scene,
        levelId: "level-2",
        directions: crossFloorDirections(CROSS_FLOOR_ROUTE),
      }),
    );

    expect(showContext).not.toHaveBeenCalledWith(true);
    expect(currentSceneDiagnostics().activeLevelIndices()).toEqual([1]);
    expect(currentSceneDiagnostics().contextLevelIndices()).toEqual([0]);
  });
});
