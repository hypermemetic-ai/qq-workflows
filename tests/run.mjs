import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
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
// Scrub live notification routing/thread env from test runs.
// Targeted actual live routing values (preserve needed config: CODEX_HOME, CODEX_MODEL, CODEX_BIN).
delete env.CODEX_THREAD_ID;
delete env.CODEX_SESSION_ID;
delete env.CODEX_CONVERSATION_ID;
// Explicit safe notification transport backstop.
env.QQ_CODEX_BIN = "/usr/bin/true";

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
