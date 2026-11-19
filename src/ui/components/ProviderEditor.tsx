import { useState } from "react";

import type { JsonValue, PathEdit } from "../../core/types";
import type { ToastKind } from "../App";
import { ApiKeyField } from "./ApiKeyField";
import { EndpointPanel } from "./EndpointPanel";
import { ModelEditor } from "./ModelEditor";
import type { DocShape } from "./ProviderList";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

/** Preset `package` values per doc shape (from the v1→v2 migration map). */
const PRESETS: { label: string; v1: string; v2: string }[] = [
  { label: "openai-compatible", v1: "@ai-sdk/openai-compatible", v2: "@opencode/ai/providers/openai-compatible" },
  { label: "openai", v1: "@ai-sdk/openai", v2: "@opencode/ai/providers/openai" },
  { label: "anthropic", v1: "@ai-sdk/anthropic", v2: "@opencode/ai/providers/anthropic" },
  { label: "google", v1: "@ai-sdk/google", v2: "@opencode/ai/providers/google" },
  { label: "google-vertex", v1: "@ai-sdk/google-vertex", v2: "@opencode/ai/providers/google-vertex" },
];

/** Local-runtime presets: no `package` key is written and the model list is omitted. */
const LOCAL_PRESETS = ["ollama", "lmstudio", "vllm"];

const PLACEHOLDER_LIMIT: Obj = { context: 128000, output: 8192 };

interface ProviderEditorProps {
  /** The provider's parsed object (already shape-tagged by ProviderList). */
  entryId: string;
  /** Where this provider lives: v1 `provider` or v2 `providers` container. */
  entry: Obj;
  /** Key-path of the provider: `["provider", id]` or `["providers", id]`. */
  path: (string | number)[];
  /** All OTHER provider ids in the same container (rename collision checks). */
  otherIds: string[];
  /** Field spelling for THIS entry, derived from its own CONTAINER (`entryShape`). */
  shape: DocShape;
  apply: (edits: PathEdit[]) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  /** After a committed ID rename, so the parent can move the selection. */
  onRenamed: (newId: string) => void;
}

/**
 * Structured editor for one provider, reading/writing the KEYS of its own
 * doc shape: v1 `npm`/`options`/variant-map, v2 `package`/`settings`/
 * variant-array. `headers` is v2-only (the v1 schema has no such key).
 * ID rename = delete-old + create-new edit pair in one `apply` call.
 */
