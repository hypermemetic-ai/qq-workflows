// Rebuildable transport holds, never workflow state. The kernel lock covers
// acquisition AND shutdown across processes; a holder survives coordinator
// teardown only while its exact process incarnation remains alive.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
const holderScope = dir => join(dirname(dir), `${basename(dir)}-runtime`);

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`relay transport directory must be an owned private real directory: ${path}`);
  }
}

// startTicks and boot ID survive process-title changes and reject PID reuse.
function identity(pid = process.pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pid, startTicks: fields[19], bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), zombie: fields[0] === 'Z' };
}

export async function withRelayProcessLock(dir, operation) {
  privateDirectory(dir);
  const scope = holderScope(dir);
  privateDirectory(scope);
  const path = join(scope, 'runtime.lock');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafe relay runtime lock');
  // flock is already part of the supported Linux runtime. Unlike an O_EXCL
  // lock, kernel ownership releases after a crash without a torn-owner gap.
  // The helper holds only this lock; EOF on its private pipe releases it.
  const helper = spawn('flock', ['--exclusive', '--timeout', '10', '--no-fork', path, process.execPath, '-e',
    'process.stdin.resume(); process.stdout.write("locked\\n"); process.stdin.on("end",()=>process.exit(0));'],
  { stdio: ['pipe', 'pipe', 'ignore'] });
  helper.stdin.on('error', () => {});
  const exited = new Promise(resolve => helper.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => { helper.kill('SIGKILL'); reject(new Error('relay runtime lock timed out')); }, 12000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.once('exit', code => { clearTimeout(timer); reject(new Error(`relay runtime lock exited before acquisition (${code})`)); });
      helper.stdout.on('data', chunk => {
        text += chunk;
        if (text.includes('locked\n')) { clearTimeout(timer); resolve(); }
      });
    });
    return await operation();
  } finally {
    helper.stdin.end();
    await exited;
  }
}

// These synchronous helpers are called only under withRelayProcessLock.
export function registerRelayHolder(dir) {
  const holders = join(holderScope(dir), 'holders');
  privateDirectory(holders);
  const path = join(holders, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(identity())}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}

export function removeRelayHolder(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function remainingRelayHolders(dir) {
  const holders = join(holderScope(dir), 'holders');
  privateDirectory(holders);
  const live = [];
  for (const name of readdirSync(holders)) {
    const path = join(holders, name);
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(stored.pid) || stored.pid <= 0 || !stored.startTicks || !stored.bootId) { live.push(name); continue; }
      let current;
      try { current = identity(stored.pid); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') { removeRelayHolder(path); continue; }
        live.push(name); continue; // Unobservable never means dead.
      }
      if (current.zombie || stored.bootId !== current.bootId || stored.startTicks !== current.startTicks) removeRelayHolder(path);
      else live.push(name);
    } catch {
      // A crash can leave a torn holder write. Its generated filename still
      // names the creating PID, but absent start evidence NEVER permits PID
      // reuse inference: only a provably nonexistent PID allows removal.
      const match = /^(\d+)-[0-9a-f-]{36}\.json$/.exec(name);
      if (match) {
        try { identity(Number(match[1])); }
        catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') { removeRelayHolder(path); continue; }
        }
      }
      live.push(name);
    }
  }
  return live;
}

// A bound Pi receiver borrows the existing runtime and must participate even
// when its launching coordinator no longer exists. It never spawns a relay.
export async function holdRelayForReceiver(dir) {
  const path = await withRelayProcessLock(dir, () => registerRelayHolder(dir));
  let released = false;
  return async () => {
    if (released) return;
    await withRelayProcessLock(dir, () => removeRelayHolder(path));
    released = true;
  };
}
