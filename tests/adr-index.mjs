#!/usr/bin/env node
// Deterministic proof of the derived ADR-only index: materialization, the
// narrow retryable index/update helper, and honest freshness receipts
// (workflow/adr-index.mjs). Injected fake backend at the provider boundary —
// NO live model inference, no GPU model load, no real project reindex.
//
// Covers: only ADR documents are materialized/passed to the index (never
// README/guides/historical evidence), receipts record corpus/config/index
// freshness + source revision + backend identity, no reindex when only
// non-ADR files change, publication-style ADR change invalidates freshness
// and triggers a rebuild, up-to-date idempotence, failed backend => failed
// retryable + NEVER a fresh receipt + honest missing/stale/corrupt status,
// workspace symlink refusal, empty corpus is valid.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_ADR_INDEX_CONFIG,
  adrIndexStatus,
  adrIndexWorkspace,
  indexConfigHash,
  listWorkspaceFiles,
  readAdrIndexReceipt,
  updateAdrIndex,
} from "../workflow/adr-index.mjs";
import { readAdrCorpus } from "../workflow/adr-corpus.mjs";
import { buildCorpusRepo, commitFiles, fakeBackendFactory, syntheticAdr, syntheticAdrPath, tmpStateDir } from "./fixtures/adr-corpus/fixture.mjs";

const pass = (message) => console.log(`PASS ${message}`);

// ---------------------------------------------------------------------------
// Build / receipts / freshness
// ---------------------------------------------------------------------------
{
  const { root, revision } = buildCorpusRepo({ count: 2, prefix: "adr-index-" });
  const stateDir = tmpStateDir();
  const backend = fakeBackendFactory();

  // Missing index before any build: honest, never "zero matches".
  const loaded = await readAdrCorpus({ projectRoot: root });
  const before = adrIndexStatus(stateDir, { corpus: loaded.corpus });
  assert.equal(before.state, "missing");
  assert.equal(before.fresh, false);

  const built = await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: backend });
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.status, "indexed");
  assert.equal(built.reindexed, true);
  assert.equal(backend.calls.index.length, 1);

  // ONLY the ADR documents reached the index backend — never README/guides/
  // historical evidence/manifests/judgments.
  const indexedFiles = backend.calls.index[0].files;
  assert.deepEqual(indexedFiles.sort(), [syntheticAdrPath(1), syntheticAdrPath(2)].sort(), "only ADR files are passed to the index");
  assert.deepEqual(listWorkspaceFiles(stateDir).sort(), indexedFiles.sort(), "the derived materialization contains exactly the corpus ADRs");
  assert.ok(!indexedFiles.some((file) => /README|guide|ticket|report|manifest|judgment|historical/i.test(file)), "no non-ADR document is ever indexed");

  // Receipt records corpus/config/index freshness + provenance + backend identity.
  const receiptRead = readAdrIndexReceipt(stateDir);
  assert.equal(receiptRead.ok, true, receiptRead.reason);
  const receipt = receiptRead.receipt;
  assert.equal(receipt.corpus.corpusHash, loaded.corpus.corpusHash);
  assert.equal(receipt.corpus.sourceRevision, revision);
  assert.equal(receipt.config.configHash, indexConfigHash(DEFAULT_ADR_INDEX_CONFIG));
  assert.equal(receipt.backend.name, "fake-zvec-backend");
  assert.deepEqual(receipt.materialization.files.map((file) => file.path).sort(), indexedFiles.sort());
  assert.ok(receipt.materialization.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.version)), "per-ADR content-hash versions are recorded");
  const fresh = adrIndexStatus(stateDir, { corpus: loaded.corpus });
  assert.equal(fresh.state, "fresh");
  // Real zvec-grep stores its index under <root>/.zvec-grep. That hidden
  // operational home is scanner-excluded, not an ADR and not an extra corpus
  // file; a publication refresh must preserve it instead of deleting it.
  const indexHome = join(adrIndexWorkspace(stateDir), ".zvec-grep");
  mkdirSync(indexHome);
  writeFileSync(join(indexHome, "manifest.json"), "synthetic index marker");
  assert.equal(adrIndexStatus(stateDir, { corpus: loaded.corpus }).state, "fresh");
  assert.deepEqual(listWorkspaceFiles(stateDir).sort(), indexedFiles.sort());

  // Idempotence: an unchanged corpus is up-to-date WITHOUT touching the backend.
  const again = await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: backend });
  assert.equal(again.status, "up-to-date");
  assert.equal(again.reindexed, false);
  assert.equal(backend.calls.index.length, 1, "no needless reindex");

  // A commit touching ONLY non-ADR files never triggers a reindex.
  commitFiles(root, { "src/app.js": "export const app = () => 'v2';\n" }, "non-ADR change");
  const afterNonAdr = await readAdrCorpus({ projectRoot: root });
  assert.equal(afterNonAdr.corpus.corpusHash, loaded.corpus.corpusHash);
  assert.equal(adrIndexStatus(stateDir, { corpus: afterNonAdr.corpus }).state, "fresh", "non-ADR commits do not stale the derived index");
  const nonAdrRun = await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: backend });
  assert.equal(nonAdrRun.status, "up-to-date");
  assert.equal(backend.calls.index.length, 1, "no needless reindex when only non-ADR files change");

  // Publication-style ADR content change: stale status, then a real rebuild.
  commitFiles(root, { [syntheticAdrPath(2)]: `${syntheticAdr(2, "topic-2")}\nPublication-style update.\n` }, "publish ADR change");
  const afterPublish = await readAdrCorpus({ projectRoot: root });
  const stale = adrIndexStatus(stateDir, { corpus: afterPublish.corpus });
  assert.equal(stale.state, "stale", "publication-style content change invalidates index freshness");
  const rebuilt = await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: backend });
  assert.equal(rebuilt.status, "indexed");
  assert.equal(backend.calls.index.length, 2, "an ADR content change reindexes");
  assert.equal(readFileSync(join(indexHome, "manifest.json"), "utf8"), "synthetic index marker", "backend index home survives content refresh");
  assert.equal(adrIndexStatus(stateDir, { corpus: afterPublish.corpus }).state, "fresh");
  assert.equal(readAdrIndexReceipt(stateDir).receipt.corpus.entries.find((entry) => entry.adrId === "0002").version, afterPublish.corpus.entries.find((entry) => entry.adrId === "0002").version, "the receipt carries the new content-hash version");

  // A config change also stales the index honestly.
  const otherConfig = { ...DEFAULT_ADR_INDEX_CONFIG, version: 2 };
  assert.equal(adrIndexStatus(stateDir, { corpus: afterPublish.corpus, config: otherConfig }).state, "stale", "config change invalidates freshness");
  pass("derived ADR-only index: only ADR files indexed, receipts honest, no needless reindex, publication change rebuilds");
}

