import { useCallback, useEffect, useMemo, useState } from "react";

import type { CurrentConfig, ToastKind } from "../App";
import { getConfig, saveConfig, type SaveOutcome } from "../api";
import { parseJsonc } from "../../core/jsonc";
import type { Issue, JsonValue, PathEdit } from "../../core/types";
import { editInText } from "../editor-path";
import { ProviderEditor } from "./ProviderEditor";

/** Legacy opencode v1 stores providers under `provider`; v2 uses `providers`. */
export type DocShape = "v1" | "v2";

/**
 * Field spelling follows the CONTAINER an entry lives in, not the doc-level
 * flag: a `providers`-shaped entry inside a legacy doc still wants
 * `package`/`settings`/variant-arrays (the schema validates per container,
 * `additionalProperties: false`). `docShape` itself only drives the legacy
 * banner and where NEW providers are created.
 */
export function entryShape(container: "provider" | "providers"): DocShape {
  return container === "provider" ? "v1" : "v2";
}

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compute the doc shape once, on load: which provider container exists? */
export function detectDocShape(text: string): DocShape {
  const { value } = parseJsonc(text);
  return isObj(value) && value["provider"] !== undefined ? "v1" : "v2";
}

interface ProviderEntry {
  container: "provider" | "providers";
  id: string;
  value: Obj;
}

interface Selection {
  container: "provider" | "providers";
  id: string;
}

interface ProviderListProps {
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
}

/**
 * The Providers tab. Holds a LIST OF PENDING `PathEdit[]` (not a text copy):
 * the displayed doc is `editInText(config.text, edits)` recomputed per edit,
 * and Save compiles the edits to full new text client-side and sends it
 * through the normal sha256+issues save pipeline. Stale/new_issues handling
 * mirrors RawJsonTab (the text being saved is simply the edited one).
 * Switching tabs discards pending edits (React remount) — App confirms.
 */
