/**
 * Glyph-independent labels for vertical link markers.
 *
 * The indoor style deliberately ships no `glyphs` source, so a MapLibre
 * `text-field` symbol can never rasterize visible copy. Instead each unique
 * `(targetDirection, targetFloor)` pair is drawn once onto an offscreen
 * canvas and registered as a map style image (`map.addImage`), referenced by
 * the label layer through a per-feature `labelImage` image id. The arrow
 * glyphs are language-neutral and the floor token is exported floor data, so
 * no localized string is introduced.
 */

export const VERTICAL_LINK_LABEL_PREFIX = "vertical-link-label";
export const VERTICAL_LINK_LABEL_WIDTH = 48;
export const VERTICAL_LINK_LABEL_HEIGHT = 20;
const LABEL_FONT = "600 11px 'Segoe UI', system-ui, -apple-system, sans-serif";
const LABEL_COLOR = "#d81b8c";
const LABEL_HALO_COLOR = "#ffffff";

/** Deterministic style-image id for one (direction, floor) pair. */
export function verticalLinkLabelImageName(
  direction: "up" | "down",
  targetFloor: string,
): string {
  return `${VERTICAL_LINK_LABEL_PREFIX}-${direction}-${targetFloor}`;
}

/** Visible label copy: a neutral arrow plus the language-neutral floor token. */
export function verticalLinkLabelText(
  direction: "up" | "down",
  targetFloor: string,
): string {
  return `${direction === "up" ? "↑" : "↓"} ${targetFloor}`;
}

/**
 * Minimal canvas-2d surface used to rasterize a label. A structural subset of
 * `CanvasRenderingContext2D` so tests can drive a recording fake.
 */
export interface LabelCanvas2D {
  font: string;
  textAlign: string;
  textBaseline: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: string;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): { width: number; height: number; data: Uint8ClampedArray };
}

/**
 * Paint the visible label onto a 2d context: white halo stroke underneath,
 * magenta fill on top — the same look as the former text-field paint, minus
 * MapLibre glyphs.
 */
export function paintVerticalLinkLabel(
  ctx: LabelCanvas2D,
  direction: "up" | "down",
  targetFloor: string,
): void {
  const text = verticalLinkLabelText(direction, targetFloor);
  ctx.font = LABEL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = LABEL_HALO_COLOR;
  ctx.lineWidth = 3;
  ctx.strokeText(text, 2, VERTICAL_LINK_LABEL_HEIGHT / 2);
  ctx.fillStyle = LABEL_COLOR;
  ctx.fillText(text, 2, VERTICAL_LINK_LABEL_HEIGHT / 2);
}

/**
 * Rasterize one label to an addImage-ready RGBA image, or `null` when no 2d
 * rasterizer is available (the marker then stays unlabeled, never crashes).
 * Canvas rasterization is what makes the visible copy independent of style
 * glyphs.
 */
export function buildVerticalLinkLabelImage(
  direction: "up" | "down",
  targetFloor: string,
): { width: number; height: number; data: Uint8ClampedArray } | null {
  const canvas = document.createElement("canvas");
  canvas.width = VERTICAL_LINK_LABEL_WIDTH;
  canvas.height = VERTICAL_LINK_LABEL_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (ctx == null) {
    return null;
  }
  paintVerticalLinkLabel(ctx, direction, targetFloor);
  return ctx.getImageData(0, 0, VERTICAL_LINK_LABEL_WIDTH, VERTICAL_LINK_LABEL_HEIGHT);
}

/** Minimal MapLibre surface needed to register style images. */
export interface ImageRegistry {
  hasImage(id: string): boolean;
  addImage(
    id: string,
    image: { width: number; height: number; data: Uint8ClampedArray },
  ): void;
}

export interface VerticalLinkLabelPair {
  direction: "up" | "down";
  targetFloor: string;
}

/** Unique (direction, floor) pairs among the given vertical-link features. */
export function verticalLinkLabelPairs(
  features: readonly GeoJSON.Feature[],
): VerticalLinkLabelPair[] {
  const seen = new Set<string>();
  const pairs: VerticalLinkLabelPair[] = [];
  for (const feature of features) {
    const properties = feature.properties;
    if (properties == null || properties.kind !== "vertical-link") {
      continue;
    }
    const direction = properties.targetDirection;
    const targetFloor = properties.targetFloor;
    if (direction !== "up" && direction !== "down") {
      continue;
    }
    if (typeof targetFloor !== "string" || targetFloor.length === 0) {
      continue;
    }
    const key = `${direction}:${targetFloor}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pairs.push({ direction, targetFloor });
  }
  return pairs;
}

/**
 * Register one canvas-rasterized label image per unique
 * (targetDirection, targetFloor). Idempotent: skips ids already present. A
 * symbol referencing an image that is not registered yet is simply not drawn
 * until the image is added.
 */
export function registerVerticalLinkLabelImages(
  registry: ImageRegistry,
  features: readonly GeoJSON.Feature[],
): void {
  for (const { direction, targetFloor } of verticalLinkLabelPairs(features)) {
    const name = verticalLinkLabelImageName(direction, targetFloor);
    if (registry.hasImage(name)) {
      continue;
    }
    const image = buildVerticalLinkLabelImage(direction, targetFloor);
    if (image == null) {
      continue;
    }
    registry.addImage(name, image);
  }
}
