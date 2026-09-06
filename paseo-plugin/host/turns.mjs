export function createTurnState() {
  return {
    generation: 0,
    chain: Promise.resolve(),
  };
}

export function bumpGeneration(state) {
  state.generation += 1;
  return state.generation;
}

export function enqueueTurn(state, fn) {
  const run = state.chain.then(fn, fn);
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}

export function wakeIsStale(state, generation) {
  return state.generation !== generation;
}
