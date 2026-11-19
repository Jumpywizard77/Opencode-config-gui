import { useEffect, useState } from "react";

import type { ToastKind } from "../App";
import { refreshSchema, type SchemaRefreshPayload, type StatePayload } from "../api";

interface SchemaBadgeProps {
  /** Server state for the active probe folder (null while loading). */
  state: StatePayload | null;
  onToast: (message: string, kind?: ToastKind) => void;
}

/**
 * Schema provenance badge for the topbar: green `remote (<fetchedAt>)`,
 * amber `bundled`, or a RED degraded notice when even the bundled schema is
 * missing (`schemaFetchedAt === "bundled-missing"` → validation disabled).
 * The refresh button re-downloads the live schema and updates the badge from
 * the response; the detected OpenCode version rides beside it.
 */
export function SchemaBadge({ state, onToast }: SchemaBadgeProps) {
  const [override, setOverride] = useState<SchemaRefreshPayload | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh server state (folder switch / refetch) supersedes any local
  // post-refresh override.
  useEffect(() => {
    setOverride(null);
  }, [state]);

  const source = override?.schemaSource ?? state?.schemaSource;
  const fetchedAt = override?.schemaFetchedAt ?? state?.schemaFetchedAt;

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await refreshSchema();
      if (result.kind === "ok") {
        setOverride(result.data);
        onToast(`Schema refreshed: ${result.data.schemaSource}.`);
      } else {
        onToast(`Schema refresh failed: ${result.message}`, "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="schema-badge">
      {state === null && override === null ? (
        <span className="provenance">…</span>
      ) : fetchedAt === "bundled-missing" ? (
        <span className="badge badge-degraded" title="Neither the remote nor the bundled schema is available">
          validation disabled — schema unavailable
        </span>
      ) : source === "remote" ? (
        <span className="badge badge-green" title="Schema downloaded from opencode.ai">
          remote ({fetchedAt})
        </span>
      ) : (
        <span className="badge badge-amber" title="Shipped-with-the-app schema (stale but valid)">
          bundled
        </span>
      )}
      <button type="button" onClick={() => void refresh()} disabled={busy || state === null}>
        {busy ? "Refreshing…" : "refresh schema"}
      </button>
      <span className="provenance" title="OpenCode CLI detected on PATH">
        OpenCode: {state === null ? "…" : state.opencodeVersion ?? "not found"}
      </span>
    </span>
  );
}
