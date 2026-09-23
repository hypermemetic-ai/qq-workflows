#!/usr/bin/env node
// Synthetic committed ADRs, injected index/search boundary; no live inference.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareCandidateSet, DEFAULT_RETRIEVAL_POLICY, readCandidateSnapshot, retrievalLimitFor } from '../workflow/adr-candidates.mjs';
import { buildCorpusRepo, commitFiles, fakeBackendFactory, syntheticAdrPath, tmpStateDir } from './fixtures/adr-corpus/fixture.mjs';
const unit = (text, id = 'u1') => ({ id, text, textSha256: createHash('sha256').update(text).digest('hex') });
for (const count of [0, 1, 50, 51, 140]) {
  const { root } = buildCorpusRepo({ count });
  const stateDir = tmpStateDir();
  const backend = fakeBackendFactory({ hitFilter: (path) => path === syntheticAdrPath(1) });
  const evidence = [unit(`topic-1 ADR-${String(count).padStart(4, '0')} ADR-404 adr-0002`)];
  const set = await prepareCandidateSet({ stateDir, projectRoot: root, evidence, backendFactory: backend });
  assert.equal(set.ok, true, set.reason);
  assert.equal(set.strategy, count <= 50 ? 'exhaustive' : 'retrieved');
  assert.equal(set.candidates.length, count <= 50 ? count : 2, 'shadow does not exclude; explicit reference is included outside retrieval');
  assert.equal(set.coverage.exhaustive, count <= 50);
  assert.equal(set.coverage.retrieval.backendBounds.recallDepthPerRoute, 2000);
  assert.equal(set.retrievalReceipt.perGroupLimit, count ? retrievalLimitFor(DEFAULT_RETRIEVAL_POLICY, count) : 1);
  assert.equal(set.explicitReferences.unresolved.some((ref) => ref.reference === 'ADR-404'), true);
  assert.equal(set.explicitReferences.unresolved.some((ref) => ref.reference === 'adr-0002'), false, 'canonical references are case sensitive');
  if (count > 50) {
    assert.deepEqual(set.candidates.map((c) => c.adrId), [String(count).padStart(4, '0'), '0001']);
    assert.ok(set.retrievalReceipt.perGroupLimit > 50 || count === 51, 'large corpora have a corpus-scaled breadth, not a fixed 50 ceiling');
  }
  const snapshot = readCandidateSnapshot(stateDir, set.snapshotId);
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.snapshot.candidateRefs, set.candidateRefs);
  const replay = await prepareCandidateSet({ stateDir, projectRoot: root, evidence, backendFactory: fakeBackendFactory({ failSearch: true }) });
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.candidates, set.candidates, 'actual candidate tuples replay without promising fresh ranking');
  if (count === 51) {
    const changed = await prepareCandidateSet({ stateDir, projectRoot: root, evidence: [unit('topic-2')], backendFactory: backend });
    assert.notEqual(changed.snapshotId, set.snapshotId, 'query change invalidates snapshot');
    const otherPolicy = { ...DEFAULT_RETRIEVAL_POLICY, breadth: { ...DEFAULT_RETRIEVAL_POLICY.breadth, fraction: 0.75 } };
    const differentPolicy = await prepareCandidateSet({ stateDir, projectRoot: root, evidence, policy: otherPolicy, backendFactory: backend });
    assert.notEqual(differentPolicy.snapshotId, set.snapshotId, 'config change invalidates snapshot');
    commitFiles(root, { [syntheticAdrPath(1)]: '# SYNTHETIC TEST ADR changed\n\ntopic-1\n' }, 'publication style change');
    const published = await prepareCandidateSet({ stateDir, projectRoot: root, evidence, backendFactory: backend });
    assert.notEqual(published.snapshotId, set.snapshotId, 'published bytes invalidate snapshot');
    assert.notEqual(published.candidates.find((c) => c.adrId === '0001').version, set.candidates.find((c) => c.adrId === '0001').version);
    const failure = await prepareCandidateSet({ stateDir: tmpStateDir(), projectRoot: root, evidence, backendFactory: fakeBackendFactory({ failSearch: true }) });
    assert.equal(failure.ok, false);
    assert.equal(failure.status, 'incomplete');
    assert.equal(failure.retryable, true);
    assert.equal(failure.candidates, null);
    const shadowFailure = await prepareCandidateSet({ stateDir: tmpStateDir(), projectRoot: buildCorpusRepo({ count: 50 }).root, evidence, backendFactory: fakeBackendFactory({ failSearch: true }) });
    assert.equal(shadowFailure.ok, true);
    assert.equal(shadowFailure.candidates.length, 50);
    assert.equal(shadowFailure.shadow.ok, false);
  }
}
console.log('PASS 0/1/50/51/140 candidate strategy, explicit refs, shadow, replay, failure, version/config invalidation');
