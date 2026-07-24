import type { GdbInspection, GdbInspectResponse, GdbMappingPlan, NetworkInspectResponse, FacilitiesInspectResponse } from "../gdb/types";
import type { LocaleCode } from "../imdf/types";

export type ApiUserRole = "viewer" | "member" | "admin";

export interface ApiUser {
  id: number;
  username: string;
  role: ApiUserRole;
}

export interface VenueRow {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
}

export interface VenueSummary extends VenueRow {
  latest: {
    seq: number;
    publicVersionId: string;
    status: string;
    stats: { levels: number; features: number } | null;
    createdAt: string;
  } | null;
  editableMapping?: boolean;
  hasNetwork?: boolean;
  hasGraph?: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
/** Permanent public version identity: a lowercase 64-hex string. */
const PUBLIC_VERSION_ID = /^[0-9a-f]{64}$/;

export function datasetBundleUrl(slug: string, publicVersionId?: string): string {
  const base = `/v/default/${slug}/bundle`;
  return publicVersionId !== undefined && PUBLIC_VERSION_ID.test(publicVersionId)
    ? `${base}@${publicVersionId}`
    : base;
}

/**
 * Canonical viewer deep-link for a published venue. Pins to `?version=<publicVersionId>`
 * (the permanent 64-hex identity, never the reusable seq) when it is valid,
 * always tags the current locale, and appends `review=1` for network review.
 */
export function viewerHref(
  slug: string,
  publicVersionId: string | null | undefined,
  locale: LocaleCode,
  review = false,
): string {
  const query = new URLSearchParams({ dataset: slug, lang: locale });
  if (publicVersionId != null && PUBLIC_VERSION_ID.test(publicVersionId)) {
    query.set("version", publicVersionId);
  }
  if (review) {
    query.set("review", "1");
  }
  return `/?${query.toString()}`;
}
/**
 * Corrective copy for the stable structured error codes a failed publish job
 * persists as `{"code","message","details"?}` JSON (kiriko-model importer
 * codes plus publish-runner codes). Server messages and details are internal
 * and never shown to the user.
 */
const publishErrorCopy: Record<string, string | undefined> = {
  unsupported_file: "This file is not a valid IMDF ZIP archive.",
  archive_too_large:
    "This archive exceeds the 100 MiB compressed or 300 MiB uncompressed limit.",
  unsafe_archive_path: "This archive contains an unsafe file path and was rejected.",
  invalid_archive: "This ZIP is encrypted, damaged, or has conflicting archive records.",
  missing_required_file: "This archive is missing a required IMDF file.",
  invalid_json: "One of the IMDF files is not valid JSON.",
  invalid_manifest_version: "This archive must use IMDF manifest version 1.0.0.",
  invalid_feature_collection: "One of the IMDF GeoJSON files has an invalid feature collection.",
  duplicate_feature_id: "The archive contains the same IMDF feature ID more than once.",
  stale_version: "This upload was replaced before publishing finished. Upload the archive again.",
};

const publishFailedFallback = "Publishing failed on the server. Try uploading the archive again.";

/**
 * Turns a persisted publish-job error string into readable corrective copy.
 * Structured JSON errors map by stable code; unknown or malformed JSON falls
 * back to generic copy (never raw JSON or internal messages); pre-structured
 * plain text (legacy rows, client-side "timed out") passes through unchanged.
 */
export function publishErrorMessage(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const code = (parsed as { code?: unknown }).code;
    if (typeof code === "string") {
      return publishErrorCopy[code] ?? publishFailedFallback;
    }
  }
  return publishFailedFallback;
}

export interface GdbError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const gdbErrorCopy: Record<string, { ja: string; en: string } | undefined> = {
  invalid_geodatabase: {
    ja: "読み取り可能な Esri File Geodatabase が見つかりませんでした。",
    en: "The upload does not contain a readable Esri File Geodatabase.",
  },
  gdb_too_large: {
    ja: "GDB データが処理上限（アーカイブ 200 MiB 等）を超えています。",
    en: "The geodatabase exceeds the processing limits (e.g. 200 MiB archive).",
  },
  gdb_inspection_failed: {
    ja: "geodatabase を検査できませんでした。ファイルを確認してください。",
    en: "The geodatabase could not be inspected. Check the file and try again.",
  },
  gdb_conversion_failed: {
    ja: "選択したレイヤーを変換できませんでした。割り当てを見直してください。",
    en: "The selected layers could not be converted. Review the mapping and try again.",
  },
  gdb_network_extraction_failed: {
    ja: "ルーティングネットワークを抽出できませんでした。net_junction / net_path レイヤーを確認してください。",
    en: "The routing network could not be extracted. Check the net_junction / net_path layers.",
  },
  no_routable_network: {
    ja: "経路網を生成できませんでした。歩行可能なユニット（walkway / platform など）が割り当てられているか確認してください。",
    en: "No routable network could be generated. Check that walkable units (e.g. walkway, platform) are mapped.",
  },
};

