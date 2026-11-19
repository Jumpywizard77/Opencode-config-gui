import type { DiscoveredConfig } from "../core/discovery";
import type { MigrationReport } from "../core/migrate";
import type { ProbeResult } from "../core/probe";
import type { Issue } from "../core/types";

/**
 * Same-origin HTTP client for the local server (see `src/server/`). The UI
 * never sees raw Responses: every HTTP outcome is mapped to a discriminated
 * union keyed on `kind` so callers `switch` explicitly.
 *
 * `folder` (the UI's "Open folder…" probe folder) is an optional trailing
 * argument on the config-touching calls. It rides on the query string — the
 * server roots path safety per request on it, so a config discovered through
 * a probe folder is only readable/writable when the same folder accompanies
 * the read and every later save.
 */

// ---------------------------------------------------------------------------
// Payload shapes (mirrors of the server JSON, kept hand-written: the server
// is a separate module and a type-only import here would drag node builtins
// into the browser bundle graph).
// ---------------------------------------------------------------------------

export interface StatePayload {
  configs: DiscoveredConfig[];
  opencodeVersion: string | null;
  schemaSource: "bundled" | "remote";
  /** `"bundled"`, `"bundled-missing"` (degraded validation) or an ISO date. */
  schemaFetchedAt: string;
  probeFolderEcho: string | null;
}

export interface ConfigPayload {
  text: string;
  sha256: string;
  issues: Issue[];
}

export interface UpgradePreviewPayload {
  diff: string;
  report: MigrationReport;
  sha256: string;
}

export interface SchemaRefreshPayload {
  schemaSource: string;
  schemaFetchedAt: string;
}

// ---------------------------------------------------------------------------
// Result unions
// ---------------------------------------------------------------------------

export interface ApiError {
  kind: "error";
  /** HTTP status, or 0 for a transport failure (fetch rejected). */
  status: number;
  message: string;
}

export type ApiResult<T> = { kind: "ok"; data: T } | ApiError;

/** Outcome of `saveConfig`/`upgradeApply` — the write pipeline's three fates. */
export type SaveOutcome =
  | { kind: "ok"; sha256: string; backupPath: string }
  | { kind: "stale"; diskSha256: string }
  | { kind: "new_issues"; newIssues: Issue[] }
  | ApiError;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(body: unknown, status: number): string {
  const record = asRecord(body);
  return typeof record?.["error"] === "string" ? (record["error"] as string) : `HTTP ${status}`;
}

/** Builds `/api/…` (optionally `?k=v&…`); undefined/empty params are dropped. */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function callApi<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    return { kind: "error", status: 0, message: err instanceof Error ? err.message : String(err) };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null; // non-JSON error pages fall through to the HTTP-status message
  }
  if (!response.ok) {
    return { kind: "error", status: response.status, message: errorMessage(body, response.status) };
  }
  return { kind: "ok", data: body as T };
}

/** Maps the save/upgrade-apply responses (200 / 409 stale / 400 new_issues). */
async function interpretSave(response: Response): Promise<SaveOutcome> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 409) {
    const record = asRecord(body);
    const diskSha256 = record?.["diskSha256"];
    if (typeof diskSha256 === "string" && record?.["error"] === "stale") {
      return { kind: "stale", diskSha256 };
    }
  }
  if (response.ok) {
    const record = asRecord(body);
    const sha256 = record?.["sha256"];
    const backupPath = record?.["backupPath"];
    if (typeof sha256 === "string" && typeof backupPath === "string") {
      return { kind: "ok", sha256, backupPath };
    }
  }
  if (response.status === 400) {
    const record = asRecord(body);
    if (record?.["error"] === "new_issues" && Array.isArray(record["newIssues"])) {
      return { kind: "new_issues", newIssues: record["newIssues"] as Issue[] };
    }
  }
  return { kind: "error", status: response.status, message: errorMessage(body, response.status) };
}

async function postSave(url: string, payload: Record<string, unknown>): Promise<SaveOutcome> {
  let response: Response;
  try {
    response = await fetch(url, postJson(payload));
  } catch (err) {
    return { kind: "error", status: 0, message: err instanceof Error ? err.message : String(err) };
  }
  return interpretSave(response);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function getState(folder?: string): Promise<ApiResult<StatePayload>> {
  return callApi<StatePayload>(withQuery("/api/state", { folder }));
}

export function getConfig(path: string, folder?: string): Promise<ApiResult<ConfigPayload>> {
  return callApi<ConfigPayload>(withQuery("/api/config", { path, folder }));
}

export function saveConfig(
  path: string,
  text: string,
  baseSha256: string,
  baseIssues: Issue[],
  folder?: string,
): Promise<SaveOutcome> {
  return postSave(withQuery("/api/config/save", { folder }), {
    path,
    text,
    baseSha256,
    baseIssues,
  });
}

export function probe(baseURL: string, apiKey?: string): Promise<ApiResult<ProbeResult>> {
  return callApi<ProbeResult>(
    "/api/probe",
    postJson({ baseURL, ...(apiKey !== undefined ? { apiKey } : {}) }),
  );
}

export function upgradePreview(
  path: string,
  folder?: string,
): Promise<ApiResult<UpgradePreviewPayload>> {
  return callApi<UpgradePreviewPayload>(withQuery("/api/upgrade/preview", { folder }), postJson({ path }));
}

export function upgradeApply(
  path: string,
  baseSha256: string,
  baseIssues: Issue[],
  folder?: string,
): Promise<SaveOutcome> {
  return postSave(withQuery("/api/upgrade/apply", { folder }), {
    path,
    baseSha256,
    baseIssues,
  });
}

export function refreshSchema(): Promise<ApiResult<SchemaRefreshPayload>> {
  return callApi<SchemaRefreshPayload>("/api/schema/refresh", { method: "POST" });
}
