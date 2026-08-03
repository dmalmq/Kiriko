/**
 * Renderer spike shell (3D rendering spike Task 7): one MapLibre map with a
 * plain raster basemap and the scene custom layer, native HTML diagnostics
 * controls, and a fixed measurement HUD. Disposable spike code: never imported
 * by production modules.
 */
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, MapMouseEvent, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { loadScene, type SceneLevelView, type SceneView, type SemanticRoleName } from "./sceneFormat";
import { createSceneLayer, type SceneLayer } from "./sceneLayer";
import { createFrameMeter, measureOnce, measureOnceAsync, type FrameMeter } from "./measure";
import "./spike.css";

declare global {
  interface Window {
    /**
     * Spike-only measurement handles used by the gate matrix. Declared rather
     * than cast so every assignment stays type-checked.
     */
    __spikeMap?: MapLibreMap;
    __spikeLayer?: SceneLayer;
    __spikeScene?: SceneView;
  }
}

/** Scene URL supplied by `?scene=`. */
const DEFAULT_SCENE_URL = "/spike/tokyo.kscene";
/** Provisional centre used before the scene's frame origin is known. */
const DEFAULT_CENTER: readonly [number, number] = [139.764457, 35.678519];
/** HUD flush period; refs are sampled per render so React never renders at
 *  frame rate inside the measurement loop. */
const HUD_REFRESH_MS = 250;
/** Centre assertion tolerance: the pinned values carry 6 decimals (~0.1 m). */
const CENTER_TOLERANCE_DEG = 1e-5;

/** Pinned frame-origin centres from the Task 7 contract, keyed by staged
 *  scene file name. */
const EXPECTED_CENTERS: Readonly<Record<string, readonly [number, number]>> = {
  "tokyo.kscene": [139.764457, 35.678519],
  "shinjuku.kscene": [139.697031, 35.690503],
  "lumine-est.kscene": [139.701206, 35.691432],
};

/** Plain raster basemap. If the tile host is unreachable the map still
 *  renders the scene layer; the HUD and controls are unaffected. */
const BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  name: "OSM raster basemap",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm-raster", type: "raster", source: "osm" }],
};

// ---------------------------------------------------------------------------
// ECEF → WGS84 geodetic. `sceneLayer.ts` keeps this routine private, so the
// identical formula (same WGS84 constants, same 10-pass iteration) is
// replicated here to derive the map centre from the scene's frame origin.
// The altitude is deliberately ignored: the frame origin is the model corner,
// not ground (see the Task 7 contract).
// ---------------------------------------------------------------------------
const WGS84_SEMI_MAJOR = 6378137.0;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

function ecefToLngLat(ecef: readonly [number, number, number]): [number, number] {
  const [x, y, z] = ecef;
  const p = Math.hypot(x, y);
  const lonRad = Math.atan2(y, x);
  let latRad = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(latRad);
    const n = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const altitude = p / Math.cos(latRad) - n;
    latRad = Math.atan2(z, p * (1 - WGS84_E2 * (n / (n + altitude))));
  }
  return [(lonRad * 180) / Math.PI, (latRad * 180) / Math.PI];
}

/** Pinned expectation for a scene URL, matched by staged file name, or null. */
function expectedCenterFor(sceneUrl: string): readonly [number, number] | null {
  const fileName = (sceneUrl.split(/[/\\]/).pop() ?? "").split("?")[0] ?? "";
  return EXPECTED_CENTERS[fileName] ?? null;
}

interface LoadMetrics {
  decodeMs: number;
  uploadMs: number;
  center: readonly [number, number];
  expectedCenter: readonly [number, number] | null;
  centreOk: boolean;
  featureCount: number;
  levelCount: number;
}

interface LiveMetrics {
  p50: number;
  p95: number;
  frameCount: number;
  drawCalls: number;
  visibleBatches: number;
  pickPath: "rgba32f" | "rgba8";
}

const EMPTY_LIVE: LiveMetrics = {
  p50: 0,
  p95: 0,
  frameCount: 0,
  drawCalls: 0,
  visibleBatches: 0,
  pickPath: "rgba8",
};

interface PickReadout {
  featureIndex: number;
  sourceObjectId: string;
  role: SemanticRoleName;
  canonicalId: string | null;
  levelName: string;
}

type LoadStatus = "loading" | "ready" | "error";

