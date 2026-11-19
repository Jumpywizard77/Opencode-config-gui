import { useCallback, useEffect, useRef, useState } from "react";

import type { Issue } from "../core/types";
import { getConfig, getState, type StatePayload } from "./api";
import { ConfigPicker } from "./components/ConfigPicker";
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

export type ToastKind = "info" | "error";

type TabId = "providers" | "mcp" | "raw";

const TABS: { id: TabId; label: string; placeholder: string | null }[] = [
  { id: "providers", label: "Providers", placeholder: "Providers editing — coming in a later task." },
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
  const toastId = useRef(0);

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
      const result = await getConfig(path, folder);
      if (result.kind === "ok") {
        setCurrentConfig({ path, ...result.data });
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

  // After a successful save, the disk holds exactly what the editor shows:
  // sync BOTH the editor-seed text and the staleness token. (Re-seeding the
  // textarea on `config.text` then no-ops — the strings are equal — while a
  // real Reload from disk changes the string and reseeds.)
  const handleSaved = useCallback((text: string, sha256: string, backupPath: string) => {
    setCurrentConfig((previous) => (previous === null ? previous : { ...previous, text, sha256 }));
    addToast(`Saved. Backup: ${backupPath}`);
  }, [addToast]);

  const handleOpenFolder = useCallback((nextFolder: string) => {
    setFolder(nextFolder);
    setCurrentConfig(null);
  }, []);

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
            onClick={() => setTab(entry.id)}
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
            Select a config file above to edit it as raw JSONC.
          </section>
        ) : (
          <RawJsonTab
            key={currentConfig.path}
            config={currentConfig}
            folder={folder}
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
