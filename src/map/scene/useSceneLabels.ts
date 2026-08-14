/**
 * The scene's label overlay: DOM labels placed from the renderer's own
 * projection, so a label sits on the floor it names (#23 D5, #32).
 *
 * Why not the 2D marker overlay: it projects a longitude and latitude onto the
 * map plane at zero elevation, which is correct in 2D and metres wrong on a
 * pitched camera. And it deliberately shows up to two hundred markers, which is
 * right for a flat plan and unreadable over a perspective scene — so in 3D that
 * overlay steps aside and this one takes over, capped and prioritized.
 *
 * Only one label system renders at a time. Two would double every name.
 */
import { useEffect } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { LoadedVenue, LocaleCode, ViewerFeature } from "../../imdf/types";
import { markerIconFor } from "../markerIcons";
import type { ParsedNetwork } from "../networkFeatures";
import { verticalLinkLabelText } from "../verticalLinkLabels";
import { conveyanceDirections, type ConveyanceDirection } from "./conveyanceDirection";
import { rampGlyph } from "./conveyanceGlyphs";
import {
  layoutSceneLabels,
  type LabelCandidate,
  type LabelMode,
  type PlacedLabel,
} from "./sceneLabels";
import type { SceneLayer } from "./sceneLayer";

const OVERLAY_CLASS = "scene-labels";

/**
 * Chrome the labels must not hide behind. Measured every layout rather than
 * assumed, because panels open, close, and reflow with the viewport.
 */
const CHROME_SELECTORS = [
  ".floating-panel",
  ".floor-stack",
  ".icon-rail",
  ".context-bar",
  ".top-actions",
  ".scene-source",
  ".scene-notice",
  ".map-attribution",
  ".facility-popup",
] as const;

/** Conveyance categories, in the order a reviewer meets them on signage. */
const CONVEYANCE_CATEGORIES: Record<string, true> = {
  elevator: true,
  escalator: true,
  stairs: true,
  steps: true,
  ramp: true,
  movingwalkway: true,
};

/** Feature types that can carry a landmark label. */
const LANDMARK_TYPES: Record<string, true> = {
  occupant: true,
  amenity: true,
  kiosk: true,
};

/**
 * Prose for the directed badge's accessible name. The visible chevron itself
 * is language-neutral (arrow + floor token, like the 2D overlay); only the
 * spoken name needs words, in both locales.
 */
const DIRECTION_WORDS: Record<"up" | "down", Record<LocaleCode, string>> = {
  up: { ja: "上り", en: "up" },
  down: { ja: "下り", en: "down" },
};

export interface UseSceneLabelsArgs {
  map: MapLibreMap | null;
  layer: SceneLayer | null;
  venue: LoadedVenue;
  levelId: string;
  locale: LocaleCode;
  selectedFeatureId: string | null;
  /** Guidance caps labels harder than overview does (#32). */
  mode: LabelMode;
  enabled: boolean;
  /**
   * The parsed routing graph, when it is loaded. Conveyance badges show their
   * direction chevron only from this evidence; null renders today's plain
   * badges.
   */
  network: ParsedNetwork | null;
  /** Mirrors the flat overlay's contract: id plus the feature's own centre. */
  onSelect: (featureId: string, center: [number, number]) => void;
}

/** A conveyance's pictogram, or the neutral form when the set has none. */
export function conveyanceIcon(category: string): string {
  return markerIconFor(category) ?? rampGlyph();
}

function labelText(feature: ViewerFeature, locale: LocaleCode): string {
  const name = feature.labels[locale] ?? feature.labels["en"] ?? feature.labels["ja"];
  if (name !== undefined && name !== "") {
    return name;
  }
  return feature.category ?? "";
}

