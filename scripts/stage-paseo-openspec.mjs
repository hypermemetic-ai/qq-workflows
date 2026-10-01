#!/usr/bin/env node
// Layer the reviewed OpenSpec preference onto the existing Pi-compatible release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.join(repo, 'patches/paseo/0.10.2');
const manifest = JSON.parse(await readFile(path.join(artifact, 'openspec-planning.json'), 'utf8'));
const patchFile = path.join(artifact, 'openspec-planning.patch');
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(await readFile(patchFile)), manifest.patchSha256);
const releases = path.join(homedir(), '.local/share/paseo/releases');
const base = path.join(releases, manifest.baseIdentity);
const candidate = path.join(releases, `0.10.2-qq-openspec.${manifest.patchSha256.slice(0, 16)}`);
const mode = process.argv[2] ?? '--stage';
assert(['--stage', '--verify'].includes(mode), 'use --stage or --verify');
execFileSync(process.execPath, [path.join(repo, 'scripts/stage-paseo-native-admission.mjs'), '--verify'], { stdio: 'ignore' });
if (mode === '--stage') {
  await mkdir(candidate, { mode: 0o700 });
  execFileSync('cp', ['-a', '--reflink=auto', base + '/.', candidate]);
  execFileSync('chmod', ['-R', 'u+w', candidate]);
  await rename(path.join(candidate, 'qq-native-admission-provenance.json'), path.join(candidate, 'qq-native-admission-base-provenance.json'));
  await rm(path.join(candidate, 'qq-native-admission-seal.json'));
  execFileSync('patch', ['--batch', '--fuzz=0', '-p1', '-i', patchFile], { cwd: candidate, stdio: 'ignore' });
  await writeFile(path.join(candidate, 'qq-openspec-provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
}
const installed = JSON.parse(await readFile(path.join(candidate, 'qq-openspec-provenance.json'), 'utf8'));
assert.deepEqual(installed, manifest);
for (const [file, expected] of Object.entries(manifest.sha256)) {
  assert.equal(hash(await readFile(path.join(candidate, file))), expected, file);
}
console.log(JSON.stringify({ candidate, sourceCommit: manifest.sourceCommit, patchSha256: manifest.patchSha256 }));
