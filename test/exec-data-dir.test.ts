import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { execDataDir } from "../src/exec-data-dir.js";

/**
 * The shared anchor for every executable-relative shipped-data candidate
 * (`static-dir.ts`, `core/schema.ts`). The contract that got both release
 * binaries booting with "no built UI found" when it was broken: `execPath`
 * is the executable FILE, so the helper must return its DIRECTORY.
 */
describe("execDataDir", () => {
  it("returns the directory CONTAINING the executable file (release-binary layout)", () => {
    const exeDir = join("release", "opencode-config-gui-windows-x64");
    const exeFile = join(exeDir, "opencode-config-gui.exe");
    expect(execDataDir(exeFile)).toBe(exeDir);
  });

  it("returns the node binary's directory for a plain-node invocation", () => {
    expect(execDataDir(join("/usr", "local", "bin", "node"))).toBe(join("/usr", "local", "bin"));
  });

  it("defaults to the directory of process.execPath", () => {
    expect(execDataDir()).toBe(dirname(process.execPath));
  });
});
