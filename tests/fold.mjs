#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assembleArchitectRequest, keptPairs, rememberPair, requestPairs, conversationTokens, contextWindow, tokenSuffix, CONVERSATION_TOKEN_FLOOR } from '../paseo-plugin/host/fold.mjs';
const pair = (id, tokens) => ({ messageId: id, operator: '', architect: ' word'.repeat(tokens) });
const count = pairs => pairs.reduce((n, p) => n + conversationTokens(p.operator) + conversationTokens(p.architect), 0);
const history = [pair('old', 5000), pair('previous', 1000)];
const saved = structuredClone(history);
const current = ' word'.repeat(900);
const selected = requestPairs(history, current);
assert.equal(CONVERSATION_TOKEN_FLOOR, 2048);
assert.equal(count(selected) + conversationTokens(current), 2048);
assert.equal(conversationTokens(selected[0].architect), 148, '1900 recent tokens add only 148 older tokens');
assert.equal(selected[0].trimmed, true);
assert.deepEqual(selected[1], history[1], 'the previous exchange remains intact');
assert.equal(contextWindow(selected, 'current').firstExchange.architect, selected[0].architect);
const request = assembleArchitectRequest({ ticketText: ' huge'.repeat(5000), pairs: history, operatorText: current });
assert.equal(request.input.slice(1).reduce((n, item) => n + conversationTokens(item.content), 0), 2048, 'ticket does not consume the floor');
assert.deepEqual(requestPairs(history, ' word'.repeat(3000)), [history[1]], 'minimum exchanges can exceed the token floor');
assert.deepEqual(keptPairs(history), history, 'at least two completed exchanges remain intact');
assert.equal(count(keptPairs([...history, pair('latest', 900)])), 2048);
const small = [pair('1', 2), pair('2', 2), pair('3', 2)];
assert.deepEqual(keptPairs(small), small, 'early conversation is not padded');
const crossMessage = requestPairs([{ messageId: 'old', operator: ' question'.repeat(200), architect: ' answer'.repeat(100) }, pair('prev', 1000)], current);
assert.equal(conversationTokens(crossMessage[0].architect), 100);
assert.equal(conversationTokens(crossMessage[0].operator), 48);
for (const text of ['你好 👋 café '.repeat(100), '<|endoftext|> const x = 1; '.repeat(100)]) {
  for (const budget of [1, 2, 3, 17, 148]) {
    const suffix = tokenSuffix(text, budget);
    assert.ok(text.endsWith(suffix));
    assert.ok(conversationTokens(suffix) <= budget);
    assert.ok(!suffix.includes('\uFFFD'));
  }
}
const next = rememberPair(history, current, 'okay', 'next');
assert.equal(next.at(-1).messageId, 'next');
assert.deepEqual(requestPairs(JSON.parse(JSON.stringify(next)), 'continue'), requestPairs(next, 'continue'));
assert.deepEqual(history, saved);
assert.deepEqual(keptPairs(undefined), []);
console.log('2048-token gap fill, partial oldest exchange, Unicode-safe trimming, minimum exchanges and persistence passed');
