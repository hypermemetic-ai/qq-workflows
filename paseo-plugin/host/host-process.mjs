#!/usr/bin/env node
import { createRuntime } from './runtime.mjs';
import { STATE_DIR } from './config.mjs';
import { readHostMeta } from './host-client.mjs';
import { join } from 'node:path';
const runtime = createRuntime({ storePath: join(STATE_DIR, 'state.sqlite'), onIdleUpgrade: async () => { await runtime.close(); process.exit(0); } });
const acquired = runtime.store.transaction(() => {
  const prior = runtime.store.get('host', 'lease');
  if (prior?.pid) { try { process.kill(prior.pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  runtime.store.put('host', 'lease', { pid: process.pid });
  return true;
});
if (!acquired) process.exit(0);
// Surviving children retain this endpoint across a host crash.
const previous = await readHostMeta();
await runtime.listen(previous?.url ? Number(new URL(previous.url).port) : 0);
await runtime.reconcile();
process.on('SIGTERM', async () => { await runtime.close({ terminal: true }); process.exit(0); });
