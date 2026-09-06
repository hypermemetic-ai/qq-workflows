#!/usr/bin/env node
// Keep Grok's native conversation/compaction harness. Clamp injected MCP servers before session creation.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { callHost } from './host-client.mjs';
import { PLUGIN_ROOT } from './config.mjs';
import { STATE_DIR } from './config.mjs';
import { nativeProvider } from './providers/native-provider.mjs';
const nativeHome = join(STATE_DIR, 'teachers', process.env.ARCHITECT_JOB_ID ?? randomUUID());
const nativeCwd = join(nativeHome, 'workspace');
await mkdir(nativeCwd, { recursive: true, mode: 0o700 });
const sourceHome = process.env.GROK_HOME || join(homedir(), '.grok');
try { await copyFile(join(sourceHome, 'auth.json'), join(nativeHome, 'auth.json')); await chmod(join(nativeHome, 'auth.json'), 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const proxy = process.env.ARCHITECT_JOB_ID ? await nativeProvider({ endpoint: process.env.GROK_CLI_CHAT_PROXY_BASE_URL || 'https://cli-chat-proxy.grok.com/v1', jobId: process.env.ARCHITECT_JOB_ID, hostUrl: process.env.ARCHITECT_HOST }) : null;
const child = spawn(process.env.GROK_BIN || join(sourceHome, 'bin', 'grok'), ['agent', '--agent-profile', join(PLUGIN_ROOT, 'host', 'teacher.md'), '--no-leader', ...(proxy ? ['--cli-chat-proxy-base-url', proxy.url] : []), 'stdio'], { cwd: nativeCwd, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, GROK_HOME: nativeHome, GROK_MEMORY: '0', GROK_TITLE_REFRESH: '0', GROK_SUBAGENTS: '0', GROK_WORKFLOWS: '0', GROK_MAX_RETRIES: '0', GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_MANAGED_MCPS_ENABLED: '0', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0' } });
child.stdout.pipe(process.stdout);
createInterface({ input: process.stdin }).on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.method === 'session/new' || message.method === 'session/load') {
      // The five host tools retain the real workspace. Grok's own directory is
      // empty so repository/user plugins cannot add unrelated MCP capabilities.
      message.params.cwd = nativeCwd;
      message.params.mcpServers = (message.params.mcpServers ?? []).filter(server => server.name === 'architect');
    }
    child.stdin.write(JSON.stringify(message) + '\n');
  } catch (error) { console.error(error.message); }
}).on('close', () => child.stdin.end());
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { proxy?.close(); process.exitCode = code ?? 1; });
process.on('SIGTERM', () => child.kill('SIGTERM'));

const beat = setInterval(() => {
  if (!process.env.ARCHITECT_JOB_ID) return;
  void callHost('/runner', { event: 'heartbeat', jobId: process.env.ARCHITECT_JOB_ID, value: { pid: child.pid, activity: 'native Teacher conversation' } }).catch(() => {});
}, 10_000);
beat.unref();
child.on('exit', () => clearInterval(beat));
