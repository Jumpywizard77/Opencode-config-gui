import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { PathLike } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { FsImpl } from "../../src/core/discovery";
import { upgradeDocumentText } from "../../src/core/migrate";
import { probeModels } from "../../src/core/probe";
import { createConfigApiHandlers } from "../../src/server/config-api";
import { createExtraApiHandlers, type ExtraApiDeps } from "../../src/server/extra-api";
import { sha256 } from "../../src/server/http";
import { createServer, type CreateServerOptions } from "../../src/server/server";

/**
 * Integration tests for Task 9's extra routes (`probe`, `upgrade/preview`,
 * `upgrade/apply`, `schema/refresh`) over real HTTP, plus static serving with
 * SPA fallback. Same harness as config-api.test.ts: `createServer` on
 * 127.0.0.1:0 with both route tables merged, discovery pinned to a mkdtemp
 * fake home, schema load pinned to a private cacheDir, and probe/schema
 * networking injected — nothing here touches the network or the real home.
 */

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/opencode.v1.sample.json", import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");

const failFetch = (async () => {
  throw new Error("offline test: server tests must not touch the network");
}) as unknown as typeof fetch;

const failExec = (): Promise<{ stdout: string }> =>
  Promise.reject(new Error("offline test: no opencode binary may run"));

/** Flat existing-path fake for the discovery fs port (see config-api.test.ts). */
function discoveryFsFake(files: string[]): FsImpl {
  const canon = (p: unknown): string =>
    String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const fileSet = new Set(files.map(canon));
  const dirSet = new Set<string>();
  for (const file of fileSet) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      dirSet.add(parts.slice(0, i).join("/"));
    }
  }
  return {
    existsSync: (p) => {
      const c = canon(p);
      return fileSet.has(c) || dirSet.has(c);
    },
    readdirSync: ((p: PathLike) => {
      const c = canon(p);
      const prefix = `${c}/`;
      const names: string[] = [];
      for (const file of fileSet) {
        if (file.startsWith(prefix)) {
          const rest = file.slice(prefix.length);
          if (!rest.includes("/")) names.push(rest);
        }
      }
      return names;
    }) as unknown as FsImpl["readdirSync"],
  };
}

interface Harness {
  server: http.Server;
  base: string;
  /** The mkdtemp project dir; contains `opencode.json` (a fixture copy). */
  dir: string;
  configPath: string;
}

const harnesses: Harness[] = [];

function boot(overrides: Partial<ExtraApiDeps> = {}, serverOptions: CreateServerOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ocg-xapi-"));
  const configPath = join(dir, "opencode.json");
  copyFileSync(FIXTURE_PATH, configPath);
  const fakeHome = join(dir, "fakehome");
  mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
  writeFileSync(join(fakeHome, ".config", "opencode", "opencode.json"), FIXTURE_TEXT);

  const deps: ExtraApiDeps = {
    platform: "linux",
    env: { HOME: fakeHome },
    cwd: dir,
    homeDir: join(dir, "definitely-not-a-home"),
    loadSchemaOptions: { cacheDir: join(dir, "schema-cache"), fetchImpl: failFetch },
    execFileImpl: failExec,
    ...overrides,
  };

  const routes = { ...createConfigApiHandlers(deps), ...createExtraApiHandlers(deps) };
  const server = createServer(routes, serverOptions);
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const harness: Harness = { server, base: `http://127.0.0.1:${port}`, dir, configPath };
      harnesses.push(harness);
      done(harness);
    });
  });
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.server.closeAllConnections();
    await new Promise<void>((done) => harness.server.close(() => done()));
    try {
      rmSync(harness.dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle; temp dirs are disposable.
    }
  }
});

function query(params: Record<string, string>): string {
  return `?${Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&")}`;
}

interface CallResponse {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  harness: Harness,
  method: string,
  pathWithQuery: string,
  body?: unknown,
): Promise<CallResponse> {
  const res = await fetch(harness.base + pathWithQuery, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text), headers: res.headers };
}

function rawGet(
  harness: Harness,
  pathWithQuery: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const { port } = harness.server.address() as AddressInfo;
    const request = http.request({ host: "127.0.0.1", port, path: pathWithQuery, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: data }));
    });
    request.on("error", fail);
    request.end();
  });
}

const previewUrl = (harness: Harness): string => `/api/upgrade/preview${query({ folder: harness.dir })}`;
const applyUrl = (harness: Harness): string => `/api/upgrade/apply${query({ folder: harness.dir })}`;

