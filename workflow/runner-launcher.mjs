// A short-lived bridge removes the runner from the coordinator's PPID tree.
// The gated supervisor owns the worker, its output files and its exit record;
// no worker descriptor is connected to the coordinator that may be reloaded.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ppid = pid => {
  try { return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]); }
  catch { return null; }
};

export async function spawnDetachedRunner({ request, cwd, env = process.env, spawnFn = spawn }) {
  const bridge = spawnFn(process.execPath, [self, '--bridge', request], {
    cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let observed = null, errorText = '';
  bridge.stderr?.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
  bridge.on('message', message => { if (Number.isSafeInteger(message?.pid) && message.pid > 0) observed = message.pid; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { bridge.kill('SIGKILL'); reject(new Error('runner bridge timed out')); }, 5000);
    bridge.once('error', error => { clearTimeout(timeout); reject(error); });
    bridge.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  if (code !== 0 || !observed) throw new Error(`runner bridge failed (${code}): ${errorText}`);
  // The launcher must have exited, and the supervisor must no longer belong
  // to this coordinator's PPID tree before the gate permits any worker start.
  const argv = readFileSync(`/proc/${observed}/cmdline`, 'utf8').split('\0');
  const parent = ppid(observed);
  if (argv[1] !== self || argv[2] !== '--supervise' || argv[3] !== request || !parent || parent === process.pid || parent === bridge.pid)
    throw new Error('runner supervisor identity/reparenting boundary not confirmed');
  writeFileSync(`${request}.go`, '', { flag: 'wx', mode: 0o600 });
  return { pid: observed };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--bridge') {
    const env = { ...process.env };
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    const child = spawn(process.execPath, [self, '--supervise', process.argv[3]], {
      cwd: process.cwd(), env, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('error', () => { process.exitCode = 1; process.disconnect?.(); });
    child.once('spawn', () => { child.unref(); process.send?.({ pid: child.pid }, () => process.disconnect?.()); });
  } else if (process.argv[2] === '--supervise') {
    const request = process.argv[3];
    const wait = async () => {
      for (let i = 0; i < 500; i++) {
        if (existsSync(`${request}.go`)) break;
        await sleep(20);
      }
      if (!existsSync(`${request}.go`)) {
        rmSync(request, { force: true });
        throw new Error('runner launch gate timed out');
      }
      const config = JSON.parse(readFileSync(request, 'utf8'));
      rmSync(request, { force: true }); // do not retain provider credentials beyond launch
      const out = openSync(config.stdout, 'a', 0o600), err = openSync(config.stderr, 'a', 0o600);
      let child;
      try {
        child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env,
          detached: true, stdio: ['ignore', out, err] });
      } finally { closeSync(out); closeSync(err); }
      let stopping = false;
      const stop = () => {
        stopping = true;
        if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
      child.once('error', error => {
        writeFileSync(`${request}.exit`, JSON.stringify({ error: error.message, stopping }));
        process.exitCode = 1;
      });
      child.once('close', (code, signal) => {
        writeFileSync(`${request}.exit`, JSON.stringify({ code, signal, stopping }));
        process.exitCode = code === 0 ? 0 : 1;
      });
    };
    wait().catch(error => { writeFileSync(`${request}.exit`, JSON.stringify({ error: error.message })); process.exitCode = 1; });
  }
}
