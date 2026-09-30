// Short-lived launch bridge for the EXISTING execution host. setsid alone does
// not remove a child from Paseo's recursive PPID walk. The bridge exits before
// the coordinator binds the host PID and permits the pipeline to start.
// Inside paseo.service, a transient user scope also removes the NEW host from
// the service's kill cgroup. Existing jobs are never adopted or restarted.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const hostPath = fileURLToPath(new URL('./execution-host.mjs', import.meta.url));
const launcherPath = fileURLToPath(import.meta.url);
const paseoCgroup = /(?:^|\/)paseo\.service(?:\/|$)/m;
const readCgroup = pid => readFileSync(`/proc/${pid}/cgroup`, 'utf8');

export function executionHostScope(cgroup) {
  return paseoCgroup.test(cgroup) ? `qq-execution-${randomUUID()}.scope` : null;
}

export function verifyExecutionHostProcess({ pid, requestPath, scope }, readProc = readFileSync) {
  // A PID that exited/reused before binding must never become owned.
  const argv = readProc(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  if (argv[0] !== process.execPath || argv[1] !== hostPath || argv[2] !== requestPath) {
    throw new Error('execution host process identity changed before binding');
  }
  if (scope) {
    const cgroup = readProc(`/proc/${pid}/cgroup`, 'utf8');
    if (paseoCgroup.test(cgroup) || !cgroup.split('\n').some(line => line.split(':').slice(2).join(':').split('/').includes(scope))) {
      throw new Error('execution host independent systemd scope was not established');
    }
  }
}

export function spawnExecutionHostProcess({ requestPath, root, env, log }, { sourceCgroup = () => process.platform === 'linux' ? readCgroup('self') : '' } = {}) {
  // Fail closed if the required boundary cannot be read or established. Scope
  // execution inherits cwd/env/fds, so secrets are NOT copied into unit
  // properties, command arguments or the journal. No restart policy exists.
  const scope = executionHostScope(sourceCgroup());
  return new Promise((resolveLaunch, reject) => {
    const launcher = spawn(process.execPath, [launcherPath, '--launch', requestPath, ...(scope ? [scope] : [])], {
      cwd: root, env, detached: true, stdio: ['ignore', 'ignore', log, 'ipc'],
    });
    let observed = null;
    const timer = setTimeout(() => { launcher.kill('SIGKILL'); reject(new Error('execution host launcher timed out')); }, 5000);
    launcher.on('message', message => { if (Number.isSafeInteger(message?.pid) && message.pid > 0) observed = message; });
    launcher.once('error', error => { clearTimeout(timer); reject(error); });
    launcher.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !observed) { reject(new Error(`execution host launcher failed (${code})`)); return; }
      try {
        verifyExecutionHostProcess({ pid: observed.pid, requestPath, scope });
        resolveLaunch({ pid: observed.pid });
      } catch (error) { reject(error); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = { ...process.env };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  const requestPath = process.argv[3];
  const scope = process.argv[4];
  if (process.argv[2] === '--launch' && scope) {
    // systemd-run attaches this fresh bridge BEFORE it execs; the bridge
    // forks the gated host, then exits to break Paseo's recursive PPID walk.
    // The scope remains alive for the host and all its future descendants.
    const scoped = spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', `--unit=${scope}`,
      '--', process.execPath, launcherPath, '--scoped', requestPath], {
      cwd: process.cwd(), env, stdio: ['ignore', 'pipe', process.stderr],
    });
    let output = '';
    scoped.stdout.on('data', data => { output += data; });
    scoped.once('error', () => { process.exitCode = 1; process.disconnect?.(); });
    scoped.once('close', code => {
      try {
        if (code !== 0) throw new Error('scope launch failed');
        const message = JSON.parse(output);
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0) throw new Error('invalid host PID');
        process.send?.(message, () => process.disconnect?.());
      } catch { process.exitCode = 1; process.disconnect?.(); }
    });
  } else if (process.argv[2] === '--launch' || process.argv[2] === '--scoped') {
    const child = spawn(process.execPath, [hostPath, requestPath], {
      cwd: process.cwd(), env, detached: true, stdio: ['ignore', 'ignore', process.stderr],
    });
    child.once('error', () => { process.exitCode = 1; process.disconnect?.(); });
    child.once('spawn', () => {
      child.unref();
      if (process.argv[2] === '--scoped') process.stdout.write(JSON.stringify({ pid: child.pid }));
      else process.send?.({ pid: child.pid }, () => process.disconnect?.());
    });
  }
}
