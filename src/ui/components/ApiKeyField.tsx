import { useState } from "react";

import type { JsonValue } from "../../core/types";

/** `{env:NAME}` / `{file:path}` reference forms opencode resolves at runtime. */
const WRAPPER = /^\{(env|file):([\s\S]*)\}$/;

interface ApiKeyFieldProps {
  label: string;
  /** Stored value (`undefined` = unset). May be a literal or a wrapper form. */
  value: JsonValue | undefined;
  onChange: (next: JsonValue | undefined) => void;
}

/**
 * API key text input with a mask toggle and `{env:…}` / `{file:…}` wrap
 * buttons. Unwrap is EXPLICIT and non-destructive: it shows the inner value
 * as a literal with a note; editing the field is what commits the literal,
 * and blur NEVER silently unwraps.
 */
export function ApiKeyField({ label, value, onChange }: ApiKeyFieldProps) {
  const stored =
    typeof value === "string"
      ? value
      : value === undefined
        ? undefined
        : JSON.stringify(value); // non-string oddity: shown as JSON, editing replaces it
  const [revealed, setRevealed] = useState(false);
  const [unwrapped, setUnwrapped] = useState<{ literal: string; wrapper: string } | null>(null);

  const displayed = unwrapped !== null ? unwrapped.literal : (stored ?? "");
  const isWrapper = stored !== undefined && WRAPPER.test(stored);
  // Reference forms are not themselves secret; mask only literal keys.
  const masked = !revealed && unwrapped === null && !isWrapper;

  const commit = (next: string): void => {
    setUnwrapped(null); // any edit finalizes whatever the field shows right now
    onChange(next === "" ? undefined : next);
  };

  const wrapWith = (kind: "env" | "file"): void => {
    const answer = window.prompt(
      kind === "env"
        ? "Environment variable name to store the key as ({env:NAME}):"
        : "Path of a file containing the key ({file:PATH}):",
    );
    if (answer === null) return;
    const trimmed = answer.trim();
    if (trimmed === "") return;
    setUnwrapped(null);
    onChange(`{${kind}:${trimmed}}`);
  };

  return (
    <div className="api-key-field">
      <span className="field-label">{label}</span>
      <div className="api-key-row">
        <input
          type={masked ? "password" : "text"}
          spellCheck={false}
          value={displayed}
          onChange={(event) => commit(event.target.value)}
        />
        <button type="button" onClick={() => setRevealed((shown) => !shown)}>
          {revealed ? "hide" : "show"}
        </button>
        <button type="button" onClick={() => wrapWith("env")} title="Replace the value with {env:NAME}">
          {"{env:…}"}
        </button>
        <button type="button" onClick={() => wrapWith("file")} title="Replace the value with {file:PATH}">
          {"{file:…}"}
        </button>
        <button
          type="button"
          disabled={!isWrapper}
          title="Preview the literal inside this wrapper (only an edit commits it)"
          onClick={() => {
            const match = WRAPPER.exec(stored ?? "");
            if (match !== null) setUnwrapped({ literal: match[2], wrapper: match[0] });
          }}
        >
          unwrap
        </button>
      </div>
      {unwrapped !== null && (
        <div className="hint">
          Previewing the literal inside <code>{unwrapped.wrapper}</code>. Editing the field replaces
          the wrapper with this literal; leaving the field does <strong>not</strong> unwrap it.
        </div>
      )}
    </div>
  );
}
