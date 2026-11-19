import { useEffect, useRef, useState } from "react";

import type { Issue } from "../../core/types";
import type { CurrentConfig, ToastKind } from "../App";
import { getConfig, saveConfig, type SaveOutcome } from "../api";

interface RawJsonTabProps {
  config: CurrentConfig;
  folder: string | undefined;
  onSaved: (text: string, sha256: string, backupPath: string) => void;
  onReload: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
}

/**
 * Raw JSONC editor. The staleness contract: every save sends the sha256 and
 * issues of the text we LOADED (the base), never whatever we think the disk
 * holds. A 409 `stale` offers Reload (drop edits) or Force save (fetch the
 * fresh disk sha, then save THIS editor text against it — still server-
 * validated and backed up, never a blind overwrite). `new_issues` lists the
 * blocking problems and refuses; the edits stay in the textarea.
 */
export function RawJsonTab({ config, folder, onSaved, onReload, onToast }: RawJsonTabProps) {
  const [text, setText] = useState(config.text);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [blockedIssues, setBlockedIssues] = useState<Issue[] | null>(null);
  // The text App echoes back into `config.text` after OUR save. The re-seed
  // effect below must not mistake that echo for a (re)load from disk — else
  // edits typed during the save round-trip would be wiped.
  const lastSavedText = useRef<string | null>(null);

  // Re-seed the editor when the config is (re)loaded from disk — a reload or
  // a config switch (switches also remount via the App-side `key`).
  useEffect(() => {
    if (config.text === lastSavedText.current) return;
    setText(config.text);
    setStale(false);
    setBlockedIssues(null);
  }, [config.text]);

  const handleOutcome = (outcome: SaveOutcome): void => {
    switch (outcome.kind) {
      case "ok":
        setStale(false);
        setBlockedIssues(null);
        lastSavedText.current = text; // mark the echo App will hand back
        onSaved(text, outcome.sha256, outcome.backupPath);
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

  const save = async () => {
    setSaving(true);
    try {
      handleOutcome(await saveConfig(config.path, text, config.sha256, config.issues, folder));
    } finally {
      setSaving(false);
    }
  };

  // Force save = refetch (fresh disk sha) + explicit re-save of the editor
  // text against that fresh base. Two server round-trips on purpose: the
  // write still goes through the staleness check, validation and backup.
  const forceSave = async () => {
    setSaving(true);
    try {
      const fresh = await getConfig(config.path, folder);
      if (fresh.kind !== "ok") {
        onToast(`Could not refresh the file from disk: ${fresh.message}`, "error");
        return;
      }
      handleOutcome(
        await saveConfig(config.path, text, fresh.data.sha256, fresh.data.issues, folder),
      );
    } finally {
      setSaving(false);
    }
  };

  const dirty = text !== config.text;

  return (
    <section className="raw-tab">
      <div className="raw-path" title={config.path}>
        {config.path}
        {dirty && <span className="dirty-marker"> unsaved</span>}
      </div>

      {stale && (
        <div className="stale-banner">
          The file changed on disk since you loaded it — your edits are not lost.{" "}
          <button type="button" onClick={onReload}>
            Reload
          </button>{" "}
          <button type="button" onClick={() => void forceSave()} disabled={saving || !dirty}>
            Force save
          </button>{" "}
          <span className="hint">(Force save overwrites the disk copy with your editor text — it is
          still validated and backed up.)</span>
        </div>
      )}

      {blockedIssues !== null && (
        <div className="issues-banner">
          <div>Save refused — your edit introduces new validation errors:</div>
          <ul>
            {blockedIssues.map((issue, index) => (
              <li key={`${issue.path}|${issue.message}|${index}`}>
                <code>{issue.path || "(document)"}</code>: {issue.message}
              </li>
            ))}
          </ul>
          <div className="hint">Fix them above; your edits are kept in the editor.</div>
        </div>
      )}

      <textarea
        className="json-editor"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <div className="raw-actions">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onReload} disabled={saving}>
          Reload from disk
        </button>
        <span className="sha-hint" title="SHA-256 of the last text loaded from or saved to disk">
          {config.sha256.slice(0, 12)}…
        </span>
      </div>
    </section>
  );
}
