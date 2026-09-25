// Focused test evidence for Pi managed OPEN executions. The runner configuration
// is project-owned, but agents supply only relative test paths, never commands.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export const TEST_BINDING_ENV = 'QQ_MANAGED_TEST_BINDING';
const digest = value => createHash('sha256').update(value).digest('hex');
const pathFor = (stateDir, id) => join(stateDir, 'managed-tests', `${id}.json`);
const read = (stateDir, id) => JSON.parse(readFileSync(pathFor(stateDir, id), 'utf8'));
function save(stateDir, id, state) {
  const path = pathFor(stateDir, id), tmp = `${path}.${randomUUID()}.tmp`;
  mkdirSync(join(stateDir, 'managed-tests'), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return state;
}
export function testingPlan(ticket) {
  const section = /^## Testing plan\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(ticket)?.[1] ?? '';
  const explicit = /^Broad regression:[ \t]*(none|required)[ \t]*(?:\r?\nCommand:[ \t]*([^\r\n]+))?/mi.exec(section);
  // The approved phase ticket predates the structured plan field. Do not
  // extrapolate its project command to unrelated tickets.
  const approved = /requires broad source regression for this project with the authorized workflow-owned command `npm test`/.test(ticket) || /broad source regression command for this project is `npm test`/.test(section);
  if (!explicit && !approved) throw new Error('OPEN testing plan must explicitly declare Broad regression: none or required and a command when required');
  const command = approved ? 'npm test' : explicit[1].toLowerCase() === 'required' ? explicit[2]?.trim() : null;
  if ((approved || explicit?.[1].toLowerCase() === 'required') && !command) throw new Error('required broad regression needs an authorized command');
  return { required: Boolean(command), command };
}
export function initManagedTesting({ stateDir, id, root, worktree, ticket }) {
  const plan = testingPlan(ticket);
  const authority = admitRunner(worktree);
  const state = { schema: 1, root, worktree, stateDir, plan, authority, selection: null,
    active: null, runs: [], checkpoints: [], reviews: [], round: 0,
    totals: {focusedTargets:[],focusedLaunches:0,focusedElapsedMs:0,checkpointLaunches:0,checkpointElapsedMs:0} };
  return save(stateDir, id, state);
}
export function managedTestingView(stateDir, id) { return read(stateDir, id); }
export function activateTestingSeat({ stateDir, id, role, jobId, attemptId }) {
  const state = read(stateDir, id);
  config(state);
  state.active = { role, jobId, attemptId };
  save(stateDir, id, state);
  return JSON.stringify({ stateDir, id, worktree: state.worktree, role, jobId, attemptId });
}
function bound(binding, roles) {
  if (!binding || !roles.includes(binding.role)) throw new Error('managed testing role not admitted');
  const state = read(binding.stateDir, binding.id);
  if (JSON.stringify(state.active) !== JSON.stringify({ role: binding.role, jobId: binding.jobId, attemptId: binding.attemptId }) || state.worktree !== binding.worktree)
    throw new Error('managed testing attempt/worktree is no longer active');
  return state;
}
const runnerPath = '.architect/test-runner.json';
const hasKeys = (data, keys) => Object.keys(data).sort().join(',') === [...keys].sort().join(',');
function parseRunner(bytes) {
  let data;
  try { data = JSON.parse(bytes); } catch { throw new Error('unsupported project focused-test runner configuration'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      typeof data.directory !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(data.directory))
    throw new Error('unsupported project focused-test runner configuration');
  if (data.schema === 1) {
    if (!hasKeys(data,['schema','command','args','directory','extension']) || data.command !== 'node' ||
        !Array.isArray(data.args) || data.args.length !== 0 || typeof data.extension !== 'string' || !/^\.[a-zA-Z0-9]+$/.test(data.extension))
      throw new Error('unsupported project focused-test runner configuration');
  } else if (data.schema === 2) {
    if (!hasKeys(data,['schema','profile','directory','extension']) || data.profile !== 'node-tsx-test' || data.extension !== '.test.ts')
      throw new Error('unsupported project focused-test runner configuration');
  } else throw new Error('unsupported project focused-test runner configuration');
  return data;
}
function gitRunner(worktree, args) {
  return execFileSync('git',args,{cwd:worktree,stdio:['ignore','pipe','pipe']});
}
function runnerBytes(worktree) {
  const path = join(worktree,runnerPath);
  try {
    if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(realpathSync(worktree) + sep)) throw new Error('not a regular contained file');
    return readFileSync(path);
  } catch { throw new Error('missing or invalid project focused-test runner configuration'); }
}
function admitRunner(worktree) {
  let base, committed;
  try {
    base = gitRunner(worktree,['rev-parse','HEAD']).toString().trim();
    // HEAD is the approved execution base, not a worker-created staged file.
    const mode = gitRunner(worktree,['ls-tree',base,'--',runnerPath]).toString();
    if (!mode.startsWith('100644 blob ') && !mode.startsWith('100755 blob ')) throw new Error('not a committed regular file');
    committed = gitRunner(worktree,['show',`${base}:${runnerPath}`]);
    if (gitRunner(worktree,['status','--porcelain','--',runnerPath]).toString().trim()) throw new Error('dirty runner');
  } catch { throw new Error('project focused-test runner configuration must be committed and clean at admission'); }
  const bytes = runnerBytes(worktree);
  if (!bytes.equals(committed)) throw new Error('project focused-test runner configuration differs from committed authority');
  parseRunner(bytes);
  return { base, digest: digest(bytes) };
}
function config(state) {
  if (!state.authority) throw new Error('missing admitted focused-test runner authority');
  const bytes = runnerBytes(state.worktree);
  try {
    if (digest(bytes) !== state.authority.digest || gitRunner(state.worktree,['status','--porcelain','--',runnerPath]).toString().trim())
      throw new Error('drift');
  } catch { throw new Error('focused-test runner configuration/profile drift from admitted authority'); }
  return parseRunner(bytes);
}
export function currentManagedRunner(state) {
  try { config(state); return true; } catch { return false; }
}
function targetPath(state, cfg, target) {
  if (typeof target !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(target) || target.includes('..') || target.startsWith('/') ||
      target.split('/').some(part => !part || part === '.' || /^run\.(?:mjs|test\.ts)$/.test(part))) throw new Error(`invalid focused target: ${target}`);
  const dir = resolve(state.worktree, cfg.directory), path = resolve(dir, target);
  if (!realpathSync(dir).startsWith(realpathSync(state.worktree) + sep)) throw new Error('test directory escapes bound worktree');
  if (!path.startsWith(dir + sep) || !target.endsWith(cfg.extension) || !existsSync(path) || !realpathSync(path).startsWith(realpathSync(dir) + sep) ||
      !realpathSync(path).endsWith(cfg.extension) || !statSync(path).isFile() ||
      /^run\.(?:mjs|test\.ts)$/.test(realpathSync(path).split(sep).at(-1))) throw new Error(`not an existing focused test: ${target}`);
  // Deny symlink escapes and the project's broad entrypoint even when nested.
  const rel = relative(state.worktree, path);
  if (rel.split(sep).includes('run.mjs')) throw new Error('broad entrypoint is not a focused target');
  return path;
}
export function selectManagedTests(binding, { targets, rationale }) {
  const state = bound(binding, ['test_owner', 'reviewer']);
  if (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length || typeof rationale !== 'string' || !rationale.trim()) throw new Error('explicit distinct targets and rationale required');
  const cfg = config(state);
  for (const target of targets) targetPath(state, cfg, target);
  if (binding.role === 'reviewer' && (!state.selection || state.selection.targets.some(t => !targets.includes(t)))) throw new Error('reviewer may only widen an established selection');
  state.selection = { targets, rationale, by: binding.role, authority: state.authority.digest, at: Date.now() };
  state.totals.focusedTargets = [...new Set([...state.totals.focusedTargets,...targets])];
  save(binding.stateDir, binding.id, state);
  return state.selection;
}
export function workingState({ worktree, stateDir }) {
  // Include untracked retained tests and all edited files, but not workflow
  // records: recording evidence must not itself invalidate that evidence.
  // Use the bound state directory rather than assuming a fixed layout.
  const excludedState = resolve(stateDir);
  if (excludedState === resolve(worktree)) throw new Error('workflow state directory cannot be the worktree');
  const parts = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.qq-workflows') continue;
      const path = join(dir, entry.name);
      if (resolve(path) === excludedState) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) parts.push(`${relative(worktree,path)}\0file\0${digest(readFileSync(path))}`);
      else if (entry.isSymbolicLink()) parts.push(`${relative(worktree,path)}\0link\0${readlinkSync(path)}`);
    }
  }
  visit(worktree);
  return digest(parts.join('\n'));
}
function launch(command, args, cwd, timeoutMs, signal, focused = false) {
  return new Promise(done => {
    const start = Date.now();
    if (signal?.aborted) return done({ status: 'cancelled', elapsedMs: 0 });
    const testState = mkdtempSync(join(tmpdir(),'qq-focused-test-'));
    const env = { ...process.env, QQ_WORKFLOW_STATE_DIR:testState };
    for (const key of ['QQ_MANAGED_TEST_BINDING','QQ_WORKFLOW_COMMUNICATION','QQ_WORKER_RESULT_BINDING',
      'QQ_WORKER_CONFIG_FILE','QQ_WORKFLOW_SESSION_ID','QQ_RUNNER_ID','QQ_SUBAGENT_BIN','QQ_RUNNER_BIN']) delete env[key];
    if (focused) for (const key of ['NODE_OPTIONS','NODE_PATH']) delete env[key];
    let child, timer, killTimer, finished = false, timedOut = false, cancelled = false, output = '';
    const finish = (status, extra = {}) => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener?.('abort', abort);
      try { rmSync(testState,{recursive:true,force:true}); } catch {} done({ status, elapsedMs: Date.now()-start, output: output.slice(-4000), ...extra }); };
    const terminate = () => { child?.kill('SIGTERM'); killTimer = setTimeout(() => child?.kill('SIGKILL'), 2000); };
    const abort = () => { cancelled = true; terminate(); };
    try { child = spawn(command, args, { cwd, env, stdio: ['ignore','pipe','pipe'] }); }
    catch (error) { return finish('incomplete', { error: error.message }); }
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener?.('abort', abort, { once:true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.on('error', error => finish('incomplete', { error: error.message }));
    child.on('close', (code, sig) => finish(cancelled ? 'cancelled' : timedOut ? 'timeout' : sig || code === null ? 'incomplete' : code === 0 ? 'pass' : 'fail', { code, signal: sig }));
  });
}
export async function runManagedTests(binding, { signal, expectedRed = null } = {}) {
  const state = bound(binding, ['test_owner','implementer','reviewer']);
  const cfg = config(state);
  if (!state.selection?.targets?.length) {
    const record = {role:binding.role,round:state.round,selection:[],authority:state.authority.digest,hash:workingState(state),outcomes:[],status:'no-tests',at:Date.now()};
    state.runs.push(record); save(binding.stateDir,binding.id,state); return record;
  }
  if (expectedRed !== null && (binding.role !== 'test_owner' || state.round !== 0 || typeof expectedRed !== 'string' || !expectedRed.trim()))
    throw new Error('expected-red reason is available only to the initial test owner');
  if (state.selection.authority !== state.authority.digest) throw new Error('focused selection has stale runner authority');
  const hash = workingState(state), outcomes = [];
  for (const target of state.selection.targets) {
    const file = targetPath(state, cfg, target);
    const args = cfg.schema === 2 ? ['--import','tsx','--test',file] : [...cfg.args,file];
    outcomes.push({ target, ...await launch('node', args, state.worktree, 120000, signal, true) });
    config(state); // Fail closed if the profile changed while a child was running.
    if (signal?.aborted) break;
  }
  const status = outcomes.length !== state.selection.targets.length || outcomes.some(o => ['incomplete','timeout','cancelled'].includes(o.status)) ? 'incomplete'
    : outcomes.some(o => o.status === 'fail') ? expectedRed ? 'expected-red' : 'fail' : 'pass';
  const record = { role: binding.role, round: state.round, selection: [...state.selection.targets], authority: state.authority.digest, hash, outcomes, status,
    ...(expectedRed ? {expectedRed} : {}), at: Date.now() };
  const fresh = bound(binding, ['test_owner','implementer','reviewer']);
  config(fresh);
  if (workingState(fresh) !== hash || JSON.stringify(fresh.selection?.targets) !== JSON.stringify(record.selection))
    record.status = 'incomplete';
  fresh.runs.push(record);
  fresh.totals.focusedLaunches += outcomes.length;
  fresh.totals.focusedElapsedMs += outcomes.reduce((sum,o) => sum + o.elapsedMs,0);
  save(binding.stateDir,binding.id,fresh);
  return record;
}
export function focusedPass(state) {
  const latest = [...state.runs].reverse().find(r => r.role === 'reviewer');
  return Boolean(currentManagedRunner(state) && state.selection?.authority === state.authority.digest &&
    latest && latest.authority === state.authority.digest && latest.status === 'pass' && latest.hash === workingState(state) &&
    JSON.stringify(latest.selection) === JSON.stringify(state.selection?.targets) && latest.round === state.round);
}
export async function runManagedCheckpoint(binding, { signal } = {}) {
  const state = bound(binding, ['reviewer']);
  if (!state.plan.required) return { status:'not-required' };
  if (!focusedPass(state) || !state.reviews.some(r => r.round === state.round && r.verdict === 'READY' && r.authority === state.authority.digest && r.hash === workingState(state) && JSON.stringify(r.selection) === JSON.stringify(state.selection.targets)))
    throw new Error('current focused PASS and reviewer no-repair assessment required before checkpoint');
  if (state.checkpoints.some(c => c.round === state.round)) throw new Error('checkpoint already attempted this review round');
  // Mark admission before launching. An interrupted process cannot be retried
  // to green within this round.
  const hash = workingState(state), entry = { round:state.round, authority:state.authority.digest, hash, selection:[...state.selection.targets], command:state.plan.command, status:'incomplete', at:Date.now() };
  state.checkpoints.push(entry); state.totals.checkpointLaunches += 1; save(binding.stateDir,binding.id,state);
  // Only the workflow interprets the approved command. Not caller supplied.
  const [command, ...args] = state.plan.command.split(' ');
  const result = await launch(command,args,state.worktree,900000,signal);
  Object.assign(entry,result);
  const fresh = bound(binding,['reviewer']);
  const recorded = fresh.checkpoints.find(c => c.round === state.round);
  Object.assign(recorded, result);
  if (!currentManagedRunner(fresh) || workingState(fresh) !== hash) recorded.status = 'incomplete';
  fresh.totals.checkpointElapsedMs += result.elapsedMs;
  save(binding.stateDir,binding.id,fresh);
  return recorded;
}
export function recordManagedReview(binding, { verdict, implementation = [], tests = [], selection = [], decision = null, incomplete = [], suggestions = [] }) {
  const state = bound(binding,['reviewer']);
  if (!['READY','PASS','FAIL','DECISION_NEEDED','INCOMPLETE'].includes(verdict)) throw new Error('invalid review verdict');
  const groups = {implementation, tests, selection, incomplete, suggestions};
  if (Object.values(groups).some(v => !Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim()))) throw new Error('review findings must be nonempty string arrays');
  const repairs = [...implementation,...tests,...selection];
  const validDecision = decision && typeof decision === 'object' && typeof decision.question === 'string' && decision.question.trim() && typeof decision.recommendation === 'string' && decision.recommendation.trim();
  if ((verdict === 'DECISION_NEEDED') !== Boolean(decision) || (decision && !validDecision)) throw new Error('decision-needed requires an unresolved agreement and recommended option, only on DECISION_NEEDED');
  if (verdict === 'FAIL' ? (!repairs.length || incomplete.length) : repairs.length) throw new Error('material repair findings require FAIL; FAIL needs material repair without incomplete verification');
  if (verdict === 'INCOMPLETE' ? !incomplete.length : incomplete.length) throw new Error('incomplete verification requires INCOMPLETE');
  if ((verdict === 'PASS' || verdict === 'READY') && (!focusedPass(state) ||
      (verdict === 'PASS' && state.plan.required && !state.checkpoints.some(c => c.round === state.round && c.status === 'pass' && c.authority === state.authority.digest && c.hash === workingState(state) && JSON.stringify(c.selection) === JSON.stringify(state.selection.targets)))))
    throw new Error('PASS refused: outstanding findings or missing current focused/checkpoint evidence');
  if (verdict === 'READY' && !state.plan.required) throw new Error('READY is only for a required checkpoint');
  const review = { verdict, groups, ...(decision ? {decision} : {}), round:state.round, authority:state.authority.digest, selection:[...(state.selection?.targets ?? [])], hash:workingState(state), at:Date.now() };
  state.reviews.push(review); save(binding.stateDir,binding.id,state);
  return review;
}
export function advanceManagedRound(stateDir,id) {
  const state = read(stateDir,id);
  if (state.round !== 0 || state.reviews.at(-1)?.verdict !== 'FAIL') throw new Error('no shared repair round available');
  state.round = 1; state.active = null; save(stateDir,id,state);
  return state.reviews.at(-1);
}
export function managedLandingReady(stateDir,id) {
  const state = read(stateDir,id), last = state.reviews.at(-1);
  return Boolean(last?.verdict === 'PASS' && last.round === state.round && last.authority === state.authority.digest && JSON.stringify(last.selection) === JSON.stringify(state.selection?.targets) && last.hash === workingState(state) && focusedPass(state) &&
    (!state.plan.required || state.checkpoints.some(c => c.round === state.round && c.status === 'pass' && c.authority === state.authority.digest && c.hash === last.hash && JSON.stringify(c.selection) === JSON.stringify(state.selection.targets))));
}