// ---------------------------------------------------------------------------
// Failure honesty: backend failure is retryable and never claims fresh
// ---------------------------------------------------------------------------
{
  const { root } = buildCorpusRepo({ count: 1, prefix: "adr-index-fail-" });
  const stateDir = tmpStateDir();
  const failing = fakeBackendFactory({ failIndex: true });
  const failed = await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: failing });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.match(failed.reason, /fake index failure/);
  assert.equal(readAdrIndexReceipt(stateDir).ok, false, "a failed build never records a fresh receipt");
  const loaded = await readAdrCorpus({ projectRoot: root });
  assert.equal(adrIndexStatus(stateDir, { corpus: loaded.corpus }).state, "missing", "status stays honestly missing/stale, never fresh");

  // Independently retryable: the same helper call succeeds with a working backend.
  const retry = await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: fakeBackendFactory() });
  assert.equal(retry.ok, true);
  assert.equal(retry.status, "indexed");
  assert.equal(adrIndexStatus(stateDir, { corpus: loaded.corpus }).state, "fresh");

  // Backend open failure (unsupported state) is explicit, never silent.
  const unsupported = await updateAdrIndex({
    stateDir: tmpStateDir(),
    projectRoot: root,
    force: true,
    backendFactory: fakeBackendFactory({ failOpen: true }),
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, "unsupported-backend");
  assert.match(unsupported.reason, /unavailable/);

  // Corrupt receipt: honest corruption, never trusted as fresh.
  const corruptState = tmpStateDir();
  const ok = await updateAdrIndex({ stateDir: corruptState, projectRoot: root, backendFactory: fakeBackendFactory() });
  assert.equal(ok.ok, true);
  writeFileSync(join(corruptState, "adr-index", "index-receipt.json"), "{\"schema\":\"adr-index-receipt\",", "utf8");
  assert.equal(readAdrIndexReceipt(corruptState).corrupt, true);
  assert.equal(adrIndexStatus(corruptState, { corpus: loaded.corpus }).state, "corrupt");
  pass("failed/unsupported backends and corrupt receipts are honest (no zero matches, no fake freshness) and retryable");
}

// ---------------------------------------------------------------------------
// Unsafe workspace and empty corpus
// ---------------------------------------------------------------------------
{
  const { root } = buildCorpusRepo({ count: 1, prefix: "adr-index-sym-" });
  const stateDir = tmpStateDir();
  // A pre-existing workspace SYMLINK is refused, never followed.
  mkdirSync(join(stateDir, "adr-index"), { recursive: true });
  symlinkSync("/etc", adrIndexWorkspace(stateDir), "dir");
  const refused = await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: fakeBackendFactory() });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "unsafe-workspace");
  assert.match(refused.reason, /symlink/);
  rmSync(join(stateDir, "adr-index"), { recursive: true, force: true });

  // A true empty corpus is valid: nothing materialized or indexed.
  const emptyRepo = buildCorpusRepo({ count: 0, prefix: "adr-index-empty-" });
  const emptyState = tmpStateDir();
  const backend = fakeBackendFactory();
  const empty = await updateAdrIndex({ stateDir: emptyState, projectRoot: emptyRepo.root, backendFactory: backend });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, "empty-corpus");
  assert.equal(backend.calls.index.length, 0, "an empty corpus is never indexed");
  assert.equal(existsSync(adrIndexWorkspace(emptyState)), false, "an empty corpus materializes nothing");
  assert.equal(adrIndexStatus(emptyState, { corpus: (await readAdrCorpus({ projectRoot: emptyRepo.root })).corpus }).state, "empty");
  pass("unsafe workspace symlinks are refused; a true empty corpus is valid");
}

console.log("Passed tests/adr-index.mjs");
