import { useCallback, useEffect, useMemo, useState } from "react";

import type { CurrentConfig, ToastKind } from "../App";
import { getConfig, saveConfig, type SaveOutcome } from "../api";
import { parseJsonc } from "../../core/jsonc";
import type { Issue, JsonValue, PathEdit } from "../../core/types";
import { editInText } from "../editor-path";
import type { DocShape } from "./ProviderList";
import {
  collectMcpEntries,
  mcpEntryPath,
  mcpGlobalTimeoutForm,
  MCP_TIMEOUT_KEYS,
  pickMcpContainer,
  timeoutTrioEdits,
  type McpTimeoutKey,
} from "../mcp-logic";
import { McpEditor } from "./McpEditor";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Selection {
  container: "flat" | "servers";
  name: string;
}

interface McpListProps {
  config: CurrentConfig;
  folder: string | undefined;
  docShape: DocShape;
  /** Bumped by App on every disk load — the re-seed trigger (as in RawJsonTab). */
  loadNonce: number;
  onSaved: (path: string, text: string, sha256: string, backupPath: string) => void;
  onReload: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
  /** Reports unsaved structured edits so App can confirm on tab switch. */
  onDirty: (dirty: boolean) => void;
  /** Opens the shared v1→v2 Upgrade dialog (App-owned, same as Providers). */
  onUpgrade: () => void;
}

/**
 * The MCP tab. Same pending-`PathEdit[]` architecture as the Providers tab:
 * the displayed doc is `editInText(config.text, edits)` recomputed per edit,
 * Save compiles to full new text and goes through the normal save pipeline.
 * Entries live in TWO containers (flat legacy `mcp.<name>` and v2
 * `mcp.servers.<name>`); per-entry paths and disable polarity come from
 * `mcp-logic`, and edits NEVER migrate an entry between containers — that
 * is the Upgrade dialog's job.
 */
