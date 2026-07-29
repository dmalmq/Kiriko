import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import type { LocaleCode } from "../imdf/types";
import {
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_SCHEME,
  attachmentContentUrl,
  attachmentThumbnailUrl,
} from "./attachmentTokens";
import type { IssueAttachmentMetadata } from "./types";

/**
 * The only Markdown rendering boundary in the app. Raw HTML is never parsed
 * (no rehype-raw, `skipHtml` drops it), only a small allowlist of elements
 * renders, and every link URL passes the http/https/mailto protocol filter
 * before reaching the DOM. Images render exclusively from first-party
 * `attachment:<id>` tokens resolved against server-projected metadata (or a
 * local blob preview inside the editor); remote, data:, and SVG sources can
 * never reach an `<img>`.
 */

export const ISSUE_MARKDOWN_MAX_SCALARS = 4000;

/** Converts CRLF and bare CR to LF — the exact server normalization. */
export function normalizeIssueMarkdown(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

export type IssueBodyProblem =
  | "empty"
  | "too_long"
  | "control_characters"
  | "unpaired_surrogates";

export interface IssueBodyCheck {
  /** Unicode scalar values in the normalized body. */
  scalars: number;
  problem: IssueBodyProblem | null;
}

/**
 * Mirrors the server Markdown contract for immediate composer feedback (the
 * server remains authoritative): 1–4,000 Unicode scalar values after newline
 * normalization, no unpaired UTF-16 surrogates, not whitespace-only, and no
 * C0/C1 controls except tab and LF.
 */
export function checkIssueBody(normalized: string): IssueBodyCheck {
  let scalars = 0;
  let whitespaceOnly = true;
  let problem: IssueBodyProblem | null = null;
  for (let i = 0; i < normalized.length; i += 1) {
    const unit = normalized.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < normalized.length ? normalized.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        problem ??= "unpaired_surrogates";
      } else {
        i += 1;
        scalars += 1;
        whitespaceOnly = false;
      }
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      problem ??= "unpaired_surrogates";
      continue;
    }
    if ((unit <= 0x1f && unit !== 0x09 && unit !== 0x0a) || (unit >= 0x7f && unit <= 0x9f)) {
      problem ??= "control_characters";
      continue;
    }
    scalars += 1;
    if (!/\s/.test(normalized[i] as string)) {
      whitespaceOnly = false;
    }
  }
  if (problem === null) {
    if (whitespaceOnly || scalars === 0) {
      problem = "empty";
    } else if (scalars > ISSUE_MARKDOWN_MAX_SCALARS) {
      problem = "too_long";
    }
  }
  return { scalars, problem };
}

/**
 * Link protocol filter: only absolute `http:`, `https:`, and `mailto:` URLs
 * keep an href. Relative URLs, protocol-relative URLs, and every other
 * scheme (javascript:, data:, …) return `undefined`, which removes the
 * attribute from the rendered anchor.
 */
export function safeIssueUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return url;
    }
  } catch {
    // Relative or malformed input carries no safe protocol.
  }
  return undefined;
}

export interface MarkdownBodyProps {
  /** Normalized Markdown source as stored on the server. */
  body: string;
  /** Attachment metadata projected with the body (plus editor previews). */
  attachments?: IssueAttachmentMetadata[];
  /** Lightbox labeling; defaults to English when absent. */
  locale?: LocaleCode;
}

/** Caps rendered image occurrences against pathological token repetition. */
const MAX_RENDERED_IMAGES = 20;

const lightboxUi = {
  close: { ja: "閉じる", en: "Close" },
  enlarge: { ja: "画像を拡大", en: "Enlarge image" },
} as const;

interface LightboxImage {
  url: string;
  alt: string;
}

interface LightboxProps {
  image: LightboxImage;
  locale: LocaleCode;
  onClose: () => void;
}

/**
 * Accessible lightbox: modal dialog with a real close button, Escape and
 * backdrop dismissal, initial focus on the close control, and focus return
 * to the triggering thumbnail. Opens no new browsing context.
 */
function AttachmentLightbox({ image, locale, onClose }: LightboxProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const background: Array<{ element: HTMLElement; inert: boolean }> = [];
    let active: HTMLElement = dialog;
    while (active.parentElement !== null) {
      for (const sibling of active.parentElement.children) {
        if (sibling !== active && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      active = active.parentElement;
      if (active === document.body) {
        break;
      }
    }
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement)))
        || (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement)))
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      for (const { element, inert } of background) {
        element.inert = inert;
      }
    };
  }, [onClose]);
  return (
    <div
      ref={dialogRef}
      className="issue-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={image.alt}
      tabIndex={-1}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="issue-lightbox__close"
        aria-label={lightboxUi.close[locale]}
        onClick={onClose}
      >
        ×
      </button>
      <img
        className="issue-lightbox__image"
        src={image.url}
        alt={image.alt}
        onClick={(event) => {
          event.stopPropagation();
        }}
      />
    </div>
  );
}

