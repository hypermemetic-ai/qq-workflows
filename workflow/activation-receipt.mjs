// Session-bound provenance for release activation. Written only after the owning
// session's startup recovery ran; absence/failure is not evidence of uptake.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function activationDir(home = homedir()) {
  return join(home, '.local', 'state', 'qq-workflows', 'architect-activation');
}
export function receiptPath(id, home = homedir()) {
  if (!/^[a-f0-9-]{36}$/i.test(id ?? '')) throw new Error('invalid Architect agent ID');
  return join(activationDir(home), `${id}.json`);
}
export function readReceipt(id, home) {
  try { return JSON.parse(readFileSync(receiptPath(id, home), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeReceipt(id, receipt, home) {
  const path = receiptPath(id, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
