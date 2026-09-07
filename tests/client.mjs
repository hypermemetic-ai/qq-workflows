import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostVersion } from '../paseo-plugin/host/version.mjs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const paseoRequire = createRequire(realpathSync(process.env.PATH.split(':').map(dir => join(dir, 'paseo')).find(existsSync)));
const serverEntry = paseoRequire.resolve('@getpaseo/server');
let root = dirname(serverEntry);
while (!root.endsWith('/@getpaseo/server') && dirname(root) !== root) root = dirname(root);
const { compilePlugin } = await import(pathToFileURL(join(root, 'dist/server/server/plugins/compiler.js')));
const { clientBundle } = await compilePlugin(resolve('paseo-plugin/index.ts'));
assert.ok(!clientBundle.includes('markdown-it'), 'Markdown parser stays on the server; Hermes renders serialized tokens');
const pluginRequire = createRequire(resolve('paseo-plugin/package.json'));
const sdk = { useWorkspace() {}, useRpc() {}, defineRpc: x => x };
const evaluate = Function(`return ${clientBundle}`)();
const module = evaluate(name => {
  if (name === '@getpaseo/plugin') return sdk;
  if (name === '@getpaseo/plugin/server') return { defineRpc: x => x };
  if (name === 'react-native') return { Pressable: 'button', ScrollView: 'div', Text: 'span', View: 'div' };
  return pluginRequire(name);
});
const registrations = new Map();
let contributeClient;
const plugin = new Proxy({}, { get: (_, name) => (...args) => {
  if (name === 'addClientSide') contributeClient = args[0];
  else registrations.set(name + ':' + (args[0]?.id ?? args[0]), args);
} });
const cleanup = module.default(plugin);
assert.equal(typeof cleanup, 'function');
assert.ok(registrations.has('addSurface:architect'));
assert.ok(registrations.has('addWorkspacePanel:ticket'));
const command = registrations.get('addCommandCenterItem:start-architect')[0];
const called = [];
await command.onSelect({ workspace: { directory: '/selected/workspace' }, rpc: async (contract, input) => called.push({ name: contract.name, input }), openPanel: id => called.push(id) });
assert.deepEqual(called, [{ name: 'architect.start', input: { cwd: '/selected/workspace', title: 'Architect' } }, 'ticket']);
cleanup();
function phoneClient() {
  const pills = new Map();
  const opened = [];
  let update, resolveList;
  const list = new Promise(resolve => { resolveList = resolve; });
  const client = {
    paseo: { agents: { subscribe(callback) { update = callback; return () => { update = null; }; }, list: () => list } },
    addComposerPill(pill) { pills.set(pill.agentId, pill); return () => pills.delete(pill.agentId); },
    openPanel(...args) { opened.push(args); },
  };
  return { client, pills, opened, update: value => update(value), load: agents => resolveList({ entries: agents.map(agent => ({ agent })) }) };
}
async function verifyPhoneClient(contribute) {
  const fixture = phoneClient();
  const dispose = contribute(fixture.client);
  const architect = { id: 'architect', provider: 'architect', labels: {}, cwd: '/project', workspaceId: 'architect-workspace' };
  const recovery = { id: 'recovery', provider: 'codex', cwd: '/project', workspaceId: 'recovery-workspace' };
  const unrelated = { id: 'other', provider: 'codex', cwd: '/other', workspaceId: 'other-workspace' };
  // An update received while the initial snapshot is loading must win.
  fixture.update({ kind: 'upsert', agent: { ...recovery, workspaceId: 'current-workspace' } });
  fixture.load([architect, recovery, unrelated]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...fixture.pills.keys()].sort(), ['architect', 'recovery']);
  fixture.pills.get('recovery').onPress();
  assert.deepEqual(fixture.opened, [['ticket', { workspaceId: 'current-workspace' }]]);
  fixture.update({ kind: 'remove', agentId: 'architect' });
  assert.equal(fixture.pills.size, 0, 'remove buttons when checkout no longer has an Architect');
  fixture.update({ kind: 'upsert', agent: architect });
  assert.equal(fixture.pills.size, 2);
  dispose();
  assert.equal(fixture.pills.size, 0, 'plugin reload disposes all buttons');
  const pending = phoneClient();
  contribute(pending.client)();
  pending.load([architect]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.pills.size, 0, 'late snapshots cannot recreate disposed buttons');
}
await verifyPhoneClient(contributeClient);
console.log('actual compiled client registers its panel and invokes workspace-scoped Start');
const fixture = mkdtempSync(join(tmpdir(), 'architect-server-bundle-'));
try {
  mkdirSync(join(fixture, 'host', 'providers'), { recursive: true });
  const nested = join(fixture, 'host', 'providers', 'model.mjs');
  writeFileSync(nested, 'export const revision = 1;');
  const original = hostVersion(join(fixture, 'host'));
  writeFileSync(nested, 'export const revision = 2;');
  assert.notEqual(hostVersion(join(fixture, 'host')), original, 'nested source changes must trigger a host upgrade');
  const entry = join(fixture, 'index.ts');
  writeFileSync(join(fixture, 'version.server.ts'), `export { hostVersion } from ${JSON.stringify(resolve('paseo-plugin/host/version.mjs'))};`);
  writeFileSync(entry, `import { hostVersion } from './version.server'; export default function contribute(plugin) { plugin.handle('version', hostVersion); }`);
  const { serverBundle } = await compilePlugin(entry);
  const bundled = Function(`return ${serverBundle}`)()(pluginRequire);
  let getVersion;
  bundled.default({ handle: (_contract, handler) => { getVersion = handler; } });
  assert.equal(getVersion(), hostVersion(), 'bundled and standalone hosts must identify the same source revision');
} finally { rmSync(fixture, { recursive: true, force: true }); }


