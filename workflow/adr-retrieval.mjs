// Shared ADR retrieval for Architect planning lookup (`search_adrs`) and
// exact ADR reading (`read_adr`), over the pinned committed corpus and the
// derived ADR-only index (workflow/adr-corpus.mjs + workflow/adr-index.mjs).
//
// Contract
// --------
// * One narrow retrieval capability with exactly two uses: (1) let the
//   Architect find relevant ADRs while planning, (2) shrink Jev's ADR
//   comparison space (workflow/adr-candidates.mjs). There is no third
//   architectural judgment stage here: a lookup hit is relevance, never
//   automatic mandate, approval, or a decision.
// * Search is read/derived-index work: no publication, no Jev judgment and no
//   obligation state is required to look up an ADR, and nothing here persists
//   transcript or reasoning. The read-only default never mutates anything;
//   `refreshIndex: true` only refreshes the DERIVED index (state dir), never
//   the repository.
// * Results carry the stable ADR id/path/content-version/committed source
//   revision, an EXACT excerpt (explicitly not the full document — read_adr
//   pages the full exact text with the established bounded paging
//   convention), and honest source/index freshness plus bounded
//   coverage/errors. A failed or missing search NEVER reports "zero matches";
//   a true empty corpus is valid and distinctly labelled.

import {
  ADR_CORPUS_DIR,
  corpusSummary,
  extractAdrReferences,
  isUnsafeReference,
  readAdrCorpus,
  readAdrDocument,
  resolveAdrReference,
} from "./adr-corpus.mjs";
import {
  DEFAULT_ADR_INDEX_CONFIG,
  ZVEC_RECALL_DEPTH_PER_ROUTE,
  ZVEC_RECALL_ROUTES,
  ZVEC_SCORE_KIND,
  adrIndexStatus,
  defaultBackendFactory,
  updateAdrIndex,
} from "./adr-index.mjs";
import { REPORT_CHUNK_MAX } from "./reports.mjs";
import { bytePage } from './tool-output.mjs';

export const DEFAULT_SEARCH_LIMIT = 8;
/** Bounded tool retrieval option (distinct from the backend's per-route recall depth). */
export const MAX_SEARCH_LIMIT = 50;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function clampSearchLimit(limit, fallback = DEFAULT_SEARCH_LIMIT) {
  if (limit == null) return fallback;
  const value = Math.trunc(Number(limit));
  if (!Number.isFinite(value) || value < 1) throw fail("invalid-arguments", "limit must be a positive integer");
  return Math.min(value, MAX_SEARCH_LIMIT);
}

const backendBounds = Object.freeze({
  recallDepthPerRoute: ZVEC_RECALL_DEPTH_PER_ROUTE,
  recallRoutes: [...ZVEC_RECALL_ROUTES],
  scoreKind: ZVEC_SCORE_KIND,
  note: "hits are a ranked sample of at most the per-route adaptive recall depth before fusion; reranking never recovers unretrieved ADRs",
});

/**
 * Search the project's committed ADR corpus through the derived ADR-only
 * index. Bounded by `limit` (1..MAX_SEARCH_LIMIT). Read-only unless
 * `refreshIndex: true` explicitly refreshes the derived index first.
 */
