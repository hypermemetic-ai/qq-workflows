import { conversationTokens } from './fold.mjs';

const sum = values => values.reduce((a, b) => a + b, 0);
const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, median: null, mean: null, p90: null };
  const middle = Math.floor(sorted.length / 2);
  return { samples: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    mean: sum(sorted) / sorted.length, p90: sorted[Math.ceil(sorted.length * .9) - 1] };
}

// Read the existing journal; never invoke a model or include transcript contents in reports.
export function architectMeasurements(db, { cwd, source } = {}) {
  const records = kind => db.prepare('SELECT id,value FROM records WHERE kind=? ORDER BY rowid').all(kind)
    .map(row => [row.id, JSON.parse(row.value)]);
  const states = new Map(records('turn'));
  const attempts = new Map();
  for (const row of db.prepare('SELECT operation,state,value FROM attempts ORDER BY rowid').all()) {
    const split = row.operation.indexOf(':model:');
    if (split < 0) continue;
    const key = row.operation.slice(0, split);
    if (!attempts.has(key)) attempts.set(key, []);
    attempts.get(key).push({ ...row, value: JSON.parse(row.value) });
  }
  const turns = [];
  for (const [id, metadata] of records('architect_turn')) {
    if (metadata.version !== 1 || (cwd && metadata.cwd !== cwd)) continue;
    const rows = attempts.get(id) ?? [];
    const successful = new Map();
    for (const row of rows) if (row.value.outcome?.raw) {
      successful.set(row.value.outcome.raw.id ?? row.operation, row.value.outcome);
    }
    const responses = [...successful.values()];
    const calls = new Map();
    for (const response of responses) for (const call of response.toolCalls ?? []) calls.set(call.id, call);
    const outputs = new Map();
    const state = states.get(id);
    for (const item of [...rows.flatMap(row => row.value.request?.input ?? []), ...(state?.input ?? []), ...(state?.outputs ?? [])]) {
      if (item.type === 'function_call_output' && calls.has(item.call_id)) outputs.set(item.call_id, text(item.output));
    }
    const user = rows[0]?.value.request?.input?.filter(item => item.role === 'user').at(-1)?.content ?? '';
    const userText = text(user);
    const assistantTexts = responses.map(response => response.text ?? '');
    const callTexts = responses.flatMap(response => (response.raw.output ?? [])
      .filter(item => item.type === 'function_call' || item.type === 'tool_call')
      .map(item => `${item.name}\n${text(item.arguments)}`));
    const components = {
      user: [userText], assistant: assistantTexts, toolCalls: callTexts, toolOutputs: [...outputs.values()],
    };
    const tokens = Object.fromEntries(Object.entries(components).map(([key, values]) => [key, sum(values.map(conversationTokens))]));
    const characters = Object.fromEntries(Object.entries(components).map(([key, values]) => [key, sum(values.map(value => [...value].length))]));
    const reasoning = responses.map(response => response.raw.usage?.output_tokens_details?.reasoning_tokens);
    const completeAccounting = responses.length > 0 && reasoning.every(Number.isFinite) && calls.size === outputs.size;
    const reasoningTokens = responses.length && reasoning.every(Number.isFinite) ? sum(reasoning) : null;
    turns.push({ id, ...metadata, tokens, characters, reasoningTokens,
      model: rows[0]?.value.request?.model ?? null, reasoningEffort: rows[0]?.value.request?.reasoning ?? null,
      estimatedFullTokens: completeAccounting ? sum(Object.values(tokens)) + reasoningTokens : null,
      modelResponses: responses.length, providerAttempts: rows.length,
      unsuccessfulAttempts: rows.filter(row => row.state !== 'complete' || !row.value.outcome?.raw).length,
      toolCalls: calls.size, missingToolOutputs: calls.size - outputs.size,
      peakProviderInputTokens: Math.max(0, ...responses.map(response => response.raw.usage?.input_tokens ?? 0)),
    });
  }
  const windows = [];
  const previous = new Map();
  for (const turn of turns) {
    if (turn.status !== 'completed') continue;
    const prior = previous.get(turn.sessionId);
    if (prior && prior.estimatedFullTokens != null && turn.estimatedFullTokens != null) {
      windows.push({ sessionId: turn.sessionId, turns: [prior.id, turn.id],
        estimatedFullTokens: prior.estimatedFullTokens + turn.estimatedFullTokens });
    }
    previous.set(turn.sessionId, turn);
  }
  const selectedTurns = source ? turns.filter(turn => turn.source === source) : turns;
  const selectedIds = new Set(selectedTurns.map(turn => turn.id));
  const selectedWindows = windows.filter(window => window.turns.every(id => selectedIds.has(id)));
  return { version: 1, method: 'o200k_base text estimate plus provider-reported reasoning; excludes pinned instructions, ticket and tool definitions. Failed attempts have unknown generation. Only labelled Architect turns; no legacy, child-agent or coding-session samples.',
    sessions: new Set(selectedTurns.map(turn => turn.sessionId)).size,
    statusCounts: selectedTurns.reduce((counts, turn) => ({ ...counts, [turn.status]: (counts[turn.status] ?? 0) + 1 }), {}),
    twoTurnTokens: stats(selectedWindows.map(window => window.estimatedFullTokens)), turns: selectedTurns, windows: selectedWindows };
}
