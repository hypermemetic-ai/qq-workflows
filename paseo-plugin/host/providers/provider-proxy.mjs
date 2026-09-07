import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { retryProviderOperation, createLedger, classifyFailure } from '../recovery.mjs';
import { providerScope } from '../supervisor.mjs';
import { readProviderResponse } from './text-loop.mjs';

// OCR's SDK hardcodes five retries. This boundary performs the permitted provider
// attempts and tells the SDK not to retry the final response. Identical failed
// requests retain their outcome rather than receiving a new budget.
export async function createProviderProxy({ endpoint, token, model, store, jobId, delegationId = jobId, circuit, fetchFn = fetch, sleep, random }) {
  const failures = [];
  const inFlight = new Map();
  const controller = new AbortController();
  const scope = providerScope(endpoint, model, token);
  const ledger = store.get("ledger", delegationId) ?? createLedger();
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      // OCR's filter emits a null required list for tools without mandatory
      // arguments. x.ai rejects it; an empty list preserves that intent.
      for (const tool of payload.tools ?? []) {
        const schema = tool.input_schema ?? tool.function?.parameters;
        if (schema?.required === null) schema.required = [];
      }
      const body = JSON.stringify(payload);
      const requestId = `${jobId}:review:${createHash('sha256').update(body).digest('hex')}`;
      const cached = store.get('proxy_result', requestId);
      const perform = async () => {
        try {
          const result = await retryProviderOperation(async () => {
            controller.signal.throwIfAborted();
            const attemptId = store.begin(requestId, { kind: 'model', jobId, scope, startedAt: Date.now(), request: JSON.parse(body) });
            try {
              const response = await fetchFn(new URL(req.url, endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body, signal: controller.signal });
              const text = await readProviderResponse(response, state => store.put('text_detector', requestId, state));
              const outcome = { status: response.status, text, contentType: response.headers.get('content-type') || 'application/json' };
              store.finish(attemptId, outcome);
              if (!response.ok) throw Object.assign(new Error(text), { status: response.status, retryAfter: response.headers.get('retry-after') });
              return outcome;
            } catch (error) {
              try { store.finish(attemptId, { error: error.message }); } catch { /* already recorded HTTP outcome */ }
              throw error;
            }
          }, { ledger, circuit, scope, random, sleep: async ms => {
            controller.signal.throwIfAborted();
            if (sleep) await sleep(ms);
            else await delay(ms, undefined, { signal: controller.signal });
            controller.signal.throwIfAborted();
          } });
          store.put('proxy_result', requestId, result);
          return result;
        } catch (error) {
          const failure = { status: error.status || 502, text: JSON.stringify({ error: { message: error.message, type: error.failureClass ?? classifyFailure(error) } }), contentType: 'application/json', failureClass: error.failureClass ?? classifyFailure(error), attempts: error.attempts, exhausted: error.exhausted };
          failures.push(failure);
          store.put('proxy_result', requestId, failure);
          return failure;
        } finally { store.put('ledger', delegationId, ledger); }
      };
      if (!cached && !inFlight.has(requestId)) inFlight.set(requestId, perform());
      const outcome = cached ?? await inFlight.get(requestId);
      if (cached?.failureClass) failures.push(cached);
      res.writeHead(outcome.status, { 'Content-Type': outcome.contentType, 'x-should-retry': 'false' });
      res.end(outcome.text);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    failures,
    async close() {
      controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
