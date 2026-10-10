'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { Refusal, parseOptions, createRuntimeProbe, launchEnvironment, promoteDesktop, failureReason } = require('./orca-desktop-after-start.cjs');

function harness(overrides = {}) {
  let elapsed = 0;
  let launches = 0;
  const before = { pid: 42, runtimeId: 'fixture', profile: '/tmp/fixture/orca', executable: '/tmp/fixture/Orca/orca-ide', status: { graphStatus: 'ready', desktopWindowStatus: 'openable', authoritativeWindowId: 0 } };
  const after = { ...before, status: { graphStatus: 'ready', desktopWindowStatus: 'available', authoritativeWindowId: 1 } };
  return {
    options: { timeoutMs: 3000, display: ':109' },
    adapters: {
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
      displayReady: () => true,
      probe: async () => launches ? after : before,
      launch: async () => { launches++; return 3; },
      ...overrides
    },
    launches: () => launches
  };
}

test('accepts stock second-instance exit3 only after same-runtime renderer readiness', async () => {
  const h = harness();
  await promoteDesktop(h.options, h.adapters);
  assert.equal(h.launches(), 1);
});

test('an unavailable display never launches and expires', async () => {
  const h = harness({ displayReady: () => false });
  await assert.rejects(promoteDesktop(h.options, h.adapters), /readiness-timeout/);
  assert.equal(h.launches(), 0);
});

test('an ordinary post-start profile creation race retries without relaxing identity checks', async () => {
  const h = harness();
  const probe = h.adapters.probe;
  delete h.adapters.probe;
  let attempts = 0;
  h.adapters.createProbe = () => {
    if (++attempts === 1) throw Object.assign(new Error('private-profile-path'), { code: 'ENOENT' });
    return probe;
  };
  await promoteDesktop(h.options, h.adapters);
  assert.equal(attempts, 2);
  assert.equal(h.launches(), 1);
  const refused = harness({ createProbe: () => { throw new Refusal('profile-identity-mismatch'); } });
  delete refused.adapters.probe;
  await assert.rejects(promoteDesktop(refused.options, refused.adapters), /profile-identity-mismatch/);
  assert.equal(refused.launches(), 0);
});

test('failure categories expose supported errno without private messages, paths or unknown codes', () => {
  const error = Object.assign(new Error('private-path-and-credential'), { code: 'MODULE_NOT_FOUND' });
  assert.equal(failureReason(error), 'probe-failed (MODULE_NOT_FOUND)');
  assert.equal(failureReason(new Refusal('readiness-timeout', { cause: error })), 'readiness-timeout (MODULE_NOT_FOUND)');
  error.code = 'private-credential';
  assert.equal(failureReason(error), 'probe-failed (unknown-error)');
});

test('a blocked promotion never launches', async () => {
  const h = harness({ probe: async () => ({ status: { desktopWindowStatus: 'blocked' } }) });
  await assert.rejects(promoteDesktop(h.options, h.adapters), /desktop-activation-blocked/);
  assert.equal(h.launches(), 0);
});

test('exit3 is not enough when a different runtime becomes available', async () => {
  let calls = 0;
  const h = harness();
  const original = h.adapters.probe;
  h.adapters.probe = async (...args) => ({ ...await original(...args), runtimeId: calls++ === 0 ? 'fixture' : 'replacement' });
  await assert.rejects(promoteDesktop(h.options, h.adapters), /runtime-replaced/);
});

test('an already ready renderer needs no second app launch', async () => {
  const h = harness({ probe: async () => ({ pid: 42, runtimeId: 'fixture', status: { graphStatus: 'ready', desktopWindowStatus: 'available', authoritativeWindowId: 1 } }) });
  await promoteDesktop(h.options, h.adapters);
  assert.equal(h.launches(), 0);
});

test('a successful launcher cannot hide missing authoritative renderer ownership', async () => {
  const h = harness({ probe: async () => ({ pid: 42, runtimeId: 'fixture', status: { graphStatus: 'ready', desktopWindowStatus: 'openable', authoritativeWindowId: 0 } }) });
  await assert.rejects(promoteDesktop(h.options, h.adapters), /renderer-readiness-timeout/);
});

