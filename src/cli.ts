#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createConfigApiHandlers } from "./server/config-api.js";
import { createExtraApiHandlers } from "./server/extra-api.js";
import { createServer } from "./server/server.js";

/**
 * Entry point: parse flags, boot the loopback-only server and (unless asked
 * not to) open the default browser. All behaviour lives in the server layer;
 * this file is argument parsing and process glue.
 */

interface CliOptions {
  port: number;
  folder: string;
  open: boolean;
  /** Resolved static dir, or undefined when nothing exists to serve. */
  staticDir: string | undefined;
}

const USAGE =
  "usage: opencode-config-gui [--port <n>] [--folder <path>] [--static <dir>] [--no-open]\n" +
  "  --port <n>      port to bind on 127.0.0.1 (default: 0 = any free port)\n" +
  "  --folder <path> project folder to seed config discovery (default: cwd)\n" +
  "  --static <dir>  built UI assets dir (default: <package>/dist/ui when it exists)\n" +
  "  --no-open       do not launch a browser\n";

/** Returns parsed options, or prints a message to `stream` (null = fine). */
function parseArgs(argv: string[]): { options?: CliOptions; error?: string; help?: boolean } {
  let port = 0;
  let folder: string | undefined;
  let open = true;
  let staticFlag: string | undefined;

  const next = (i: number): string | undefined => argv[i + 1];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        return { help: true };
      case "--no-open":
        open = false;
        break;
      case "--port": {
        const value = next(i);
        if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) {
          return { error: "--port expects a number between 0 and 65535\n" + USAGE };
        }
        port = Number(value);
        i += 1;
        break;
      }
      case "--folder": {
        const value = next(i);
        if (value === undefined) return { error: "--folder expects a path\n" + USAGE };
        folder = value;
        i += 1;
        break;
      }
      case "--static": {
        const value = next(i);
        if (value === undefined) return { error: "--static expects a path\n" + USAGE };
        staticFlag = value;
        i += 1;
        break;
      }
      default:
        return { error: `unknown argument: ${arg}\n${USAGE}` };
    }
  }

  // Candidate package roots, first match wins:
  //  - `--static` (verbatim);
  //  - for `node dist/cli.js` / the npm bin: dist/cli.js sits in <package>/dist,
  //    so the package root is one up from import.meta.url;
  //  - for a Bun-compiled single-file binary (see .github/workflows/release.yml):
  //    import.meta.url points INSIDE the executable's embedded virtual FS, so
  //    the release archive instead ships `dist/ui` next to the binary itself.
  //    Under plain Node this candidate is just <node dir>/dist/ui, which does
  //    not exist, so it is inert there.
  const staticCandidates =
    staticFlag !== undefined
      ? [resolve(staticFlag)]
      : [join(fileURLToPath(new URL("..", import.meta.url)), "dist", "ui"), join(dirname(process.execPath), "dist", "ui")];
  const staticDir = staticCandidates.find((candidate) => existsSync(candidate));
  // undefined when nothing exists to serve: static serving stays off
  return { options: { port, folder: resolve(folder ?? process.cwd()), open, staticDir } };
}

/** Best-effort default-browser launch; a missing opener binary is not fatal. */
function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]] // the empty title keeps cmd from eating the URL
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.error(`could not open the browser (${command} failed); visit ${url} manually`);
    });
    child.unref();
  } catch {
    console.error(`could not open the browser; visit ${url} manually`);
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.error !== undefined || parsed.options === undefined) {
    process.stderr.write(parsed.error ?? USAGE);
    process.exitCode = 1;
    return;
  }
  const { port, folder, open, staticDir } = parsed.options;

  const deps = { cwd: folder };
  const routes = { ...createConfigApiHandlers(deps), ...createExtraApiHandlers(deps) };
  const server = createServer(routes, staticDir !== undefined ? { staticDir } : {});

  server.on("error", (err) => {
    console.error(`opencode-config-gui could not listen on 127.0.0.1:${port}:`, err);
    process.exitCode = 1;
  });

  // Explicit host binding: the tool is loopback-only by contract. Port 0
  // lets the OS pick, which is why the URL is printed from the bound address.
  server.listen(port, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    console.log(`opencode-config-gui running at ${url}`);
    if (staticDir === undefined) {
      console.log("(no built UI found; the API is served but there is no page to open)");
    }
    if (open) openBrowser(url);
  });
}

main();
