import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './config.mjs';
import { HOST_STATE_DIR, readHostMeta, callHost } from './runtime.mjs';
import { hostVersion } from './version.mjs';
let starting;
export async function ensureHost() {
  if (starting) return starting;
  starting = start().finally(() => { starting = null; });
  return starting;
}
async function start() {
  const health = async () => {
    const meta = await readHostMeta();
    if (!meta?.url) return false;
    try {
      const response = await fetch(meta.url + '/health', { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return false;
      const actual = await response.json();
      if (actual.version && actual.version !== hostVersion() && !actual.draining) await fetch(meta.url + '/upgrade', { method: 'POST', signal: AbortSignal.timeout(1000) });
      return true;
    }
    catch { return false; }
  };
  if (await health()) return;
  await mkdir(HOST_STATE_DIR, { recursive: true });
  const log = await open(join(HOST_STATE_DIR, 'host.log'), 'a');
  try {
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'host', 'host-process.mjs')], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  for (let n = 0; n < 100; n++) { if (await health()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Architect host did not become ready; inspect architect/host.log');
}
export async function hostRequest(path, payload) { await ensureHost(); return callHost(path, payload); }
