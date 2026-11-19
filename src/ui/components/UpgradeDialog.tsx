import { useCallback, useEffect, useState } from "react";

import type { CurrentConfig, ToastKind } from "../App";
import { upgradeApply, upgradePreview, type UpgradePreviewPayload } from "../api";
import type { Issue } from "../../core/types";

type PreviewState =
  | { phase: "loading" }
  | { phase: "ok"; data: UpgradePreviewPayload }
  | { phase: "error"; message: string };

type ApplyState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "new_issues"; issues: Issue[] }
  | { phase: "stale" }
  | { phase: "error"; message: string };

interface UpgradeDialogProps {
  config: CurrentConfig;
  folder: string | undefined;
  /** Server-detected OpenCode version for the standing "recent OpenCode" note. */
  opencodeVersion: string | null;
  onToast: (message: string, kind?: ToastKind) => void;
  /** Re-loads the config from disk (after a successful apply or a stale refusal). */
  onReload: () => void;
  onClose: () => void;
}

/**
 * v1→v2 upgrade preview/apply dialog. The preview always comes from the
 * SERVER migrating the DISK text (`upgradePreview`), so what is shown is
 * exactly what `upgradeApply` will write — Apply vouches for staleness with
 * the CURRENT config `sha256`+`issues` at click time (Task 12 ruling), and a
 * successful apply RELOADS the config so every tab re-seeds from the new text.
 * A `new_issues` refusal disables Apply and points at the Raw JSON tab: two
 * different files changed underneath the issue-policy comparison.
 */
export function UpgradeDialog({
  config,
  folder,
  opencodeVersion,
  onToast,
  onReload,
  onClose,
}: UpgradeDialogProps) {
  const [preview, setPreview] = useState<PreviewState>({ phase: "loading" });
  const [applyState, setApplyState] = useState<ApplyState>({ phase: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPreview({ phase: "loading" });
    void upgradePreview(config.path, folder).then((result) => {
      if (cancelled) return;
      setPreview(result.kind === "ok" ? { phase: "ok", data: result.data } : { phase: "error", message: result.message });
    });
    return () => {
      cancelled = true;
    };
  }, [config.path, folder, attempt]);

  const applyUpgrade = useCallback(async (): Promise<void> => {
    setApplyState({ phase: "busy" });
    const outcome = await upgradeApply(config.path, config.sha256, config.issues, folder);
    switch (outcome.kind) {
      case "ok":
        onToast(`Upgrade applied. Backup: ${outcome.backupPath}`);
        onReload(); // re-seed every tab from the migrated text
        onClose();
        break;
      case "stale":
        setApplyState({ phase: "stale" });
        break;
      case "new_issues":
        setApplyState({ phase: "new_issues", issues: outcome.newIssues });
        break;
      case "error":
        setApplyState({ phase: "error", message: outcome.message });
        break;
    }
  }, [config.path, config.sha256, config.issues, folder, onToast, onReload, onClose]);

  const applying = applyState.phase === "busy";

  return (
    <div className="dialog-overlay">
      <div className="dialog upgrade-dialog" role="dialog" aria-modal="true" aria-label="Upgrade v1 to v2">
        <h2>Upgrade config v1 → v2</h2>
        <div className="upgrade-notice">
          v2 keys need a recent OpenCode — detected: <code>OpenCode: {opencodeVersion ?? "not found"}</code>
        </div>
        <div className="raw-path" title="Target file">
          {config.path}
        </div>

        {preview.phase === "loading" && <div className="hint">Computing migration preview…</div>}
        {preview.phase === "error" && (
          <div className="error-banner">
            Preview failed: {preview.message}{" "}
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {applyState.phase === "stale" && (
          <div className="stale-banner">
            The file changed on disk since you loaded it — nothing was written.{" "}
            <button
              type="button"
              onClick={() => {
                onReload();
                onClose();
              }}
            >
              Reload and close
            </button>
          </div>
        )}
        {applyState.phase === "new_issues" && (
          <div className="issues-banner">
            <div>Another file has changes — the migrated document fails validation, so nothing was written:</div>
            <ul>
              {applyState.issues.map((issue, index) => (
                <li key={`${issue.path}|${issue.message}|${index}`}>
                  <code>{issue.path || "(document)"}</code>: {issue.message}
                </li>
              ))}
            </ul>
            <div className="hint">Use the Raw JSON tab to convert by hand.</div>
          </div>
        )}
        {applyState.phase === "error" && <div className="error-banner">Apply failed: {applyState.message}</div>}

        {preview.phase === "ok" && (
          <>
            {preview.data.report.changes.length === 0 && (
              <div className="hint">Nothing to change — this config is already in v2 shape.</div>
            )}
            {preview.data.report.changes.length > 0 && (
              <div className="upgrade-lists">
                <div>
                  <span className="field-label">Changes ({preview.data.report.changes.length})</span>
                  <ul>
                    {preview.data.report.changes.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </div>
                {preview.data.report.leftUnchanged.length > 0 && (
                  <div>
                    <span className="field-label">Left unchanged ({preview.data.report.leftUnchanged.length})</span>
                    <ul>
                      {preview.data.report.leftUnchanged.map((entry, index) => (
                        <li key={index}>
                          <code>{entry.path || "(document)"}</code>: {entry.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <pre className="upgrade-diff">{preview.data.diff}</pre>
          </>
        )}

        <div className="raw-actions">
          <button type="button" onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void applyUpgrade()}
            disabled={applying || preview.phase !== "ok" || applyState.phase === "new_issues"}
          >
            {applying ? "Applying…" : "Apply upgrade"}
          </button>
        </div>
      </div>
    </div>
  );
}
