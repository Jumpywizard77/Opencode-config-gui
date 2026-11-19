import type { PathLike } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  defaultGlobalConfigPath,
  discoverConfigs,
  findOpencodeVersion,
  type ExecFileImpl,
  type FsImpl,
} from "../../src/core/discovery";

/**
 * Hand-rolled fsImpl fake (deliberately memfs-free): a flat list of existing
 * file paths, comparable with `/` or `\` separators. The readdirSync cast is
 * needed because node's real one is a five-overload family that a plain
 * `(path) => string[]` fake cannot structurally satisfy.
 */
function fsFake(files: string[]): FsImpl {
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
    existsSync: (p: PathLike) => {
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

const LINUX_ENV = { HOME: "/home/me" };

describe("core/discovery", () => {
  describe("discoverConfigs", () => {
    it("discoverConfigs_withGlobalAndProjectFiles_shouldClassifyKindsAndEditability", () => {
      const found = discoverConfigs({
        platform: "linux",
        env: LINUX_ENV,
        cwd: "/work/proj",
        fsImpl: fsFake([
          "/home/me/.config/opencode/opencode.json",
          "/work/proj/opencode.jsonc",
          "/work/proj/.opencode/opencode.json",
        ]),
      });

      expect(found).toEqual([
        { path: "/home/me/.config/opencode/opencode.json", kind: "global", editable: true },
        { path: "/work/proj/opencode.jsonc", kind: "project", editable: true },
        { path: "/work/proj/.opencode/opencode.json", kind: "project", editable: true },
      ]);
    });

    it("discoverConfigs_withSystemDirFile_shouldReportReadOnly", () => {
      const found = discoverConfigs({
        platform: "linux",
        env: LINUX_ENV,
        cwd: "/work/proj",
        fsImpl: fsFake(["/etc/opencode/opencode.json", "/etc/opencode/managed.json"]),
      });

      expect(found).toEqual([
        { path: "/etc/opencode/opencode.json", kind: "system", editable: false },
        { path: "/etc/opencode/managed.json", kind: "managed", editable: false },
      ]);
    });

    it("discoverConfigs_prefersJsoncOverJsonInSameDirectory", () => {
      const found = discoverConfigs({
        platform: "linux",
        env: LINUX_ENV,
        cwd: "/work/proj",
        fsImpl: fsFake(["/work/proj/opencode.json", "/work/proj/opencode.jsonc"]),
      });

      expect(found.filter((c) => c.kind === "project").map((c) => c.path)).toEqual([
        "/work/proj/opencode.jsonc",
        "/work/proj/opencode.json",
      ]);
    });

    it("discoverConfigs_withProbeFolder_shouldScanItAlongsideCwd", () => {
      const files = ["/work/proj/opencode.json", "/other/folder/.opencode/opencode.jsonc"];
      const found = discoverConfigs({
        platform: "linux",
        env: LINUX_ENV,
        cwd: "/work/proj",
        probeFolder: "/other/folder",
        fsImpl: fsFake(files),
      });
      expect(found).toEqual([
        { path: "/work/proj/opencode.json", kind: "project", editable: true },
        { path: "/other/folder/.opencode/opencode.jsonc", kind: "project", editable: true },
      ]);

      // probeFolder duplicating cwd must not double-report the same file.
      const deduped = discoverConfigs({
        platform: "linux",
        env: LINUX_ENV,
        cwd: "/work/proj",
        probeFolder: "/work/proj",
        fsImpl: fsFake(files),
      });
      expect(deduped).toEqual([
        { path: "/work/proj/opencode.json", kind: "project", editable: true },
      ]);
    });

    it("discoverConfigs_onWindows_shouldFollowWindowsPathAndEnvConventions", () => {
      const found = discoverConfigs({
        platform: "win32",
        env: {
          APPDATA: "C:\\Users\\me\\AppData\\Roaming",
          PROGRAMDATA: "C:\\ProgramData",
        },
        cwd: "C:\\work\\proj",
        fsImpl: fsFake([
          "C:\\Users\\me\\AppData\\Roaming\\opencode\\opencode.jsonc",
          "C:\\work\\proj\\opencode.json",
          "C:\\ProgramData\\opencode\\opencode.json",
        ]),
      });

      expect(found).toEqual([
        {
          path: "C:\\Users\\me\\AppData\\Roaming\\opencode\\opencode.jsonc",
          kind: "global",
          editable: true,
        },
        { path: "C:\\work\\proj\\opencode.json", kind: "project", editable: true },
        { path: "C:\\ProgramData\\opencode\\opencode.json", kind: "system", editable: false },
      ]);
    });

    it("discoverConfigs_onDarwin_shouldScanLibraryApplicationSupport", () => {
      const found = discoverConfigs({
        platform: "darwin",
        env: LINUX_ENV,
        cwd: "/work/proj",
        fsImpl: fsFake(["/Library/Application Support/opencode/managed.json"]),
      });

      expect(found).toEqual([
        {
          path: "/Library/Application Support/opencode/managed.json",
          kind: "managed",
          editable: false,
        },
      ]);
    });

    it("discoverConfigs_withUnreadableSystemDir_shouldSkipItWithoutThrowing", () => {
      // A permission-blown readdir must degrade to "not found", never throw.
      const broken: FsImpl = {
        existsSync: () => true,
        readdirSync: (() => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }) as unknown as FsImpl["readdirSync"],
      };

      expect(
        discoverConfigs({
          platform: "linux",
          env: LINUX_ENV,
          cwd: "/work/proj",
          fsImpl: broken,
        }),
      ).toEqual([]);
    });
  });

  describe("defaultGlobalConfigPath", () => {
    it("defaultGlobalConfigPath_onWindows_withUserProfile_shouldUseWindowsConvention", () => {
      expect(defaultGlobalConfigPath("win32", { USERPROFILE: "C:\\Users\\me" })).toBe(
        "C:\\Users\\me\\.config\\opencode\\opencode.json",
      );
    });

    it("defaultGlobalConfigPath_onWindows_withAppData_shouldPreferAppData", () => {
      expect(
        defaultGlobalConfigPath("win32", {
          APPDATA: "C:\\Users\\me\\AppData\\Roaming",
          USERPROFILE: "C:\\Users\\me",
        }),
      ).toBe("C:\\Users\\me\\AppData\\Roaming\\opencode\\opencode.json");
    });

    it("defaultGlobalConfigPath_onLinux_withXdg_shouldPreferXdgConfigHome", () => {
      expect(defaultGlobalConfigPath("linux", { XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" })).toBe(
        "/xdg/opencode/opencode.json",
      );
    });

    it("defaultGlobalConfigPath_onDarwin_shouldUseHomeDotConfigNotLibrary", () => {
      // OpenCode documents `~/.config/opencode` on every platform; unlike
      // generic XDG apps it has no `Library/Application Support` global config.
      expect(defaultGlobalConfigPath("darwin", { HOME: "/Users/me" })).toBe(
        "/Users/me/.config/opencode/opencode.json",
      );
    });
  });

  describe("findOpencodeVersion", () => {
    it("findOpencodeVersion_withVersionOutput_shouldRunBoundedAndReturnParsedVersion", async () => {
      const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number } }> = [];
      const version = await findOpencodeVersion(async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: "1.14.28\n", stderr: "" };
      });

      expect(version).toBe("1.14.28");
      expect(calls).toEqual([{ file: "opencode", args: ["--version"], options: { timeout: 5000 } }]);
    });

    it("findOpencodeVersion_withFailingExecFile_shouldReturnNull", async () => {
      const version = await findOpencodeVersion(async () => {
        throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      });
      expect(version).toBeNull();
    });

    it("findOpencodeVersion_withSyncThrowingImpl_shouldReturnNull", async () => {
      const boom = (() => {
        throw new Error("port exploded synchronously");
      }) as unknown as ExecFileImpl;
      expect(await findOpencodeVersion(boom)).toBeNull();
    });

    it("findOpencodeVersion_withVersionlessOutput_shouldReturnNull", async () => {
      const version = await findOpencodeVersion(async () => ({
        stdout: "opencode: command not found\n",
        stderr: "",
      }));
      expect(version).toBeNull();
    });
  });
});
