import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './config.mjs';
export function hostVersion(root = join(PLUGIN_ROOT, 'host')) {
  // Paseo evaluates a compiled bundle; import.meta.url is not the source file there.
  const hash = createHash('sha256');
  function visit(directory, prefix = '') {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = prefix + entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, name + '/');
      else if (/\.(mjs|md)$/.test(name)) hash.update(name).update(readFileSync(path));
    }
  }
  visit(root);
  return hash.digest('hex');
}
