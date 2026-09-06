import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_ROOT, STATE_DIR, HOST_META_PATH } from './config.mjs';
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
  await mkdir(STATE_DIR, { recursive: true });
  const log = await open(join(STATE_DIR, 'host.log'), 'a');
  try {
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'host', 'host-process.mjs')], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  for (let n = 0; n < 100; n++) { if (await health()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Architect host did not become ready; inspect architect/host.log');
}
export async function hostRequest(path, payload) { await ensureHost(); return callHost(path, payload); }

export async function readHostMeta() {
  try {
    return JSON.parse(await readFile(HOST_META_PATH, "utf8"));
  } catch {
    return null;
  }
}

export async function callHost(path, payload, { signal, hostUrl } = {}) {
  const meta = { url: hostUrl ?? process.env.ARCHITECT_HOST ?? (await readHostMeta())?.url };
  if (!meta?.url) throw new Error("architect host is not listening");
  const response = await fetch(`${meta.url}${path}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const json = await response.json();
  if (!response.ok) throw Object.assign(new Error(json.error ?? JSON.stringify(json)), { failureClass: json.failureClass, attempts: json.attempts, exhausted: json.exhausted });
  return json;
}
