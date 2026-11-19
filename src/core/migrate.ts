import { createTwoFilesPatch } from "diff";

import { parseJsonc } from "./jsonc";
import type { JsonValue } from "./types";

/**
 * Human-readable outcome of `upgradeDocumentText`. Every removal or rewrite
 * appends one line to `changes`; anything the migrator refuses to touch gets a
 * `leftUnchanged` entry with a reason. The v1→v2 upgrade is lossless: no key is
 * ever dropped silently.
 */
export interface MigrationReport {
  changes: string[];
  leftUnchanged: { path: string; reason: string }[];
}

/** v1 `@ai-sdk/*` package values → v2 provider package values (spec rule 2). */
const PACKAGE_MAP: { readonly [k: string]: string } = {
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
  "@ai-sdk/openai": "@opencode/ai/providers/openai",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
  "@ai-sdk/google": "@opencode/ai/providers/google",
  "@ai-sdk/google-vertex": "@opencode/ai/providers/google-vertex",
};

/** Mechanical top-level key renames (spec rules 1, 3, 5). */
const TOP_LEVEL_RENAMES: { readonly [k: string]: string } = {
  provider: "providers",
  plugin: "plugins",
  command: "commands",
  reference: "references",
};

type Obj = { [k: string]: JsonValue };

function isObj(v: JsonValue | undefined): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Documents can contain keys like `constructor`; never trust prototype chains. */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Upgrade a whole opencode config document from the v1 schema to v2.
 *
 * Pure text→text: the document is parsed tolerantly (any parse error aborts the
 * upgrade — nothing is rewritten on top of malformed input), transformed as a
 * `JsonValue` tree, and re-serialized with two-space indentation. Migrated
 * keys keep the original key's position. When nothing changes (already-v2
 * documents) the original text is returned byte-identically with
 * `changes: []`. BOM and CRLF line endings of the input are preserved.
 */
export function upgradeDocumentText(text: string): { text: string; report: MigrationReport } {
  const report: MigrationReport = { changes: [], leftUnchanged: [] };

  const { value, errors } = parseJsonc(text);
  if (errors.length > 0 || !isObj(value)) {
    report.leftUnchanged.push({
      path: "",
      reason: "document did not parse as a JSON object — cannot migrate",
    });
    return { text, report };
  }

  const migrated = migrateTopLevel(value, report);
  if (report.changes.length === 0) {
    return { text, report };
  }
  return { text: serialize(text, migrated), report };
}

/**
 * Unified diff of two document texts, for the diff-review dialog. Filenames are
 * intentionally empty (the dialog supplies its own labels).
 */
export function computeUnifiedDiff(before: string, after: string): string {
  return createTwoFilesPatch("", "", before, after);
}

function serialize(original: string, value: JsonValue): string {
  let out = JSON.stringify(value, null, 2) + "\n";
  if (original.includes("\r\n")) {
    out = out.replace(/\n/g, "\r\n");
  }
  if (original.charCodeAt(0) === 0xfeff) {
    out = "\uFEFF" + out;
  }
  return out;
}

function migrateTopLevel(doc: Obj, report: MigrationReport): JsonValue {
  const out: Obj = {};
  for (const [key, val] of Object.entries(doc)) {
    const target = hasOwn(TOP_LEVEL_RENAMES, key) ? TOP_LEVEL_RENAMES[key] : undefined;
    if (target !== undefined) {
      if (hasOwn(doc, target)) {
        report.leftUnchanged.push({
          path: key,
          reason: `both "${key}" and "${target}" exist — not merged, left unchanged`,
        });
        out[key] = val;
      } else {
        report.changes.push(`${key} → ${target} (key renamed)`);
        out[target] = key === "provider" && isObj(val) ? migrateProviders(val, report) : val;
      }
    } else if (key === "mcp") {
      out.mcp = migrateMcp(val, report);
    } else if (key === "agent") {
      // Spec rule 6: field shapes differ in v2; never auto-migrated.
      report.leftUnchanged.push({
        path: "agent",
        reason: "shape differs in v2 — edit in raw tab",
      });
      out.agent = val;
    } else {
      out[key] = val;
    }
  }
  return out;
}

function migrateProviders(providers: Obj, report: MigrationReport): JsonValue {
  const out: Obj = {};
  for (const [id, prov] of Object.entries(providers)) {
    if (isObj(prov)) {
      out[id] = migrateProvider(prov, id, report);
    } else {
      out[id] = prov;
      report.leftUnchanged.push({
        path: `provider.${id}`,
        reason: "provider entry is not an object — kept verbatim",
      });
    }
  }
  return out;
}

function migrateProvider(prov: Obj, id: string, report: MigrationReport): JsonValue {
  const out: Obj = {};
  for (const [key, val] of Object.entries(prov)) {
    switch (key) {
      case "npm": {
        if (typeof val !== "string" || hasOwn(prov, "package")) {
          out[key] = val;
          report.leftUnchanged.push({
            path: `provider.${id}.npm`,
            reason: `"npm" is not a string or a "package" key already exists — left unchanged`,
          });
          break;
        }
        const mapped = hasOwn(PACKAGE_MAP, val) ? PACKAGE_MAP[val] : undefined;
        if (mapped === undefined) {
          out.package = val;
          report.changes.push(
            `provider.${id}.npm → package (${val} — unrecognized package name, value kept verbatim)`,
          );
          report.leftUnchanged.push({
            path: `provider.${id}.npm`,
            reason: `unrecognized package "${val}" — value kept verbatim under "package"`,
          });
        } else {
          out.package = mapped;
          report.changes.push(`provider.${id}.npm → package (${val} → ${mapped})`);
        }
        break;
      }
      case "options": {
        if (hasOwn(prov, "settings")) {
          out[key] = val;
          report.leftUnchanged.push({
            path: `provider.${id}.options`,
            reason: 'both "options" and "settings" exist — not merged, left unchanged',
          });
          break;
        }
        out.settings = val;
        report.changes.push(`provider.${id}.options → settings (contents moved)`);
        break;
      }
      case "models": {
        if (isObj(val)) {
          out.models = migrateModels(val, id, report);
        } else {
          out.models = val;
          report.leftUnchanged.push({
            path: `provider.${id}.models`,
            reason: "models block is not an object — left unchanged",
          });
        }
        break;
      }
      default:
        out[key] = val;
    }
  }
  return out;
}

