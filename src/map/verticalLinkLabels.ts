/**
 * Glyph-independent labels for vertical link markers.
 *
 * The indoor style deliberately ships no `glyphs` source, so a MapLibre
 * `text-field` symbol can never rasterize visible copy. Instead each unique
 * `(targetDirection, targetFloor)` pair is drawn once as an SVG data-URI
 * image, registered on the map style, and referenced by the label layer
 * through a per-feature `labelImage` image id. The arrow glyphs are
 * language-neutral and the floor token is exported floor data, so no
 * localized string is introduced.
 */

export const VERTICAL_LINK_LABEL_PREFIX = "vertical-link-label";

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
 * One SVG data URI rasterizing the visible label without style glyphs. The
 * white stroke (`paint-order="stroke"`) reproduces the former text halo, and
 * the magenta fill matches the vertical-link marker color.
 */
export function buildVerticalLinkLabelImageDataUrl(
  direction: "up" | "down",
  targetFloor: string,
): string {
  const text = verticalLinkLabelText(direction, targetFloor);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="20" viewBox="0 0 48 20">` +
    `<text x="2" y="14.5" font-family="'Segoe UI', system-ui, -apple-system, sans-serif" ` +
    `font-size="11" font-weight="600" fill="#d81b8c" stroke="#ffffff" stroke-width="2" ` +
    `paint-order="stroke">${text}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Minimal MapLibre surface needed to register style images. `loadImage`
 * resolves to the decoded image resource (an `ImageBitmap`/`HTMLImageElement`
 * in maplibre-gl v5, or an `{width,height,data}` payload in older versions);
 * the module only forwards whatever the map decoded back to `addImage`.
 */
export interface ImageRegistry {
  hasImage(id: string): boolean;
  loadImage(url: string): Promise<{ data: unknown }>;
  addImage(id: string, image: unknown): void;
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
 * Register one SVG label image per unique (targetDirection, targetFloor).
 * Idempotent and race-safe: skips ids already present and re-checks before
 * `addImage`, mirroring the facility icon loader. A symbol referencing an
 * image that has not finished loading is simply not drawn yet, then appears
 * once the image resolves.
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
    void registry
      .loadImage(buildVerticalLinkLabelImageDataUrl(direction, targetFloor))
      .then((result) => {
        if (result != null && !registry.hasImage(name)) {
          registry.addImage(name, result.data);
        }
      })
      .catch(() => {
        /* a failed rasterization leaves the marker unlabeled, never crashes the map */
      });
  }
}
