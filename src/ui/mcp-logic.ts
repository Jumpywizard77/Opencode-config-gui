import type { JsonValue, PathEdit } from "../core/types";
import type { DocShape } from "./components/ProviderList";

/**
 * Pure per-entry path/polarity logic for the MCP tab, extracted so the
 * polarity rules are unit-pinned (test/ui/mcp-logic.test.ts) rather than
 * implied by component behaviour.
 *
 * The cardinal rule (Task 12 ruling): the CONTAINER an entry lives in
 * decides BOTH where edits target and which disable key it speaks —
 * legacy flat `mcp.<name>` entries keep `enabled`, v2 `mcp.servers.<name>`
 * entries use `disabled`. The UI never flips polarity and never migrates
 * an entry between containers; that is the Upgrade dialog's job.
 */

export type McpContainer = "flat" | "servers";
export type McpType = "local" | "remote";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One row of the MCP list: which container, the entry name and its value. */
export interface McpEntryView {
  container: McpContainer;
  name: string;
  /** Parsed object; EMPTY when `notObject` (the editor refuses to edit it). */
  value: Obj;
  /** True when the raw value is not an object — Raw JSON territory. */
  notObject: boolean;
}

/** Entries from both containers: flat `mcp.*` (minus `timeout`/`servers`) plus `mcp.servers.*`. */
export function collectMcpEntries(doc: JsonValue | undefined): McpEntryView[] {
  if (!isObj(doc)) return [];
  const mcp = doc["mcp"];
  if (!isObj(mcp)) return [];
  const out: McpEntryView[] = [];
  const push = (container: McpContainer, name: string, raw: JsonValue): void => {
    out.push({ container, name, value: isObj(raw) ? raw : {}, notObject: !isObj(raw) });
  };
  for (const [name, raw] of Object.entries(mcp)) {
    if (name === "timeout" || name === "servers") continue;
    push("flat", name, raw);
  }
  const servers = mcp["servers"];
  if (isObj(servers)) {
    for (const [name, raw] of Object.entries(servers)) {
      push("servers", name, raw);
    }
  }
  return out;
}

/** Key-path of an entry: `["mcp", name]` (flat) or `["mcp", "servers", name]` (v2). */
export function mcpEntryPath(container: McpContainer, name: string): (string | number)[] {
  return container === "flat" ? ["mcp", name] : ["mcp", "servers", name];
}

/**
 * Where a NEW entry is created: the container already in use wins, otherwise
 * the document's own shape (mirrors the Providers tab's "new providers go to
 * the doc's OWN container" rule).
 */
export function pickMcpContainer(mcpBlock: JsonValue | undefined, docShape: DocShape): McpContainer {
  if (isObj(mcpBlock)) {
    if (isObj(mcpBlock["servers"])) return "servers";
    if (Object.keys(mcpBlock).some((k) => k !== "timeout" && k !== "servers")) return "flat";
  }
  return docShape === "v1" ? "flat" : "servers";
}

/** The variant whose fields to render: stored `type`, else inferred from `url`. */
export function activeMcpType(value: Obj): McpType {
  if (value["type"] === "remote") return "remote";
  if (value["type"] === "local") return "local";
  return typeof value["url"] === "string" ? "remote" : "local";
}

/** Read the container's own disable marker: legacy `enabled === false` / v2 `disabled === true`. */
export function isEntryDisabled(value: Obj, container: McpContainer): boolean {
  return container === "flat" ? value["enabled"] === false : value["disabled"] === true;
}

/**
 * Check/uncheck the disabled box. Checked writes the container's disable
 * marker; unchecked DELETES it (enabled is the implicit default in both
 * shapes) — the other shape's key is never written.
 */
export function disabledToggleEdits(
  path: (string | number)[],
  container: McpContainer,
  disabled: boolean,
): PathEdit[] {
  if (container === "flat") {
    return [{ path: [...path, "enabled"], value: disabled ? false : undefined }];
  }
  return [{ path: [...path, "disabled"], value: disabled ? true : undefined }];
}

const LOCAL_ONLY_KEYS = ["command", "cwd", "environment"];
const REMOTE_ONLY_KEYS = ["url", "headers", "oauth"];

/**
 * Switch local↔remote: set `type` and DELETE the keys that belong only to the
 * variant being left (both schemas are `additionalProperties: false`, so
 * leaving them behind would fail validation on every save anyway).
 */
export function switchMcpTypeEdits(path: (string | number)[], nextType: McpType): PathEdit[] {
  const dropped = nextType === "local" ? REMOTE_ONLY_KEYS : LOCAL_ONLY_KEYS;
  return [
    { path: [...path, "type"], value: nextType },
    ...dropped.map((key) => ({ path: [...path, key], value: undefined })),
  ];
}

/** Rename = delete the old key and re-create the whole value under the new name. */
export function renameMcpEdits(
  path: (string | number)[],
  newName: string,
  value: JsonValue,
): PathEdit[] {
  return [
    { path, value: undefined },
    { path: [...path.slice(0, -1), newName], value },
  ];
}

/** The three keys of the v2 global-timeout object. */
export const MCP_TIMEOUT_KEYS = ["startup", "catalog", "execution"] as const;
export type McpTimeoutKey = (typeof MCP_TIMEOUT_KEYS)[number];

/** Shape of `mcp.timeout` for the trio UI: the numeric form is legacy-only. */
export function mcpGlobalTimeoutForm(
  mcpBlock: JsonValue | undefined,
): "absent" | "numeric" | "object" {
  const timeout = isObj(mcpBlock) ? mcpBlock["timeout"] : undefined;
  if (typeof timeout === "number") return "numeric";
  if (isObj(timeout)) return "object";
  return "absent";
}

/**
 * Edit one field of the `mcp.timeout` { startup, catalog, execution } trio.
 *  - the deprecated NUMERIC form gets NO edits: reshaping it is the Upgrade
 *    dialog's job (with a report line), not a keystroke in the trio;
 *  - blank clears one key, and clearing the LAST key deletes `mcp.timeout`
 *    itself so no `{}` debris is written;
 *  - only positive integers are written (mirrors the schema).
 */
export function timeoutTrioEdits(
  timeout: JsonValue | undefined,
  key: McpTimeoutKey,
  next: string,
): PathEdit[] {
  if (timeout !== undefined && !isObj(timeout)) return []; // numeric or foreign shape
  if (next.trim() === "") {
    const remaining = isObj(timeout)
      ? Object.keys(timeout).filter((k) => k !== key && timeout[k] !== undefined)
      : [];
    return remaining.length === 0
      ? [{ path: ["mcp", "timeout"], value: undefined }]
      : [{ path: ["mcp", "timeout", key], value: undefined }];
  }
  const parsed = /^\d+$/.test(next.trim()) ? Number(next.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return [];
  return [{ path: ["mcp", "timeout", key], value: parsed }];
}
