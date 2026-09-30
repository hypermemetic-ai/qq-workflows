#!/usr/bin/env node
// A single owned correction of the published Paseo 0.10.2 package, not a patch framework.
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, readlink, realpath, mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(repo, 'patches/paseo/0.10.2');
const patchFile = path.join(artifacts, 'pi-native-admission.patch');
const manifest = JSON.parse(await readFile(path.join(artifacts, 'manifest.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const patch = await readFile(patchFile);
assert.equal(hash(patch), manifest.patchSha256, 'patch hash mismatch');
assert.equal(manifest.baseVersion, '0.10.2');
assert.equal(manifest.piContract, '0.99.1');
const releases = path.join(homedir(), '.local/share/paseo/releases');
const official = path.join(releases, '0.10.2');
const candidate = path.join(releases, `0.10.2-qq-pi-admission.${manifest.patchSha256.slice(0, 16)}`);
const tarball = path.join(homedir(), '.local/state/paseo-upgrade/0.10.2-preparation/getpaseo-server-0.10.2.tgz');
const serverRel = 'lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server';
const provenanceName = 'qq-native-admission-provenance.json';
const sealName = 'qq-native-admission-seal.json';
const mode = process.argv[2] ?? '--stage';
assert(['--stage', '--verify', '--seal'].includes(mode), 'use --stage, --verify or --seal');

async function inventory(root) {
  const result = [];
  async function walk(relative = '') {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const rel = path.posix.join(relative, name);
      if ([provenanceName, sealName].includes(rel)) continue;
      const full = path.join(root, rel), stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        const target = await readlink(full);
        assert(!path.isAbsolute(target), `nonrelocatable link: ${rel}`);
        const resolved = await realpath(full);
        assert(resolved.startsWith(root + '/'), `external/broken link: ${rel}`);
        result.push({ path: rel, link: target });
      } else if (stat.isDirectory()) {
        await walk(rel);
      } else {
        assert(stat.isFile(), `unsupported entry: ${rel}`);
        result.push({ path: rel, sha256: hash(await readFile(full)), executable: Boolean(stat.mode & 0o111) });
      }
    }
  }
  await walk();
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function version(root) {
  for (const rel of ['lib/node_modules/@getpaseo/cli', serverRel]) {
    assert.equal(JSON.parse(await readFile(path.join(root, rel, 'package.json'), 'utf8')).version, manifest.baseVersion);
  }
}
async function targets(root, key) {
  for (const file of manifest.files) assert.equal(hash(await readFile(path.join(root, file.path))), file[key], `${key}: ${file.path}`);
}
// Always validate the retained input too, including on verification/activation.
assert.equal(hash(await readFile(tarball)), manifest.serverTarballSha256, 'published server input hash mismatch');
await version(official);
await targets(official, 'before');
for (const file of manifest.files) {
  const member = 'package/' + file.path.slice(serverRel.length + 1);
  assert.equal(hash(execFileSync('tar', ['-xOf', tarball, member], { maxBuffer: 8 * 1024 * 1024 })), file.before, `tarball target: ${member}`);
}
const base = await inventory(official);
const baseTreeSha256 = hash(JSON.stringify(base));
assert.equal(baseTreeSha256, manifest.baseTreeSha256, 'official dependency tree hash mismatch');
const expected = base.map(entry => {
  const changed = manifest.files.find(file => file.path === entry.path);
  return changed ? { ...entry, sha256: changed.after } : entry;
});
const candidateTreeSha256 = hash(JSON.stringify(expected));
if (mode === '--stage') {
  // EEXIST fails closed, including any partially staged prior candidate.
  await mkdir(candidate, { mode: 0o700 });
  execFileSync('cp', ['-a', '--reflink=auto', official + '/.', candidate], { timeout: 120000 });
  execFileSync('patch', ['--batch', '--fuzz=0', '-p1', '-i', patchFile], { cwd: candidate });
  await writeFile(path.join(candidate, provenanceName), JSON.stringify({
    ...manifest, official, tarball, baseTreeSha256, candidateTreeSha256,
    candidate, patchFile, localPatch: true, stagedAt: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
await version(candidate);
await targets(candidate, 'after');
assert.deepEqual(await inventory(candidate), expected, 'candidate dependency tree/link/content mismatch');
const provenance = JSON.parse(await readFile(path.join(candidate, provenanceName), 'utf8'));
for (const [key, value] of Object.entries({ patchSha256: manifest.patchSha256, serverTarballSha256: manifest.serverTarballSha256, baseTreeSha256, candidateTreeSha256, candidate, official, localPatch: true })) {
  assert.equal(provenance[key], value, `provenance mismatch: ${key}`);
}
assert.deepEqual(provenance.files, manifest.files, 'provenance changed-files mismatch');
const binary = await realpath(path.join(candidate, 'bin/paseo'));
assert(binary.startsWith(candidate + '/'), 'candidate binary resolves outside candidate');
if (mode === '--seal') {
  await writeFile(path.join(candidate, sealName), JSON.stringify({ patchSha256: manifest.patchSha256, candidateTreeSha256, sealedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o400, flag: 'wx' });
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
let sealed = false;
try {
  const seal = JSON.parse(await readFile(path.join(candidate, sealName), 'utf8'));
  assert.equal(seal.patchSha256, manifest.patchSha256);
  assert.equal(seal.candidateTreeSha256, candidateTreeSha256);
  async function checkModes(dir) {
    assert.equal((await lstat(dir)).mode & 0o222, 0, 'unsealed directory');
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name), stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      assert.equal(stat.mode & 0o222, 0, `unsealed: ${full}`);
      if (stat.isDirectory()) await checkModes(full);
    }
  }
  await checkModes(candidate);
  sealed = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (mode === '--verify') assert.equal(sealed, true, 'activation requires a tested sealed candidate');
console.log(JSON.stringify({ mode, candidate, binary, patchSha256: manifest.patchSha256, baseTreeSha256, candidateTreeSha256, sealed }, null, 2));