if (process.env.PASEO_V08_SERVER_ROOT) {
  const adapterRoot = mkdtempSync(join(tmpdir(), 'architect-v08-test-'));
  try {
    const output = join(adapterRoot, 'plugin');
    execFileSync(process.execPath, [resolve('scripts/build-plugin-v08.mjs'), output]);
    const compiler = await import(pathToFileURL(join(process.env.PASEO_V08_SERVER_ROOT, 'dist/server/server/plugins/compiler.js')));
    const { clientBundle, serverBundle } = await compiler.compilePlugin({ client: join(output, 'index.client.tsx'), server: join(output, 'index.server.ts') });
    assert.ok(serverBundle.length);
    const client = Function(`return ${clientBundle}`)()(name => {
      if (name === '@getpaseo/plugin') return sdk;
      if (name === 'react-native') return { Pressable: 'button', ScrollView: 'div', Text: 'span', View: 'div' };
      return pluginRequire(name);
    });
    const registered = new Map();
    await verifyPhoneClient(capabilities => client.default(new Proxy(capabilities, { get: (target, method) => method in target ? target[method] : (...args) => registered.set(method + ':' + (args[0]?.id ?? args[0]), args) })));
    const called = [];
    await registered.get('addCommandCenterItem:start-architect')[0].onSelect({ workspace: { directory: '/fork/workspace' }, rpc: async (contract, input) => called.push({ name: contract.name, input }), openPanel: panel => called.push(panel) });
    assert.deepEqual(called, [{ name: 'architect.start', input: { cwd: '/fork/workspace', title: 'Architect' } }, 'ticket']);
    assert.ok(registered.has('addWorkspacePanel:ticket'));
    assert.deepEqual([...registered.keys()].sort(), [...registrations.keys()].sort(), 'entry registrations stay aligned across Paseo versions');
    console.log('v0.8 adapter compiles the same UI and preserves workspace-scoped Start');
  } finally { rmSync(adapterRoot, { recursive: true, force: true }); }
}
