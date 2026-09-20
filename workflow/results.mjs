// Authoritative worker result transport (extracted from the MCP server so both
// the MCP adapter and the native pi Architect share one implementation).
//
// A worker's terminal result is only trustworthy when it was delivered through
// the explicit complete_task transport file (or, for test doubles, a registry
// entry explicitly keyed by that job). There is no fallback that promotes
// stream output to a result.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const COMPLETE_TASK_RESPONSE_MAX = 32_768;
export const COMPLETE_TASK_DATA_POINTS_MAX = 20;
export const COMPLETE_TASK_DATA_POINT_LEN_MAX = 100;

export function cleanupRunnerFiles(runner) {
  if (!runner) return;
  if (runner.resultFile) {
    try {
      rmSync(runner.resultFile, { force: true });
    } catch {}
  }
  if (runner.id) {
    try {
      rmSync(join(tmpdir(), `qq-complete-task-${runner.id}.json`), { force: true });
    } catch {}
  }
}

export function validateRunnerResultPayload(payload, runner) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Runner result payload is not an object" };
  }

  // Check runner binding
  if (payload.runnerId !== undefined && payload.runnerId !== null) {
    if (runner?.id && payload.runnerId !== runner.id) {
      return {
        ok: false,
        error: `Runner result ID mismatch: expected '${runner.id}', got '${payload.runnerId}'`,
      };
    }
  }

  // Validate response
  if (payload.response === undefined || payload.response === null) {
    return { ok: false, error: "Runner result is missing 'response' field" };
  }
  if (typeof payload.response !== "string") {
    return { ok: false, error: "Runner result 'response' must be a string" };
  }
  if (payload.response.length > COMPLETE_TASK_RESPONSE_MAX) {
    return {
      ok: false,
      // `code` is additive metadata: the message stays byte-identical so pinned
      // callers keep matching on it, while the ingestion path can recognise the
      // "only the transport cap was exceeded" case and spill the full report to
      // durable storage instead of losing it.
      code: "response-over-cap",
      limit: COMPLETE_TASK_RESPONSE_MAX,
      actual: payload.response.length,
      error: `Runner result response exceeds ${COMPLETE_TASK_RESPONSE_MAX}-character cap (got ${payload.response.length} chars)`,
    };
  }

  // Validate data_points
  let dataPoints = [];
  if (payload.data_points !== undefined && payload.data_points !== null) {
    if (!Array.isArray(payload.data_points)) {
      return { ok: false, error: "Runner result 'data_points' must be an array of strings" };
    }
    if (payload.data_points.length > COMPLETE_TASK_DATA_POINTS_MAX) {
      return {
        ok: false,
        error: `Runner result 'data_points' exceeds ${COMPLETE_TASK_DATA_POINTS_MAX}-item cap (got ${payload.data_points.length} items)`,
      };
    }
    for (let i = 0; i < payload.data_points.length; i++) {
      if (typeof payload.data_points[i] !== "string") {
        return { ok: false, error: `Runner result data_points[${i}] must be a string` };
      }
      if (payload.data_points[i].length > COMPLETE_TASK_DATA_POINT_LEN_MAX) {
        return {
          ok: false,
          error: `Runner result data_points[${i}] exceeds ${COMPLETE_TASK_DATA_POINT_LEN_MAX}-character cap (got ${payload.data_points[i].length} chars)`,
        };
      }
    }
    dataPoints = payload.data_points;
  }

  return {
    ok: true,
    result: {
      response: payload.response,
      data_points: dataPoints,
    },
  };
}

