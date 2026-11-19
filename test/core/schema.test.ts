import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSchema, validateConfigText, type SchemaSource } from "../../src/core/schema";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

function readBundledSchema(): object {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL("../../src/core/schema-bundled.json", import.meta.url)), "utf8"),
  ) as object;
}

/** The vendored schema, presented as the validator sees it when `loadSchema` falls back. */
const bundledSource: SchemaSource = {
  schema: readBundledSchema(),
  source: "bundled",
  fetchedAt: "bundled",
};

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "ocg-schema-"));
}

describe("core/schema", () => {
  it("validateConfigText_withInlineBogusRootText_shouldReportUnknownTopLevelKeyIssues", () => {
    // Brief fallback branch, and it is the one the live schema enforces: the
    // deprecated v1 keys (`provider`, `mcp`, `plugin`, …) are still fully
    // defined in opencode.ai/config.json, so the v1 fixture validates cleanly
    // (deprecated is an annotation, never an error). Unknown top-level keys
    // are what the root `additionalProperties: false` actually rejects.
    const issues = validateConfigText(
      JSON.stringify({ $schema: "https://opencode.ai/config.json", bogus_root: 1 }, null, 2),
      bundledSource,
    );
    expect(issues.some((issue) => issue.path === "bogus_root")).toBe(true);

    // ...and the v1 sample must stay issue-free for exactly that reason.
    expect(validateConfigText(readFixture("opencode.v1.sample.json"), bundledSource)).toEqual([]);
  });

  it("validateConfigText_withGoldenV2Text_shouldReturnNoIssues", () => {
    expect(validateConfigText(readFixture("opencode.v2.golden.json"), bundledSource)).toEqual([]);
  });

  it("validateConfigText_withWrongTypeInNestedField_shouldReportIssueAtExactPath", () => {
    // The brief sketched `settings.baseURL` as the wrong-typed field, but the
    // current live schema types provider `settings.*` permissively
    // (`additionalProperties: anyOf [{}, null]`), so no error is possible
    // there. `limit.context` is an equally nested v2 field the schema does
    // enforce (integer), so it carries the exact-path assertion instead.
    const doc = JSON.parse(readFixture("opencode.v2.golden.json"));
    doc.providers.Maya.models["Qwen3.8-Flash-Next"].limit.context = "131072";
    const issues = validateConfigText(JSON.stringify(doc, null, 2), bundledSource);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("providers.Maya.models.Qwen3.8-Flash-Next.limit.context");
    expect(issues[0]!.message).toContain("integer");
  });

  it("loadSchema_withUnreachableRemote_shouldFallBackToBundled", async () => {
    const cacheDir = tempCacheDir();
    const result = await loadSchema({
      refresh: true,
      cacheDir,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.source).toBe("bundled");
    expect(result.fetchedAt).toBe("bundled");
    expect((result.schema as { $id?: string }).$id).toBe("https://opencode.ai/config.json");
  });

  it("loadSchema_withSuccessfulRefresh_shouldReturnRemoteAndWriteCache", async () => {
    const cacheDir = tempCacheDir();
    const schema = readBundledSchema();
    const fetchImpl = (async () => ({ ok: true, json: async () => schema })) as unknown as typeof fetch;

    const result = await loadSchema({ refresh: true, cacheDir, fetchImpl });
    expect(result.source).toBe("remote");
    expect(result.fetchedAt).not.toBe("bundled");
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
    expect(result.schema).toEqual(schema);

    const cacheFile = join(cacheDir, "config-schema.json");
    expect(existsSync(cacheFile)).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toMatchObject({ schema });
  });

  it("loadSchema_withWarmCacheAndNoRefresh_shouldServeCacheWithoutFetching", async () => {
    const cacheDir = tempCacheDir();
    const schema = readBundledSchema();
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => schema };
    }) as unknown as typeof fetch;

    const refreshed = await loadSchema({ refresh: true, cacheDir, fetchImpl });
    const cached = await loadSchema({ cacheDir, fetchImpl });
    expect(fetchCalls).toBe(1);
    expect(cached.source).toBe("remote");
    expect(cached.fetchedAt).toBe(refreshed.fetchedAt);
  });

  it("loadSchema_withMissingBundledFile_shouldFallBackToPermissiveSchemaWithoutThrowing", async () => {
    // Last rung of the ladder: a packaged copy that is absent (e.g. dist/
    // packaging forgot the JSON) must degrade to a permissive `{}` schema,
    // never throw. The degraded provenance keeps `source: 'bundled'` but a
    // distinct `fetchedAt` sentinel, so a `{}` validator can never masquerade
    // as the real vendored copy in the fetchedAt-keyed validator cache.
    const cacheDir = tempCacheDir();
    const result = await loadSchema({
      refresh: true,
      cacheDir,
      fetchImpl: async () => {
        throw new Error("network down");
      },
      bundledPath: join(cacheDir, "absent-bundled-copy.json"),
    });
    expect(result.source).toBe("bundled");
    expect(result.fetchedAt).toBe("bundled-missing");
    expect(result.schema).toEqual({});

    // Documented degradation: validation against `{}` becomes a permissive
    // no-op rather than an error.
    expect(validateConfigText(JSON.stringify({ bogus_root: 1, nonsense: [1, 2] }), result)).toEqual([]);
  });

  it("loadSchema_withCorruptCacheFile_shouldFallBackToBundled", async () => {
    const cacheDir = tempCacheDir();
    writeFileSync(join(cacheDir, "config-schema.json"), "{not json");
    const result = await loadSchema({
      refresh: true,
      cacheDir,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.source).toBe("bundled");
    expect(result.fetchedAt).toBe("bundled");
    expect((result.schema as { $id?: string }).$id).toBe("https://opencode.ai/config.json");
  });

  it("loadSchema_withNonOkHttpResponse_shouldFallBackToCacheOrBundled", async () => {
    const cacheDir = tempCacheDir();
    const notFound = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;

    // Cold cache: a 404 walks all the way down to the bundled copy.
    const cold = await loadSchema({ refresh: true, cacheDir, fetchImpl: notFound });
    expect(cold.source).toBe("bundled");

    // Warm cache: after one good refresh, a failing refresh serves the cache.
    const schema = readBundledSchema();
    const ok = (async () => ({ ok: true, json: async () => schema })) as unknown as typeof fetch;
    const warmed = await loadSchema({ refresh: true, cacheDir, fetchImpl: ok });
    const stale = await loadSchema({ refresh: true, cacheDir, fetchImpl: notFound });
    expect(stale.source).toBe("remote");
    expect(stale.fetchedAt).toBe(warmed.fetchedAt);
  });
});
