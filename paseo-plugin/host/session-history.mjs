import { keptPairs } from './fold.mjs';
import { responseItems } from './loop.mjs';

// Old sessions counted automatic wakes as human exchanges. Recover only
// completed, durably recorded turns; never regenerate an answer or tool effect.
export function restoreOperatorHistory(store, sessionId, savedPairs) {
  const turns = store.list('architect_turn')
    .filter(([, turn]) => turn.sessionId === sessionId && turn.status === 'completed')
    .sort((a, b) => a[1].startedAt - b[1].startedAt)
    .map(([id, turn]) => ({ ...turn, id }));
  const selected = keptPairs(turns);
  if (!selected.length) return keptPairs(savedPairs);
  const pairs = [];
  for (const turn of selected) {
    const state = store.get('turn', turn.id);
    if (!Array.isArray(state?.input) || !Number.isInteger(state.exchangeStart) ||
        state.exchangeStart < 0 || state.exchangeStart >= state.input.length ||
        !state.result || state.result.toolCalls?.length) return keptPairs(savedPairs);
    const items = [...state.input.slice(state.exchangeStart), ...responseItems(state.result)];
    const first = items[0];
    if (first?.role !== 'user' || typeof first.content !== 'string') return keptPairs(savedPairs);
    pairs.push({ source: turn.source, messageId: turn.messageId,
      operator: first.content, architect: (state.assistantParts ?? []).join(''), items });
  }
  return pairs;
}
