// Short-lived launch bridge for the EXISTING execution host. setsid alone does
// not remove a child from Paseo's recursive PPID walk. The bridge exits before
// the coordinator binds the host PID and permits the pipeline to start.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const hostPath = fileURLToPath(new URL('./execution-host.mjs', import.meta.url));
export function spawnExecutionHostProcess({ requestPath, root, env, log }) {
  return new Promise((resolveLaunch, reject) => {
    const launcher = spawn(process.execPath, [fileURLToPath(import.meta.url), '--launch', requestPath], {
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
        // A PID that exited/reused before binding must never become owned.
        const argv = readFileSync(`/proc/${observed.pid}/cmdline`, 'utf8').split('\0');
        if (argv[1] !== hostPath || argv[2] !== requestPath) throw new Error('execution host process identity changed before binding');
        resolveLaunch({ pid: observed.pid });
      } catch (error) { reject(error); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === '--launch') {
  const env = { ...process.env };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  const child = spawn(process.execPath, [hostPath, process.argv[3]], {
    cwd: process.cwd(), env, detached: true, stdio: ['ignore', 'ignore', process.stderr],
  });
  child.once('error', () => { process.exitCode = 1; process.disconnect?.(); });
  child.once('spawn', () => {
    child.unref();
    process.send?.({ pid: child.pid }, () => process.disconnect?.());
  });
}