// Registry-backed implementation. `registry` is a Map keyed by job id (or by
// session id for legacy calls, or by the literal key "default" for test
// doubles). Callers that have no registry pass `null` and get file-only reads.
export function readAuthoritativeRunnerResult(runner, { registry = null } = {}) {
  if (!runner) return { ok: false, error: "No runner provided" };
  const lookup = (key) => (registry && key && registry.has(key) ? registry.get(key) : null);
  const inMemory = lookup(runner.id) || lookup(runner.sessionId);

  if (runner.resultFile) {
    if (!existsSync(runner.resultFile)) {
      if (inMemory) return validateRunnerResultPayload(inMemory, runner);
      return {
        ok: false,
        error: `Missing runner result transport file at '${runner.resultFile}'`,
      };
    }

    let raw;
    try {
      raw = readFileSync(runner.resultFile, "utf8");
    } catch (err) {
      return { ok: false, error: `Failed to read runner result transport file: ${err.message}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `Runner result transport file is malformed JSON: ${err.message}` };
    }

    return validateRunnerResultPayload(parsed, runner);
  }

  // Fallback for test doubles without resultFile (e.g. T7a)
  const fallback = inMemory || lookup("default");
  if (fallback) return validateRunnerResultPayload(fallback, runner);

  return {
    ok: false,
    error: `No authoritative complete_task result available for runner '${runner.id}' (no transport file or registry entry)`,
  };
}

// Render the complete findings text for a validated result: data points first
// (bounded, structural), then the response. Used to persist the full report
// before any bounded notification is sent.
export function renderRunnerFindings(result, { dataPointsLimit = COMPLETE_TASK_DATA_POINTS_MAX } = {}) {
  if (result == null) return "";
  let findings;
  let dataPoints = [];
  if (typeof result === "string") {
    findings = result;
  } else if (typeof result === "object") {
    findings = result.response ?? JSON.stringify(result);
    if (Array.isArray(result.data_points)) dataPoints = result.data_points.slice(0, dataPointsLimit);
  } else {
    findings = String(result);
  }
  const dp = dataPoints.length ? `\n\ndata_points:\n${dataPoints.map((d) => `- ${d}`).join("\n")}` : "";
  return `${findings}${dp}`;
}

// Overflow-safe ingestion for a terminal worker result.
//
// The pinned worker contract keeps its 32,768-character complete_task cap, so a
// worker can be cut off by a transport cap (the observed DeepSeek
// `final_answer_over_cap` failure). The architect side must never lose the only
// copy of the report in that case: an over-cap response is spilled verbatim to
// the durable report store, and the authoritative result keeps a bounded head
// plus the report reference. In-cap results pass through untouched.
export function acceptRunnerResult(
  runner,
  { registry = null, stateDir = null, saveReport, boundedText = null, now = Date.now() } = {},
) {
  const direct = readAuthoritativeRunnerResult(runner, { registry });
  if (direct.ok) return { ...direct, spilled: false };
  if (direct.code !== "response-over-cap") return direct;
  if (!stateDir || typeof saveReport !== "function") {
    return { ok: false, error: direct.error, code: direct.code, spilled: false, spillUnavailable: true };
  }

  // Re-read the raw payload: validation reports the failure, only the ingestion
  // path needs the oversized text itself.
  let payload;
  try {
    payload = JSON.parse(readFileSync(runner.resultFile, "utf8"));
  } catch (err) {
    return { ok: false, error: `Runner result transport file could not be re-read for spill: ${err.message}` };
  }
  const full = String(payload.response ?? "");
  let dataPoints = [];
  if (Array.isArray(payload.data_points)) dataPoints = payload.data_points.filter((entry) => typeof entry === "string");
  // The durable artifact is the complete worker result, rendered exactly like an
  // in-cap result, so retrieval looks the same whichever path produced it.
  const saved = saveReport(stateDir, {
    jobId: runner.id ?? "unknown",
    role: "runner",
    text: renderRunnerFindings({ response: full, data_points: dataPoints }),
    now,
  });
  const bounded = typeof boundedText === "function"
    ? boundedText(full, { reportId: saved.reportId })
    : { text: `${full.slice(0, 8_000)}\n… [${full.length - 8_000} chars omitted] …\n${full.slice(-8_000)}`, truncated: true };
  return {
    ok: true,
    spilled: true,
    report: { reportId: saved.reportId, chars: saved.chars, path: saved.path },
    result: {
      response: bounded.text,
      data_points: dataPoints,
    },
  };
}
