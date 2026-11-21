# pi-config-gui — Design

Date: 2026-11-21
Status: draft (pending partner approval)
Author: Ranger 1 + partner brainstorm
Sister project: `docs/superpowers/specs/2026-11-19-opencode-config-gui-design.md`

## Intent and why

Pi (pi.dev, the earendil-works terminal coding agent) is configured for model
providers through `~/.pi/agent/models.json` (custom endpoints, model entries,
`modelOverrides`) and `~/.pi/agent/auth.json` (stored API keys and OAuth
credentials). For the partner's main audience — people serving models on their
own box with Ollama, LM Studio, vLLM, or a llama.cpp router — connecting that
endpoint means hand-writing a provider block: the right `baseUrl`, the right
`api` string (`openai-completions`, `openai-responses`, `anthropic-messages`,
…), a dummy `apiKey`, and one entry per model with `contextWindow`/`maxTokens`
guesswork. The pi docs themselves acknowledge this gap (installation "doesn't
help you create default models.json for local LLMs").

The partner wants a sibling to `opencode-config-gui`, built from the same
proven parts, that makes the local-endpoint flow point-and-click: pick a
preset, probe the running server, import the model list, save. Hosted-provider
API keys are managed secondarily via `auth.json`.

Success looks like: a local-models friend runs `npx pi-config-gui`, adds their
Ollama with two clicks plus a probe-import, hits save, opens `pi`, and `/model`
shows the models — with their file's comments and formatting preserved.

## Goals

1. One-command start: `npx pi-config-gui` boots a loopback-only server and
   opens the browser, mirroring the opencode app's UX and CLI flags
   (`--port`, `--no-open`, and `--agent-dir` in place of `--folder`).
2. Agent-directory handling: resolve the agent dir as `--agent-dir` flag >
   `PI_CODING_AGENT_DIR` env > `~/.pi/agent` (Windows: `%USERPROFILE%\.pi\agent`).
   No project-level `.pi` handling, no ancestor walks.
3. Two managed documents (the "document pipeline", see Approach):
   - `models.json` — full editor (providers, models, overrides).
   - `auth.json` — API-key entries editable; OAuth/unknown credential types
     displayed read-only and never rewritten.
   - `settings.json`, `mcp.json`, `keybindings.json` — detected and shown
     as existing, never edited, never written.
4. Hero flow, "Add local endpoint": preset picker (Ollama, LM Studio, vLLM,
   llama.cpp router, generic OpenAI-compatible) that pre-fills `baseUrl`,
   `api`, and a placeholder `apiKey`; then server-side probe of
   `{baseUrl}/models` and checkbox import of what's actually serving
   (imported models get pi's schema defaults `contextWindow: 128000`,
   `maxTokens: 16384`, marked for review). Probe reuses the opencode app's
   key-scrubbing rules.
5. Provider editor for `models.json` providers: `name`, `baseUrl`, `api`
   (select from the four documented API families + free text), `apiKey`
   (masked; supports literal, `$NAME`/`${NAME}` env interpolation, and
   `!command` forms, with wrap/unwrap helpers for the `$NAME` form),
   `headers` key/value rows, `authHeader` toggle, and a provider-level
   `compat` block edited as schema-validated JSON (not field-by-field —
   see Non-goals). Rerouting a built-in provider (setting only `baseUrl`
   under e.g. `"anthropic"`) is the same form opened in "built-in reroute"
   mode; a static list of known built-in provider IDs powers autocomplete
   for new provider IDs.
6. Model editor for `models[].entries`: `id`, `name`, per-model `api`/
   `baseUrl` overrides, `reasoning`, `input` (text/image checkboxes),
   `contextWindow`, `maxTokens`, `cost` (four required USD/M fields plus
   `tiers` row editor), `headers`, and — as schema-validated JSON
   sub-editors, not hand-built forms — `compat`, `samplingParams`,
   `samplingParamsByThinkingLevel`, `thinkingLevelMap`, `inputLimits`,
   `promptCache`.
7. `modelOverrides` editor: same field set keyed by existing model ID, with
   a UI note that unknown IDs are silently ignored by pi.
8. `auth.json` key editor: list stored credentials; `{"type":"api_key",
   "key":…, "env":{…}}` entries are editable (provider ID, masked key,
   `!command` key form, `env` string-map rows — the Cloudflare-style
   account-ID pattern); entries of any other shape are listed read-only
   ("managed by `/login` / `/logout` in pi") and are byte-stable across
   GUI saves; delete removes the entry (with confirm).
9. Validation against pi's published schema: vendor
   `https://pi.dev/schemas/models.schema.json` at build time (it is
   self-contained, all `$defs` inline, `additionalProperties: true` inside
   `compat`), with the same remote-refresh + disk-cache ladder as the
   opencode app. `auth.json` has no published schema: validate against a
   small hand-written schema covering the documented credential shapes,
   permissive about unknown entry shapes it doesn't understand.
10. Raw JSON tab per document (full-text editing through the same save
    pipeline), plus a per-document validation panel and schema badge.
11. Save integrity carried over unchanged in spirit: staleness check
    (sha256 vs. disk → offer Reload / Force-save), block only *newly
    introduced* validation errors, exclusive timestamped backups, atomic
    write via temp + rename. Editing is surgical path-edits so formatting,
    key order, and existing `//` comments in `models.json` are preserved.
12. Cross-platform: Windows/macOS/Linux, same CI matrix as the sister app.

## Non-goals

- Editing `settings.json`, `mcp.json`, keybindings, themes, skills,
  extensions, or anything project-level under `.pi/`.
- OAuth login/logout flows (pi owns those; the GUI never triggers them).
- A built-in model catalog browser. Overlay-only view: the GUI shows what
  is in `models.json` (+ `auth.json`), with static ID lists only as
  autocomplete hints. Partner explicitly chose this.
- Field-by-field forms for `compat` and friends (dozens of fields per API
  family; schema-validated JSON editing + rich docs in the schema itself
  is enough).
- Migrating/normalizing anything (pi has no legacy config shape).
- Showing which models are *available* in a running pi (that would mean
  reading pi's install/state; deliberately out).
- Multiple agent dirs / profile switching.

## Anti-goals

- Rewriting or reformatting `auth.json` wholesale, or touching OAuth
  entries at all.
- Writing `/* */` block comments or non-`//` constructs pi's loader can't
  read (`models.json` accepts `//` line comments and trailing commas since
  pi PR #4162; older pi versions reject even those — we preserve what's
  there and write none ourselves).
- Shipping a "helpful" default `models.json` that silently adds providers
  the user didn't ask for. New files are created only on first explicit
  save, seeded with `{ "$schema": "https://pi.dev/schemas/models.schema.json", "providers": {} }`
  (models.json) or `{}` (auth.json).
- Leaking secrets: probe output and logs scrub keys (existing rules);
  API key values are never echoed in validation messages.

## Constraints

- Pure TypeScript, ESM, Node ≥ 20; React 19 + hand-written CSS, no
  component/router/state libraries — identical stack to the sister app.
- Self-contained fork inside `pi-config-gui/`: own `package.json`, tsconfigs,
  vite/vitest configs, scripts, tests, README, launch scripts. No imports
  across the folder boundary; the opencode app's tree stays byte-identical.
  (Partner's call: fork-in-subfolder now; possibly a real git fork/branch
  later.)
- Security model unchanged: bind `127.0.0.1` only, local-Host/Origin gate,
  no auth, no CORS; writable paths restricted to the resolved agent dir.
- Secret files are handled as the user's own files: the GUI can display
  and edit `auth.json` keys (masked in the UI) because it runs loopback
  on the user's machine with their own file permissions. On POSIX, when
  *creating* `auth.json`, create it `0600`.

## Approaches

Considered for "how does one app manage two config documents":

1. **Generalize the document pipeline (chosen).** Promote "document" to a
   first-class concept in discovery and the API: `/api/state` reports the
   agent dir and its documents (kind: `models` | `auth` | `readonly`;
   exists; editable); `/api/config` and `/api/config/save` take a `doc`
   selector; the vet/backup/atomic-save/staleness pipeline runs per
   document, each with its own validator. Trades one risky-but-tested
   refactor for maximal reuse: the UI's dirty-draft/staleness handling,
   path-edit machinery, and Raw tab work on both docs for free.
2. Two separate API surfaces (`/api/models…`, `/api/auth…`) sharing only
   `saveValidated`. Rejected: duplicates the dirty-state dance per
   document — historically where this app's subtle bugs lived.
3. Fresh minimal scaffold reusing patterns only. Rejected: throws away
   ~60% of the sister app's battle-tested code (save integrity, security
   guards, packaging, tests).

Previously settled with the partner: self-contained fork in a subfolder
(vs. shared-code monorepo, which risks dragging the stable opencode app).

## Chosen-by-partner decisions

- Scope B: `models.json` + `auth.json` managed; settings/mcp out.
- Catalog stance A: overlay-only, no catalog fetch (audience is local-
  endpoint users, not hosted-model browsing).
- Self-contained fork in `pi-config-gui/`, built and run entirely from
  there.
- Build via Approach 1.

## Left to the builder

- Exact preset table: ports for Ollama (`:11434/v1`), LM Studio
  (`:1234/v1`), vLLM (`:8000/v1`), llama.cpp router (check pi's
  `llama-cpp.md` for the router's actual default port/base URL) and the
  placeholder `apiKey` each preset writes.
- The static list of known built-in provider IDs for autocomplete (from
  pi's providers docs; keep it a tiny data file, staliness tolerated).
- `thinkingLevelMap` UX: JSON sub-editor (acceptable) vs. level rows.
- Whether to port the GitHub release workflow (six bun-compiled binaries)
  in v1 or ship npm-only first — recommend npm-first, wire releases after
  the app is stable.
- Depth of the `auth.json` hand-written schema (at minimum: known
  credential types validated, unknown types accepted with a warning).
- Test fixtures: hand-write a realistic commented `models.json` and an
  `auth.json` mixing api_key and OAuth-style entries (redacted, invented).
- Porting mechanics: copy the portable modules, then rename/trim; drop
  `migrate.ts`, MCP editors, `{env:}` wrappers, v1/v2 shape detection,
  opencode discovery/paths, and their tests.
- How "detected read-only" files (settings/mcp) are surfaced — a modest
  info strip in the header, not a tab.

## Shape of the UI (agreed sketch)

```
pi-config-gui — agent dir: ~/.pi/agent        [schema: pi models.json ✓]
[ Providers & Models ]  [ API Keys ]  [ Raw JSON ]

Providers & Models (models.json)
  providers: [ollama +] [lmstudio +] [+ Add local endpoint…]
    ollama   http://localhost:11434/v1   openai-completions   models(3)
      "qwen2.5-coder:7b"   reasoning ☐   ctx 128000   out 16384
      [probe → import models]        [delete provider]
  (built-in reroutes and modelOverrides listed in a secondary "Advanced" section)

API Keys (auth.json)
  anthropic    api key  [•••••••]  [show] [edit] [remove]
  openai       api key  [•••••••]  env: 1 row
  github-copilot  OAuth — managed by /login in pi   [read-only badge]
```
