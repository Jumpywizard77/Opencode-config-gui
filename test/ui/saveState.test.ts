import { describe, expect, it } from "vitest";

import { applySavedToConfig, type CurrentConfig } from "../../src/ui/App";

/**
 * Pins the cross-config guard of `handleSaved` (the whole reduction, with
 * React state updates stripped out): a save whose response lands AFTER the
 * user switched to a different config must not stamp its text/sha256 onto
 * the other file's editor state.
 */

const configA = (overrides: Partial<CurrentConfig> = {}): CurrentConfig => ({
  path: "C:/project/a/opencode.json",
  text: "text-on-disk-A",
  sha256: "sha-A",
  issues: [{ path: "provider.x", message: "pre-existing" }],
  ...overrides,
});

describe("applySavedToConfig", () => {
  it("syncs text and sha256 when the save belongs to the open config", () => {
    const open = configA();
    const result = applySavedToConfig(open, {
      path: open.path,
      text: "text-saved-A",
      sha256: "sha-A-new",
    });
    expect(result).toEqual({
      path: open.path,
      text: "text-saved-A",
      sha256: "sha-A-new",
      issues: open.issues, // untouched: issues are only refreshed by a load
    });
    expect(result).not.toBe(open);
  });

  it("returns the open config UNCHANGED (same reference) when the save is for another path", () => {
    // The race the review caught: A saves, the user switches to B, A's
    // response arrives — B must be returned byte-identical.
    const openB = configA({ path: "C:/project/b/opencode.json", text: "B", sha256: "sha-B" });
    const result = applySavedToConfig(openB, {
      path: "C:/project/a/opencode.json",
      text: "stamped-from-A",
      sha256: "sha-A",
    });
    expect(result).toBe(openB);
  });

  it("passes through null (no config open)", () => {
    expect(applySavedToConfig(null, { path: "x", text: "t", sha256: "s" })).toBeNull();
  });
});
