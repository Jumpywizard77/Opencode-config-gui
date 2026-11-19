import { useState } from "react";

import type { JsonValue, PathEdit } from "../../core/types";
import type { DocShape } from "./ProviderList";
import { VariantRows } from "./VariantRows";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

interface ModelEditorProps {
  /** Path of the owning `models` object (`<container>.<provider>.models`). */
  modelsPath: (string | number)[];
  modelId: string;
  /** The model's sibling keys, for rename collision checks. */
  siblingIds: string[];
  model: Obj;
  docShape: DocShape;
  apply: (edits: PathEdit[]) => void;
}

/**
 * One model entry. Field spellings follow the doc's own shape: v2 uses
 * `modelID` and `capabilities.{tools,temperature}` + `disabled`; v1 uses the
 * flat `id` / `tool_call` / `temperature` flags (its schema has no `disabled`
 * on models). Renaming the model key is a delete-old + create-new edit pair.
 */
export function ModelEditor({ modelsPath, modelId, siblingIds, model, docShape, apply }: ModelEditorProps) {
  const prefix = [...modelsPath, modelId];
  const [keyDraft, setKeyDraft] = useState(modelId);

  const commitKey = (): void => {
    const next = keyDraft.trim();
    if (next === "" || siblingIds.includes(next)) {
      setKeyDraft(modelId);
      return;
    }
    if (next === modelId) return;
    apply([
      { path: [...modelsPath, modelId], value: undefined },
      { path: [...modelsPath, next], value: model },
    ]);
  };

  const limit = isObj(model["limit"]) ? (model["limit"] as Obj) : {};
  const caps = isObj(model["capabilities"]) ? (model["capabilities"] as Obj) : {};

  const textEdit = (key: string, raw: string): void => {
    apply([{ path: [...prefix, key], value: raw === "" ? undefined : raw }]);
  };

  const boolEdit = (path: (string | number)[], checked: boolean): void => {
    apply([{ path, value: checked ? true : undefined }]); // unchecked = drop the key
  };

  return (
    <div className="model-editor">
      <div className="model-key-row">
        <span className="field-label">Model key</span>
        <input
          type="text"
          spellCheck={false}
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          onBlur={commitKey}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
        />
        <span className="hint">renaming re-creates the entry at the end of the list</span>
        <button
          type="button"
          className="model-delete"
          onClick={() => {
            if (window.confirm(`Delete model "${modelId}" from this provider?`)) {
              apply([{ path: [...modelsPath, modelId], value: undefined }]);
            }
          }}
        >
          delete model
        </button>
      </div>

      <div className="field-grid">
        <label>
          <span className="field-label">Display name</span>
          <input
            type="text"
            spellCheck={false}
            value={asStr(model["name"])}
            onChange={(event) => textEdit("name", event.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{docShape === "v2" ? "modelID" : "id (API model id)"}</span>
          <input
            type="text"
            spellCheck={false}
            value={asStr(docShape === "v2" ? model["modelID"] : model["id"])}
            onChange={(event) => textEdit(docShape === "v2" ? "modelID" : "id", event.target.value)}
          />
        </label>
        <label>
          <span className="field-label">Context limit</span>
          <NumInput
            value={limit["context"]}
            onChange={(next) => apply([{ path: [...prefix, "limit", "context"], value: next }])}
          />
        </label>
        <label>
          <span className="field-label">Output limit</span>
          <NumInput
            value={limit["output"]}
            onChange={(next) => apply([{ path: [...prefix, "limit", "output"], value: next }])}
          />
        </label>
      </div>

      <div className="bool-row">
        <span className="field-label">Capabilities</span>
        {docShape === "v2" ? (
          <>
            <label className="bool">
              <input
                type="checkbox"
                checked={caps["tools"] === true}
                onChange={(event) => boolEdit([...prefix, "capabilities", "tools"], event.target.checked)}
              />
              tools
            </label>
            <label className="bool">
              <input
                type="checkbox"
                checked={caps["temperature"] === true}
                onChange={(event) =>
                  boolEdit([...prefix, "capabilities", "temperature"], event.target.checked)
                }
              />
              temperature
            </label>
            <label className="bool">
              <input
                type="checkbox"
                checked={model["disabled"] === true}
                onChange={(event) => boolEdit([...prefix, "disabled"], event.target.checked)}
              />
              disabled
            </label>
          </>
        ) : (
          <>
            <label className="bool" title="v1 flag: tool_call">
              <input
                type="checkbox"
                checked={model["tool_call"] === true}
                onChange={(event) => boolEdit([...prefix, "tool_call"], event.target.checked)}
              />
              tools (v1 tool_call)
            </label>
            <label className="bool" title="v1 flat flag">
              <input
                type="checkbox"
                checked={model["temperature"] === true}
                onChange={(event) => boolEdit([...prefix, "temperature"], event.target.checked)}
              />
              temperature
            </label>
            <span className="hint">(v1 model entries have no disabled key)</span>
          </>
        )}
      </div>

      <VariantRows
        modelPath={prefix}
        variants={model["variants"]}
        docShape={docShape}
        apply={apply}
      />
    </div>
  );
}

function NumInput({
  value,
  onChange,
}: {
  value: JsonValue | undefined;
  onChange: (next: JsonValue | undefined) => void;
}) {
  return (
    <input
      type="number"
      step={1}
      value={typeof value === "number" ? String(value) : ""}
      onChange={(event) => {
        const raw = event.target.value.trim();
        if (raw === "") onChange(undefined);
        else if (/^-?\d+$/.test(raw)) onChange(Number(raw));
      }}
    />
  );
}
