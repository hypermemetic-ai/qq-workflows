import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';
export async function boundObservation(value, { limit = 16000, artifactDir = join(STATE_DIR, 'artifacts') } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= limit) return value;
  const hash = createHash('sha256').update(text).digest('hex');
  await mkdir(artifactDir, { recursive: true });
  const artifact = join(artifactDir, `${hash}.txt`);
  await writeFile(artifact, text);
  return { bounded: true, totalChars: text.length, artifact, head: text.slice(0, limit / 2), tail: text.slice(-limit / 2), warning: 'Observation exceeded the request budget. Full diagnostic retained; narrow the query or specify an explicit result bound.' };
}
