#!/usr/bin/env node
// Negative inputs never get as far as modifying/copying a release.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = await mkdtemp(path.join(tmpdir(), 'paseo-stager-test-'));
try {
  const dir = path.join(root, 'patches/paseo/0.10.2');
  await mkdir(dir, { recursive: true }); await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/stage-paseo-native-admission.mjs'), await readFile(new URL('../scripts/stage-paseo-native-admission.mjs', import.meta.url)));
  const patch = await readFile(new URL('../patches/paseo/0.10.2/pi-native-admission.patch', import.meta.url));
  await writeFile(path.join(dir, 'pi-native-admission.patch'), patch);
  const original = JSON.parse(await readFile(new URL('../patches/paseo/0.10.2/manifest.json', import.meta.url)));
  const cases = [
    ['patch hash', m => m.patchSha256 = '0'.repeat(64), /patch hash mismatch/],
    ['base version', m => m.baseVersion = '0.8.0', /0.8.0/],
    ['Pi contract', m => m.piContract = '0.84.1', /0.84.1/],
    ['tarball input', m => m.serverTarballSha256 = '0'.repeat(64), /published server input hash mismatch/],
    ['exact patch target', m => m.files[0].before = '0'.repeat(64), /before:/],
    ['complete base tree', m => m.baseTreeSha256 = '0'.repeat(64), /official dependency tree hash mismatch/],
    ['candidate changed file', m => m.files[0].after = '0'.repeat(64), /after:/],
    ['provenance changed-files list', m => m.files.reverse(), /provenance changed-files mismatch/],
  ];
  for (const [name, mutate, expected] of cases) {
    const manifest = structuredClone(original); mutate(manifest);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    let failed = false;
    try { execFileSync(process.execPath, [path.join(root, 'scripts/stage-paseo-native-admission.mjs'), '--verify'], { timeout: 15000, stdio: 'pipe' }); }
    catch (error) { failed = true; assert.match(error.stderr.toString(), expected, name); }
    assert.equal(failed, true, name);
    console.log(`PASS rejected ${name} mismatch`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
