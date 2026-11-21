# pi-config-gui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loopback web app (`pi-config-gui/`) that edits Pi's `~/.pi/agent/models.json` and `auth.json`, hero flow being "add a local model endpoint, probe it, import its models".

**Architecture:** Self-contained fork of the opencode-config-gui layers (raw node:http loopback server + React SPA + pure-TS core) with the single-config pipeline generalized into a per-document pipeline (`doc` selector, per-document validator, `auth.json` rebase-save semantics). Path safety collapses to a fixed doc-ID allowlist inside the resolved agent dir.

**Tech Stack:** TypeScript ESM (Node ≥ 20), React 19, Vite, vitest, ajv (2020 draft), jsonc-parser, diff. No component/router/state libraries.

**Spec:** `docs/superpowers/specs/2026-11-21-pi-config-gui-design.md` — read it alongside this plan; it fixes scope (models.json + auth.json only, overlay-only catalog, no CI changes) and the three builder-check decisions (auth rebase, probe-merge/no-exec, manual npm publish).

**Copy sources:** The sister app at the repo root (`src/`, `test/`) is the material to fork. Copying files FROM it INTO `pi-config-gui/` is expected; the fork never imports across the folder boundary, and nothing in the opencode tree is ever modified.

## Global Constraints

- Everything lives under `pi-config-gui/` with its own `package.json` (name `pi-config-gui`, bin `pi-config-gui → dist/cli.js`), tsconfigs, vite/vitest configs, scripts, README, `launch.bat`/`launch.sh`.
- `.github/` and the opencode app's `src/`, `test/`, `package.json` are byte-identical before and after this plan.
- Pure TypeScript, ESM (`"type": "module"`), Node ≥ 20 floor; React 19 + hand-written CSS; runtime deps exactly: `ajv`, `diff`, `jsonc-parser`, `react`, `react-dom`.
- Server binds `127.0.0.1` only (port 0 default), local-Host/Origin gate preserved verbatim from `server/http.ts` + `server/server.ts`.
- Schema URL: `https://pi.dev/schemas/models.schema.json`; cache dir `~/.cache/pi-config-gui`; vendored copy at `src/core/schema-bundled.json`.
- Agent dir resolution: `--agent-dir` flag > `PI_CODING_AGENT_DIR` env > `~/.pi/agent` (Windows `%USERPROFILE%\.pi\agent`); POSIX-created `auth.json` gets mode `0600`.
- The server never executes `!command` strings found in config; probe resolves `$NAME` from its own `process.env` only.
- `models.json` gets classic staleness/Force-save; `auth.json` structured saves rebase (spec §"Settled during builder-check" 1).
- Commit style: one commit per task step where the step says commit; all `git add` paths are under `pi-config-gui/` (plus the plan doc once).
- All npm/vitest commands run with working dir `pi-config-gui/`.

## Review Focus

Failure modes no single task's happy-path tests will exercise — each gets a pinning test in the named task:

1. **auth.json changes under the editor** (pi refreshes OAuth tokens live): a structured save touching one `api_key` entry must preserve untouched entries byte-for-byte and must not 409 on unrelated churn; it MUST 409 when a top-level entry it touched differs on disk from its base (Task 5).
2. **Legacy/odd pi files**: `models.json` with `//` comments, trailing commas, BOM, CRLF round-trips through edits with the comments alive (Task 1 pins; Task 4 re-pins through the save route).
3. **Key forms in the probe path**: `!command` apiKey → refused with a machine-readable error and never spawned; `$NAME` → resolved from server env; unresolvable `$NAME` → treated as absent key with the literal sent NOT happening (Task 7).
4. **Absent files / empty agent dir**: `/api/state` lists `models`/`auth` with `exists:false`; first save seeds the documented stub content and creates the file (`0600` for auth on POSIX) (Task 4).
5. **Unknown `auth.json` entry shapes** (future pi versions): validation stays permissive, the entry renders read-only, and a rebase-save leaves it byte-stable (Tasks 3, 5, 12).

---

### Task 1: Fork scaffold + build wiring

**Files:**
- Create: `pi-config-gui/package.json`, `pi-config-gui/tsconfig.json`, `pi-config-gui/tsconfig.build.json`, `pi-config-gui/vite.config.ts`, `pi-config-gui/vitest.config.ts`, `pi-config-gui/index.html`, `pi-config-gui/.gitignore`
- Copy (adapt branding strings only): `src/core/types.ts`, `src/core/jsonc.ts`, `src/core/probe.ts`, `src/server/http.ts`, `src/server/server.ts`, `src/static-dir.ts`, `src/exec-data-dir.ts`, `src/ui/styles.css`, `src/ui/editor-path.ts`, `src/ui/components/Toast.tsx`, `src/ui/components/ValidationPanel.tsx` → `pi-config-gui/` mirrors; `scripts/postbuild.mjs` → `pi-config-gui/scripts/postbuild.mjs`
- Copy tests verbatim: `test/core/jsonc.test.ts`, `test/core/probe.test.ts`, `test/core/editor-path` equivalents → `pi-config-gui/test/...`
- Create: `pi-config-gui/src/main-placeholder.ts` (temporary `export {}` so tsc has input — removed in Task 9 when App lands)