export function MarkdownBody({ body, attachments, locale }: MarkdownBodyProps): ReactElement {
  const resolvedLocale = locale ?? "en";
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const metadataById = useMemo(() => {
    const map = new Map<string, IssueAttachmentMetadata>();
    for (const metadata of attachments ?? []) {
      map.set(metadata.id, metadata);
    }
    return map;
  }, [attachments]);

  const closeLightbox = useCallback(() => {
    setLightbox(null);
  }, []);

  useEffect(() => {
    if (lightbox === null && triggerRef.current !== null) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [lightbox]);

  // Per-render occurrence counter for the image cap. Kept in a ref (reset at
  // the top of every render) so the img component identity can stay stable —
  // a remounting img would detach the lightbox's focus-return target.
  const renderCountRef = useRef(0);
  renderCountRef.current = 0;

  const openLightbox = useCallback((trigger: HTMLButtonElement, image: LightboxImage) => {
    triggerRef.current = trigger;
    setLightbox(image);
  }, []);

  const renderImage = useCallback(
    (props: { node?: unknown; src?: unknown; alt?: unknown }): ReactElement => {
      const { node: _node, src, alt } = props;
      const id =
        typeof src === "string" && src.startsWith(ATTACHMENT_SCHEME)
          ? src.slice(ATTACHMENT_SCHEME.length)
          : null;
      const metadata = id === null ? undefined : metadataById.get(id);
      if (metadata !== undefined && renderCountRef.current < MAX_RENDERED_IMAGES) {
        renderCountRef.current += 1;
        const thumbnailUrl = metadata.previewUrl ?? attachmentThumbnailUrl(metadata.id);
        const fullUrl = metadata.previewUrl ?? attachmentContentUrl(metadata.id);
        const altText = typeof alt === "string" ? alt : "";
        return (
          <button
            type="button"
            className="issue-image"
            aria-label={`${lightboxUi.enlarge[resolvedLocale]}: ${altText}`}
            onClick={(event) => {
              openLightbox(event.currentTarget, { url: fullUrl, alt: altText });
            }}
          >
            <img
              src={thumbnailUrl}
              alt={altText}
              width={metadata.thumbnailWidth}
              height={metadata.thumbnailHeight}
              loading="lazy"
              decoding="async"
            />
          </button>
        );
      }
      // Unknown/foreign/remote/data sources never render as images;
      // the escaped alt text remains as plain text.
      return <>{typeof alt === "string" ? alt : ""}</>;
    },
    [metadataById, openLightbox, resolvedLocale],
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: renderImage as NonNullable<Components["img"]>,
    }),
    [renderImage],
  );

  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkBreaks]}
        allowedElements={["p", "br", "em", "strong", "ol", "ul", "li", "a", "code", "img"]}
        skipHtml
        urlTransform={(url, key, node) => {
          // Only `attachment:` image sources pass through (for our own img
          // component to resolve); links keep the strict protocol filter.
          if (
            key === "src"
            && node.tagName === "img"
            && url.startsWith(ATTACHMENT_SCHEME)
            && ATTACHMENT_ID_PATTERN.test(url.slice(ATTACHMENT_SCHEME.length))
          ) {
            return url;
          }
          return safeIssueUrl(url);
        }}
        components={components}
      >
        {body}
      </ReactMarkdown>
      {lightbox !== null ? (
        <AttachmentLightbox image={lightbox} locale={resolvedLocale} onClose={closeLightbox} />
      ) : null}
    </>
  );
}

const editorUi = {
  hint: {
    ja: "Markdown：**太字**、*斜体*、リスト、リンクが使えます",
    en: "Markdown: **bold**, *italic*, lists, links",
  },
  empty: { ja: "本文を入力してください", en: "Enter some text." },
  tooLong: { ja: "4,000文字以内で入力してください", en: "Keep it under 4,000 characters." },
  controlCharacters: {
    ja: "使用できない制御文字が含まれています",
    en: "Remove unsupported control characters.",
  },
  brokenCharacters: {
    ja: "不正な文字が含まれています",
    en: "The text contains broken characters.",
  },
} as const;

export interface MarkdownEditorFeedbackProps {
  locale: LocaleCode;
  /** `checkIssueBody` result for the editor's normalized value. */
  check: IssueBodyCheck;
}

/**
 * Shared feedback block for every Markdown editor (issue composer, root and
 * reply editors, reply box): formatting hint, live scalar count, and the
 * reason a disabled submit cannot proceed — validation problems as
 * `role="alert"`, the empty state as a quiet note.
 */
export function MarkdownEditorFeedback({ locale, check }: MarkdownEditorFeedbackProps): ReactElement {
  return (
    <>
      <div className="markdown-editor__hint-row">
        <p className="markdown-editor__hint">{editorUi.hint[locale]}</p>
        <p className="markdown-editor__count" aria-live="polite">
          {`${check.scalars}/${ISSUE_MARKDOWN_MAX_SCALARS}`}
        </p>
      </div>
      {check.problem === "empty" ? (
        <p className="markdown-editor__note">{editorUi.empty[locale]}</p>
      ) : null}
      {check.problem === "too_long" ? (
        <p className="markdown-editor__error" role="alert">
          {editorUi.tooLong[locale]}
        </p>
      ) : null}
      {check.problem === "control_characters" ? (
        <p className="markdown-editor__error" role="alert">
          {editorUi.controlCharacters[locale]}
        </p>
      ) : null}
      {check.problem === "unpaired_surrogates" ? (
        <p className="markdown-editor__error" role="alert">
          {editorUi.brokenCharacters[locale]}
        </p>
      ) : null}
    </>
  );
}
