import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentUploadError,
  uploadIssueAttachment,
} from "./attachmentsApi";

class SuccessfulXmlHttpRequest {
  status = 200;
  responseText = "{";
  readonly upload = {
    addEventListener: () => {},
  };
  private readonly listeners = new Map<string, () => void>();

  open(): void {}

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }

  send(): void {
    this.listeners.get("load")?.();
  }

  abort(): void {
    this.listeners.get("abort")?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadIssueAttachment", () => {
  it("rejects malformed JSON in a successful response", async () => {
    vi.stubGlobal("XMLHttpRequest", SuccessfulXmlHttpRequest);

    const upload = uploadIssueAttachment(
      "a".repeat(64),
      "11111111-2222-4333-8444-555555555555",
      new File(["image"], "image.png", { type: "image/png" }),
      () => {},
    );

    await expect(upload.promise).rejects.toEqual(
      new AttachmentUploadError(200, "The upload returned an invalid response."),
    );
  });
});
