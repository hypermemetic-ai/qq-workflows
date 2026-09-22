// Use the INSTALLED Paseo implementation for lifecycle acceptance. A missing
// install is an explicit skip, never substituted with a simpler PID-only kill.
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

function serverDirectory() {
  const bin = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'paseo')).find(existsSync);
  if (!bin) return null;
  const dir = resolve(dirname(realpathSync(bin)), '..', 'node_modules/@getpaseo/server/dist/server');
  return existsSync(join(dir, 'server/agent/providers/jsonl-rpc-process.js')) ? dir : null;
}

export async function loadPaseoTreeTerminator() {
  const dir = serverDirectory();
  if (!dir) return null;
  return (await import(pathToFileURL(join(dir, 'utils/tree-kill.js')).href)).terminateWithTreeKill;
}

export async function loadPaseoRpcClient() {
  const dir = serverDirectory();
  if (!dir) return null;
  const { JsonlRpcProcess } = await import(pathToFileURL(join(dir, 'server/agent/providers/jsonl-rpc-process.js')).href);
  return class PaseoFixtureRpc {
    constructor(options) { this.options = options; }
    start() {
      if (this.rpc) return this;
      const { bin, args, cwd, env } = this.options;
      this.rpc = new JsonlRpcProcess({ launch: { command: bin, args, cwd, env }, logger: { warn() {} },
        spawn: launch => spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] }),
      });
      this.exited = new Promise(resolveExit => this.rpc.onExit(resolveExit));
      return this;
    }
    get pid() { return this.rpc?.child.pid; }
    get stderrTail() { return this.rpc?.stderrBuffer ?? ''; }
    request(command) { return this.rpc.request(command); }
    close() { return this.rpc.close(); }
    waitForExit() { return this.exited; }
  };
}
