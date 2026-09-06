import { createHash } from 'node:crypto';
import { createTextGuard } from './text-loop.mjs';
import { backoffMs, classifyFailure, createLedger, createLoopGuard, normalizeLoopValue, LOOP_WARNING } from './recovery.mjs';

export function createSupervisor({ store, jobs, circuit, now = Date.now, random = Math.random, wake }) {
  function save(job) { store.put('job', job.id, job); }
  return async function supervise({ jobId, event, operation, value = {}, attemptId }) {
    const job = jobs.get(jobId);
    if (!job) throw new Error('unknown runner job');
    if (event === 'stopped') {
      if (store.get('receipt', jobId)) return { accepted: true };
      const unknown = store.active().some(item => item.value.jobId === jobId && item.value.kind === 'command');
      job.status = unknown ? 'uncertain' : 'failed'; job.failure = value;
      job.error = `${job.role} stopped: ${value.message ?? 'runner exited'}.${unknown ? ' A command outcome is unknown; work is preserved and will not be replayed.' : ''}`;
      save(job); wake?.(job.parent, job.error, `${jobId}:failure`); return { ok: true };
    }
    if (event === 'heartbeat') {
      job.heartbeatAt = now(); job.pid = value.pid; job.activity = value.activity;
      save(job); return { ok: true };
    }
    // Native Grok consumes the done receipt and generates its closing reply.
    // Completion never grants further repository tool execution.
    const teacherClosure = job.role === 'teacher' && store.get('receipt', jobId) && ['begin', 'success', 'failure', 'checkpoint'].includes(event) && (event !== 'begin' || value.kind === 'model');
    if (!teacherClosure && (job.status !== 'running' || store.get('receipt', jobId))) throw new Error('stale runner');
    const delegationId = job.delegationId ?? job.id;
    const ledger = store.get('ledger', delegationId) ?? job.ledger ?? createLedger();
    const persistLedger = () => { job.ledger = ledger; store.put('ledger', delegationId, ledger); save(job); };
    const key = `${jobId}:${operation}`;
    if (event === 'text') {
      const guard = createTextGuard();
      try { return guard.push(value.text ?? ''); }
      finally { store.put('text_detector', key, guard.snapshot()); }
    }
    if (event === 'checkpoint') { store.put('runner_checkpoint', key, value); return { ok: true }; }
    if (event === 'begin') {
      const failures = store.get('request_failures', key) ?? [];
      if (failures.length >= 3 || failures.some(item => !['transient', 'invalid_output'].includes(item.failureClass))) throw new Error(`Request already failed: ${failures.at(-1)?.message}; no further provider attempt is permitted`);
      const scope = value.scope ?? 'unknown-provider';
      if (value.kind === 'model' && circuit?.isOpen(scope)) throw new Error('provider circuit open');
      const id = store.begin(key, { ...value, jobId, startedAt: now() });
      store.put('runner_current', key, { operation, attemptId: id, ...value });
      store.put('runner_current', jobId, { operation, attemptId: id, ...value });
      return { attemptId: id };
    }
    if (event === 'success' || event === 'failure') {
      const current = store.get('runner_current', key) ?? store.get('runner_current', jobId);
      if (current?.attemptId !== attemptId || current?.operation !== operation) throw new Error('stale runner result');
      store.finish(attemptId, value);
      if (event === 'success') {
        if (current.kind === 'model') circuit?.recordSuccess(current.scope);
        store.put('runner_result', key, value);
        return { ok: true };
      }
      const cls = value.failureClass ?? classifyFailure(value);
      const prior = store.get('request_failures', key) ?? [];
      prior.push(value);
      store.put('request_failures', key, prior);
      if (current.kind === 'model') circuit?.recordFailure(current.scope, cls, { newRequest: prior.length === 1, requestId: key });
      const retry = current.kind === 'model' && prior.length < 3 && ledger.recoveryActions < 6 && (cls === 'transient' || (cls === 'invalid_output' && ledger.regenerations < 1));
      if (!retry) return { retry: false, failureClass: cls, attempts: prior.map(x => x.message), exhausted: cls === 'transient' || cls === 'invalid_output' };
      ledger.recoveryActions++;
      if (cls === 'invalid_output') ledger.regenerations++;
      persistLedger();
      const after = value.retryAfter;
      const retryAfterMs = after == null ? 0 : Number.isFinite(Number(after)) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - now());
      return { retry: true, delayMs: Math.max(backoffMs(prior.length, random), retryAfterMs || 0), feedback: cls === 'invalid_output' ? 'The previous output was invalid. Return a complete response with valid tool arguments.' : null };
    }
    if (event === 'loop_before') {
      const history = store.get('detector', delegationId) ?? [];
      const equal = (a,b) => normalizeLoopValue(a) === normalizeLoopValue(b);
      for (const period of [1,2,3]) {
        if (history.length < period * 5) continue;
        const tail = history.slice(-period * 5);
        if (!equal({name: value.name,args: value.args,state:value.state}, {name:tail[0].name,args:tail[0].args,state:tail[0].state})) continue;
        if (tail.every((item,i) => equal(item,tail[i % period]))) return { action: 'stop', occurrences: 6 };
      }
      return { action: 'allow' };
    }
    if (event === 'loop') {
      const prior = store.get('detector', delegationId) ?? [];
      const guard = createLoopGuard();
      for (const item of prior) guard.observe(item);
      const decision = guard.observe(value);
      store.put('detector', delegationId, [...prior, value].slice(-20));
      if (decision.action === 'warn') return { ...decision, warning: LOOP_WARNING };
      return decision;
    }
    if (event === 'restart') {
      if (ledger.processRestarts >= 1 || ledger.recoveryActions >= 6) throw new Error('process restart allowance exhausted');
      ledger.processRestarts++; ledger.recoveryActions++; persistLedger(); return { ok: true };
    }
    if (event === 'repair') {
      if (ledger.regenerations >= 1 || ledger.recoveryActions >= 6) throw new Error('output repair exhausted');
      ledger.regenerations++; ledger.recoveryActions++; persistLedger(); return { ok: true };
    }
    throw new Error(`unknown runner event: ${event}`);
  };
}
export function providerScope(endpoint, model, credential) {
  const base = String(endpoint).replace(/\/+$/, '').replace(/\/v1$/, '');
  const name = String(model).replace(/^xai\//, '').replace(/-build$/, '');
  return createHash('sha256').update(`${base}\n${name}\n${credential}`).digest('hex');
}
