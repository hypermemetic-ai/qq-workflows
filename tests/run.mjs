import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
delete env.QQ_IMPLEMENTER_PROVIDER;
delete env.QQ_REVIEWER_PROVIDER;
delete env.QQ_RESEARCHER_PROVIDER;
delete env.QQ_WORKFLOW_PROVIDER;
delete env.QQ_RUNNER_ID;
// Architect profile isolation: no test may inherit a live workflow identity, the
// operator's prompt capture target, operator-action tooling, or central worker
// configuration. Each run gets its own durable state directory.
delete env.QQ_ENABLE_OPERATOR_ACTION;
delete env.QQ_WORKFLOW_SESSION_ID;
delete env.QQ_ARCHITECT_PROFILE;
delete env.QQ_ARCHITECT_OWNER_AGENT_ID;
delete env.QQ_ARCHITECT_PROMPT_CAPTURE;
delete env.PASEO_AGENT_ID;
delete env.QQ_WORKER_CONFIG_FILE;
delete env.QQ_WORKER_EXEC;
env.QQ_WORKFLOW_STATE_DIR = join(mkdtempSync(join(tmpdir(), 'qq-workflow-state-')), 'state');
// Scrub live notification routing/thread env from test runs.
// Targeted actual live routing values (preserve needed config: CODEX_HOME, CODEX_MODEL, CODEX_BIN).
delete env.CODEX_THREAD_ID;
delete env.CODEX_SESSION_ID;
delete env.CODEX_CONVERSATION_ID;
// Explicit safe notification transport backstop.
env.QQ_CODEX_BIN = "/usr/bin/true";
// Durable retention of terminal findings must never write into the operator's
// real state dir during tests. Point every child at one unique temp dir.
env.QQ_RUNNER_FINDINGS_DIR = mkdtempSync(join(tmpdir(), 'qq-test-findings-'));

const tests = readdirSync(directory)
  .filter(name => name.endsWith('.mjs') && !['run.mjs', 'live.mjs'].includes(name))
  .sort();

for (const name of tests) {
  console.log(`Running ${name}`);
  const result = spawnSync(process.execPath, [join(directory, name)], {
    cwd: dirname(directory), env, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    console.error(result.error ?? `${name} failed (${result.signal ?? result.status})`);
    process.exit(result.status || 1);
  }
}
console.log(`Passed ${tests.length} Architect test files.`);
