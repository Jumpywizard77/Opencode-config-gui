# opencode-config-gui — Design

Date: 2026-11-19
Status: approved by partner (2026-11-19)
Author: Ranger 1 + partner brainstorm

## Intent and why

OpenCode's configuration (`opencode.json` / `opencode.jsonc`) is powerful but
painful to edit by hand — especially adding model providers. Adding a local
OpenAI-compatible endpoint (llama.cpp, llama-swap, LM Studio, Ollama-style
servers) today means hand-typing provider blocks, model IDs, context/output
limits, and `reasoningEffort` variants, while the v1→v2 schema migration makes
matters worse: the old `provider`/`plugin`/flat-`mcp` keys still work but are
deprecated in favor of `providers`/`plugins`/`mcp.servers`.

The partner wants a shareable graphical config editor, aimed first at that
provider-setup pain, that ordinary OpenCode users can run with one command.
Success looks like: a friend can point it at their global config, add a local
provider, import its model list from the running endpoint, hit save, and have
OpenCode pick it up — with valid JSON preserved and comments intact.

Audience: OpenCode users on Windows/macOS/Linux, comfortable with a terminal
but not with hand-editing this schema. The partner is the primary user and
maintainer; they are not a Rust developer and want a pure-TypeScript project.

## Goals

1. One-command start: `npx opencode-config-gui` starts a local server and
   opens the UI in the default browser.
2. Config discovery: locate OpenCode config files the way OpenCode documents
   them — global `~/.config/opencode/opencode.json(c)`, project-level
   `opencode.json(c)` and `.opencode/opencode.json(c)` (the user picks a
   project folder; we search it and report what we find). System-wide
   (`%ProgramData%\opencode`, `/etc/opencode`, `/Library/Application Support/
   opencode`) and managed configs are **detected read-only** and flagged, not
   edited, in v1.
3. Deep provider editor: list/add/edit/delete providers in the current v2
   shape (`providers.<id>` with `package`, `name`, `env`, `settings`
   including `baseURL`/`apiKey`, `headers`, `models`). Reading a file that
   uses the deprecated v1 `provider` key must work: show those providers,
   mark the file "legacy shape", offer upgrade (below).
4. Model sub-editor per provider: model ID, display name,
   `limit.context`/`limit.output`, `variants` (key → arbitrary options
   object, with `reasoningEffort` as a guided convenience), plus the
   boolean/flag fields the schema allows (`reasoning`, `tool_call`,
   `attachment`, `modalities`, `status`, `cost`…): expose the common ones as
   fields; everything rare stays editable via the raw tab.
5. MCP server editor: local (`command` array, `cwd`, `environment`,
   `enabled`, `timeout`) and remote (`url`, `headers`, `oauth`,
   `enabled`, `timeout`) under `mcp.servers`; global `mcp.timeout` object.
   Legacy flat `mcp` entries (anything not `timeout`/`servers`) are read and
   displayed.
6. Endpoint probe ("Fetch from endpoint"): given a provider's `baseURL`
   (+ API key if set), issue `GET {baseURL}/models` server-side (no CORS
   problems for local LLM servers). Present the returned model IDs with
   checkboxes; imported models get placeholder limits (`context: 128000`,
   `output: 8192`) clearly marked for editing, since most servers don't
   report context sizes. A separate lightweight `[test]` action reports
   reachable / auth-failed / not-OpenAI-compatible / unreachable with the
   underlying error.
