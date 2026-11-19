import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// A fake RELEASE LAYOUT: the executable is a FILE, and the archive ships its
// `dist/ui` as a SIBLING of that file (see .github/workflows/release.yml).
// Passing the file (not a directory) here is what pins the executable-file →
// dirname semantics — joining `dist/ui` onto the file path itself was a bug
// every release binary would have shipped with.
const fakeExecDir = join(tempRoot, "release", "opencode-config-gui-windows-x64");
const fakeExecFile = join(fakeExecDir, "opencode-config-gui.exe");
mkdirSync(join(fakeExecDir, "dist", "ui"), { recursive: true });
writeFileSync(fakeExecFile, "not a real binary, just a path anchor\n");
const fakeExecUi = join(fakeExecDir, "dist", "ui");

/** Only the executable's sibling dist/ui "exists" in this scenario. */
const onlyExecUi = (path: string): boolean => path === fakeExecUi;

describe("static dir candidate ladder", () => {
  it("--static is the only candidate, taken verbatim (resolved absolute)", () => {
    const flagPath = resolve(join(tempRoot, "somewhere", "ui"));
    const candidates = staticDirCandidates(flagPath, {
      importMetaUrl: packageAnchor,
      execPath: fakeExecFile,
    });
    expect(candidates).toEqual([flagPath]);
  });

  it("package-root candidate comes first, executable-relative second", () => {
    const candidates = staticDirCandidates(undefined, {
      importMetaUrl: packageAnchor,
      execPath: fakeExecFile,
    });
    expect(candidates).toEqual([join(tempRoot, "pkg", "dist", "ui"), fakeExecUi]);
  });

  it("the executable-relative candidate is a SIBLING of the executable file, never inside it", () => {
    // The Bun-compiled binary IS the execPath file; the shipped `dist/ui`
    // sits next to it. This pins the release-archive layout exactly.
    const candidates = staticDirCandidates(undefined, {
      importMetaUrl: "bunfs:///root/index.js",
      execPath: fakeExecFile,
    });
    expect(candidates).toEqual([fakeExecUi]);
    expect(candidates[0]).not.toContain("opencode-config-gui.exe");
  });

  it("a bunfs:/// anchor (Bun compiled binary) contributes NO candidate instead of throwing", () => {
    const candidates = staticDirCandidates(undefined, {
      importMetaUrl: "bunfs:///root/index.js",
      execPath: fakeExecFile,
    });
    expect(candidates).toEqual([fakeExecUi]);
  });

  it("resolveStaticDir falls through to the executable-relative dir when the package-root one is absent", () => {
    expect(
      resolveStaticDir(undefined, {
        importMetaUrl: "bunfs:///root/index.js",
        execPath: fakeExecFile,
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
        execPath: fakeExecFile,
        exists: both,
      }),
    ).toBe(join(tempRoot, "pkg", "dist", "ui"));
  });

  it("resolveStaticDir returns undefined for a --static path that does not exist", () => {
    expect(
      resolveStaticDir(join(tempRoot, "nope"), {
        importMetaUrl: packageAnchor,
        execPath: fakeExecFile,
        exists: onlyExecUi,
      }),
    ).toBeUndefined();
  });
});
