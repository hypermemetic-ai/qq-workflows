import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './config.mjs';
export function hostVersion() {
  // Paseo evaluates a compiled bundle; import.meta.url is not the source file there.
  const root = join(PLUGIN_ROOT, 'host');
  const hash = createHash('sha256');
  for (const name of readdirSync(root).sort()) {
    if (/\.(mjs|md)$/.test(name)) hash.update(name).update(readFileSync(join(root, name)));
  }
  return hash.digest('hex');
}
