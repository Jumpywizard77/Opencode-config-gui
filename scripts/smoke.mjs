// Runtime smoke test against the BUILT cli: boots `dist/cli.js --no-open` on a
// free port, checks that /api/state answers JSON and / serves the built UI,
// then shuts the server down. Used by the Node-20 CI job (the runtime floor:
// the dev toolchain needs newer Node, shipped code must run here) and handy
// locally after `npm run build`. Exits non-zero on any failed expectation.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(`smoke failed: ${message}`);
  }
}

const child = spawn(process.execPath, [cliPath, "--no-open", "--port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});

const watchdog = setTimeout(() => {
  child.kill();
  console.error("smoke failed: server did not report a bound port within 30s");
  process.exit(1);
}, 30_000);

const url = await new Promise((resolveUrl, rejectUrl) => {
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    const match = out.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) resolveUrl(match[1]);
  });
  child.on("error", rejectUrl);
  child.on("exit", (code) => rejectUrl(new Error(`server exited early (code ${code}): ${out}`)));
});

try {
  const state = await fetch(`${url}/api/state`);
  assert(state.status === 200, `/api/state returned ${state.status}`);
  const body = await state.json(); // throws unless the body is JSON
  assert(Array.isArray(body.configs), "/api/state JSON has no `configs` array");

  const page = await fetch(`${url}/`);
  assert(page.status === 200, `/ returned ${page.status}`);
  const html = await page.text();
  assert(/<html/i.test(html), "/ did not serve an HTML document");

  // Loopback-only contract: the server must not answer a foreign Host header
  // (DNS-rebinding guard). node:http is used, not fetch: undici may rewrite a
  // caller-set Host, which would make this check vacuous.
  const forgedStatus = await new Promise((resolveStatus, rejectStatus) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: new URL(url).port,
        path: "/api/state",
        // Without setHost:false Node overwrites the Host header itself.
        setHost: false,
        headers: { Host: "example.com" },
      },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      },
    );
    request.on("error", rejectStatus);
    request.end();
  });
  assert(forgedStatus === 403, `forged Host header got ${forgedStatus}, expected 403`);

  console.log(`smoke ok: ${url} served /api/state JSON and index.html`);
} finally {
  clearTimeout(watchdog);
  child.kill();
}
