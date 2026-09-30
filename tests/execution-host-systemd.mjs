// Focused launch-boundary gates and an opt-in disposable user-systemd proof.
// No production units, provider processes or model inference are touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executionHostScope, verifyExecutionHostProcess, spawnExecutionHostProcess } from '../workflow/execution-host-launcher.mjs';
import { createJob, readJob, writeJob, processFingerprint } from '../workflow/jobs.mjs';
import { recordManagedExecution } from '../workflow/execution-authority.mjs';
import { cancelExecutionHost } from '../workflow/execution-supervisor.mjs';
import { readReport } from '../workflow/reports.mjs';

const hostPath = fileURLToPath(new URL('../workflow/execution-host.mjs', import.meta.url));
const launcherURL = new URL('../workflow/execution-host-launcher.mjs', import.meta.url).href;
const jobsURL = new URL('../workflow/jobs.mjs', import.meta.url).href;
const source = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/paseo.service\n';
const scope = executionHostScope(source);
assert.match(scope, /^qq-execution-.*\.scope$/);
for (const value of ['', '0::/ordinary.scope', '0::/not-paseo.service', '0::/paseo.service-backup']) assert.equal(executionHostScope(value), null);
assert.ok(executionHostScope(source.trim() + '/nested'));
const requestPath = '/fixture/request.json';
const identity = [process.execPath, hostPath, requestPath, ''].join('\0');
const observed = { pid: 42, requestPath, scope };
const proc = (cmdline, cgroup) => path => path.endsWith('/cmdline') ? cmdline : cgroup;
verifyExecutionHostProcess(observed, proc(identity, `0::/app.slice/${scope}\n`));
for (const cgroup of [source, '0::/other.scope', `0::/paseo.service/${scope}`]) {
  assert.throws(() => verifyExecutionHostProcess(observed, proc(identity, cgroup)), /independent systemd scope/);
}
for (const cmdline of [identity.replace(requestPath, '/forged/request'), identity.replace(hostPath, '/forged/host'), identity.replace(process.execPath, '/forged/node')]) {
  assert.throws(() => verifyExecutionHostProcess(observed, proc(cmdline, `0::/${scope}`)), /identity changed/);
}
assert.throws(() => verifyExecutionHostProcess(observed, () => { throw new Error('missing process'); }), /missing process/);
console.log('PASS scope selection, observed executable/host/request PID gates, actual scope membership and fail-closed proc reads');