7. "Upgrade to v2 schema": convert `provider` → `providers` (`npm` →
   `package`, `options` → `settings`), `plugin` → `plugins`, flat `mcp`
   entries → `mcp.servers`, and any other deprecated top-level keys the
   schema marks (e.g. `command` → `commands`, `agent` → `agents`,
   `permission` → `permissions`) where a mechanical mapping exists. Show a
   reviewable before/after diff; apply only on confirm. Mapping rules that
   are ambiguous (e.g. `agent` → `agents` field-shape differences) may be
   left to the raw tab with a warning — the builder decides per-key after
   checking the schema; nothing may be silently dropped.
   The conversion also includes a **package value rewrite table**, because
   the v2 docs' custom-provider recipe uses native runtime packages
   (`@opencode/ai/providers/openai-compatible` etc.), not `@ai-sdk/*`
   AI SDK packages: v1 `npm: "@ai-sdk/openai-compatible"` maps to v2
   `package: "@opencode/ai/providers/openai-compatible"`, with entries for
   the common `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google*`
   equivalents. Unknown `npm` values are preserved verbatim and flagged in
   the diff as "kept as-is — verify this package loads in OpenCode v2".
   The v2 representation of v1 `variants` is settled from the models
   guide, not guessed: v1 `{key: {opts}}` maps mechanically to the v2
   array form `variants: [{ id, settings }]` (the docs' own example puts
   `reasoningEffort` inside variant `settings`). The modern alternative —
   `capabilities.reasoning: { supported, effort: [...], toggle }`, where
   `toggle: true` yields a `none` variant — builds the same variants
   declaratively and must be offered in the variant sub-editor as an
   "effort levels" quick-config alongside the raw key/value rows. A small
   **runtime spike** (see Implementation notes) still runs first to
   confirm on the partner's OpenCode 2.2.7 that the package rewrite and
   the array-variants form actually work (variant visible in `/models`,
   provider initializes); its verified output is committed as the golden
   fixture for migration tests.
8. Raw JSONC tab for everything else: full-file view/edit with schema
   validation feedback (paths + messages), used for agents, permissions,
   policies, commands, experimental, etc.
9. Schema-validated saves: every save validates the resulting document
   against the OpenCode config JSON Schema (`https://opencode.ai/config.json`)
   and refuses (with clear per-path errors) on hard violations. Ambiguous
   cases (custom keys under `additionalProperties: true` zones) pass.
10. File safety: edits are applied to the parsed document via a
    comment-preserving JSONC edit path so comments, key order, and formatting
    of untouched sections survive; a timestamped backup (
    `opencode.json.bak-YYYYMMDD-HHmmss`) is written next to the file before
    each save; saving writes atomically (temp file + rename).
11. API keys stay in the document by default (matching current user habit),
    with a one-click "move to `{env:VAR}`" / "move to `{file:path}`" action
    that rewrites the value as an OpenCode variable reference.
12. The server binds `127.0.0.1` only and serves a random free port; no
    authentication layer beyond same-origin checks in v1.

## Non-goals (v1)

- Editing auth/credential stores (`auth.json` etc.) — out of scope entirely.
- Editing system-wide/managed config files (detected + flagged only).
- Simulating OpenCode's multi-file merge/precedence result; we edit one
  selected file at a time and merely note that other files exist.
- Electron/Tauri desktop wrapper (explicitly deferred; the server design
  must not preclude adding one later).
- Forms for every config section (agents/permissions/policies/commands live
  in the raw tab in v1).
- Provider marketplaces/templates catalog beyond a small built-in preset
  list (see "Presets" below) — no network catalog.
- Windows/macOS/Linux installer packages.

## Anti-goals

- Producing a config file that OpenCode refuses to load.
- Silent data loss: dropped comments, vanished unknown keys, or overwritten
  files without backups.
- Exfiltrating API keys: the only permitted outbound network calls are
  (a) fetching/refreshing the JSON schema document and (b) requests to
  endpoint URLs the user explicitly typed and triggered. No analytics.

## Constraints

- Pure TypeScript/Node. Partner's machine: Windows 11, Node v24, npm 11, no
  Bun installed. Therefore: develop and run on Node ≥ 20; single-binary
  releases are produced in CI via `bun build --compile` per OS/arch (CI
  installs Bun; the dev machine never needs it).
- Config files may be `.json` or `.jsonc` (comments, trailing commas are
  legal). All parsing must be JSONC-aware.