export function ProviderEditor({
  entryId,
  entry,
  path,
  otherIds,
  shape,
  apply,
  onToast,
  onRenamed,
}: ProviderEditorProps) {
  const [idDraft, setIdDraft] = useState(entryId);
  const packageKey = shape === "v1" ? "npm" : "package";
  const optionsKey = shape === "v1" ? "options" : "settings";
  const options = isObj(entry[optionsKey]) ? (entry[optionsKey] as Obj) : {};
  const models = isObj(entry["models"]) ? (entry["models"] as Obj) : {};
  const presetValue = asStr(entry[packageKey]);
  const [presetOverride, setPresetOverride] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState("");

  // Which select option is active: derived from the stored value when it is a
  // known package; otherwise from this session's choice (local runtimes and
  // blank store NO package, so the file itself cannot tell them apart).
  const storedPreset = PRESETS.find((preset) => preset[shape] === presetValue);
  const activePreset = presetValue !== "" ? (storedPreset?.label ?? "custom") : (presetOverride ?? "blank");
  const isLocalPreset = LOCAL_PRESETS.includes(activePreset);

  const commitRename = (): void => {
    const next = idDraft.trim();
    if (next === "" || otherIds.includes(next)) {
      setIdDraft(entryId);
      return;
    }
    if (next === entryId) return;
    apply([
      { path, value: undefined },
      { path: [...path.slice(0, -1), next], value: entry },
    ]);
    onRenamed(next);
  };

  const setOption = (key: string, value: JsonValue | undefined): void => {
    apply([{ path: [...path, optionsKey, key], value }]);
  };

  const importModels = (ids: string[]): void => {
    const edits: PathEdit[] = ids
      .filter((id) => !(id in models))
      .map((id) => ({
        path: [...path, "models", id],
        value: { name: id, limit: { ...PLACEHOLDER_LIMIT } } satisfies Obj,
      }));
    if (edits.length === 0) {
      onToast("All fetched models are already listed — nothing imported.");
      return;
    }
    apply(edits);
    onToast(
      `Imported ${edits.length} model(s) with placeholder limits (context ${PLACEHOLDER_LIMIT["context"]} / output ${PLACEHOLDER_LIMIT["output"]}) — edit these.`,
    );
  };

  return (
    <div className="provider-editor">
      <div className="field-grid">
        <label>
          <span className="field-label">ID (rename = delete + re-create)</span>
          <input
            type="text"
            spellCheck={false}
            value={idDraft}
            onChange={(event) => setIdDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
          />
        </label>
        <label>
          <span className="field-label">Display name</span>
          <input
            type="text"
            spellCheck={false}
            value={asStr(entry["name"])}
            onChange={(event) =>
              apply([
                { path: [...path, "name"], value: event.target.value === "" ? undefined : event.target.value },
              ])
            }
          />
        </label>
      </div>

      <div className="preset-row">
        <span className="field-label">Preset {packageKey}</span>
        <select
          value={activePreset}
          onChange={(event) => {
            const label = event.target.value;
            setPresetOverride(label);
            const preset = PRESETS.find((candidate) => candidate.label === label);
            if (preset !== undefined) {
              apply([{ path: [...path, packageKey], value: preset[shape] }]);
            } else if (label !== "custom") {
              // blank / ollama / lmstudio / vllm: no package key is written.
              apply([{ path: [...path, packageKey], value: undefined }]);
            }
          }}
        >
          {PRESETS.map((preset) => (
            <option key={preset.label} value={preset.label}>
              {preset.label}
            </option>
          ))}
          {LOCAL_PRESETS.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
          <option value="blank">blank</option>
          <option value="custom">custom…</option>
        </select>
        {activePreset === "custom" && (
          <input
            className="preset-free"
            type="text"
            spellCheck={false}
            placeholder={shape === "v1" ? "@ai-sdk/… npm package" : "package (e.g. @opencode/ai/providers/…)"}
            value={presetValue}
            onChange={(event) =>
              apply([
                {
                  path: [...path, packageKey],
                  value: event.target.value === "" ? undefined : event.target.value,
                },
              ])
            }
          />
        )}
        {isLocalPreset && (
          <span className="hint">
            local runtime: no {packageKey} key and the model list is provided by opencode at runtime
          </span>
        )}
      </div>

      <div className="field-grid">
        <label>
          <span className="field-label">settings.baseURL</span>
          <input
            type="text"
            spellCheck={false}
            value={asStr(options["baseURL"])}
            onChange={(event) => setOption("baseURL", event.target.value === "" ? undefined : event.target.value)}
          />
        </label>
        <ApiKeyField
          label="API key"
          value={options["apiKey"]}
          onChange={(next) => setOption("apiKey", next)}
        />
      </div>

      <div className="endpoint-block">
        <span className="field-label">Endpoint</span>
        <EndpointPanel
          baseURL={asStr(options["baseURL"])}
          apiKey={typeof options["apiKey"] === "string" && !/^\{(env|file):/.test(options["apiKey"]) ? options["apiKey"] : undefined}
          onImport={importModels}
          onToast={onToast}
        />
      </div>

      <EnvRows env={Array.isArray(entry["env"]) ? (entry["env"] as JsonValue[]) : undefined} path={path} apply={apply} />
      {shape === "v2" && (
        <HeaderRows headers={isObj(entry["headers"]) ? (entry["headers"] as Obj) : undefined} path={path} apply={apply} />
      )}

      {!isLocalPreset ? (
        <div className="model-list">
          <span className="field-label">Models ({Object.keys(models).length})</span>
          {Object.entries(models).map(([modelId, model]) =>
            isObj(model) ? (
              <div className="model-card" key={modelId}>
                <ModelEditor
                  modelsPath={[...path, "models"]}
                  modelId={modelId}
                  siblingIds={Object.keys(models).filter((other) => other !== modelId)}
                  model={model}
                  shape={shape}
                  apply={apply}
                />
              </div>
            ) : (
              <div className="warning-banner" key={modelId}>
                <code>{modelId}</code>: model entry is not an object — edit it in the Raw JSON tab
              </div>
            ),
          )}
          <div className="model-add">
            <input
              type="text"
              spellCheck={false}
              placeholder="new model id (e.g. Qwen3.8-Flash-Next)"
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addModel();
              }}
            />
            <button type="button" onClick={addModel} disabled={newModelId.trim() === "" || newModelId.trim() in models}>
              + add model
            </button>
          </div>
        </div>
      ) : (
        <div className="model-list">
          <span className="field-label">Models</span>
          <div className="hint">
            the {activePreset} local-runtime preset omits the model list;{" "}
            {Object.keys(models).length > 0
              ? `${Object.keys(models).length} entr(ies) remain in the file (edit in Raw JSON).`
              : "nothing to list."}
          </div>
        </div>
      )}
    </div>
  );

  function addModel(): void {
    const id = newModelId.trim();
    if (id === "" || id in models) return;
    apply([{ path: [...path, "models", id], value: {} }]);
    setNewModelId("");
  }
}

function EnvRows({
  env,
  path,
  apply,
}: {
  env: JsonValue[] | undefined;
  path: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}) {
  const rows = env ?? [];
  return (
    <div className="kv-block">
      <span className="field-label">env (variable names)</span>
      {rows.map((row, index) => (
        <div className="kv-row" key={index}>
          <input
            type="text"
            spellCheck={false}
            value={asStr(row)}
            onChange={(event) =>
              apply([{ path: [...path, "env", index], value: event.target.value }])
            }
          />
          <button
            type="button"
            onClick={() => apply([{ path: [...path, "env"], value: rows.filter((_, i) => i !== index) }])}
          >
            ✕
          </button>
        </div>
      ))}
      {/*
       * "+ env var" persists an empty string AT THE NEXT INDEX (the
       * SettingsCells "+ key" pattern): the row renders from the doc and is
       * editable. An unfilled "" entry is a legal string element; deleting a
       * row rewrites the array, so no empty rows are ever written as debris
       * by removal.
       */}
      <button type="button" onClick={() => apply([{ path: [...path, "env", rows.length], value: "" }])}>
        + env var
      </button>
    </div>
  );
}

function HeaderRows({
  headers,
  path,
  apply,
}: {
  headers: Obj | undefined;
  path: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}) {
  const entries: [string, string][] = Object.entries(headers ?? {}).map(
    ([key, value]) => [key, asStr(value)] as [string, string],
  );
  // Key renames/removals rewrite the object and DROP empty-key rows (a ""
  // header name is meaningless on save); value edits are path-addressed so an
  // added row with a still-empty key keeps rendering and stays editable.
  const rewrite = (next: [string, string][]): void => {
    const cleaned = next.filter(([key]) => key !== "");
    const value: Obj = {};
    for (const [key, headerValue] of cleaned) value[key] = headerValue;
    apply([{ path: [...path, "headers"], value: cleaned.length === 0 ? undefined : value }]);
  };
  const replace = (index: number, next: [string, string]): void => {
    rewrite(entries.map((entry, i) => (i === index ? next : entry)));
  };
  return (
    <div className="kv-block">
      <span className="field-label">headers</span>
      {entries.map(([key, value], index) => (
        <div className="kv-row" key={index}>
          <input
            type="text"
            spellCheck={false}
            value={key}
            onChange={(event) => replace(index, [event.target.value, value])}
          />
          <input
            type="text"
            spellCheck={false}
            value={value}
            onChange={(event) => apply([{ path: [...path, "headers", key], value: event.target.value }])}
          />
          <button type="button" onClick={() => rewrite(entries.filter((_, i) => i !== index))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={entries.some(([key]) => key === "")}
        onClick={() => apply([{ path: [...path, "headers", ""], value: "" }])}
      >
        + header
      </button>
    </div>
  );
}
