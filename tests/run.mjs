import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

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
