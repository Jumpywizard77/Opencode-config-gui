import { copyFileSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import nodePath from "node:path";

import {
  discoverConfigs,
  findOpencodeVersion,
  type DiscoveredConfig,
  type ExecFileImpl,
  type FsImpl,
} from "../core/discovery.js";
import {
  loadSchema,
  validateConfigText,
  type LoadSchemaOptions,
  type SchemaSource,
} from "../core/schema.js";
import type { Issue } from "../core/types.js";
import { json, readBody, sha256, type ApiRoutes } from "./http.js";

/**
 * HTTP-facing config endpoints: state, read, save. All filesystem side
 * effects live here (the `core/` modules stay pure); all path safety is
 * decided by `vetConfigPath` BEFORE any file is read or written.
 */

export type { DiscoveredConfig };

/** Injection ports; every default is the real platform (tests go hermetic). */
export interface ConfigApiDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Server's project folder for discovery (the UI's `?folder=` is per-request). */
  cwd?: string;
  /** Home dir used as an allowed root for GET/PUT (tests override it). */
  homeDir?: string;
  loadSchemaOptions?: LoadSchemaOptions;
  execFileImpl?: ExecFileImpl;
  /** Filesystem port for discovery only (config IO always uses node:fs). */
  discoveryFs?: FsImpl;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

export type VetOutcome =
  | { ok: true; entry: DiscoveredConfig }
  | { ok: false; status: number; error: string };

/**
 * Filesystem truth for comparisons: realpath (when the target exists — this
 * collapses symlinks/junctions), then absolute resolve (collapses `..`), then
 * case-fold on case-insensitive platforms.
 */
