// Final owned model-visible output boundary. Measure the *entire* serialized
// frame (including Pi details), never a JS string's code-unit length.
import { saveReport } from './reports.mjs';

export const TOOL_OUTPUT_MAX = 16_384;
export const serializedBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function prefix(value, bytes = 360) {
  let out = '';
  for (const char of String(value ?? '')) {
    if (Buffer.byteLength(JSON.stringify(out + char)) > bytes) break;
    out += char;
  }
  return out;
}

export function outputFrame(value, { stateDir = null, name = 'tool', pi = false, isError = false, identity = {} } = {}) {
  const frame = (body, error = isError) => pi
    ? { content: [{ type: 'text', text: JSON.stringify(body) }], details: body, isError: Boolean(error) }
    : { content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }], ...(error ? { isError: true } : {}) };
  let normal;
  try {
    normal = frame(value);
    if (serializedBytes(normal) <= TOOL_OUTPUT_MAX) return normal;
  } catch (error) {
    // The action already returned. Serialization failure is not evidence that
    // it failed or that it is safe to retry it.
    const receipt = { ok: value?.ok ?? !isError, code: 'presentation-error', outputIncomplete: true,
      detailComplete: false, detailUnavailable: true, outcomeKnown: value !== undefined,
      jobId: prefix(value?.jobId), executionId: prefix(value?.executionId), status: prefix(value?.status),
      reason: prefix(error?.message ?? error), retrieval: 'inspect durable job/action by ID; do not repeat the action' };
    return frame(receipt);
  }
  let reference = {};
  if (stateDir) {
    try {
      const saved = saveReport(stateDir, { role: 'tool-output', jobId: name, text: JSON.stringify(value) });
      reference = { reportId: saved.reportId, detailComplete: true, retrieval: 'read_report with reportId, offset and nextOffset; JSON text is the exact original result' };
    } catch (error) {
      reference = { detailUnavailable: true, detailComplete: false, persistenceError: prefix(error?.message ?? error), retrieval: 'inspect the durable job/action record by ID; do not repeat a side effect to page this result' };
    }
  } else {
    reference = { detailUnavailable: true, detailComplete: false, retrieval: 'inspect the durable record by ID if available; do not repeat a side effect to page this result' };
  }
  const body = { ok: value?.ok === false ? false : !isError, code: 'output-over-budget', outputIncomplete: true,
    outcomeKnown: value?.outcomeKnown ?? (value !== undefined), tool: name, ...identity,
    ...(value?.jobId ? { jobId: prefix(value.jobId) } : {}),
    ...(value?.executionId ? { executionId: prefix(value.executionId) } : {}),
    ...(value?.status ? { status: prefix(value.status) } : {}),
    ...(value?.code ? { originalCode: prefix(value.code) } : {}),
    ...(value?.error || value?.reason ? { reason: prefix(value.error ?? value.reason) } : {}),
    serializedBytes: serializedBytes(normal), ...reference };
  // An execution's authority view may be large even on ordinary completion.
  // Keep the current role outcome references in the check itself, not solely
  // inside a generic tool-output report. Prefer the latest attempt for each
  // role, and keep the exact larger view available via the reference above.
  if (name === 'check_execution' && value?.authority && typeof value.authority === 'object') {
    const authority = value.authority;
    // body.reportId points at the exact serialized tool result. The execution's
    // own outcome report is a distinct durable artifact; never replace that
    // detail reference with the execution report while claiming exact retrieval.
    const compact = { ...body, executionReportId: value.reportId ?? null, authority: {
      execution: authority.execution?.outcome ? { outcome: {
        status: authority.execution.outcome.status, reportId: authority.execution.outcome.reportId,
      }, outcomeKnown: authority.execution.outcomeKnown } : null,
      roles: [], reports: [], reportCount: authority.reportCount ?? authority.reports?.length ?? 0,
    } };
    const fits = () => serializedBytes(frame(compact)) <= TOOL_OUTPUT_MAX;
    // Use a separate compact view rather than copying progress, evidence or
    // historical attempts, whose text can dwarf the current report references.
    if (fits()) {
      const roles = Array.isArray(authority.roles) ? authority.roles : [];
      for (const role of roles) {
        const attempt = Array.isArray(role.attempts) ? role.attempts.at(-1) : null;
        const entry = { role: role.role, jobId: role.jobId,
          attempts: attempt ? [{ attemptId: attempt.attemptId, outcome: attempt.outcome
            ? { status: attempt.outcome.status, revision: attempt.outcome.revision, reportId: attempt.outcome.reportId }
            : null, outcomeKnown: attempt.outcomeKnown }] : [] };
        compact.authority.roles.push(entry);
        if (!fits()) compact.authority.roles.pop();
      }
      const reports = Array.isArray(authority.reports) ? authority.reports : [];
      // Current outcome reports first if the view contains many evidence refs.
      for (const report of [...reports.filter(item => item.label === 'outcome-report'),
        ...reports.filter(item => item.label !== 'outcome-report')]) {
        const entry = { role: report.role, jobId: report.jobId, attemptId: report.attemptId,
          label: report.label, reportId: report.reportId };
        compact.authority.reports.push(entry);
        if (!fits()) compact.authority.reports.pop();
      }
      compact.authority.rolesComplete = compact.authority.roles.length === roles.length;
      compact.authority.reportsComplete = compact.authority.reports.length === reports.length
        && compact.authority.reports.length === compact.authority.reportCount;
      if (fits()) return frame(compact);
    }
  }
  // A malicious caller can also supply giant names/identity: never bypass the guard.
  if (serializedBytes(frame(body)) > TOOL_OUTPUT_MAX) {
    return frame({ ok: false, code: 'output-over-budget', outputIncomplete: true, detailUnavailable: true,
      reason: 'Result too large; detail reference could not fit. Inspect durable state by ID.' });
  }
  return frame(body);
}

// Cut a UTF-16 page at a JSON-safe byte budget, without splitting surrogate
// pairs. The caller's offset is still measured in JS code units.
export function bytePage(text, start, size, metadata, maxBytes = 6_500) {
  let end = Math.max(start, Math.min(text.length, start + size));
  const fits = n => serializedBytes({ ...metadata, text: text.slice(start, n), nextOffset: n, complete: n >= text.length }) <= maxBytes;
  if (!fits(end)) {
    let low = start, high = end;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    end = low;
  }
  if (end < text.length && end > start && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) {
    // A one-code-unit request can end inside an astral character. Include its
    // second code unit when the byte budget permits, rather than returning an
    // empty page with nextOffset === offset forever.
    if (fits(end + 1)) end++;
    else end--;
  }
  return { ...metadata, text: text.slice(start, end), nextOffset: end, complete: end >= text.length };
}
