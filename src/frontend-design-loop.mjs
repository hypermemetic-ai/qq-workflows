import { spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_SESSION = "frontend-design-loop";
export const PRIMARY_SESSION_ID = "session-63a11000-0000-4000-8000-000000000021";
export const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 800 }),
  phone: Object.freeze({ width: 412, height: 915 }),
  short: Object.freeze({ width: 412, height: 520 }),
});
export const DEFAULT_MEASURE_SELECTORS = Object.freeze([
  "#console-stream",
  "#session-panel",
  ".session-heading",
  "#transcript",
  "#composer",
  "#interrupt-form",
  "#composer-submit",
  "#interrupt-submit",
  ".session-menu",
]);

const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseLiveFlag(argv = [], env = process.env) {
  return Boolean(argv.includes("--live") || env.QQ_DESIGN_LOOP_LIVE === "1");
}

export function sanitizeLabel(value, fallback = "current") {
  const label = String(value ?? "").trim() || fallback;
  if (!LABEL.test(label)) throw new Error("design-loop label must be 1-64 characters of A-Za-z0-9._-");
  return label;
}

export function stateRoot(env = process.env) {
  const stateHome = env.XDG_STATE_HOME
    ? resolve(env.XDG_STATE_HOME)
    : join(resolve(env.HOME || homedir()), ".local", "state");
  return join(stateHome, "qq", "frontend-design-loop");
}

export function statePath(env = process.env) {
  return join(stateRoot(env), "state.json");
}

export function shotsDir(label, env = process.env) {
  return join(stateRoot(env), "shots", sanitizeLabel(label));
}

export function readState(env = process.env) {
  const path = statePath(env);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || !Number.isInteger(value.pid) || typeof value.origin !== "string") {
      throw new Error("malformed");
    }
    return value;
  } catch {
    throw new Error("design-loop state is malformed");
  }
}

function writeState(value, env) {
  const root = stateRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(statePath(env), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function defaultExec(command, args, options = {}) {
  return new Promise((resolveExec) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      resolveExec({ code: 1, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      resolveExec({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function defaultSpawn(command, args, options = {}) {
  return spawnProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached ?? false,
    stdio: options.stdio ?? ["ignore", "ignore", "ignore"],
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function startFixture(options = {}) {
  const env = options.env ?? process.env;
  const existing = (() => {
    try { return readState(env); } catch { return undefined; }
  })();
  if (existing) {
    try {
      process.kill(existing.pid, 0);
      throw new Error(`design-loop fixture already running at ${existing.origin} (pid ${existing.pid})`);
    } catch (error) {
      if (error?.message?.includes("already running")) throw error;
    }
  }

  const inputRoot = resolve(options.root ?? PACKAGE_ROOT);
  const root = existsSync(join(inputRoot, "tests", "qq-ui-browser-fixture.mjs"))
    ? inputRoot
    : (existsSync(join(dirname(inputRoot), "tests", "qq-ui-browser-fixture.mjs")) ? dirname(inputRoot) : PACKAGE_ROOT);
  const live = options.live !== false;
  const endpointFile = options.endpointFile ?? join(stateRoot(env), "endpoint");
  mkdirSync(dirname(endpointFile), { recursive: true, mode: 0o700 });
  try { unlinkSync(endpointFile); } catch {}

  const spawn = options.spawn ?? defaultSpawn;
  const child = spawn(process.execPath, ["tests/qq-ui-browser-fixture.mjs", endpointFile, ...(live ? ["--live"] : [])], {
    cwd: root,
    env: { ...process.env, ...env, ...(live ? { QQ_DESIGN_LOOP_LIVE: "1" } : {}) },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref?.();

  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  while (!existsSync(endpointFile) || !String(readFileSync(endpointFile, "utf8")).trim()) {
    if (Date.now() > deadline) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
      throw new Error("design-loop fixture did not publish an origin");
    }
    await sleep(50);
  }

  const origin = String(readFileSync(endpointFile, "utf8")).trim().replace(/\/$/, "");
  const sessionId = options.sessionId ?? PRIMARY_SESSION_ID;
  const sessionUrl = `${origin}/qq/session/${sessionId}`;
  const record = {
    pid: child.pid,
    origin,
    sessionId,
    sessionUrl,
    endpointFile,
    live,
  };
  writeState(record, env);
  return record;
}

export async function stopLoop(options = {}) {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  let state;
  try { state = readState(env); } catch { state = undefined; }
  const closed = { fixture: "absent", browser: "skipped" };
  if (state?.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
      closed.fixture = "signaled";
    } catch {
      closed.fixture = "gone";
    }
  }
  const browser = await exec("agent-browser", ["--session", BROWSER_SESSION, "close"], { env: { ...process.env, ...env } });
  closed.browser = browser.code === 0 ? "closed" : "absent";
  try { unlinkSync(statePath(env)); } catch {}
  if (state?.endpointFile) {
    try { unlinkSync(state.endpointFile); } catch {}
  }
  return { ...closed, origin: state?.origin ?? "" };
}

async function browser(exec, env, args) {
  const result = await exec("agent-browser", ["--session", BROWSER_SESSION, ...args], {
    env: { ...process.env, ...env },
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `agent-browser ${args[0]} failed`);
  }
  return result.stdout;
}

export async function seedPrompt(options = {}) {
  const env = options.env ?? process.env;
  const state = options.state ?? readState(env);
  if (!state) throw new Error("design-loop fixture is not running");
  const prompt = String(options.prompt ?? "design-loop seed");
  if (!prompt.trim()) throw new Error("design-loop seed requires a prompt");
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${state.origin}/qq/session/${encodeURIComponent(state.sessionId)}/prompt`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: state.origin,
      "sec-fetch-site": "same-origin",
    },
    body: new URLSearchParams({ prompt }).toString(),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`design-loop seed failed (${response.status}): ${body.trim() || "empty response"}`);
  }
  return { origin: state.origin, sessionId: state.sessionId, status: response.status };
}

export async function measureBoxes(options = {}) {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const selectors = options.selectors ?? DEFAULT_MEASURE_SELECTORS;
  const boxes = {};
  const styles = {};
  for (const selector of selectors) {
    boxes[selector] = (await browser(exec, env, ["get", "box", selector])).trim();
    if (options.styles !== false) {
      styles[selector] = (await browser(exec, env, ["get", "styles", selector])).trim();
    }
  }
  return { boxes, styles: options.styles === false ? undefined : styles };
}

export async function captureShots(options = {}) {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  let state;
  try { state = options.state ?? readState(env); } catch { state = undefined; }
  const url = typeof options.url === "string" && options.url.trim()
    ? options.url.trim()
    : state?.sessionUrl;
  if (!url) throw new Error("capture needs a url or a running design-loop fixture");
  const label = sanitizeLabel(options.label ?? "current");
  const dir = shotsDir(label, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = options.short ? ["desktop", "phone", "short"] : ["desktop", "phone"];
  await browser(exec, env, ["open", url]);
  if (options.reload !== false) await browser(exec, env, ["reload"]);
  const shots = {};
  for (const name of names) {
    const viewport = VIEWPORTS[name];
    const path = join(dir, `${name}.png`);
    await browser(exec, env, ["set", "viewport", String(viewport.width), String(viewport.height)]);
    await browser(exec, env, ["screenshot", path]);
    shots[name] = path;
  }
  const measured = options.measure === false
    ? undefined
    : await measureBoxes({ env, exec, selectors: options.selectors, styles: options.styles });
  return { label, dir, shots, sessionUrl: url, ...measured };
}
