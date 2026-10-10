#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseOptions(args) {
  const values = {};
  const names = new Set(['profile', 'main-pid', 'port', 'display']);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !names.has(name) || !args[i + 1] || name in values) refuse('invalid-arguments');
    values[name] = args[i + 1];
  }
  const options = { profile: values.profile, mainPid: Number(values['main-pid']), port: Number(values.port), display: values.display, timeoutMs: 60_000 };
  if (!options.profile || !path.isAbsolute(options.profile) || !Number.isInteger(options.mainPid) || options.mainPid <= 1 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !/^:\d+(?:\.\d+)?$/.test(options.display ?? '')) refuse('invalid-arguments');
  return options;
}

function processIdentity(pid, io = fs) {
  if (io.statSync(`/proc/${pid}`).uid !== process.getuid()) refuse('process-owner-mismatch');
  const stat = io.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!/^\d+$/.test(fields[19] ?? '') || !Number.isInteger(Number(fields[1]))) refuse('process-identity-unavailable');
  return { parent: Number(fields[1]), start: fields[19] };
}

function belongsTo(pid, mainPid, io = fs) {
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const identity = processIdentity(pid, io);
    if (pid === mainPid) return true;
    pid = identity.parent;
  }
  return false;
}

function isElf(executable, io) {
  const fd = io.openSync(executable, 'r');
  try {
    const header = Buffer.alloc(4);
    return io.readSync(fd, header, 0, 4, 0) === 4 && header.toString('hex') === '7f454c46';
  } finally { io.closeSync(fd); }
}

function createRuntimeProbe(options, adapters = {}) {
  const io = adapters.fs ?? fs;
  const profile = io.realpathSync(options.profile);
  if (path.basename(profile) !== 'orca' || io.statSync(profile).uid !== process.getuid()) refuse('profile-identity-mismatch');
  const mainStart = processIdentity(options.mainPid, io).start;
  let executable;
  let client;
  let readMetadata;
  const bootstrap = () => {
    const file = path.join(profile, 'orca-runtime.json');
    const stat = io.statSync(file);
    if (stat.uid !== process.getuid() || stat.size > 131_072) refuse('bootstrap-identity-mismatch');
    const metadata = JSON.parse(io.readFileSync(file, 'utf8'));
    if (!Number.isInteger(metadata.pid) || metadata.pid <= 1 || typeof metadata.runtimeId !== 'string' || !metadata.runtimeId || !belongsTo(metadata.pid, options.mainPid, io) || processIdentity(options.mainPid, io).start !== mainStart) refuse('runtime-owner-mismatch');
    const transports = metadata.transports ?? [metadata.transport];
    const websocket = transports.find((entry) => entry?.kind === 'websocket');
    const unix = transports.find((entry) => entry?.kind === 'unix');
    if (!websocket || Number(new URL(websocket.endpoint).port) !== options.port) refuse('runtime-port-mismatch');
    if (!unix || path.dirname(unix.endpoint) !== profile || !/^o-\d+-[\w-]+\.sock$/.test(path.basename(unix.endpoint)) || Buffer.byteLength(unix.endpoint) > 107) refuse('runtime-socket-mismatch');
    return metadata;
  };
  return async (timeoutMs) => {
    const before = bootstrap();
    const liveExecutable = io.realpathSync(`/proc/${before.pid}/exe`);
    if (path.basename(liveExecutable) !== 'orca-ide' || !isElf(liveExecutable, io)) refuse('runtime-is-not-packaged-orca');
    if (executable && executable !== liveExecutable) refuse('runtime-executable-changed');
    executable = liveExecutable;
    if (!client) {
      const root = path.join(path.dirname(executable), 'resources/app.asar.unpacked/out/cli/runtime');
      const load = adapters.load ?? require;
      const { RuntimeClient } = load(path.join(root, 'client.js'));
      ({ readMetadata } = load(path.join(root, 'metadata.js')));
      client = new RuntimeClient(profile, 1000, null, null);
    }
    const metadata = readMetadata(profile);
    const response = await client.call('status.get', undefined, { timeoutMs });
    if (response.ok !== true || response.result?.runtimeId !== before.runtimeId) refuse('runtime-rpc-identity-mismatch');
    const after = bootstrap();
    if ([metadata, after].some((entry) => entry.pid !== before.pid || entry.runtimeId !== before.runtimeId)) refuse('runtime-changed');
    return { profile, executable, pid: before.pid, runtimeId: before.runtimeId, status: response.result };
  };
}

