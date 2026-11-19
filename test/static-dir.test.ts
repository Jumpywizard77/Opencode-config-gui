import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { resolveStaticDir, staticDirCandidates } from "../src/static-dir.js";

const tempRoot = mkdtempSync(join(tmpdir(), "ocg-static-"));
afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// A fake <package>/dist/cli.js location: the ".." anchor resolves to <root>.
const packageAnchor = pathToFileURL(join(tempRoot, "pkg", "dist", "cli.js")).href;
// A fake node executable location whose dist/ui actually exists.
const fakeExecDir = join(tempRoot, "fake-exec");
mkdirSync(join(fakeExecDir, "dist", "ui"), { recursive: true });
const fakeExecUi = join(fakeExecDir, "dist", "ui");

/** Only the fake executable's dist/ui "exists" in this scenario. */
const onlyExecUi = (path: string): boolean => path === fakeExecUi;

describe("static dir candidate ladder", () => {
  it("--static is the only candidate, taken verbatim (resolved absolute)", () => {
    const flagPath = resolve(join(tempRoot, "somewhere", "ui"));
    const candidates = staticDirCandidates(flagPath, {
      importMetaUrl: packageAnchor,
      execPath: fakeExecDir,
    });
    expect(candidates).toEqual([flagPath]);
  });

  it("package-root candidate comes first, executable-relative second", () => {
    const candidates = staticDirCandidates(undefined, {
      importMetaUrl: packageAnchor,
      execPath: fakeExecDir,
    });
    expect(candidates).toEqual([join(tempRoot, "pkg", "dist", "ui"), fakeExecUi]);
  });

  it("a bunfs:/// anchor (Bun compiled binary) contributes NO candidate instead of throwing", () => {
    const candidates = staticDirCandidates(undefined, {
      importMetaUrl: "bunfs:///root/index.js",
      execPath: fakeExecDir,
    });
    expect(candidates).toEqual([fakeExecUi]);
  });

  it("resolveStaticDir falls through to the executable-relative dir when the package-root one is absent", () => {
    expect(
      resolveStaticDir(undefined, {
        importMetaUrl: "bunfs:///root/index.js",
        execPath: fakeExecDir,
        exists: onlyExecUi,
      }),
    ).toBe(fakeExecUi);
  });

  it("resolveStaticDir prefers the package-root dir when both exist", () => {
    const both = (path: string): boolean =>
      path === join(tempRoot, "pkg", "dist", "ui") || path === fakeExecUi;
    expect(
      resolveStaticDir(undefined, {
        importMetaUrl: packageAnchor,
        execPath: fakeExecDir,
        exists: both,
      }),
    ).toBe(join(tempRoot, "pkg", "dist", "ui"));
  });

  it("resolveStaticDir returns undefined for a --static path that does not exist", () => {
    expect(
      resolveStaticDir(join(tempRoot, "nope"), {
        importMetaUrl: packageAnchor,
        execPath: fakeExecDir,
        exists: onlyExecUi,
      }),
    ).toBeUndefined();
  });
});
