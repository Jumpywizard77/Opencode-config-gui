import type { JsonValue, PathEdit } from "../../core/types";
import {
  thinkingLevelEdits,
  thinkingLevelMapToggleEdits,
  thinkingLevelRows,
} from "../model-logic";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ThinkingLevelEditorProps {
  /** The entry's current `thinkingLevelMap` value (`undefined` = absent). */
  map: JsonValue | undefined;
  /** Path of the `thinkingLevelMap` object; parents are created on first write. */
  mapPath: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}

/** Friendly labels for pi's seven thinking levels (`off` is the "none" level). */
function levelLabel(level: string): string {
  return level === "off" ? "none (off)" : level;
}

/** What an absent level does in pi — a provider default through high, unsupported for xhigh/max. */
function absentHint(level: string): string {
  return level === "xhigh" || level === "max" ? "provider unsupported unless mapped" : "provider default";
}

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Guided editor for pi's `thinkingLevelMap`. A toggle enables the map; while
 * enabled, every pi thinking level (`off`/none, minimal, low, medium, high,
 * xhigh, max) gets a box for the provider value that level sends (e.g. an
 * OpenAI `reasoning_effort`). Enabling seeds all seven with the level name
 * (`off` → "none"), which the user can retarget. Each row also has an
 * "unsupported" checkbox: that stores `null`, pi's explicit "this level is
 * unsupported" marker. An absent level is different — it uses the provider's
 * default value through `high` (and xhigh/max are unsupported).
 *
 * Hand-edited keys outside pi's seven levels are preserved and editable
 * rather than silently dropped. Toggling off deletes the whole map, restoring
 * provider defaults.
 */
export function ThinkingLevelEditor({ map, mapPath, apply }: ThinkingLevelEditorProps) {
  const malformed = map !== undefined && !isObj(map);
  const rows = malformed ? [] : thinkingLevelRows(map);

  const toggle = (checked: boolean): void => {
    // Checking an absent map seeds all seven levels so the boxes start filled;
    // checking a malformed map replaces it with the same preset.
    apply(thinkingLevelMapToggleEdits(mapPath, checked));
  };

  return (
    <div className="kv-block level-editor">
      <label className="bool" title="enable pi's per-level reasoning value map">
        <input
          type="checkbox"
          checked={map !== undefined}
          onChange={(event) => toggle(event.target.checked)}
        />
        thinkingLevelMap (per-level reasoning values)
      </label>
      <div className="hint">
        Provider value sent for each thinking level. An empty box = not mapped (provider default);{" "}
        <code>null</code> = unsupported. Toggle off removes the map entirely. pi ignores
        this map unless <code>reasoning</code> is enabled above.
      </div>
      {malformed && (
        <div className="warning-banner">
          <code>thinkingLevelMap</code> is not an object in the file — edit it in the Raw JSON tab.
        </div>
      )}
      {!malformed && map === undefined && (
        <div className="hint">the map is disabled — tick the box above to add all seven levels.</div>
      )}
      {rows.map(({ level, value, known, mapped }) => {
        const unsupported = value === null;
        const schemaInvalid = value !== null && typeof value !== "string" && value !== undefined;
        return (
          <div className={mapped ? "level-row" : "level-row level-row-unmapped"} key={level}>
            <span className="level-name">{levelLabel(level)}</span>
            {!known && (
              <span className="badge badge-amber" title="not one of pi's seven thinking levels">
                not a pi level
              </span>
            )}
            {schemaInvalid && (
              <span className="badge badge-amber" title="schema expects a string or null">
                not a string
              </span>
            )}
            <input
              type="text"
              spellCheck={false}
              className="level-value"
              title={unsupported ? "unsupported level (null) — uncheck to remove the mapping" : "provider value sent for this level"}
              placeholder={mapped ? "" : absentHint(level)}
              value={displayValue(value)}
              disabled={unsupported}
              onChange={(event) => apply(thinkingLevelEdits(mapPath, level, event.target.value === "" ? undefined : event.target.value))}
            />
            <label className="bool" title="null marks this level unsupported; unchecking removes the mapping">
              <input
                type="checkbox"
                checked={unsupported}
                onChange={(event) =>
                  apply(thinkingLevelEdits(mapPath, level, event.target.checked ? null : undefined))
                }
              />
              unsupported
            </label>
            {mapped && (
              <button
                type="button"
                title="delete this mapping (restores the provider default)"
                onClick={() => apply(thinkingLevelEdits(mapPath, level, undefined))}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
