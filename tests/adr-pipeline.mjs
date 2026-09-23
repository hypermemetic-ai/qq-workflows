#!/usr/bin/env node
// Manifest -> selected retained evidence -> shared candidates -> both Jev passes -> packet.
// Synthetic corpus and fake provider/backend; no inference, no publication.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stageAdrSource, activateCurationObligation, listCurationObligations } from '../workflow/adr-curation.mjs';
import { recordManagedExecution } from '../workflow/execution-authority.mjs';
import { runAdrCurationComparison } from '../workflow/adr-jev-pipeline.mjs';
import { DEFAULT_RETRIEVAL_POLICY } from '../workflow/adr-candidates.mjs';
import { buildCorpusRepo, fakeBackendFactory, tmpStateDir } from './fixtures/adr-corpus/fixture.mjs';
const phaseId = 'abcd1234-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner = 'test-coordinator';
const changeId = 'adr-integration-exec';
async function run(count, threshold) {
  const { root } = buildCorpusRepo({ count });
  const stateDir = tmpStateDir();
  const requestPath = join(stateDir, 'execution-hosts', changeId, 'request.json');
  mkdirSync(join(stateDir, 'execution-hosts', changeId), { recursive: true });
  writeFileSync(requestPath, '{}');
  recordManagedExecution({ stateDir, executionId: changeId, kind: 'open', phaseId, root, owner, constraints: 'Synthetic fixture.', launchId: 'launch', requestPath, now: 1 });
  const ticketPath = join(root, 'ticket-synthetic.md');
  writeFileSync(ticketPath, '# Synthetic ticket\n\nExplore topic-1 and ADR-0002 in the test corpus.\n');
  const staged = await stageAdrSource({ stateDir, executionId: changeId, ticketPath, expected: { root, owner, phaseId }, now: 2, actor: { kind: 'runtime', id: 'test' } });
  activateCurationObligation({ stateDir, executionId: changeId, manifestId: staged.manifestId, landing: { method: 'ff', receipt: 'f'.repeat(40), headSha: 'f'.repeat(40) }, expected: { root, owner, phaseId }, now: 3, actor: { kind: 'runtime', id: 'test' } });
  const calls = [];
  const provider = { api: { name: 'systemone', version: 'v1', endpoint: 'https://api.typesafe.ai/v1/systemone' }, async request({ model, state, questions }) {
    calls.push({ model, state, questions });
    const key = Object.keys(questions)[0];
    const second = Boolean(state.candidate_adr);
    const positive = second ? 'consider_together' : 'include';
    const negative = second ? 'unrelated' : 'low_priority';
    return { ok: true, httpStatus: 200, json: { model, answers: { [key]: { type: 'choice', choice: positive, probabilities: { [positive]: 0.4, [negative]: 0.6 } } } } };
  } };
  const backend = fakeBackendFactory({ hitFilter: (path) => path.endsWith('ADR-0001.md') });
  const result = await runAdrCurationComparison({ stateDir, changeId, manifestId: staged.manifestId, projectRoot: root, provider, backendFactory: backend,
    expected: { root, owner, phaseId }, retrievalPolicy: { ...DEFAULT_RETRIEVAL_POLICY, exhaustiveThreshold: threshold } });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.packet.coverage.exhaustiveCandidateComparison, count <= threshold);
  assert.equal(result.packet.coverage.candidateComparison.strategy, count <= threshold ? 'exhaustive' : 'retrieved');
  assert.equal(result.packet.coverage.curationObligation, 'pending (untouched by this processing)');
  assert.equal(listCurationObligations({ stateDir, changeId }).processingStatus, 'pending');
  assert.equal(result.selection.counts.providerRequests > 0, true);
  assert.equal(result.comparison.counts.providerRequests > 0, true);
  assert.equal(result.comparison.coverage.pairsPlanned, result.comparison.counts.pairs);
  assert.equal(result.packet.identity.routingPolicy.positiveScoreMin, 0.4);
  assert.ok(calls.length >= 2);
  return result;
}
const exhaustive = await run(51, 51);
const filtered = await run(51, 50);
assert.ok(filtered.comparison.counts.pairs < exhaustive.comparison.counts.pairs, 'selective fixture requests fewer Jev pairs; no real recall claim');
assert.ok(filtered.candidateSet.candidates.some((candidate) => candidate.adrId === '0002'), 'explicit reference bypasses retrieval');
console.log('PASS real manifest -> selection -> candidate policy -> comparison -> packet; fewer selective pair requests, obligation pending');
