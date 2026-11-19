import { describe, expect, it } from "vitest";

import { parseJsonc } from "../../src/core/jsonc";
import type { JsonValue } from "../../src/core/types";
import { editInText } from "../../src/ui/editor-path";
import {
  activeMcpType,
  collectMcpEntries,
  disabledToggleEdits,
  isEntryDisabled,
  isReservedMcpFlatKey,
  mcpEntryPath,
  mcpGlobalTimeoutForm,
  pickMcpContainer,
  renameMcpEdits,
  switchMcpTypeEdits,
  timeoutTrioEdits,
  validateMcpEntryName,
} from "../../src/ui/mcp-logic";

/**
 * Pure per-entry MCP path/polarity logic backing the MCP tab. The cardinal
 * rule these tests pin: the CONTAINER an entry lives in decides BOTH the
 * location edits target and the disable polarity — flat `mcp.<name>` entries
 * keep the legacy `enabled` key, `mcp.servers.<name>` entries use `disabled`.
 * The editor must never silently flip either.
 */

const LEGACY_DOC = `{
  "provider": { "Basalt": { "npm": "@ai-sdk/openai-compatible" } },
  "mcp": {
    // a comment the edits must not eat
    "timeout": 5000,
    "comfy-mcp": {
      "type": "local",
      "command": ["comfy-mcp.exe", "--stdio"],
      "enabled": false,
      "environment": { "COMFY_BIN": "C:\\\\tools\\\\comfy.exe" }
    }
  }
}
`;

const V2_DOC = `{
  "providers": {},
  "mcp": {
    "timeout": { "startup": 100, "execution": 5000 },
    "servers": {
      "sentry": { "type": "remote", "url": "https://mcp.sentry.dev/mcp", "disabled": true }
    }
  }
}
`;

function rootOf(text: string): { [k: string]: JsonValue } {
  const { value, errors } = parseJsonc(text);
  expect(errors).toEqual([]);
  return value as { [k: string]: JsonValue };
}

function mcpOf(text: string): { [k: string]: JsonValue } {
  return rootOf(text)["mcp"] as { [k: string]: JsonValue };
}

describe("collectMcpEntries", () => {
  it("collects flat entries and skips the global timeout key", () => {
    const entries = collectMcpEntries(rootOf(LEGACY_DOC));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ container: "flat", name: "comfy-mcp", notObject: false });
    expect(entries[0].value["enabled"]).toBe(false);
  });

  it("collects v2 servers entries alongside any flat leftovers", () => {
    const entries = collectMcpEntries(rootOf(V2_DOC));
    expect(entries).toEqual([
      expect.objectContaining({ container: "servers", name: "sentry" }),
    ]);
  });

  it("marks non-object entries as notObject with an empty value", () => {
    const doc = rootOf('{ "mcp": { "weird": 42 } }');
    const entries = collectMcpEntries(doc);
    expect(entries).toEqual([
      expect.objectContaining({ container: "flat", name: "weird", notObject: true, value: {} }),
    ]);
  });

  it("returns nothing without an mcp block, and skips a non-object servers block", () => {
    expect(collectMcpEntries(rootOf("{}"))).toEqual([]);
    expect(collectMcpEntries(rootOf('{ "mcp": { "servers": 7 } }'))).toEqual([]);
  });
});

describe("mcpEntryPath", () => {
  it("addresses flat entries under mcp and v2 entries under mcp.servers", () => {
    expect(mcpEntryPath("flat", "a b")).toEqual(["mcp", "a b"]);
    expect(mcpEntryPath("servers", "x")).toEqual(["mcp", "servers", "x"]);
  });
});

describe("pickMcpContainer (where NEW entries go)", () => {
  it("prefers an existing object-valued servers block", () => {
    expect(pickMcpContainer(rootOf(V2_DOC)["mcp"], "v2")).toBe("servers");
    // even a legacy-shaped doc that already keeps servers elsewhere goes to servers
    expect(pickMcpContainer({ servers: {} }, "v1")).toBe("servers");
  });

  it("prefers flat when flat entries already live there", () => {
    expect(pickMcpContainer(rootOf(LEGACY_DOC)["mcp"], "v1")).toBe("flat");
  });

  it("falls back to the doc shape when the mcp block is absent or timeout-only", () => {
    expect(pickMcpContainer(undefined, "v1")).toBe("flat");
    expect(pickMcpContainer(undefined, "v2")).toBe("servers");
    expect(pickMcpContainer({ timeout: 1 }, "v2")).toBe("servers");
    expect(pickMcpContainer({ timeout: 1 }, "v1")).toBe("flat");
  });
});