function launchEnvironment(profile, display, inherited = process.env) {
  const env = { ...inherited, DISPLAY: display, XDG_CONFIG_HOME: path.dirname(profile), ORCA_USER_DATA_PATH: profile, ORCA_BACKGROUND_LAUNCH: '1' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING', 'ORCA_DEV_USER_DATA_PATH']) delete env[key];
  return env;
}

async function launchExistingRuntime(snapshot, display, timeoutMs, onChild = () => {}) {
  const child = cp.spawn(snapshot.executable, [`--user-data-dir=${snapshot.profile}`], { env: launchEnvironment(snapshot.profile, display), stdio: 'ignore' });
  onChild(child);
  try {
    return await new Promise((resolve, reject) => {
      let expired = false;
      let kill;
      const timer = setTimeout(() => {
        expired = true;
        child.kill('SIGTERM');
        kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 200);
      }, timeoutMs);
      child.once('error', () => { clearTimeout(timer); clearTimeout(kill); reject(new Refusal('second-launch-failed')); });
      child.once('exit', (code) => { clearTimeout(timer); clearTimeout(kill); expired ? reject(new Refusal('second-launch-timeout')) : resolve(code); });
    });
  } finally { onChild(null); }
}

async function promoteDesktop(options, adapters = {}) {
  const now = adapters.now ?? (() => performance.now());
  const sleep = adapters.sleep ?? delay;
  const probe = adapters.probe ?? createRuntimeProbe(options);
  const displayReady = adapters.displayReady ?? ((timeoutMs) => cp.spawnSync('/usr/bin/xdpyinfo', ['-display', options.display], { timeout: timeoutMs, stdio: 'ignore' }).status === 0);
  const launch = adapters.launch ?? ((snapshot, timeoutMs) => launchExistingRuntime(snapshot, options.display, timeoutMs, adapters.onChild));
  const deadline = now() + options.timeoutMs;
  const remaining = () => Math.max(0, deadline - now());
  const reserve = Math.min(15_000, options.timeoutMs / 3);
  let before;
  while (remaining() > reserve) {
    try {
      const current = await probe(Math.min(1000, remaining()));
      if (current.status.desktopWindowStatus === 'blocked') refuse('desktop-activation-blocked');
      if (displayReady(Math.min(1000, remaining())) && current.status.graphStatus === 'ready' && ['openable', 'available'].includes(current.status.desktopWindowStatus)) { before = current; break; }
    } catch (error) { if (error instanceof Refusal) throw error; }
    await sleep(Math.min(500, remaining()));
  }
  if (!before) refuse('readiness-timeout');
  if (before.status.desktopWindowStatus !== 'available') {
    const code = await launch(before, Math.min(5000, remaining()));
    if (code !== 0 && code !== 3) refuse('second-launch-rejected');
  }
  while (remaining() > 0) {
    const current = await probe(Math.min(1000, remaining()));
    if (current.pid !== before.pid || current.runtimeId !== before.runtimeId) refuse('runtime-replaced');
    if (current.status.graphStatus === 'ready' && current.status.desktopWindowStatus === 'available' && Number.isInteger(current.status.authoritativeWindowId) && current.status.authoritativeWindowId > 0) return;
    await sleep(Math.min(500, remaining()));
  }
  refuse('renderer-readiness-timeout');
}

if (require.main === module) {
  let child;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child?.kill('SIGTERM'); process.exit(1); });
  Promise.resolve().then(() => promoteDesktop(parseOptions(process.argv.slice(2)), { onChild: (value) => { child = value; } })).then(
    () => console.log('Orca desktop post-start: same runtime renderer ready.'),
    (error) => { console.error(`Orca desktop post-start: ${error instanceof Refusal ? error.message : 'probe-failed'}; serve retained.`); process.exitCode = 1; }
  );
}

module.exports = { Refusal, parseOptions, createRuntimeProbe, launchEnvironment, promoteDesktop };