export function McpList({
  config,
  folder,
  docShape,
  loadNonce,
  onSaved,
  onReload,
  onToast,
  onDirty,
  onUpgrade,
}: McpListProps) {
  const [edits, setEdits] = useState<PathEdit[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [blockedIssues, setBlockedIssues] = useState<Issue[] | null>(null);

  useEffect(() => {
    setEdits([]);
    setSelected(null);
    setNewName("");
    setStale(false);
    setBlockedIssues(null);
  }, [loadNonce]);

  const dirty = edits.length > 0;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  // Parse guard: editInText REFUSES malformed JSONC (same as Providers).
  const baseParse = useMemo(() => parseJsonc(config.text), [config.text]);
  const parseBroken = baseParse.errors.length > 0 || !isObj(baseParse.value);

  const [derived, derivedError] = useMemo((): [string | null, string | null] => {
    if (parseBroken) return [null, null];
    try {
      return [editInText(config.text, edits), null];
    } catch (err) {
      return [
        null,
        `Structured edit failed: ${err instanceof Error ? err.message : String(err)} — reload from disk to start over.`,
      ];
    }
  }, [config.text, edits, parseBroken]);

  const doc = derived === null ? null : (parseJsonc(derived).value as Obj | undefined);
  const entries = collectMcpEntries(doc ?? undefined);
  const selectedEntry =
    selected === null
      ? undefined
      : entries.find((e) => e.container === selected.container && e.name === selected.name);

  const mcpBlock = doc?.["mcp"];
  const serversBroken = isObj(mcpBlock) && "servers" in mcpBlock && !isObj(mcpBlock["servers"]);
  const timeoutForm = mcpGlobalTimeoutForm(mcpBlock);
  const hasFlatEntries = entries.some((e) => e.container === "flat");

  const apply = useCallback((newEdits: PathEdit[]) => {
    setEdits((previous) => [...previous, ...newEdits]);
  }, []);

  const handleOutcome = (outcome: SaveOutcome): void => {
    switch (outcome.kind) {
      case "ok":
        setStale(false);
        setBlockedIssues(null);
        if (derived !== null) onSaved(config.path, derived, outcome.sha256, outcome.backupPath);
        setEdits([]);
        break;
      case "stale":
        setStale(true);
        setBlockedIssues(null);
        break;
      case "new_issues":
        setStale(false);
        setBlockedIssues(outcome.newIssues);
        break;
      case "error":
        onToast(`Save failed: ${outcome.message}`, "error");
        break;
    }
  };

  const save = async (): Promise<void> => {
    if (derived === null) return;
    setSaving(true);
    try {
      handleOutcome(await saveConfig(config.path, derived, config.sha256, config.issues, folder));
    } finally {
      setSaving(false);
    }
  };

  const forceSave = async (): Promise<void> => {
    if (derived === null) return;
    setSaving(true);
    try {
      const fresh = await getConfig(config.path, folder);
      if (fresh.kind !== "ok") {
        onToast(`Could not refresh the file from disk: ${fresh.message}`, "error");
        return;
      }
      handleOutcome(
        await saveConfig(config.path, derived, fresh.data.sha256, fresh.data.issues, folder),
      );
    } finally {
      setSaving(false);
    }
  };

  if (parseBroken) {
    return (
      <section className="mcp-list-tab">
        <div className="error-banner">
          This config has parse errors — fix them in the Raw JSON tab first; structured editing is
          disabled while the document does not parse.
        </div>
      </section>
    );
  }

  return (
    <section className="mcp-list-tab">
      {derivedError !== null && <div className="error-banner">{derivedError}</div>}

      {hasFlatEntries && (
        <div className="legacy-banner">
          legacy shape — these MCP servers live flat under <code>mcp.&lt;name&gt;</code>; edits
          stay there with the legacy <code>enabled</code> key (no silent migration).{" "}
          <button type="button" onClick={onUpgrade}>
            Upgrade
          </button>
        </div>
      )}

      {serversBroken && (
        <div className="warning-banner">
          <code>mcp.servers</code> is not an object — fix it in the Raw JSON tab; v2 entries are
          not listed until it is.
        </div>
      )}

      {stale && (
        <div className="stale-banner">
          The file changed on disk since you loaded it — your pending edits are not lost.{" "}
          <button type="button" onClick={onReload} disabled={saving}>
            Reload
          </button>{" "}
          <button type="button" onClick={() => void forceSave()} disabled={saving || !dirty}>
            Force save
          </button>
        </div>
      )}
      {blockedIssues !== null && (
        <div className="issues-banner">
          <div>Save refused — the edits introduce new validation errors:</div>
          <ul>
            {blockedIssues.map((issue, index) => (
              <li key={`${issue.path}|${issue.message}|${index}`}>
                <code>{issue.path || "(document)"}</code>: {issue.message}
              </li>
            ))}
          </ul>
          <div className="hint">Adjust above; pending edits are kept.</div>
        </div>
      )}

      <div className="provider-columns">
        <div className="provider-picker">
          <div className="provider-list-head">MCP servers ({entries.length})</div>
          {entries.map((entry) => (
            <div
              key={`${entry.container}|${entry.name}`}
              className={`provider-row${selectedEntry?.name === entry.name && selectedEntry?.container === entry.container ? " provider-row-active" : ""}`}
            >
              <button type="button" onClick={() => setSelected({ container: entry.container, name: entry.name })}>
                {entry.name}
              </button>
              <span
                className="shape-badge"
                title={
                  entry.container === "flat"
                    ? "stored flat under mcp (v1 legacy)"
                    : "stored under mcp.servers (v2)"
                }
              >
                {entry.container === "flat" ? "v1" : "v2"}
              </span>
            </div>
          ))}
          {entries.length === 0 && <div className="hint">no MCP servers yet</div>}
          <div className="provider-add">
            <input
              type="text"
              spellCheck={false}
              placeholder="new server name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addEntry();
              }}
            />
            <button type="button" onClick={addEntry} disabled={newName.trim() === ""}>
              + add
            </button>
          </div>
        </div>

        <div className="provider-detail">
          {selectedEntry === undefined ? (
            <div className="hint">Select an MCP server to edit it, or add one.</div>
          ) : selectedEntry.notObject ? (
            <div className="warning-banner">
              <code>{selectedEntry.name}</code> is not an object — edit it in the Raw JSON tab.
            </div>
          ) : (
            <>
              <div className="provider-detail-head">
                <span className="field-label">{mcpEntryPath(selectedEntry.container, selectedEntry.name).join(".")}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete MCP server "${selectedEntry.name}"?`)) {
                      apply([{ path: mcpEntryPath(selectedEntry.container, selectedEntry.name), value: undefined }]);
                      setSelected(null);
                    }
                  }}
                >
                  delete server
                </button>
              </div>
              <McpEditor
                key={`${selectedEntry.container}|${selectedEntry.name}`}
                entryId={selectedEntry.name}
                container={selectedEntry.container}
                entry={selectedEntry.value}
                path={mcpEntryPath(selectedEntry.container, selectedEntry.name)}
                otherIds={entries
                  .filter((e) => e.container === selectedEntry.container && e.name !== selectedEntry.name)
                  .map((e) => e.name)}
                apply={apply}
                onRenamed={(newId) => setSelected({ container: selectedEntry.container, name: newId })}
              />
            </>
          )}
        </div>
      </div>

      <TimeoutTrio form={timeoutForm} mcpBlock={mcpBlock} apply={apply} />

      <div className="raw-actions">
        <button type="button" onClick={() => void save()} disabled={saving || !dirty || derived === null}>
          {saving ? "Saving…" : `Save${dirty ? ` (${pendingTouches(edits)})` : ""}`}
        </button>
        <button type="button" onClick={onReload} disabled={saving}>
          Reload from disk
        </button>
        {dirty && <span className="dirty-marker">unsaved MCP changes</span>}
      </div>
    </section>
  );

  function addEntry(): void {
    const name = newName.trim();
    if (name === "" || entries.some((e) => e.name === name)) return;
    // New servers go to the container the doc already uses (else its shape) —
    // never a silent migration of existing entries.
    const container = pickMcpContainer(mcpBlock, docShape);
    apply([
      {
        path: mcpEntryPath(container, name),
        value: { type: "local", command: [] } satisfies Obj,
      },
    ]);
    setNewName("");
    setSelected({ container, name });
  }
}

/** The global `mcp.timeout` { startup, catalog, execution } trio. */
function TimeoutTrio({
  form,
  mcpBlock,
  apply,
}: {
  form: "absent" | "numeric" | "object";
  mcpBlock: JsonValue | undefined;
  apply: (edits: PathEdit[]) => void;
}) {
  const timeout = isObj(mcpBlock) ? mcpBlock["timeout"] : undefined;
  const values = isObj(timeout) ? timeout : {};
  if (form === "numeric") {
    return (
      <div className="timeout-trio">
        <span className="field-label">mcp.timeout (global)</span>
        <div className="warning-banner">
          deprecated numeric form (<code>{JSON.stringify(timeout)}</code>) — the Upgrade dialog
          converts it to <code>{"{ execution }"}</code>; the trio is disabled so no silent reshape
          happens here. Edit in Raw JSON to change it now.
        </div>
      </div>
    );
  }
  return (
    <div className="timeout-trio">
      <span className="field-label">mcp.timeout (global, ms)</span>
      <div className="timeout-fields">
        {MCP_TIMEOUT_KEYS.map((key) => (
          <label key={key}>
            <span className="field-label">{key}</span>
            <input
              type="text"
              inputMode="numeric"
              spellCheck={false}
              value={typeof values[key] === "number" ? String(values[key]) : ""}
              placeholder="unset"
              onChange={(event) => apply(timeoutTrioEdits(timeout, key as McpTimeoutKey, event.target.value))}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function pendingTouches(edits: PathEdit[]): string {
  return `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
}