describe("activeMcpType", () => {
  it("reads the stored type, infers from url, defaults to local", () => {
    expect(activeMcpType({ type: "remote", url: "u" })).toBe("remote");
    expect(activeMcpType({ type: "local", command: [] })).toBe("local");
    expect(activeMcpType({ url: "u" })).toBe("remote");
    expect(activeMcpType({})).toBe("local");
  });
});

describe("disable polarity (never silently flipped)", () => {
  it("flat entries read/write the legacy `enabled` key", () => {
    const flat = { type: "local", command: [] as JsonValue[], enabled: false };
    expect(isEntryDisabled(flat, "flat")).toBe(true);
    expect(isEntryDisabled({ type: "local", command: [] }, "flat")).toBe(false);
    expect(disabledToggleEdits(["mcp", "x"], "flat", true)).toEqual([
      { path: ["mcp", "x", "enabled"], value: false },
    ]);
    // un-checking removes the marker (enabled is the implicit default) — it
    // must NOT write a `disabled` key.
    expect(disabledToggleEdits(["mcp", "x"], "flat", false)).toEqual([
      { path: ["mcp", "x", "enabled"], value: undefined },
    ]);
  });

  it("v2 servers entries read/write `disabled`", () => {
    expect(isEntryDisabled({ type: "remote", url: "u", disabled: true }, "servers")).toBe(true);
    expect(isEntryDisabled({ type: "remote", url: "u" }, "servers")).toBe(false);
    expect(disabledToggleEdits(["mcp", "servers", "x"], "servers", true)).toEqual([
      { path: ["mcp", "servers", "x", "disabled"], value: true },
    ]);
    expect(disabledToggleEdits(["mcp", "servers", "x"], "servers", false)).toEqual([
      { path: ["mcp", "servers", "x", "disabled"], value: undefined },
    ]);
  });

  it("end-to-end: toggling a legacy entry keeps the FLAT location and the enabled key", () => {
    const entry = collectMcpEntries(rootOf(LEGACY_DOC))[0];
    const text = editInText(
      LEGACY_DOC,
      disabledToggleEdits(mcpEntryPath(entry.container, entry.name), entry.container, false),
    );
    const comfy = mcpOf(text)["comfy-mcp"] as { [k: string]: JsonValue };
    expect(comfy["enabled"]).toBeUndefined();
    expect(comfy["disabled"]).toBeUndefined();
    expect(comfy["command"]).toEqual(["comfy-mcp.exe", "--stdio"]);
    // re-disabling writes enabled:false back at the SAME flat path
    const again = mcpOf(
      editInText(
        text,
        disabledToggleEdits(mcpEntryPath(entry.container, entry.name), entry.container, true),
      ),
    )["comfy-mcp"] as { [k: string]: JsonValue };
    expect(again["enabled"]).toBe(false);
    expect(again["disabled"]).toBeUndefined();
  });

  it("end-to-end: enabling a v2 servers entry clears `disabled` in place", () => {
    const entry = collectMcpEntries(rootOf(V2_DOC))[0];
    const text = editInText(
      V2_DOC,
      disabledToggleEdits(mcpEntryPath(entry.container, entry.name), entry.container, false),
    );
    const sentry = (mcpOf(text)["servers"] as { [k: string]: JsonValue })["sentry"] as {
      [k: string]: JsonValue;
    };
    expect(sentry["disabled"]).toBeUndefined();
    expect(sentry["enabled"]).toBeUndefined();
    expect(sentry["url"]).toBe("https://mcp.sentry.dev/mcp");
  });
});

describe("switchMcpTypeEdits", () => {
  it("to remote: sets type and drops local-only keys (command/cwd/environment)", () => {
    const edits = switchMcpTypeEdits(["mcp", "x"], "remote");
    expect(edits).toEqual([
      { path: ["mcp", "x", "type"], value: "remote" },
      { path: ["mcp", "x", "command"], value: undefined },
      { path: ["mcp", "x", "cwd"], value: undefined },
      { path: ["mcp", "x", "environment"], value: undefined },
    ]);
  });

  it("to local: sets type and drops remote-only keys (url/headers/oauth)", () => {
    const edits = switchMcpTypeEdits(["mcp", "servers", "x"], "local");
    expect(edits).toEqual([
      { path: ["mcp", "servers", "x", "type"], value: "local" },
      { path: ["mcp", "servers", "x", "url"], value: undefined },
      { path: ["mcp", "servers", "x", "headers"], value: undefined },
      { path: ["mcp", "servers", "x", "oauth"], value: undefined },
    ]);
  });

  it("end-to-end on the legacy entry: command/environment gone, enabled kept", () => {
    const text = editInText(
      LEGACY_DOC,
      switchMcpTypeEdits(["mcp", "comfy-mcp"], "remote"),
    );
    const comfy = mcpOf(text)["comfy-mcp"] as { [k: string]: JsonValue };
    expect(comfy["type"]).toBe("remote");
    expect(comfy["command"]).toBeUndefined();
    expect(comfy["environment"]).toBeUndefined();
    expect(comfy["enabled"]).toBe(false);
  });
});

