import { useState } from "react";

import type { JsonValue, PathEdit } from "../../core/types";
import type { DocShape } from "./ProviderList";

const LEVELS = ["none", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

interface VariantRowsProps {
  /** Path of the owning model object (`…models.<id>`). */
  modelPath: (string | number)[];
  /** Raw `variants` value: array (v2 docs) or key→settings map (v1 docs). */
  variants: JsonValue | undefined;
  docShape: DocShape;
  apply: (edits: PathEdit[]) => void;
}

/**
 * Variant editor with BOTH storages: v2 docs keep an array of
 * `{ id, settings }`; v1 docs keep a `{ key: {…opts} }` map — the editor
 * NEVER reshapes the doc's own layout. `capabilities.reasoning` conversion
 * is offered for v2 docs only (it is a v2 concept).
 */
export function VariantRows({ modelPath, variants, docShape, apply }: VariantRowsProps) {
  const [presetLevel, setPresetLevel] = useState<Level>("medium");

  const variantsPath = [...modelPath, "variants"];
  const v2Array = Array.isArray(variants) ? (variants as JsonValue[]) : variants === undefined ? [] : null;
  const v1Map = isObj(variants) ? variants : variants === undefined ? {} : null;

  if (v2Array === null && v1Map === null) {
    return (
      <div className="variant-rows">
        <span className="field-label">Variants</span>
        <div className="hint">
          <code>variants</code> is not an object/array — edit it in the Raw JSON tab.
        </div>
      </div>
    );
  }

  const settingsOf = (variant: JsonValue): Obj | null =>
    isObj(variant) && (variant["settings"] === undefined || isObj(variant["settings"]))
      ? ((variant["settings"] as Obj | undefined) ?? {})
      : null;

  const addReasoningPreset = (): void => {
    if (docShape === "v2") {
      apply([
        {
          path: variantsPath,
          value: [...(v2Array as JsonValue[]), { id: presetLevel, settings: { reasoningEffort: presetLevel } }],
        },
      ]);
    } else {
      apply([{ path: [...variantsPath, presetLevel], value: { reasoningEffort: presetLevel } }]);
    }
  };

  const useCapabilitiesInstead = (): void => {
    // v2 only. Effort levels come from the variant ids; a "none" variant
    // becomes the boolean toggle instead of an effort entry.
    const effort = (v2Array as JsonValue[])
      .map((variant) => (isObj(variant) && typeof variant["id"] === "string" ? variant["id"] : ""))
      .filter((id) => id !== "" && id !== "none");
    const hadNone = effort.length !== (v2Array as JsonValue[]).length;
    const reasoning: Obj = { supported: true, effort };
    if (hadNone) reasoning["toggle"] = true;
    if (
      !window.confirm(
        `Replace the variants array with capabilities.reasoning = ${JSON.stringify(reasoning)}? ` +
          "The variants array is removed. This cannot be undone here.",
      )
    ) {
      return;
    }
    apply([
      { path: [...modelPath, "capabilities", "reasoning"], value: reasoning },
      { path: variantsPath, value: undefined },
    ]);
  };

  return (
    <div className="variant-rows">
      <span className="field-label">Variants</span>

      {v2Array !== null && (
        <V2Rows variantsPath={variantsPath} rows={v2Array} settingsOf={settingsOf} apply={apply} />
      )}
      {docShape === "v1" && v1Map !== null && (
        <V1Rows variantsPath={variantsPath} entries={v1Map} apply={apply} />
      )}

      <div className="variant-add">
        <select value={presetLevel} onChange={(event) => setPresetLevel(event.target.value as Level)}>
          {LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <button type="button" onClick={addReasoningPreset}>
          + reasoningEffort preset
        </button>
        {docShape === "v2" && v2Array !== null && v2Array.length > 0 && (
          <button type="button" className="variant-convert" onClick={useCapabilitiesInstead}>
            Use capabilities.reasoning instead
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// v2: array of { id, settings }
// ---------------------------------------------------------------------------

function V2Rows({
  variantsPath,
  rows,
  settingsOf,
  apply,
}: {
  variantsPath: (string | number)[];
  rows: JsonValue[];
  settingsOf: (variant: JsonValue) => Obj | null;
  apply: (edits: PathEdit[]) => void;
}) {
  return (
    <>
      {rows.map((variant, index) => {
        const settings = isObj(variant) ? settingsOf(variant) : null;
        return (
          <div className="variant-row" key={index}>
            <input
              className="variant-id"
              type="text"
              spellCheck={false}
              value={isObj(variant) ? asStr(variant["id"]) : asStr(variant)}
              disabled={settings === null}
              onChange={(event) =>
                apply([{ path: [...variantsPath, index, "id"], value: event.target.value }])
              }
            />
            {settings === null ? (
              <span className="hint">{"not a { id, settings } object — edit in Raw JSON"}</span>
            ) : (
              <SettingsCells
                basePath={[...variantsPath, index, "settings"]}
                settings={settings}
                apply={apply}
              />
            )}
            <button
              type="button"
              title="Remove variant"
              onClick={() => apply([{ path: variantsPath, value: rows.filter((_, i) => i !== index) }])}
            >
              ✕
            </button>
          </div>
        );
      })}
      {rows.length === 0 && <div className="hint">no variants yet</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// v1: key → settings map
// ---------------------------------------------------------------------------

function V1Rows({
  variantsPath,
  entries,
  apply,
}: {
  variantsPath: (string | number)[];
  entries: Obj;
  apply: (edits: PathEdit[]) => void;
}) {
  const keys = Object.keys(entries);
  return (
    <>
      {keys.map((key) => {
        const settings = isObj(entries[key]) ? (entries[key] as Obj) : null;
        return (
          <div className="variant-row" key={key}>
            <VariantMapKey
              oldKey={key}
              siblingKeys={keys.filter((k) => k !== key)}
              onSubmit={(next) => {
                // Map-key rename = delete-old + create-new pair (v1 layout).
                if (next === key) return;
                apply([
                  { path: [...variantsPath, key], value: undefined },
                  { path: [...variantsPath, next], value: entries[key] },
                ]);
              }}
            />
            {settings === null ? (
              <span className="hint">not an object — edit in Raw JSON</span>
            ) : (
              <SettingsCells basePath={[...variantsPath, key]} settings={settings} apply={apply} />
            )}
            <button
              type="button"
              title="Remove variant"
              onClick={() => apply([{ path: [...variantsPath, key], value: undefined }])}
            >
              ✕
            </button>
          </div>
        );
      })}
      {keys.length === 0 && <div className="hint">no variants yet</div>}
    </>
  );
}

function VariantMapKey({
  oldKey,
  siblingKeys,
  onSubmit,
}: {
  oldKey: string;
  siblingKeys: string[];
  onSubmit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(oldKey);
  return (
    <input
      className="variant-id"
      type="text"
      spellCheck={false}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next === "" || siblingKeys.includes(next)) {
          setDraft(oldKey); // reject empty/colliding renames, keep the doc intact
          return;
        }
        onSubmit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// key/value settings cells (shared by both layouts)
// ---------------------------------------------------------------------------

function SettingsCells({
  basePath,
  settings,
  apply,
}: {
  basePath: (string | number)[];
  settings: Obj;
  apply: (edits: PathEdit[]) => void;
}) {
  return (
    <span className="settings-cells">
      {Object.entries(settings).map(([key, value]) => (
        <span className="settings-cell" key={key}>
          <span className="settings-key">{key}</span>
          <input
            type="text"
            spellCheck={false}
            value={asStr(value)}
            onChange={(event) => {
              const raw = event.target.value;
              const next: JsonValue = /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
              apply([{ path: [...basePath, key], value: next === "" ? undefined : next }]);
            }}
          />
          <button
            type="button"
            title={`remove ${key}`}
            onClick={() => apply([{ path: [...basePath, key], value: undefined }])}
          >
            −
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => {
          const key = window.prompt("New variant setting key (e.g. reasoningEffort):");
          if (key === null || key.trim() === "" || key.trim() in settings) return;
          apply([{ path: [...basePath, key.trim()], value: "" }]);
        }}
      >
        + key
      </button>
    </span>
  );
}
