// Real installed relay, two independent process holders. Only fixture-owned
// processes are terminated by cleanup; no production state is involved.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRelayRuntime, resolveRelayInstall } from '../workflow/communication.mjs';

const childRoot = process.env.QQ_TEST_RELAY_HOLDER;
if (childRoot) {
  const result = await acquireRelayRuntime({ stateDir: childRoot });
  assert.equal(result.ok, true, result.reason);
  process.send({ type: 'ready', healthy: (await result.relay.inspect()).service === 'qq-relay' });
  process.on('message', async message => {
    if (message === 'inspect') {
      try { process.send({ type: 'health', healthy: (await result.relay.inspect()).service === 'qq-relay' }); }
      catch { process.send({ type: 'health', healthy: false }); }
    } else if (message === 'release') {
      await result.relay.release();
      process.disconnect();
    }
  });
} else if (!resolveRelayInstall(process.env).root) {
  console.log('SKIP cross-process relay lifetime: installed relay unavailable');
} else {
  const root = mkdtempSync(join(tmpdir(), 'qq-relay-process-holders-'));
  chmodSync(root, 0o700);
  const ownedChildren = [];
  let borrower;
  const options = { stateDir: root, spawnImpl: (...args) => {
    const child = spawn(...args); ownedChildren.push(child); return child;
  } };
  const message = child => Promise.race([
    once(child, 'message').then(([value]) => value),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('relay borrower response timed out')), 10000); timer.unref(); }),
  ]);
  try {
    const owner = await acquireRelayRuntime(options);
    assert.equal(owner.ok, true, owner.reason);
    borrower = fork(new URL(import.meta.url), [], {
      env: { ...process.env, QQ_TEST_RELAY_HOLDER: root },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    assert.deepEqual(await message(borrower), { type: 'ready', healthy: true });
    await owner.relay.release();
    const afterRelease = message(borrower); borrower.send('inspect');
    assert.deepEqual(await afterRelease, { type: 'health', healthy: true },
      'finishing one owner must preserve another live process holder');
    // Reacquisition after local teardown must reuse the surviving transport.
    const replacement = await acquireRelayRuntime(options);
    assert.equal(replacement.ok, true, replacement.reason);
    assert.equal(ownedChildren.length, 1, 'reconnect never launches a competing relay');
    await replacement.relay.release();
    const afterReconnect = message(borrower); borrower.send('inspect');
    assert.equal((await afterReconnect).healthy, true);
    const finished = once(borrower, 'exit'); borrower.send('release'); await finished;
    // A dead process's stale hold is rebuildable transport bookkeeping. It
    // cannot prevent cleanup of another independently owned runtime forever.
    const secondRoot = join(root, 'second');
    const second = await acquireRelayRuntime({ ...options, stateDir: secondRoot });
    assert.equal(second.ok, true, second.reason);
    borrower = fork(new URL(import.meta.url), [], {
      env: { ...process.env, QQ_TEST_RELAY_HOLDER: secondRoot },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    assert.equal((await message(borrower)).healthy, true);
    const crashed = once(borrower, 'exit'); borrower.kill('SIGKILL'); await crashed;
    assert.equal((await second.relay.release()).released, true, 'provably dead holder is pruned safely');
    console.log('PASS real relay: cross-process holder survives cleanup/reconnect; dead holder does not prevent owned cleanup');
  } finally {
    for (const child of [borrower, ...ownedChildren].filter(Boolean)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.ref(); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