- The canonical schema evolves; the app must cope with schema drift: fetch
  and cache the remote schema (with app-bundled fallback copy + user-visible
  "refresh schema" action); tolerate validation-library quirks over hard
  crashes.
- `npx opencode-config-gui` must work on all three OSes without native
  build steps (no node-gyp dependencies).
- Test fixture: the partner's real `opencode.json` sits at the repo root as
  a **local-only** file (git- and npm-excluded; see Implementation notes)
  and exercises v1 shapes: 4 `@ai-sdk/openai-compatible` providers with
  `options.baseURL`/`apiKey`, models with `limit` + `variants`, one flat
  `mcp` server, one `plugin` entry. The committed tests use a sanitized
  copy of it that must parse, display, validate, and upgrade correctly.

## Approaches considered

1. **Tauri desktop app** — smallest binaries, installers, full FS + CORS-free
   HTTP. Rejected: Rust toolchain in the build loop; partner doesn't know
   Rust. Audience lives in terminals anyway.
2. **Local-server TypeScript app (CHOSEN)** — Vite+React UI served by a tiny
   Node HTTP server that owns all filesystem and endpoint-probe work.
   Distributed via npm (`npx`) plus single-file binaries from CI. Full path
   detection, CORS-free probes, zero Rust, and a later Electron/Tauri wrapper
   remains a thin packaging step. Trade-off: UI lives in a browser tab, not a
   native window; no installer.
3. **Pure browser SPA on GitHub Pages** — zero install, but fails must-haves:
   no arbitrary-path config detection, and CORS blocks most local model
   servers' `/models` endpoints. Rejected.

Electron and pywebview were dropped as heavier paths to the same place as #2;
Wails/Neutralino only make sense with Go/JS-shell preferences the partner
doesn't have.

## Decided by the partner

- Shareable app (not personal-only); local-server form factor; deep
  provider/MCP editors + raw JSONC tab (not whole-config forms).
- "Read old, write new" migration posture: v1 files are readable/editable,
  upgrade to v2 is an explicit, diff-reviewed action.

## Design decisions (mine, correctable)

- **Stack**: TypeScript everywhere; `node:http` + a thin router (Fastify
  allowed if it stays dependency-light); Vite + React for the UI;
  `comment-json` (or equivalent comment-preserving parser) for config IO;
  `ajv` for schema validation. One npm package; UI built and served as
  static assets by the server in production mode.
- **Architecture**: `core/` (pure: config model, migration rules, probe
  client, validator — no I/O side effects beyond injectable fs/http ports),
  `server/` (thin HTTP + fs glue), `ui/` (React). Business logic must not
  import framework code, so a future desktop shell reuses `core/`.
- **Config file selection UX**: on start the server auto-detects the global
  config; UI shows a config picker (global, detected project configs, or
  "open folder…"), path display, and read-only badges for
  system/managed/`ProgramData` locations.
- **Probe protocol**: OpenAI-compatible `GET {baseURL}/models` with
  `Authorization: Bearer <key>` when a key is set (also try without).
  Timeout ~10 s. Follow `<baseURL>/chat/completions`-style normalization:
  if `baseURL` ends with `/v1`, request `{baseURL}/models`, else try
  `{baseURL}/v1/models` as fallback. Response parsed for `data[].id`.
  Never log key material.
- **Variant editing**: variants are free-form objects; UI presents key/value
  rows with `reasoningEffort` quick-add presets (none/low/medium/high/xhigh)
  mirroring the partner's existing style.
- **Presets**: "Add provider" offers a small built-in preset menu —
  "OpenAI-compatible (local or remote)", "Anthropic", "OpenAI", "Google",
  each prefilling `package` and common settings — plus blank. No network
  lookups of provider catalogs in v1 (models.dev integration deferred).
