import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { withRelayProcessLock, registerRelayHolder, removeRelayHolder, remainingRelayHolders } from '../workflow/relay-process-holders.mjs';

if (process.env.QQ_TEST_RELAY_LOCK) {
  await withRelayProcessLock(process.env.QQ_TEST_RELAY_LOCK, async () => {
    registerRelayHolder(process.env.QQ_TEST_RELAY_LOCK);
    process.send('locked');
    await new Promise(() => { setInterval(() => {}, 1000); });
  });
} else {
  const root = mkdtempSync(join(tmpdir(), 'qq-relay-holder-lock-'));
  chmodSync(root, 0o700);
  const dir = join(root, 'relay');
  let child;
  try {
    child = fork(new URL(import.meta.url), [], { env: { ...process.env, QQ_TEST_RELAY_LOCK: dir }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    assert.equal((await once(child, 'message'))[0], 'locked');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await withRelayProcessLock(dir, () => {
      assert.deepEqual(remainingRelayHolders(dir), [], 'dead process hold is pruned after lock owner crash');
      const live = registerRelayHolder(dir);
      assert.equal(remainingRelayHolders(dir).length, 1);
      const holders = join(root, 'relay-runtime', 'holders');
      writeFileSync(join(holders, `${child.pid}-${randomUUID()}.json`), '', { mode: 0o600 });
      assert.equal(remainingRelayHolders(dir).length, 1, 'torn hold of provably dead PID is pruned');
      writeFileSync(join(holders, `${process.pid}-${randomUUID()}.json`), '', { mode: 0o600 });
      assert.equal(remainingRelayHolders(dir).length, 2, 'torn hold of live PID prevents shutdown');
      removeRelayHolder(live);
      assert.equal(remainingRelayHolders(dir).length, 1);
    });
    console.log('PASS relay lock: kernel crash recovery; dead/torn/unknown holder safety');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
}