function canonicalKey(candidate: string): string {
  let real = candidate;
  try {
    // Unreadable/missing targets fall through: resolve() below still
    // normalizes separators and collapses `..`.
    real = realpathSync(candidate);
  } catch {
    // keep `candidate` as-is
  }
  const resolved = nodePath.resolve(real);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function withinRoot(rootKey: string, candidateKey: string): boolean {
  const trimmed = rootKey.length > 1 ? rootKey.replace(/[\\/]+$/, "") : rootKey;
  const prefix = trimmed.endsWith(nodePath.sep) ? trimmed : trimmed + nodePath.sep;
  return candidateKey === trimmed || candidateKey.startsWith(prefix);
}

/**
 * Decide whether a client-supplied path may be read or written:
 *
 * 1. it must be one of THIS request's `discoverConfigs` results (global /
 *    project under cwd or `?folder=`), compared on canonical keys so `..`
 *    tricks cannot slip a different file past a string match;
 * 2. system/managed kinds are refused (403) by kind, before any read;
 * 3. the canonical path must additionally resolve INSIDE one of the allowed
 *    roots — the user home dir or the request's `?folder=` — as
 *    defense-in-depth against configs discovered via server-side defaults
 *    (e.g. cwd) that the user never opened.
 *
 * Exported for Task 9's `extra-api.ts`, which vets upgrade paths through
 * this exact function (one path-safety implementation, no drift).
 */
export function vetConfigPath(
  deps: ConfigApiDeps,
  requestedPath: string,
  folder: string | undefined,
): VetOutcome {
  const configs = discoverConfigs({
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    cwd: deps.cwd ?? process.cwd(),
    ...(folder !== undefined ? { probeFolder: folder } : {}),
    ...(deps.discoveryFs !== undefined ? { fsImpl: deps.discoveryFs } : {}),
  });
  const wanted = canonicalKey(requestedPath);
  const entry = configs.find((config) => canonicalKey(config.path) === wanted);
  if (entry === undefined) return { ok: false, status: 404, error: "unknown_or_unsafe_path" };
  if (!entry.editable) return { ok: false, status: 403, error: "system_or_managed_config" };

  const roots = [deps.homeDir ?? homedir()];
  if (folder !== undefined) roots.push(folder);
  const target = canonicalKey(entry.path);
  if (!roots.some((root) => withinRoot(canonicalKey(root), target))) {
    return { ok: false, status: 404, error: "unknown_or_unsafe_path" };
  }
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// Save pipeline
// ---------------------------------------------------------------------------

export interface SaveDeps {
  /** The already-loaded schema generation to validate both texts against. */
  schema: SchemaSource;
}

export interface SaveWritten {
  ok: true;
  sha256: string;
  backupPath: string;
}
export interface SaveStale {
  ok: false;
  kind: "stale";
  diskSha256: string;
}
export interface SaveBlocked {
  ok: false;
  kind: "new_issues";
  newIssues: Issue[];
}
export type SaveResult = SaveWritten | SaveStale | SaveBlocked;

const issueKey = (issue: Issue): string => `${issue.path}|${issue.message}`;

/** Local-time `YYYYMMDD-HHmmss` stamp for backup file names. */
function backupStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const MAX_BACKUP_ATTEMPTS = 50;

/**
 * Copy `source` to a FRESH backup path next to it and return that path.
 * The stamp has 1-second granularity, and rapid sequential saves (double
 * Ctrl+S, upgrade-apply followed by a save) collide on it — a plain
 * `copyFileSync` would silently overwrite the earlier backup, letting the
 * safety net itself lose data. So the copy is exclusive (`COPYFILE_EXCL`,
 * also race-proof against a concurrent saver) and a colliding name is
 * retried with `-1`, `-2`, … suffixes.
 */
function writeBackup(source: string): string {
  const stem = `${source}.bak-${backupStamp(new Date())}`;
  for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? stem : `${stem}-${attempt}`;
    try {
      copyFileSync(source, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(
    `could not create a unique backup next to ${source} after ${MAX_BACKUP_ATTEMPTS} attempts`,
  );
}

/**
 * The shared validated-save pipeline (the config-save route AND Task 9's
 * upgrade-apply call this — one implementation of backup + atomic write +
 * issue policy, no drift between the two entry points).
 *
 * PATH SAFETY IS THE CALLER'S JOB: `path` must already have passed
 * `vetConfigPath` (or Task 9's equivalent). This function happily writes any
 * path it is handed.
 *
 * Issue policy — saves are blocked ONLY by errors the edit newly introduces:
 * the OLD issue set is recomputed from the on-disk text at save time, never
 * taken from the client's `baseIssues`. The client's view may be stale (the
 * file changed since its GET) or simply lying; disk truth wins. `baseIssues`
 * is accepted (and kept in the signature) purely as informational context —
 * unused today, available for future warning UI or Task 9's reports.
 */
export async function saveValidated(
  deps: SaveDeps,
  path: string,
  text: string,
  baseSha256: string,
  baseIssues: Issue[],
): Promise<SaveResult> {
  void baseIssues; // informational by design; see the policy note above

  const diskText = readFileSync(path, "utf8");
  const diskSha = sha256(diskText);
  if (diskSha !== baseSha256) return { ok: false, kind: "stale", diskSha256: diskSha };

  const oldKeys = new Set(validateConfigText(diskText, deps.schema).map(issueKey));
  const introduced = new Map<string, Issue>();
  for (const issue of validateConfigText(text, deps.schema)) {
    const key = issueKey(issue);
    // set difference newSet \ oldSet, de-duplicated by `path|message`
    if (!oldKeys.has(key) && !introduced.has(key)) introduced.set(key, issue);
  }
  if (introduced.size > 0) {
    return { ok: false, kind: "new_issues", newIssues: [...introduced.values()] };
  }

  const backupPath = writeBackup(path); // backup BEFORE any overwrite

  // Atomic replace: temp file in the SAME directory, then rename onto the
  // target (rename is atomic within a filesystem; on Windows Node replaces
  // the existing file via MoveFileExW(REPLACE_EXISTING)).
  const tempPath = nodePath.join(
    nodePath.dirname(path),
    `.${nodePath.basename(path)}.tmp-${randomBytes(6).toString("hex")}`,
  );
  writeFileSync(tempPath, text);
  try {
    renameSync(tempPath, path);
  } catch (err) {
    rmSync(tempPath, { force: true }); // no orphaned temp residue on failure
    throw err;
  }

  return { ok: true, sha256: sha256(text), backupPath };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createConfigApiHandlers(deps: ConfigApiDeps = {}): ApiRoutes {
  const schemaSource = (): Promise<SchemaSource> => loadSchema(deps.loadSchemaOptions ?? {});

  // An empty `?folder=` must mean "absent": resolve("") is the server's CWD,
  // and an accidental CWD root would silently widen path safety.
  const folderParam = (url: URL): string | undefined => {
    const value = url.searchParams.get("folder");
    return value !== null && value !== "" ? value : undefined;
  };

  const folderOf = (url: URL, body: Record<string, unknown>): string | undefined =>
    folderParam(url) ??
    (typeof body["folder"] === "string" && body["folder"] !== "" ? (body["folder"] as string) : undefined);

  return {
    "GET /api/state": async ({ res, url }) => {
      const folder = folderParam(url);
      const configs = discoverConfigs({
        platform: deps.platform ?? process.platform,
        env: deps.env ?? process.env,
        cwd: deps.cwd ?? process.cwd(),
        ...(folder !== undefined ? { probeFolder: folder } : {}),
        ...(deps.discoveryFs !== undefined ? { fsImpl: deps.discoveryFs } : {}),
      });
      const [source, opencodeVersion] = await Promise.all([
        schemaSource(),
        findOpencodeVersion(deps.execFileImpl),
      ]);
      json(res, 200, {
        configs,
        opencodeVersion,
        schemaSource: source.source,
        schemaFetchedAt: source.fetchedAt,
        probeFolderEcho: folder ?? null,
      });
    },

    "GET /api/config": async ({ res, url }) => {
      const requested = url.searchParams.get("path");
      if (requested === null || requested === "") {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const vet = vetConfigPath(deps, requested, folderParam(url));
      if (!vet.ok) {
        json(res, vet.status, { error: vet.error });
        return;
      }
      let text: string;
      try {
        text = readFileSync(vet.entry.path, "utf8");
      } catch {
        // discovered a moment ago yet unreadable (race/permissions): a read
        // failure, not a safety refusal.
        json(res, 500, { error: "read_failed" });
        return;
      }
      const source = await schemaSource();
      json(res, 200, { text, sha256: sha256(text), issues: validateConfigText(text, source) });
    },

    "POST /api/config/save": async ({ req, res, url }) => {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          json(res, 400, { error: "bad_request" });
          return;
        }
        body = parsed as Record<string, unknown>;
      } catch {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const target = body["path"];
      const text = body["text"];
      const baseSha256 = body["baseSha256"];
      const baseIssues = Array.isArray(body["baseIssues"]) ? (body["baseIssues"] as Issue[]) : [];
      if (typeof target !== "string" || typeof text !== "string" || typeof baseSha256 !== "string") {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const vet = vetConfigPath(deps, target, folderOf(url, body));
      if (!vet.ok) {
        json(res, vet.status, { error: vet.error });
        return;
      }
      const source = await schemaSource();
      const result = await saveValidated({ schema: source }, vet.entry.path, text, baseSha256, baseIssues);
      if (!result.ok) {
        if (result.kind === "stale") {
          json(res, 409, { error: "stale", diskSha256: result.diskSha256 });
        } else {
          json(res, 400, { error: "new_issues", newIssues: result.newIssues });
        }
        return;
      }
      json(res, 200, { sha256: result.sha256, backupPath: result.backupPath });
    },
  };
}
