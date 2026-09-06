import { createHash } from "node:crypto";

export const PROVIDER_ATTEMPTS = 3;
export const MALFORMED_REGENS = 1;
export const PROCESS_RESTARTS = 1;
export const AGGREGATE_RECOVERY = 6;
export const LOOP_HISTORY = 20;
export const LOOP_WARN_AT = 3;
export const LOOP_STOP_AT = 6;
export const CIRCUIT_FAILURES = 5;
export const CIRCUIT_MIN_REQUESTS = 2;
export const CIRCUIT_COOLDOWN_MS = 60_000;
export const BACKOFF_CAPS_MS = Object.freeze([5_000, 10_000]);

export function failureText(error) {
  if (error == null) return "";
  const stderr = String(error.stderr ?? "").trim();
  if (stderr) return stderr;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyFailure(error) {
  if (error?.name === 'AbortError' || ['SIGTERM', 'SIGINT'].includes(error?.signal)) return 'cancelled';
  const seen = new Set();
  for (let item = error; item && !seen.has(item); item = item.cause) {
    seen.add(item);
    if (item.failureClass) return item.failureClass;
    const status = item.status ?? item.statusCode ?? item.response?.status;
    if ([400, 401, 403, 404, 422].includes(status)) return "permanent";
    if ([408, 429, 500, 502, 503, 504].includes(status)) return "transient";
  }
  const s = [...seen].map(failureText).join(" | ").toLowerCase();
  if (/degeneration|repeated-action loop|loop persisted/.test(s)) return "degeneration";
  if (
    /set brave_api_key|exa_api_key|missing search credentials|401\b|403\b|\b400\b|invalid api key|authentication|insufficient_quota|quota exceeded|unsupported model|invalid_request|invalid-argument|invalid_argument|badrequesterror|bad request|maximum prompt|context length|context window|too many tokens|token limit/.test(s)
    && !/timeout|502|503|429/.test(s)
  ) {
    return "permanent";
  }
  if (
    /\b429\b|rate.?limit|\b50[0234]\b|econnreset|etimedout|enotfound|readtimeout|timeout after|internal error during token|service unavailable|temporarily unavailable|circuit open/.test(s)
  ) {
    return "transient";
  }
  if (/produced no output|produced no json|output is not json|empty model response|question is empty/.test(s)) {
    return "invalid_output";
  }
  return "process";
}

export function summarizeFailure(error) {
  const text = failureText(error).replace(/\s+/g, " ").trim();
  const timeout = text.match(/timeout after ([\d.]+)\s*seconds/i);
  if (timeout) return `ReadTimeout at the provider's ${timeout[1]}-second timeout`;
  const xai = text.match(/"error"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (xai) return xai[1].replace(/\\"/g, '"');
  if (/internal error during token|\b500\b/.test(text) && !/\b400\b/.test(text)) return "HTTP 500";
  if (/readtimeout/i.test(text)) return "ReadTimeout";
  const http = text.match(/\bHTTP\s*([45]\d\d)\b/i);
  if (http) return `HTTP ${http[1]}`;
  if (text.length <= 240) return text;
  return text.slice(-240);
}

export function createLedger() {
  return {
    providerAttempts: 0,
    regenerations: 0,
    processRestarts: 0,
    recoveryActions: 0,
  };
}

export function canRecover(ledger) {
  return (ledger?.recoveryActions ?? 0) < AGGREGATE_RECOVERY;
}

export function backoffMs(failedAttempt, random = Math.random) {
  const cap = BACKOFF_CAPS_MS[Math.min(Math.max(failedAttempt, 1), BACKOFF_CAPS_MS.length) - 1];
  return Math.floor((random() ?? 0) * cap);
}

export function createCircuit({
  now = Date.now,
  openAfter = CIRCUIT_FAILURES,
  minRequests = CIRCUIT_MIN_REQUESTS,
  cooldownMs = CIRCUIT_COOLDOWN_MS,
  store,
} = {}) {
  const scopes = new Map(store?.list("circuit") ?? []);
  const save = (scope, item) => store?.put("circuit", String(scope ?? "default"), item);
  function bucket(scope) {
    const key = String(scope ?? "default");
    if (!scopes.has(key)) {
      scopes.set(key, {
        consecutive: 0,
        requests: 0,
        state: "closed",
        openedAt: 0,
        probe: false,
      });
    }
    return scopes.get(key);
  }
  function maybeHalfOpen(item) {
    if (item.state === "open" && now() - item.openedAt >= cooldownMs) {
      item.state = "half-open";
      item.probe = true;
    }
  }
  return {
    isOpen(scope) {
      const item = bucket(scope);
      maybeHalfOpen(item);
      if (item.state === "closed") return false;
      if (item.state === "half-open" && item.probe) {
        item.probe = false;
        save(scope, item);
        return false;
      }
      return item.state !== "closed";
    },
    recordSuccess(scope) {
      const item = bucket(scope);
      item.consecutive = 0;
      item.requests = 0;
      item.state = "closed";
      item.probe = false;
      save(scope, item);
    },
    recordFailure(scope, cls, { newRequest = false } = {}) {
      if (cls !== "transient") return;
      const item = bucket(scope);
      if (newRequest) item.requests += 1;
      item.consecutive += 1;
      if (item.state === "half-open") {
        item.state = "open";
        item.openedAt = now();
        item.probe = false;
        save(scope, item);
        return;
      }
      if (item.consecutive >= openAfter && item.requests >= minRequests) {
        item.state = "open";
        item.openedAt = now();
      }
      save(scope, item);
    },
    snapshot(scope) {
      const item = bucket(scope);
      maybeHalfOpen(item);
      return { ...item };
    },
  };
}

export async function retryProviderOperation(fn, {
  ledger = createLedger(),
  circuit,
  scope = "default",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  const attempts = [];
  if (circuit?.isOpen(scope)) {
    const error = new Error("provider circuit open");
    error.failureClass = "transient";
    error.circuitOpen = true;
    error.attempts = attempts;
    throw error;
  }
  let requestCounted = false;
  for (let n = 1; n <= PROVIDER_ATTEMPTS; n++) {
    try {
      const result = await fn();
      circuit?.recordSuccess(scope);
      ledger.providerAttempts = n;
      return result;
    } catch (error) {
      if (error.supervised) throw error;
      const cls = error.failureClass ?? classifyFailure(error);
      attempts.push(summarizeFailure(error));
      if (!requestCounted) {
        circuit?.recordFailure(scope, cls, { newRequest: true });
        requestCounted = true;
      } else {
        circuit?.recordFailure(scope, cls, { newRequest: false });
      }
      error.failureClass = cls;
      error.attempts = attempts;
      if (cls === "permanent" || cls === "degeneration") throw error;
      if (cls === "process") throw error;
      if (cls === "invalid_output") {
        if (ledger.regenerations >= MALFORMED_REGENS) {
          error.exhausted = true;
          throw error;
        }
        ledger.regenerations += 1;
      }
      const more = n < PROVIDER_ATTEMPTS && canRecover(ledger);
      if (!more) {
        error.exhausted = cls === "transient" || cls === "invalid_output";
        throw error;
      }
      ledger.recoveryActions += 1;
      ledger.providerAttempts = n;
      const after = error.retryAfter ?? error.response?.headers?.get?.("retry-after");
      const retryAfterMs = after == null ? 0 : Number.isFinite(Number(after)) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now());
      await sleep(Math.max(backoffMs(n, random), retryAfterMs || 0));
      if (circuit?.isOpen(scope)) { error.circuitOpen = true; throw error; }
    }
  }
  const error = new Error(attempts.join(" → ") || "provider recovery exhausted");
  error.failureClass = "transient";
  error.attempts = attempts;
  error.exhausted = true;
  throw error;
}

export function operationKey(cwd, kind, identity) {
  return createHash("sha256").update(`${cwd}\n${kind}\n${identity}`).digest("hex");
}

export function parseResearcherResult(stderr) {
  const text = String(stderr ?? "");
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("RESEARCHER_RESULT ")) continue;
    try {
      return JSON.parse(trimmed.slice("RESEARCHER_RESULT ".length));
    } catch {
      return null;
    }
  }
  return null;
}

export function formatSpentProviderWake({
  role = "research",
  attempts = [],
  details = "",
  headSha = "",
  worktree = "",
} = {}) {
  const n = Math.max(attempts.length, 1);
  const unit = n === 1 ? "attempt" : "attempts";
  const chain = attempts.length ? attempts.join(" → ") : "provider failure";
  if (role === "review") {
    const where = [
      headSha ? `at ${headSha}` : "",
      worktree ? `in ${worktree}` : "",
    ].filter(Boolean).join(" ");
    return [
      `Review could not complete after ${n} provider ${unit}${attempts.length ? `: ${chain}` : ""}.`,
      `The submitted change is preserved${where ? ` ${where}` : ""}; it has not been landed.`,
      "No review verdict was accepted, and the correction allowance was not consumed.",
      "Automatic recovery is exhausted.",
      details ? `Details: ${details}.` : null,
    ].filter(Boolean).join(" ");
  }
  return [
    `Research could not complete after ${n} provider ${unit}: ${chain}.`,
    "Automatic recovery is exhausted.",
    "No answer was accepted.",
    details ? `Details: ${details}.` : null,
  ].filter(Boolean).join(" ");
}

export function formatPermanentWake({ role = "research", summary, details } = {}) {
  const who = role === "review" ? "Review" : "Research";
  return [
    `${who} could not complete: ${summary}.`,
    "Automatic recovery was not attempted.",
    details ? `Details: ${details}.` : null,
  ].filter(Boolean).join(" ");
}

export function formatDegenerationWake({
  role = "implementer",
  action = "repeated tool calls",
  occurrences = LOOP_STOP_AT,
  worktree = "",
  details = "",
} = {}) {
  const who = role === "research" ? "Research" : "Implementer";
  return [
    `${who} stopped after a repeated-action loop persisted despite a warning: ${action}, unchanged results, ${occurrences} occurrences.`,
    worktree
      ? `Work is preserved in ${worktree}; it has not been landed.`
      : "Work is preserved; it has not been landed.",
    "Automatic restart was not attempted.",
    details ? `Details: ${details}.` : null,
  ].filter(Boolean).join(" ");
}

export function formatLivenessWake({ role = "research", operation = "a provider request", details = "" } = {}) {
  const who = role === "review" ? "Review" : "Research";
  return [
    `${who} liveness is uncertain while waiting on ${operation}.`,
    "The process has not been confirmed stopped, and no replacement was started.",
    "Operator inspection or cancellation is needed.",
    details ? `Details: ${details}.` : null,
  ].filter(Boolean).join(" ");
}

export function formatCircuitWake({ role = "research", details = "" } = {}) {
  const who = role === "review" ? "Review" : "Research";
  return [
    `${who} is blocked: the provider is failing.`,
    "Automatic recovery is paused for 60 seconds.",
    details ? `Details: ${details}.` : null,
  ].filter(Boolean).join(" ");
}

export function formatRecoveryWake(error, { role = "research", details = "", headSha = "", worktree = "" } = {}) {
  const cls = error?.failureClass ?? classifyFailure(error);
  if (cls === 'cancelled') return `${role === 'review' ? 'Review' : role === 'implementer' ? 'Implementer' : 'Research'} cancelled. Existing work and request evidence are preserved; no replacement was started.${details ? ` Details: ${details}.` : ''}`;
  const attempts = Array.isArray(error?.attempts) && error.attempts.length
    ? error.attempts
    : [summarizeFailure(error)];
  if (error?.circuitOpen || /circuit open/i.test(failureText(error))) {
    return formatCircuitWake({ role, details });
  }
  if (cls === "degeneration") {
    return formatDegenerationWake({
      role: role === "review" ? "implementer" : role,
      action: summarizeFailure(error),
      worktree,
      details,
    });
  }
  if (cls === "permanent" || (cls === "process" && !error?.exhausted)) {
    return formatPermanentWake({ role, summary: summarizeFailure(error), details });
  }
  return formatSpentProviderWake({ role, attempts, details, headSha, worktree });
}

export function normalizeLoopValue(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return value.map(normalizeLoopValue).join(",");
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return keys.map((key) => `${key}=${normalizeLoopValue(value[key])}`).join("&");
  }
  return String(value);
}

