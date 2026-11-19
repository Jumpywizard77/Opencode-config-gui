import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getConfig,
  getState,
  probe,
  refreshSchema,
  saveConfig,
  upgradeApply,
  upgradePreview,
} from "../../src/ui/api";

/**
 * Unit tests for the UI's HTTP client (`src/ui/api.ts`) with `globalThis.fetch`
 * stubbed: no server is booted. The tests pin (a) URL/body building and
 * (b) the HTTP-status → discriminated-union mapping, above all `saveConfig`'s
 * 409 → `{kind:'stale', diskSha256}` — the callers switch on `kind` explicitly
 * and must never see a raw Response.
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface StubResponse {
  status: number;
  body: unknown;
}

/** Records every call; every response is `body` serialized as JSON. */
function stubFetch(calls: FetchCall[], respond: (call: FetchCall) => StubResponse): void {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
}

function networkFailFetch(): void {
  const fetchImpl = (): Promise<Response> => Promise.reject(new Error("boom"));
  vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
}

const query = (params: Record<string, string>): string =>
  new URLSearchParams(params).toString();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveConfig", () => {
  it("POSTs exactly {path, text, baseSha256, baseIssues} to /api/config/save", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: { sha256: "new-sha", backupPath: "p.bak-x" } }));

    const result = await saveConfig("C:/cfg/opencode.json", '{"a":1}', "base-sha", [
      { path: "provider.x", message: "pre-existing warning" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/config/save");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      path: "C:/cfg/opencode.json",
      text: '{"a":1}',
      baseSha256: "base-sha",
      baseIssues: [{ path: "provider.x", message: "pre-existing warning" }],
    });
    expect(result).toEqual({ kind: "ok", sha256: "new-sha", backupPath: "p.bak-x" });
  });

  it("maps 409 {error:'stale', diskSha256} to {kind:'stale', diskSha256}", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 409, body: { error: "stale", diskSha256: "disk-sha" } }));

    const result = await saveConfig("p", "t", "stale-base", []);
    expect(result).toEqual({ kind: "stale", diskSha256: "disk-sha" });
  });

  it("maps 400 {error:'new_issues', newIssues} to {kind:'new_issues', newIssues}", async () => {
    const calls: FetchCall[] = [];
    const newIssues = [{ path: "provider", message: "must be an object" }];
    stubFetch(calls, () => ({ status: 400, body: { error: "new_issues", newIssues } }));

    const result = await saveConfig("p", "t", "base", []);
    expect(result).toEqual({ kind: "new_issues", newIssues });
  });

  it("maps other error statuses to {kind:'error', status, message}", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 403, body: { error: "system_or_managed_config" } }));

    const result = await saveConfig("p", "t", "base", []);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(403);
    expect(result.message).toContain("system_or_managed_config");
  });

  it("maps a rejected fetch (network failure) to kind 'error' with status 0", async () => {
    networkFailFetch();
    const result = await saveConfig("p", "t", "base", []);
    expect(result).toEqual({ kind: "error", status: 0, message: "boom" });
  });

  it("appends ?folder= when a folder is supplied (path-safety rooting)", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: { sha256: "s", backupPath: "b" } }));

    await saveConfig("p", "t", "base", [], "D:/projects/app");
    expect(calls[0]!.url).toBe(`/api/config/save?${query({ folder: "D:/projects/app" })}`);
    // folder rides on the query only; the body keeps its exact four keys.
    expect(Object.keys(JSON.parse(String(calls[0]!.init.body)))).toEqual([
      "path",
      "text",
      "baseSha256",
      "baseIssues",
    ]);
  });
});

describe("getState / getConfig", () => {
  it("GETs /api/state and passes the payload through as {kind:'ok', data}", async () => {
    const payload = {
      configs: [{ path: "C:/cfg/opencode.json", kind: "global", editable: true }],
      opencodeVersion: "1.14.28",
      schemaSource: "bundled",
      schemaFetchedAt: "bundled",
      probeFolderEcho: null,
    };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    const result = await getState();
    expect(calls[0]!.url).toBe("/api/state");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(result).toEqual({ kind: "ok", data: payload });
  });

  it("GETs /api/state?folder= when a folder is supplied", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({
      status: 200,
      body: { configs: [], opencodeVersion: null, schemaSource: "bundled", schemaFetchedAt: "bundled", probeFolderEcho: "D:/x" },
    }));

    await getState("D:/x");
    expect(calls[0]!.url).toBe(`/api/state?${query({ folder: "D:/x" })}`);
  });

  it("GETs /api/config?path= (and ?folder= when supplied) for the text payload", async () => {
    const payload = { text: "{}", sha256: "abc", issues: [] };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    const plain = await getConfig("C:/cfg/opencode.json");
    expect(calls[0]!.url).toBe(`/api/config?${query({ path: "C:/cfg/opencode.json" })}`);
    expect(plain).toEqual({ kind: "ok", data: payload });

    await getConfig("C:/cfg/opencode.json", "D:/projects/app");
    expect(calls[1]!.url).toBe(
      `/api/config?${query({ path: "C:/cfg/opencode.json", folder: "D:/projects/app" })}`,
    );
  });

  it("maps error responses to {kind:'error', status, message} (e.g. unsafe path)", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 404, body: { error: "unknown_or_unsafe_path" } }));

    const result = await getConfig("/etc/passwd");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(404);
    expect(result.message).toContain("unknown_or_unsafe_path");
  });
});

describe("upgrade, probe and schema endpoints", () => {
  it("upgradePreview POSTs {path} and returns {diff, report, sha256}", async () => {
    const payload = { diff: "--- a", report: { changes: [], leftUnchanged: [] }, sha256: "sha" };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    const result = await upgradePreview("C:/cfg/opencode.json");
    expect(calls[0]!.url).toBe("/api/upgrade/preview");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ path: "C:/cfg/opencode.json" });
    expect(result).toEqual({ kind: "ok", data: payload });
  });

  it("upgradeApply POSTs {path, baseSha256, baseIssues} and maps 409 to stale", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 409, body: { error: "stale", diskSha256: "disk" } }));

    const result = await upgradeApply("p", "base", []);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      path: "p",
      baseSha256: "base",
      baseIssues: [],
    });
    expect(result).toEqual({ kind: "stale", diskSha256: "disk" });
  });

  it("probe POSTs {baseURL} and omits apiKey unless supplied", async () => {
    const payload = { status: "ok", modelIds: ["gpt"], detail: "", latencyMs: 5 };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    await probe("http://127.0.0.1:9/v1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ baseURL: "http://127.0.0.1:9/v1" });

    await probe("http://127.0.0.1:9/v1", "sk-test");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      baseURL: "http://127.0.0.1:9/v1",
      apiKey: "sk-test",
    });
  });

  it("refreshSchema POSTs /api/schema/refresh and returns the provenance", async () => {
    const payload = { schemaSource: "remote", schemaFetchedAt: "2026-11-19T00:00:00.000Z" };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    const result = await refreshSchema();
    expect(calls[0]!.url).toBe("/api/schema/refresh");
    expect(calls[0]!.init.method).toBe("POST");
    expect(result).toEqual({ kind: "ok", data: payload });
  });

  it("maps non-JSON error bodies to kind 'error' with an HTTP-status message", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response("gateway blew up", { status: 502 });
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);

    const result = await getState();
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(502);
    expect(result.message).toContain("502");
  });
});
