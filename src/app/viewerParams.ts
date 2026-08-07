import type { LocaleCode } from "../imdf/types";

export interface ViewerParams {
  src: string | null;
  level: string | null;
  embed: boolean;
  locale: LocaleCode | null;
  dataset: string | null;
  forceViewer: boolean;
  review: boolean;
  /** Optional 64-hex permanent public version identity that pins the viewer. */
  version: string | null;
  /**
   * Opt in to the 3D scene layer. The capability preflight that decides this
   * automatically — and the 2D fallback it falls back to — is a later slice
   * (#62); until then 3D is explicit, so no venue silently changes how it
   * renders.
   */
  scene: boolean;
  /**
   * Preserve the WebGL drawing buffer so a test can read the pixels the
   * renderer actually produced (#26 section 5's capture requirement). Off by
   * default: preserving the buffer costs every frame, and a reviewer gains
   * nothing from it.
   */
  capture: boolean;
}

function safeSrc(raw: string | null, base?: string): string | null {
  if (raw === null || raw === "") {
    return null;
  }
  try {
    const url = new URL(raw, base ?? window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** Parses the viewer's deep-link query params; invalid values degrade to absent. */
export function parseViewerParams(search: string, base?: string): ViewerParams {
  const params = new URLSearchParams(search);

  const levelRaw = params.get("level");
  const level = levelRaw !== null && levelRaw.trim() !== "" ? levelRaw.trim() : null;

  const embedRaw = params.get("embed");
  const embed =
    embedRaw !== null && (embedRaw === "" || /^(1|true)$/i.test(embedRaw));

  const langRaw = params.get("lang");
  const locale: LocaleCode | null = langRaw === "ja" || langRaw === "en" ? langRaw : null;

  const datasetRaw = params.get("dataset");
  const dataset = datasetRaw !== null && datasetRaw.trim() !== "" ? datasetRaw.trim() : null;

  const viewerRaw = params.get("viewer");
  const forceViewer =
    viewerRaw !== null && (viewerRaw === "" || /^(1|true)$/i.test(viewerRaw));

  const reviewRaw = params.get("review");
  const review = reviewRaw !== null && (reviewRaw === "" || /^(1|true)$/i.test(reviewRaw));

  const versionRaw = params.get("version")?.trim() ?? "";
  const version = /^[0-9a-f]{64}$/.test(versionRaw) ? versionRaw : null;

  const sceneRaw = params.get("scene");
  const scene = sceneRaw !== null && (sceneRaw === "" || /^(1|true)$/i.test(sceneRaw));

  const captureRaw = params.get("capture");
  const capture = captureRaw !== null && (captureRaw === "" || /^(1|true)$/i.test(captureRaw));

  return {
    src: safeSrc(params.get("src"), base),
    level,
    embed,
    locale,
    dataset,
    forceViewer,
    review,
    version,
    scene,
    capture,
  };
}