describe("server/extra-api", () => {
  it("upgradePreview_withV1FixturePath_shouldReturnUnifiedDiffAndNonEmptyChanges", async () => {
    const harness = await boot();
    const got = await call(harness, "POST", previewUrl(harness), { path: harness.configPath });
    expect(got.status).toBe(200);

    // The staleness token is the SHA of the DISK text (what apply must echo).
    expect(got.body.sha256).toBe(sha256(FIXTURE_TEXT));

    const report = got.body.report as { changes: string[]; leftUnchanged: { path: string }[] };
    expect(report.changes.length).toBeGreaterThan(0);
    expect(report.changes.some((change) => change.includes("provider → providers"))).toBe(true);

    expect(got.body.diff).toContain("@@"); // a real unified diff, not just headers
    expect(got.body.diff).toContain("-  \"provider\":");
    expect(got.body.diff).toContain("+  \"providers\":");

    // Preview is a pure read: same bytes on disk, no backup, no temp residue.
    expect(readFileSync(harness.configPath, "utf8")).toBe(FIXTURE_TEXT);
    expect(readdirSync(harness.dir).filter((name) => name.includes(".bak-"))).toEqual([]);
    expect(readdirSync(harness.dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("upgradePreview_forUndiscoveredPath_shouldReturn404", async () => {
    const harness = await boot();
    const got = await call(harness, "POST", previewUrl(harness), { path: join(harness.dir, "nope.json") });
    expect(got.status).toBe(404);
    expect(got.body.error).toBe("unknown_or_unsafe_path");
  });

  it("upgradeApply_forSystemKindPath_shouldReturn403", async () => {
    // Same KIND-based refusal as Task 8's config routes, via a fake fs that
    // only knows the /etc file (no real /etc needed).
    const systemPath = "/etc/opencode/opencode.json";
    const harness = await boot({ discoveryFs: discoveryFsFake([systemPath]) });
    const got = await call(harness, "POST", previewUrl(harness), {
      path: systemPath,
      baseSha256: "0".repeat(64),
      baseIssues: [],
    });
    expect(got.status).toBe(403);
    expect(typeof got.body.error).toBe("string");
  });

  it("upgradeApply_withMatchingBaseSha_shouldWriteMigratedTextAndBackup", async () => {
    const harness = await boot();
    const preview = await call(harness, "POST", previewUrl(harness), { path: harness.configPath });
    expect(preview.status).toBe(200);

    // Server-side migration is computed from DISK text; the expected result
    // is the pure core migrator's output on the same bytes.
    const { text: expectedText } = upgradeDocumentText(FIXTURE_TEXT);

    const applied = await call(harness, "POST", applyUrl(harness), {
      path: harness.configPath,
      baseSha256: preview.body.sha256,
      baseIssues: [],
    });
    expect(applied.status).toBe(200);
    expect(Object.keys(applied.body).sort()).toEqual(["backupPath", "sha256"]); // save-shape
    expect(applied.body.sha256).toBe(sha256(expectedText));
    expect(readFileSync(harness.configPath, "utf8")).toBe(expectedText);

    // Backup holds the pre-upgrade (v1) bytes, named like Task 8's saves.
    const backupName = basename(applied.body.backupPath as string);
    expect(backupName).toMatch(/^opencode\.json\.bak-\d{8}-\d{6}(-\d+)?$/);
    expect(readFileSync(applied.body.backupPath, "utf8")).toBe(FIXTURE_TEXT);

    // GET /api/config: the file is now a v2 document.
    const got = await call(
      harness,
      "GET",
      `/api/config${query({ path: harness.configPath, folder: harness.dir })}`,
    );
    expect(got.status).toBe(200);
    expect(got.body.text).toContain('"providers"');
    const doc = JSON.parse(got.body.text);
    expect(doc).not.toHaveProperty("provider"); // not as a top-level key

    // Re-applying the preview on the now-v2 file: nothing left to change.
    const again = await call(harness, "POST", previewUrl(harness), { path: harness.configPath });
    expect(again.status).toBe(200);
    expect(again.body.report.changes).toEqual([]);
    expect(again.body.sha256).toBe(applied.body.sha256);
    expect(again.body.diff).not.toContain("@@"); // identical texts: header-only patch

    // Task-8 stale regression, re-run through the upgrade entry point: a
    // second apply with the now-stale preview sha 409s and writes nothing.
    const stale = await call(harness, "POST", applyUrl(harness), {
      path: harness.configPath,
      baseSha256: preview.body.sha256,
      baseIssues: [],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale");
    expect(stale.body.diskSha256).toBe(applied.body.sha256);
    expect(readFileSync(harness.configPath, "utf8")).toBe(expectedText);
    // No extra backup was produced by the refused apply.
    expect(readdirSync(harness.dir).filter((name) => name.includes(".bak-"))).toHaveLength(1);
  });

  it("probe_withStubbedOkResponse_shouldPassThroughModelIds", async () => {
    const seenUrls: string[] = [];
    const okFetch = (async (input: unknown) => {
      seenUrls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "alpha-model" }, { id: "beta-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // Injectable probeImpl: the route wires body → probe and ProbeResult →
    // response; the stubbed fetch keeps the probe itself off the network.
    const harness = await boot({
      probeImpl: (input) => probeModels({ ...input, fetchImpl: okFetch }),
    });

    const got = await call(harness, "POST", "/api/probe", {
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-secret-do-not-echo",
    });
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("ok");
    expect(got.body.modelIds).toEqual(["alpha-model", "beta-model"]);
    expect(seenUrls).toEqual(["https://api.example.test/v1/models"]);
    // The apiKey never appears anywhere in the response.
    expect(JSON.stringify(got.body)).not.toContain("sk-secret-do-not-echo");
  });

  it("probe_withMissingBaseUrl_shouldReturn400", async () => {
    const harness = await boot();
    const got = await call(harness, "POST", "/api/probe", { apiKey: "sk-x" });
    expect(got.status).toBe(400);
    expect(got.body.error).toBe("bad_request");
  });

  it("schemaRefresh_withStubbedFetch_shouldReportRemoteSource", async () => {
    const schemaFetch = (async () =>
      new Response(JSON.stringify({ type: "object", properties: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const cacheDir = join(mkdtempSync(join(tmpdir(), "ocg-xapi-cache-")), "schema-cache");
    const harness = await boot({ loadSchemaOptions: { cacheDir, fetchImpl: schemaFetch } });
    try {
      const got = await call(harness, "POST", "/api/schema/refresh", {});
      expect(got.status).toBe(200);
      expect(got.body.schemaSource).toBe("remote");
      expect(Date.parse(got.body.schemaFetchedAt as string)).toBeGreaterThan(0);

      // The refresh populated the shared cache: /api/state now reports remote.
      const state = await call(harness, "GET", `/api/state${query({ folder: harness.dir })}`);
      expect(state.body.schemaSource).toBe("remote");

      // A refresh whose network fails degrades honestly to the bundled copy.
      const offline = await boot({
        loadSchemaOptions: { cacheDir: join(cacheDir, "unused"), fetchImpl: failFetch },
      });
      const degraded = await call(offline, "POST", "/api/schema/refresh", {});
      expect(degraded.status).toBe(200);
      expect(degraded.body.schemaSource).toBe("bundled");
    } finally {
      try {
        rmSync(join(cacheDir, ".."), { recursive: true, force: true });
      } catch {
        // temp dir, disposable
      }
    }
  });

  it("apiRequest_withForeignOrigin_shouldReturn403", async () => {
    const harness = await boot();
    // Explicit browser-style cross-origin POSTs: every extra route must 403
    // before any body handling (the gate runs ahead of routing).
    const routes = ["/api/probe", "/api/upgrade/preview", "/api/upgrade/apply", "/api/schema/refresh"];
    for (const path of routes) {
      const res = await fetch(harness.base + path, {
        method: "POST",
        headers: { origin: "http://evil.example", "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status, path).toBe(403);
    }

    // Control: the same request with no Origin header (non-browser client)
    // passes the gate — the 403 above is about the foreign Origin itself.
    const control = await call(harness, "POST", "/api/schema/refresh", {});
    expect(control.status).toBe(200);
  });

  it("static_withTempStaticDir_shouldServeAssetsWithSpaFallbackAndRefuseTraversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocg-xapi-static-"));
    try {
      const staticDir = join(dir, "ui");
      mkdirSync(staticDir, { recursive: true });
      writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>ocg</title>");
      mkdirSync(join(staticDir, "assets"), { recursive: true });
      writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1);\n");

      const harness = await boot({}, { staticDir });

      const root = await rawGet(harness, "/");
      expect(root.status).toBe(200);
      expect(root.body).toBe("<!doctype html><title>ocg</title>");

      const asset = await rawGet(harness, "/assets/app.js");
      expect(asset.status).toBe(200);
      expect(asset.body).toBe("console.log(1);\n");

      // SPA fallback: an unknown route serves index.html, not a 404.
      const spa = await rawGet(harness, "/deep/client/route");
      expect(spa.status).toBe(200);
      expect(spa.body).toBe("<!doctype html><title>ocg</title>");

      // Encoded-slash traversal survives URL parsing and must hit the
      // containment guard; the neighbouring config is never served.
      const escape = await rawGet(harness, "/..%2fopencode.json");
      expect(escape.status).toBe(403);
      expect(escape.body).toContain("unsafe_path");
      expect(escape.body).not.toContain("Maya");

      // Raw dot segments are normalized away by the URL parser itself, so
      // they can at worst reach the SPA fallback — again, never the config.
      const normalized = await rawGet(harness, "/%2e%2e/opencode.json");
      expect(normalized.status).toBe(200);
      expect(normalized.body).toBe("<!doctype html><title>ocg</title>");

      // Static responses carry no CORS headers either.
      const res = await fetch(`${harness.base}/index.html`);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp dir, disposable
      }
    }
  });
});
