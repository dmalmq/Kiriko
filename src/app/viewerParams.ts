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

  return { src: safeSrc(params.get("src"), base), level, embed, locale, dataset, forceViewer, review, version };
}
