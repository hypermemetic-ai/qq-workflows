import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRelayRuntime, resolveRelayInstall } from '../workflow/communication.mjs';

const install = resolveRelayInstall(process.env);
if (!install.root) {
  console.log('SKIP relay acquisition: installed qq-relay unavailable');
} else {
  const root = mkdtempSync(join(tmpdir(), 'qq-relay-acquisition-'));
  chmodSync(root, 0o700);
  const children = [];
  const spawnImpl = (...args) => { const child = spawn(...args); children.push(child); return child; };
  const options = { stateDir: root, spawnImpl };
  try {
    const results = await Promise.all(Array.from({ length: 24 }, () => acquireRelayRuntime(options)));
    for (const result of results) assert.equal(result.ok, true, result.reason);
    assert.equal(children.length, 1, 'parallel startup must spawn one singleton relay');
    const handle = results[0].relay;
    assert.ok(results.every(result => result.relay === handle));
    assert.equal(handle.refCount, 24);
    assert.equal((await handle.inspect()).service, 'qq-relay');
    const releases = await Promise.all(results.slice(1).map(result => result.relay.release()));
    assert.ok(releases.every(result => !result.released));
    assert.equal(handle.refCount, 1);
    assert.equal((await handle.inspect()).service, 'qq-relay', 'one remaining worker retains usable transport');

    // Acquisition begins while the last release is still awaiting child exit.
    const closing = handle.release();
    const opening = acquireRelayRuntime(options);
    assert.equal((await closing).released, true);
    const reopened = await opening;
    assert.equal(reopened.ok, true, reopened.reason);
    assert.notEqual(reopened.relay, handle, 'a closing handle cannot be reacquired');
    assert.equal(children.length, 2);
    assert.equal(reopened.relay.refCount, 1);
    assert.equal((await reopened.relay.inspect()).service, 'qq-relay');
    assert.equal(acquireRelayRuntime.cache.get(root), reopened.relay, 'old exit callback cannot evict replacement');
    assert.equal((await handle.release()).released, false, 'late duplicate release cannot affect replacement');
    assert.equal((await reopened.relay.release()).released, true);
    assert.equal(acquireRelayRuntime.cache.has(root), false, 'release evicts the outer state-directory key');
    console.log('PASS real relay: concurrent startup, partial release, shutdown/reacquire ordering and cache identity');
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
