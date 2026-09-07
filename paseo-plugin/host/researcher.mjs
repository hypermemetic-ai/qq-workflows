import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { PLUGIN_ROOT } from "./config.mjs";
import { classifyFailure, parseResearcherResult } from "./recovery.mjs";
import { loadGrokToken, withResearchSecrets } from "./providers/secrets.mjs";

const RESEARCHER_ERROR_CLIP = 4000;

export function execFileWithInput(command, args, options = {}) {
  const { input, onSpawn, signal, ...rest } = options;
  return new Promise((resolve, reject) => {
    let spawnFailure;
    const child = execFileCb(command, args ?? [], rest, (error, stdout, stderr) => {
      if (spawnFailure) { reject(spawnFailure); return; }
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    try { onSpawn?.(child); } catch (error) {
      spawnFailure = error;
      child.stdin?.destroy();
      terminateProcess(child.pid).then(() => reject(error), () => reject(error));
      return;
    }
    if (signal) {
      const abort = () => {
        try { child.kill("SIGTERM"); } catch {}
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    child.stdin?.end(input ?? "");
  });
}

export function terminateProcess(pid, { termMs = 2000, killMs = 1000, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), killFn = (pid, sig) => process.kill(pid, sig) } = {}) {
  const failures = [];
  if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve(failures);
  const alive = () => {
    try { killFn(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
  };
  try { killFn(pid, "SIGTERM"); } catch (error) {
    if (error?.code === "ESRCH") return Promise.resolve(failures);
    failures.push(`SIGTERM process ${pid} failed: ${error.message}`);
  }
  return (async () => {
    const termDeadline = Date.now() + termMs;
    while (Date.now() < termDeadline && alive()) await sleepFn(50);
    if (!alive()) return failures;
    try { killFn(pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") failures.push(`SIGKILL process ${pid} failed: ${error.message}`);
      return failures;
    }
    const killDeadline = Date.now() + killMs;
    while (Date.now() < killDeadline && alive()) await sleepFn(50);
    if (alive()) failures.push(`process ${pid} still alive after SIGKILL; residual processes may remain`);
    return failures;
  })();
}

export function terminateProcessGroup(pgid, { termMs = 2000, killMs = 1000, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), killFn = (pid, sig) => process.kill(pid, sig) } = {}) {
  const failures = [];
  if (!Number.isInteger(pgid) || pgid <= 1) return Promise.resolve(failures);
  const alive = () => {
    try { killFn(-pgid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
  };
  try { killFn(-pgid, "SIGTERM"); } catch (error) {
    if (error?.code === "ESRCH") return Promise.resolve(failures);
    failures.push(`SIGTERM process group ${pgid} failed: ${error.message}`);
  }
  return (async () => {
    const termDeadline = Date.now() + termMs;
    while (Date.now() < termDeadline && alive()) await sleepFn(50);
    if (!alive()) return failures;
    try { killFn(-pgid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") failures.push(`SIGKILL process group ${pgid} failed: ${error.message}`);
      return failures;
    }
    const killDeadline = Date.now() + killMs;
    while (Date.now() < killDeadline && alive()) await sleepFn(50);
    if (alive()) failures.push(`process group ${pgid} still alive after SIGKILL; residual processes may remain`);
    return failures;
  })();
}

export function formatResearcherFailure(error) {
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  const body = stderr || stdout;
  if (body) return clipResearcherError(body);
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const stripped = stripCommandFailed(raw);
  if (stripped) return clipResearcherError(stripped);
  if (error?.code === "E2BIG" || error?.code === "ENAMETOOLONG") {
    return "researcher question was too large to spawn";
  }
  if (typeof error?.code === "number") {
    return `researcher exited ${error.code} without output`;
  }
  if (error?.code) return `researcher failed: ${error.code}`;
  return "researcher exited without output";
}

function stripCommandFailed(message) {
  const text = String(message ?? "").trim();
  if (!text.startsWith("Command failed:")) return text;
  const nl = text.indexOf("\n");
  if (nl < 0) return "";
  return text.slice(nl + 1).trim();
}

function clipResearcherError(text) {
  const t = String(text ?? "").trim();
  if (t.length <= RESEARCHER_ERROR_CLIP) return t;
  return t.slice(-RESEARCHER_ERROR_CLIP);
}

export function pythonRuntimeRoot(pluginRoot = PLUGIN_ROOT) {
  return join(pluginRoot, "..", "runtimes", "python");
}

export function resolveResearcher(root = pythonRuntimeRoot()) {
  const venvResearcher = join(root, ".venv", "bin", "researcher");
  const venvPython = join(root, ".venv", "bin", "python");
  const env = withResearchSecrets(process.env);
  if (existsSync(venvResearcher)) {
    return { command: venvResearcher, args: [], cwd: root, env };
  }
  if (existsSync(venvPython)) {
    return { command: venvPython, args: ["-m", "researcher"], cwd: root, env };
  }
  return {
    command: process.env.PYTHON ?? "python3",
    args: ["-m", "researcher"],
    cwd: root,
    env: { ...env, PYTHONPATH: join(root, "src") },
  };
}

export function researcherUserMessage(question, cwd) {
  const q = String(question ?? "").trim();
  const workspace = String(cwd ?? "").trim();
  if (!workspace) return q;
  return `${q}\n\nWorkspace root: ${workspace}`;
}

export async function runResearcher(question, { root, cwd, hostUrl, jobId, restart: grantRestart, execFileFn = execFileWithInput, signal, onSpawn } = {}) {
  const q = String(question ?? "").trim();
  if (!q) throw new Error("researcher question is empty");
  const resolved = resolveResearcher(root);
  const prompt = researcherUserMessage(q, cwd);
  const token = resolved.env.XAI_API_KEY || await loadGrokToken(resolved.env);
  const env = { ...resolved.env, ...(token ? { XAI_API_KEY: token } : {}), ...(hostUrl ? { ARCHITECT_HOST: hostUrl, ARCHITECT_JOB_ID: jobId } : {}) };
  const runOnce = execFileFn;
  let lastError;
  for (let start = 1; start <= 2; start++) {
    try {
      const { stdout, stderr } = await runOnce(resolved.command, resolved.args, {
        cwd: resolved.cwd,
        encoding: "utf8",
        env,
        maxBuffer: 20 * 1024 * 1024,
        input: prompt,
        signal,
        onSpawn,
      });
      const text = String(stdout ?? "").trim();
      if (!text) {
        const empty = new Error("researcher produced no output");
        empty.failureClass = "invalid_output";
        throw empty;
      }
      return extractResearcherAnswer(text);
    } catch (error) {
      try { if (error.stdout) extractResearcherAnswer(error.stdout); } catch (structured) { if (structured.failureClass) { lastError = structured; break; } }
      lastError = annotateResearcherError(error);
      const cls = lastError.failureClass;
      const restart = start === 1 && cls === "process" && isRecoverableSpawn(lastError);
      if (!restart) break;
      await grantRestart?.();
    }
  }
  const message = formatResearcherFailure(lastError);
  console.error(`researcher failed: ${message}`);
  const wrapped = new Error(message, { cause: lastError });
  wrapped.failureClass = lastError?.failureClass;
  wrapped.attempts = lastError?.attempts;
  wrapped.exhausted = lastError?.exhausted;
  wrapped.circuitOpen = lastError?.circuitOpen;
  wrapped.stderr = lastError?.stderr;
  wrapped.traceback = lastError?.traceback;
  throw wrapped;
}

function isRecoverableSpawn(error) {
  const code = error?.code;
  return code === "EAGAIN";
}

function annotateResearcherError(error) {
  const result = parseResearcherResult(error?.stderr ?? failureStderr(error));
  if (result) {
    error.failureClass = result.class ?? classifyFailure(error);
    error.attempts = Array.isArray(result.attempts) ? result.attempts : error.attempts;
    error.exhausted = result.exhausted === true || error.failureClass === "transient";
    if (result.action) error.action = result.action;
    if (result.occurrences) error.occurrences = result.occurrences;
    return error;
  }
  error.failureClass = error.failureClass ?? classifyFailure(error);
  if (!Array.isArray(error.attempts) || error.attempts.length === 0) {
    error.attempts = undefined;
  }
  return error;
}

function failureStderr(error) {
  if (error?.stderr) return error.stderr;
  if (error instanceof Error && error.message.startsWith("Command failed:")) {
    const nl = error.message.indexOf("\n");
    return nl >= 0 ? error.message.slice(nl + 1) : "";
  }
  return "";
}

export function extractResearcherAnswer(text) {
  let envelope;
  try { envelope = JSON.parse(String(text)); }
  catch { throw Object.assign(new Error("researcher completion is not JSON"), { failureClass: "invalid_output" }); }
  if (envelope.version !== 1 || envelope.kind !== "research_completion" || typeof envelope.ok !== "boolean") throw Object.assign(new Error("invalid researcher completion envelope"), { failureClass: "invalid_output" });
  if (!envelope.ok) {
    const details = envelope.error ?? {};
    throw Object.assign(new Error(details.message || "research failed"), { failureClass: details.failureClass, attempts: details.attempts, exhausted: details.exhausted, traceback: typeof details.traceback === "string" ? details.traceback.slice(-16000) : undefined });
  }
  if (typeof envelope.answer !== "string" || !envelope.answer.trim()) throw Object.assign(new Error("invalid researcher done answer"), { failureClass: "invalid_output" });
  return envelope.answer;
}