function migrateModels(models: Obj, providerId: string, report: MigrationReport): JsonValue {
  const out: Obj = {};
  for (const [mid, model] of Object.entries(models)) {
    if (!isObj(model)) {
      out[mid] = model;
      continue;
    }
    const migrated: Obj = {};
    for (const [key, val] of Object.entries(model)) {
      // Spec rule 1: variants map {id: opts} → array [{id, settings: opts}].
      // Anything that is not a plain object (e.g. an already-migrated array)
      // passes through untouched.
      if (key === "variants" && isObj(val)) {
        migrated.variants = Object.entries(val).map(([vid, settings]) => ({ id: vid, settings }));
        report.changes.push(
          `provider.${providerId}.models.${mid}.variants → array of { id, settings } (${Object.keys(val).length} variants)`,
        );
      } else {
        migrated[key] = val;
      }
    }
    out[mid] = migrated;
  }
  return out;
}

function migrateMcp(val: JsonValue, report: MigrationReport): JsonValue {
  if (!isObj(val)) {
    report.leftUnchanged.push({ path: "mcp", reason: "mcp block is not an object — left unchanged" });
    return val;
  }

  const flat = Object.entries(val).filter(([k]) => k !== "servers" && k !== "timeout");
  const hasServers = hasOwn(val, "servers");
  const existingServers = hasServers && isObj(val.servers) ? val.servers : undefined;
  const numericTimeout = typeof val.timeout === "number";
  if (flat.length === 0 && !numericTimeout) {
    return val; // already v2 shape
  }

  // Error path from spec rule 4: refuse any mcp upgrade (flat move OR numeric
  // timeout reshape) rather than clobber a `mcp.servers` value we can't merge.
  if (hasServers && existingServers === undefined) {
    report.leftUnchanged.push({
      path: "mcp",
      reason: "mcp.servers exists but is not an object — mcp left unchanged",
    });
    return val;
  }
  if (flat.length > 0) {
    const collisions = flat.filter(([k]) => existingServers !== undefined && hasOwn(existingServers, k));
    if (collisions.length > 0) {
      report.leftUnchanged.push({
        path: "mcp",
        reason:
          `flat mcp entries (${collisions.map(([k]) => k).join(", ")}) collide with existing ` +
          "mcp.servers entries — mcp left unchanged, merge refused",
      });
      return val;
    }
  }

  // Merged servers: existing `servers` entries first, then the moved flat
  // entries (collision-free by the check above).
  const servers: Obj = existingServers ? { ...existingServers } : {};
  for (const [name, entry] of flat) {
    report.changes.push(`mcp.${name} → mcp.servers.${name}`);
    if (isObj(entry)) {
      servers[name] = migrateMcpEntry(entry, `mcp.servers.${name}`, report);
    } else {
      servers[name] = entry;
      report.leftUnchanged.push({
        path: `mcp.${name}`,
        reason: "mcp entry is not an object — moved under mcp.servers verbatim",
      });
    }
  }

  const out: Obj = {};
  const flatNames = new Set(flat.map(([k]) => k));
  const placeServers = () => {
    if (!hasOwn(out, "servers") && (hasServers || flat.length > 0)) {
      out.servers = servers;
    }
  };
  for (const key of Object.keys(val)) {
    if (key === "servers" || flatNames.has(key)) {
      placeServers(); // migrated key keeps the original key's position
      continue;
    }
    if (key === "timeout" && numericTimeout) {
      out.timeout = { execution: val.timeout as number };
      report.changes.push(`mcp.timeout ${val.timeout} → { execution: ${val.timeout} } (deprecated numeric form)`);
      report.leftUnchanged.push({
        path: "mcp.timeout",
        reason: "numeric timeout reshaped to { execution } — verify the intended execution timeout",
      });
      continue;
    }
    out[key] = val[key];
  }
  return out;
}

function migrateMcpEntry(entry: Obj, newPath: string, report: MigrationReport): JsonValue {
  const out: Obj = {};
  for (const [key, val] of Object.entries(entry)) {
    if (key === "enabled" && typeof val === "boolean") {
      // Spec rule 4: v2 flips the polarity — `disabled` is the v2 key.
      if (val === false) {
        out.disabled = true;
        report.changes.push(`${newPath}.enabled: false → disabled: true`);
      } else {
        report.changes.push(`${newPath}.enabled: true → dropped (v2 servers are enabled by default)`);
      }
    } else {
      if (key === "enabled") {
        report.leftUnchanged.push({
          path: `${newPath}.enabled`,
          reason: `"enabled" is not a boolean — left unchanged`,
        });
      }
      out[key] = val;
    }
  }
  return out;
}
