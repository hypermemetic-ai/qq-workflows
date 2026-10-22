#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const MODEL = 'claude-opus-5-5';
const TEXT_GENERATION_MODEL = 'claude-haiku-5-5';
const AUTO_COMPACT_WINDOW = '300000';
const INSTANCE = 'claudeAgent';
const args = process.argv.slice(2);
const homeIndex = args.indexOf('--t3-home');
const t3Home = homeIndex < 0 ? resolve(homedir(), '.t3') : args[homeIndex + 1];
if (homeIndex >= 0) args.splice(homeIndex, 2);
if (!t3Home || args.includes('--help')) {
  console.log('Usage: node scripts/verify-t3-openspec.mjs [--t3-home PATH] [WORKSPACE ...]');
  process.exit(t3Home ? 0 : 1);
}
const workspaces = args.length ? args.map(p => resolve(p)) : [process.cwd()];
const expected = [
  't3-openspec-architect', 'openspec-explore', 'openspec-propose',
  'openspec-update-change', 'openspec-apply-change', 'openspec-sync-specs',
  'openspec-archive-change',
];

// Mirrors T3's launch argument parsing: one value per flag, values never start with --.
function flagValue(launchArgs, name) {
  const tokens = launchArgs.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === `--${name}` && tokens[i + 1] && !tokens[i + 1].startsWith('--')) return tokens[i + 1];
    if (tokens[i].startsWith(`--${name}=`)) return tokens[i].slice(name.length + 3);
  }
  return undefined;
}

function readSettings() {
  const settings = JSON.parse(readFileSync(resolve(t3Home, 'userdata/settings.json'), 'utf8'));
  const instances = settings.providerInstances ?? {};
  const claude = instances[INSTANCE];
  if (claude?.driver !== INSTANCE || claude.enabled === false) throw new Error('T3 has no enabled Claude instance');
  if (instances.codex?.enabled !== false) throw new Error('T3 Codex provider is not disabled');
  for (const [key, model] of [['defaultModelSelection', MODEL], ['textGenerationModelSelection', TEXT_GENERATION_MODEL]]) {
    const selection = settings[key];
    if (selection?.instanceId !== INSTANCE || selection.model !== model) {
      throw new Error(`T3 ${key} does not select ${model} on the Claude instance`);
    }
  }
  if (settings.storageCleanup?.worktreeOnMerge !== true) throw new Error('T3 does not remove worktrees of merged pull requests');
  if (claude.config?.autoCompactWindow !== AUTO_COMPACT_WINDOW) {
    throw new Error(`Claude auto-compact window is not ${AUTO_COMPACT_WINDOW} tokens`);
  }
  const launchArgs = claude.config?.launchArgs ?? '';
  const profile = flagValue(launchArgs, 'add-dir');
  const instructions = flagValue(launchArgs, 'append-system-prompt-file');
  if (!profile || !instructions) throw new Error('Claude launch arguments omit the architect profile');
  if (!statSync(instructions).isFile()) throw new Error(`missing architect instructions: ${instructions}`);
  return { binary: claude.config?.binaryPath || 'claude', profile, instructions };
}

// The initialize control request reports account, models and discovered skills.
// Standard input then closes without a user message, so no model turn starts.
function initialize(binary, workspace, profile, instructions) {
  const child = spawn(binary, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', MODEL, '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
    '--add-dir', profile, '--append-system-prompt-file', instructions,
  ], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolveResponse, reject) => {
    let buffer = '', diagnostic = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
      if (error) reject(error); else resolveResponse(result);
    };
    const timer = setTimeout(() => finish(new Error(`${workspace}: initialize timed out`)), 60000);
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(`claude exited (${code}) before initializing`
      + (diagnostic.includes('Error') ? '; it reported a startup error' : ''))));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type !== 'control_response' || message.response?.request_id !== 'verify-init') continue;
        if (message.response.subtype !== 'success') finish(new Error(`initialize: ${message.response.error ?? 'failed'}`));
        else finish(null, message.response.response);
      }
    });
    child.stdin.write(JSON.stringify({
      type: 'control_request', request_id: 'verify-init', request: { subtype: 'initialize' },
    }) + '\n');
  });
}

try {
  const { binary, profile, instructions } = readSettings();
  console.log(`Verified T3 settings: ${MODEL} for threads, ${TEXT_GENERATION_MODEL} for text generation; compaction at ${AUTO_COMPACT_WINDOW} tokens; Codex disabled.`);
  for (const workspace of workspaces) {
    const response = await initialize(binary, workspace, profile, instructions);
    // Account details include personal identifiers. Report only the plan type.
    if (!response.account) throw new Error('Claude Code has no authenticated account');
    console.log(`Authenticated account type: ${response.account.subscriptionType ?? 'present'}`);
    for (const wanted of [MODEL, TEXT_GENERATION_MODEL]) {
      if (!response.models?.some(model => model.value === wanted || model.resolvedModel === wanted)) {
        throw new Error(`The account does not offer ${wanted}`);
      }
    }
    const names = new Set((response.commands ?? []).map(command => command.name));
    const missing = expected.filter(name => !names.has(name));
    if (missing.length) throw new Error(`${workspace}: missing skills ${missing.join(', ')}`);
    if (response.current_permission_mode !== 'bypassPermissions') {
      throw new Error('Claude permissions do not match full implementation access');
    }
    console.log(`Verified seven workflow skills, ${MODEL} and full access: ${workspace}`);
  }
  console.log('No model turn was started.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
