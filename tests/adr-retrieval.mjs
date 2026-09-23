#!/usr/bin/env node
// Deterministic proof of the shared ADR retrieval layer (search_adrs /
// read_adr core: workflow/adr-retrieval.mjs). Fake backend seam at the
// provider boundary — NO live model inference, no GPU model load.
//
// Covers: an Architect query returns a known relevant synthetic ADR and the
// exact read follows (excerpt is explicitly NOT the full document), never
// historical evidence (the fake backend can only see the ADR-only
// materialization), empty vs missing/stale/failed index honesty (no fake
// "zero matches"), pinned snapshot/dirty root untouched, bounded paging of
// exact text, unsafe/unknown/ambiguous reference refusals, bounded limit.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readAdr, searchAdrs } from "../workflow/adr-retrieval.mjs";
import { contentVersionOf } from "../workflow/adr-corpus.mjs";
import { adrIndexWorkspace, updateAdrIndex } from "../workflow/adr-index.mjs";
import { buildCorpusRepo, commitFiles, fakeBackendFactory, syntheticAdr, syntheticAdrPath, tmpStateDir } from "./fixtures/adr-corpus/fixture.mjs";

const pass = (message) => console.log(`PASS ${message}`);

// ---------------------------------------------------------------------------
// Architect planning lookup -> known relevant synthetic ADR -> exact read
// ---------------------------------------------------------------------------
{
  const { root, revision } = buildCorpusRepo({ count: 2, prefix: "adr-retr-" });
  const stateDir = tmpStateDir();
  const backend = fakeBackendFactory();

  const search = await searchAdrs({
    stateDir,
    projectRoot: root,
    query: "topic-2",
    limit: 5,
    refreshIndex: true,
    backendFactory: backend,
  });
  assert.equal(search.ok, true, search.reason);
  assert.equal(search.status, "ok");
  assert.equal(search.results.length, 1, "the known relevant synthetic ADR is returned (topic-2 matches only ADR-0002)");
  const hit = search.results[0];
  assert.equal(hit.adrId, "0002");
  assert.equal(hit.path, syntheticAdrPath(2));
  assert.equal(hit.version, contentVersionOf(syntheticAdr(2, "topic-2")));
  assert.match(hit.version, /^sha256:/);
  assert.equal(hit.sourceRevision, revision, "results carry the committed source revision");
  assert.ok(hit.excerpt.length > 0 && hit.excerpt.length < syntheticAdr(2, "topic-2").length, "the excerpt is a bounded passage, NOT the full document");
  assert.equal(hit.excerptIsFullDocument, false, "the excerpt is explicitly not the full document");
  assert.match(hit.scoreKind, /NOT a similarity probability/);
  assert.equal(search.index.fresh, true);
  assert.equal(search.coverage.requestedLimit, 5);
  assert.equal(search.coverage.returned, 1);
  assert.equal(search.coverage.backendBounds.recallDepthPerRoute, 2000, "the backend 2000/route recall bound is surfaced");
  assert.match(search.coverage.backendBounds.note, /reranking never recovers unretrieved ADRs/);

  // Historical evidence NEVER surfaces: the fake backend only ever saw the
  // ADR-only materialization (asserted at the index boundary too).
  assert.deepEqual(backend.calls.index[0].files.sort(), [syntheticAdrPath(1), syntheticAdrPath(2)].sort(), "only ADR documents are in the search index");
  assert.ok(!JSON.stringify(search.results).includes("historical-evidence"), "historical evidence is never returned as an ADR result");

  // Exact read of the found ADR, paged: full exact committed bytes.
  const full = syntheticAdr(2, "topic-2");
  const page1 = await readAdr({ projectRoot: root, reference: "ADR-0002", limit: 40 });
  assert.equal(page1.ok, true, page1.reason);
  assert.equal(page1.totalChars, full.length);
  assert.equal(page1.complete, false, "paging continues");
  assert.equal(page1.text, full.slice(0, 40), "paged text is exact bytes");
  assert.equal(page1.version, hit.version);
  let gathered = page1.text;
  let cursor = page1;
  while (!cursor.complete) {
    cursor = await readAdr({ projectRoot: root, reference: "ADR-0002", offset: cursor.nextOffset, limit: 40 });
    assert.equal(cursor.ok, true);
    gathered += cursor.text;
  }
  assert.equal(gathered, full, "the paged read assembles the FULL exact document");
  assert.ok(gathered.length > hit.excerpt.length, "the excerpt is not the full document");

  // A tiny read stays bounded by the established chunk maximum.
  const single = await readAdr({ projectRoot: root, reference: "ADR-0002" });
  assert.equal(single.limit, 8192);
  pass("Architect query -> known relevant synthetic ADR -> exact paged read (never historical evidence)");
}