export async function searchAdrs({
  stateDir,
  projectRoot,
  query,
  limit = DEFAULT_SEARCH_LIMIT,
  revision = "HEAD",
  corpusDir = ADR_CORPUS_DIR,
  config = DEFAULT_ADR_INDEX_CONFIG,
  refreshIndex = false,
  backendFactory = defaultBackendFactory,
  now = () => Date.now(),
} = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  if (typeof query !== "string" || query.trim() === "" || query.length > 4000) {
    return { ok: false, status: "invalid-arguments", code: "invalid-arguments", reason: "search_adrs requires a non-empty query of at most 4000 characters" };
  }
  let boundedLimit;
  const warnings = [];
  try {
    boundedLimit = clampSearchLimit(limit);
    if (limit != null && Math.trunc(Number(limit)) > MAX_SEARCH_LIMIT) {
      warnings.push(`limit ${Math.trunc(Number(limit))} exceeds the bounded retrieval maximum and was clamped to ${MAX_SEARCH_LIMIT}`);
    }
  } catch (error) {
    return { ok: false, status: "invalid-arguments", code: error.code ?? "invalid-arguments", reason: error.message };
  }

  const loaded = await readAdrCorpus({ projectRoot, revision, corpusDir });
  if (!loaded.ok) {
    // Invalid/unavailable source is honest and retryable-ish: never "no matches".
    return {
      ok: false,
      status: "corpus-invalid",
      code: loaded.code,
      retryable: loaded.code !== "duplicate-id" && loaded.code !== "invalid-corpus",
      reason: loaded.reason,
      details: loaded.details ?? null,
    };
  }
  const corpus = loaded.corpus;
  const source = corpusSummary(corpus);
  if (corpus.entries.length === 0) {
    return {
      ok: true,
      status: "empty-corpus",
      query,
      results: [],
      corpus: source,
      index: { state: "empty", fresh: false, note: "the committed corpus contains no ADR documents (a true empty corpus is valid)" },
      coverage: { requestedLimit: boundedLimit, returned: 0, backendBounds },
      warnings: [],
    };
  }

  let index = adrIndexStatus(stateDir, { corpus, config });
  let refreshed = null;
  if (refreshIndex && index.state !== "fresh") {
    refreshed = await updateAdrIndex({ stateDir, projectRoot, revision, corpusDir, config, corpus, backendFactory, now });
    if (!refreshed.ok) {
      return {
        ok: false,
        status: "index-unavailable",
        code: refreshed.code ?? "index-refresh-failed",
        retryable: refreshed.retryable !== false,
        reason: `the derived ADR index is not fresh and refreshing it failed: ${refreshed.reason}`,
        corpus: source,
        index: { state: index.state, fresh: false },
      };
    }
    index = adrIndexStatus(stateDir, { corpus, config });
  }
  if (index.state === "missing" || index.state === "corrupt") {
    return {
      ok: false,
      status: "index-missing",
      code: index.state === "corrupt" ? "index-corrupt" : "index-missing",
      retryable: true,
      reason: `${index.reason}. Build or refresh the derived ADR index (updateAdrIndex, or search_adrs with refreshIndex) and retry; this is an unavailable search, NOT zero matches.`,
      corpus: source,
      index: { state: index.state, fresh: false },
    };
  }
  if (index.state === "stale") {
    return {
      ok: false,
      status: "index-stale",
      code: "index-stale",
      retryable: true,
      reason: `${index.reason}. Refresh the derived index and retry; stale hits cannot be presented as exact committed excerpts.`,
      corpus: source,
      index: { state: "stale", fresh: false, receiptId: index.receipt?.receiptId ?? null },
      results: null,
    };
  }

  const opened = await backendFactory({ workspaceRoot: index.receipt.materialization?.workspace ?? null });
  if (!opened.ok) {
    return {
      ok: false,
      status: "search-unavailable",
      code: "unsupported-backend",
      retryable: true,
      reason: opened.reason,
      corpus: source,
      index: { state: index.state, fresh: index.fresh },
    };
  }
  try {
    const search = await opened.backend.search({ queries: [{ id: "primary", role: "primary", text: query.trim() }], limit: boundedLimit });
    if (!search.ok) {
      return {
        ok: false,
        status: "search-failed",
        code: "search-failed",
        retryable: search.retryable !== false,
        reason: search.message ?? "the ADR search backend failed",
        corpus: source,
        index: { state: index.state, fresh: index.fresh },
        // Explicitly NOT an empty successful result set.
        results: null,
      };
    }
    // Lift chunk hits to whole ADR identities. Versions come from the INDEXED
    // snapshot (the receipt) so a stale result honestly describes the bytes it
    // was built from — never the changed current corpus.
    const indexEntries = index.receipt?.corpus?.entries?.length
      ? index.receipt.corpus.entries
      : corpus.entries.map((entry) => ({ adrId: entry.adrId, slug: entry.slug, stem: entry.stem, path: entry.path, version: entry.version }));
    const byPath = new Map(indexEntries.map((entry) => [entry.path, entry]));
    const hitSourceRevision = index.receipt?.corpus?.sourceRevision ?? corpus.sourceRevision;
    const results = [];
    const seen = new Set();
    let unmappedHits = 0;
    for (const group of search.groups ?? []) {
      for (const item of group.items ?? []) {
        const entry = item.relativePath ? byPath.get(item.relativePath) : null;
        if (!entry) {
          unmappedHits += 1;
          continue;
        }
        if (seen.has(entry.adrId)) continue;
        seen.add(entry.adrId);
        results.push({
          adrId: entry.adrId,
          slug: entry.slug ?? null,
          stem: entry.stem,
          path: entry.path,
          version: entry.version,
          contentSha256: String(entry.version ?? "").startsWith("sha256:") ? String(entry.version).slice("sha256:".length) : null,
          sourceRevision: hitSourceRevision,
          // EXACT indexed bytes of one passage — explicitly NOT the full
          // document (read_adr pages the full exact text).
          excerpt: item.excerpt,
          excerptIsFullDocument: false,
          range: item.range,
          rank: item.rank,
          score: item.score,
          scoreKind: item.scoreKind ?? ZVEC_SCORE_KIND,
          matchedBy: item.matchedBy,
        });
      }
    }
    if (unmappedHits > 0) {
      warnings.push(`${unmappedHits} indexed hit(s) did not map to a corpus ADR document and were dropped (the derived index should contain ADR documents only)`);
    }
    const returnedPerGroup = (search.groups ?? []).map((group) => ({ id: group.id, requested: boundedLimit, returned: group.items.length, saturated: group.items.length >= boundedLimit }));
    return {
      ok: true,
      status: "ok",
      query: query.trim(),
      results,
      corpus: source,
      index: {
        state: index.state,
        fresh: index.fresh,
        receiptId: index.receipt?.receiptId ?? null,
        indexedAt: index.receipt?.indexedAt ?? null,
        builtForSourceRevision: index.receipt?.corpus?.sourceRevision ?? null,
        backend: index.receipt?.backend ?? null,
        ...(refreshed?.reindexed ? { refreshed: true } : {}),
      },
      coverage: {
        requestedLimit: boundedLimit,
        returned: results.length,
        groups: returnedPerGroup,
        saturationKnown: true,
        coverageKind: search.coverage ?? "ranked_sample",
        backendBounds,
      },
      warnings,
    };
  } finally {
    await opened.backend.close?.();
  }
}

