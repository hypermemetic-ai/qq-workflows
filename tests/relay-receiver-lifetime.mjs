import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunicationReceiver } from '../workflow/communication-receiver.mjs';
import { withRelayProcessLock, remainingRelayHolders } from '../workflow/relay-process-holders.mjs';

const root = mkdtempSync(join(tmpdir(), 'qq-receiver-lifetime-'));
chmodSync(root, 0o700);
const dir = join(root, 'relay');
const receiver = createCommunicationReceiver({}, { binding: {
  socketPath: join(dir, 'qq-relay.sock'), changeId: 'receiver-lifetime', role: 'runner',
} });
try {
  let starting;
  await withRelayProcessLock(dir, async () => {
    starting = receiver.start({}, { sessionManager: { getSessionId: () => '2c0f7d35-cc23-4229-8a66-1fb0e81bff70' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    await receiver.stop();
  });
  await starting;
  assert.equal(receiver.address, null, 'shutdown cannot be undone by late acquisition');
  await withRelayProcessLock(dir, () => assert.deepEqual(remainingRelayHolders(dir), [], 'late acquired reference is released'));
  console.log('PASS receiver shutdown during transport acquisition cannot resurrect polling or leak a hold');
} finally { await receiver.stop(); rmSync(root, { recursive: true, force: true }); }