export function createLoopGuard({
  history = LOOP_HISTORY,
  warnAt = LOOP_WARN_AT,
  stopAt = LOOP_STOP_AT,
} = {}) {
  const events = [];
  let warned = false;
  function fingerprint({ name, args, result, state }) {
    return `${name}|${normalizeLoopValue(args)}|${normalizeLoopValue(result)}|${normalizeLoopValue(state)}`;
  }
  function countTail(fp) {
    let n = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i] === fp) n += 1;
      else break;
    }
    return n;
  }
  function countCycle(period) {
    if (events.length < period * 2) return 0;
    const cycle = events.slice(-period).join("||");
    let n = 0;
    for (let start = events.length - period; start >= 0; start -= period) {
      const slice = events.slice(start, start + period).join("||");
      if (slice !== cycle) break;
      n += 1;
    }
    return n;
  }
  return {
    observe(event) {
      const fp = fingerprint(event);
      events.push(fp);
      if (events.length > history) events.shift();
      const same = countTail(fp);
      const cycle = Math.max(countCycle(2), countCycle(3));
      const occurrences = Math.max(same, cycle);
      if (occurrences >= stopAt) return { action: "stop", occurrences, warned };
      if (occurrences >= warnAt) {
        warned = true;
        return { action: "warn", occurrences, warned };
      }
      return { action: "allow", occurrences, warned };
    },
    get warned() {
      return warned;
    },
    get events() {
      return [...events];
    },
  };
}

export const LOOP_WARNING =
  "This action pattern has repeated three times with unchanged results. Use the existing result, change the investigation, or finish. Continuing the same pattern will stop this run.";
