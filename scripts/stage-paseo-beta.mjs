#!/usr/bin/env node
// Reproduce the owned compatibility port on the pinned published beta tree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat, readlink, realpath, mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.join(repo, 'patches/paseo/0.11.0-beta.5');
const manifest = JSON.parse(await readFile(path.join(artifact, 'manifest.json'), 'utf8'));
const patchFile = path.join(artifact, 'compatibility.patch');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(manifest.baseVersion, '0.11.0-beta.5');
assert.equal(hash(await readFile(patchFile)), manifest.patchSha256, 'patch hash mismatch');
const releases = path.join(homedir(), '.local/share/paseo/releases');
const official = path.join(releases, manifest.baseVersion);
const candidate = path.join(releases, `${manifest.baseVersion}-qq-compat.${manifest.patchSha256.slice(0, 16)}`);
const preparation = path.join(homedir(), '.local/state/paseo-beta-20261006');
const serverRel = 'lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server';
const provenanceName = 'qq-beta-compatibility.json';
const sealName = 'qq-beta-seal.json';
const mode = process.argv[2] ?? '--stage';
assert(['--stage', '--seal', '--verify'].includes(mode), 'use --stage, --seal or --verify');

async function inventory(root) {
  const rows = [];
  async function walk(relative = '') {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const rel = path.posix.join(relative, name);
      if ([provenanceName, sealName].includes(rel)) continue;
      const full = path.join(root, rel), stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        const link = await readlink(full);
        assert(!path.isAbsolute(link), `nonrelocatable link: ${rel}`);
        assert((await realpath(full)).startsWith(root + '/'), `external/broken link: ${rel}`);
        rows.push({ path: rel, link });
      } else if (stat.isDirectory()) await walk(rel);
      else {
        assert(stat.isFile(), `unsupported entry: ${rel}`);
        rows.push({ path: rel, sha256: hash(await readFile(full)), executable: Boolean(stat.mode & 0o111) });
      }
    }
  }
  await walk();
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
for (const [name, expected] of Object.entries(manifest.tarballs)) {
  assert.equal(hash(await readFile(path.join(preparation, name))), expected, `published input: ${name}`);
}
for (const rel of ['lib/node_modules/@getpaseo/cli', serverRel]) {
  assert.equal(JSON.parse(await readFile(path.join(official, rel, 'package.json'))).version, manifest.baseVersion);
}
const base = await inventory(official);
assert.equal(hash(JSON.stringify(base)), manifest.baseTreeSha256, 'official installed tree mismatch');
for (const file of manifest.files.filter(file => file.before)) {
  assert.equal(hash(await readFile(path.join(official, file.path))), file.before, `before: ${file.path}`);
  assert.equal(hash(execFileSync('tar', ['-xOf', path.join(preparation, 'getpaseo-server-0.11.0-beta.5.tgz'), 'package/' + file.path.slice(serverRel.length + 1)], { maxBuffer: 8 * 1024 * 1024 })), file.before, `tarball: ${file.path}`);
}
const expected = base.map(entry => {
  const changed = manifest.files.find(file => file.path === entry.path);
  return changed ? { ...entry, sha256: changed.after } : entry;
});
for (const file of manifest.files.filter(file => !file.before)) expected.push({ path: file.path, sha256: file.after, executable: false });
expected.sort((a, b) => a.path.localeCompare(b.path));
const candidateTreeSha256 = hash(JSON.stringify(expected));
assert.equal(candidateTreeSha256, manifest.candidateTreeSha256);
if (mode === '--stage') {
  await mkdir(candidate, { mode: 0o700 }); // Fail closed on existing/partial candidates.
  execFileSync('cp', ['-a', '--reflink=auto', official + '/.', candidate]);
  execFileSync('patch', ['--batch', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '-i', patchFile], { cwd: candidate, stdio: 'ignore' });
  await writeFile(path.join(candidate, provenanceName), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
assert.deepEqual(JSON.parse(await readFile(path.join(candidate, provenanceName))), manifest);
assert.deepEqual(await inventory(candidate), expected, 'candidate content/link inventory mismatch');
assert((await realpath(path.join(candidate, 'bin/paseo'))).startsWith(candidate + '/'));
if (mode === '--seal') {
  await writeFile(path.join(candidate, sealName), JSON.stringify({ patchSha256: manifest.patchSha256, candidateTreeSha256 }, null, 2) + '\n', { mode: 0o400, flag: 'wx' });
  async function seal(dir) {
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name), stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await seal(full);
      await chmod(full, stat.mode & ~0o222);
    }
  }
  await seal(candidate);
  await chmod(candidate, (await lstat(candidate)).mode & ~0o222);
}
if (mode === '--verify') {
  assert.deepEqual(JSON.parse(await readFile(path.join(candidate, sealName))), { patchSha256: manifest.patchSha256, candidateTreeSha256 });
  async function readonly(dir) {
    assert.equal((await lstat(dir)).mode & 0o222, 0, `unsealed: ${dir}`);
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name), stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await readonly(full);
      else assert.equal(stat.mode & 0o222, 0, `unsealed: ${full}`);
    }
  }
  await readonly(candidate);
}
assert.equal(execFileSync(path.join(candidate, 'bin/paseo'), ['--version'], { encoding: 'utf8' }).trim(), manifest.baseVersion);
console.log(JSON.stringify({ candidate, patchSha256: manifest.patchSha256, candidateTreeSha256, sourceCommit: manifest.sourceCommit }));
