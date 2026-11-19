import { useState } from "react";

import type { DiscoveredConfig } from "../../core/discovery";

const OPEN_FOLDER_VALUE = "__open_folder__";

interface ConfigPickerProps {
  configs: DiscoveredConfig[];
  selectedPath: string;
  onSelect: (path: string) => void;
  onOpenFolder: (folder: string) => void;
}

/**
 * Dropdown of the EDITABLE discovered configs (system/managed kinds are
 * detected but never opened for editing) plus an inline "Open folder…" text
 * input that sets the `?folder=` probe folder — App re-fetches state on it.
 */
export function ConfigPicker({ configs, selectedPath, onSelect, onOpenFolder }: ConfigPickerProps) {
  const [folderMode, setFolderMode] = useState(false);
  const [folderInput, setFolderInput] = useState("");

  const editable = configs.filter((config) => config.editable);

  const applyFolder = () => {
    const trimmed = folderInput.trim();
    if (trimmed === "") return;
    onOpenFolder(trimmed);
    setFolderInput("");
    setFolderMode(false);
  };

  return (
    <span className="config-picker">
      <select
        value={selectedPath}
        onChange={(event) => {
          const value = event.target.value;
          if (value === OPEN_FOLDER_VALUE) {
            setFolderMode(true);
          } else if (value !== "") {
            onSelect(value);
          }
        }}
      >
        <option value="">Select a config file…</option>
        {editable.map((config) => (
          <option key={config.path} value={config.path}>
            {config.kind}: {config.path}
          </option>
        ))}
        <option value={OPEN_FOLDER_VALUE}>Open folder…</option>
      </select>
      {folderMode && (
        <span className="folder-input">
          <input
            type="text"
            placeholder="path to a project folder"
            value={folderInput}
            autoFocus
            onChange={(event) => setFolderInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyFolder();
              if (event.key === "Escape") {
                setFolderMode(false);
                setFolderInput("");
              }
            }}
          />
          <button type="button" onClick={applyFolder} disabled={folderInput.trim() === ""}>
            Open
          </button>
          <button
            type="button"
            onClick={() => {
              setFolderMode(false);
              setFolderInput("");
            }}
          >
            Cancel
          </button>
        </span>
      )}
    </span>
  );
}
