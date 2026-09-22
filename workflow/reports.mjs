// Durable report store.
//
// Terminal reports (runner findings, execution results and failure
// diagnostics) are persisted in full before anything is notified. Notifications
// carry a bounded summary plus a report reference; the full text stays
// retrievable in chunks. Nothing in this module ever discards the only copy of
// a report because a transport cap was exceeded.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Observed final-answer transport cap (DeepSeek worker `final_answer_over_cap`).
export const REPORT_TRANSPORT_CAP = 16_384;
// Chunk size for bounded retrieval of a full report.
export const REPORT_CHUNK_MAX = 8_192;

export function reportsDir(stateDir) {
  return join(stateDir, "reports");
}

export function reportPath(stateDir, reportId) {
  if (typeof reportId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(reportId)) {
    throw new Error("invalid report reference: expected a retained report ID, not a path");
  }
  return join(reportsDir(stateDir), `${reportId}.txt`);
}

function reportIdFor({ jobId, role, text }) {
  const digest = createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
  const safeJob = String(jobId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return `${role || "job"}-${safeJob}-${digest}`;
}

// Persist the complete report. Idempotent: identical text for the same job
// yields the same report ID and rewrites the same file.
export function saveReport(stateDir, { jobId, role = "job", text, now = Date.now() } = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (typeof text !== "string") throw new Error("report text must be a string");
  const reportId = reportIdFor({ jobId, role, text });
  const path = reportPath(stateDir, reportId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
  return {
    reportId,
    path,
    bytes: Buffer.byteLength(text, "utf8"),
    chars: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
    savedAt: now,
  };
}

export function readReportMeta(stateDir, reportId) {
  try {
    const stat = statSync(reportPath(stateDir, reportId));
    return { reportId, path: reportPath(stateDir, reportId), bytes: stat.size, exists: true };
  } catch {
    return { reportId, path: reportPath(stateDir, reportId), bytes: 0, exists: false };
  }
}

// Bounded, chunked retrieval: the caller can walk the whole report without ever
// holding it in one transport frame.
export function readReport(stateDir, reportId, { offset = 0, limit = REPORT_CHUNK_MAX } = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!reportId) throw new Error("reportId is required");
  const start = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.min(Math.max(1, Math.trunc(limit) || REPORT_CHUNK_MAX), REPORT_CHUNK_MAX);
  let text;
  try {
    text = readFileSync(reportPath(stateDir, reportId), "utf8");
  } catch {
    return { ok: false, reportId, error: `no persisted report '${reportId}'`, offset: start, limit: size };
  }
  const slice = text.slice(start, start + size);
  const nextOffset = start + slice.length;
  return {
    ok: true,
    reportId,
    offset: start,
    limit: size,
    totalChars: text.length,
    nextOffset,
    complete: nextOffset >= text.length,
    text: slice,
  };
}

export function listReports(stateDir) {
  let names;
  try {
    names = readdirSync(reportsDir(stateDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((name) => {
      const reportId = name.slice(0, -4);
      const meta = readReportMeta(stateDir, reportId);
      return { reportId, bytes: meta.bytes };
    });
}

// Bounded delivery text: keeps the head and the tail, states exactly how much
// was omitted, and points at the durable report for retrieval. Never returns
// more than `cap` characters.
export function boundedReportText(text, { cap = REPORT_TRANSPORT_CAP, reportId = null, label = "report" } = {}) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= cap) {
    return { text: value, truncated: false, omittedChars: 0, totalChars: value.length };
  }
  const reference = reportId
    ? `Full ${label} retained as report '${reportId}' (${value.length} chars); retrieve it in chunks with read_report.`
    : `Full ${label} retained (${value.length} chars); retrieve it in chunks.`;
  const markerHead = `\n\n… [`;
  const markerTail = ` chars omitted] …\n\n${reference}\n`;
  // 32 chars reserve the omitted-char count so the result can never exceed cap.
  const budget = cap - markerHead.length - markerTail.length - 32;
  if (budget <= 0) {
    return { text: reference.slice(0, cap), truncated: true, omittedChars: value.length, totalChars: value.length };
  }
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const omitted = value.length - headLen - tailLen;
  const text2 = `${value.slice(0, headLen)}${markerHead}${omitted}${markerTail}${value.slice(value.length - tailLen)}`;
  return { text: text2, truncated: true, omittedChars: omitted, totalChars: value.length };
}