/** The label candidates for one floor, tiered by what the reviewer is doing. */
export function collectSceneLabelCandidates(
  venue: LoadedVenue,
  levelId: string,
  locale: LocaleCode,
  selectedFeatureId: string | null,
  directions: ReadonlyMap<string, ConveyanceDirection>,
): Omit<LabelCandidate, "screen" | "size">[] {
  const candidates: Omit<LabelCandidate, "screen" | "size">[] = [];
  for (const feature of venue.featuresById.values()) {
    if (feature.center === null || feature.levelId !== levelId) {
      continue;
    }
    const category = feature.category ?? "";
    const selected = feature.id === selectedFeatureId;
    const conveyance = Object.hasOwn(CONVEYANCE_CATEGORIES, category);
    const landmark = Object.hasOwn(LANDMARK_TYPES, feature.featureType);
    if (!selected && !conveyance && !landmark) {
      continue;
    }
    const text = labelText(feature, locale);
    if (text === "" && !conveyance) {
      continue;
    }
    const direction = conveyance ? directions.get(feature.id) : undefined;
    candidates.push({
      id: feature.id,
      // A selected conveyance keeps its badge rather than losing its pictogram
      // to the selection tier.
      tier: selected && !conveyance ? "selection" : conveyance ? "conveyance" : "landmark",
      text,
      // The subject of the view survives the cap: the selection always, and a
      // selected conveyance both ways.
      protected: selected,
      ...(conveyance ? { icon: conveyanceIcon(category) } : {}),
      // Graph evidence only; absent when no vertical link matched this
      // conveyance, exactly like today's plain badge.
      ...(direction === undefined ? {} : { direction }),
    });
  }
  return candidates;
}

/** Estimated box for a label before it is measured; keeps layout deterministic. */
function estimateSize(candidate: Omit<LabelCandidate, "screen" | "size">): {
  width: number;
  height: number;
} {
  if (candidate.icon !== undefined) {
    // A directed badge carries the pictogram plus the direction chevron, so it
    // is a wide pill instead of the round 28 px badge. Same 7 px-per-character
    // rule as the pill face below, plus the badge's own padding.
    if (candidate.direction !== undefined) {
      const chevron = verticalLinkLabelText(candidate.direction.arrow, candidate.direction.targetFloor);
      return { width: 28 + 16 + chevron.length * 7, height: 28 };
    }
    return { width: 28, height: 28 };
  }
  // 7 px per character is the measured average for the pill's 12 px face, plus
  // horizontal padding. Deliberately an estimate, not a measurement: measuring
  // every frame would reflow the overlay it is laying out.
  return { width: Math.min(220, 24 + candidate.text.length * 7), height: 24 };
}

function renderLabels(
  overlay: HTMLDivElement,
  placed: readonly PlacedLabel[],
  locale: LocaleCode,
  onSelect: (label: PlacedLabel) => void,
): void {
  overlay.replaceChildren();
  const svgNs = "http://www.w3.org/2000/svg";
  const leaders = document.createElementNS(svgNs, "svg");
  leaders.setAttribute("class", "scene-labels__leaders");
  leaders.setAttribute("aria-hidden", "true");
  overlay.append(leaders);

  for (const label of placed) {
    if (label.leader !== null) {
      const line = document.createElementNS(svgNs, "line");
      line.setAttribute("x1", String(Math.round(label.leader.x1)));
      line.setAttribute("y1", String(Math.round(label.leader.y1)));
      line.setAttribute("x2", String(Math.round(label.leader.x2)));
      line.setAttribute("y2", String(Math.round(label.leader.y2)));
      line.setAttribute("class", "scene-labels__leader");
      leaders.append(line);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      label.icon === undefined
        ? `scene-label scene-label--${label.tier}`
        : `scene-label scene-label--badge scene-label--${label.tier}`;
    // Integral translation: fractional offsets re-rasterize text on every frame
    // of a camera move.
    button.style.transform = `translate(${Math.round(label.box.x)}px, ${Math.round(label.box.y)}px)`;
    button.style.width = `${Math.round(label.box.width)}px`;
    button.style.height = `${Math.round(label.box.height)}px`;
    if (label.icon === undefined) {
      button.textContent = label.text;
      button.title = label.text;
    } else if (label.direction === undefined) {
      button.innerHTML = label.icon;
      button.setAttribute("aria-label", label.text === "" ? label.tier : label.text);
      button.title = label.text;
    } else {
      // Directed badge: the pictogram plus the static direction chevron (arrow
      // + target floor token, the same neutral vocabulary as the 2D overlay).
      // The chevron is aria-hidden; the button's accessible name carries the
      // direction in the active locale.
      const chevron = document.createElement("span");
      chevron.className = "scene-label__chevron";
      chevron.textContent = verticalLinkLabelText(label.direction.arrow, label.direction.targetFloor);
      chevron.setAttribute("aria-hidden", "true");
      const word = DIRECTION_WORDS[label.direction.arrow][locale];
      const accessible = `${label.text} ${word} ${label.direction.targetFloor}`.trim();
      button.innerHTML = label.icon;
      button.append(chevron);
      button.classList.add("scene-label--chevron");
      button.setAttribute("aria-label", accessible === "" ? label.tier : accessible);
      button.title = accessible === "" ? label.text : accessible;
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(label);
    });
    overlay.append(button);
  }
}

