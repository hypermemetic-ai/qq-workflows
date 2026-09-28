// Non-disruptive existing-session uptake. CLI commands are injected in tests;
// no worker/session is started to prove a reload. A durable journal survives a
// caller timeout or a detached coordinator's turn ending.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activationDir, readReceipt } from '../workflow/activation-receipt.mjs';
import { ARCHITECT_PROVIDER_ID } from '../workflow/architect-profile.mjs';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const livePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }; 
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function journalPath(home, repoRoot) {
  const key = createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 16);
  return join(activationDir(home), `activation-${key}.json`);
}
function jsonCommand(run, bin, args) {
  const result = run(bin, args, { encoding: 'utf8' });
  if (result?.error || result?.status !== 0) throw new Error(`${args.join(' ')}: ${result?.error?.message || String(result?.stderr ?? '').trim().slice(0, 240) || `exit ${result?.status}`}`);
  let data;
  try { data = JSON.parse(String(result.stdout)); } catch { throw new Error(`${args.join(' ')}: malformed JSON reply`); }
  if (data === null || typeof data !== 'object') throw new Error(`${args.join(' ')}: malformed reply`);
  return data;
}
function identity(id, inspected) {
  return inspected?.Id === id && inspected.Provider === ARCHITECT_PROVIDER_ID && !inspected.Archived && typeof inspected.Cwd === 'string';
}
function nativeFile(file) {
  if (!file || typeof file !== 'string') return null;
  try { const s = statSync(file); return { dev: s.dev, ino: s.ino, size: s.size }; } catch { return null; }
}
function provenance(receipt, id, repoRoot) {
  return receipt?.agentId === id && receipt.sessionKey === id && receipt.ownerAgentId === id &&
    receipt.sessionId === id && typeof receipt.ticketPath === 'string' && typeof receipt.root === 'string' &&
    Number.isInteger(receipt.pid) && receipt.pid > 0 &&
    Number.isFinite(receipt.startedAt) && receipt.recovery?.ok === true &&
    receipt.extensionModule === pathToFileURL(join(resolve(repoRoot), 'pi-extension', 'qq-architect.mjs')).href &&
    receipt.operationsModule === pathToFileURL(join(resolve(repoRoot), 'workflow', 'operations.mjs')).href &&
    nativeFile(receipt.sessionFile) !== null;
}
function preserve(before, after, previous) {
  if (!before) return true; // first uptake can predate session-bound receipts
  const next = nativeFile(after.sessionFile);
  return before.sessionKey === after.sessionKey && before.sessionId === after.sessionId &&
    before.ticketPath === after.ticketPath && before.root === after.root &&
    before.ownerAgentId === after.ownerAgentId && before.sessionFile === after.sessionFile &&
    previous && next && previous.dev === next.dev && previous.ino === next.ino && next.size >= previous.size;
}
function save(path, state) {
  mkdirSync(activationDir(state.home), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
export async function activateArchitects({ home, repoRoot, paseoBin = 'paseo', run = spawnSync,
  sleep = pause, now = Date.now, isAlive = livePid, waitMs = 300_000, pollMs = 1500 } = {}) {
  const path = journalPath(home, repoRoot);
  let previous = null;
  try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ }
  const state = { home, repoRoot: resolve(repoRoot), startedAt: new Date(now()).toISOString(),
    agents: previous?.repoRoot === resolve(repoRoot) ? { ...previous.agents } : {}, status: 'pending' };
  const update = (id, value) => { state.agents[id] = value; save(path, state); };
  save(path, state);
  let list;
  try {
    list = jsonCommand(run, paseoBin, ['agent', 'ls', '--global', '--json']);
    if (!Array.isArray(list)) throw new Error('agent ls: expected array');
  } catch (error) {
    state.status = 'failed'; state.error = error.message; save(path, state);
    return { ...state, journal: path };
  }
  const ids = [...new Set(list.filter((agent) => typeof agent?.provider === 'string' && agent.provider.split('/')[0] === ARCHITECT_PROVIDER_ID && uuid.test(agent.id ?? '')).map((agent) => agent.id))];
  state.agents = Object.fromEntries(ids.map((id) => [id, state.agents[id] ?? { status: 'pending', reason: 'discovered; not yet inspected' }]));
  save(path, state);
  const deadline = now() + waitMs;
  await Promise.all(ids.map(async (id) => {
    let before = null, oldMeta = null, oldNative = null, reloadAt = null;
    try {
      oldMeta = jsonCommand(run, paseoBin, ['agent', 'inspect', id, '--json']);
      if (!identity(id, oldMeta)) throw new Error('agent identity/provider changed since listing');
      const pendingReload = previous?.repoRoot === resolve(repoRoot) && previous?.agents?.[id]?.status === 'pending' &&
        Number.isFinite(previous.agents[id].reloadedAt) && previous.agents[id].cwd === oldMeta.Cwd ? previous.agents[id] : null;
      before = pendingReload ? (pendingReload.before ?? null) : readReceipt(id, home);
      oldNative = before && nativeFile(before.sessionFile);
      if (!pendingReload && provenance(before, id, repoRoot) && isAlive(before.pid)) {
        update(id, { status: 'already-current', pid: before.pid, extensionModule: before.extensionModule, operationsModule: before.operationsModule, sessionFile: before.sessionFile, recovery: before.recovery });
        return;
      }
      update(id, { status: 'pending', reason: pendingReload ? 'awaiting previous reload receipt' : 'waiting for idle', before, cwd: oldMeta.Cwd,
        reloadedAt: pendingReload?.reloadedAt ?? null });
      reloadAt = pendingReload?.reloadedAt ?? null;
      while (reloadAt === null && now() < deadline) {
        const current = jsonCommand(run, paseoBin, ['agent', 'inspect', id, '--json']);
        if (!identity(id, current) || current.Cwd !== oldMeta.Cwd) throw new Error('agent identity, provider, or project changed while waiting');
        if (current.Status !== 'idle') { await sleep(pollMs); continue; }
        // Recheck immediately before reload. Detached workflow hosts are not
        // agent turns; their status does not prevent the supported reload.
        const check = jsonCommand(run, paseoBin, ['agent', 'inspect', id, '--json']);
        if (!identity(id, check) || check.Cwd !== oldMeta.Cwd) throw new Error('agent identity changed before reload');
        if (check.Status !== 'idle') { await sleep(pollMs); continue; }
        reloadAt = now();
        // Record intent before the external call. A timeout or malformed reply
        // may mean the reload was accepted; a later invocation must reconcile
        // its receipt rather than blindly replaying it.
        update(id, { status: 'pending', reason: 'reload result uncertain; awaiting receipt', before, reloadedAt: reloadAt, cwd: oldMeta.Cwd });
        let refused = false, errorMessage = null;
        try {
          const response = run(paseoBin, ['agent', 'reload', id, '--json'], { encoding: 'utf8' });
          if (response?.error) throw response.error;
          if (response?.status !== 0) {
            const message = String(response?.stderr ?? `exit ${response?.status}`).trim().slice(0, 240);
            // Only an explicit idle/busy refusal proves no reload was accepted.
            // A transport/CLI failure can have succeeded before losing its reply.
            refused = /\b(busy|not idle|running)\b/i.test(message);
            throw new Error(message);
          }
          const reply = JSON.parse(String(response.stdout));
          if (!reply || typeof reply !== 'object') throw new Error('malformed reload reply');
          if (reply.error || reply.success === false) {
            refused = true;
            throw new Error(`reload refused: ${JSON.stringify(reply).slice(0, 240)}`);
          }
        } catch (error) { errorMessage = error.message; }
        if (errorMessage && refused) {
          // A refusal can race with a new receipt. Give the daemon a poll and
          // reconcile any adoption before treating the refusal as retryable.
          await sleep(pollMs);
          const after = readReceipt(id, home);
          if (!(after?.startedAt >= reloadAt && provenance(after, id, repoRoot) && isAlive(after.pid) &&
              (!before || after.pid !== before.pid || after.startedAt > before.startedAt))) {
            reloadAt = null;
            update(id, { status: 'pending', reason: `reload failed or raced: ${errorMessage}`, before, cwd: oldMeta.Cwd });
            continue;
          }
        }
        update(id, { status: 'pending', reason: errorMessage ? `reload result uncertain: ${errorMessage}; awaiting receipt` :
          'reload accepted; awaiting session-bound recovery receipt', before, reloadedAt: reloadAt, cwd: oldMeta.Cwd });
        break;
      }
      if (reloadAt !== null) {
        while (now() < deadline) {
          const after = readReceipt(id, home);
          if (after?.startedAt >= reloadAt && (!before || after.pid !== before.pid || after.startedAt > before.startedAt) && provenance(after, id, repoRoot) && isAlive(after.pid)) {
            const current = jsonCommand(run, paseoBin, ['agent', 'inspect', id, '--json']);
            const sameNative = !before || (oldNative && preserve(before, after, oldNative));
            if (!identity(id, current) || current.Cwd !== oldMeta.Cwd || !sameNative || (before?.pid && before.pid === after.pid)) {
              throw new Error('post-reload agent, native session or PID continuity check failed');
            }
            update(id, { status: 'applied', pid: after.pid, previousPid: before?.pid ?? null, extensionModule: after.extensionModule, operationsModule: after.operationsModule, sessionFile: after.sessionFile, recovery: after.recovery });
            break;
          }
          await sleep(pollMs);
        }
      }
    } catch (error) {
      update(id, { status: 'failed', reason: error.message, before, reloadedAt: reloadAt, cwd: oldMeta?.Cwd });
    }
  }));
  state.status = Object.values(state.agents).some((v) => v.status === 'failed') ? 'partial-failed' :
    Object.values(state.agents).some((v) => v.status === 'pending') ? 'pending' : 'complete';
  save(path, state);
  return { ...state, journal: path };
}
