import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activateArchitects, journalPath } from '../scripts/activate-architect.mjs';
import { readReceipt, writeReceipt } from '../workflow/activation-receipt.mjs';
import { tempDir } from './support/architect-fixtures.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const id = 'a1deb084-e29c-4c6b-8574-f2c845533a16';
const other = 'cc67e366-089c-4ede-af31-9b0263b1b662';
const home = tempDir('qq-activation-');
const sessionFile = join(home, 'pi-session.jsonl');
writeFileSync(sessionFile, 'history\n');
const moduleUrl = pathToFileURL(join(repoRoot, 'pi-extension', 'qq-architect.mjs')).href;
const operationsUrl = pathToFileURL(join(repoRoot, 'workflow', 'operations.mjs')).href;
const receipt = (agentId, pid, startedAt = 20) => ({ agentId, sessionKey: agentId, ownerAgentId: agentId,
  sessionId: agentId, ticketPath: `.architect/tickets/${agentId}.md`, root: '/project', sessionFile, pid, startedAt,
  extensionModule: moduleUrl, operationsModule: operationsUrl, recovery: { ok: true, deferred: 1 } });
const meta = (agentId, Status = 'idle') => ({ Id: agentId, Provider: 'qq-architect', Status, Cwd: '/project', Archived: false });
function fake({ busy = 0, wrong = false, failReload = false, uncertain = false, lostReply = false, receiptAfter = true, malformed = false, changedSession = false,
  caseHome = home, caseSessionFile = sessionFile } = {}) {
  let tick = 20, reloads = 0, inspected = 0;
  const calls = [];
  const run = (_bin, args) => {
    calls.push(args.join(' '));
    if (malformed) return { status: 0, stdout: 'not json' };
    if (args[1] === 'ls') return { status: 0, stdout: JSON.stringify([
      { id, provider: 'qq-architect/model', status: 'running' },
      { id: other, provider: 'codex/model' }, { id: 'fake', provider: 'qq-architect/model' }]) };
    if (args[1] === 'inspect') return { status: 0, stdout: JSON.stringify({ ...meta(id, ++inspected <= busy ? 'running' : 'idle'), Provider: wrong ? 'codex' : 'qq-architect' }) };
    if (args[1] === 'reload') {
      reloads++;
      if (failReload && reloads <= (typeof failReload === 'number' ? failReload : Infinity)) return { status: 1, stderr: 'busy race' };
      if (receiptAfter) {
        writeFileSync(caseSessionFile, 'history\nnew entry\n');
        const newSession = join(caseHome, 'different-session.jsonl');
        if (changedSession) writeFileSync(newSession, 'different history\n');
        writeReceipt(id, { ...receipt(id, 901, tick), sessionFile: changedSession ? newSession : caseSessionFile }, caseHome);
      }
      return lostReply ? { status: 1, stderr: 'transport lost reply' } : { status: 0, stdout: uncertain ? 'not json' : '{}' };
    }
    throw new Error(args.join(' '));
  };
  const opts = { home: caseHome, repoRoot, run, paseoBin: 'fake-paseo', now: () => tick,
    sleep: async () => { tick += 10; }, pollMs: 10, waitMs: 70, isAlive: () => true };
  return { opts, calls, get reloads() { return reloads; } };
}
// New path: a busy turn becomes idle; detached job doesn't matter; only target
// Architect is reloaded, with native session and recovery provenance retained.
let f = fake({ busy: 4 });
let result = await activateArchitects(f.opts);
assert.equal(result.status, 'complete');
assert.equal(result.agents[id].status, 'applied');
assert.equal(result.agents[id].sessionFile, sessionFile);
assert.equal(result.agents[id].recovery.deferred, 1);
assert.equal(f.reloads, 1);
assert.equal(result.agents[other], undefined);
assert.equal(readFileSync(journalPath(home, repoRoot), 'utf8').includes('"applied"'), true);