export function ProviderList({
  config,
  folder,
  docShape,
  loadNonce,
  onSaved,
  onReload,
  onToast,
  onDirty,
}: ProviderListProps) {
  const [edits, setEdits] = useState<PathEdit[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [newProviderId, setNewProviderId] = useState("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [blockedIssues, setBlockedIssues] = useState<Issue[] | null>(null);

  useEffect(() => {
    setEdits([]);
    setSelected(null);
    setNewProviderId("");
    setStale(false);
    setBlockedIssues(null);
  }, [loadNonce]);

  const dirty = edits.length > 0;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  // Parse guard: applyPathEdits REFUSES malformed JSONC, so with hard parse
  // issues the structured tab is disabled until the Raw tab fixes them.
  const baseParse = useMemo(() => parseJsonc(config.text), [config.text]);
  const parseBroken = baseParse.errors.length > 0 || !isObj(baseParse.value);

  const [derived, derivedError] = useMemo((): [string | null, string | null] => {
    if (parseBroken) return [null, null];
    try {
      return [editInText(config.text, edits), null];
    } catch (err) {
      // Should not happen: the pending edits are produced against this same
      // text. Defensive per the controller ruling (applyPathEdits throws).
      return [
        null,
        `Structured edit failed: ${err instanceof Error ? err.message : String(err)} — reload from disk to start over.`,
      ];
    }
  }, [config.text, edits, parseBroken]);

  const doc = derived === null ? null : (parseJsonc(derived).value as Obj | undefined);
  const entries = collectEntries(doc ?? undefined);
  const selectedEntry =
    selected === null
      ? undefined
      : entries.find((e) => e.container === selected.container && e.id === selected.id);

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
      <section className="provider-list-tab">
        <div className="error-banner">
          This config has parse errors — fix them in the Raw JSON tab first; structured editing is
          disabled while the document does not parse.
        </div>
      </section>
    );
  }

  return (
    <section className="provider-list-tab">
      {derivedError !== null && <div className="error-banner">{derivedError}</div>}

      {docShape === "v1" && (
        <div className="legacy-banner">
          legacy shape — providers live under <code>provider</code>; edits stay there (no silent
          migration).{" "}
          {/* TODO(Task 12): open the Upgrade preview/apply dialog from here. */}
          <button type="button" disabled title="Upgrade preview ships in a later task.">
            Upgrade
          </button>
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
          <div className="provider-list-head">Providers ({entries.length})</div>
          {entries.map((entry) => (
            <div
              key={`${entry.container}|${entry.id}`}
              className={`provider-row${selectedEntry?.id === entry.id && selectedEntry?.container === entry.container ? " provider-row-active" : ""}`}
            >
              <button type="button" onClick={() => setSelected({ container: entry.container, id: entry.id })}>
                {entry.id}
              </button>
              <span
                className="shape-badge"
                title={`stored under "${entry.container}" (${entry.container === "provider" ? "v1 legacy" : "v2"})`}
              >
                {entry.container === "provider" ? "v1" : "v2"}
              </span>
            </div>
          ))}
          {entries.length === 0 && <div className="hint">no providers yet</div>}
          <div className="provider-add">
            <input
              type="text"
              spellCheck={false}
              placeholder="new provider id"
              value={newProviderId}
              onChange={(event) => setNewProviderId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addProvider();
              }}
            />
            <button type="button" onClick={addProvider} disabled={newProviderId.trim() === ""}>
              + add
            </button>
          </div>
        </div>

        <div className="provider-detail">
          {selectedEntry === undefined ? (
            <div className="hint">Select a provider to edit it, or add one.</div>
          ) : (
            <>
              <div className="provider-detail-head">
                <span className="field-label">
                  {selectedEntry.container}
                  {"."}
                  {selectedEntry.id}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete provider "${selectedEntry.id}" and all its models?`)) {
                      apply([{ path: [selectedEntry.container, selectedEntry.id], value: undefined }]);
                      setSelected(null);
                    }
                  }}
                >
                  delete provider
                </button>
              </div>
              <ProviderEditor
                key={`${selectedEntry.container}|${selectedEntry.id}`}
                entryId={selectedEntry.id}
                entry={selectedEntry.value}
                path={[selectedEntry.container, selectedEntry.id]}
                otherIds={entries
                  .filter((e) => e.container === selectedEntry.container && e.id !== selectedEntry.id)
                  .map((e) => e.id)}
                shape={entryShape(selectedEntry.container)}
                apply={apply}
                onToast={onToast}
                onRenamed={(newId) => setSelected({ container: selectedEntry.container, id: newId })}
              />
            </>
          )}
        </div>
      </div>

      <div className="raw-actions">
        <button type="button" onClick={() => void save()} disabled={saving || !dirty || derived === null}>
          {saving ? "Saving…" : `Save${dirty ? ` (${pendingTouches(edits)})` : ""}`}
        </button>
        <button type="button" onClick={onReload} disabled={saving}>
          Reload from disk
        </button>
        {dirty && <span className="dirty-marker">unsaved provider changes</span>}
      </div>
    </section>
  );

  function addProvider(): void {
    const id = newProviderId.trim();
    if (id === "" || entries.some((e) => e.id === id)) return;
    // New providers go to the doc's OWN container — never migrate silently.
    const container = docShape === "v1" ? "provider" : "providers";
    apply([{ path: [container, id], value: {} }]);
    setNewProviderId("");
    setSelected({ container, id });
  }
}

function collectEntries(doc: Obj | undefined): ProviderEntry[] {
  if (doc === undefined) return [];
  const out: ProviderEntry[] = [];
  for (const container of ["provider", "providers"] as const) {
    const block = doc[container];
    if (!isObj(block)) continue;
    for (const [id, value] of Object.entries(block)) {
      if (isObj(value)) {
        out.push({ container, id, value });
      } else {
        out.push({ container, id, value: {} });
      }
    }
  }
  return out;
}

function pendingTouches(edits: PathEdit[]): string {
  return `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
}