// ---------------------------------------------------------------------------
// Empty vs missing vs stale vs failed index honesty
// ---------------------------------------------------------------------------
{
  // Empty corpus: valid empty result, distinctly labelled (never an error).
  const emptyRepo = buildCorpusRepo({ count: 0, prefix: "adr-retr-empty-" });
  const empty = await searchAdrs({ stateDir: tmpStateDir(), projectRoot: emptyRepo.root, query: "anything", backendFactory: fakeBackendFactory() });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, "empty-corpus");
  assert.deepEqual(empty.results, []);
  assert.equal(empty.index.state, "empty");

  // Missing index without refresh: explicit unavailable/retryable — NEVER
  // "zero matches".
  const { root } = buildCorpusRepo({ count: 1, prefix: "adr-retr-missing-" });
  const stateDir = tmpStateDir();
  const missing = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", backendFactory: fakeBackendFactory() });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "index-missing");
  assert.equal(missing.retryable, true);
  assert.match(missing.reason, /NOT zero matches/);
  assert.equal(missing.results, undefined, "a failed search never returns a successful empty result set");

  // Failed index refresh: honest index-unavailable.
  const failedRefresh = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", refreshIndex: true, backendFactory: fakeBackendFactory({ failIndex: true }) });
  assert.equal(failedRefresh.ok, false);
  assert.equal(failedRefresh.status, "index-unavailable");

  // Failed search backend: explicit search-failed, results null (not []).
  const indexedBackend = fakeBackendFactory();
  await updateAdrIndex({ stateDir, projectRoot: root, backendFactory: indexedBackend });
  const failedSearch = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", backendFactory: fakeBackendFactory({ failSearch: true }) });
  assert.equal(failedSearch.ok, false);
  assert.equal(failedSearch.status, "search-failed");
  assert.equal(failedSearch.retryable, true);
  assert.equal(failedSearch.results, null, "a failed search must not fake a successful empty candidate set");

  // Unsupported backend is honest too.
  const unsupported = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", backendFactory: fakeBackendFactory({ failOpen: true }) });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, "search-unavailable");
  assert.match(unsupported.reason, /unavailable/);

  // Stale index: refuse to present passages as exact committed excerpts.
  commitFiles(root, { [syntheticAdrPath(1)]: `${syntheticAdr(1, "topic-1")}\nPublication change.\n` }, "publish");
  const stale = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", backendFactory: indexedBackend });
  assert.equal(stale.ok, false, "stale index cannot claim exact current passages");
  assert.equal(stale.status, "index-stale");
  assert.equal(stale.index.fresh, false);
  assert.equal(stale.results, null, "stale is not an empty successful result set");
  assert.match(stale.reason, /Refresh/);

  // refreshIndex heals staleness honestly.
  const refreshed = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", refreshIndex: true, backendFactory: fakeBackendFactory() });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.index.fresh, true);
  assert.equal(refreshed.results[0].version, contentVersionOf(`${syntheticAdr(1, "topic-1")}\nPublication change.\n`));
  pass("empty vs missing/stale/failed index is honest — never zero matches on a failed search");
}

// ---------------------------------------------------------------------------
// Reference refusals, dirty root, bounded limits
// ---------------------------------------------------------------------------
{
  const { root } = buildCorpusRepo({ count: 1, prefix: "adr-retr-ref-" });
  const unsafe = await readAdr({ projectRoot: root, reference: "docs/adr/README.md" });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.code, "unsafe-reference", "path-like references are refused as unsafe, never opened");
  const unknown = await readAdr({ projectRoot: root, reference: "ADR-404" });
  assert.equal(unknown.code, "unknown-reference");
  const malformed = await readAdr({ projectRoot: root, reference: "adr-0001" });
  assert.equal(malformed.code, "malformed-reference", "canonical references are case-sensitive");

  // Dirty root: read_adr returns committed bytes and leaves the tree alone.
  const dirtyPath = join(root, syntheticAdrPath(1));
  writeFileSync(dirtyPath, "DIRTY", "utf8");
  const dirtyRead = await readAdr({ projectRoot: root, reference: "ADR-0001" });
  assert.equal(dirtyRead.text, syntheticAdr(1, "topic-1"), "pinned committed bytes, never dirty worktree content");
  assert.equal(readFileSync(dirtyPath, "utf8"), "DIRTY", "the dirty root is unchanged");
  rmSync(dirtyPath, { force: true });

  // Bounded retrieval options.
  const stateDir = tmpStateDir();
  const clamped = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", limit: 5, refreshIndex: true, backendFactory: fakeBackendFactory() });
  assert.equal(clamped.coverage.requestedLimit, 5);
  const overLimit = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", limit: 500, backendFactory: fakeBackendFactory() });
  assert.equal(overLimit.coverage.requestedLimit, 50, "retrieval options are bounded at 50 results for the planning tool surface");
  assert.ok(overLimit.warnings.some((warning) => /clamped/.test(warning)), "clamping is explicit, never silent");
  const badLimit = await searchAdrs({ stateDir, projectRoot: root, query: "topic-1", limit: 0, backendFactory: fakeBackendFactory() });
  assert.equal(badLimit.ok, false);
  assert.equal(badLimit.code, "invalid-arguments");
  const noQuery = await searchAdrs({ stateDir, projectRoot: root, query: "  ", backendFactory: fakeBackendFactory() });
  assert.equal(noQuery.ok, false, "an empty query is an explicit invalid argument");
  assert.equal(noQuery.status, "invalid-arguments");
  pass("unsafe/unknown/non-canonical references are refused; dirty root untouched; limits are bounded");
}

console.log("Passed tests/adr-retrieval.mjs");
