#!/usr/bin/env node
/**
 * Bounded live acceptance smoke for the DeepSeek Minimal worker harness.
 *
 * It goes through the PRODUCTION entrypoint only: the central
 * `buildWorkerLaunch` with an explicit seat, the reviewed operator config, and
 * the pinned runtime. The model must (1) run one harmless shell command,
 * (2) read a tiny synthetic local image with `read_image`, and (3) deliver a
 * bounded final report through the EXISTING runner transport. No
 * hand-constructed conversation requests, no repository or user content, no
 * benchmarks.
 *
 * The outgoing request facts (provider, model, reasoning effort, max tokens)
 * are read from the harness's own durable session log (`request/header`), so
 * the gate verifies them without intercepting TLS and without touching a
 * credential. The same log's `delivery-accepted` events count the provider
 * requests that were actually accepted.
 *
 * Usage:
 *   node prototype/deepseek-minimal/scripts/live-smoke.mjs \
 *     [--image <tiny.png>] [--seat runner] [--budget 6] [--max-tokens 2048] \
 *     [--wall-ms 180000] [--receipt <dir>] [--workdir <dir>]
 *
 * Credentials come from the existing worker mechanism only (environment or the
 * operator's 0600 key file). They are never printed, receipted, or placed in
 * argv.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkerLaunch,
  deepSeekMinimalRuntimeRoot,
  defaultWorkerConfigFile,
  loadWorkerConfig,
  resolveWorkerApiKey,
} from "../../../workflow/worker-config.mjs";
import { decodePng, encodePng } from "../mock/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROTOTYPE_ROOT = dirname(HERE);
export const REPO_ROOT = dirname(dirname(PROTOTYPE_ROOT));

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at === -1 ? fallback : argv[at + 1];
};
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seat = valueOf("--seat", "runner");
const budget = Number(valueOf("--budget", "6"));
const maxTokens = Number(valueOf("--max-tokens", "2048"));
const wallMs = Number(valueOf("--wall-ms", "180000"));
const runRoot = mkdtempSync(join(tmpdir(), "qq-live-smoke-"));

// Synthetic, tiny, unambiguous fixture: a solid red 3x2 PNG. Never repository
// or user material.
let imagePath = valueOf("--image");
if (!imagePath) {
  imagePath = join(runRoot, "smoke-red-3x2.png");
  writeFileSync(imagePath, encodePng(3, 2, () => [220, 20, 20]));
}
if (!existsSync(imagePath)) {
  console.error("--image <existing tiny png> does not exist");
  process.exit(2);
}
const image = readFileSync(imagePath);
const png = decodePng(image);

// Operator config: preserve the existing provider/model/auth pins and max,
// select the harness, and raise the output-token setting explicitly.
const sourceConfigFile = process.env.QQ_WORKER_CONFIG_FILE || defaultWorkerConfigFile(process.env);
const base = loadWorkerConfig({ env: process.env });
const runtimeRoot = deepSeekMinimalRuntimeRoot(process.env);
const configFile = join(runRoot, "worker-config.json");
writeFileSync(configFile, `${JSON.stringify({
  provider: base.provider,
  model: base.model,
  base_url: base.baseUrl,
  wire_api: base.wireApi,
  env_key: base.envKey,
  ...(base.apiKeyFile ? { api_key_file: base.apiKeyFile } : {}),
  ...(base.reasoningEffort ? { reasoning_effort: base.reasoningEffort } : {}),
  harness: "deepseek-minimal",
  max_output_tokens: maxTokens,
}, null, 2)}\n`);

const env = { ...process.env, QQ_WORKER_CONFIG_FILE: configFile, QQ_DEEPSEEK_RUNTIME_ROOT: runtimeRoot };
const config = loadWorkerConfig({ env });
const credential = resolveWorkerApiKey(config, { env });
if (!credential.key) {
  console.error("live smoke requires a provider credential through the existing resolver (environment or 0600 key file)");
  process.exit(2);
}

const workdir = valueOf("--workdir") || mkdtempSync(join(tmpdir(), "qq-live-smoke-work-"));
const runnerId = `live-smoke-${Date.now()}`;
const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
const prompt = [
  "This is a bounded harness smoke test. Do exactly this and nothing else:",
  "1. Run exactly one harmless shell command: printf 'SMOKE_SHELL_OK'",
  `2. Call the read_image tool on the absolute path ${imagePath}`,
  "3. Deliver a final answer of at most 400 characters containing the literal text SMOKE_SHELL_OK, the literal text SMOKE_FINAL, and the image's width in pixels, height in pixels, and dominant colour name.",
  "Do not read, create, or modify any other files. Do not run any other commands. Do not ask questions.",
].join("\n");

const launch = buildWorkerLaunch({
  seat,
  cwd: workdir,
  prompt,
  env,
  mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
});
if (process.env.QQ_LIVE_SMOKE_BIN) launch.bin = process.env.QQ_LIVE_SMOKE_BIN;

const started = Date.now();
const child = spawn(launch.bin, launch.args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: launch.env });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, wallMs);
const exit = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
clearTimeout(timer);
const wallClockMs = Date.now() - started;

const lines = stdout.trim() === "" ? [] : stdout.trim().split("\n").map((line) => JSON.parse(line));
const finalText = lines
  .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
  .map((event) => event.item.text)
  .join("\n");

// --- harness session log: the durable, credential-free wire evidence --------
const sessionsRoot = join(runtimeRoot, "dsh-home", "sessions");
async function locateSessionLog() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(sessionsRoot)) {
      const candidates = [];
      const stack = [sessionsRoot];
      while (stack.length > 0) {
        const dir = stack.pop();
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) stack.push(path);
          else if (/^session.*\.jsonl$/u.test(entry.name)) candidates.push(path);
        }
      }
      const newest = candidates
        .map((path) => {
          try { return { path, mtime: statSync(path).mtimeMs }; } catch { return { path, mtime: 0 }; }
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const candidate of newest) {
        try {
          const first = readFileSync(candidate.path, "utf8").split("\n")[0];
          if (JSON.parse(first)?.cwd === workdir) return candidate.path;
        } catch { /* keep scanning */ }
      }
    }
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}
const sessionLog = await locateSessionLog();

