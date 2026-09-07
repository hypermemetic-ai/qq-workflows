#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_INDEX_EMBEDDING, indexWorkspace } from "../paseo-plugin/host/search/zg.mjs";

const ran = [];
await indexWorkspace("/tmp/ws", {
  execFileFn: async (command, args, opts) => {
    ran.push({ command, args, opts });
    return { stdout: "Indexing complete\n", stderr: "" };
  },
});
assert.equal(ran[0].command, "zg");
assert.deepEqual(ran[0].args, ["index", "/tmp/ws", "--embedding", DEFAULT_INDEX_EMBEDDING, "--mode", "direct", "--rebuild"]);
assert.ok(ran[0].opts.timeout > 119_000 && ran[0].opts.timeout <= 120_000);
assert.match(ran[0].opts.env.ZVEC_GREP_HOME, /architect\/zg$/);
let clock = 0;
const contended = [];
await indexWorkspace('/tmp/ws', {
  home: '/isolated-zg', now: () => clock,
  sleep: async ms => { clock += ms; },
  execFileFn: async (command, args, opts) => {
    contended.push({ args, opts });
    if (contended.length < 3) throw Object.assign(new Error('Command failed: zg index --embedding model'), { stderr: 'Code: ZVEC_GREP.ENGINE.LOCK.BUSY' });
    return { stdout: 'complete' };
  },
});
assert.equal(contended.length, 3);
assert.ok(contended.every(call => call.args.includes('--embedding')));
assert.ok(contended.every(call => call.opts.env.ZVEC_GREP_HOME === '/isolated-zg'));
assert.equal(contended[2].opts.timeout, 118_000);
let exhausted = 0;
clock = 0;
await assert.rejects(indexWorkspace('/tmp/ws', { timeout: 2000, now: () => clock, sleep: async ms => { clock += ms; },
  execFileFn: async () => { exhausted++; throw new Error('ZVEC_GREP.ENGINE.LOCK.BUSY'); },
}), /LOCK.BUSY/);
assert.equal(exhausted, 2);
let permanent = 0;
await assert.rejects(indexWorkspace('/tmp/ws', { execFileFn: async () => {
  permanent++; throw Object.assign(new Error('Command failed: zg --embedding model'), { stderr: 'Permission denied' });
} }), /Command failed/);
assert.equal(permanent, 1, 'failed command text must not trigger an embedding fallback');
const mismatch = [];
await indexWorkspace('/tmp/ws', { execFileFn: async (command, args) => {
  mismatch.push(args);
  if (mismatch.length === 1) throw Object.assign(new Error('index failed'), { stderr: 'ZVEC_GREP.ENGINE.WORKSPACE_INDEX.EMBEDDING_MODEL_MISMATCH' });
  return { stdout: 'complete' };
} });
assert.equal(mismatch[1].includes('--embedding'), false);

let failFast = 0;
await assert.rejects(indexWorkspace('/tmp/ws', { waitForLock: false,
  sleep: async () => { throw new Error('Must not wait'); },
  execFileFn: async () => { failFast++; throw new Error('ZVEC_GREP.ENGINE.LOCK.BUSY'); },
}), /LOCK.BUSY/);
assert.equal(failFast, 1);