const root = mkdtempSync(join(tmpdir(), 'qq-host-systemd-'));
const stateDir = join(root, 'state');
const owner = 'fixture-owner';
function request(id) {
  const dir = join(stateDir, 'execution-hosts', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const requestPath = join(dir, 'request.json');
  const launchId = randomUUID();
  const phaseId = 'fixture-phase';
  createJob({ stateDir, id, role: 'execution', kind: 'open', workflow: { sessionKey: owner, root }, cwd: root });
  recordManagedExecution({ stateDir, executionId: id, kind: 'open', phaseId, root, owner,
    constraints: 'Disposable deterministic cgroup survival proof; no model inference.', launchId, requestPath });
  writeJob(stateDir, { ...readJob(stateDir, id), phaseId, executionHost: { launchId, requestPath, authority: true } });
  writeFileSync(requestPath, JSON.stringify({ schema: 1, stateDir, jobId: id, root, owner, kind: 'open', phaseId, launchId }), { mode: 0o600 });
  return { requestPath, logPath: join(dir, 'host.log') };
}
// Invalid user-manager transport cannot silently fall back to an unsafe fork.
const unavailable = request('unavailable');
const log = openSync(unavailable.logPath, 'a', 0o600);
try {
  await assert.rejects(spawnExecutionHostProcess({ ...unavailable, root, log,
    env: { ...process.env, XDG_RUNTIME_DIR: '/nonexistent/qq-test-runtime', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/qq-test-bus' } },
  { sourceCgroup: () => source }), /launcher failed/);
} finally { closeSync(log); }
assert.equal(readJob(stateDir, 'unavailable').process, null);
assert.equal(readJob(stateDir, 'unavailable').terminal, null);
assert.match(readFileSync(unavailable.logPath, 'utf8'), /Failed to connect to bus/);
console.log('PASS unavailable required user-manager boundary: no PID binding, pipeline result or unsafe fallback');

if (process.env.QQ_TEST_USER_SYSTEMD === '1') {
  const unit = `qq-boundary-origin-${randomUUID()}.service`;
  const systemctl = (...args) => {
    const r = spawnSync('/usr/bin/systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const wait = async predicate => {
    const until = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > until) throw new Error('fixture timed out: ' + root);
      await new Promise(done => setTimeout(done, 30));
    }
  };
  const pipelinePath = join(root, 'pipeline.mjs');
  const workerPath = join(root, 'worker.json');
  const finishPath = join(root, 'finish');
  writeFileSync(pipelinePath, `import {spawn} from 'node:child_process';
import {writeFileSync,existsSync} from 'node:fs';
let child, cancelled=false;
export async function dispatchExecution(){
 child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 writeFileSync(${JSON.stringify(workerPath)},JSON.stringify({pid:child.pid,host:process.pid,cwd:process.cwd(),secret:process.env.QQ_FIXTURE_SECRET}));
 return {id:'deterministic'};
}
export async function cancelExecution(){cancelled=true; child?.kill('SIGTERM');}
export async function checkExecution(){
 if(cancelled)return {status:'cancelled'};
 if(existsSync(${JSON.stringify(finishPath)})){child.kill('SIGTERM');return {status:'completed',phase:'completed',result:{evidence:'child survived origin stop'}};}
 return {status:'running',phase:'implementing'};
}
`);
  const loaderPath = join(root, 'loader.mjs');
  writeFileSync(loaderPath, `export async function resolve(s,c,next){if(c.parentURL===${JSON.stringify(pathToFileURL(hostPath).href)}&&s==='../bin/mcp-server.mjs')return {url:${JSON.stringify(pathToFileURL(pipelinePath).href)},shortCircuit:true};return next(s,c);}`);
  const registerPath = join(root, 'register.mjs');
  writeFileSync(registerPath, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loaderPath).href)});`);
  const good = request('survive');
  const ordinary = request('ordinary-unbound');
  const readyPath = join(root, 'ready.json');
  const driverPath = join(root, 'origin.mjs');
  writeFileSync(driverPath, `import {openSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnExecutionHostProcess} from ${JSON.stringify(launcherURL)};
import {readJob,writeJob,processFingerprint} from ${JSON.stringify(jobsURL)};
const log=openSync(${JSON.stringify(good.logPath)},'a',0o600);
// Only substitute the origin NAME for detection; actual host membership is
// verified by production code against real /proc and the created scope.
const cgroup=readFileSync('/proc/self/cgroup','utf8');
if(!cgroup.includes(${JSON.stringify(unit)}))throw new Error('not in disposable origin');
const ordinaryLog=openSync(${JSON.stringify(ordinary.logPath)},'a',0o600);
const ordinary=await spawnExecutionHostProcess({requestPath:${JSON.stringify(ordinary.requestPath)},root:${JSON.stringify(root)},log:ordinaryLog,env:process.env});
closeSync(ordinaryLog);
const host=await spawnExecutionHostProcess({requestPath:${JSON.stringify(good.requestPath)},root:${JSON.stringify(root)},log,
 env:{...process.env,NODE_OPTIONS:${JSON.stringify('--import ' + registerPath)},QQ_FIXTURE_SECRET:'private fixture value'}},
 {sourceCgroup:()=>cgroup.replace(${JSON.stringify(unit)},'paseo.service')});
