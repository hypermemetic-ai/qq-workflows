import { createHash } from 'node:crypto';
import { completeArchitect, loadCodexAuth } from './model.mjs';
import { createCircuit, createLedger, retryProviderOperation } from './recovery.mjs';
import { providerScope } from './supervisor.mjs';

export async function supervisedArchitect(request, { store, turnKey, complete = completeArchitect, sleep, random }) {
  const identity = createHash('sha256').update(JSON.stringify({ input: request.input, tools: request.tools, instructions: request.instructions })).digest('hex');
  const operation = `${turnKey}:model:${identity}`;
  const saved = store.get('architect_response', operation);
  if (saved) return saved;
  const failed = store.get('architect_failure', operation);
  if (failed) throw Object.assign(new Error(failed.message), failed);
  const auth = request.auth ?? (process.env.OPENAI_API_KEY ? null : await loadCodexAuth());
  const scope = providerScope(process.env.OPENAI_BASE_URL || 'codex/responses', 'gpt-6-astra', process.env.OPENAI_API_KEY || auth?.accessToken);
  const ledger = store.get('ledger', turnKey) ?? createLedger();
  try {
    const result = await retryProviderOperation(async () => {
      const attempt = store.begin(operation, { kind: 'model', request: { input: request.input, tools: request.tools, instructions: request.instructions, model: 'gpt-6-astra', reasoning: 'high' } });
      try {
        const response = await complete({ ...request, auth, reasoning: 'high' });
        store.finish(attempt, response);
        return response;
      } catch (error) {
        store.finish(attempt, { message: error.message, status: error.status });
        throw error;
      }
    }, { ledger, scope, circuit: createCircuit({ store }), sleep, random });
    store.put('architect_response', operation, result);
    return result;
  } catch (error) {
    // Cancellation permits a later explicit turn; spent provider requests do not.
    if (!request.signal?.aborted) store.put('architect_failure', operation, { message: error.message, failureClass: error.failureClass, attempts: error.attempts, exhausted: error.exhausted });
    throw error;
  } finally { store.put('ledger', turnKey, ledger); }
}
