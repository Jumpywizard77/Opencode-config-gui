import { useState } from "react";

import type { ProbeResult } from "../../core/probe";
import type { ToastKind } from "../App";
import { probe } from "../api";

interface EndpointPanelProps {
  baseURL: string;
  /** Literal apiKey only — the caller withholds `{env:…}`/`{file:…}` forms. */
  apiKey: string | undefined;
  onImport: (modelIds: string[]) => void;
  onToast: (message: string, kind?: ToastKind) => void;
}

/**
 * Endpoint health + model import. [test] / [Fetch from endpoint] both run
 * the server-side `probe`; the fetch button additionally opens the checkbox
 * list of discovered `modelIds`, and Import hands the selection to the
 * caller (which writes placeholder-limit model entries and toasts).
 */
export function EndpointPanel({ baseURL, apiKey, onImport, onToast }: EndpointPanelProps) {
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState(false);

  const canRun = baseURL.trim() !== "" && !probing;

  const run = async (forFetch: boolean): Promise<void> => {
    setProbing(true);
    setResult(null);
    setListOpen(false);
    try {
      const outcome = await probe(baseURL.trim(), apiKey);
      if (outcome.kind !== "ok") {
        onToast(`Probe request failed: ${outcome.message}`, "error");
        return;
      }
      setResult(outcome.data);
      if (forFetch && outcome.data.status === "ok" && outcome.data.modelIds.length > 0) {
        setSelected(new Set(outcome.data.modelIds)); // everything pre-checked
        setListOpen(true);
        setImported(false);
      }
    } finally {
      setProbing(false);
    }
  };

  const toggle = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="endpoint-panel">
      <div className="endpoint-actions">
        <button type="button" disabled={!canRun} onClick={() => void run(false)}>
          {probing ? "Probing…" : "test"}
        </button>
        <button type="button" disabled={!canRun} onClick={() => void run(true)}>
          Fetch from endpoint
        </button>
        {baseURL.trim() === "" && <span className="hint">set a baseURL first</span>}
      </div>

      {result !== null && (
        <div className={`probe-status probe-${result.status}`}>
          <span className="probe-chip">{result.status.replace("_", " ")}</span>
          <span className="probe-latency">{result.latencyMs} ms</span>
          <span className="probe-detail">{result.detail}</span>
        </div>
      )}

      {listOpen && result !== null && (
        <div className="probe-models">
          <div className="probe-models-head">
            {result.modelIds.length} model(s) at the endpoint:
          </div>
          <ul className="probe-model-list">
            {result.modelIds.map((id) => (
              <li key={id}>
                <label>
                  <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
                  <code>{id}</code>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={imported || selected.size === 0}
            onClick={() => {
              // Preserve the endpoint's own ordering for the selection.
              onImport(result.modelIds.filter((id) => selected.has(id)));
              setImported(true);
            }}
          >
            Import {selected.size} model(s)
          </button>
          {imported && (
            <span className="hint">
              imported with placeholder limits — already-listed models were left alone
            </span>
          )}
        </div>
      )}
    </div>
  );
}
