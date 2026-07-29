import { useState, type ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentIdsForSubmit, IssueMarkdownEditor } from "./IssueMarkdownEditor";
import type { LocaleCode } from "../imdf/types";
import type { IssueAttachmentMetadata } from "./types";

const VERSION_ID = "a".repeat(64);

interface UploadCall {
  publicVersionId: string;
  requestId: string;
  file: File;
  onProgress: (fraction: number) => void;
  resolve: (metadata: IssueAttachmentMetadata) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

function makeMetadata(id: string = crypto.randomUUID()): IssueAttachmentMetadata {
  return { id, contentType: "image/png", width: 40, height: 30, thumbnailWidth: 40, thumbnailHeight: 30 };
}

function mockUploadTransport() {
  const calls: UploadCall[] = [];
  const uploadFile = vi.fn(
    (publicVersionId: string, requestId: string, file: File, onProgress: (fraction: number) => void) => {
      let resolveFn!: (metadata: IssueAttachmentMetadata) => void;
      let rejectFn!: (error: unknown) => void;
      const promise = new Promise<IssueAttachmentMetadata>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      const call: UploadCall = {
        publicVersionId,
        requestId,
        file,
        onProgress,
        resolve: resolveFn,
        reject: rejectFn,
        abort: vi.fn(() => {
          rejectFn(new Error("aborted"));
        }),
      };
      calls.push(call);
      return { promise, abort: call.abort };
    },
  );
  return { uploadFile, calls };
}

interface HarnessProps {
  initial?: string;
  locale?: LocaleCode;
  publicVersionId?: string | null;
  uploadFile?: ReturnType<typeof mockUploadTransport>["uploadFile"];
  cancelStaged?: (id: string) => Promise<void>;
  onSubmitBlockedChange?: (blocked: boolean) => void;
  existingAttachments?: IssueAttachmentMetadata[];
  disabled?: boolean;
}

function Harness(props: HarnessProps): ReactElement {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <div>
      <IssueMarkdownEditor
        locale={props.locale ?? "en"}
        value={value}
        onChange={setValue}
        ariaLabel="Body"
        publicVersionId={props.publicVersionId === undefined ? VERSION_ID : props.publicVersionId}
        uploadFile={props.uploadFile}
        cancelStaged={props.cancelStaged}
        onSubmitBlockedChange={props.onSubmitBlockedChange}
        existingAttachments={props.existingAttachments}
        disabled={props.disabled}
      />
      <output data-testid="value">{value}</output>
    </div>
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Body") as HTMLTextAreaElement;
}

function select(start: number, end: number): void {
  const area = textarea();
  area.focus();
  area.setSelectionRange(start, end);
}

function currentValue(): string {
  return (screen.getByTestId("value") as HTMLOutputElement).value
    ?? screen.getByTestId("value").textContent
    ?? "";
}

/** Lets the editor's requestAnimationFrame selection-restore land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}

function pngFile(name = "shot.png", type = "image/png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
}

let objectUrls: string[];

beforeEach(() => {
  objectUrls = [];
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => {
      const url = `blob:mock-${objectUrls.length}`;
      objectUrls.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn(),
  }));
});

describe("IssueMarkdownEditor toolbar", () => {
  it("wraps and unwraps the selection for bold, italic, and inline code", async () => {
    const user = userEvent.setup();
    render(<Harness initial="hello world" />);
    select(6, 11);
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(currentValue()).toBe("hello **world**");
    await settle();
    select(8, 13);
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(currentValue()).toBe("hello world");
    await settle();

    select(6, 11);
    await user.click(screen.getByRole("button", { name: "Italic" }));
    expect(currentValue()).toBe("hello *world*");
    await settle();
    select(7, 12);
    await user.click(screen.getByRole("button", { name: "Inline code" }));
    expect(currentValue()).toBe("hello *`world`*");
  });

  it("inserts markers at an empty selection for keyboard-only users", async () => {
    const user = userEvent.setup();
    render(<Harness initial="" />);
    select(0, 0);
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(currentValue()).toBe("****");
    await waitFor(() => {
      expect(textarea().selectionStart).toBe(2);
    });
    expect(document.activeElement).toBe(textarea());
  });

  it("formats selected lines as bulleted or numbered lists and toggles them off", async () => {
    const user = userEvent.setup();
    render(<Harness initial={"alpha\nbeta"} />);
    select(0, 9);
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    expect(currentValue()).toBe("- alpha\n- beta");
    await settle();
    select(0, 15);
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    expect(currentValue()).toBe("alpha\nbeta");
    await settle();

    select(0, 9);
    await user.click(screen.getByRole("button", { name: "Numbered list" }));
    expect(currentValue()).toBe("1. alpha\n2. beta");
  });

  it("handles Japanese text selections without disturbing the text", async () => {
    const user = userEvent.setup();
    render(<Harness initial="こんにちは世界" />);
    select(5, 7);
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(currentValue()).toBe("こんにちは**世界**");
  });

  it("localizes toolbar names", () => {
    render(<Harness locale="ja" />);
    expect(screen.getByRole("button", { name: "太字" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "画像" })).toBeTruthy();
  });
});

describe("IssueMarkdownEditor link dialog", () => {
  it("inserts a link from selected text and a validated URL", async () => {
    const user = userEvent.setup();
    render(<Harness initial="see docs now" />);
    select(4, 8);
    await user.click(screen.getByRole("button", { name: "Link" }));
    const urlField = screen.getByLabelText("Link URL");
    await user.type(urlField, "https://example.com/docs");
    await user.click(screen.getByRole("button", { name: "Insert link" }));
    expect(currentValue()).toBe("see [docs](https://example.com/docs) now");
  });

  it("rejects unsafe URLs with an accessible error and keeps the dialog open", async () => {
    const user = userEvent.setup();
    render(<Harness initial="click" />);
    select(0, 5);
    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.type(screen.getByLabelText("Link URL"), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Insert link" }));
    expect(screen.getByRole("alert").textContent).toContain("https://");
    expect(currentValue()).toBe("click");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Link URL")).toBeNull();
  });
});

describe("IssueMarkdownEditor Write/Preview tabs", () => {
  it("renders the preview with the production renderer and returns to write", async () => {
    const user = userEvent.setup();
    render(<Harness initial={"**bold** and\n\n- one\n- two"} />);
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByTestId("issue-markdown-preview");
    expect(preview.querySelector("strong")?.textContent).toBe("bold");
    expect(preview.querySelectorAll("ul li")).toHaveLength(2);
    expect(screen.queryByLabelText("Body")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Write" }));
    expect(screen.getByLabelText("Body")).toBeTruthy();
  });

  it("marks the active tab via aria-selected", async () => {
    const user = userEvent.setup();
    render(<Harness initial="x" />);
    const write = screen.getByRole("tab", { name: "Write" });
    const preview = screen.getByRole("tab", { name: "Preview" });
    expect(write.getAttribute("aria-selected")).toBe("true");
    await user.click(preview);
    expect(preview.getAttribute("aria-selected")).toBe("true");
  });
});

describe("IssueMarkdownEditor image uploads", () => {
  it("accepts file dragover only while enabled", () => {
    const { rerender } = render(<Harness />);

    expect(fireEvent.dragOver(textarea(), { dataTransfer: { types: ["text/plain"] } })).toBe(true);
    expect(fireEvent.dragOver(textarea(), { dataTransfer: { types: ["Files"] } })).toBe(false);

    rerender(<Harness disabled />);
    expect(fireEvent.dragOver(textarea(), { dataTransfer: { types: ["Files"] } })).toBe(true);
  });

  it("disables every attachment mutation control when locked", async () => {
    const { uploadFile, calls } = mockUploadTransport();
    const { container, rerender } = render(<Harness uploadFile={uploadFile} />);
    fireEvent.paste(textarea(), {
      clipboardData: {
        files: [
          pngFile("uploading.png"),
          pngFile("failed.png"),
          pngFile("complete.png"),
          pngFile("invalid.gif", "image/gif"),
        ],
      },
    });
    calls[1]?.reject(new Error("network"));
    calls[2]?.resolve(makeMetadata());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.getByLabelText("Alt text")).toBeTruthy();
    });

    rerender(<Harness uploadFile={uploadFile} disabled />);

    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true);
    for (const remove of screen.getAllByRole("button", { name: "Remove" })) {
      expect((remove as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByLabelText("Alt text") as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
  });

  it("uploads a pasted image, replaces the placeholder with a token, and edits alt text", async () => {
    const { uploadFile, calls } = mockUploadTransport();
    const blocked: boolean[] = [];
    render(
      <Harness
        uploadFile={uploadFile}
        onSubmitBlockedChange={(value) => blocked.push(value)}
      />,
    );
    const file = pngFile();
    fireEvent.paste(textarea(), { clipboardData: { files: [file] } });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(calls[0]?.publicVersionId).toBe(VERSION_ID);
    expect(currentValue()).toContain("![Uploading…](pending:");
    expect(screen.getByText("Uploading…")).toBeTruthy();
    expect(blocked[blocked.length - 1]).toBe(true);

    calls[0]?.onProgress(0.5);
    await waitFor(() => {
      expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0.5");
    });

    const metadata = makeMetadata();
    calls[0]?.resolve(metadata);
    await waitFor(() => {
      expect(currentValue()).toContain(`![Screenshot](attachment:${metadata.id})`);
    });
    expect(currentValue()).not.toContain("pending:");
    await waitFor(() => {
      expect(blocked[blocked.length - 1]).toBe(false);
    });

    const alt = screen.getByLabelText("Alt text");
    fireEvent.change(alt, { target: { value: "West ] \\ entrance" } });
    expect(currentValue()).toContain(`![West \\] \\\\ entrance](attachment:${metadata.id})`);
    expect(attachmentIdsForSubmit(currentValue())).toEqual([metadata.id]);

    fireEvent.change(alt, { target: { value: "Gate [2]" } });
    expect(currentValue()).toContain(`![Gate \\[2\\]](attachment:${metadata.id})`);
    expect(attachmentIdsForSubmit(currentValue())).toEqual([metadata.id]);
  });

  it("keeps every placeholder when multiple files are selected", () => {
    const { uploadFile } = mockUploadTransport();
    render(<Harness uploadFile={uploadFile} />);
    fireEvent.drop(textarea(), {
      dataTransfer: { files: [pngFile("first.png"), pngFile("second.png")] },
    });

    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(currentValue().match(/pending:/g)).toHaveLength(2);
  });

  it("uploads from drag/drop and from the file picker", async () => {
    const user = userEvent.setup();
    const { uploadFile, calls } = mockUploadTransport();
    const { container } = render(<Harness uploadFile={uploadFile} />);
    fireEvent.drop(textarea(), { dataTransfer: { files: [pngFile()] } });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    calls[0]?.resolve(makeMetadata());
    await waitFor(() => {
      expect(currentValue()).toContain("](attachment:");
    });

    // Picker: the Image toolbar button targets the hidden file input.
    await user.click(screen.getByRole("button", { name: "Image" }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile("second.png")] } });
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it("keeps the same request ID across retries so a lost response cannot duplicate", async () => {
    const user = userEvent.setup();
    const { uploadFile, calls } = mockUploadTransport();
    const blocked: boolean[] = [];
    render(
      <Harness uploadFile={uploadFile} onSubmitBlockedChange={(value) => blocked.push(value)} />,
    );
    fireEvent.paste(textarea(), { clipboardData: { files: [pngFile()] } });
    calls[0]?.reject(new Error("network"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Upload failed");
    });
    expect(blocked[blocked.length - 1]).toBe(true);
    expect(currentValue()).toContain("pending:");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(calls[1]?.requestId).toBe(calls[0]?.requestId);
    const metadata = makeMetadata();
    calls[1]?.resolve(metadata);
    await waitFor(() => {
      expect(currentValue()).toContain(`attachment:${metadata.id}`);
    });
  });

  it("aborts an upload when its placeholder is deleted", async () => {
    const { uploadFile, calls } = mockUploadTransport();
    const blocked: boolean[] = [];
    render(
      <Harness uploadFile={uploadFile} onSubmitBlockedChange={(value) => blocked.push(value)} />,
    );
    fireEvent.paste(textarea(), { clipboardData: { files: [pngFile()] } });
    expect(blocked[blocked.length - 1]).toBe(true);

    fireEvent.change(textarea(), { target: { value: "" } });

    await waitFor(() => {
      expect(calls[0]?.abort).toHaveBeenCalled();
      expect(screen.queryByText("Uploading…")).toBeNull();
      expect(blocked[blocked.length - 1]).toBe(false);
    });
  });

  it("cancels an in-flight upload, removing the placeholder", async () => {
    const user = userEvent.setup();
    const { uploadFile, calls } = mockUploadTransport();
    render(<Harness uploadFile={uploadFile} />);
    fireEvent.paste(textarea(), { clipboardData: { files: [pngFile()] } });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls[0]?.abort).toHaveBeenCalled();
    await waitFor(() => {
      expect(currentValue()).not.toContain("pending:");
    });
    expect(screen.queryByText("Uploading…")).toBeNull();
  });

  it("removes a completed upload, deleting the staged attachment and its token", async () => {
    const user = userEvent.setup();
    const { uploadFile, calls } = mockUploadTransport();
    const cancelStaged = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    render(<Harness uploadFile={uploadFile} cancelStaged={cancelStaged} />);
    fireEvent.paste(textarea(), { clipboardData: { files: [pngFile()] } });
    const metadata = makeMetadata();
    calls[0]?.resolve(metadata);
    await waitFor(() => {
      expect(currentValue()).toContain(`attachment:${metadata.id}`);
    });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(cancelStaged).toHaveBeenCalledWith(metadata.id);
    expect(currentValue()).not.toContain(`attachment:${metadata.id}`);
    expect(screen.queryByLabelText("Alt text")).toBeNull();
  });

  it("rejects unsupported files with a localized card and no upload", async () => {
    const user = userEvent.setup();
    const { uploadFile } = mockUploadTransport();
    render(<Harness uploadFile={uploadFile} />);
    fireEvent.paste(textarea(), {
      clipboardData: { files: [pngFile("anim.gif", "image/gif")] },
    });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(currentValue()).not.toContain("pending:");
    expect(screen.getByRole("alert").textContent).toContain("PNG");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders staged previews in the Preview tab from local blob URLs", async () => {
    const user = userEvent.setup();
    const { uploadFile, calls } = mockUploadTransport();
    render(<Harness uploadFile={uploadFile} />);
    fireEvent.paste(textarea(), { clipboardData: { files: [pngFile()] } });
    const metadata = makeMetadata();
    calls[0]?.resolve(metadata);
    await waitFor(() => {
      expect(currentValue()).toContain(`attachment:${metadata.id}`);
    });
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByTestId("issue-markdown-preview");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("blob:mock-0");
  });

  it("renders existing attachments (edit surface) in the Preview tab", async () => {
    const user = userEvent.setup();
    const metadata = makeMetadata();
    render(
      <Harness
        initial={`before ![old](attachment:${metadata.id})`}
        existingAttachments={[metadata]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByTestId("issue-markdown-preview");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(
      `/api/issue-attachments/${metadata.id}/thumbnail`,
    );
  });

  it("hides image controls when no issue identity is available", () => {
    render(<Harness publicVersionId={null} />);
    expect(screen.queryByRole("button", { name: "Image" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bold" })).toBeTruthy();
  });
});
