import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./zg-index-projects-test.py', import.meta.url))], {
  stdio: 'inherit', env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
