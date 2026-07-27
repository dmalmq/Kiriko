import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const createVenue = vi.fn();
const uploadVersion = vi.fn();
const waitForJob = vi.fn();
const deleteVenue = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      createVenue: (...a: unknown[]) => createVenue(...a),
      uploadVersion: (...a: unknown[]) => uploadVersion(...a),
      waitForJob: (...a: unknown[]) => waitForJob(...a),
      deleteVenue: (...a: unknown[]) => deleteVenue(...a),
    },
  };
});

import { UploadModal } from "./UploadModal";

afterEach(() => {
  vi.clearAllMocks();
});

function zipFile(name = "shinjuku-station.zip"): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, { type: "application/zip" });
}

describe("UploadModal", () => {
  it("prefills the name from the file, uploads, and reaches the done state", async () => {
    createVenue.mockResolvedValue({ id: 7, slug: "shinjuku-station", name: "shinjuku-station" });
    uploadVersion.mockResolvedValue({ jobId: "j1" });
    waitForJob.mockResolvedValue({ status: "done" });
    const onPublished = vi.fn();
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={onPublished} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile());
    expect((screen.getByLabelText("Dataset name") as HTMLInputElement).value).toBe(
      "shinjuku-station",
    );

    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => {
      expect(screen.getByText("Published")).toBeTruthy();
    });
    expect(createVenue).toHaveBeenCalledWith("shinjuku-station");
    expect(uploadVersion).toHaveBeenCalled();
    expect(onPublished).toHaveBeenCalled();
    const open = screen.getByRole("link", { name: "Open" });
    expect(open.getAttribute("href")).toBe("/?dataset=shinjuku-station");
  });

  it("checks the same accepted create upload job after timeout without creating another venue", async () => {
    createVenue.mockResolvedValue({ id: 7, slug: "shinjuku-station", name: "shinjuku-station" });
    uploadVersion.mockResolvedValue({ jobId: "upload-timeout" });
    waitForJob.mockResolvedValueOnce({ status: "timeout" }).mockResolvedValueOnce({ status: "done" });
    const onPublished = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={onClose} onPublished={onPublished} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile());
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("upload-timeout"));
    expect(screen.getByText(/still running/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /open local data/i })).toBeTruthy();
    expect(createVenue).toHaveBeenCalledTimes(1);
    expect(uploadVersion).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(screen.getByText("Published")).toBeTruthy());
    expect(waitForJob).toHaveBeenCalledTimes(2);
    expect(waitForJob).toHaveBeenLastCalledWith("upload-timeout");
    expect(createVenue).toHaveBeenCalledTimes(1);
    expect(uploadVersion).toHaveBeenCalledTimes(1);
    expect(deleteVenue).not.toHaveBeenCalled();
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed publish job and re-enables the form", async () => {
    createVenue.mockResolvedValue({ id: 8, slug: "bad", name: "bad" });
    uploadVersion.mockResolvedValue({ jobId: "j2" });
    waitForJob.mockResolvedValue({ status: "error", error: "not a ZIP archive" });
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={() => {}} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("bad.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText(/not a ZIP archive/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  });
  it("renders corrective copy instead of raw structured JSON for a failed publish job", async () => {
    createVenue.mockResolvedValue({ id: 10, slug: "bad-imdf", name: "bad-imdf" });
    uploadVersion.mockResolvedValue({ jobId: "j3" });
    waitForJob.mockResolvedValue({
      status: "error",
      error: JSON.stringify({
        code: "missing_required_file",
        message: "importer: manifest.json is missing from the archive root",
        details: { entry: "manifest.json" },
      }),
    });
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={() => {}} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("bad-imdf.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("missing a required IMDF file");
    expect(alert.textContent).not.toContain("{");
    expect(alert.textContent).not.toContain("manifest.json");
    expect(alert.textContent).not.toContain("missing_required_file");
  });

  it("hides internal structured error messages behind generic corrective copy", async () => {
    createVenue.mockResolvedValue({ id: 11, slug: "crash", name: "crash" });
    uploadVersion.mockResolvedValue({ jobId: "j4" });
    waitForJob.mockResolvedValue({
      status: "error",
      error: JSON.stringify({
        code: "internal_error",
        message: "SQLITE_BUSY: database is locked at /var/lib/kiriko/data.db",
      }),
    });
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={() => {}} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("crash.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("SQLITE_BUSY");
    expect(alert.textContent).not.toContain("{");
    expect(alert.textContent?.length).toBeGreaterThan(0);
  });

  it("never renders malformed JSON job errors verbatim", async () => {
    createVenue.mockResolvedValue({ id: 12, slug: "weird", name: "weird" });
    uploadVersion.mockResolvedValue({ jobId: "j5" });
    waitForJob.mockResolvedValue({
      status: "error",
      error: '{"unexpected":true,"stack":["a","b"]}',
    });
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={() => {}} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("weird.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("{");
    expect(alert.textContent).not.toContain("unexpected");
    expect(alert.textContent?.length).toBeGreaterThan(0);
  });

  it("disables the header close button while uploading", async () => {
    createVenue.mockResolvedValue({ id: 9, slug: "slow", name: "slow" });
    uploadVersion.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={() => {}} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("slow.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  it("deletes the orphan venue when create succeeds but upload fails", async () => {
    createVenue.mockResolvedValue({ id: 99, slug: "orphan", name: "orphan", createdAt: "" });
    uploadVersion.mockRejectedValue(new Error("network error"));
    deleteVenue.mockResolvedValue(undefined);
    const onPublished = vi.fn();
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={onPublished} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("orphan.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(deleteVenue).toHaveBeenCalledWith(99));
    expect(onPublished).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("deletes the orphan venue when the publish job fails", async () => {
    createVenue.mockResolvedValue({ id: 100, slug: "job-fail", name: "job-fail", createdAt: "" });
    uploadVersion.mockResolvedValue({ jobId: "j-fail" });
    waitForJob.mockResolvedValue({ status: "error", error: "not a ZIP archive" });
    deleteVenue.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<UploadModal locale="en" onClose={() => {}} onPublished={() => {}} />);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("job-fail.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(deleteVenue).toHaveBeenCalledWith(100));
    expect(await screen.findByText(/not a ZIP archive/)).toBeTruthy();
  });

  it("uploads a new version to an existing venue without createVenue", async () => {
    uploadVersion.mockResolvedValue({ jobId: "jv1" });
    waitForJob.mockResolvedValue({ status: "done" });
    const onPublished = vi.fn();
    const user = userEvent.setup();
    render(
      <UploadModal
        locale="en"
        onClose={() => {}}
        onPublished={onPublished}
        target={{ venueId: 42, venueName: "Existing Station", slug: "existing-station" }}
      />,
    );

    expect(screen.getByRole("dialog", { name: /upload imdf version/i })).toBeTruthy();
    const nameInput = screen.getByLabelText("Dataset name") as HTMLInputElement;
    expect(nameInput.value).toBe("Existing Station");
    expect(nameInput.readOnly || nameInput.disabled).toBe(true);

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("v2.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(screen.getByText("Published")).toBeTruthy());
    expect(createVenue).not.toHaveBeenCalled();
    expect(uploadVersion).toHaveBeenCalled();
    const uploadArgs = uploadVersion.mock.calls[0]!;
    expect(uploadArgs[0]).toBe(42);
    expect(deleteVenue).not.toHaveBeenCalled();
    expect(onPublished).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      "/?dataset=existing-station",
    );
  });

  it("checks the same accepted version upload job after timeout without uploading again", async () => {
    uploadVersion.mockResolvedValue({ jobId: "version-timeout" });
    waitForJob.mockResolvedValueOnce({ status: "timeout" }).mockResolvedValueOnce({ status: "done" });
    const onPublished = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <UploadModal
        locale="en"
        onClose={onClose}
        onPublished={onPublished}
        target={{ venueId: 42, venueName: "Existing Station", slug: "existing-station" }}
      />,
    );

    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("v2-timeout.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(waitForJob).toHaveBeenCalledWith("version-timeout"));
    expect(screen.getByText(/still running/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /upload imdf version/i })).toBeTruthy();
    expect(uploadVersion).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(screen.getByText("Published")).toBeTruthy());
    expect(waitForJob).toHaveBeenCalledTimes(2);
    expect(waitForJob).toHaveBeenLastCalledWith("version-timeout");
    expect(createVenue).not.toHaveBeenCalled();
    expect(uploadVersion).toHaveBeenCalledTimes(1);
    expect(deleteVenue).not.toHaveBeenCalled();
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it("does not delete an existing venue when version upload fails", async () => {
    uploadVersion.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(
      <UploadModal
        locale="en"
        onClose={() => {}}
        onPublished={() => {}}
        target={{ venueId: 42, venueName: "Existing Station", slug: "existing-station" }}
      />,
    );
    await user.upload(screen.getByLabelText("IMDF ZIP"), zipFile("bad.zip"));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(createVenue).not.toHaveBeenCalled();
    expect(deleteVenue).not.toHaveBeenCalled();
  });
});