export function RendererSpike() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const layerRef = useRef<SceneLayer | null>(null);
  const sceneRef = useRef<SceneView | null>(null);
  const meterRef = useRef<FrameMeter | null>(null);
  if (meterRef.current === null) {
    meterRef.current = createFrameMeter();
  }
  const lastRenderRef = useRef<number>(0);
  const hoveredIndexRef = useRef<number | null>(null);
  const selectedIndexRef = useRef<number | null>(null);
  // Mirrors of the two controls the layer owns, so the context-restore handler
  // can rebuild into the state the user was actually looking at. Refs rather
  // than state because the handler is registered once, outside React's render.
  const activeLevelRef = useRef(0);
  const showContextRef = useRef(false);

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<LoadMetrics | null>(null);
  const [levels, setLevels] = useState<readonly SceneLevelView[]>([]);
  const [live, setLive] = useState<LiveMetrics>(EMPTY_LIVE);
  const [activeLevel, setActiveLevel] = useState(0);
  const [showAllLevels, setShowAllLevels] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pick, setPick] = useState<PickReadout | null>(null);
  const [selected, setSelected] = useState<PickReadout | null>(null);

  useEffect(() => {
    const container = mapContainerRef.current;
    const meter = meterRef.current;
    if (!container || !meter) {
      return;
    }

    const sceneParam =
      new URLSearchParams(window.location.search).get("scene") ?? DEFAULT_SCENE_URL;

    const map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: [...(expectedCenterFor(sceneParam) ?? DEFAULT_CENTER)],
      zoom: 18.5,
      pitch: 60,
      bearing: 0,
      maxPitch: 60,
      // Without this, a headless screenshot of the WebGL canvas comes back blank
      // or stale, which made the gate 2 and gate 5 visual checks unmeasurable.
      // It costs a copy per frame, so it is a spike-only setting. MapLibre 5.24
      // moved this under canvasContextAttributes.
      canvasContextAttributes: { preserveDrawingBuffer: true, contextType: "webgl2" },
    });
    mapRef.current = map;
    // Spike-only measurement handle: the gate 3 matrix drives the camera from
    // the browser console, and a scripted sweep is more repeatable than
    // synthetic drag events. Never referenced by production code.
    window.__spikeMap = map;
    lastRenderRef.current = performance.now();

    let disposed = false;

    const canvas = map.getCanvas();
    const resetFrameClock = (): void => {
      // Discard gaps (style load, context-loss downtime) so they never
      // pollute the frame-time distribution.
      lastRenderRef.current = performance.now();
    };
    /**
     * MapLibre drops custom layers on context loss and logs "Custom layer ...
     * cannot be restored after WebGL context loss. You will need to re-add it
     * manually". `render` is never called again, so the layer cannot heal
     * itself — the application owns re-adding it. Measured before this handler
     * existed: 31 picks before a forced loss, 0 after, with the layer's own
     * stats frozen at its last pre-loss counts.
     */
    const readdLayerAfterContextLoss = (): void => {
      // KNOWN INCOMPLETE: the correct trigger point is unresolved. MapLibre
      // finishes its own restore after `webglcontextrestored`, so re-adding
      // synchronously there loses the race and the layer is dropped again.
      // Deferring to the first `idle` (below) did not fire in a headless
      // Chromium run either — after a forced loss the layer stays absent
      // (`map.getLayer("scene-3d")` is undefined) and picks stay at 0.
      // Production must own this: see the gate 2 section of the spike report.
      map.once("idle", () => {
        const scene = sceneRef.current;
        if (disposed || !scene || map.getLayer("scene-3d")) {
          return;
        }
        const rebuilt = createSceneLayer(scene, { id: "scene-3d" });
        map.addLayer(rebuilt);
        rebuilt.setActiveLevel(activeLevelRef.current);
        rebuilt.setShowContextLevels(showContextRef.current);
        layerRef.current = rebuilt;
        window.__spikeLayer = rebuilt;
        map.triggerRepaint();
      });
    };
    canvas.addEventListener("webglcontextrestored", resetFrameClock);
    canvas.addEventListener("webglcontextrestored", readdLayerAfterContextLoss);
    map.on("load", resetFrameClock);

    const onRender = (): void => {
      const now = performance.now();
      meter.sample(now - lastRenderRef.current);
      lastRenderRef.current = now;
    };
    map.on("render", onRender);

    const hudTimer = window.setInterval(() => {
      const percentiles = meter.percentiles();
      const stats = layerRef.current?.stats();
      setLive({
        p50: percentiles.p50,
        p95: percentiles.p95,
        frameCount: percentiles.count,
        drawCalls: stats?.drawCalls ?? 0,
        visibleBatches: stats?.visibleBatches ?? 0,
        pickPath: stats?.pickPath ?? "rgba8",
      });
    }, HUD_REFRESH_MS);

    /** Resolve a `SurfacePick` into its feature/level readout, or null when
     *  the pick misses or the feature is out of range. */
    const resolvePick = (
      scene: SceneView,
      featureIndex: number,
    ): PickReadout | null => {
      const feature = scene.features[featureIndex];
      if (!feature) {
        return null;
      }
      const level = scene.levels[feature.levelIndex];
      return {
        featureIndex,
        sourceObjectId: feature.sourceObjectId,
        role: feature.role,
        canonicalId: feature.canonicalId,
        levelName: level?.sourceLevelName ?? "(no level)",
      };
    };

    const onPointerMove = (event: MapMouseEvent): void => {
      const layer = layerRef.current;
      const scene = sceneRef.current;
      if (!layer) {
        return;
      }
      const hit = layer.pickAt(event.point.x, event.point.y);
      const readout = hit !== null && scene ? resolvePick(scene, hit.featureIndex) : null;
      setPick(readout);

      const hovered = readout?.featureIndex ?? null;
      if (hoveredIndexRef.current !== hovered) {
        if (hoveredIndexRef.current !== null) {
          layer.setFeatureState(hoveredIndexRef.current, { hovered: false });
        }
        if (hovered !== null) {
          layer.setFeatureState(hovered, { hovered: true });
        }
        hoveredIndexRef.current = hovered;
      }
    };
    map.on("mousemove", onPointerMove);

    const onClick = (event: MapMouseEvent): void => {
      const layer = layerRef.current;
      const scene = sceneRef.current;
      if (!layer || !scene) {
        return;
      }
      const hit = layer.pickAt(event.point.x, event.point.y);
      if (!hit) {
        return;
      }
      const readout = resolvePick(scene, hit.featureIndex);
      if (readout === null) {
        return;
      }
      if (selectedIndexRef.current !== null && selectedIndexRef.current !== hit.featureIndex) {
        layer.setFeatureState(selectedIndexRef.current, { selected: false });
      }
      layer.setFeatureState(hit.featureIndex, { selected: true });
      selectedIndexRef.current = hit.featureIndex;
      setSelected(readout);
    };
    map.on("click", onClick);

    // ---- scene load + GPU upload, timed ------------------------------
    void (async () => {
      try {
        const response = await fetch(sceneParam);
        if (!response.ok) {
          throw new Error(`scene fetch failed: ${response.status} ${response.statusText}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const { value: scene, ms: decodeMs } = await measureOnceAsync("spike:decode", () =>
          loadScene(bytes),
        );
        if (disposed) {
          return;
        }

        // `map.addLayer` synchronously runs the custom layer's `onAdd`, which
        // builds and uploads every GPU resource, so its wall time is the GPU
        // upload measurement.
        const { value: layer, ms: uploadMs } = measureOnce("spike:upload", () => {
          const created = createSceneLayer(scene, { id: "scene-3d" });
          map.addLayer(created);
          return created;
        });
        layerRef.current = layer;
        // Spike-only: gate 4 probes `pickAt` and `stats()` directly from the
        // console, which is more precise than inferring picks from the HUD.
        window.__spikeLayer = layer;
        window.__spikeScene = scene;

        // Centre on the frame origin (model corner, not ground — altitude is
        // deliberately not treated as terrain).
        const center = ecefToLngLat(scene.header.frameOriginEcef);
        map.setCenter(center);

        const expectedCenter = expectedCenterFor(sceneParam);
        const centreOk =
          expectedCenter !== null &&
          Math.abs(center[0] - expectedCenter[0]) < CENTER_TOLERANCE_DEG &&
          Math.abs(center[1] - expectedCenter[1]) < CENTER_TOLERANCE_DEG;

        setLevels(scene.levels);
        setMetrics({
          decodeMs,
          uploadMs,
          center,
          expectedCenter,
          centreOk,
          featureCount: scene.features.length,
          levelCount: scene.levels.length,
        });
        setStatus("ready");
      } catch (error) {
        if (disposed) {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    })();

    return () => {
      disposed = true;
      window.clearInterval(hudTimer);
      canvas.removeEventListener("webglcontextrestored", resetFrameClock);
      map.off("load", resetFrameClock);
      map.off("render", onRender);
      map.off("mousemove", onPointerMove);
      map.off("click", onClick);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  function handleActiveLevelChange(index: number): void {
    setActiveLevel(index);
    activeLevelRef.current = index;
    layerRef.current?.setActiveLevel(index);
  }

  function handleShowAllLevelsChange(show: boolean): void {
    setShowAllLevels(show);
    showContextRef.current = show;
    layerRef.current?.setShowContextLevels(show);
  }

  function handleReducedMotionChange(reduced: boolean): void {
    // MapLibre 5.24 exposes no public reduced-motion API (it consults an
    // internal module-level flag), so this checkbox drives the shell's own
    // CSS motion and is exposed as `data-reduced-motion` for the measurement
    // matrix to read.
    setReducedMotion(reduced);
  }

  function simulateContextLoss(): void {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    // `getContext("webgl2")` returns the exact context MapLibre created, so
    // the extension instance is the map's own; losing it exercises the
    // layer's context-loss save/restore path.
    const gl = map.getCanvas().getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) {
      setErrorMessage("WEBGL_lose_context unavailable on this context");
      setStatus("error");
      return;
    }
    extension.loseContext();
  }

  return (
    <div
      className={reducedMotion ? "spike-shell is-reduced-motion" : "spike-shell"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <div ref={mapContainerRef} className="spike-map" />

      <aside className="spike-hud" aria-label="Renderer spike measurements">
        <h1>Renderer spike</h1>
        <dl>
          <div>
            <dt>p50</dt>
            <dd>{live.p50.toFixed(1)} ms</dd>
          </div>
          <div>
            <dt>p95</dt>
            <dd>{live.p95.toFixed(1)} ms</dd>
          </div>
          <div>
            <dt>frames</dt>
            <dd>{live.frameCount}</dd>
          </div>
          <div>
            <dt>draw calls</dt>
            <dd>{live.drawCalls}</dd>
          </div>
          <div>
            <dt>visible batches</dt>
            <dd>{live.visibleBatches}</dd>
          </div>
          <div>
            <dt>pick path</dt>
            <dd>{live.pickPath}</dd>
          </div>
          <div>
            <dt>decode</dt>
            <dd>{metrics !== null ? `${metrics.decodeMs.toFixed(1)} ms` : "—"}</dd>
          </div>
          <div>
            <dt>upload</dt>
            <dd>{metrics !== null ? `${metrics.uploadMs.toFixed(1)} ms` : "—"}</dd>
          </div>
          <div>
            <dt>features</dt>
            <dd>{metrics !== null ? metrics.featureCount : "—"}</dd>
          </div>
          <div>
            <dt>levels</dt>
            <dd>{metrics !== null ? metrics.levelCount : "—"}</dd>
          </div>
          <div className="spike-hud__center">
            <dt>centre</dt>
            <dd>
              {metrics === null
                ? "—"
                : `${metrics.center[0].toFixed(6)}, ${metrics.center[1].toFixed(6)}` +
                  (metrics.expectedCenter === null
                    ? " (no pinned expectation)"
                    : ` (expected ${metrics.expectedCenter[0].toFixed(6)}, ${metrics.expectedCenter[1].toFixed(6)}) ${metrics.centreOk ? "OK" : "MISMATCH"}`)}
            </dd>
          </div>
        </dl>
        {status === "loading" && <p className="spike-hud__status">loading scene…</p>}
        {status === "error" && (
          <p className="spike-hud__status spike-hud__status--error">{errorMessage}</p>
        )}
      </aside>

      <section className="spike-controls" aria-label="Scene controls">
        <label className="spike-controls__field">
          Active level
          <select
            value={activeLevel}
            disabled={status !== "ready"}
            onChange={(event) => {
              handleActiveLevelChange(Number(event.target.value));
            }}
          >
            {levels.map((level, index) => (
              <option key={level.canonicalId} value={index}>
                {level.canonicalId} — {level.sourceLevelName}
              </option>
            ))}
          </select>
        </label>
        <label className="spike-controls__check">
          <input
            type="checkbox"
            checked={showAllLevels}
            disabled={status !== "ready"}
            onChange={(event) => {
              handleShowAllLevelsChange(event.target.checked);
            }}
          />
          Show all levels
        </label>
        <label className="spike-controls__check">
          <input
            type="checkbox"
            checked={reducedMotion}
            onChange={(event) => {
              handleReducedMotionChange(event.target.checked);
            }}
          />
          Reduced motion
        </label>
        <button type="button" disabled={status !== "ready"} onClick={simulateContextLoss}>
          Simulate context loss
        </button>
      </section>

      <aside className="spike-pick" aria-label="Pick readout">
        <h2>Pick</h2>
        {pick === null ? (
          <p className="spike-pick__empty">Move the pointer over the scene to pick a feature.</p>
        ) : (
          <dl>
            <div>
              <dt>sourceObjectId</dt>
              <dd>{pick.sourceObjectId}</dd>
            </div>
            <div>
              <dt>role</dt>
              <dd>{pick.role}</dd>
            </div>
            <div>
              <dt>canonicalId</dt>
              <dd>{pick.canonicalId ?? "(none)"}</dd>
            </div>
            <div>
              <dt>level</dt>
              <dd>{pick.levelName}</dd>
            </div>
          </dl>
        )}
        {selected !== null && (
          <p className="spike-pick__selected">
            selected: {selected.sourceObjectId} ({selected.role})
          </p>
        )}
      </aside>
    </div>
  );
}
