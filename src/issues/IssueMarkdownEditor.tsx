import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactElement,
  type Ref,
} from "react";
import type { LocaleCode } from "../imdf/types";
import { parseAttachmentTokenIds } from "./attachmentTokens";
import {
  deleteStagedAttachment,
  uploadIssueAttachment,
  type AttachmentUpload,
} from "./attachmentsApi";
import {
  checkIssueBody,
  MarkdownBody,
  MarkdownEditorFeedback,
  normalizeIssueMarkdown,
  safeIssueUrl,
} from "./MarkdownBody";
import type { IssueAttachmentMetadata } from "./types";

/**
 * Shared native-textarea Markdown editor for every issue body surface (root
 * create/edit, reply create/edit). Markdown stays canonical: the toolbar
 * only manipulates the textarea selection, and Write/Preview tabs render the
 * exact production `MarkdownBody`. First-party images upload staged and
 * appear in the body as stable `attachment:<id>` tokens.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const PENDING_SCHEME = "pending:";

function escapeAttachmentAlt(alt: string): string {
  return alt.replace(/[\\[\]]/g, "\\$&");
}

function attachmentTokenPattern(id: string): RegExp {
  return new RegExp(`!\\[(?:\\\\.|[^\\\\\\]])*\\]\\(attachment:${id}\\)`);
}

const ui = {
  write: { ja: "書く", en: "Write" },
  preview: { ja: "プレビュー", en: "Preview" },
  toolbar: { ja: "書式", en: "Formatting" },
  bold: { ja: "太字", en: "Bold" },
  italic: { ja: "斜体", en: "Italic" },
  inlineCode: { ja: "インラインコード", en: "Inline code" },
  bulletList: { ja: "箇条書き", en: "Bulleted list" },
  numberedList: { ja: "番号付きリスト", en: "Numbered list" },
  link: { ja: "リンク", en: "Link" },
  image: { ja: "画像", en: "Image" },
  linkText: { ja: "リンクのテキスト", en: "Link text" },
  linkUrl: { ja: "リンク先 URL", en: "Link URL" },
  linkInsert: { ja: "リンクを挿入", en: "Insert link" },
  linkInvalid: {
    ja: "https:// または mailto: の URL を入力してください",
    en: "Enter an https:// or mailto: URL.",
  },
  cancel: { ja: "キャンセル", en: "Cancel" },
  uploading: { ja: "アップロード中…", en: "Uploading…" },
  uploadFailed: { ja: "アップロードに失敗しました", en: "Upload failed" },
  uploadInvalid: {
    ja: "PNG・JPEG・WebP（10MBまで）のみ添付できます",
    en: "Only PNG, JPEG, or WebP up to 10 MB",
  },
  retry: { ja: "再試行", en: "Retry" },
  remove: { ja: "削除", en: "Remove" },
  altLabel: { ja: "代替テキスト", en: "Alt text" },
  defaultAlt: { ja: "スクリーンショット", en: "Screenshot" },
  publicWarning: {
    ja: "画像は課題と同じく公開されます。秘密情報を写さないでください。",
    en: "Images are as public as the issue itself. Do not include secrets.",
  },
  dismiss: { ja: "閉じる", en: "Dismiss" },
} as const;

interface EditorUpload {
  /** Also the upload idempotency request ID (a UUID v4). */
  localId: string;
  /** Exact placeholder text inserted into the body while uploading. */
  placeholder: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "success" | "error" | "invalid";
  progress: number;
  metadata: IssueAttachmentMetadata | null;
  transport: AttachmentUpload | null;
}

