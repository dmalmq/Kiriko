import type { IssueAttachmentMetadata } from "./types";

/**
 * First-party attachment upload transport. XHR (not fetch) because fetch
 * cannot report upload progress — the same project-native pattern as the
 * venue/GDB uploads in `src/gallery/api.ts`.
 */

export interface AttachmentUpload {
  promise: Promise<IssueAttachmentMetadata>;
  /** Aborts the in-flight request (explicit cancel or teardown only). */
  abort(): void;
}

export class AttachmentUploadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AttachmentUploadError";
    this.status = status;
  }
}

/**
 * POSTs one image file with its idempotency request ID. Retrying with the
 * same request ID and identical content returns the same attachment (the
 * server is idempotent), so response-loss retries are safe.
 */
export function uploadIssueAttachment(
  publicVersionId: string,
  requestId: string,
  file: File,
  onProgress: (fraction: number) => void,
): AttachmentUpload {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<IssueAttachmentMetadata>((resolve, reject) => {
    xhr.open(
      "POST",
      `/api/review/versions/${encodeURIComponent(publicVersionId)}/issue-attachments`,
    );
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 200) {
        resolve(JSON.parse(xhr.responseText) as IssueAttachmentMetadata);
      } else {
        let message = "The upload failed.";
        try {
          const body = JSON.parse(xhr.responseText) as { message?: unknown };
          if (typeof body.message === "string") {
            message = body.message;
          }
        } catch {
          // Non-JSON error body; keep the generic message.
        }
        reject(new AttachmentUploadError(xhr.status, message));
      }
    });
    xhr.addEventListener("error", () => {
      reject(new AttachmentUploadError(0, "network error"));
    });
    xhr.addEventListener("abort", () => {
      reject(new AttachmentUploadError(0, "aborted"));
    });
    const form = new FormData();
    form.append("requestId", requestId);
    form.append("file", file);
    xhr.send(form);
  });
  return {
    promise,
    abort: () => {
      xhr.abort();
    },
  };
}

/** Explicit cancel of a staged upload (DELETE is staged-only server-side). */
export async function deleteStagedAttachment(attachmentId: string): Promise<void> {
  await fetch(`/api/issue-attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
}