- **Save flow**: UI sends the *whole edited document* to the server only for
  validation; the server diffs against the on-disk document and applies a
  minimal patch through the comment-preserving editor (this also implements
  comment preservation on structured edits).
  Builder may simplify to comment-aware re-serialization of the touched
  subtree if patching proves fragile, as long as untouched sections keep
  comments and layout.
- **Security**: bind `127.0.0.1`; validate `Origin`/`Host` headers on the
  API; no CORS headers on API routes; schema fetch via HTTPS GET only.
- **Validation/save policy for already-invalid files**: a save is blocked
  only by validation errors **newly introduced** by the edit. Pre-existing
  violations in untouched parts of the file are surfaced as a persistent
  warnings panel (path + message) but never block saves — otherwise a
  friend's stray unknown key (the root schema is `additionalProperties:
  false`) would lock them out of the structured editors for something they
  didn't touch. Rationale: the tool's job is to not make things worse.
- **OpenCode version awareness (minimal)**: on start, if an `opencode`
  binary is on `PATH`, the server runs `opencode --version` once
  (best-effort, never fatal) and shows the detected version in the UI.
  The upgrade-diff preview carries a standing notice: "v2 keys require a
  recent OpenCode release (your detected version: X / unknown)". No
  gating, no compatibility matrix in v1.
- **Presets, local-runtime note**: OpenCode v2 has built-in discovery
  runtimes for Ollama, LM Studio, and vLLM (provider IDs `ollama`,
  `lmstudio`, `vllm`; models auto-discover). The preset menu should offer
  these three as special entries that only set `settings.baseURL`/`apiKey`
  (no `package`, no manual model list), distinct from the generic
  "OpenAI-compatible" preset where the GUI's own endpoint probe fills
  models.
- **Distribution**: npm package with `bin` entry; CI (GitHub Actions) runs
  tests on push and on tag builds 6 Bun-compiled binaries
  (win/linux/darwin × x64/arm64) attached to a GitHub Release. README leads
  with `npx opencode-config-gui`.
- **Versioning of this tool**: plain semver; no relation to OpenCode's version.

## Left to the builder

- Exact router/UI library details (component library vs hand-rolled CSS),
  table/form layout aesthetics.
- The precise deprecated-key mapping table for the upgrade feature, derived
  from the live schema's `deprecated: true` entries; anything not safely
  mechanical is listed in the diff preview as "left unchanged — see docs".
- Handling of pathological inputs (huge configs, duplicate keys, BOM, CRLF)
  — prefer preserving bytes of untouched regions.
- Whether "Revert" means reload-from-disk only, or also an in-session undo
  stack (either acceptable; reload-from-disk is the floor).
- Test split across core/server; Playwright or none for UI smoke tests in v1
  (core logic must be unit-tested, including the migration rules against the
  partner's fixture file).

## Implementation notes

- **Spike first**: the v1→v2 `package` value rewrite and `variants` array
  form are documented (models guide) but must be confirmed against the
  partner's live OpenCode 2.2.7 before the migrator is coded around them.
  First work item: hand-migrate the fixture's smallest provider ("Maya")
  to v2, run OpenCode, confirm the provider initializes and its reasoning
  variants appear and are selectable. The verified block is committed as
  the golden fixture for migration unit tests; every later migration rule
  test derives from that shape. If the spike contradicts the docs, the
  spike wins and Goal 7's variant mapping is revised accordingly.
- **Fixture handling (partner instruction, 2026-11-19)**: the repo-root
  `opencode.json` is the partner's real config with live (being-rotated)
  local keys. It is a **local-only development fixture**: never committed
  to git, never included in the npm package or release artifacts
  (`.gitignore` entry + explicit `files` allow-list in `package.json`).
  Unit tests run against a sanitized copy under `test/fixtures/` with
  placeholder credentials (`sk-test-…`) and parameterized paths, created
  once at test-scaffold time and thereafter maintained in-repo.
  The partner is rotating the original keys independently of this project.