describe("renameMcpEdits", () => {
  it("deletes the old key and re-creates the value under the new name", () => {
    const entry = collectMcpEntries(rootOf(LEGACY_DOC))[0];
    const value = entry.value;
    const text = editInText(
      LEGACY_DOC,
      renameMcpEdits(mcpEntryPath("flat", "comfy-mcp"), "comfy", value),
    );
    const mcp = mcpOf(text);
    expect(mcp["comfy-mcp"]).toBeUndefined();
    expect(mcp["comfy"]).toEqual(value);
  });
});

describe("global mcp.timeout", () => {
  it("reports the form of the global timeout", () => {
    expect(mcpGlobalTimeoutForm(rootOf(LEGACY_DOC)["mcp"])).toBe("numeric");
    expect(mcpGlobalTimeoutForm(rootOf(V2_DOC)["mcp"])).toBe("object");
    expect(mcpGlobalTimeoutForm({})).toBe("absent");
    expect(mcpGlobalTimeoutForm(undefined)).toBe("absent");
    expect(mcpGlobalTimeoutForm({ timeout: "soon" })).toBe("absent");
  });

  it("numeric form refuses trio edits (the Upgrade dialog owns that reshape)", () => {
    expect(timeoutTrioEdits(5000, "execution", "1000")).toEqual([]);
    expect(timeoutTrioEdits("soon", "execution", "1000")).toEqual([]);
  });

  it("sets one key of the trio, creating mcp.timeout when absent", () => {
    expect(timeoutTrioEdits(undefined, "execution", " 8000 ")).toEqual([
      { path: ["mcp", "timeout", "execution"], value: 8000 },
    ]);
    const current = rootOf(V2_DOC)["mcp"] as { [k: string]: JsonValue };
    expect(
      timeoutTrioEdits(current["timeout"], "startup", "200").map((e) => e.path).flat(),
    ).toEqual(["mcp", "timeout", "startup"]);
  });

  it("blank clears one key; clearing the last key deletes mcp.timeout itself", () => {
    const current = rootOf(V2_DOC)["mcp"] as { [k: string]: JsonValue };
    expect(timeoutTrioEdits(current["timeout"], "startup", "")).toEqual([
      { path: ["mcp", "timeout", "startup"], value: undefined },
    ]);
    expect(timeoutTrioEdits({ catalog: 3 }, "catalog", "")).toEqual([
      { path: ["mcp", "timeout"], value: undefined },
    ]);
    const text = editInText(V2_DOC, timeoutTrioEdits({ execution: 1 }, "execution", ""));
    expect(mcpOf(text)["timeout"]).toBeUndefined();
  });

  it("rejects non-positive-integer values with no edits", () => {
    expect(timeoutTrioEdits(undefined, "startup", "abc")).toEqual([]);
    expect(timeoutTrioEdits(undefined, "startup", "0")).toEqual([]);
    expect(timeoutTrioEdits(undefined, "startup", "-5")).toEqual([]);
    expect(timeoutTrioEdits(undefined, "startup", "1.5")).toEqual([]);
  });
});

describe("reserved flat entry names (add/rename guard)", () => {
  it("flags mcp.timeout and mcp.servers as reserved, exact-match after trim", () => {
    expect(isReservedMcpFlatKey("timeout")).toBe(true);
    expect(isReservedMcpFlatKey("servers")).toBe(true);
    expect(isReservedMcpFlatKey("  timeout  ")).toBe(true);
    expect(isReservedMcpFlatKey("Timeout")).toBe(false); // case matters: JSON keys are
    expect(isReservedMcpFlatKey("my-servers")).toBe(false);
    expect(isReservedMcpFlatKey("")).toBe(false);
  });

  it("validateMcpEntryName rejects reserved names in the FLAT container only", () => {
    for (const name of ["timeout", "servers", " servers "]) {
      expect(validateMcpEntryName("flat", name)).toMatch(/reserved name/i);
    }
    expect(validateMcpEntryName("flat", "comfy-mcp")).toBeNull();
    // names that would be structural keys up top are perfectly legal SERVER keys
    expect(validateMcpEntryName("servers", "timeout")).toBeNull();
    expect(validateMcpEntryName("servers", "servers")).toBeNull();
  });
});