test('CLI pins a private display and rejects incomplete or duplicate identity arguments', () => {
  assert.deepEqual(parseOptions(['--profile', '/tmp/fixture/orca', '--main-pid', '41', '--port', '6778', '--display', ':109']), { profile: '/tmp/fixture/orca', mainPid: 41, port: 6778, display: ':109', timeoutMs: 60000 });
  assert.throws(() => parseOptions(['--profile', '/tmp/fixture/orca']), /invalid-arguments/);
  assert.throws(() => parseOptions(['--display', ':109', '--display', ':99']), /invalid-arguments/);
  const env = launchEnvironment('/tmp/fixture/orca', ':109', { ELECTRON_RUN_AS_NODE: '1', ORCA_ENVIRONMENT: 'other', ORCA_PAIRING_CODE: 'private', XDG_CONFIG_HOME: '/wrong', HOME: '/preserved-home' });
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/fixture');
  assert.equal(env.ORCA_USER_DATA_PATH, '/tmp/fixture/orca');
  assert.equal(env.DISPLAY, ':109');
  assert.equal(env.HOME, '/preserved-home');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.ORCA_PAIRING_CODE, undefined);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-post-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'orca');
  fs.mkdirSync(profile);
  const executable = path.join(root, 'Orca', 'orca-ide');
  fs.mkdirSync(path.dirname(executable));
  fs.writeFileSync(executable, Buffer.from('7f454c46', 'hex'));
  const metadata = { pid: 42, runtimeId: 'fixture', authToken: 'private-token-never-log', transports: [{ kind: 'unix', endpoint: path.join(profile, 'o-42-fixt.sock') }, { kind: 'websocket', endpoint: 'ws://127.0.0.1:6778' }] };
  const write = () => fs.writeFileSync(path.join(profile, 'orca-runtime.json'), JSON.stringify(metadata));
  write();
  const io = {
    ...fs,
    statSync: (p) => p.startsWith('/proc/') ? { uid: process.getuid() } : fs.statSync(p),
    realpathSync: (p) => p === '/proc/42/exe' ? executable : fs.realpathSync(p),
    readFileSync: (p, ...args) => {
      if (!p.startsWith('/proc/')) return fs.readFileSync(p, ...args);
      const fields = Array(21).fill('0'); fields[0] = 'S'; fields[1] = p.includes('/42/') ? '41' : '1'; fields[19] = '100';
      return `42 (fixture) ${fields.join(' ')}`;
    }
  };
  let resultId = 'fixture';
  const load = (p) => p.endsWith('client.js') ? { RuntimeClient: class {
    constructor(...args) { assert.deepEqual(args, [profile, 1000, null, null]); }
    async call(method) { assert.equal(method, 'status.get'); return { ok: true, result: { runtimeId: resultId } }; }
  } } : { readMetadata: () => JSON.parse(fs.readFileSync(path.join(profile, 'orca-runtime.json'), 'utf8')) };
  return { profile, metadata, write, io, load, setResultId: (id) => { resultId = id; } };
}

test('actual bootstrap fixture requires owned PID lineage, socket/profile and matching RPC identity', async (t) => {
  const f = fixture(t);
  const probe = createRuntimeProbe({ profile: f.profile, mainPid: 41, port: 6778 }, { fs: f.io, load: f.load });
  assert.equal((await probe(1000)).pid, 42);
  f.setResultId('other-runtime');
  await assert.rejects(probe(1000), /runtime-rpc-identity-mismatch/);
  f.setResultId('fixture');
  f.metadata.transports[0].endpoint = '/different/orca/o-42-fixt.sock'; f.write();
  await assert.rejects(probe(1000), /runtime-socket-mismatch/);
  f.metadata.pid = 40; f.write();
  await assert.rejects(probe(1000), /runtime-owner-mismatch/);
});

test('helper failure logs no input or credentials and leaves its running service owner alive', async (t) => {
  const sentinel = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => sentinel.kill('SIGTERM'));
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'orca-desktop-after-start.cjs'), '--profile', 'private-token'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid-arguments; serve retained/);
  assert.equal(result.stderr.includes('private-token'), false);
  assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
  const unit = fs.readFileSync(path.join(__dirname, '../systemd/orca-desktop-after-start.conf'), 'utf8');
  assert.match(unit, /^ExecStartPost=-\/usr\/bin\/timeout .*65s /m);
  assert.doesNotMatch(unit, /^ExecStart=|^Restart=|^KillMode=/m);
});

test('systemd accepts the ignored-failure post-start template without replacing ExecStart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'orca-post-start-review.service');
  const dropin = fs.readFileSync(path.join(__dirname, '../systemd/orca-desktop-after-start.conf'), 'utf8');
  fs.writeFileSync(file, `[Unit]\nDescription=Unstarted template verification\n[Service]\nType=simple\nExecStart=/usr/bin/sleep 60\n${dropin}`);
  const result = cp.spawnSync('/usr/bin/systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr?.slice(0, 512));
});
