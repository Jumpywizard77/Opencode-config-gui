import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../src/core/types";
import { computeUnifiedDiff, upgradeDocumentText } from "../../src/core/migrate";

type Obj = { [k: string]: JsonValue };

function obj(v: JsonValue | undefined): Obj {
  expect(v).toBeTypeOf("object");
  return v as Obj;
}

function readFixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

describe("core/migrate", () => {
  it("upgradeDocumentText_withV1Fixture_convertsToSchemaValidV2MatchingGoldenShape", () => {
    const text = readFixture("opencode.v1.sample.json");
    const v1 = obj(obj(JSON.parse(text).provider));
    const { text: out, report } = upgradeDocumentText(text);

    // Result is parseable JSON.
    const after = obj(JSON.parse(out) as JsonValue);

    // Provider block renamed; the v1 fixture has exactly these four providers.
    expect(after).not.toHaveProperty("provider");
    const providers = obj(after.providers);
    expect(Object.keys(providers).sort()).toEqual(["Basalt", "Maya", "Strata", "unsloth"]);

    for (const [id, raw] of Object.entries(providers)) {
      const p = obj(raw);
      expect(p.package).toBe("@opencode/ai/providers/openai-compatible");
      expect(p).not.toHaveProperty("npm");
      expect(p).not.toHaveProperty("options");
      expect(obj(p.settings).baseURL).toBeTypeOf("string");
      // v1 `name` carried over untouched.
      expect(p.name).toEqual(obj(v1[id]).name);
    }

    // Golden shape check: variants are arrays of exactly { id, settings },
    // content derived from the v1 fixture's own variants map (per controller
    // ruling — the golden only verifies the shape, not counts or values).
    const goldenProvider = obj(obj(obj(JSON.parse(readFixture("opencode.v2.golden.json")).providers).Maya));
    const goldenModel = obj(obj(goldenProvider.models)["Qwen3.8-Flash-Next"]);
    const goldenVariantKeys = Object.keys(obj((goldenModel.variants as JsonValue[])[0])).sort();
    for (const [pid, raw] of Object.entries(providers)) {
      const models = obj(obj(raw).models);
      for (const [mid, mraw] of Object.entries(models)) {
        const variants = obj(mraw).variants;
        expect(Array.isArray(variants)).toBe(true);
        const v1Variants = obj(obj(obj(obj(v1[pid]).models)[mid]).variants);
        expect(variants).toEqual(
          Object.entries(v1Variants).map(([id, settings]) => ({ id, settings })),
        );
        for (const entry of variants as JsonValue[]) {
          expect(Object.keys(obj(entry)).sort()).toEqual(goldenVariantKeys);
        }
      }
    }

    // mcp: flat entry moved under servers; `enabled: true` dropped (v2 default),
    // never re-written as `enabled`.
    const mcp = obj(after.mcp);
    expect(mcp).not.toHaveProperty("comfy-mcp");
    const comfy = obj(obj(mcp.servers)["comfy-mcp"]);
    expect(comfy.command).toEqual([
      "C:\\Users\\testuser\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\comfy-mcp.exe",
    ]);
    expect(comfy).not.toHaveProperty("enabled");
    expect(comfy.disabled ?? true).toBe(true); // dropped key => enabled polarity
    expect(comfy.environment).toEqual({
      COMFY_BIN: "C:\\tools\\comfy.exe",
      COMFY_LOCAL_URL: "http://127.0.0.1:8008",
    });

    // plugin → plugins, entries unchanged.
    expect(after).not.toHaveProperty("plugin");
    expect(after.plugins).toEqual(["superpowers@git+https://github.com/obra/superpowers.git"]);

    // Untouched keys survive.
    expect(after.$schema).toBe("https://opencode.ai/config.json");
    // Migrated keys keep the original key's position.
    expect(Object.keys(after)).toEqual(["$schema", "plugins", "providers", "mcp"]);

    expect(report.changes.length).toBeGreaterThanOrEqual(10);
    expect(report.leftUnchanged).toEqual([]);
  });

  it("upgradeDocumentText_withAlreadyV2Golden_shouldReturnUnchangedTextAndEmptyChanges", () => {
    const text = readFixture("opencode.v2.golden.json");
    const { text: out, report } = upgradeDocumentText(text);

    expect(out).toBe(text);
    expect(report).toEqual({ changes: [], leftUnchanged: [] });
  });

  it("upgradeDocumentText_withUnknownNpmPackage_shouldKeepValueAndRecordLeftUnchanged", () => {
    const text = JSON.stringify(
      { provider: { acme: { npm: "@acme/thing", options: { baseURL: "http://x/v1" } } } },
      null,
      2,
    );
    const { text: out, report } = upgradeDocumentText(text);

    const acme = obj(obj(obj(JSON.parse(out)).providers).acme);
    expect(acme.package).toBe("@acme/thing"); // value kept verbatim
    expect(acme).not.toHaveProperty("npm");
    expect(report.leftUnchanged).toContainEqual({
      path: "provider.acme.npm",
      reason: 'unrecognized package "@acme/thing" — value kept verbatim under "package"',
    });
  });

  it("upgradeDocumentText_withAgentKey_shouldLeaveUnchangedWithReason", () => {
    const doc = {
      agent: { build: { temperature: 0.5 } },
      plugin: ["x"],
    };
    const { text: out, report } = upgradeDocumentText(JSON.stringify(doc, null, 2));

    const after = obj(JSON.parse(out));
    expect(after.agent).toEqual(doc.agent); // never auto-migrated, not even renamed
    expect(after).not.toHaveProperty("agents");
    expect(report.leftUnchanged).toContainEqual({
      path: "agent",
      reason: "shape differs in v2 — edit in raw tab",
    });
    expect(report.changes.filter((line) => line.includes("agent"))).toEqual([]);
  });

  it("upgradeDocumentText_withV1Fixture_reportMatchesExpectFixture", () => {
    const { report } = upgradeDocumentText(readFixture("opencode.v1.sample.json"));
    const expected = JSON.parse(readFixture("upgrade-report.expect.json"));
    expect(report).toEqual(expected);
  });

  it("upgradeDocumentText_withDisabledMcpEntry_flipsEnabledFalseToDisabledTrue", () => {
    const { text: out, report } = upgradeDocumentText(
      JSON.stringify({ mcp: { tool: { type: "local", command: ["x"], enabled: false } } }, null, 2),
    );

    const tool = obj(obj(obj(obj(JSON.parse(out)).mcp).servers)["tool"]);
    expect(tool).not.toHaveProperty("enabled");
    expect(tool.disabled).toBe(true);
    expect(report.changes).toContain("mcp.servers.tool.enabled: false → disabled: true");
  });

  it("upgradeDocumentText_withScalarMcpTimeout_reshapesToExecutionObjectWithNote", () => {
    const { text: out, report } = upgradeDocumentText(JSON.stringify({ mcp: { timeout: 30 } }, null, 2));

    expect(obj(obj(JSON.parse(out)).mcp).timeout).toEqual({ execution: 30 });
    expect(report.changes).toContain("mcp.timeout 30 → { execution: 30 } (deprecated numeric form)");
    expect(report.leftUnchanged).toContainEqual({
      path: "mcp.timeout",
      reason: "numeric timeout reshaped to { execution } — verify the intended execution timeout",
    });
  });

  it("upgradeDocumentText_withMcpServersCollision_refusesMcpAndWarns", () => {
    const doc = {
      mcp: {
        servers: { tool: { command: ["kept"] } },
        tool: { command: ["would-clobber"] },
      },
    };
    const { text, report } = upgradeDocumentText(JSON.stringify(doc, null, 2));

    expect(text).toBe(JSON.stringify(doc, null, 2)); // nothing rewritten
    expect(report.changes).toEqual([]);
    expect(report.leftUnchanged[0]).toMatchObject({ path: "mcp" });
    expect(report.leftUnchanged[0].reason).toContain("collide");
  });

  it("upgradeDocumentText_withCommandAndReference_renamesTopLevelKeys", () => {
    const doc = { command: [{ name: "a" }], reference: { r: { path: "./x" } } };
    const { text: out, report } = upgradeDocumentText(JSON.stringify(doc, null, 2));

    const after = obj(JSON.parse(out));
    expect(after).not.toHaveProperty("command");
    expect(after).not.toHaveProperty("reference");
    expect(after.commands).toEqual(doc.command);
    expect(after.references).toEqual(doc.reference);
    expect(report.changes).toContain("command → commands (key renamed)");
    expect(report.changes).toContain("reference → references (key renamed)");
  });

  it("upgradeDocumentText_withPrototypeKeyNames_doesNotReadInheritedValues", () => {
    // `constructor` / `toString` are real Object.prototype members; lookups
    // against user documents and the package table must be own-property only.
    const { text: out, report } = upgradeDocumentText(
      JSON.stringify({ constructor: 1, provider: { p: { npm: "constructor" } }, toString: true }, null, 2),
    );

    const after = obj(JSON.parse(out));
    expect(after.constructor).toBe(1);
    expect(after.toString).toBe(true);
    expect(obj(obj(after.providers).p).package).toBe("constructor");
    expect(report.leftUnchanged).toContainEqual({
      path: "provider.p.npm",
      reason: 'unrecognized package "constructor" — value kept verbatim under "package"',
    });
    expect(report.changes.filter((line) => line.includes("constructor →"))).toEqual([]);
  });

  it("upgradeDocumentText_withNonObjectServersAndNumericTimeout_shouldRefuseAndPreserveServersValue", () => {
    const doc = { mcp: { servers: "x", timeout: 30 } };
    const { text, report } = upgradeDocumentText(JSON.stringify(doc, null, 2));

    expect(text).toBe(JSON.stringify(doc, null, 2)); // whole mcp left alone
    expect(obj(obj(JSON.parse(text)).mcp).servers).toBe("x"); // not silently replaced by {}
    expect(obj(obj(JSON.parse(text)).mcp).timeout).toBe(30); // refusal wins over timeout reshape
    expect(report.changes).toEqual([]);
    expect(report.leftUnchanged[0]).toMatchObject({ path: "mcp" });
    expect(report.leftUnchanged[0].reason).toContain("servers");
  });

  it("computeUnifiedDiff_withChangedLine_producesUnifiedPatch", () => {
    const patch = computeUnifiedDiff("a\nb\n", "a\nc\n");

    expect(patch).toContain("--- ");
    expect(patch).toContain("+++ ");
    expect(patch).toContain("-b");
    expect(patch).toContain("+c");
  });
});
