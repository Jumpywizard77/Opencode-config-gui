import type { PathLike } from "node:fs";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { FsImpl } from "../../src/core/discovery";
import {
  createConfigApiHandlers,
  type ConfigApiDeps,
  type DiscoveredConfig,
} from "../../src/server/config-api";
import { sha256 } from "../../src/server/http";
import { createServer } from "../../src/server/server";

/**
 * Integration tests over real HTTP (global fetch + real node:fs on mkdtemp
 * dirs) and one raw `node:http` request for the Host/Origin checks. The
 * harness boots `createServer` on 127.0.0.1:0.
 *
 * Hermeticity: `platform`/`env`/`homeDir` are injected so discovery and the
 * path-safety roots never touch the developer's real home or /etc; the schema
 * load is pinned to the bundled fallback (failing fetch + private cacheDir)
 * and the version probe to a failing execFileImpl, so no network or child
 * processes happen here.
 */

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/opencode.v1.sample.json", import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");

const failFetch = (async () => {
  throw new Error("offline test: server tests must not touch the network");
}) as unknown as typeof fetch;

const failExec = (): Promise<{ stdout: string }> =>
  Promise.reject(new Error("offline test: no opencode binary may run"));

/** Flat existing-path fake for the discovery fs port (see discovery.test.ts). */
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

function boot(overrides: Partial<ConfigApiDeps> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ocg-srv-"));
  const configPath = join(dir, "opencode.json");
  copyFileSync(FIXTURE_PATH, configPath);
  // A fake home so the `global` kind exists inside the project dir (which is
  // the request folder root); the REAL home never enters discovery or vetting
  // because deps.homeDir/env are overridden.
  const fakeHome = join(dir, "fakehome");
  mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
  writeFileSync(join(fakeHome, ".config", "opencode", "opencode.json"), FIXTURE_TEXT);

  const deps: ConfigApiDeps = {
    platform: "linux",
    env: { HOME: fakeHome },
    cwd: dir,
    homeDir: join(dir, "definitely-not-a-home"),
    loadSchemaOptions: { cacheDir: join(dir, "schema-cache"), fetchImpl: failFetch },
    execFileImpl: failExec,
    ...overrides,
  };

  const server = createServer(createConfigApiHandlers(deps));
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

interface Response {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  harness: Harness,
  method: string,
  pathWithQuery: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(harness.base + pathWithQuery, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text), headers: res.headers };
}

const getConfigUrl = (harness: Harness, filePath: string, folder?: string): string =>
  `/api/config${query({ path: filePath, folder: folder ?? harness.dir })}`;

