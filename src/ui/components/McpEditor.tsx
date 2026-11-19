import { useState } from "react";

import type { JsonValue, PathEdit } from "../../core/types";
import {
  activeMcpType,
  disabledToggleEdits,
  isEntryDisabled,
  renameMcpEdits,
  switchMcpTypeEdits,
  validateMcpEntryName,
  type McpContainer,
  type McpType,
} from "../mcp-logic";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

interface McpEditorProps {
  /** The entry's key in its container (also its rename draft source). */
  entryId: string;
  /** Which container the entry lives in — decides edit path AND polarity. */
  container: McpContainer;
  /** Parsed entry object (already container-tagged by McpList). */
  entry: Obj;
  /** Key-path: `["mcp", id]` or `["mcp", "servers", id]`. */
  path: (string | number)[];
  /** All OTHER entry ids in the same container (rename collision checks). */
  otherIds: string[];
  apply: (edits: PathEdit[]) => void;
  /** After a committed ID rename, so the parent can move the selection. */
  onRenamed: (newId: string) => void;
}

/**
 * Structured editor for one MCP server entry. The fields per variant:
 * local — `command` array rows, `cwd`, `environment` key/value rows;
 * remote — `url`, `headers` key/value rows. Both share name, type select
 * and the `disabled` box, whose KEY depends on the container (never the
 * other container's polarity key — see `mcp-logic`).
 */
export function McpEditor({
  entryId,
  container,
  entry,
  path,
  otherIds,
  apply,
  onRenamed,
}: McpEditorProps) {
  const [idDraft, setIdDraft] = useState(entryId);
  /** Inline refusal for a reserved rename TARGET (""/duplicate revert stays silent). */
  const [renameError, setRenameError] = useState<string | null>(null);
  const type = activeMcpType(entry);
  const disabled = isEntryDisabled(entry, container);

  const commitRename = (): void => {
    const next = idDraft.trim();
    if (next === "" || otherIds.includes(next)) {
      setIdDraft(entryId);
      return;
    }
    if (next === entryId) return;
    const nameProblem = validateMcpEntryName(container, next);
    if (nameProblem !== null) {
      setRenameError(nameProblem); // draft stays so the user can fix it
      return;
    }
    setRenameError(null);
    apply(renameMcpEdits(path, next, entry));
    onRenamed(next);
  };

  const setType = (next: McpType): void => {
    if (next === type) return;
    const leftBehind = (next === "local" ? ["url", "headers", "oauth"] : ["command", "cwd", "environment"]).filter(
      (key) => key in entry,
    );
    if (leftBehind.length > 0 && !window.confirm(`Switching to ${next} removes: ${leftBehind.join(", ")}. Continue?`)) {
      return;
    }
    apply(switchMcpTypeEdits(path, next));
  };

  return (
    <div className="mcp-editor">
      <div className="field-grid">
        <div>
          <label>
            <span className="field-label">Name (rename = delete + re-create)</span>
            <input
              type="text"
              spellCheck={false}
              value={idDraft}
              onChange={(event) => {
                setIdDraft(event.target.value);
                setRenameError(null);
              }}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              }}
            />
          </label>
          {renameError !== null && <div className="field-error">{renameError}</div>}
        </div>
        <label>
          <span className="field-label">Type</span>
          <select value={type} onChange={(event) => setType(event.target.value as McpType)}>
            <option value="local">local</option>
            <option value="remote">remote</option>
          </select>
        </label>
      </div>

      <div className="bool-row">
        <label className="bool">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(event) => apply(disabledToggleEdits(path, container, event.target.checked))}
          />
          disabled
        </label>
        <span className="hint">
          {container === "flat"
            ? "stored as `enabled: false` at mcp." + entryId + " (legacy polarity, kept in place)"
            : "stored as `disabled: true` under mcp.servers." + entryId}
        </span>
      </div>

      {type === "local" ? (
        <>
          <CommandRows
            command={Array.isArray(entry["command"]) ? (entry["command"] as JsonValue[]) : undefined}
            path={path}
            apply={apply}
          />
          <label>
            <span className="field-label">cwd</span>
            <input
              type="text"
              spellCheck={false}
              value={asStr(entry["cwd"])}
              onChange={(event) =>
                apply([
                  {
                    path: [...path, "cwd"],
                    value: event.target.value === "" ? undefined : event.target.value,
                  },
                ])
              }
            />
          </label>
          <ObjectRows
            label="environment"
            objectKey="environment"
            object={isObj(entry["environment"]) ? (entry["environment"] as Obj) : undefined}
            path={path}
            apply={apply}
          />
        </>
      ) : (
        <>
          <label>
            <span className="field-label">url</span>
            <input
              type="text"
              spellCheck={false}
              value={asStr(entry["url"])}
              onChange={(event) =>
                apply([
                  {
                    path: [...path, "url"],
                    value: event.target.value === "" ? undefined : event.target.value,
                  },
                ])
              }
            />
          </label>
          <ObjectRows
            label="headers"
            objectKey="headers"
            object={isObj(entry["headers"]) ? (entry["headers"] as Obj) : undefined}
            path={path}
            apply={apply}
          />
        </>
      )}
    </div>
  );
}

/** `command`: rows of strings, add/remove/replace per index (the provider `env` rows). */
function CommandRows({
  command,
  path,
  apply,
}: {
  command: JsonValue[] | undefined;
  path: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}) {
  const rows = command ?? [];
  return (
    <div className="kv-block">
      <span className="field-label">command (argv)</span>
      {rows.map((row, index) => (
        <div className="kv-row" key={index}>
          <input
            type="text"
            spellCheck={false}
            value={asStr(row)}
            onChange={(event) => apply([{ path: [...path, "command", index], value: event.target.value }])}
          />
          <button
            type="button"
            onClick={() => apply([{ path: [...path, "command"], value: rows.filter((_, i) => i !== index) }])}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => apply([{ path: [...path, "command", rows.length], value: "" }])}>
        + command arg
      </button>
    </div>
  );
}

/** String-valued objects (`environment`, `headers`) — the provider `HeaderRows` pattern. */
function ObjectRows({
  label,
  objectKey,
  object,
  path,
  apply,
}: {
  label: string;
  objectKey: string;
  object: Obj | undefined;
  path: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}) {
  const entries: [string, string][] = Object.entries(object ?? {}).map(
    ([key, value]) => [key, asStr(value)] as [string, string],
  );
  // Key renames/removals rewrite the object and DROP empty-key rows; value
  // edits are path-addressed so an added row with a still-empty key keeps
  // rendering and stays editable.
  const rewrite = (next: [string, string][]): void => {
    const cleaned = next.filter(([key]) => key !== "");
    const value: Obj = {};
    for (const [key, item] of cleaned) value[key] = item;
    apply([{ path: [...path, objectKey], value: cleaned.length === 0 ? undefined : value }]);
  };
  const replace = (index: number, next: [string, string]): void => {
    rewrite(entries.map((entry, i) => (i === index ? next : entry)));
  };
  return (
    <div className="kv-block">
      <span className="field-label">{label}</span>
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
            onChange={(event) => apply([{ path: [...path, objectKey, key], value: event.target.value }])}
          />
          <button type="button" onClick={() => rewrite(entries.filter((_, i) => i !== index))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={entries.some(([key]) => key === "")}
        onClick={() => apply([{ path: [...path, objectKey, ""], value: "" }])}
      >
        + {label === "environment" ? "env var" : "header"}
      </button>
    </div>
  );
}