**Interfaces:**
- Consumes: nothing.
- Produces: build/test harness for every later task; `core/types.ts` exports `JsonValue`, `Issue`, `PathEdit` exactly as the sister app; `core/jsonc.ts` exports `parseJsonc(text): {value: JsonValue, errors: Issue[]}` and `applyPathEdits(text, edits: PathEdit[]): string`; `server/http.ts` exports `json`, `readBody`, `sha256`, `requireLocalRequest`, `ApiRoutes`.

- [ ] **Step 1:** Write `package.json` modeled on the sister's: name/bin `pi-config-gui`, scripts `test`/`typecheck`/`build`/`dev:ui`/`dev:server`/`smoke`/`prepublishOnly` (same shapes; `dev:server` port 8711 to coexist with opencode's 8710), runtime deps exactly `ajv`, `diff`, `jsonc-parser`, `react`, `react-dom`. Write tsconfigs/vite/vitest/index.html copied with `pi-config-gui` strings.
- [ ] **Step 2:** Copy the files listed above; in `vite.config.ts` keep the `/api` dev proxy to `127.0.0.1:8711`.
- [ ] **Step 3:** `npm install`; run the copied jsonc/probe tests: `npx vitest run test/core` — expect PASS (they are harness-independent).
- [ ] **Step 4:** `npm run typecheck` and `npm run build` (build may only emit the placeholder + vite shell; acceptable if `postbuild.mjs`'s schema copy step is skipped until the file exists in Task 3 — guard it with an exists-check).
- [ ] **Step 5:** Commit `chore(pi-config-gui): scaffold self-contained fork with portable layers`.

### Task 2: core/discovery.ts for pi documents

**Files:**
- Create: `pi-config-gui/src/core/discovery.ts`, `pi-config-gui/test/core/discovery.test.ts`

**Interfaces:**
- Consumes: `FsImpl`, `ExecFileImpl` port shapes (copy the two type definitions from the sister `core/discovery.ts`; drop `probeFolder` machinery).
- Produces:
```ts
export type DocId = "models" | "auth" | "settings" | "mcp" | "keybindings";
export interface PiDoc { id: DocId; path: string; kind: "models" | "auth" | "other";
                         editable: boolean; exists: boolean }
export function resolveAgentDir(platform: NodeJS.Platform,
  env: Record<string, string | undefined>, agentDirFlag?: string): string
export interface DiscoverDocsInput { platform: NodeJS.Platform;
  env: Record<string, string | undefined>; agentDir?: string; fsImpl?: FsImpl }
export function discoverDocs(input: DiscoverDocsInput): { agentDir: string; docs: PiDoc[] }
export async function findPiVersion(execFileImpl?: ExecFileImpl): Promise<string | null>
```
- `docs` order: `models`, `auth`, then `settings`, `mcp`, `keybindings`. `models`/`auth` are ALWAYS listed (`exists:false` when absent, `editable:true`); the `other` docs appear only when present (`editable:false`).
- `resolveAgentDir`: flag wins verbatim; else `PI_CODING_AGENT_DIR`; else `<home>/.pi/agent` — home from `USERPROFILE` (win32) / `HOME` (posix), literal `"~"` anchor when missing (mirror the sister's never-throw style).
- `findPiVersion`: like `findOpencodeVersion` — binary `pi`, `--version`, 5 s cap, `null` on any failure.

- [ ] **Step 1:** Write failing tests: win32 default path from `USERPROFILE`; posix `PI_CODING_AGENT_DIR` wins over `HOME`; flag wins over both; `discoverDocs` on a fake `fsImpl` whose agent dir holds only `settings.json` returns exactly `[{id:"models",exists:false,editable:true}, {id:"auth",exists:false,editable:true}, {id:"settings",exists:true,editable:false}]` in that order (pin order, kinds, flags).
- [ ] **Step 2:** Run `npx vitest run test/core/discovery.test.ts` — FAIL.
- [ ] **Step 3:** Implement in `src/core/discovery.ts` per the signatures; keep the pure/injected-port structure and comment style of the sister module.
- [ ] **Step 4:** Re-run — PASS. Also add + run a `findPiVersion` test with a stub `execFileImpl` (ok / throw → null).
- [ ] **Step 5:** Commit `feat(pi-config-gui): pi agent-dir discovery with models/auth/other documents`.

### Task 3: Schema layer + vendored pi schema + auth validator

**Files:**
- Create: `pi-config-gui/src/core/schema.ts`, `pi-config-gui/src/core/auth-schema.ts`, `pi-config-gui/src/core/schema-bundled.json`, `pi-config-gui/test/core/schema.test.ts`, `pi-config-gui/test/core/auth-schema.test.ts`
- Modify: `pi-config-gui/scripts/postbuild.mjs` (schema copy step now unconditional)

**Interfaces:**
- Consumes: `parseJsonc`, `Issue`, `JsonValue`; sister `schema.ts` structure.
- Produces:
```ts
export const REMOTE_SCHEMA_URL = "https://pi.dev/schemas/models.schema.json"
// same SchemaSource / LoadSchemaOptions / loadSchema ladder as sister, but:
// cache file join(cacheDir ?? ~/.cache/pi-config-gui, "models-schema.json")
// NO stubRemoteRefs call needed (pi's schema is self-contained) — keep the
// helper (harmless, guards future remote refs) and pin it compiles offline.
export function validateConfigText(text: string, schema: SchemaSource): Issue[]   // models.json
export type DocValidator = (text: string) => Issue[]
export function validatorFor(docId: DocId, schema: SchemaSource): DocValidator
//   "models" → validateConfigText; "auth" → validateAuthText; other → () => []
export function validateAuthText(text: string): Issue[]   // in auth-schema.ts
```
- `validateAuthText` hand-rolled rules (NO ajv — permissive by design): top level must be a JSON object (JSONC-parsed; parse errors → its Issues); each top-level value must be an object with a string `type`; when `type === "api_key"`: `key` must be a string (or `!command` string — same type), optional `env` must be a `Record<string,string>`; unknown `type` values or unknown fields produce NO issues (Review Focus 5).

- [ ] **Step 1:** Download the schema: `Invoke-WebRequest https://pi.dev/schemas/models.schema.json -OutFile pi-config-gui/src/core/schema-bundled.json` (commit the file). Verify it parses and `jq .'$id'` equals `https://pi.dev/schemas/models.schema.json`.
- [ ] **Step 2:** Write `schema.test.ts` (adapt sister tests): ladder refresh→cache→bundled; cache dir override `pi-config-gui` naming; degraded bundled → permissive `{}` with `fetchedAt: "bundled-missing"`; a valid pi `models.json` sample (custom provider with `api`, `models[0].id`, `modelOverrides`) validates clean; a model missing `id` yields an Issue with path `providers.x.models[0]`. Add auth validator tests here-in-miniature or in its file: `{"anthropic":{"type":"api_key","key":"sk-x","env":{"A":"b"}}}` clean; `{"weird":{"type":"oauth_future","blob":{"any":[1]}}}` clean; `{"p":{"type":"api_key"}}` → Issue at `p.key`; top-level array → one Issue at ``.
- [ ] **Step 3:** Run — FAIL; implement `schema.ts` (copy sister, swap URL/cache filename/`$id` comment) + `auth-schema.ts`; re-run — PASS.
- [ ] **Step 4:** `npm run build` — confirm `dist/core/schema-bundled.json` lands. Commit `feat(pi-config-gui): pi models schema ladder + permissive auth validator`.

### Task 4: Document-based config API (state / read / classic save)

**Files:**
- Create: `pi-config-gui/src/server/config-api.ts`, `pi-config-gui/test/server/config-api.test.ts`
- Material: sister `src/server/config-api.ts` (save pipeline reused; path vetting REPLACED by doc-id allowlist).

**Interfaces:**
- Consumes: `discoverDocs`, `resolveAgentDir`, `DocId`, `PiDoc`, `validatorFor`, `findPiVersion`, `sha256`.
- Produces:
```ts
export interface ConfigApiDeps { platform?: NodeJS.Platform; env?: Record<string,string|undefined>;
  agentDir?: string; homeDir?: string; loadSchemaOptions?: LoadSchemaOptions;
  execFileImpl?: ExecFileImpl; discoveryFs?: FsImpl }
export type VetOutcome = { ok: true; doc: PiDoc } | { ok: false; status: number; error: string }
export function vetDoc(deps: ConfigApiDeps, docId: string): VetOutcome
//   unknown id → 400 "bad_doc"; exists-discovered non-editable (settings/mcp/
//   keybindings) → 403 "read_only_doc"; models/auth → ok (even when exists:false)
export function seedText(docId: DocId): string
//   models: `{\n  "$schema": "https://pi.dev/schemas/models.schema.json",\n  "providers": {}\n}\n`
//   auth:   `{}\n`
export interface SaveDeps { validate: DocValidator }
export type SaveResult = SaveWritten | SaveStale | SaveBlocked   // shapes as sister
export async function saveValidated(deps: SaveDeps, path: string, seed: string,
  text: string, baseSha256: string): Promise<SaveResult>
//   diskText = file exists ? readFileSync : seed;  rest identical to sister
//   (backup ONLY when the file exists; temp+rename always; on POSIX, when
//   CREATING a file whose path ends "auth.json", chmod the temp file 0o600
//   before rename).
export interface SaveRebased { ok: true; sha256: string; backupPath: string; rebased: true }
export interface SaveConflict { ok: false; kind: "conflict"; entries: string[] }
export async function saveAuthRebased(deps: SaveDeps, path: string,
  baseText: string, edits: PathEdit[]): Promise<SaveResult | SaveConflict>
export function createConfigApiHandlers(deps?: ConfigApiDeps): ApiRoutes
```
- Routes: `GET /api/state` → `{ agentDir, docs, piVersion, schemaSource, schemaFetchedAt }`; `GET /api/config?doc=<id>` → absent editable file serves `seedText` (so `sha256` is the seed hash and the client's classic base flow just works), `{ text, sha256, issues, exists }`; `POST /api/config/save` body `{ doc, text, baseSha256, baseIssues, edits?, baseText? }` — `models` (or absent `edits`): classic; `auth` with a valid non-empty `edits` array + string `baseText`: `saveAuthRebased`; `auth` without `edits` (raw tab): classic.
- `saveAuthRebased`: parse `baseText` and disk text (JSONC); touched entries = distinct `edits[i].path[0]`; for each, deep-compare parsed values in base vs disk (`JSON.stringify` of `undefined` for absent — treat "both absent" as equal, "one absent" as conflict); on any mismatch → `{ok:false, kind:"conflict", entries}`; else `text := applyPathEdits(diskText, edits)`, then the same new-issues/backup/atomic-write policy as `saveValidated`, returning `SaveRebased`.

- [ ] **Step 1:** Write tests using temp dirs + injected `discoveryFs`/`env` (mirror the sister test harness): state payload shape incl. `exists:false` docs; `GET /api/config?doc=models` when file absent returns seed text + seed sha; `vetDoc` 400/403/ok matrix; classic save on models: stale → 409 with `diskSha256`; new-introduced issue → 400 `newIssues`; happy → file written + `.bak-*` created; save over ABSENT file creates it with edited seed content; POSIX auth-seed creation mode test (skip on win32). Review-Focus 2 pin: models save through a file containing `//` comments + trailing comma preserves both in the written bytes.
- [ ] **Step 2:** `npx vitest run test/server/config-api.test.ts` — FAIL.
- [ ] **Step 3:** Implement `config-api.ts` (adapt sister backup/writeBackup/paths; delete `vetConfigPath`/folder machinery — no `?folder=` exists in pi-config-gui).
- [ ] **Step 4:** Re-run — PASS. Commit `feat(pi-config-gui): document-keyed config API with seeded files and classic save`.

### Task 5: auth.json rebase save route + conflict tests

**Files:**
- Modify: `pi-config-gui/src/server/config-api.ts` (wire `saveAuthRebased` into the save route — Task 4 stubbed it if needed)
- Create: `pi-config-gui/test/server/auth-rebase.test.ts`

**Interfaces:** Consumes Task 4's `createConfigApiHandlers`, `saveAuthRebased`, `applyPathEdits`. Produces: route behavior only.

- [ ] **Step 1:** Tests (temp dirs, real HTTP on ephemeral ports like the sister server tests):
  1. Disk `auth.json` = `{ "anthropic": {"type":"api_key","key":"A"}, "copilot": {"type":"oauth","token":"T1"} }`; client base had token `T0` but edits only touch `anthropic.key → B`. Save succeeds, and written file contains `T1` byte-stable (Review Focus 1).
  2. Client base and disk differ inside `anthropic` (pi rotated something inside the touched entry) → 409 `{error:"conflict", entries:["anthropic"]}`, file untouched, no backup written.
  3. Edit adds a brand-new provider entry while disk gained an unrelated one → save keeps both.
  4. Unknown-shape entry (Review Focus 5): disk contains `{"zeta":{"type":"weird","nested":{"x":[1,2]}}}` untouched by edits → byte-stable after save of another entry.
  5. `edits` present but `baseText` missing/malformed → 400 `bad_request`, no write.
  6. auth save WITHOUT `edits` (raw tab path) → classic stale-409 semantics still apply.
- [ ] **Step 2:** Run — FAIL (where Task 4 stubbed). Implement/finish per Task 4's interface. Run — PASS. Commit `feat(pi-config-gui): auth.json rebase save with entry-level conflict detection`.

### Task 6: Presets, key forms, built-in provider IDs

**Files:**
- Create: `pi-config-gui/src/core/presets.ts`, `pi-config-gui/src/core/keyref.ts`, `pi-config-gui/src/core/builtins.ts`, `pi-config-gui/test/core/keyref.test.ts`, `pi-config-gui/test/core/presets.test.ts`

**Interfaces:**
- Produces:
```ts
// presets.ts
export interface LocalPreset { id: string; label: string; baseUrl: string; api: string; apiKey: string }
export const LOCAL_PRESETS: readonly LocalPreset[]
// ollama: http://localhost:11434/v1, openai-completions, "ollama"
// lmstudio: http://localhost:1234/v1, openai-completions, "lmstudio"
// vllm: http://localhost:8000/v1, openai-completions, "vllm"
// llamacpp: llama.cpp router — CHECK pi's docs/llama-cpp.md (github
//   earendil-works/pi) for the router default port + /v1 base; use it; fall
//   back to http://localhost:8080/v1 with apiKey "llamacpp" if the doc is
//   unreachable. Record the finding in a code comment.
// generic: baseUrl "", api "openai-completions", apiKey ""
// keyref.ts
export type KeyForm = "literal" | "env" | "command"
export function classifyKey(value: string): KeyForm   // "!"-prefixed → command;
//   contains an unescaped "$" ("$$" and "$!" are escapes → literal) → env; else literal
export function envVarNames(value: string): string[]  // $NAME / ${NAME} names, escapes honored
export function resolveEnvKey(value: string, env: Record<string,string|undefined>):
  { ok: true; key: string } | { ok: false; missing: string[] }
// builtins.ts
export const BUILTIN_PROVIDER_IDS: readonly string[]  // from pi docs/providers.md
//   tables: anthropic, openai, gemini, azure, amazon-bedrock, google-vertex,
//   mistral, groq, cerebras, xai, openrouter, vercel-ai-gateway, github-copilot,
//   deepseek, nvidia-nim, hugging-face, fireworks, together, baseten, kimi,
//   meta, minimax, moonshot, typesafe, radius, zai, opencode + qwen/xiaomi
//   variants as documented. Staleness tolerated (autocomplete only); add a
//   comment pointing at docs/providers.md.
```
- [ ] **Step 1:** Write `keyref.test.ts` pins: `classifyKey("!security find-generic-password") === "command"`; `classifyKey("$$literal") === "literal"`; `classifyKey("sk-$KEY$OTHER") === "env"` with `envVarNames === ["KEY","OTHER"]`; `resolveEnvKey("pre-$NAME", {NAME:"X"})` → `{ok:true, key:"pre-X"}`; missing var → `{ok:false, missing:["NAME"]}`; `classifyKey("$!") === "literal"` and `classifyKey("!")` → command.
- [ ] **Step 2:** Run — FAIL; implement all three modules; run — PASS.
- [ ] **Step 3:** Commit `feat(pi-config-gui): local endpoint presets, api-key form classification, built-in provider ids`.

### Task 7: extra-api (probe + schema refresh), key-form gated

**Files:**
- Create: `pi-config-gui/src/server/extra-api.ts`, `pi-config-gui/test/server/extra-api.test.ts`
- Copy: sister `src/core/probe.ts` already in place (Task 1). No `/api/upgrade/*` (pi has no migrator).

**Interfaces:**
- Consumes: `probeModels`, `classifyKey`, `resolveEnvKey`, `loadSchema`, `json`/`readBody`/`ApiRoutes`.
- Produces: `export function createExtraApiHandlers(deps?: { loadSchemaOptions?: LoadSchemaOptions; env?: Record<string,string|undefined> }): ApiRoutes`
  - `POST /api/probe` body `{ baseUrl, apiKey?: string }`. Server classifies `apiKey` via `classifyKey`: `"command"` → `400 {error:"command_key"}` (NEVER spawned — Review Focus 3); `"env"` → `resolveEnvKey` against `deps.env ?? process.env`, missing → probe runs keyless with the response flagging `{warning:"env_key_unresolved", names}` (never sending the `$NAME` text as a key); `"literal"` → as-is. Delegates to `probeModels`; response = its `ProbeResult` verbatim.
  - `POST /api/schema/refresh` → `{ source, fetchedAt }` via `loadSchema({refresh:true})` (copy sister behavior).

- [ ] **Step 1:** Tests with stub `fetchImpl` (sister `extra-api.test.ts` is the harness template): ok probe with literal Bearer key reaches `/v1/models` and returns ids; `!cmd` key refused pre-network (stub fetch that records calls asserts zero calls); `$MISSING` resolved-unsuccessfully probes keyless with warning; refresh returns `source:"remote"` on stubbed fetch.
- [ ] **Step 2:** Run — FAIL; implement; run — PASS. Commit `feat(pi-config-gui): probe endpoint with key-form gating and schema refresh`.

### Task 8: CLI, launch scripts, smoke

**Files:**
- Create: `pi-config-gui/src/cli.ts`, `pi-config-gui/launch.bat`, `pi-config-gui/launch.sh`, `pi-config-gui/scripts/smoke.mjs`
- Material: sister `src/cli.ts` + `scripts/smoke.mjs` (strip `--folder`/`?folder=` machinery entirely).

**Interfaces:** Consumes `createConfigApiHandlers({agentDir})`, `createExtraApiHandlers`, `createServer`, `resolveStaticDir`. Produces: `USAGE` + flags `--port <n>`, `--agent-dir <path>`, `--static <dir>`, `--no-open`; boot prints `pi-config-gui running at http://127.0.0.1:<port>/`.

- [ ] **Step 1:** Copy+adapt cli (rename all strings; `deps = { agentDir: resolve(flag) }` only when flag given; URL without `?folder=`).
- [ ] **Step 2:** Adapt `smoke.mjs`: boot `dist/cli.js --port <free> --agent-dir <tmpdir with a models.json> --no-open`; assert `GET /api/state` lists the doc + `GET /api/config?doc=models` echoes text + foreign `Host:` header gets refused (copy the sister's guard check). Run `npm run build && npm run smoke` — PASS.
- [ ] **Step 3:** Launch scripts copied with `pi-config-gui` names. Commit `feat(pi-config-gui): cli, launch scripts, smoke test`.

### Task 9: UI shell — App, api client, Raw tab, header

**Files:**
- Create: `pi-config-gui/src/ui/main.tsx`, `pi-config-gui/src/ui/App.tsx`, `pi-config-gui/src/ui/api.ts`, `pi-config-gui/src/ui/components/RawJsonTab.tsx`, `pi-config-gui/src/ui/components/SchemaBadge.tsx`, `pi-config-gui/test/ui/api.test.ts`
- Delete: `pi-config-gui/src/main-placeholder.ts` (vite entry now `src/ui/main.tsx`).

**Interfaces:**
- Consumes: server routes from Tasks 4/7.
- Produces (the UI's only network surface — Tasks 10–12 build against it):
```ts
// api.ts
export type DocId = "models" | "auth"
export interface DocState { id: DocId; path: string; exists: boolean; editable: boolean }
export interface StatePayload { agentDir: string; docs: DocState[]; otherDocs: { id: string; path: string }[];
  piVersion: string | null; schemaSource: "bundled"|"remote"; schemaFetchedAt: string }
export interface ConfigPayload { text: string; sha256: string; issues: Issue[]; exists: boolean }
export type SaveResult = { ok:true; sha256:string; backupPath:string } |
  { ok:false; kind:"stale"; diskSha256:string } | { ok:false; kind:"new_issues"; newIssues:Issue[] } |
  { ok:false; kind:"conflict"; entries:string[] } | { ok:false; kind:"error"; status:number }
export function getState(): Promise<StatePayload>
export function getConfig(doc: DocId): Promise<ConfigPayload>
export function saveConfig(body: { doc: DocId; text: string; baseSha256: string;
  baseIssues: Issue[]; edits?: PathEdit[]; baseText?: string }): Promise<SaveResult>
export function refreshSchema(): Promise<{ source: string; fetchedAt: string }>
export function probe(input: { baseUrl: string; apiKey?: string }):
  Promise<ProbeResult & { warning?: { kind: "env_key_unresolved"; names: string[] } }>
```
- `App.tsx`: header = title + agent dir + `SchemaBadge` (pi version + schema provenance, sister pattern) + info strip listing `otherDocs`; tabs `providers` ("Providers & Models") / `keys` ("API Keys") / `raw` (per-doc textarea via `RawJsonTab`, classic save); dirty-draft confirm-on-switch + staleness/`conflict` toasts follow the sister App patterns (conflict toast: "pi changed <entries> in auth.json — reloaded"). Placeholder panes for providers/keys until Tasks 10/12.

- [ ] **Step 1:** Write `test/ui/api.test.ts` (sister `test/ui/api.ts` style, stub `fetch`): `saveConfig` maps 409→stale, 400 new_issues, 409-with-entries→conflict, other→error; `probe` passes body through and surfaces `warning` when present.
- [ ] **Step 2:** Run — FAIL; implement `api.ts`; PASS.
- [ ] **Step 3:** Implement shell + Raw tab + badge (copy `RawJsonTab`/`SchemaBadge` from sister, swap `path`→`doc`, drop Upgrade dialog refs); `npm run build` green; manual: `node dist/cli.js --agent-dir <tmp>` shows state + raw text. Commit `feat(pi-config-gui): UI shell, doc-aware api client, raw tab`.

### Task 10: Providers & Models tab — list, presets dialog, provider editor, JsonField

**Files:**
- Create: `pi-config-gui/src/ui/components/ProviderList.tsx`, `pi-config-gui/src/ui/components/ProviderEditor.tsx`, `pi-config-gui/src/ui/components/JsonField.tsx`, `pi-config-gui/src/ui/provider-logic.ts`, `pi-config-gui/test/ui/provider-logic.test.ts`
- Material: sister `ProviderList.tsx`/`ProviderEditor.tsx` (pending-`PathEdit[]` architecture), `ApiKeyField.tsx` (mask + `$NAME` wrap instead of `{env:}`).

**Interfaces:**
- Consumes: `Task 9` api (save via pending edits → `saveConfig({doc:"models", ...})`); `LOCAL_PRESETS`, `BUILTIN_PROVIDER_IDS`, `classifyKey`, `PathEdit`.
- Produces:
```ts
// provider-logic.ts (pure, unit-pinned)
export interface ProviderEntryView { id: string; name?: string; baseUrl?: string; api?: string;
  apiKey?: string; builtinReroute: boolean; modelCount: number; overrideCount: number }
export function parseProviders(doc: JsonValue): ProviderEntryView[]
//   builtinReroute = id ∈ BUILTIN_PROVIDER_IDS; unknown top-level shapes
//   (non-object entries) are returned with a synthetic `shapeError: true` flag
//   → list renders them read-only with a "edit in Raw tab" note
export function classifyDeleteRename(...) — NOT needed: rename = delete+create edits (sister pattern)
export function addProviderEdits(id: string, preset: LocalPreset | null): PathEdit[]
//   {} entry, or preset: baseUrl/api/apiKey when non-empty
// rename/delete follow the sister's delete+create edit-pair pattern
// JsonField.tsx
export function JsonField(props: { label: string; value: JsonValue | undefined;
  onChange: (v: JsonValue | undefined) => void; deleteWhenUndefined?: true }): JSX.Element
//   textarea of JSON; local parseJsonc on blur; invalid → red border + message,
//   keeps last good value; undefined/empty → deletes the path
```
- `ProviderEditor` fields: `name`, `baseUrl`, `api` (datalist: the four documented API families + `openai-codex-responses`, free text allowed), `apiKey` (masked input; `[env]` wrap/unwrap helper writing `$NAME`; if `classifyKey==="command"` show read-only `!command` notice + [paste key to test] one-off field feeding `probe` only), headers key/value rows, `authHeader` checkbox, provider `compat` as `JsonField`. Models + modelOverrides sections are Task 11 mounts: render `<ModelSections providerId models overrides onEdits/>` imported from `ModelSections.tsx` created in Task 11 — create a stub export in this task so the tree compiles.
- Presets dialog ("Add local endpoint…"): preset radio list from `LOCAL_PRESETS` + free provider-id (datalist of `BUILTIN_PROVIDER_IDS` + suggested custom ids); on create: `addProviderEdits` + open the editor with `probe` auto-run when baseUrl is a localhost URL.

- [ ] **Step 1:** `provider-logic.test.ts` pins: parse of a commented sample (providers with models + overrides counts; reroute flag for `"anthropic"` with only baseUrl; non-object entry flagged read-only); `addProviderEdits("ollama", ollamaPreset)` yields `path ["providers","ollama"]` with the three fields; free-id yields `{}` value.
- [ ] **Step 2:** Run — FAIL; implement `provider-logic.ts`; PASS.
- [ ] **Step 3:** `JsonField.test.tsx`? — keep logic out of JSX: no test needed beyond compile; implement component. Implement list/editor/dialog wiring edits through the pending-edits pattern (dirty draft, per-doc staleness) from the sister components; keep CSS classes from copied `styles.css` (extend as needed in `pi-config-gui/src/ui/styles.css`).
- [ ] **Step 4:** `npm run typecheck && npm run build`; manual check against a real `~/.pi/agent` copy. Commit `feat(pi-config-gui): providers list, preset endpoint dialog, provider editor, JsonField`.

### Task 11: Model + modelOverrides editors

**Files:**
- Create: `pi-config-gui/src/ui/components/ModelSections.tsx`, `pi-config-gui/src/ui/components/ModelEditor.tsx`, `pi-config-gui/src/ui/components/CostEditor.tsx`, `pi-config-gui/src/ui/model-logic.ts`, `pi-config-gui/test/ui/model-logic.test.ts`

**Interfaces:**
- Consumes: `PathEdit`, `JsonField` (Task 10), probe dialog (`api.probe` from Task 9).
- Produces:
```ts
// model-logic.ts (pure)
export function addModelEdits(providerId: string, id: string): PathEdit[]
export function setModelFieldEdits(providerId: string, index: number,
  field: string, value: JsonValue | undefined): PathEdit[]   // undefined deletes
export function mergeImportEdits(providerId: string, existingIds: string[],
  pickedIds: string[]): PathEdit[]
//   ONLY ids not in existingIds (Review Focus: probe re-run never overwrites);
//   each added entry = { id, contextWindow: 128000, maxTokens: 16384 }
export function addOverrideEdits(providerId: string, modelId: string): PathEdit[]
```
- `ModelEditor`: `id`, `name`, per-model `api`/`baseUrl` (blank = delete), `reasoning` checkbox, `input` text/image checkboxes, `contextWindow`/`maxTokens` numeric, `cost` via `CostEditor` (four USD/M numbers + `tiers` rows `inputTokensAbove|input|output|cacheRead|cacheWrite`), then `JsonField`s for `compat`, `samplingParams`, `samplingParamsByThinkingLevel`, `thinkingLevelMap`, `inputLimits`, `promptCache`, plus headers rows.
- Import dialog: [Probe] → `api.probe({baseUrl, apiKey})`; `command_key` error → "resolve the key to test" notice; result list with checkboxes pre-checked for unseen ids only (ids already in the file render disabled + "already configured"); Import → `mergeImportEdits`; imported rows badge "review limits" (UI state only).
- `ModelSections`: models array table + add/delete (confirm) + key rename via delete+create, `modelOverrides` section (fields minus `id`/`api`/`baseUrl`, per-model override note "unknown ids are ignored by pi").

- [ ] **Step 1:** `model-logic.test.ts` pins (esp.): `mergeImportEdits("p", ["a"], ["a","b"])` returns exactly one edit adding `b` with the default limits and NO edit touching `a`; `setModelFieldEdits(...,"reasoning",undefined)` deletes the path.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Implement the three components + wire into `ProviderEditor`; typecheck/build green. Commit `feat(pi-config-gui): model and modelOverrides editors with probe-merge import`.

### Task 12: API Keys tab (auth.json)

**Files:**
- Create: `pi-config-gui/src/ui/components/AuthKeysTab.tsx`, `pi-config-gui/src/ui/components/AuthEntryEditor.tsx`, `pi-config-gui/src/ui/auth-logic.ts`, `pi-config-gui/test/ui/auth-logic.test.ts`

**Interfaces:**
- Consumes: `api.getConfig/saveConfig({doc:"auth", edits, baseText})` (Task 9), `classifyKey` (Task 6).
- Produces:
```ts
// auth-logic.ts (pure)
export type EntryView = { id: string; kind: "api_key"; key?: string; env: Record<string,string> }
                      | { id: string; kind: "readonly"; type: string }
                      | { id: string; kind: "shape_error" }
export function parseAuthDoc(doc: JsonValue): EntryView[]
export function setEntryEdits(id: string, entry: {key?: string; env?: Record<string,string>},
  previous?: EntryView): PathEdit[]   // full entry rewrite for touched entry ONLY
export function deleteEntryEdits(id: string): PathEdit[]   // value: undefined
```
- Saves send `edits` + `baseText` so the server rebases; on `{kind:"conflict"}` the tab reloads its document and toasts the entry names (Task 9 toast wiring). Unknown `type` or non-object entries → `readonly`/`shape_error` rows with the "managed by /login in pi" note; key row: mask toggle, shows form badge (`literal`/`$ENV`/`!command` per `classifyKey`), `[env]` rows editor for `env`; delete with confirm; add new api_key entry (provider id free text + datalist of `BUILTIN_PROVIDER_IDS`). Banner: "auth.json holds secrets — never commit it".
- [ ] **Step 1:** `auth-logic.test.ts` pins: `parseAuthDoc` matrix (api_key / oauth-ish / non-object); `setEntryEdits` produces ONE path edit at `["<id>"]` leaving siblings unnamed in the payload (Review Focus 5: untouched entries are simply never addressed, server rebase keeps them byte-stable); `deleteEntryEdits` value `undefined`.
- [ ] **Step 2:** FAIL → implement → PASS. **Step 3:** Implement components + wire; typecheck/build. Commit `feat(pi-config-gui): auth.json API-keys tab with rebase-backed saves`.

### Task 13: Docs, polish, full verification

**Files:**
- Create: `pi-config-gui/README.md`; modify: none expected (fix anything the checks surface)

- [ ] **Step 1:** README (sister's structure, pi content): what it edits, agent-dir resolution + `PI_CODING_AGENT_DIR`, pi hint line ("after saving, run `/model` (or `/reload`) in pi to pick changes up"), models.json `//`-comment note + older-pi caveat (pre-PR-#4162 pi rejects comments the file already contains — the GUI preserves, pi parses), security/loopback section, manual publish note (`npm publish` from `pi-config-gui/` only, no CI).
- [ ] **Step 2:** Full gate: in `pi-config-gui/`: `npm run typecheck && npx vitest run && npm run build && npm run smoke` — all PASS; from repo root: `git status --porcelain src test package.json .github` — empty (Global Constraint).
- [ ] **Step 3:** Commit `docs(pi-config-gui): README + final checks`; tag nothing, publish nothing (manual per spec).

---

## Self-review notes

- Spec coverage: Goals 1–2 → Tasks 2/8; 3 → 2/4/9; 4 → 10/11 (merge semantics in 11); 5 → 10; 6–7 → 11; 8 → 12; 9 → 3; 10 → 9; 11 → 4/5; 12 → 1. Non-goals enforced by omission; anti-goals pinned in Review Focus tests.
- Interface consistency: `DocId` (core `"models"|"auth"|"settings"|"mcp"|"keybindings"`) narrows to `"models"|"auth"` only in `ui/api.ts`; `SaveResult` union in api.ts mirrors server `SaveWritten|SaveStale|SaveBlocked|SaveConflict` + HTTP error.
- `applyPathEdits` is shared client/server (Task 1's `editor-path.ts`), which is what makes server-side rebase (Task 5) apply identical edits.
