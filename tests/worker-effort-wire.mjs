#!/usr/bin/env node
// On-wire proof for the operator's reasoning-effort pin.
//
// Unlike the other worker tests, this one deliberately drives the *installed*
// Codex client (not a fake binary) so the request body proves what the worker
// actually sends. It talks only to a dummy-key HTTP server on localhost that
// answers every request itself: no provider traffic, no paid calls, no live
// benchmark. If no Codex client is installed the test reports a skip (exit 0)
// rather than failing, since it cannot fabricate an installed client.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKER_SEATS, buildWorkerLaunch } from "../workflow/worker-config.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-worker-effort-wire-"));
const DUMMY_KEY = "dummy-key-for-localhost-capture";

// Locate a real `codex` executable, ignoring the suite-wide QQ_CODEX_BIN shim
// (`/usr/bin/true`) that exists to keep notification transports inert.
function resolveInstalledCodex(env = process.env) {
  if (env.QQ_WORKER_EFFORT_WIRE_CODEX) {
    return existsSync(env.QQ_WORKER_EFFORT_WIRE_CODEX) ? env.QQ_WORKER_EFFORT_WIRE_CODEX : null;
  }
  for (const dir of String(env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "codex");
    try {
      if (existsSync(candidate) && statSync(candidate).isFile() && (statSync(candidate).mode & 0o111)) {
        return candidate;
      }
    } catch {
      // Unreadable PATH entry: keep searching.
    }
  }
  return null;
}

const codexBin = resolveInstalledCodex();
if (!codexBin) {
  console.log("worker effort wire test SKIPPED: no installed codex client on PATH (set QQ_WORKER_EFFORT_WIRE_CODEX to pin one).");
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

// Minimal Responses API stream, enough for `codex exec --json` to finish a turn.
const finalMessage = {
  id: "msg_wire_1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "OK", annotations: [] }],
};
const streamEvents = [
  { type: "response.created", response: { id: "resp_wire_1", object: "response", status: "in_progress", output: [] } },
  { type: "response.output_item.done", output_index: 0, item: finalMessage },
  {
    type: "response.completed",
    response: {
      id: "resp_wire_1",
      object: "response",
      status: "completed",
      output: [finalMessage],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  },
];

const received = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    received.push({ method: req.method, url: req.url, headers: req.headers, body: parsed, raw: body });
    if (!String(req.url).endsWith("/responses")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of streamEvents) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

function spawnWorker(launch, cwd) {
  return new Promise((resolve) => {
    const child = spawn(launch.bin, launch.args, {
      cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, error: err });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// One real worker launch per case, against the local capture server. The
// config file is the same operator file the deployment reads, so this exercises
// JSON -> validation -> argv -> wire.
async function runWorker(seat, extraConfig = {}) {
  const label = extraConfig.reasoning_effort ?? "absent";
  const configFile = join(root, `worker-config-${label}.json`);
  writeFileSync(configFile, JSON.stringify({
    provider: "deepseek",
    model: "deepseek-flash",
    base_url: origin,
    wire_api: "responses",
    env_key: "DEEPSEEK_API_KEY",
    api_key_file: join(root, "missing-key-file"),
    ...extraConfig,
  }));
  const workDir = mkdtempSync(join(root, `work-${seat}-${label}-`));
  const baseEnv = { ...process.env };
  delete baseEnv.QQ_CODEX_BIN;
  const env = {
    ...baseEnv,
    QQ_WORKER_CONFIG_FILE: configFile,
    QQ_WORKER_CODEX_HOME: join(root, `codex-home-${seat}-${label}`),
    QQ_WORKER_CODEX_BIN: codexBin,
    DEEPSEEK_API_KEY: DUMMY_KEY,
  };
  const launch = buildWorkerLaunch({ seat, cwd: workDir, prompt: "Reply with OK", env });
  const before = received.length;
  const result = await spawnWorker(launch, workDir);
  return { label, launch, result, seen: received.slice(before) };
}

try {
  // Guard the wire cases below against a seat rename: they must stay real seats.
  for (const seat of ["implementer", "reviewer"]) assert.ok(WORKER_SEATS.includes(seat));

  // 1. Configured max: exact level on the wire, no alias translation.
  const maxRun = await runWorker("implementer", { reasoning_effort: "max" });
  assert.equal(maxRun.result.code, 0, `codex must exit cleanly (stderr: ${maxRun.result.stderr})`);
  assert.equal(maxRun.seen.length, 1, `expected exactly one Responses request, saw ${maxRun.seen.length}`);
  const maxRequest = maxRun.seen[0];
  assert.equal(maxRequest.method, "POST");
  assert.ok(maxRequest.url.endsWith("/responses"), `unexpected request path '${maxRequest.url}'`);
  assert.equal(maxRequest.body.model, "deepseek-flash");
  assert.equal(maxRequest.body.reasoning.effort, "max", `reasoning must be max: ${JSON.stringify(maxRequest.body.reasoning)}`);
  assert.equal(maxRequest.body.reasoning.summary, "auto");
  // The reasoning object is exactly effort + summary: no alias field and no
  // other invented knob rides along.
  assert.deepEqual(Object.keys(maxRequest.body.reasoning).sort(), ["effort", "summary"]);
  assert.ok(maxRequest.raw.includes('"effort":"max"'), "wire body must carry the literal effort=max");
  // The local dummy key is what the capture server saw; the operator's real key
  // file (absent here) is never in play.
  assert.ok(
    String(maxRequest.headers.authorization || "").includes(DUMMY_KEY),
    "the local capture must authenticate with the injected dummy key",
  );
  // The launch argv that produced that request carries the exact override.
  const maxArgv = maxRun.launch.args.join(" ");
  assert.ok(maxArgv.includes('model_reasoning_effort="max"'), maxArgv);
  assert.doesNotMatch(maxArgv, /xhigh|ultra/);

  // 2. Absent field: the client default request is preserved (no effort key).
  const defaultRun = await runWorker("reviewer");
  assert.equal(defaultRun.result.code, 0, `codex must exit cleanly (stderr: ${defaultRun.result.stderr})`);
  assert.equal(defaultRun.seen.length, 1);
  assert.equal(
    defaultRun.seen[0].body.reasoning.effort,
    undefined,
    `absent reasoning_effort must not invent a level: ${JSON.stringify(defaultRun.seen[0].body.reasoning)}`,
  );
  assert.deepEqual(Object.keys(defaultRun.seen[0].body.reasoning).sort(), ["summary"]);
  assert.ok(
    !defaultRun.launch.args.some((arg) => arg.startsWith("model_reasoning_effort")),
    "absent reasoning_effort must not emit an override",
  );
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("Worker reasoning-effort wire test passed (on-wire reasoning.effort verified with the installed client).");