/**
 * Read ONE ADR's full exact committed text by canonical reference, paged with
 * the established bounded paging convention (`offset`/`limit` → `nextOffset`
 * until `complete`). The version is the content-hash of the exact bytes.
 */
export async function readAdr({
  projectRoot,
  reference,
  adrId = null,
  revision = "HEAD",
  corpusDir = ADR_CORPUS_DIR,
  offset = 0,
  limit = REPORT_CHUNK_MAX,
} = {}) {
  const ref = reference ?? adrId;
  if (!stateGuard(projectRoot)) {
    return { ok: false, status: "invalid-arguments", code: "unsafe-root", reason: "read_adr requires an explicit project root" };
  }
  if (isUnsafeReference(ref)) {
    return { ok: false, status: "refused", code: "unsafe-reference", reason: `reference ${JSON.stringify(ref)} is path-like or unsafe; an ADR reference is an identifier, never a path` };
  }
  const start = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.min(Math.max(1, Math.trunc(limit) || REPORT_CHUNK_MAX), REPORT_CHUNK_MAX);
  const loaded = await readAdrDocument({ projectRoot, reference: ref, revision, corpusDir });
  if (!loaded.ok) {
    return {
      ok: false,
      status: loaded.code === "unknown-reference" || loaded.code === "ambiguous-reference" || loaded.code === "malformed-reference" || loaded.code === "unsafe-reference" ? "refused" : "corpus-invalid",
      code: loaded.code,
      reason: loaded.reason,
      ...(loaded.candidates ? { candidates: loaded.candidates } : {}),
    };
  }
  const { entry, resolvedBy, sourceRevision, corpusHash, corpusDir: dir } = loaded;
  const text = entry.content;
  return bytePage(text, start, size, {
    ok: true, status: 'ok', adrId: entry.adrId, slug: entry.slug, stem: entry.stem,
    path: entry.path, version: entry.version, contentSha256: entry.contentSha256,
    sourceRevision, corpus: { corpusDir: dir, corpusHash, sourceRevision },
    resolvedBy, offset: start, limit: size, totalChars: text.length,
  });
}

function stateGuard(projectRoot) {
  return typeof projectRoot === "string" && projectRoot.trim() !== "";
}

export { extractAdrReferences, resolveAdrReference, readAdrCorpus };
