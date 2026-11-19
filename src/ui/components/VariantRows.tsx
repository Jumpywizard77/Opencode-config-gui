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
  /** Raw `variants` value: array (v2 entries) or key→settings map (v1 entries). */
  variants: JsonValue | undefined;
  /** The entry's CONTAINER shape (not the doc-level flag). */
  shape: DocShape;
  apply: (edits: PathEdit[]) => void;
}

/**
 * Pure conversion logic (unit-tested): well-formed `{ id, … }` entries yield
 * the effort levels — a `none` variant becomes `toggle: true` instead of an
 * effort entry — while entries that are not objects with a non-empty string
 * `id` are REPORTED as `malformed` (they cannot be represented; the caller
 * must warn that converting deletes them). `hadNone` is detected by the id
 * itself, never by a length mismatch against the filtered list.
 */
export function reasoningFromVariants(rows: JsonValue[]): { reasoning: Obj; malformed: JsonValue[] } {
  const effort: string[] = [];
  const malformed: JsonValue[] = [];
  let hadNone = false;
  for (const row of rows) {
    if (isObj(row) && typeof row["id"] === "string" && row["id"] !== "") {
      if (row["id"] === "none") hadNone = true;
      else effort.push(row["id"]);
    } else {
      malformed.push(row);
    }
  }
  const reasoning: Obj = { supported: true, effort };
  if (hadNone) reasoning["toggle"] = true;
  return { reasoning, malformed };
}

/**
 * Variant editor with BOTH storages: v2 entries keep an array of
 * `{ id, settings }`; v1 entries keep a `{ key: {…opts} }` map — the editor
 * NEVER reshapes the entry's own layout (an array/map that exists is edited
 * AS that storage, whatever the container's nominal shape). The
 * `capabilities.reasoning` conversion is offered for v2 entries with
 * array-stored variants only (it is a v2 concept).
 */
export function VariantRows({ modelPath, variants, shape, apply }: VariantRowsProps) {
  const [presetLevel, setPresetLevel] = useState<Level>("medium");

  const variantsPath = [...modelPath, "variants"];
  // What to RENDER/APPEND, decided by the storage actually present (never a
  // null-spread): a v2 entry with a hand-edited map keeps map editing.
  // When `variants` is absent, the entry's nominal container shape decides
  // the storage a first edit creates.
  const rows: JsonValue[] | null = Array.isArray(variants)
    ? (variants as JsonValue[])
    : variants === undefined && shape === "v2"
      ? []
      : null;
  const mapEntries: Obj | null = isObj(variants)
    ? variants
    : variants === undefined && shape === "v1"
      ? {}
      : null;

  if (rows === null && mapEntries === null) {
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
    if (rows !== null) {
      apply([
        {
          path: variantsPath,
          value: [...rows, { id: presetLevel, settings: { reasoningEffort: presetLevel } }],
        },
      ]);
    } else {
      apply([{ path: [...variantsPath, presetLevel], value: { reasoningEffort: presetLevel } }]);
    }
  };

  const useCapabilitiesInstead = (): void => {
    // v2 entries only. Effort levels come from the variant ids; a "none"
    // variant becomes the boolean toggle instead of an effort entry.
    const { reasoning, malformed } = reasoningFromVariants(rows ?? []);
    let message =
      `Replace the variants array with capabilities.reasoning = ${JSON.stringify(reasoning)}? ` +
      "The variants array is removed. This cannot be undone here.";
    if (malformed.length > 0) {
      message +=
        ` NOTE: ${malformed.length} entr${malformed.length === 1 ? "y" : "ies"} ` +
        `(currently: ${JSON.stringify(malformed).slice(0, 200)}) cannot be represented as reasoning ` +
        "levels and will be REMOVED with the array.";
    }
    if (!window.confirm(message)) return;
    apply([
      { path: [...modelPath, "capabilities", "reasoning"], value: reasoning },
      { path: variantsPath, value: undefined },
    ]);
  };

  return (
    <div className="variant-rows">
      <span className="field-label">Variants</span>

      {rows !== null && (
        <V2Rows variantsPath={variantsPath} rows={rows} settingsOf={settingsOf} apply={apply} />
      )}
      {mapEntries !== null && (
        <V1Rows variantsPath={variantsPath} entries={mapEntries} apply={apply} />
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
        {shape === "v2" && rows !== null && rows.length > 0 && (
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
                apply([
                  {
                    path: [...variantsPath, index, "id"],
                    value: event.target.value === "" ? undefined : event.target.value,
                  },
                ])
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
