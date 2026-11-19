# Spike notes — verified v2 provider shape (Task 2, 2026-11-19)

Environment: OpenCode CLI **v2.2.7** (`resources/opencode-cli.exe` from the
desktop install), live local OpenAI-compatible endpoint
`http://127.0.0.1:8080/v1` (currently serving `Qwen3.8-Flash-Next`),
scratch project `opencode.json` = `test/fixtures/opencode.v2.golden.json`.

Ruling (controller): the plan's Maya `glm-5.3-flash` model was not being
served by the endpoint at spike time (only `Qwen3.8-Flash-Next`), so the
verification used the served model ID. The verified artifact is the provider
*shape* (package + settings + variants-array), which is model-ID-independent;
Task 4's migration tests compare the variants-array shape, not the model ID.

## Fixture-local deviations from the brief shape

The committed golden differs from the brief's Step 1 sketch in two further
ways, both deliberate: (a) the variant set was reduced to the two levels the
spike actually exercised (`high`, `low`) instead of the brief's four
(`high`/`medium`/`low`/`none`) — the migrator's shape contract is per-variant
`{id, settings}`, independent of how many variants a model declares, so the
smaller set verifies the same contract; (b) `limit.output` was set to the
served model's capacity at spike time (32000) rather than the brief's 60000,
so the fixture describes a config that actually ran. Consequently, Task 4's
migration tests must derive variant-count and variant-content assertions from
the v1 fixture's own variant maps, and use this golden only for the
per-variant `{id, settings}` shape and the provider-key shape.

## Verified

1. `package: "@opencode/ai/providers/openai-compatible"` +
   `settings.baseURL` — provider initialized, no `@ai-sdk/*` needed.
2. `models.<id>.variants: [{ id, settings: { reasoningEffort } }]` —
   registered and selectable:
   - `opencode run --model "Maya/Qwen3.8-Flash-Next#bogus"` →
     `Error: Variant unavailable for Maya/Qwen3.8-Flash-Next: bogus`
     (proves the variants array, not catalog defaults, drives availability)
   - `#low`  → completed ("OK")
   - `#high` → completed, correct arithmetic ("391")
   The brief's "`#high`/`#low` listed by `/models`" check is substituted here
   by the `--model provider/model#variant` CLI acceptance/rejection probe,
   treated as the equivalent check on variant exposure (no interactive
   `/models` listing was captured).
3. No `apiKey` required for this endpoint; omitted `env` is fine.

## Caveats

- The *effect* of `reasoningEffort` values on generation was not measured
  (no server log inspection); what is verified is that the shape loads,
  variants are exposed/validated, and requests complete with the settings
  applied.
- The brief's Step 2 check that "reasoning effort visibly changes" was NOT
  met: variant registration and selection are verified, but the effort
  value's *effect* on generation is not measured. Accepted-risk follow-up:
  Task 4 only needs a schema-and-runtime-valid shape, so this does not
  block migration work.
- Runs executed with the partner's global config also loaded; the spike
  model ID exists only in the project-level golden config, so resolution
  demonstrably used the v2 project block.
- Alternative shape `capabilities.reasoning` was NOT exercised (docs
  describe it; the array form the migrator emits is the verified one).

## Conclusion

The golden fixture (`test/fixtures/opencode.v2.golden.json`) is the exact
config that ran. v1→v2 migration (Task 4) emits this shape:
`npm→package` with the `@opencode/ai/...` rewrite, `options→settings`,
variants map → `[{id, settings}]` array.