/**
 * Place and render the scene's labels, following the camera. Layout runs at most
 * once per animation frame: a camera move fires far more often than that, and
 * every run reads the renderer's projection.
 */
export function useSceneLabels({
  map,
  layer,
  venue,
  levelId,
  locale,
  selectedFeatureId,
  mode,
  enabled,
  network,
  onSelect,
}: UseSceneLabelsArgs): void {
  useEffect(() => {
    if (map === null || layer === null || !enabled) {
      return;
    }
    const container = map.getContainer();
    const overlay = document.createElement("div");
    overlay.className = OVERLAY_CLASS;
    container.append(overlay);

    // Labels anchor on the floor's plane; every source level registered to a
    // floor sits on the same one, so the first is as good as any.
    const levelIndex = layer.levelIndicesOf(levelId)[0] ?? 0;
    // Direction evidence comes from the routing graph only, keyed by the
    // active floor's conveyance footprints. A null network (review off, or a
    // bundle with no graph) yields an empty map and today's plain badges.
    const directions = conveyanceDirections(
      network,
      venue.levels,
      levelId,
      [...venue.featuresById.values()].filter(
        (feature) =>
          feature.levelId === levelId &&
          feature.category !== null &&
          Object.hasOwn(CONVEYANCE_CATEGORIES, feature.category),
      ),
    );
    const base = collectSceneLabelCandidates(venue, levelId, locale, selectedFeatureId, directions);
    const anchors = new Map<string, [number, number, number]>();
    for (const candidate of base) {
      const feature = venue.featuresById.get(candidate.id);
      if (feature?.center == null) {
        continue;
      }
      anchors.set(
        candidate.id,
        layer.localFromLngLat(feature.center[0], feature.center[1], levelIndex),
      );
    }

    let frame = 0;
    const relayout = (): void => {
      frame = 0;
      const canvas = map.getCanvas();
      const viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
      if (viewport.width === 0 || viewport.height === 0) {
        return;
      }
      const origin = canvas.getBoundingClientRect();
      // Queried from the document, not the map container: the chrome is a
      // sibling of the map, and only the canvas rect matters for conversion.
      const reserved = CHROME_SELECTORS.flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((element) => {
          const box = element.getBoundingClientRect();
          return {
            x: box.left - origin.left,
            y: box.top - origin.top,
            width: box.width,
            height: box.height,
          };
        }),
      ).filter((box) => box.width > 0 && box.height > 0);
      const candidates: LabelCandidate[] = base.map((candidate) => {
        const local = anchors.get(candidate.id) ?? null;
        return {
          ...candidate,
          screen: local === null ? null : layer.projectLocal(local),
          size: estimateSize(candidate),
        };
      });
      renderLabels(overlay, layoutSceneLabels(candidates, { viewport, mode, reserved }), locale, (label) => {
        const centre = venue.featuresById.get(label.id)?.center ?? null;
        if (centre !== null) {
          onSelect(label.id, centre);
        }
      });
    };

    const schedule = (): void => {
      if (frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(relayout);
    };

    // `render` covers camera moves, resizes, and the first frame the scene's
    // projection exists at all.
    map.on("render", schedule);
    schedule();

    return () => {
      map.off("render", schedule);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      overlay.remove();
    };
  }, [map, layer, venue, levelId, locale, selectedFeatureId, mode, enabled, network, onSelect]);
}