const requests = { accepted: 0, headers: [], assistantMessages: 0, toolNames: [], terminal: null };
if (sessionLog) {
  for (const line of readFileSync(sessionLog, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "session-log-deepseek/delivery-accepted") requests.accepted += 1;
    else if (event.type === "assistant/message") requests.assistantMessages += 1;
    else if (event.type === "tool/call") requests.toolNames.push(event.data?.name);
    else if (event.type === "request/header") requests.headers.push(event.data?.header?.config ?? null);
    else if (event.type === "turn/end") requests.terminal = event.data?.reason?.kind ?? null;
  }
  requests.toolNames = [...new Set(requests.toolNames)];
}

// --- runner transport (the existing authoritative completion path) ----------
let transport = null;
if (existsSync(resultFile)) {
  try { transport = JSON.parse(readFileSync(resultFile, "utf8")); } catch (error) { transport = { parseError: error.message }; }
}

// --- best-effort cleanup of any upload this smoke owned ---------------------
// The harness keeps its own credential-free upload index; only records whose
// attachment is this smoke's synthetic image are deleted.
function ownedProviderFileIds() {
  const ids = new Set();
  const indexFile = join(runtimeRoot, "dsh-home", "llm-deepseek", "files-v3.json");
  if (existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(readFileSync(indexFile, "utf8"));
      const wanted = `sha256:${sha256(image)}`;
      for (const record of parsed?.records ?? []) {
        if (record?.attachmentId === wanted || record?.variantId === wanted) {
          if (typeof record.fileId === "string" && record.fileId) ids.add(record.fileId);
        }
      }
    } catch { /* an unreadable index simply yields no owned ids */ }
  }
  if (sessionLog) {
    for (const line of readFileSync(sessionLog, "utf8").split("\n")) {
      for (const match of line.matchAll(/"file_?id"\s*:\s*"([A-Za-z0-9_-]+)"/gu)) {
        if (match[1].includes("-")) ids.add(match[1]);
      }
    }
  }
  return [...ids];
}
const uploadCleanup = [];
{
  const ids = ownedProviderFileIds();
  const root = config.messagesBaseUrl.endsWith("/v1") ? config.messagesBaseUrl : `${config.messagesBaseUrl}/v1`;
  for (const id of ids) {
    try {
      const response = await fetch(`${root}/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          "x-api-key": credential.key,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "files-api-2025-04-14",
        },
      });
      uploadCleanup.push({ id, status: response.status, ok: response.ok });
    } catch (error) {
      uploadCleanup.push({ id, ok: false, error: error.message.slice(0, 200) });
    }
  }
}

const described = /\bred\b/iu.test(finalText) && /\b3\b/u.test(finalText) && /\b2\b/u.test(finalText);
const wire = requests.headers[0] ?? null;
const checks = {
  exitZero: exit.code === 0,
  terminalCompleted: requests.terminal === "completed",
  shellOperation: requests.toolNames.includes("bash"),
  readImage: requests.toolNames.includes("read_image"),
  finalMentionsShell: finalText.includes("SMOKE_SHELL_OK"),
  finalMentionsImage: finalText.includes("SMOKE_FINAL") && described,
  requestHeaderObserved: wire !== null,
  wireModelPinned: wire?.model === base.model,
  wireEffortPinned: wire?.reasoningEffort === base.reasoningEffort,
  wireMaxTokensPinned: wire?.maxTokens === maxTokens,
  completionTransportValid: transport?.response === finalText
    && Array.isArray(transport?.data_points) && transport.runnerId === runnerId,
  withinBudget: requests.accepted <= budget,
  withinWallClock: wallClockMs <= wallMs,
};
const ok = Object.values(checks).every(Boolean);

const receipt = {
  recordedAt: new Date().toISOString(),
  gate: "live-harness-smoke",
  ok,
  seat,
  harness: config.harness,
  entrypoint: "workflow/worker-config.mjs buildWorkerLaunch (production)",
  endpointHost: new URL(config.messagesBaseUrl).host,
  endpointPath: new URL(config.messagesBaseUrl).pathname,
  appliedMaxTokens: maxTokens,
  sourceConfigFile,
  runtimeRoot,
  runtimeHead: readRuntimeHead(),
  sessionLog,
  wireRequestHeader: wire,
  inference: {
    requestsAccepted: requests.accepted,
    assistantMessages: requests.assistantMessages,
    budget,
    note: "requestsAccepted counts the harness's durable session-log delivery-accepted events for this smoke session (one per accepted provider request). The session-title step is a local fallback and issues no provider request in this pinned bundle.",
  },
  observations: { toolNames: requests.toolNames, terminal: requests.terminal },
  image: { path: imagePath, sha256: sha256(image), bytes: image.length, png: png ?? null },
  finalAnswer: finalText.slice(0, 1_000),
  runnerTransport: transport,
  exit,
  wallClockMs,
  checks,
  uploadCleanup,
  stderrTail: stderr.trim().split("\n").slice(-6),
  credentialSource: (credential.source ?? "").replace(/:.*/u, ":<redacted>"),
};

function readRuntimeHead() {
  try {
    return JSON.parse(readFileSync(join(runtimeRoot, "provenance.json"), "utf8")).head;
  } catch { return null; }
}

const receiptDir = valueOf("--receipt", join(REPO_ROOT, ".architect", "artifacts", `live-smoke-${receipt.recordedAt.replace(/[:.]/gu, "-")}`));
mkdirSync(receiptDir, { recursive: true });
const receiptPath = join(receiptDir, "LIVE-SMOKE-RECEIPT.json");
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ receiptPath, ok, checks, inference: receipt.inference, wallClockMs, toolNames: requests.toolNames, finalAnswer: receipt.finalAnswer }, null, 2));
process.exit(ok ? 0 : 1);
