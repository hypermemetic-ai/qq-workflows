#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const homeIndex = args.indexOf('--codex-home');
const codexHome = homeIndex < 0 ? resolve(homedir(), '.t3/codex') : args[homeIndex + 1];
if (homeIndex >= 0) args.splice(homeIndex, 2);
if (!codexHome || args.includes('--help')) {
  console.log('Usage: node scripts/verify-t3-openspec.mjs [--codex-home PATH] [WORKSPACE ...]');
  process.exit(codexHome ? 0 : 1);
}
const workspaces = args.length ? args.map(p => resolve(p)) : [process.cwd()];
const expected = [
  't3-openspec-architect', 'openspec-explore', 'openspec-propose',
  'openspec-update-change', 'openspec-apply-change', 'openspec-sync-specs',
  'openspec-archive-change',
];
const child = spawn('codex', ['app-server'], {
  env: { ...process.env, CODEX_HOME: codexHome },
  cwd: workspaces[0], stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = '', diagnostic = '', nextId = 0;
const pending = new Map();
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
    else entry.resolve(message.result);
  }
});
function failPending(error) {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
  pending.clear();
}
child.on('error', failPending);
child.on('exit', code => failPending(new Error(`codex app-server exited (${code})`)));
function request(method, params) {
  return new Promise((resolveRequest, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, { method, resolve: resolveRequest, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await request('initialize', {
    clientInfo: { name: 't3-openspec-verification', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const account = await request('account/read', { refreshToken: false });
  if (!account.account) throw new Error('The dedicated profile has no authenticated Codex account');
  console.log(`Authenticated account type: ${account.account.type ?? 'present'}`);
  const response = await request('skills/list', { cwds: workspaces, forceReload: true });
  for (const workspace of workspaces) {
    const entry = response.data.find(x => resolve(x.cwd) === workspace);
    if (!entry) throw new Error(`skills/list omitted ${workspace}`);
    const enabled = new Set(entry.skills.filter(x => x.enabled !== false).map(x => x.name));
    const missing = expected.filter(name => !enabled.has(name));
    if (missing.length) throw new Error(`${workspace}: missing skills ${missing.join(', ')}`);
    if (entry.errors?.length) throw new Error(`${workspace}: ${JSON.stringify(entry.errors).slice(0, 1200)}`);
    console.log(`Verified seven workflow skills: ${workspace}`);
  }
  const { config } = await request('config/read', { includeLayers: false });
  if (config.approval_policy !== 'never' || config.sandbox_mode !== 'danger-full-access') {
    throw new Error('Dedicated profile permissions do not match full implementation access');
  }
  if (config.features?.multi_agent !== true || config.agents?.enabled !== true) {
    throw new Error('Dedicated profile does not explicitly enable native delegation');
  }
  console.log('Verified full implementation access and native delegation. No model turn was started.');
} catch (error) {
  console.error(error.message);
  // Startup diagnostics can contain account/config data. Do not dump them.
  if (diagnostic.includes('Error loading config')) console.error('Codex reported a configuration load error.');
  process.exitCode = 1;
} finally {
  failPending(new Error('Verification finished'));
  child.stdin.end();
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
  killTimer.unref();
}
