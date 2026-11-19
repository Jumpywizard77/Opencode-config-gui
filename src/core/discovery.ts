import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Discovery of OpenCode config files, following the layout OpenCode
 * documents: a global config under `~/.config/opencode` (XDG / APPDATA on
 * Windows), project configs at `opencode.json(c)` and
 * `.opencode/opencode.json(c)`, plus read-only system-wide and managed
 * directories.
 *
 * The module is pure: every filesystem read goes through the injected
 * `fsImpl` port and every platform/environment fact arrives via the input
 * object, so callers (the server layer, tests, a future desktop shell)
 * control side effects. The only eager node builtins here are `path` joins
 * and the `execFile` reference used as the default port of
 * `findOpencodeVersion`.
 */

export type ConfigKind = "global" | "project" | "system" | "managed";

export interface DiscoveredConfig {
  path: string;
  kind: ConfigKind;
  /** `false` for `system`/`managed`: v1 detects those read-only, never edits. */
  editable: boolean;
}

/** Filesystem port; the server layer passes `node:fs` itself. */
export type FsImpl = Pick<typeof import("node:fs"), "existsSync" | "readdirSync">;

/** Child-process port for `findOpencodeVersion` (promisified `execFile` shape). */
export type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

export interface DiscoverConfigsInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Project folder to scan; the app is launched per config target. */
  cwd: string;
  /** Optional second folder to scan (e.g. a user-picked probe folder). */
  probeFolder?: string;
  fsImpl?: FsImpl;
}

/** Candidate file names inside a config directory, in report order (.jsonc first). */
const CONFIG_FILE_NAMES = ["opencode.jsonc", "opencode.json"] as const;

const MANAGED_FILE_NAME = "managed.json";

const VERSION_PROBE_TIMEOUT_MS = 5_000;

const defaultFs: FsImpl = { existsSync, readdirSync };

const execFileAsync = promisify(execFile);

function pathModule(platform: NodeJS.Platform): typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Directory holding the global config. OpenCode documents the global config
 * as `~/.config/opencode/opencode.json(c)` on every platform (it does NOT
 * use `Library/Application Support` on macOS). Windows convention: prefer
 * `%APPDATA%`, falling back to `%USERPROFILE%\.config`; POSIX: prefer
 * `$XDG_CONFIG_HOME`, falling back to `$HOME/.config`. With neither
 * environment variable set we anchor at the literal `~` so the path stays
 * informative instead of throwing.
 */
function globalConfigDir(platform: NodeJS.Platform, env: DiscoverConfigsInput["env"]): string {
  const p = pathModule(platform);
  if (platform === "win32") {
    const base =
      env.APPDATA ?? (env.USERPROFILE !== undefined ? p.join(env.USERPROFILE, ".config") : "~");
    return p.join(base, "opencode");
  }
  const base =
    env.XDG_CONFIG_HOME ?? (env.HOME !== undefined ? p.join(env.HOME, ".config") : "~");
  return p.join(base, "opencode");
}

/** The documented default global config file (`.json` spelling). */
export function defaultGlobalConfigPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string {
  return pathModule(platform).join(globalConfigDir(platform, env), "opencode.json");
}

/** System-wide/managed config directory for the platform (`editable: false`). */
function systemConfigDir(platform: NodeJS.Platform, env: DiscoverConfigsInput["env"]): string {
  if (platform === "win32") {
    return path.win32.join(env.PROGRAMDATA ?? "C:\\ProgramData", "opencode");
  }
  if (platform === "darwin") {
    return "/Library/Application Support/opencode";
  }
  return "/etc/opencode";
}

function safeExists(fsImpl: FsImpl, candidate: string): boolean {
  try {
    return fsImpl.existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Find every OpenCode config file reachable from the input. Order: global,
 * then project (cwd root, cwd `.opencode`, then the same for `probeFolder`),
 * then system, then managed. Within one directory `opencode.jsonc` is
 * listed before `opencode.json`. Duplicate paths (e.g. `probeFolder` equal
 * to `cwd`) are reported once.
 */
export function discoverConfigs(input: DiscoverConfigsInput): DiscoveredConfig[] {
  const p = pathModule(input.platform);
  const fsImpl = input.fsImpl ?? defaultFs;

  const found: DiscoveredConfig[] = [];
  const seen = new Set<string>();
  const dedupeKey = (file: string): string => {
    const normalized = p.normalize(file);
    return input.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const push = (file: string, kind: ConfigKind, editable: boolean): void => {
    const key = dedupeKey(file);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: file, kind, editable });
  };

  // A missing or unreadable directory simply contributes nothing.
  const scanDir = (
    dir: string,
    names: readonly string[],
    kind: ConfigKind,
    editable: boolean,
  ): void => {
    let entries: string[];
    try {
      entries = fsImpl.readdirSync(dir).map(String);
    } catch {
      return;
    }
    const present = new Set(entries);
    for (const name of names) {
      if (present.has(name)) push(p.join(dir, name), kind, editable);
    }
  };

  scanDir(globalConfigDir(input.platform, input.env), CONFIG_FILE_NAMES, "global", true);

  const projectDirs = [input.cwd];
  if (
    input.probeFolder !== undefined &&
    dedupeKey(input.probeFolder) !== dedupeKey(input.cwd)
  ) {
    projectDirs.push(input.probeFolder);
  }
  // v1 deliberately scans ONLY the folders handed in (cwd and probeFolder).
  // There is NO upward walk toward the filesystem root: the app is launched
  // per config target chosen by the user, and ancestor-directory search is
  // a raw-tab concern for a later version. Do not "fix" this by adding a
  // parent-directory loop here.
  for (const dir of projectDirs) {
    scanDir(dir, CONFIG_FILE_NAMES, "project", true);
    const dotOpenCode = p.join(dir, ".opencode");
    if (safeExists(fsImpl, dotOpenCode)) {
      scanDir(dotOpenCode, CONFIG_FILE_NAMES, "project", true);
    }
  }

  const systemDir = systemConfigDir(input.platform, input.env);
  scanDir(systemDir, CONFIG_FILE_NAMES, "system", false);
  scanDir(systemDir, [MANAGED_FILE_NAME], "managed", false);

  return found;
}

/**
 * Best-effort `opencode --version`. Returns the version string (e.g.
 * "1.14.28") or `null` when the binary is missing, times out (5 s cap), or
 * prints something unversion-like. This function never throws.
 */
export async function findOpencodeVersion(
  execFileImpl?: ExecFileImpl,
): Promise<string | null> {
  const run: ExecFileImpl =
    execFileImpl ??
    ((file, args, options) => execFileAsync(file, [...args], options));
  try {
    const { stdout } = await run("opencode", ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    const match = String(stdout).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}
