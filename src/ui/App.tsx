import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Issue } from "../core/types";
import { getConfig, getState, type StatePayload } from "./api";
import { ConfigPicker } from "./components/ConfigPicker";
import { detectDocShape, ProviderList } from "./components/ProviderList";
import { RawJsonTab } from "./components/RawJsonTab";
import { Toast, type ToastMessage } from "./components/Toast";
import { ValidationPanel } from "./components/ValidationPanel";

/** The config currently open in the editor (brief-mandated shape). */
export interface CurrentConfig {
  path: string;
  text: string;
  sha256: string;
  issues: Issue[];
}

/**
 * Applies a successful save to the open config — but ONLY when the save's
 * `path` still matches the config on screen. A save whose response lands
 * while the user is switching to a different config must not stamp its
 * text/sha256 onto the OTHER file's editor state (the disk write itself is
 * already correctly scoped by the server's per-path staleness check).
 * Exported for unit pinning: this is the whole cross-config guard.
 */
export function applySavedToConfig(
  previous: CurrentConfig | null,
  saved: { path: string; text: string; sha256: string },
): CurrentConfig | null {
  if (previous === null || previous.path !== saved.path) return previous;
  return { ...previous, text: saved.text, sha256: saved.sha256 };
}

export type ToastKind = "info" | "error";

type TabId = "providers" | "mcp" | "raw";

const TABS: { id: TabId; label: string; placeholder: string | null }[] = [
  { id: "providers", label: "Providers", placeholder: null },
  { id: "mcp", label: "MCP", placeholder: "MCP editing — coming in a later task." },
  { id: "raw", label: "Raw JSON", placeholder: null },
];

export function App() {
  // Server-side state for the ACTIVE probe folder (undefined = server default).
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [state, setState] = useState<StatePayload | null>(null);
  const [currentConfig, setCurrentConfig] = useState<CurrentConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("raw");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // Bumped every time a config payload is applied from disk (select/reload).
  // The editor re-seeds on THIS counter, not on text identity, so a reload
  // whose text happens to equal what we hold still resets the textarea.
  const [loadNonce, setLoadNonce] = useState(0);
  // Unsaved structured edits live in the Providers tab's state; a tab switch
  // (remount) discards them, so App confirms first while this is true.
  const [providersDirty, setProvidersDirty] = useState(false);
  const toastId = useRef(0);
  // Sequence guard for selectConfig (the state effect's cancelled-flag
  // pattern for a callback): only the latest load may apply.
  const loadSeq = useRef(0);

  const addToast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = (toastId.current += 1);
    setToasts((previous) => [...previous, { id, message, kind }]);
    setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  // Re-fetch the server state whenever the probe folder changes.
  useEffect(() => {
    let cancelled = false;
    void getState(folder).then((result) => {
      if (cancelled) return;
      if (result.kind === "ok") {
        setState(result.data);
      } else {
        addToast(`Could not load server state: ${result.message}`, "error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [folder, addToast]);

  const selectConfig = useCallback(
    async (path: string) => {
      const seq = (loadSeq.current += 1);
      const result = await getConfig(path, folder);
      // A newer selection (or folder switch) superseded this response: drop
      // it so out-of-order replies can never open a stale config.
      if (loadSeq.current !== seq) return;
      if (result.kind === "ok") {
        setCurrentConfig({ path, ...result.data });
        setLoadNonce((nonce) => nonce + 1);
        setLoadError(null);
      } else {
        setCurrentConfig(null);
        setLoadError(`Could not open ${path}: ${result.message}`);
      }
    },
    [folder],
  );

  const reloadCurrentConfig = useCallback(() => {
    if (currentConfig !== null) void selectConfig(currentConfig.path);
  }, [currentConfig, selectConfig]);

  // A successful save means the disk holds exactly the saved text for THAT
  // path: sync both the editor-seed text and the staleness token, but only
  // while that path is still the open config (see applySavedToConfig).
  const handleSaved = useCallback(
    (path: string, text: string, sha256: string, backupPath: string) => {
      setCurrentConfig((previous) => applySavedToConfig(previous, { path, text, sha256 }));
      addToast(`Saved. Backup: ${backupPath}`);
    },
    [addToast],
  );

  const handleOpenFolder = useCallback((nextFolder: string) => {
    loadSeq.current += 1; // a config load for the OLD folder may no longer apply
    setFolder(nextFolder);
    setCurrentConfig(null);
    setLoadError(null);
  }, []);

  // Computed ONCE per config load (controller ruling): the parsed root's
  // container key decides whether structured edits target v1 `provider.*`
  // or v2 `providers.*` paths. Saves never migrate the shape, so the memo
  // deliberately keys on the LOAD (path + nonce), not on our own saves' text.
  const docShape = useMemo(
    () => (currentConfig === null ? "v2" : detectDocShape(currentConfig.text)),
    [currentConfig?.path, loadNonce], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const switchTab = useCallback(
    (next: TabId) => {
      if (tab === "providers" && next !== tab && providersDirty) {
        if (!window.confirm("Discard the unsaved provider changes in the Providers tab?")) return;
      }
      setTab(next);
    },
    [tab, providersDirty],
  );

  const activeTab = TABS.find((entry) => entry.id === tab);

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="app-title">opencode config</h1>
        <ConfigPicker
          configs={state?.configs ?? []}
          selectedPath={currentConfig?.path ?? ""}
          onSelect={(path) => void selectConfig(path)}
          onOpenFolder={handleOpenFolder}
        />
        <span className="provenance" title="Schema provenance reported by the server">
          {state === null
            ? "…"
            : `schema: ${state.schemaSource} (${state.schemaFetchedAt}) · opencode ${state.opencodeVersion ?? "unknown"}`}
        </span>
      </header>

      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tab${tab === entry.id ? " tab-active" : ""}${entry.placeholder !== null ? " tab-later" : ""}`}
            onClick={() => switchTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <ValidationPanel
        issues={currentConfig?.issues ?? []}
        state={state}
        hasConfig={currentConfig !== null}
      />

      <main className="content">
        {loadError !== null && <div className="error-banner">{loadError}</div>}
        {activeTab?.placeholder !== null && activeTab?.placeholder !== undefined ? (
          <section className="placeholder">{activeTab.placeholder}</section>
        ) : currentConfig === null ? (
          <section className="placeholder">
            Select a config file above to edit it.
          </section>
        ) : tab === "providers" ? (
          <ProviderList
            key={currentConfig.path}
            config={currentConfig}
            folder={folder}
            docShape={docShape}
            loadNonce={loadNonce}
            onSaved={handleSaved}
            onReload={reloadCurrentConfig}
            onToast={addToast}
            onDirty={setProvidersDirty}
          />
        ) : (
          <RawJsonTab
            key={currentConfig.path}
            config={currentConfig}
            folder={folder}
            loadNonce={loadNonce}
            onSaved={handleSaved}
            onReload={reloadCurrentConfig}
            onToast={addToast}
          />
        )}
      </main>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