f = fake();
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'already-current');
assert.equal(f.reloads, 0);
// Dead process, wrong module and recovery failure cannot be interpreted as
// uptake. A successful CLI reload with no post-startup receipt stays pending.
f = fake({ receiptAfter: false });
result = await activateArchitects({ ...f.opts, isAlive: () => false });
assert.equal(result.status, 'pending');
assert.equal(result.agents[id].status, 'pending');
assert.equal(f.reloads, 1);
f = fake({ receiptAfter: false });
result = await activateArchitects({ ...f.opts, isAlive: () => false });
assert.equal(f.reloads, 0, 'a retry observes an accepted reload instead of blindly repeating it');
assert.equal(result.agents[id].status, 'pending');
writeReceipt(id, { ...receipt(id, 800), extensionModule: 'file:///old/qq-architect.mjs' }, home);
f = fake({ receiptAfter: false });
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'pending');

f = fake({ wrong: true });
result = await activateArchitects(f.opts);
assert.equal(result.status, 'partial-failed');
assert.match(result.agents[id].reason, /identity/);
assert.equal(f.reloads, 0);
f = fake({ failReload: true });
result = await activateArchitects(f.opts);
assert.equal(result.status, 'pending');
assert.ok(f.reloads >= 1);
assert.match(result.agents[id].reason, /reload failed/);
// A refused reload at idle is retried in this operation; no manual retry is
// necessary. Tests use fresh homes so no live daemon/receipt is touched.
const transientHome = tempDir('qq-activation-transient-');
const transientSession = join(transientHome, 'session.jsonl');
writeFileSync(transientSession, 'history\n');
f = fake({ caseHome: transientHome, caseSessionFile: transientSession, failReload: 1 });
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'applied');
assert.equal(f.reloads, 2);
// Malformed success output is uncertain: persist intent, reconcile a later
// receipt on the next invocation, and never issue a second reload.
const uncertainHome = tempDir('qq-activation-uncertain-');
const uncertainSession = join(uncertainHome, 'session.jsonl');
writeFileSync(uncertainSession, 'history\n');
f = fake({ caseHome: uncertainHome, caseSessionFile: uncertainSession, uncertain: true, receiptAfter: false });
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'pending');
assert.equal(f.reloads, 1);
writeReceipt(id, { ...receipt(id, 901, 20), sessionFile: uncertainSession }, uncertainHome);
f = fake({ caseHome: uncertainHome, caseSessionFile: uncertainSession });
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'applied');
assert.equal(f.reloads, 0);
const lostHome = tempDir('qq-activation-lost-reply-');
const lostSession = join(lostHome, 'session.jsonl');
writeFileSync(lostSession, 'history\n');
f = fake({ caseHome: lostHome, caseSessionFile: lostSession, lostReply: true, receiptAfter: false });
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'pending');
writeReceipt(id, { ...receipt(id, 901, 20), sessionFile: lostSession }, lostHome);
f = fake({ caseHome: lostHome, caseSessionFile: lostSession });
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'applied');
assert.equal(f.reloads, 0, 'a lost CLI reply must not trigger a blind reload');
// A receipt from a dead replacement process is not applied; when that PID is
// live on a later pass the same accepted reload can be reconciled.
const deadHome = tempDir('qq-activation-dead-');
const deadSession = join(deadHome, 'session.jsonl');
writeFileSync(deadSession, 'history\n');
f = fake({ caseHome: deadHome, caseSessionFile: deadSession });
result = await activateArchitects({ ...f.opts, isAlive: () => false });
assert.equal(result.agents[id].status, 'pending');
assert.equal(f.reloads, 1);
f = fake({ caseHome: deadHome, caseSessionFile: deadSession });
result = await activateArchitects(f.opts);
assert.equal(result.agents[id].status, 'applied');
assert.equal(f.reloads, 0);
f = fake({ malformed: true });
result = await activateArchitects(f.opts);
assert.equal(result.status, 'failed');
assert.match(result.error, /malformed JSON/);
writeReceipt(id, receipt(id, 600), home);
f = fake({ changedSession: true });
result = await activateArchitects({ ...f.opts, isAlive: (pid) => pid === 901 });
assert.equal(result.agents[id].status, 'failed', 'different native history must never count as applied');
assert.match(result.agents[id].reason, /continuity/);
console.log('architect activation lifecycle tests passed');