export interface IssueMarkdownEditorProps {
  locale: LocaleCode;
  value: string;
  onChange: (value: string) => void;
  /** Disables the textarea and toolbar while a mutation is in flight. */
  disabled?: boolean | undefined;
  ariaLabel: string;
  placeholder?: string | undefined;
  rows?: number | undefined;
  /** Textarea class, preserving each host surface's existing styling. */
  textareaClassName?: string | undefined;
  /** Null when issues are unavailable (embed/local viewers): image controls hide. */
  publicVersionId: string | null;
  /** Canonical attachment metadata (edit surfaces) for preview rendering. */
  existingAttachments?: IssueAttachmentMetadata[] | undefined;
  /** Reports whether incomplete uploads must block Post/Save. */
  onSubmitBlockedChange?: ((blocked: boolean) => void) | undefined;
  textareaRef?: Ref<HTMLTextAreaElement> | undefined;
  /** Test seams for the upload transport. */
  uploadFile?: typeof uploadIssueAttachment | undefined;
  cancelStaged?: typeof deleteStagedAttachment | undefined;
}

interface SelectionRange {
  start: number;
  end: number;
}

/** Reads the textarea selection, falling back to the end of the text. */
function selectionOf(textarea: HTMLTextAreaElement, value: string): SelectionRange {
  const start = textarea.selectionStart ?? value.length;
  const end = textarea.selectionEnd ?? value.length;
  return { start, end };
}

/** Applies inline wrap/toggle formatting around the current selection. */
function wrapSelection(
  value: string,
  range: SelectionRange,
  marker: string,
): { value: string; range: SelectionRange } {
  const before = value.slice(0, range.start);
  const selected = value.slice(range.start, range.end);
  const after = value.slice(range.end);
  if (
    before.endsWith(marker)
    && after.startsWith(marker)
    && selected.length > 0
  ) {
    return {
      value: before.slice(0, -marker.length) + selected + after.slice(marker.length),
      range: { start: range.start - marker.length, end: range.end - marker.length },
    };
  }
  return {
    value: `${before}${marker}${selected}${marker}${after}`,
    range:
      selected.length === 0
        ? { start: range.start + marker.length, end: range.end + marker.length }
        : { start: range.start, end: range.end + marker.length * 2 },
  };
}

/** Applies per-line list prefixes to the selected lines (toggle). */
function prefixLines(
  value: string,
  range: SelectionRange,
  kind: "bullet" | "numbered",
): { value: string; range: SelectionRange } {
  const lineStart = value.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
  let lineEnd = value.indexOf("\n", range.end);
  if (lineEnd === -1) {
    lineEnd = value.length;
  }
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const bulletPattern = /^- /;
  const numberedPattern = /^\d+\. /;
  const active = lines.every((line) =>
    kind === "bullet" ? bulletPattern.test(line) || line.trim() === "" : numberedPattern.test(line) || line.trim() === "",
  );
  const next = lines
    .map((line, index) => {
      if (line.trim() === "") {
        return line;
      }
      if (active) {
        return line.replace(kind === "bullet" ? bulletPattern : numberedPattern, "");
      }
      return kind === "bullet" ? `- ${line}` : `${index + 1}. ${line}`;
    })
    .join("\n");
  const nextValue = value.slice(0, lineStart) + next + value.slice(lineEnd);
  return {
    value: nextValue,
    range: { start: lineStart, end: lineStart + next.length },
  };
}

