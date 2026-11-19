import {
  applyEdits,
  getLocation,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

import type { Issue, JsonValue, PathEdit } from "./types";

const BOM = "\uFEFF";

const EDIT_OPTIONS = {
  formattingOptions: { insertSpaces: true, tabSize: 2 },
} as const;

function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(BOM.length) } : { bom: "", body: text };
}

function formatPath(path: (string | number)[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out;
}

/**
 * Parse JSONC text, collecting problems as `Issue`s. Trailing commas are
 * accepted (they are legal in opencode configs) and produce no issues.
 */
export function parseJsonc(text: string): { value: JsonValue | undefined; errors: Issue[] } {
  // jsonc-parser's scanner treats a BOM as an invalid symbol; hide it from
  // the parse and shift reported offsets back when reporting positions.
  const { bom, body } = splitBom(text);
  const parseErrors: ParseError[] = [];
  const value = parse(body, parseErrors, { allowTrailingComma: true }) as JsonValue | undefined;

  const errors = parseErrors.map((error) => {
    const offset = error.offset + bom.length;
    const line = text.slice(0, offset).split(/\r\n|\r|\n/).length;
    const location = getLocation(body, error.offset);
    const path = formatPath(location.path);
    const code = printParseErrorCode(error.error);
    return { path, message: `Line ${line}: ${code}` };
  });

  return { value, errors };
}

/**
 * Apply surgical path edits, leaving every byte outside the edited paths
 * untouched: comments, BOM, CRLF line endings and trailing commas survive.
 * Each edit is resolved against the running text, so earlier edits never
 * invalidate later offsets.
 */
export function applyPathEdits(text: string, edits: PathEdit[]): string {
  const { bom, body } = splitBom(text);
  let result = body;
  for (const edit of edits) {
    result = applyEdits(result, modify(result, edit.path, edit.value, EDIT_OPTIONS));
  }
  return bom + result;
}
