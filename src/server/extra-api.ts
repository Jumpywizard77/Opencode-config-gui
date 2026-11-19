import { readFileSync } from "node:fs";

import { computeUnifiedDiff, upgradeDocumentText } from "../core/migrate.js";
import { probeModels, type ProbeResult } from "../core/probe.js";
import { loadSchema } from "../core/schema.js";
import type { Issue } from "../core/types.js";
import { saveValidated, vetConfigPath, type ConfigApiDeps } from "./config-api.js";
import { json, readBody, sha256, type ApiHandler, type ApiRoutes, type RequestContext } from "./http.js";

/**
 * Task 9's extra endpoints: endpoint probe, v1→v2 upgrade preview/apply and
 * a manual schema refresh. Every route reuses Task 8's vetting verbatim:
 * `requireLocalRequest` gates Host/Origin at the router, `vetConfigPath`
 * decides path safety, and `saveValidated` owns the backup/atomic-write/
 * issue-policy pipeline — so an upgrade-apply can never drift from a normal
 * config save in what it refuses or how it writes.
 */

export interface ExtraApiDeps extends ConfigApiDeps {
  /**
   * Networking port for `POST /api/probe`; defaults to core's `probeModels`
   * (which itself defaults to the global fetch). Tests inject a stub so no
   * outbound request ever leaves the process.
   */
  probeImpl?: (input: { baseURL: string; apiKey?: string }) => Promise<ProbeResult>;
}

/** Parse a JSON-object request body, answering 400 on the caller's response. */
async function readJsonBody(ctx: RequestContext): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(ctx.req));
  } catch {
    json(ctx.res, 400, { error: "bad_request" });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    json(ctx.res, 400, { error: "bad_request" });
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function createExtraApiHandlers(deps: ExtraApiDeps = {}): ApiRoutes {
  // Same folder semantics as config-api: `?folder=` query first, then a
  // `folder` string in the body; an empty string means absent.
  const folderParam = (url: URL): string | undefined => {
    const value = url.searchParams.get("folder");
    return value !== null && value !== "" ? value : undefined;
  };
  const folderOf = (url: URL, body: Record<string, unknown>): string | undefined =>
    folderParam(url) ??
    (typeof body["folder"] === "string" && body["folder"] !== "" ? (body["folder"] as string) : undefined);

  /**
   * Vet a body `path` against this request's folder, answering the refusal
   * on `res` and returning undefined when the path may not be touched.
   */
  const vetBodyPath = (
    ctx: RequestContext,
    body: Record<string, unknown>,
  ): string | undefined => {
    const target = body["path"];
    if (typeof target !== "string" || target === "") {
      json(ctx.res, 400, { error: "bad_request" });
      return undefined;
    }
    const vet = vetConfigPath(deps, target, folderOf(ctx.url, body));
    if (!vet.ok) {
      json(ctx.res, vet.status, { error: vet.error });
      return undefined;
    }
    return vet.entry.path; // the discovered (canonical) path, never the client string
  };

  const probe: NonNullable<ExtraApiDeps["probeImpl"]> = deps.probeImpl ?? probeModels;

  const upgradePreview: ApiHandler = async ({ res, req, url }) => {
    const body = await readJsonBody({ req, res, url });
    if (body === undefined) return;
    const path = vetBodyPath({ req, res, url }, body);
    if (path === undefined) return;

    let diskText: string;
    try {
      diskText = readFileSync(path, "utf8");
    } catch {
      json(res, 500, { error: "read_failed" }); // discovered moments ago yet unreadable
      return;
    }
    const { text: migrated, report } = upgradeDocumentText(diskText);
    json(res, 200, {
      diff: computeUnifiedDiff(diskText, migrated),
      report,
      sha256: sha256(diskText), // the base token apply() must echo for staleness
    });
  };

  return {
    "POST /api/probe": async ({ req, res, url }) => {
      const body = await readJsonBody({ req, res, url });
      if (body === undefined) return;
      const baseURL = body["baseURL"];
      const apiKey = body["apiKey"];
      if (
        typeof baseURL !== "string" ||
        baseURL === "" ||
        (apiKey !== undefined && typeof apiKey !== "string")
      ) {
        json(res, 400, { error: "bad_request" });
        return;
      }
      // probeModels never throws; a custom probeImpl that does is handled by
      // server.ts's top-level catch (500 internal_error). The apiKey is only
      // forwarded to the probe — it is never logged or echoed back.
      const result = await probe({ baseURL, ...(apiKey !== undefined ? { apiKey } : {}) });
      json(res, 200, result);
    },

    "POST /api/upgrade/preview": upgradePreview,

    "POST /api/upgrade/apply": async ({ req, res, url }) => {
      const body = await readJsonBody({ req, res, url });
      if (body === undefined) return;
      const baseSha256 = body["baseSha256"];
      if (typeof baseSha256 !== "string") {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const baseIssues = Array.isArray(body["baseIssues"]) ? (body["baseIssues"] as Issue[]) : [];
      const path = vetBodyPath({ req, res, url }, body);
      if (path === undefined) return;

      let diskText: string;
      try {
        diskText = readFileSync(path, "utf8");
      } catch {
        json(res, 500, { error: "read_failed" });
        return;
      }
      // Migrate the DISK text, never anything the client sent: the client
      // only vouched for staleness via baseSha256. An already-migrated
      // document upgrades to byte-identical text, and saveValidated's stale
      // check (disk sha vs baseSha256) is what refuses writes on a race.
      const { text: migrated } = upgradeDocumentText(diskText);

      const source = await loadSchema(deps.loadSchemaOptions ?? {});
      const result = await saveValidated({ schema: source }, path, migrated, baseSha256, baseIssues);
      if (!result.ok) {
        if (result.kind === "stale") {
          json(res, 409, { error: "stale", diskSha256: result.diskSha256 });
        } else {
          json(res, 400, { error: "new_issues", newIssues: result.newIssues });
        }
        return;
      }
      json(res, 200, { sha256: result.sha256, backupPath: result.backupPath });
    },

    "POST /api/schema/refresh": async ({ res }) => {
      // loadSchema never throws; a failed refresh walks down to cache/bundled
      // and the reported provenance stays honest either way.
      const source = await loadSchema({ ...(deps.loadSchemaOptions ?? {}), refresh: true });
      json(res, 200, { schemaSource: source.source, schemaFetchedAt: source.fetchedAt });
    },
  };
}
