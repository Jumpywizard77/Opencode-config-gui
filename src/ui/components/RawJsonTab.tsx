import { useEffect, useState } from "react";

import type { Issue } from "../../core/types";
import type { CurrentConfig, ToastKind } from "../App";
import { getConfig, saveConfig, type SaveOutcome } from "../api";

interface RawJsonTabProps {
  config: CurrentConfig;
  folder: string | undefined;
  /** Bumped by App on every disk load (select/reload) — the re-seed trigger. */
  loadNonce: number;
  onSaved: (path: string, text: string, sha256: string, backupPath: string) => void;
  onReload: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
  /** Reports unsaved textarea text so App can confirm on tab/config/folder switch. */
  onDirty: (dirty: boolean) => void;
}

/**
 * Raw JSONC editor. The staleness contract: every save sends the sha256 and
 * issues of the text we LOADED (the base), never whatever we think the disk
 * holds. A 409 `stale` offers Reload (drop edits) or Force save (fetch the
 * fresh disk sha, then save THIS editor text against it — still server-
 * validated and backed up, never a blind overwrite). `new_issues` lists the
 * blocking problems and refuses; the edits stay in the textarea.
 */
export function RawJsonTab({
  config,
  folder,
  loadNonce,
  onSaved,
  onReload,
  onToast,
  onDirty,
}: RawJsonTabProps) {
  const [text, setText] = useState(config.text);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [blockedIssues, setBlockedIssues] = useState<Issue[] | null>(null);

  // Re-seed on the LOAD NONCE (a disk payload was just applied by App), never
  // on text identity: a reload whose text happens to equal what `config`
  // already holds MUST still reset the textarea and clear the stale/blocked
  // banners. A plain save does NOT bump the nonce — it only syncs
  // config.text/sha256 — so edits typed during the save round-trip survive.
  // Config switches also remount via App's `key`; effects run on mount.
  useEffect(() => {
    setText(config.text);
    setStale(false);
    setBlockedIssues(null);
    // config.text is read fresh from the render the nonce bumped in; the
    // nonce is the only intended trigger.
  }, [loadNonce]);

  // Draft = the textarea differs from the last text seeded from disk (or
  // confirmed by a save). Reported up to App on every change (same contract
  // as the structured tabs): this draft dies on a tab/config/folder switch,
  // so App confirms those first.
  const dirty = text !== config.text;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const handleOutcome = (outcome: SaveOutcome): void => {
    switch (outcome.kind) {
      case "ok":
        setStale(false);
        setBlockedIssues(null);
        onSaved(config.path, text, outcome.sha256, outcome.backupPath);
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

  return (
    <section className="raw-tab">
      <div className="raw-path" title={config.path}>
        {config.path}
        {dirty && <span className="dirty-marker"> unsaved</span>}
      </div>

      {stale && (
        <div className="stale-banner">
          The file changed on disk since you loaded it — your edits are not lost.{" "}
          <button type="button" onClick={onReload} disabled={saving}>
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