export function gdbErrorMessage(err: GdbError, locale: LocaleCode): string {
  const copy = gdbErrorCopy[err.code];
  const base = copy ? copy[locale] : (locale === "ja" ? "取り込みに失敗しました。" : "Import failed.");
  const layer = typeof err.details?.layer === "string" ? err.details.layer : null;
  if (layer !== null) {
    return locale === "ja" ? `${base}（レイヤー: ${layer}）` : `${base} (layer: ${layer})`;
  }
  return base;
}

export type GdbPublishResponse = {
  jobId: string;
  versionId: number;
  seq: number;
  excludedLayers: Array<{ layer: string; reason: string }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : {},
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  async me(): Promise<ApiUser | null> {
    try {
      return (await request<{ user: ApiUser }>("/api/auth/me")).user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return null;
      }
      throw error;
    }
  },

  async login(username: string, password: string): Promise<ApiUser> {
    const { user } = await request<{ user: ApiUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return user;
  },

  async logout(): Promise<void> {
    await request<void>("/api/auth/logout", { method: "POST" });
  },

  async listVenues(): Promise<VenueSummary[]> {
    return (await request<{ venues: VenueSummary[] }>("/api/venues")).venues;
  },

  async createVenue(name: string): Promise<VenueRow> {
    return (
      await request<{ venue: VenueRow }>("/api/venues", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    ).venue;
  },

  async deleteVenue(id: number): Promise<void> {
    await request<void>(`/api/venues/${id}`, { method: "DELETE" });
  },

  uploadVersion(
    venueId: number,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<{ jobId: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/venues/${venueId}/versions`);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded / event.total);
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status === 202) {
          resolve(JSON.parse(xhr.responseText) as { jobId: string });
        } else {
          reject(new ApiError(xhr.status, xhr.responseText));
        }
      });
      xhr.addEventListener("error", () => {
        reject(new ApiError(0, "network error"));
      });
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  async waitForJob(
    jobId: string,
  ): Promise<{ status: "done" } | { status: "error"; error: string }> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = await request<{ status: string; error: string | null }>(`/api/jobs/${jobId}`);
      if (job.status === "done") {
        return { status: "done" };
      }
      if (job.status === "error") {
        return { status: "error", error: job.error ?? "unknown error" };
      }
      if (Date.now() > deadline) {
        return { status: "error", error: "timed out" };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  },

  inspectGdb(
    file: File,
    onProgress?: (fraction: number) => void,
  ): Promise<GdbInspectResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/gdb/inspect");
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status === 200) {
          resolve(JSON.parse(xhr.responseText) as GdbInspectResponse);
        } else {
          let parsed: GdbError = { code: "gdb_inspection_failed", message: xhr.responseText };
          try { parsed = JSON.parse(xhr.responseText) as GdbError; } catch { /* non-JSON */ }
          reject(parsed);
        }
      });
      xhr.addEventListener("error", () => reject({ code: "gdb_inspection_failed", message: "network error" } as GdbError));
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  inspectGdbNetwork(file: File): Promise<NetworkInspectResponse> {
    // Executor form required: tsconfig lib predates Promise.withResolvers (es2024).
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/gdb/inspect-network");
      xhr.addEventListener("load", () => {
        if (xhr.status === 200) {
          resolve(JSON.parse(xhr.responseText) as NetworkInspectResponse);
        } else {
          let parsed: GdbError = { code: "gdb_network_extraction_failed", message: xhr.responseText };
          try { parsed = JSON.parse(xhr.responseText) as GdbError; } catch { /* non-JSON */ }
          reject(parsed);
        }
      });
      xhr.addEventListener("error", () => reject({ code: "gdb_network_extraction_failed", message: "network error" } as GdbError));
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  inspectGdbFacilities(file: File): Promise<FacilitiesInspectResponse> {
    // Executor form required: tsconfig lib predates Promise.withResolvers (es2024).
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/gdb/inspect-facilities");
      xhr.addEventListener("load", () => {
        if (xhr.status === 200) {
          resolve(JSON.parse(xhr.responseText) as FacilitiesInspectResponse);
        } else {
          let parsed: GdbError = { code: "gdb_facility_extraction_failed", message: xhr.responseText };
          try { parsed = JSON.parse(xhr.responseText) as GdbError; } catch { /* non-JSON */ }
          reject(parsed);
        }
      });
      xhr.addEventListener("error", () => reject({ code: "gdb_facility_extraction_failed", message: "network error" } as GdbError));
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  async publishGdb(
    venueId: number,
    blobHash: string,
    plan: GdbMappingPlan,
    networkBlobHash?: string | null,
    facilitiesBlobHash?: string | null,
  ): Promise<GdbPublishResponse> {
    const res = await fetch("/api/gdb/publish", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        venueId,
        blobHash,
        plan,
        ...(networkBlobHash ? { networkBlobHash } : {}),
        ...(facilitiesBlobHash ? { facilitiesBlobHash } : {}),
      }),
    });
    if (!res.ok) {
      let parsed: GdbError = { code: "gdb_conversion_failed", message: `${res.status}` };
      try { parsed = (await res.json()) as GdbError; } catch { /* non-JSON */ }
      throw parsed;
    }
    const body = (await res.json()) as GdbPublishResponse;
    return {
      jobId: body.jobId,
      versionId: body.versionId,
      seq: body.seq,
      excludedLayers: Array.isArray(body.excludedLayers) ? body.excludedLayers : [],
    };
  },

  async augmentGdb(
    venueId: number,
    opts: { networkBlobHash?: string; facilitiesBlobHash?: string },
  ): Promise<{ jobId: string; versionId: number; seq: number }> {
    const res = await fetch("/api/gdb/augment", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        venueId,
        ...(opts.networkBlobHash ? { networkBlobHash: opts.networkBlobHash } : {}),
        ...(opts.facilitiesBlobHash ? { facilitiesBlobHash: opts.facilitiesBlobHash } : {}),
      }),
    });
    if (!res.ok) {
      let parsed: GdbError = { code: "gdb_conversion_failed", message: `${res.status}` };
      try { parsed = (await res.json()) as GdbError; } catch { /* non-JSON */ }
      throw parsed;
    }
    return (await res.json()) as { jobId: string; versionId: number; seq: number };
  },

  async generateNetwork(
    venueId: number,
  ): Promise<{ jobId: string; versionId: number; seq: number }> {
    const res = await fetch("/api/gdb/generate-network", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ venueId }),
    });
    if (!res.ok) {
      let parsed: GdbError = { code: "gdb_conversion_failed", message: `${res.status}` };
      try { parsed = (await res.json()) as GdbError; } catch { /* non-JSON */ }
      throw parsed;
    }
    return (await res.json()) as { jobId: string; versionId: number; seq: number };
  },

  async exportNetwork(venueId: number): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch("/api/gdb/export-network", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ venueId }),
    });
    if (!res.ok) {
      let parsed: GdbError = { code: "gdb_export_failed", message: `${res.status}` };
      try { parsed = (await res.json()) as GdbError; } catch { /* non-JSON */ }
      throw parsed;
    }
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return { blob, filename: match?.[1] ?? "network.gdb.zip" };
  },

  async importNetwork(
    slug: string,
    publicVersionId: string,
    junctions: string,
    paths: string,
  ): Promise<{ jobId: string; versionId: number; seq: number }> {
    const res = await fetch("/api/gdb/import-network", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, publicVersionId, junctions, paths }),
    });
    if (!res.ok) {
      let parsed: GdbError = { code: "gdb_conversion_failed", message: `${res.status}` };
      try { parsed = (await res.json()) as GdbError; } catch { /* non-JSON */ }
      throw parsed;
    }
    return (await res.json()) as { jobId: string; versionId: number; seq: number };
  },

  async getGdbMapping(
    venueId: number,
  ): Promise<{ blobHash: string; inspection: GdbInspection; plan: GdbMappingPlan }> {
    return request<{ blobHash: string; inspection: GdbInspection; plan: GdbMappingPlan }>(
      `/api/venues/${venueId}/gdb-mapping`,
    );
  },
};