export function IssueMarkdownEditor({
  locale,
  value,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder,
  rows = 4,
  textareaClassName,
  publicVersionId,
  existingAttachments,
  onSubmitBlockedChange,
  textareaRef,
  uploadFile = uploadIssueAttachment,
  cancelStaged = deleteStagedAttachment,
}: IssueMarkdownEditorProps): ReactElement {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [uploads, setUploads] = useState<EditorUpload[]>([]);
  const [linkDialog, setLinkDialog] = useState<{ text: string; url: string } | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const linkSelectionRef = useRef<SelectionRange>({ start: 0, end: 0 });
  const uploadsRef = useRef<EditorUpload[]>([]);
  uploadsRef.current = uploads;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setTextareaRef = (element: HTMLTextAreaElement | null) => {
    internalRef.current = element;
    if (typeof textareaRef === "function") {
      textareaRef(element);
    } else if (textareaRef !== undefined && textareaRef !== null) {
      (textareaRef as { current: HTMLTextAreaElement | null }).current = element;
    }
  };

  // Teardown (dataset switch, composer close): abort in-flight uploads and
  // release local preview URLs.
  useEffect(() => {
    return () => {
      for (const upload of uploadsRef.current) {
        upload.transport?.abort();
        URL.revokeObjectURL(upload.previewUrl);
      }
    };
  }, []);

  const normalized = normalizeIssueMarkdown(value);
  const check = checkIssueBody(normalized);

  // Submit is blocked while an upload is in flight or a failed upload's
  // placeholder still sits in the body. Failed/invalid cards whose
  // placeholder text the author deleted are dropped explicitly.
  const blocked = uploads.some(
    (upload) =>
      upload.status === "uploading"
      || (upload.status === "error" && value.includes(upload.placeholder)),
  );
  useEffect(() => {
    const removedIds = new Set(
      uploads
        .filter(
          (upload) =>
            upload.status === "uploading"
            && upload.placeholder !== ""
            && !value.includes(upload.placeholder),
        )
        .map((upload) => upload.localId),
    );
    if (removedIds.size === 0) {
      return;
    }
    for (const upload of uploads) {
      if (removedIds.has(upload.localId)) {
        upload.transport?.abort();
        URL.revokeObjectURL(upload.previewUrl);
      }
    }
    setUploads((current) => current.filter((upload) => !removedIds.has(upload.localId)));
  }, [uploads, value]);
  const lastBlockedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (onSubmitBlockedChange !== undefined && lastBlockedRef.current !== blocked) {
      lastBlockedRef.current = blocked;
      onSubmitBlockedChange(blocked);
    }
  }, [blocked, onSubmitBlockedChange]);

  const updateUpload = (localId: string, patch: Partial<EditorUpload>) => {
    setUploads((current) =>
      current.map((upload) => (upload.localId === localId ? { ...upload, ...patch } : upload)),
    );
  };

  const removeUpload = (localId: string) => {
    setUploads((current) => {
      const target = current.find((upload) => upload.localId === localId);
      if (target !== undefined) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((upload) => upload.localId !== localId);
    });
  };

  const replaceText = (search: string, replacement: string): boolean => {
    const current = valueRef.current;
    const index = current.indexOf(search);
    if (index === -1) {
      return false;
    }
    onChangeRef.current(
      current.slice(0, index) + replacement + current.slice(index + search.length),
    );
    return true;
  };

  const finishUpload = (upload: EditorUpload, metadata: IssueAttachmentMetadata) => {
    const token = `![${ui.defaultAlt[locale]}](attachment:${metadata.id})`;
    // If the author deleted the placeholder mid-flight, discard the staged
    // upload instead of inserting an unreferenced token.
    if (!valueRef.current.includes(upload.placeholder)) {
      void cancelStaged(metadata.id).catch(() => undefined);
      removeUpload(upload.localId);
      return;
    }
    updateUpload(upload.localId, { status: "success", metadata, progress: 1, transport: null });
    replaceText(upload.placeholder, token);
  };

  const startUpload = (upload: EditorUpload) => {
    const transport = uploadFile(publicVersionId ?? "", upload.localId, upload.file, (fraction) => {
      updateUpload(upload.localId, { progress: fraction });
    });
    updateUpload(upload.localId, { transport, status: "uploading", progress: 0 });
    transport.promise.then(
      (metadata) => {
        finishUpload({ ...upload, transport }, metadata);
      },
      () => {
        const latest = uploadsRef.current.find((entry) => entry.localId === upload.localId);
        if (latest !== undefined && latest.status === "uploading") {
          updateUpload(upload.localId, { status: "error", transport: null });
        }
      },
    );
  };

  const addFiles = (files: Iterable<File>) => {
    if (publicVersionId === null) {
      return;
    }
    const textarea = internalRef.current;
    const fresh: EditorUpload[] = [];
    let nextValue = valueRef.current;
    let cursor: SelectionRange | null = null;
    for (const file of files) {
      const localId = crypto.randomUUID();
      if (!ACCEPTED_TYPES.has(file.type) || file.size > MAX_FILE_BYTES || file.size === 0) {
        fresh.push({
          localId,
          placeholder: "",
          file,
          previewUrl: "",
          status: "invalid",
          progress: 0,
          metadata: null,
          transport: null,
        });
        continue;
      }
      const placeholderText = `![${ui.uploading[locale]}](${PENDING_SCHEME}${localId})`;
      if (cursor === null && textarea !== null) {
        cursor = selectionOf(textarea, nextValue);
      }
      const insertAt: SelectionRange = cursor ?? { start: nextValue.length, end: nextValue.length };
      nextValue =
        nextValue.slice(0, insertAt.start) + placeholderText + nextValue.slice(insertAt.end);
      cursor = { start: insertAt.start + placeholderText.length, end: insertAt.start + placeholderText.length };
      fresh.push({
        localId,
        placeholder: placeholderText,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
        progress: 0,
        metadata: null,
        transport: null,
      });
    }
    if (fresh.length === 0) {
      return;
    }
    if (nextValue !== valueRef.current) {
      valueRef.current = nextValue;
      onChangeRef.current(nextValue);
    }
    setUploads((current) => [...current, ...fresh]);
    for (const upload of fresh) {
      if (upload.status === "uploading") {
        startUpload(upload);
      }
    }
    textarea?.focus();
  };

  const retryUpload = (upload: EditorUpload) => {
    // The same request ID + identical bytes replays idempotently server-side,
    // so a retry after a lost response cannot duplicate the attachment.
    startUpload(upload);
  };

  const cancelUpload = (upload: EditorUpload) => {
    upload.transport?.abort();
    if (upload.metadata !== null) {
      void cancelStaged(upload.metadata.id).catch(() => undefined);
      const tokenPattern = attachmentTokenPattern(upload.metadata.id);
      const current = valueRef.current;
      const match = tokenPattern.exec(current);
      if (match !== null) {
        onChangeRef.current(current.slice(0, match.index) + current.slice(match.index + match[0].length));
      }
    } else if (upload.placeholder !== "") {
      replaceText(upload.placeholder, "");
    }
    removeUpload(upload.localId);
  };

  const applyAlt = (upload: EditorUpload, alt: string) => {
    if (upload.metadata === null) {
      return;
    }
    const tokenPattern = attachmentTokenPattern(upload.metadata.id);
    const current = valueRef.current;
    const match = tokenPattern.exec(current);
    if (match !== null) {
      const token = `![${escapeAttachmentAlt(alt)}](attachment:${upload.metadata.id})`;
      onChangeRef.current(
        current.slice(0, match.index) + token + current.slice(match.index + match[0].length),
      );
    }
  };

  const applyFormat = (format: (value: string, range: SelectionRange) => { value: string; range: SelectionRange }) => {
    const textarea = internalRef.current;
    if (textarea === null) {
      return;
    }
    const result = format(valueRef.current, selectionOf(textarea, valueRef.current));
    onChangeRef.current(result.value);
    // Restore focus and the mapped selection after React commits the value.
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.range.start, result.range.end);
    });
  };

  const openLinkDialog = () => {
    const textarea = internalRef.current;
    if (textarea === null) {
      return;
    }
    const range = selectionOf(textarea, valueRef.current);
    linkSelectionRef.current = range;
    const selected = valueRef.current.slice(range.start, range.end);
    setLinkInvalid(false);
    setLinkDialog(
      safeIssueUrl(selected) !== undefined ? { text: "", url: selected } : { text: selected, url: "" },
    );
  };

  const insertLink = () => {
    if (linkDialog === null) {
      return;
    }
    const url = linkDialog.url.trim();
    if (safeIssueUrl(url) === undefined) {
      setLinkInvalid(true);
      return;
    }
    const text = linkDialog.text.trim() === "" ? url : linkDialog.text;
    const range = linkSelectionRef.current;
    const current = valueRef.current;
    const inserted = `[${text}](${url})`;
    onChangeRef.current(current.slice(0, range.start) + inserted + current.slice(range.end));
    setLinkDialog(null);
    const textarea = internalRef.current;
    requestAnimationFrame(() => {
      if (textarea !== null) {
        textarea.focus();
        const end = range.start + inserted.length;
        textarea.setSelectionRange(end, end);
      }
    });
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };

  const onDragOver = (event: ReactDragEvent<HTMLTextAreaElement>) => {
    if (!disabled && Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault();
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLTextAreaElement>) => {
    if (disabled) {
      return;
    }
    const files = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };

  // Preview merges canonical metadata with staged previews (blob URLs — the
  // server never serves staged media).
  const previewAttachments = useMemo(() => {
    const staged = uploads
      .filter((upload) => upload.status === "success" && upload.metadata !== null)
      .map((upload) => ({ ...(upload.metadata as IssueAttachmentMetadata), previewUrl: upload.previewUrl }));
    return [...(existingAttachments ?? []), ...staged];
  }, [existingAttachments, uploads]);

  // Cards for referenced/known uploads only; a card whose placeholder the
  // author deleted is dropped (the deletion was the explicit dismiss).
  const visibleUploads = uploads.filter((upload) => {
    if (upload.status === "invalid") {
      return true;
    }
    if (upload.status === "success") {
      return true;
    }
    return value.includes(upload.placeholder);
  });

  const imageControlsAvailable = publicVersionId !== null;

  const toolbarButton = (
    label: string,
    onPress: () => void,
    text: string,
  ): ReactElement => (
    <button
      key={label}
      type="button"
      className="issue-markdown-editor__tool"
      aria-label={label}
      title={label}
      disabled={disabled}
      // Keep textarea focus/selection (and any IME composition) intact.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onPress}
    >
      <span aria-hidden="true">{text}</span>
    </button>
  );

  return (
    <div className="issue-markdown-editor">
      <div className="issue-markdown-editor__bar">
        <div className="issue-markdown-editor__tabs" role="tablist">
          {(["write", "preview"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mode === tab}
              className={
                mode === tab
                  ? "issue-markdown-editor__tab issue-markdown-editor__tab--active"
                  : "issue-markdown-editor__tab"
              }
              onClick={() => {
                setMode(tab);
              }}
            >
              {ui[tab][locale]}
            </button>
          ))}
        </div>
        <div className="issue-markdown-editor__toolbar" role="toolbar" aria-label={ui.toolbar[locale]}>
          {toolbarButton(ui.bold[locale], () => {
            applyFormat((text, range) => wrapSelection(text, range, "**"));
          }, "**")}
          {toolbarButton(ui.italic[locale], () => {
            applyFormat((text, range) => wrapSelection(text, range, "*"));
          }, "*")}
          {toolbarButton(ui.inlineCode[locale], () => {
            applyFormat((text, range) => wrapSelection(text, range, "`"));
          }, "`")}
          {toolbarButton(ui.bulletList[locale], () => {
            applyFormat((text, range) => prefixLines(text, range, "bullet"));
          }, "•")}
          {toolbarButton(ui.numberedList[locale], () => {
            applyFormat((text, range) => prefixLines(text, range, "numbered"));
          }, "1.")}
          {toolbarButton(ui.link[locale], openLinkDialog, "🔗")}
          {imageControlsAvailable
            ? toolbarButton(ui.image[locale], () => {
                fileInputRef.current?.click();
              }, "🖼")
            : null}
        </div>
      </div>

      {linkDialog !== null ? (
        <div className="issue-markdown-editor__link-dialog" role="group" aria-label={ui.link[locale]}>
          <label>
            <span>{ui.linkText[locale]}</span>
            <input
              type="text"
              value={linkDialog.text}
              disabled={disabled}
              onChange={(event) => {
                setLinkDialog({ ...linkDialog, text: event.target.value });
              }}
            />
          </label>
          <label>
            <span>{ui.linkUrl[locale]}</span>
            <input
              type="text"
              inputMode="url"
              value={linkDialog.url}
              aria-invalid={linkInvalid}
              disabled={disabled}
              onChange={(event) => {
                setLinkDialog({ ...linkDialog, url: event.target.value });
                setLinkInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  insertLink();
                }
              }}
            />
          </label>
          {linkInvalid ? (
            <p className="issue-markdown-editor__error" role="alert">
              {ui.linkInvalid[locale]}
            </p>
          ) : null}
          <div className="issue-markdown-editor__link-actions">
            <button
              type="button"
              className="btn-ghost"
              disabled={disabled}
              onClick={() => {
                setLinkDialog(null);
                internalRef.current?.focus();
              }}
            >
              {ui.cancel[locale]}
            </button>
            <button type="button" className="btn-primary" disabled={disabled} onClick={insertLink}>
              {ui.linkInsert[locale]}
            </button>
          </div>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      {mode === "write" ? (
        <textarea
          ref={setTextareaRef}
          className={textareaClassName}
          aria-label={ariaLabel}
          placeholder={placeholder}
          rows={rows}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDrop={onDrop}
        />
      ) : (
        <div className="issue-markdown-editor__preview" data-testid="issue-markdown-preview">
          {check.problem === "empty" ? (
            <p className="markdown-editor__note">{ui.write[locale]}</p>
          ) : (
            <MarkdownBody body={normalized} attachments={previewAttachments} locale={locale} />
          )}
        </div>
      )}

      {visibleUploads.length > 0 ? (
        <>
          <ul className="issue-markdown-editor__uploads">
            {visibleUploads.map((upload) => (
              <li key={upload.localId} className="issue-markdown-editor__upload">
                {upload.status === "invalid" ? (
                  <>
                    <span className="issue-markdown-editor__upload-error" role="alert">
                      {ui.uploadInvalid[locale]}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={disabled}
                      onClick={() => {
                        removeUpload(upload.localId);
                      }}
                    >
                      {ui.dismiss[locale]}
                    </button>
                  </>
                ) : upload.status === "uploading" ? (
                  <>
                    <img
                      className="issue-markdown-editor__thumb"
                      src={upload.previewUrl}
                      alt=""
                      width={48}
                      height={48}
                    />
                    <progress
                      className="issue-markdown-editor__progress"
                      value={upload.progress}
                      max={1}
                      aria-label={ui.uploading[locale]}
                    />
                    <span className="issue-markdown-editor__upload-status">{ui.uploading[locale]}</span>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={disabled}
                      onClick={() => {
                        cancelUpload(upload);
                      }}
                    >
                      {ui.cancel[locale]}
                    </button>
                  </>
                ) : upload.status === "error" ? (
                  <>
                    <span className="issue-markdown-editor__upload-error" role="alert">
                      {ui.uploadFailed[locale]}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={disabled}
                      onClick={() => {
                        retryUpload(upload);
                      }}
                    >
                      {ui.retry[locale]}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={disabled}
                      onClick={() => {
                        cancelUpload(upload);
                      }}
                    >
                      {ui.remove[locale]}
                    </button>
                  </>
                ) : (
                  <>
                    <img
                      className="issue-markdown-editor__thumb"
                      src={upload.previewUrl}
                      alt=""
                      width={48}
                      height={48}
                    />
                    <label className="issue-markdown-editor__alt">
                      <span>{ui.altLabel[locale]}</span>
                      <input
                        type="text"
                        defaultValue={ui.defaultAlt[locale]}
                        aria-label={ui.altLabel[locale]}
                        disabled={disabled}
                        onChange={(event) => {
                          applyAlt(upload, event.target.value);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={disabled}
                      onClick={() => {
                        cancelUpload(upload);
                      }}
                    >
                      {ui.remove[locale]}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="issue-markdown-editor__warning">{ui.publicWarning[locale]}</p>
        </>
      ) : null}

      <MarkdownEditorFeedback locale={locale} check={check} />
    </div>
  );
}

/** Token IDs the editor's host submits with a body (matches server parsing). */
export function attachmentIdsForSubmit(normalizedBody: string): string[] {
  return parseAttachmentTokenIds(normalizedBody);
}
