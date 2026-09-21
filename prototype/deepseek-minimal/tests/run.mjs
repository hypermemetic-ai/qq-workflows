#!/usr/bin/env node
/**
 * Prototype test runner.
 *
 * Kept separate from the repository's `npm test` (which must stay
 * runtime-independent): these tests execute the pinned DeepSeek Harness
 * runtime and therefore require `scripts/setup-runtime.mjs` to have been run.
 *
 * Usage: node prototype/deepseek-minimal/tests/run.mjs [name-filter]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testFiles } from "./harness.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];
const files = testFiles().filter(name => filter === undefined || name.includes(filter));
let failed = 0;
for (const name of files) {
  process.stdout.write(`\n== ${name}\n`);
  const result = spawnSync(process.execPath, [join(directory, name)], { stdio: "inherit", cwd: dirname(directory) });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED ${name} (exit ${result.status})`);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${files.length} prototype test files failed`);
  process.exit(1);
}
console.log(`\nPassed ${files.length} prototype test files.`);
