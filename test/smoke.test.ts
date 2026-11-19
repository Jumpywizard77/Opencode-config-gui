import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface FixtureShape {
  provider?: Record<string, { options?: { apiKey?: string } }>;
  mcp?: Record<string, { environment?: Record<string, string> }>;
}

function loadFixture(): FixtureShape {
  const raw = readFileSync(new URL("fixtures/opencode.v1.sample.json", import.meta.url), "utf8");
  return JSON.parse(raw) as FixtureShape;
}

describe("v1 sample fixture", () => {
  it("parses as JSON and has 4 providers", () => {
    const fixture = loadFixture();
    expect(Object.keys(fixture.provider ?? {})).toHaveLength(4);
  });

  it("is sanitized: apiKeys are placeholders, MCP env paths are placeholders", () => {
    const fixture = loadFixture();
    expect(fixture.provider?.["unsloth"]?.options?.apiKey).toBe("sk-test-unsloth");
    expect(fixture.provider?.["Strata"]?.options?.apiKey).toBe("sk-test-strata");
    expect(fixture.mcp?.["comfy-mcp"]?.environment?.["COMFY_BIN"]).toBe("C:\\tools\\comfy.exe");
  });
});
