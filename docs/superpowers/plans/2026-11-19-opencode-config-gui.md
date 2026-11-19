# opencode-config-gui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shareable, terminal-launched (`npx opencode-config-gui`) local web app for editing OpenCode v2 config files, with deep provider/MCP editors, endpoint model probing, schema-validated saves, and a reviewable v1→v2 upgrade.

**Architecture:** Three layers in one npm package: `src/core/` (pure TypeScript: JSONC editing, migration rules, schema validation, discovery, endpoint probe — no framework imports), `src/server/` (thin `node:http` glue owning filesystem and network side effects), `src/ui/` (Vite + React SPA served as static assets). A future desktop shell wraps `core/` unchanged.

**Tech Stack:** TypeScript (strict), Node ≥ 20, `jsonc-parser` (surgical comment-preserving edits), `ajv` (JSON Schema), `diff` (unified diffs), React 18 + Vite, vitest. No native dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-opencode-config-gui-design.md`

## Global Constraints

- Node >= 20; `npx opencode-config-gui` must work on Windows/macOS/Linux with no native build steps (no node-gyp).
- TypeScript strict mode everywhere in `src/` and `test/`.
- All config parsing/printing is JSONC-aware (comments, trailing commas legal).
- Server binds `127.0.0.1` only; API validates `Origin`/`Host`; no CORS headers on `/api/*`.
- Only permitted outbound network calls: HTTPS GET of `https://opencode.ai/config.json` (schema) and user-triggered probe requests to user-typed URLs. No analytics. API keys never appear in server logs or probe error details.
- Repo-root `opencode.json` is the partner's live local config: git-ignored and npm-excluded, never committed or packaged. Tests use `test/fixtures/opencode.v1.sample.json` (sanitized) and `test/fixtures/opencode.v2.golden.json` (spike-verified).
- Every save writes a timestamped backup `*.bak-YYYYMMDD-HHmmss` first, then atomic write (temp file + rename in same directory).
- Saves blocked only by newly introduced validation errors; pre-existing issues become warnings.
- Commit after every task; conventional commit messages.

## Review Focus

- **Already-invalid config file:** saving edits to an untouched section succeeds; untouched-section schema errors surface as warnings, never as a save block. → tested in Task 8 (`save_withPreExistingError_...`).
- **File changed on disk while open:** a save whose `baseSha256` no longer matches disk returns `409 stale`; the UI must not silently overwrite. → tested in Task 8 (`save_withStaleBaseSha256_...`).
- **Probe endpoint dead / slow / behind auth:** `probeModels` resolves within ~10 s with a classified `ProbeResult`; error `detail` never contains the API key or its value. → tested in Task 7 (three probe tests).
- **Awkward bytes (BOM, CRLF, comments, trailing commas):** a structured edit leaves untouched regions byte-identical. → tested in Task 3 (`applyPathEdits_withAwkwardBytes_...`) and Task 8 round-trip test.
- **Offline first run:** remote schema fetch failure falls back to the bundled schema copy; `GET /api/state` reports `schemaSource: "bundled"` and all endpoints keep working. → tested in Task 5 (`loadSchema_withUnreachableRemote_...`) and Task 9 (`state_reportsSchemaSourceBundled_...`).

---

### Task 1: Project scaffold and fixtures

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `vite.config.ts`, `.gitignore`, `.npmrc`, `test/fixtures/opencode.v1.sample.json`, `test/smoke.test.ts`
- Copy: repo-root `opencode.json` → `test/fixtures/opencode.v1.sample.json` (sanitized, see Step 2)

**Interfaces:**
- Consumes: nothing.
- Produces: buildable TS project; `npm test` (vitest), `npm run typecheck` (tsc --noEmit); npm name `opencode-config-gui` with `"type": "module"`, `"bin": {"opencode-config-gui": "dist/cli.js"}`; deps `jsonc-parser`, `ajv`, `diff`, `react`, `react-dom`; devDeps `typescript`, `vitest`, `vite`, `@vitejs/plugin-react`, `@types/node`, `@types/react`, `@types/react-dom`; fixture `test/fixtures/opencode.v1.sample.json`.

- [ ] **Step 1: `git init`, write `.gitignore` first** containing `node_modules/`, `dist/`, `opencode.json` (the partner's live config — this line goes in before the first commit, no exceptions), then `npm init -y` and edit `package.json` to the fields in Interfaces. Scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"build": "tsc -p tsconfig.build.json && vite build"`, `"dev:ui": "vite"`, `"dev:server": "node --watch dist/cli.js --no-open"`.
- [ ] **Step 2: Create `test/fixtures/opencode.v1.sample.json`** from the root `opencode.json` with every `apiKey` value replaced by `"sk-test-<providername>"` (e.g. `"sk-test-basalt"`), MCP `environment` paths replaced by `"C:\\tools\\comfy-mcp.exe"` style placeholders, and nothing else changed. Verify `git check-ignore -q opencode.json && echo ignored` prints `ignored`.
- [ ] **Step 3: Write `test/smoke.test.ts`** asserting the sample fixture parses via `JSON.parse` and has 4 providers under its `provider` key (proves fixture sanity and the v1 shape).
- [ ] **Step 4: Run** `npm install && npm run typecheck && npm test` — expect 1 passing test.
- [ ] **Step 5: Commit** `feat: project scaffold with sanitized v1 fixture`

### Task 2: Runtime spike — verified v2 provider shape (manual, partner machine)

**Files:**
- Create: `test/fixtures/opencode.v2.golden.json` (the spike-verified v2 form of the Maya provider block, embedded in a minimal doc with `$schema` and `model` keys), `docs/superpowers/plans/spike-notes.md`

**Interfaces:**
- Consumes: partner's OpenCode 2.2.7 and the live Maya endpoint (`http://127.0.0.1:8080/v1`).
- Produces: the golden v2 provider shape that Task 4's migration tests assert; records whether `@opencode/ai/providers/openai-compatible` + `variants: [{id, settings: {reasoningEffort}}]` work, or what actually did.

- [ ] **Step 1: Write a spike config** containing the hand-converted Maya provider:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "Maya": {
      "name": "Maya (local)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8080/v1" },
      "models": {
        "glm-5.3-flash": {
          "name": "Maya GLM-5.3-Flash (local)",
          "limit": { "context": 131072, "output": 60000 },
          "variants": [
            { "id": "high",   "settings": { "reasoningEffort": "high" } },
            { "id": "medium", "settings": { "reasoningEffort": "medium" } },
            { "id": "low",    "settings": { "reasoningEffort": "low" } },
            { "id": "none",   "settings": { "reasoningEffort": "none" } }
          ]
        }
      }
    }
  },
  "model": "Maya/glm-5.3-flash"
}
```

- [ ] **Step 2: Point the partner's OpenCode at it** (e.g. run `opencode` in a scratch folder containing this as `opencode.json`) and verify: provider initializes, `Maya/glm-5.3-flash` selectable, `#high` / `#low` variants listed by `/models`, a chat completes, and reasoning effort visibly changes.
- [ ] **Step 3: If the Step 1 shape fails, iterate on the partner's machine** (candidates: `body` instead of `settings` in variants; `capabilities.reasoning` with `effort`/`toggle`) until variants demonstrably work. Record findings in `spike-notes.md`. **If no working shape is found, stop and report** — do not guess; the spec's anti-goal (config that misbehaves) outranks schedule.
- [ ] **Step 4: Commit the verified block as `test/fixtures/opencode.v2.golden.json`** and commit `docs: spike result — verified v2 variants/package shape`.

### Task 3: core/jsonc.ts — surgical JSONC editing

**Files:**
- Create: `src/core/types.ts`, `src/core/jsonc.ts`, `test/core/jsonc.test.ts`

**Interfaces:**
- Consumes: nothing (wraps `jsonc-parser`).
- Produces:
  - `type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }`
  - `interface Issue { path: string; message: string }` (`path` = dot/bracket path, e.g. `providers.Maya.settings.baseURL`)
  - `interface PathEdit { path: (string | number)[]; value: JsonValue | undefined }` (`undefined` deletes)
  - `parseJsonc(text: string): { value: JsonValue | undefined; errors: Issue[] }`
  - `applyPathEdits(text: string, edits: PathEdit[]): string` — applies all edits via `jsonc-parser` `modify`/`applyEdits` against the *original* text (re-resolve offsets after each edit by applying them in reverse path-depth order)

- [ ] **Step 1: Write failing `test/core/jsonc.test.ts`** with:
  - `applyPathEdits_setsNestedValue_shouldPreserveCommentsAndUntouchedRegionsByteIdentical` — fixture-shaped JSONC text with `// comment` above one provider; set another provider's `settings.baseURL`; assert comments survive and every line outside the edited provider's block is unchanged.
  - `applyPathEdits_withAwkwardBytes_shouldPreserveBomCrlfAndTrailingCommasOutsideEdits` — input starts `\uFEFF`, uses CRLF, has a trailing comma; after edit: BOM still at position 0, CRLF count unchanged outside the edited line, file still parses via `parseJsonc` with `errors.length === 0`-tolerant check (trailing comma may warn, must not error).
  - `applyPathEdits_deletesPath_shouldRemoveKeyOnly` (`value: undefined`).
  - `parseJsonc_withTrailingComma_returnsValueAndNoHardErrors`.
- [ ] **Step 2: Run** `npx vitest run test/core/jsonc.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/core/types.ts` and `src/core/jsonc.ts`. Approach: `parseJsonc` = `jsonc` `parse` with collected `ParseError[]` mapped to `Issue` (position → line, dot-path via `jsonc` `getNodeFromPosition` where available, else positional message). `applyPathEdits`: for each edit call `modify(text, edit.path, edit.value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })` recomputing from the running text, edits sorted so deeper/later paths are applied against stable offsets (simplest correct approach: apply one at a time to the running text).
- [ ] **Step 4: Run tests — expect PASS.** Also `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: comment-preserving JSONC path editing`

### Task 4: core/migrate.ts — v1→v2 upgrade rules

**Files:**
- Create: `src/core/migrate.ts`, `test/core/migrate.test.ts`, `test/fixtures/upgrade-report.expect.json` (created in Step 3)
- Modify: `package.json` (add `diff` dep if not present)

**Interfaces:**
- Consumes: Task 3 `JsonValue`, `parseJsonc`.
- Produces:
  - `interface MigrationReport { changes: string[]; leftUnchanged: { path: string; reason: string }[] }`
  - `upgradeDocumentText(text: string): { text: string; report: MigrationReport }` — pure text→text on the whole document (documented rules below); already-v2 documents return `report.changes: []` unchanged text.
  - `computeUnifiedDiff(before: string, after: string): string` (wraps `diff`'s `createTwoFilesPatch` with empty filenames)

Documented migration rules (per spec Goal 7):
1. `provider` → `providers`; per provider: `npm` → `package` (value rewritten via table below), `options` → `settings` (contents move), `models.<id>.variants` map `{id: opts}` → array `[{ id, settings: opts }]` (golden Task 2 shape), drop the now-invalid `options`/`npm` keys.
2. Package value table: `@ai-sdk/openai-compatible` → `@opencode/ai/providers/openai-compatible`; `@ai-sdk/openai` → `@opencode/ai/providers/openai`; `@ai-sdk/anthropic` → `@opencode/ai/providers/anthropic`; `@ai-sdk/google` / `@ai-sdk/google-vertex` → `@opencode/ai/providers/google` / `@opencode/ai/providers/google-vertex`; unknown values kept verbatim + pushed to `leftUnchanged`.
3. `plugin` → `plugins` (entries unchanged).
4. Flat `mcp` entries (every key except `servers`/`timeout`) move under `mcp.servers`; per entry: `enabled: false` → `disabled: true`, `enabled: true` → key dropped; scalar `mcp.timeout` (deprecated number) → `mcp.timeout: { execution: <n> }` + note in `leftUnchanged`; existing `mcp.servers` entries merge (error path: refuse to upgrade with a `MigrationReport` warning rather than clobber).
5. `command` → `commands`, `reference` → `references` (mechanical key renames).
6. `agent` → `agents`: **never auto-migrated** (field shapes differ; spec allows leaving ambiguous keys) — reported in `leftUnchanged` with reason `"shape differs in v2 — edit in raw tab"`.
7. Every removed key and every rewrite appends a human line to `changes` (e.g. `"provider.Maya.npm → package (@ai-sdk/... → @opencode/ai/providers/openai-compatible)"`).

- [ ] **Step 1: Write failing `test/core/migrate.test.ts`**:
  - `upgradeDocumentText_withV1Fixture_convertsToSchemaValidV2MatchingGoldenShape` — load `opencode.v1.sample.json` text, run `upgradeDocumentText`, feed result to `JSON.parse`, assert: 4 providers under `providers`, every `package` equals `@opencode/ai/providers/openai-compatible`, every provider has `settings.baseURL` and no `options`/`npm` keys, Maya's model `variants` deep-equals the Task 2 golden array shape, `mcp.servers['comfy-mcp'].command` present with `disabled` polarity, `plugins` is an array, `report.changes.length >= 10`.
  - `upgradeDocumentText_withAlreadyV2Golden_shouldReturnUnchangedTextAndEmptyChanges`.
  - `upgradeDocumentText_withUnknownNpmPackage_shouldKeepValueAndRecordLeftUnchanged` — tiny inline doc with `"npm": "@acme/thing"`.
  - `upgradeDocumentText_withAgentKey_shouldLeaveUnchangedWithReason`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `upgradeDocumentText` per the rule list (operate on `JsonValue` parsed from text, rebuild object preserving key order: emit migrated keys at the original key's position). Write `computeUnifiedDiff` one-liner over `diff.createTwoFilesPatch`. Save the fixture's actual `report` to `test/fixtures/upgrade-report.expect.json` and add a snapshot-style assertion comparing to it.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat: v1-to-v2 config migration with review report`

### Task 5: core/schema.ts — schema fetch, cache, validation

**Files:**
- Create: `src/core/schema.ts`, `src/core/schema-bundled.json` (vendored copy of `https://opencode.ai/config.json` at commit time), `test/core/schema.test.ts`

**Interfaces:**
- Consumes: Task 3 `Issue`, `parseJsonc`.
- Produces:
  - `interface SchemaSource { schema: object; source: 'bundled' | 'remote'; fetchedAt: string }` (`fetchedAt` = `"bundled"` for the vendored copy)
  - `loadSchema(opts?: { refresh?: boolean; fetchImpl?: typeof fetch }): Promise<SchemaSource>` — cache dir `~/.cache/opencode-config-gui/config-schema.json`; refresh failure falls back to cache, then bundled copy; never throws.
  - `validateConfigText(text: string, schema: SchemaSource): Issue[]` — parse via `parseJsonc` (parse errors → Issues) then ajv-validate; ajv options `{ strict: false, allErrors: true, verbose: false }`; remote `$ref` (`https://models.dev/model-schema.json#/$defs/Model`) pre-stubbed as `{}`; ajv errors mapped to `Issue` with dot-paths; `deprecated: true` schema nodes are ignored (validation only, warnings are the raw tab's business).

- [ ] **Step 1: Write failing `test/core/schema.test.ts`**:
  - `validateConfigText_withV1FixtureText_shouldReportUnknownTopLevelKeyIssues` — v1 sample against live schema copy: expect an Issue whose `path` mentions `provider` (deprecated key still validates as deprecated-but-present — assert `additionalProperties` violations for keys the schema lacks entirely, using an inline doc with `"bogus_root": 1` if the deprecated-key assertion proves flaky; keep whichever the schema actually enforces and note it in the test name).
  - `validateConfigText_withGoldenV2Text_shouldReturnNoIssues`.
  - `validateConfigText_withWrongTypeInNestedField_shouldReportIssueAtExactPath` — `settings.baseURL` as number → Issue path `providers.x.settings.baseURL`.
  - `loadSchema_withUnreachableRemote_shouldFallBackToBundled` — `fetchImpl` rejecting; result `source === 'bundled'`, no throw.
  - `loadSchema_withSuccessfulRefresh_shouldReturnRemoteAndWriteCache` — stub fetch returning `src/core/schema-bundled.json` contents and a temp `cacheDir` option (add optional `cacheDir` to opts for testability).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**; vendor the schema via `curl`/`Invoke-WebRequest` into `src/core/schema-bundled.json` (checked into git — it is OpenCode's public schema, not a secret). Compile ajv validator per `fetchedAt` key in a module-level `Map`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat: schema cache and config validation`

### Task 6: core/discovery.ts — config file discovery

**Files:**
- Create: `src/core/discovery.ts`, `test/core/discovery.test.ts`

**Interfaces:**
- Consumes: nothing (filesystem paths passed in; uses `node:fs` via injected `existsSync`-style port for purity: parameter `fsImpl?: Pick<typeof import('node:fs'), 'existsSync' | 'readdirSync'>`).
- Produces:
  - `type ConfigKind = 'global' | 'project' | 'system' | 'managed'`
  - `interface DiscoveredConfig { path: string; kind: ConfigKind; editable: boolean }` (`system`/`managed` → `editable: false`)
  - `discoverConfigs(input: { platform: NodeJS.Platform; env: Record<string, string | undefined>; cwd: string; probeFolder?: string; fsImpl?: ... }): DiscoveredConfig[]`
  - `defaultGlobalConfigPath(platform, env): string` — `$XDG_CONFIG_HOME|~/.config/opencode/opencode.json` (win: `%APPDATA%` fallback `%USERPROFILE%\.config` per docs `~/.config/opencode`), system: `C:\ProgramData\opencode` | `/etc/opencode` | `/Library/Application Support/opencode`.
  - Project scan within `cwd`/`probeFolder` only (current dir level: `opencode.json(c)` and `.opencode/opencode.json(c)`; no upward walk in v1 — the app is launched per-config-target by the user; upward search is a raw-tab concern, note it in a code comment so nobody "fixes" it).
  - `findOpencodeVersion(execFileImpl?): Promise<string | null>` — best-effort `opencode --version`, 5 s timeout, any error → `null`.

- [ ] **Step 1: Write failing tests** using `memfs`-free hand-rolled `fsImpl` fake (plain object):
  - `discoverConfigs_withGlobalAndProjectFiles_shouldClassifyKindsAndEditability`
  - `discoverConfigs_withSystemDirFile_shouldReportReadOnly`
  - `discoverConfigs_prefersJsoncOverJsonInSameDirectory` (both exist → `.jsonc` entry first, both listed)
  - `defaultGlobalConfigPath_onWindows_withUserProfile_shouldUseWindowsConvention`
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** per interface. [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat: opencode config discovery`

### Task 7: core/probe.ts — endpoint model probe

**Files:**
- Create: `src/core/probe.ts`, `test/core/probe.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ProbeStatus = 'ok' | 'unreachable' | 'auth_failed' | 'not_compatible'`
  - `interface ProbeResult { status: ProbeStatus; modelIds: string[]; detail: string; latencyMs: number }`
  - `buildModelsUrls(baseURL: string): string[]` — e.g. `http://h:8080/v1` → `['http://h:8080/v1/models']`; `http://h:8080` → `['http://h:8080/v1/models', 'http://h:8080/models']` (ordered candidates).
  - `probeModels(input: { baseURL: string; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<ProbeResult>` — tries URL candidates, with `Authorization: Bearer <key>` when key set (then once without); parses OpenAI `{ data: [{ id }] }`; status mapping: network/timeout → `unreachable`; 401/403 → `auth_failed`; parse failure or missing `data[]` → `not_compatible`; `detail` strings scrub any occurrence of `apiKey` (replace with `***`); default `timeoutMs` 10000 via `AbortSignal.timeout`.

- [ ] **Step 1: Write failing `test/core/probe.test.ts`** (stub `fetchImpl`):
  - `probeModels_withOpenAiStyleResponse_shouldReturnOkAndModelIds` (baseURL ends `/v1`, single candidate tried).
  - `probeModels_withConnectionRefused_shouldReturnUnreachableWithinTimeoutBudget` (stub rejects; `status === 'unreachable'`).
  - `probeModels_withApiKeyAnd401_shouldReturnAuthFailedAndRedactKeyInDetail` (stub detail message embeds the sent key; assert `!result.detail.includes('sk-secret')`).
  - `buildModelsUrls_withoutVersionSuffix_shouldPreferV1Candidate`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat: openai-compatible endpoint model probe`

### Task 8: server — config read/validate/save with backups, atomicity, staleness and issue policy

**Files:**
- Create: `src/server/http.ts` (tiny router helpers: `json(res, code, body)`, `readBody(req)`, `sha256(text)`, `requireLocalRequest(req): boolean`), `src/server/config-api.ts` (route handlers), `src/server/server.ts` (`createServer(handlers)` returning bound server on `127.0.0.1:0` for tests), `test/server/config-api.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6 (`Issue`, `SchemaSource`, `loadSchema`, `validateConfigText`, `discoverConfigs`, `findOpencodeVersion`).
- Produces (JSON shapes shared with UI Task 10):
  - `GET /api/state` → `{ configs: DiscoveredConfig[]; opencodeVersion: string | null; schemaSource: 'bundled' | 'remote'; schemaFetchedAt: string }` (query `?folder=` passes `probeFolder`)
  - `GET /api/config?path=` → `{ text: string; sha256: string; issues: Issue[] }` (404 `unknown_or_unsafe_path` if path not in `discoverConfigs` results for the request's folder or not inside an allowed root — allowed roots: home dir, request folder; 403 for `editable: false`).
  - `POST /api/config/save` body `{ path, text, baseSha256, baseIssues: Issue[] }` → 200 `{ sha256, backupPath }`; 409 `{ error: 'stale', diskSha256 }`; 400 `{ error: 'new_issues', newIssues: Issue[] }`. Policy: revalidate disk text → `oldSet`; validate proposed → `newSet`; block iff `newSet \ oldSet` non-empty (compare `path|message` strings); `baseSha256 !== sha256(diskText)` → 409. Backup then temp-file+rename write.
  - `GET /api/state` includes `probeFolderEcho`.
- [ ] **Step 1: Write failing `test/server/config-api.test.ts`** — boot `createServer` on port 0, real `node:fs` on a `mkdtemp` dir containing a copy of the v1 fixture as `opencode.json`; helper `req(method, path, body?)` via global fetch. Tests:
  - `save_validEdit_shouldWriteBackupAndNewFileAtomically` (assert backup file matches old bytes, new file matches submitted text).
  - `save_withPreExistingError_inUntouchedSection_shouldSucceedWithWarningFreeResponse` — pre-corrupt disk file with one bogus root key; submit edit elsewhere; 200.
  - `save_introducingNewSchemaError_shouldReturn400WithNewIssues` (add a second bogus key in submitted text).
  - `save_withStaleBaseSha256_shouldReturn409WithDiskSha256` (mutate disk file after GET).
  - `getConfig_forSystemKindPath_shouldReturn403`, `getConfig_forPathOutsideAllowedRoots_shouldReturn404`.
  - `state_reportsSchemaSourceBundled_andOpencodeVersionOrNull`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** router + handlers; `requireLocalRequest` checks `Host` matches `127.0.0.1:<port>`/`localhost:<port>` and, when `Origin` header present, equals `http://127.0.0.1:<port>`/`http://localhost:<port>`; all `/api` routes pass through it (403 otherwise). `server.ts` also serves static `dist/ui` with SPA fallback (wire in Task 9's static dir option; in tests static serving off).
- [ ] **Step 4: Run — expect PASS.** [ ] **Step 5: Commit** `feat: config file api with backups atomic writes and issue policy`

### Task 9: server — probe, upgrade preview/apply, schema refresh, static serving, CLI

**Files:**
- Create: `src/cli.ts`, `src/server/extra-api.ts`, `test/server/extra-api.test.ts`
- Modify: `src/server/server.ts` (mount extra routes + static dir), `package.json` (shebang build note)

**Interfaces:**
- Consumes: Task 7 `probeModels`; Task 4 `upgradeDocumentText`, `computeUnifiedDiff`; Task 8 save pipeline (`saveFromUpgrade` shares the backup/atomic/stale logic — extract it as `saveValidated(path, text, baseSha256, baseIssues)` in `config-api.ts`, exported); Task 5 `loadSchema`.
- Produces:
  - `POST /api/probe` body `{ baseURL, apiKey? }` → `ProbeResult`.
  - `POST /api/upgrade/preview` body `{ path }` → `{ diff: string; report: MigrationReport; sha256: string }`.
  - `POST /api/upgrade/apply` body `{ path, baseSha256, baseIssues }` → save-shape response, migrated text saved via `saveValidated`.
  - `POST /api/schema/refresh` → `{ schemaSource, schemaFetchedAt }`.
  - `cli.ts`: parse `--port <n>` `--folder <path>` `--no-open`; create server on `127.0.0.1:<port||0>`; print `opencode-config-gui running at http://127.0.0.1:<port>`; open browser via `child_process.spawn` (`cmd /c start` / `open` / `xdg-open`) unless `--no-open`.

- [ ] **Step 1: Write failing `test/server/extra-api.test.ts`**:
  - `upgradePreview_withV1FixturePath_shouldReturnUnifiedDiffAndNonEmptyChanges`
  - `upgradeApply_withMatchingBaseSha_shouldWriteMigratedTextAndBackup` (then GET `/api/config` and assert text contains `"providers"`, not `'"provider"'` as a top key; run existing Task-8 stale/new-issue regression by re-applying to the now-v2 file and asserting `report.changes` empty path via preview).
  - `probe_withStubbedOkResponse_shouldPassThroughModelIds` (server constructed with injectable `probeImpl`).
  - `apiRequest_withForeignOrigin_shouldReturn403` (fetch with explicit `Origin: http://evil.example`).
- [ ] **Step 2: Run — expect FAIL.** [ ] **Step 3: Implement extra-api + cli.ts + static serving** (static: `--static <dir>` or default `dist/ui` relative to package root; SPA fallback to `index.html`; never serve files under the config root that aren't in the static dir).
- [ ] **Step 4: Run — expect PASS.** Manual: `node dist/cli.js --no-open --folder .` then `curl http://127.0.0.1:<port>/api/state` prints JSON.
- [ ] **Step 5: Commit** `feat: probe upgrade and schema endpoints plus cli entry`

### Task 10: UI scaffold — shell, config picker, raw JSONC tab

**Files:**
- Create: `index.html`, `src/ui/main.tsx`, `src/ui/App.tsx`, `src/ui/api.ts`, `src/ui/components/ConfigPicker.tsx`, `src/ui/components/RawJsonTab.tsx`, `src/ui/components/ValidationPanel.tsx`, `src/ui/components/Toast.tsx`, `vite.config.ts` (modify: `base: './'`, `build.outDir: '../dist/ui'`, dev proxy `/api → http://127.0.0.1:8710`), `test/ui/api.test.ts`

**Interfaces:**
- Consumes: Task 8/9 endpoint JSON shapes exactly as written there.
- Produces: `api.ts` client functions `getState(folder?)`, `getConfig(path)`, `saveConfig(path, text, baseSha256, baseIssues)`, `probe(baseURL, apiKey?)`, `upgradePreview(path)`, `upgradeApply(path, baseSha256, baseIssues)`, `refreshSchema()`; `App` holds `{ currentConfig: {path, text, sha256, issues} | null }` and passes it to tabs.

- [ ] **Step 1: `npm create vite`-style hand scaffold** (react plugin, TS config) inside existing project root (`index.html` at root, `src/ui` as app dir; do not nest a second package).
- [ ] **Step 2: Write failing `test/ui/api.test.ts`** — stub `globalThis.fetch`; assert `saveConfig` sends `{path, text, baseSha256, baseIssues}` and that a 409 response surfaces as `{kind: 'stale', diskSha256}` (client maps HTTP outcomes to `{kind: 'ok'|'stale'|'new_issues'|'error', ...}` discriminated union so callers switch explicitly).
- [ ] **Step 3: Implement `api.ts`** to that mapping.
- [ ] **Step 4: Build the shell**: ConfigPicker (select from `state.configs` filtered `editable`, "Open folder…" prompt for `?folder=` path input), tab strip (Providers | MCP | Raw JSON — first two disabled placeholders until Tasks 11–12), ValidationPanel listing `issues` as warnings ("pre-existing — not blocking your saves") and later blocking errors, Toast. RawJsonTab: `<textarea>` (monospace, line numbers optional) seeded with `text`, Save button → `saveConfig` with current `sha256`/`issues`; on `stale` show "file changed on disk — Reload / Force save"; on `new_issues` list them and refuse.
- [ ] **Step 5: Run `npm run typecheck && npm test`** (PASS) and manual: `npm run build && node dist/cli.js --folder test-fixtures-dir` in browser — load the local partner `opencode.json`, toggle a comment, save, see backup file appear, `git status` shows nothing staged for `opencode.json` (it's ignored).
- [ ] **Step 6: Commit** `feat: ui shell with config picker and raw jsonc editor`

### Task 11: UI — provider, model and variant editors

**Files:**
- Create: `src/ui/components/ProviderList.tsx`, `src/ui/components/ProviderEditor.tsx`, `src/ui/components/ModelList.tsx`, `src/ui/components/ModelEditor.tsx`, `src/ui/components/VariantRows.tsx`, `src/ui/components/ApiKeyField.tsx`, `src/ui/components/EndpointPanel.tsx`, `src/ui/editor-path.ts`, `test/ui/editor-path.test.ts`

**Interfaces:**
- Consumes: `App` currentConfig text+issues; Task 8 save (UI-side edits are compiled to full new text client-side — parse text with a bundled `jsonc-parser` import (browser-safe), apply `PathEdit[]` via a UI copy of the apply loop, send resulting text; validation happens server-side on save).
- Produces: `editor-path.ts`: `editInText(text: string, edits: PathEdit[]): string` (browser re-export of Task 3 logic via direct `jsonc-parser` use — import `jsonc-parser` in the bundle; comment note: keep behavior in sync with `core/jsonc.ts`, and a shared `PathEdit` type imported from `core/types.ts`).

Forms:
- ProviderEditor: ID (rename = delete+create edit pair), display name, preset `package` select (openai-compatible / openai / anthropic / google / ollama / lmstudio / vllm / blank / custom-text — the three local-runtime presets omit `package` and model list), `settings.baseURL`, ApiKeyField (text input, masked, buttons `{env:…}` / `{file:…}` wrap/unwrap the value string), `env` multi-input, `headers` key/value rows.
- EndpointPanel: [test] → `probe`, colored status + latency; [Fetch from endpoint] → checkbox list of `modelIds`; Import adds `models[id] = { name: id, limit: { context: 128000, output: 8192 } }` per model (placeholders flagged with an "edit these" toast).
- ModelEditor: model key, display name, `modelID`, context/output numbers, capability booleans (`tools`, `temperature`) mapping to `capabilities`, `disabled`.
- VariantRows: rows of `id` + key/value settings pairs; "+ reasoningEffort preset" adds `{id, settings: {reasoningEffort: v}}` with level select (none/low/medium/high/xhigh); a "Use capabilities.reasoning instead" action writes `capabilities.reasoning = { supported: true, effort: [...], toggle: true }` and removes the variants array (confirm dialog).

- [ ] **Step 1: Write failing `test/ui/editor-path.test.ts`**: `editInText_addsNewProviderWithModel_shouldKeepOtherProvidersByteIdentical`; `editInText_renamesProviderId_removesOldKeyAddsNewBlock` (delete+create pair).
- [ ] **Step 2: Run — expect FAIL. Step 3: Implement** `editor-path.ts` + components per forms. v1-shaped docs: `ProviderEditor` reads legacy `provider`/`npm`/`options`/variant-map when present, renders a "legacy shape — [Upgrade]" banner linking the upgrade action (Task 12), and structured saves write back in the *legacy* location for legacy docs (never silently half-migrate; edits go to `provider.<id>…` paths in that case — encode via a `docShape: 'v1' | 'v2'` flag computed once in App).
- [ ] **Step 4:** `npm run typecheck && npm test` PASS; manual round-trip on fixture (edit Basalt baseURL, add model from probe against a stub or live endpoint, save, reload). [ ] **Step 5: Commit** `feat: provider model and variant editors`

### Task 12: UI — MCP editor, upgrade preview dialog, schema refresh

**Files:**
- Create: `src/ui/components/McpList.tsx`, `src/ui/components/McpEditor.tsx`, `src/ui/components/UpgradeDialog.tsx`, `src/ui/components/SchemaBadge.tsx`

**Interfaces:**
- Consumes: `editInText` (Task 11), `upgradePreview`/`upgradeApply`/`refreshSchema` (Task 10 client).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Implement** McpEditor: name, type select (local/remote) — local: command array rows, `cwd`, environment key/value rows, `disabled` (render legacy `enabled: false` as disabled-checked); remote: url, headers, `disabled`; global `mcp.timeout` numeric trio. Legacy flat entries: same editor, saves target flat location with `docShape` banner (mirror Task 11 pattern).
- [ ] **Step 2: Implement** UpgradeDialog: preview diff in `<pre>` with `changes`/`leftUnchanged` lists; Apply → `upgradeApply` with current `sha256`+`issues`, then reload config; disabled Apply + "another file has changes — use Raw JSON" note when `new_issues` response arrives. SchemaBadge: `bundled` (amber) / `remote + fetchedAt` (green), refresh → `refreshSchema()`, shows detected `opencodeVersion` beside a persistent note "v2 keys need a recent OpenCode" whenever an upgrade dialog is open.
- [ ] **Step 3:** `npm run typecheck && npm test` PASS; manual: open live partner `opencode.json` copy (in a scratch folder), run upgrade preview, eyeball diff matches Task 4 report, cancel. [ ] **Step 4: Commit** `feat: mcp editor and v1-to-v2 upgrade dialog`

### Task 13: Packaging, README, CI, release drill

**Files:**
- Create: `README.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `package.json` (`files`, `prepublishOnly`), `src/cli.ts` (ensure ESM shebang `#!/usr/bin/env node` survives build — add a build step `node scripts/postbuild.mjs` writing shebang + chmod if needed)
- Create: `scripts/postbuild.mjs`

**Interfaces:**
- Consumes: everything.
- Produces: publishable package; CI green matrix; tag-triggered 6-binary releases (`bun build --compile src/cli.ts --outfile release/opencode-config-gui-<os>-<arch>` for windows/linux/darwin × x64/arm64, UI assets copied into release archives).

- [ ] **Step 1:** Add `"files": ["dist", "src/core/schema-bundled.json", "README.md"]`, `"engines": {"node": ">=20"}`, `prepublishOnly: "npm run typecheck && npm test && npm run build"`. Write README: what/why, `npx opencode-config-gui`, presets, fixture note ("bring your own config; this tool keeps your keys in your file").
- [ ] **Step 2:** CI: `ci.yml` = push/PR matrix `[ubuntu, windows, macos]` × node 20/24: `npm ci && npm run typecheck && npm test`. `release.yml` = tag `v*`: build, install Bun, compile 6 binaries, attach to GitHub Release.
- [ ] **Step 3: Release drill (this is the test):** `npm pack --dry-run` and assert output lists no `opencode.json` and no `test/`; run `node dist/cli.js --no-open` from the built dist and hit `/api/state`; `git status` clean.
- [ ] **Step 4: Commit** `chore: packaging readme and ci`

---

## Self-review record

- Spec coverage: Goals 1–12 → Tasks 9–13 (CLI/browser/ports/security: 9, 13), discovery (6), providers (11), models/variants (11), MCP (12), probe (7, 9, 11), upgrade (2, 4, 9, 12), raw tab (10), schema validation (5, 8), file safety (8), env/file key refs (11), localhost binding (8). Non-goals respected (no auth-store editing, no installers, no precedence simulation).
- Review Focus lines all have named tests (Tasks 3, 5, 7, 8, 9).
- Type consistency checked: `Issue`, `PathEdit`, `JsonValue` (Task 3) reused in Tasks 4, 5, 10, 11; `DiscoveredConfig` (6) in 8; `ProbeResult` (7) in 9, 11; `MigrationReport` (4) in 9, 12; save 409/400 shapes (8) in 10 client mapping.
