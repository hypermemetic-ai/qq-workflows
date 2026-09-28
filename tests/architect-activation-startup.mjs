import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectExtension } from '../pi-extension/qq-architect.mjs';
import { readReceipt, receiptPath } from '../workflow/activation-receipt.mjs';
import { callHandlers, fakeContext, fakePi, tempDir, tickQueue } from './support/architect-fixtures.mjs';

const home = tempDir('qq-activation-start-');
const id = 'a1deb084-e29c-4c6b-8574-f2c845533a16';
const sessionFile = join(home, 'session.jsonl');
writeFileSync(sessionFile, 'native history\n');
const env = { QQ_ARCHITECT_OWNER_AGENT_ID: id, QQ_WORKFLOW_SESSION_ID: id };
async function start({ recoveryFails = false, evidence = true } = {}) {
  if (evidence) rmSync(receiptPath(id, home), { force: true });
  const pi = fakePi();
  const ticks = tickQueue();
  const extension = createArchitectExtension(pi, { env, cwd: home, activationHome: home,
    schedule: ticks.schedule,
    workflowFactory: () => ({ session: () => ({ sessionId: id, sessionKey: id, ownerAgentId: id,
      ticketPath: `.architect/tickets/${id}.md`, root: home }),
      recoverDeliveries: async () => recoveryFails ? { ok: false } : { ok: true, delivery: { replayed: [], deferred: [] }, jobs: [] } }) });
  const ctx = fakeContext();
  if (evidence) ctx.sessionManager = { getEntries: () => [], getSessionFile: () => sessionFile };
  await callHandlers(pi, 'session_start', { reason: 'startup' }, ctx);
  if (evidence) assert.equal(existsSync(receiptPath(id, home)), false, 'not written before recovery');
  await ticks.flush();
  await extension.whenReady();
  await callHandlers(pi, 'session_shutdown', {}, ctx);
  return readReceipt(id, home);
}
assert.equal((await start({ recoveryFails: true })).recovery.ok, false, 'failure is recorded, not uptake');
assert.equal((await start()).recovery.ok, true);
assert.equal(readReceipt(id, home).sessionFile, sessionFile);
assert.equal(readReceipt(id, home).ownerAgentId, id);
const previous = readReceipt(id, home);
await start({ evidence: false });
assert.deepEqual(readReceipt(id, home), previous, 'absence of owning session evidence never writes success');
console.log('architect activation startup receipts passed');
