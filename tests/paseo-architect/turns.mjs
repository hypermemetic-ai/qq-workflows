#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  bumpGeneration,
  createTurnState,
  enqueueTurn,
  wakeIsStale,
} from "../../paseo-plugin/host/turns.mjs";

const order = [];
const state = createTurnState();
let releasePrompt;
const promptGate = new Promise((resolve) => {
  releasePrompt = resolve;
});
let startedPrompt;
const promptStarted = new Promise((resolve) => {
  startedPrompt = resolve;
});

const prompt = enqueueTurn(state, async () => {
  order.push("prompt-start");
  startedPrompt();
  await promptGate;
  order.push("prompt-end");
});

const wakeGen = state.generation;
const wake = enqueueTurn(state, async () => {
  assert.equal(wakeIsStale(state, wakeGen), false);
  order.push("wake");
});

await promptStarted;
assert.deepEqual(order.slice(), ["prompt-start"]);
releasePrompt();
await Promise.all([prompt, wake]);
assert.deepEqual(order.slice(), ["prompt-start", "prompt-end", "wake"]);

const stale = createTurnState();
const gen = stale.generation;
bumpGeneration(stale);
assert.equal(wakeIsStale(stale, gen), true);
assert.equal(wakeIsStale(stale, stale.generation), false);
