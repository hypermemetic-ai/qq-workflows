import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { callHost } from './runtime.mjs';
import { classifyFailure } from './recovery.mjs';
import { providerScope } from './supervisor.mjs';
import { readProviderResponse } from './text-loop.mjs';

// Grok retains its native conversation loop. Only HTTP attempts cross this
// boundary, with its internal retries disabled by the launcher.
export async function nativeProvider({ endpoint, jobId, hostUrl, fetchFn = fetch }) {
  const journal = payload => callHost('/runner', { jobId, ...payload }, { hostUrl });
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length']; delete headers['accept-encoding'];
      const url = new URL(req.url, endpoint);
      const request = body ? JSON.parse(body) : {};
      const modelRequest = /chat\/completions$|responses$/.test(url.pathname);
      const operation = 'native-model:' + createHash('sha256').update(body).digest('hex');
      const scope = providerScope(endpoint, request.model, headers.authorization);
      for (;;) {
        const attempt = modelRequest ? await journal({ event: 'begin', operation, value: { kind: 'model', scope, request } }) : null;
        let response, text;
        try {
          response = await fetchFn(url, { method: req.method, headers, ...(body ? { body } : {}), signal: controller.signal });
          text = await readProviderResponse(response, state => journal({ event: 'checkpoint', operation: `${operation}:text`, value: state }));
          if (!response.ok) throw Object.assign(new Error(text), { status: response.status, retryAfter: response.headers.get('retry-after') });
        } catch (error) {
          if (!attempt) throw error;
          const failure = await journal({ event: 'failure', operation, attemptId: attempt.attemptId, value: { message: error.message, status: error.status, failureClass: controller.signal.aborted ? 'cancelled' : classifyFailure(error), retryAfter: error.retryAfter } });
          if (!failure.retry) throw error;
          await new Promise((resolve, reject) => { const timer = setTimeout(resolve, failure.delayMs); controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(controller.signal.reason); }, { once: true }); });
          continue;
        }
        if (attempt) await journal({ event: 'success', operation, attemptId: attempt.attemptId, value: { status: response.status, text } });
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'x-should-retry': 'false' });
        res.end(text); return;
      }
    } catch (error) {
      res.writeHead(error.status ?? 502, { 'Content-Type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => { server.closeAllConnections(); server.close(); } };
}