function rawGet(
  harness: Harness,
  pathWithQuery: string,
  headers: Record<string, string>,
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

describe("server/config-api", () => {
  it("save_validEdit_shouldWriteBackupAndNewFileAtomically", async () => {
    const harness = await boot();
    const got = await call(harness, "GET", getConfigUrl(harness, harness.configPath));
    expect(got.status).toBe(200);
    const originalText: string = got.body.text;
    expect(originalText).toBe(FIXTURE_TEXT);
    expect(got.body.sha256).toBe(sha256(FIXTURE_TEXT));

    const editedText = originalText.replace('"name": "Maya (local)"', '"name": "Maya (renamed)"');
    expect(editedText).not.toBe(originalText);

    const saved = await call(harness, "POST", `/api/config/save${query({ folder: harness.dir })}`, {
      path: harness.configPath,
      text: editedText,
      baseSha256: got.body.sha256,
      baseIssues: [],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.sha256).toBe(sha256(editedText));
    expect(typeof saved.body.backupPath).toBe("string");

    // Backup: next to the file, named *.bak-YYYYMMDD-HHmmss, holding the OLD bytes.
    const backupName = basename(saved.body.backupPath as string);
    expect(backupName).toMatch(/^opencode\.json\.bak-\d{8}-\d{6}$/);
    expect(resolve(saved.body.backupPath)).toBe(join(harness.dir, backupName));
    expect(readFileSync(saved.body.backupPath, "utf8")).toBe(originalText);

    // The file now matches the submitted text byte-for-byte, and the temp
    // file used for the atomic rename left no residue.
    expect(readFileSync(harness.configPath, "utf8")).toBe(editedText);
    expect(readdirSync(harness.dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("save_twiceInSameSecond_shouldKeepBothBackups", async () => {
    // Rapid sequential saves (Ctrl+S twice, or upgrade-apply + save) hit the
    // 1-second backup stamp. The backup net must never eat an earlier
    // backup: each save gets its own file, and the FIRST save's backup keeps
    // the original bytes.
    const harness = await boot();
    const got = await call(harness, "GET", getConfigUrl(harness, harness.configPath));
    const originalText: string = got.body.text;

    const firstText = originalText.replace('"Maya (local)"', '"Maya (edit one)"');
    const secondText = firstText.replace('"Maya (edit one)"', '"Maya (edit two)"');
    const saveUrl = `/api/config/save${query({ folder: harness.dir })}`;

    const first = await call(harness, "POST", saveUrl, {
      path: harness.configPath,
      text: firstText,
      baseSha256: got.body.sha256,
      baseIssues: [],
    });
    expect(first.status).toBe(200);
    const second = await call(harness, "POST", saveUrl, {
      path: harness.configPath,
      text: secondText,
      baseSha256: first.body.sha256,
      baseIssues: [],
    });
    expect(second.status).toBe(200);

    expect(second.body.backupPath).not.toBe(first.body.backupPath);
    const backups = readdirSync(harness.dir).filter((name) => name.includes(".bak-")).sort();
    expect(backups).toHaveLength(2);
    for (const name of backups) {
      expect(name).toMatch(/^opencode\.json\.bak-\d{8}-\d{6}(-\d+)?$/);
    }
    // The first save's backup survived the second save and still holds the
    // pre-first-save (original) bytes; the second holds the first edit.
    expect(readFileSync(first.body.backupPath, "utf8")).toBe(originalText);
    expect(readFileSync(second.body.backupPath, "utf8")).toBe(firstText);
    expect(readFileSync(harness.configPath, "utf8")).toBe(secondText);
  });

  it("save_withPreExistingError_inUntouchedSection_shouldSucceedWithWarningFreeResponse", async () => {
    const harness = await boot();
    const doc = JSON.parse(FIXTURE_TEXT);
    doc.bogus_root = { nonsense: true };
    const corruptedText = JSON.stringify(doc, null, 2);
    writeFileSync(harness.configPath, corruptedText);

    const got = await call(harness, "GET", getConfigUrl(harness, harness.configPath));
    expect(got.status).toBe(200);
    expect((got.body.issues as { path: string }[]).some((issue) => issue.path === "bogus_root")).toBe(true);

    // Edit in an untouched section; the pre-existing bogus_root error travels
    // along in the new text but is not NEWLY introduced, so the save passes
    // with a plain success body (no warning field).
    const editedText = corruptedText.replace('"Maya (local)"', '"Maya (kept)"');
    const saved = await call(harness, "POST", `/api/config/save${query({ folder: harness.dir })}`, {
      path: harness.configPath,
      text: editedText,
      baseSha256: got.body.sha256,
      baseIssues: got.body.issues,
    });
    expect(saved.status).toBe(200);
    expect(Object.keys(saved.body).sort()).toEqual(["backupPath", "sha256"]);
    expect(readFileSync(harness.configPath, "utf8")).toBe(editedText);
  });

  it("save_introducingNewSchemaError_shouldReturn400WithNewIssues", async () => {
    const harness = await boot();
    const doc = JSON.parse(FIXTURE_TEXT);
    doc.bogus_root = { nonsense: true };
    const corruptedText = JSON.stringify(doc, null, 2);
    writeFileSync(harness.configPath, corruptedText);

    const got = await call(harness, "GET", getConfigUrl(harness, harness.configPath));
    const worseDoc = JSON.parse(corruptedText);
    worseDoc.bogus_second = "nope";
    const worseText = JSON.stringify(worseDoc, null, 2);

    const saved = await call(harness, "POST", `/api/config/save${query({ folder: harness.dir })}`, {
      path: harness.configPath,
      text: worseText,
      baseSha256: got.body.sha256,
      baseIssues: got.body.issues,
    });
    expect(saved.status).toBe(400);
    expect(saved.body.error).toBe("new_issues");
    const newPaths = (saved.body.newIssues as { path: string }[]).map((issue) => issue.path);
    expect(newPaths).toContain("bogus_second");
    // The pre-existing bogus_root error is NOT part of the block: only the
    // set difference newSet \ oldSet may stop this save.
    expect(newPaths).not.toContain("bogus_root");

    // Blocked saves touch nothing: same bytes, no backup created.
    expect(readFileSync(harness.configPath, "utf8")).toBe(corruptedText);
    expect(readdirSync(harness.dir).filter((name) => name.includes(".bak-"))).toEqual([]);
  });

  it("save_withStaleBaseSha256_shouldReturn409WithDiskSha256", async () => {
    const harness = await boot();
    const got = await call(harness, "GET", getConfigUrl(harness, harness.configPath));
    appendFileSync(harness.configPath, "\n"); // someone else edited the file

    const saved = await call(harness, "POST", `/api/config/save${query({ folder: harness.dir })}`, {
      path: harness.configPath,
      text: got.body.text,
      baseSha256: got.body.sha256,
      baseIssues: [],
    });
    expect(saved.status).toBe(409);
    expect(saved.body.error).toBe("stale");
    expect(saved.body.diskSha256).toBe(sha256(got.body.text + "\n"));
    // Nothing was written: still the appended-to disk text, no backup.
    expect(readFileSync(harness.configPath, "utf8")).toBe(got.body.text + "\n");
    expect(readdirSync(harness.dir).filter((name) => name.includes(".bak-"))).toEqual([]);
  });

  it("getConfig_forSystemKindPath_shouldReturn403", async () => {
    // The system kind comes from the platform system dir; rather than needing
    // root to create /etc/opencode, discovery is fed a fake fs that only
    // knows that file. The vetting layer must refuse it by KIND, not by path
    // string, before any read happens.
    const systemPath = "/etc/opencode/opencode.json";
    const harness = await boot({ discoveryFs: discoveryFsFake([systemPath]) });

    const got = await call(harness, "GET", getConfigUrl(harness, systemPath));
    expect(got.status).toBe(403);
    expect(typeof got.body.error).toBe("string");
  });

  it("getConfig_forPathOutsideAllowedRoots_shouldReturn404", async () => {
    // dir2 is scanned through deps.cwd (so the file IS discovered), but the
    // request's allowed roots are homeDir (an empty dir) + ?folder=dir.
    const harness = await boot();
    const dir2 = mkdtempSync(join(tmpdir(), "ocg-srv-other-"));
    try {
      const otherConfig = join(dir2, "opencode.json");
      writeFileSync(otherConfig, FIXTURE_TEXT);
      const cwdBoot = await boot({ cwd: dir2 });

      const direct = await call(cwdBoot, "GET", `/api/config${query({ path: otherConfig, folder: harness.dir })}`);
      expect(direct.status).toBe(404);
      expect(direct.body.error).toBe("unknown_or_unsafe_path");

      // The same file reached through `..` tricks is refused identically —
      // the escape attempt resolves to the outside path, then fails roots.
      const trick = join(harness.dir, "..", basename(dir2), "opencode.json");
      const viaTrick = await call(cwdBoot, "GET", `/api/config${query({ path: trick, folder: harness.dir })}`);
      expect(viaTrick.status).toBe(404);
      expect(viaTrick.body.error).toBe("unknown_or_unsafe_path");

      // Control: a `..` hop that resolves back INSIDE the allowed root works.
      const harmless = join(harness.dir, "sub", "..", "opencode.json");
      const ok = await call(cwdBoot, "GET", `/api/config${query({ path: harmless, folder: harness.dir })}`);
      expect(ok.status).toBe(200);
      expect(ok.body.text).toBe(FIXTURE_TEXT);
    } finally {
      try {
        rmSync(dir2, { recursive: true, force: true });
      } catch {
        // temp dir, disposable
      }
    }
  });

  it("state_reportsSchemaSourceBundled_andOpencodeVersionOrNull", async () => {
    const harness = await boot();
    const got = await call(harness, "GET", `/api/state${query({ folder: harness.dir })}`);
    expect(got.status).toBe(200);
    expect(got.body.schemaSource).toBe("bundled");
    expect(got.body.schemaFetchedAt).toBe("bundled");
    expect(got.body.opencodeVersion).toBeNull();
    expect(got.body.probeFolderEcho).toBe(harness.dir);

    const configs = got.body.configs as DiscoveredConfig[];
    const globalEntry = configs.find((entry) => entry.kind === "global");
    expect(globalEntry).toBeDefined();
    expect(resolve(globalEntry!.path)).toBe(join(harness.dir, "fakehome", ".config", "opencode", "opencode.json"));
    expect(globalEntry!.editable).toBe(true);
    expect(configs.some((entry) => resolve(entry.path) === harness.configPath && entry.kind === "project")).toBe(
      true,
    );

    // API responses carry no CORS headers (same-origin tool, no cross-site writes).
    expect(got.headers.get("access-control-allow-origin")).toBeNull();
    expect(got.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("api_withForeignHostHeader_shouldReturn403", async () => {
    // DNS-rebinding shape: connection is local but Host names another site.
    const harness = await boot();
    const got = await rawGet(harness, "/api/state", { host: "attacker.example" });
    expect(got.status).toBe(403);
    expect(JSON.parse(got.body).error).toBeTruthy();
  });

  it("api_withForeignOrigin_shouldReturn403", async () => {
    const harness = await boot();
    const got = await rawGet(harness, "/api/state", { origin: "http://evil.example" });
    expect(got.status).toBe(403);
    expect(JSON.parse(got.body).error).toBeTruthy();

    // Control: a self-consistent localhost Host+Origin pair is accepted.
    const { port } = harness.server.address() as AddressInfo;
    const good = await rawGet(harness, "/api/state", {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
    });
    expect(good.status).toBe(200);
  });
});