closeSync(log);
writeJob(${JSON.stringify(stateDir)},{...readJob(${JSON.stringify(stateDir)},'survive'),process:{pid:host.pid,spawnedAt:Date.now(),fingerprint:processFingerprint({pid:host.pid})}});
writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({pid:host.pid,ordinary:ordinary.pid,origin:process.pid,cgroup}));
setInterval(()=>{},1000);
`);
  let hostIdentity, workerIdentity;
  try {
    const start = spawnSync('/usr/bin/systemd-run', ['--user', '--quiet', '--collect', '--service-type=exec', `--unit=${unit}`,
      '--property=Restart=no', '--', process.execPath, driverPath], { encoding: 'utf8', timeout: 10000 });
    assert.equal(start.status, 0, start.stderr);
    await wait(() => existsSync(readyPath) && existsSync(workerPath));
    const ready = JSON.parse(readFileSync(readyPath));
    const worker = JSON.parse(readFileSync(workerPath));
    hostIdentity = { pid: ready.pid, fingerprint: processFingerprint({ pid: ready.pid }) };
    workerIdentity = { pid: worker.pid, fingerprint: processFingerprint({ pid: worker.pid }) };
    assert.equal(worker.host, ready.pid);
    assert.equal(worker.cwd, root);
    assert.equal(worker.secret, 'private fixture value', 'environment survives without unit properties');
    const hostCgroup = readFileSync(`/proc/${ready.pid}/cgroup`, 'utf8');
    assert.match(hostCgroup, /qq-execution-.*\.scope/);
    assert.ok(!hostCgroup.includes(unit));
    assert.equal(readFileSync(`/proc/${worker.pid}/cgroup`, 'utf8'), hostCgroup);
    assert.equal(readFileSync(`/proc/${ready.ordinary}/cgroup`, 'utf8'), ready.cgroup,
      'ordinary non-Paseo launch retains the direct bridge, without requiring a user-systemd boundary');
    assert.equal(readJob(stateDir, 'ordinary-unbound').process, null, 'ordinary fixture remains gated');
    systemctl('stop', unit); // ONLY this test's unique disposable origin
    assert.equal(processFingerprint({ pid: ready.origin }), null);
    assert.equal(processFingerprint({ pid: ready.ordinary }), null, 'disposable origin stop kills its own unbound control');
    assert.deepEqual(processFingerprint({ pid: ready.pid }), hostIdentity.fingerprint);
    assert.deepEqual(processFingerprint({ pid: worker.pid }), workerIdentity.fingerprint);
    writeFileSync(finishPath, 'finish');
    await wait(() => readJob(stateDir, 'survive').terminal);
    const result = readJob(stateDir, 'survive');
    assert.equal(result.status, 'completed');
    assert.match(readReport(stateDir, result.terminal.reportId).text, /child survived origin stop/);
    console.log('PASS ordinary direct bridge retains origin membership; accepted scoped host and pipeline child survive disposable origin stop; cwd/env and durable result preserved');

    // The same scope mechanism leaves existing intent-first cancellation intact.
    unlinkSync(finishPath);
    const cancelling = request('cancel');
    const fd = openSync(cancelling.logPath, 'a', 0o600);
    let cancelHost;
    try { cancelHost = await spawnExecutionHostProcess({ ...cancelling, root, log: fd,
      env: { ...process.env, NODE_OPTIONS: '--import ' + registerPath } }, { sourceCgroup: () => source }); }
    finally { closeSync(fd); }
    writeJob(stateDir, { ...readJob(stateDir, 'cancel'), process: { pid: cancelHost.pid, fingerprint: processFingerprint({ pid: cancelHost.pid }) } });
    await wait(() => JSON.parse(readFileSync(workerPath)).host === cancelHost.pid);
    const cancelWorker = JSON.parse(readFileSync(workerPath));
    hostIdentity = { pid: cancelHost.pid, fingerprint: processFingerprint({ pid: cancelHost.pid }) };
    workerIdentity = { pid: cancelWorker.pid, fingerprint: processFingerprint({ pid: cancelWorker.pid }) };
    const outcome = cancelExecutionHost({ stateDir, jobId: 'cancel', by: owner });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.signalled, true);
    await wait(() => !processFingerprint({ pid: cancelHost.pid }));
    assert.equal(readJob(stateDir, 'cancel').status, 'cancelled');
    assert.equal(cancelExecutionHost({ stateDir, jobId: 'cancel', by: owner }).signalled, false);
    console.log('PASS scoped host respects authoritative cancellation before signal, truthful cancelled result and idempotent repeat');
  } finally {
    // Fingerprint guards before signalling even our own disposable fixture.
    for (const identity of [hostIdentity, workerIdentity]) {
      if (identity?.fingerprint && JSON.stringify(processFingerprint({ pid: identity.pid })) === JSON.stringify(identity.fingerprint)) {
        try { process.kill(identity.pid, 'SIGTERM'); } catch {}
      }
    }
    spawnSync('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 10000 });
  }
}
