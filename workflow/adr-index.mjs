// ADR-only derived index: materialization, receipts, and the pinned zvec-grep
// backend adapter.
//
// Purpose
// -------
// ONE derived ADR-only search index beside the shared ADR retrieval layer. The
// index root is a derived MATERIALIZATION of the pinned corpus under the
// workflow state dir (`<stateDir>/adr-index/workspace/`) — so what is indexed
// is actually limited to the ADR documents (never README/guides/tickets/
// reports/manifests/judgments/history evidence), instead of query-filtering a
// whole historical evidence index. The materialization and its receipts are
// derived/operational content living OUTSIDE the indexed docs and outside the
// repository; they are never a second knowledge or authority store (the
// committed project snapshot stays the only authority).
//
// `updateAdrIndex` is the narrow, independently retryable index/update helper
// the next publisher phase invokes after exact ADR publication. It records
// corpus/config/index freshness in one receipt and skips reindexing when only
// non-ADR files changed (freshness is keyed on the ADR-only corpus hash).
// There is no job, scheduler, background worker, wakeup, or historical
// backfill here.
//
// Backend (the ONE retrieval surface — reuse, not a new service):
// `@zvec/zvec-grep` `createZvecGrep()` + `index()` / `context()` — the
// existing repository indexing/embedding stack, direct API (supports
// caller-selected per-group `limit N` with no 50 cap; the MCP/daemon route
// rejects `limit > 50`). Model wiring is REUSED, never changed: this adapter
// passes no embedding/model/apiKey/endpoint/device override, so the operator's
// existing local zg embedding configuration applies (the @zvec/zvec-grep
// 0.2.1 catalog includes Qwen-family models, but an unconfigured new index
// may use its default local/potion-code-16m-v2). Ranking is zvec-grep's
// own hybrid FTS+vector recall with RRF rank fusion: `item.score` is a
// rank-based fusion score, NOT a similarity probability, and no score cutoff
// exists or is applied. The separate local `jinaai/jina-reranker-v3.5`
// wrapper (`bin/zg-rerank.py`) is NOT invoked by this path and bare zg does
// not invoke it either — deliberately omitted (it is a standalone tool with
// its own GPU/model load and its20/5 defaults are not ADR candidate ceilings).
// One context() call IS the single retrieval operation; no separate rerank or
// model-decision stage is added here.
//
// The module specifier is resolved explicitly (`QQ_ADR_ZVEC_MODULE` or the
// declared package name `@zvec/zvec-grep`); an unresolvable backend is an
// honest `unsupported` state, never a silent fallback and never an
// undeclared absolute-path import.

import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readAdrCorpus } from "./adr-corpus.mjs";
import { canonicalJson, sha256Hex } from "./adr-jev-cache.mjs";

export const ADR_INDEX_SCHEMA = "adr-index-receipt";
export const ADR_INDEX_SCHEMA_VERSION = 1;

/** The one supported backend module (declared package name). */
export const DEFAULT_ZVEC_MODULE = "@zvec/zvec-grep";
/** Explicit resolver/configuration override (absolute paths only via this). */
export const ENV_ADR_ZVEC_MODULE = "QQ_ADR_ZVEC_MODULE";

/**
 * Observed bound of @zvec/zvec-grep 0.2.1 adaptive recall depth per route
 * (dist/engine/pipeline/search/index.js: RECALL_INITIAL_DEPTH 200 growing to
 * RECALL_MAX_DEPTH 2000, per FTS/vector route). Surfaced honestly in every
 * retrieval receipt: hits are a ranked sample of at most this many recalled
 * items per route before fusion — reranking never recovers unretrieved ADRs.
 */
export const ZVEC_RECALL_DEPTH_PER_ROUTE = 2000;
export const ZVEC_RECALL_ROUTES = Object.freeze(["fts", "vector"]);
/** `item.score` semantics (verified in the pinned backend). */
export const ZVEC_SCORE_KIND = "rrf-rank-fusion (rank-based, NOT a similarity probability; no score cutoff is applied)";

export const ZVEC_IDENTITY = Object.freeze({
  name: "@zvec/zvec-grep",
  api: "createZvecGrep().index() / .context() (direct API)",
  embedding: "operator-local zg embedding configuration (Qwen-family catalog in @zvec/zvec-grep 0.2.1); never overridden here",
  reranking: "zvec-grep internal hybrid FTS+vector recall with RRF rank fusion (one retrieval operation)",
  jinaReranker: "NOT invoked: bin/zg-rerank.py (jinaai/jina-reranker-v3.5) is a separate standalone wrapper, deliberately omitted from this path",
  recallDepthPerRoute: ZVEC_RECALL_DEPTH_PER_ROUTE,
  recallRoutes: ZVEC_RECALL_ROUTES,
  scoreKind: ZVEC_SCORE_KIND,
});

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function adrIndexDir(stateDir) {
  return join(stateDir, "adr-index");
}

export function adrIndexWorkspace(stateDir) {
  return join(adrIndexDir(stateDir), "workspace");
}

export function adrIndexReceiptPath(stateDir) {
  return join(adrIndexDir(stateDir), "index-receipt.json");
}

/** Index configuration (bounded, versioned). `corpusDir` binds the subtree. */
export const DEFAULT_ADR_INDEX_CONFIG = Object.freeze({
  schema: "adr-index-config",
  version: 1,
});

export function indexConfigHash(config = DEFAULT_ADR_INDEX_CONFIG) {
  return sha256Hex(Buffer.from(canonicalJson(config), "utf8"));
}

// ---------------------------------------------------------------------------
// Backend resolver (explicit; honest unsupported state — never a silent
// fallback, never an undeclared absolute-path import)
// ---------------------------------------------------------------------------

/**
 * Resolve the pinned zvec-grep module. The default is the DECLARED package
 * name `@zvec/zvec-grep`; an absolute/alternate path may only be supplied
 * explicitly through `QQ_ADR_ZVEC_MODULE`. Resolution failure is an honest
 * `supported: false` result with the exact reason — the caller must surface it,
 * never fabricate empty search results.
 */
export async function resolveZvecModule({ env = process.env, importImpl = (specifier) => import(specifier) } = {}) {
  const override = String(env?.[ENV_ADR_ZVEC_MODULE] ?? "").trim();
  const specifier = override || DEFAULT_ZVEC_MODULE;
  let module;
  try {
    module = await importImpl(specifier);
  } catch (error) {
    return {
      ok: false,
      supported: false,
      specifier,
      configured: Boolean(override),
      reason: `the ADR retrieval backend module '${specifier}' could not be imported (${String(error?.message ?? error).slice(0, 200)}); set ${ENV_ADR_ZVEC_MODULE} to the installed @zvec/zvec-grep module, or run without ADR search (this is reported honestly, never an empty result)`,
    };
  }
  if (typeof module?.createZvecGrep !== "function") {
    return {
      ok: false,
      supported: false,
      specifier,
      configured: Boolean(override),
      reason: `module '${specifier}' does not export createZvecGrep; the ADR retrieval backend is unsupported in this environment`,
    };
  }
  return { ok: true, supported: true, specifier, configured: Boolean(override), module };
}

/**
 * The production backend adapter over ONE workspace root. All actual
 * index/query arguments are issued here (and only here), which is the seam
 * production-adapter contract tests inject against.
 *
 * `createOptions` is deliberately `{ root }` only: no embedding/model/apiKey/
 * endpoint/device override is ever passed (model selection = the operator's
 * existing local zg configuration). `updateIndex` runs the exact plain index
 * update (never rebuild/drop/ignore flags). `search` runs ONE `context()` call
 * (the single retrieval operation) with the caller-selected per-group limit
 * and `autoUpdate: false` (search never schedules index work).
 */
export async function createZvecBackend({ workspaceRoot, resolved, createImpl = null } = {}) {
  if (!resolved?.ok) throw fail("unsupported-backend", resolved?.reason ?? "the zvec-grep backend module is not resolved");
  const root = resolve(workspaceRoot);
  const create = createImpl ?? ((options) => resolved.module.createZvecGrep(options));
  const createOptions = { root };
  const zg = await create(createOptions);
  return {
    identity: { ...ZVEC_IDENTITY, moduleSpecifier: resolved.specifier },
    workspaceRoot: root,
    createOptions,
    async updateIndex({ signal } = {}) {
      try {
        const result = await zg.index({ ...(signal ? { signal } : {}) });
        return { ok: true, result: summarizeIndexResult(result) };
      } catch (error) {
        return { ok: false, retryable: true, reason: `zvec-grep index update failed: ${String(error?.message ?? error).slice(0, 300)}` };
      }
    },
    async search({ queries, limit, trace = true } = {}) {
      const texts = queries.map((query) => query.text);
      const contextOptions = { queries: texts, limit, trace, fuse: false, autoUpdate: false };
      let result;
      try {
        result = await zg.context(contextOptions);
      } catch (error) {
        return { ok: false, retryable: true, errorType: "SEARCH_FAILED", message: `zvec-grep search failed: ${String(error?.message ?? error).slice(0, 300)}` };
      }
      return { ok: true, ...mapContextResult(result, queries), contextOptions };
    },
    async close() {
      try { await zg.close(); } catch { /* close is best effort */ }
    },
  };
}

function summarizeIndexResult(result) {
  if (!result || typeof result !== "object") return { returned: result ?? null };
  const out = {};
  for (const key of ["indexed", "skipped", "removed", "files", "durationMs", "status"]) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

function mapContextResult(result, queries) {
  const groups = [];
  const source = result?.source ?? null;
  const coverage = result?.coverage ?? null;
  const diagnostics = result?.diagnostics ?? null;
  const rawGroups = Array.isArray(result?.groupResults) && result.groupResults.length > 0
    ? result.groupResults
    : queries.map((query) => ({
      id: query.id,
      query: query.text,
      role: query.role ?? "primary",
      items: (result?.items ?? []).filter((item) => (item.queryGroups ?? []).some((group) => group.id === query.id)),
    }));
  for (const group of rawGroups) {
    groups.push({
      id: group.id ?? null,
      query: group.query ?? "",
      role: group.role ?? "primary",
      items: (group.items ?? []).map(mapItem),
    });
  }
  return {
    groups,
    items: (result?.items ?? []).map(mapItem),
    source,
    coverage,
    diagnostics: {
      emptyReason: diagnostics?.emptyReason ?? null,
      index: diagnostics?.index ?? null,
      routes: diagnostics?.index?.routes ?? null,
      timings: diagnostics?.timings ?? null,
    },
  };
}

function mapItem(item) {
  return {
    relativePath: item?.file?.relativePath ?? null,
    absolutePath: item?.file?.absolutePath ?? null,
    excerpt: typeof item?.content === "string" ? item.content : "",
    range: item?.range ?? null,
    rank: typeof item?.rank === "number" ? item.rank : null,
    score: typeof item?.score === "number" ? item.score : null,
    scoreKind: ZVEC_SCORE_KIND,
    matchedBy: item?.matchedBy ?? null,
    trace: item?.trace ?? null,
  };
}

// ---------------------------------------------------------------------------
// Receipts (operational, subordinate, outside indexed docs)
// ---------------------------------------------------------------------------

function integrityOf(entry) {
  const rest = { ...entry };
  delete rest.integrity;
  return { algorithm: "sha256", payloadSha256: sha256Hex(Buffer.from(canonicalJson(rest), "utf8")) };
}

function writeReceipt(stateDir, receipt) {
  const dir = adrIndexDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entry = { ...receipt, integrity: integrityOf(receipt) };
  const path = adrIndexReceiptPath(stateDir);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return entry;
}

/** Read the latest index receipt. Corrupt receipts are reported, never trusted. */
export function readAdrIndexReceipt(stateDir) {
  const path = adrIndexReceiptPath(stateDir);
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return existsSync(path)
      ? { ok: false, corrupt: true, reason: `the ADR index receipt is unreadable/corrupt: ${String(error?.message ?? error)}` }
      : { ok: false, missing: true, reason: "no ADR index receipt exists yet (the derived ADR index has not been built)" };
  }
  if (!entry || typeof entry !== "object" || entry.schema !== ADR_INDEX_SCHEMA || entry.schemaVersion !== ADR_INDEX_SCHEMA_VERSION) {
    return { ok: false, corrupt: true, reason: "the ADR index receipt carries an unknown schema/version" };
  }
  const expected = integrityOf(entry).payloadSha256;
  if (entry.integrity?.payloadSha256 !== expected) {
    return { ok: false, corrupt: true, reason: "the ADR index receipt failed its sha256 integrity check" };
  }
  return { ok: true, receipt: entry };
}

/**
 * Honest index freshness vs the current corpus/config. Never claims fresh on
 * a missing/corrupt receipt, never claims zero matches on a failed state.
 */
export function adrIndexStatus(stateDir, { corpus, config = DEFAULT_ADR_INDEX_CONFIG } = {}) {
  if (!corpus?.entries?.length) {
    return { state: "empty", fresh: false, reason: "the committed corpus contains no ADR documents (a true empty corpus is valid and needs no index)" };
  }
  const read = readAdrIndexReceipt(stateDir);
  if (!read.ok) {
    return { state: read.corrupt ? "corrupt" : "missing", fresh: false, reason: read.reason };
  }
  const receipt = read.receipt;
  const configHash = indexConfigHash(config);
  if (receipt.corpus?.corpusHash !== corpus.corpusHash) {
    return { state: "stale", fresh: false, reason: "the derived ADR index was built for a different ADR corpus (new/changed ADR content); refresh it to search current bytes", receipt };
  }
  if (receipt.config?.configHash !== configHash) {
    return { state: "stale", fresh: false, reason: "the derived ADR index was built with a different index configuration; refresh it to search under the current config", receipt };
  }
  if (!workspaceIntact(stateDir, corpus, receipt.backend)) {
    return { state: "stale", fresh: false, reason: "the derived ADR materialization no longer matches the indexed corpus bytes; refresh it", receipt };
  }
  return { state: "fresh", fresh: true, reason: null, receipt };
}

function workspaceIntact(stateDir, corpus, backend) {
  const workspace = adrIndexWorkspace(stateDir);
  const expected = corpus.entries.map((entry) => entry.path).sort();
  // zvec-grep stores its operational index in <root>/.zvec-grep. The scanner
  // explicitly skips that directory; it is NOT corpus material to index.
  const indexHome = join(workspace, ".zvec-grep");
  if (backend?.name === DEFAULT_ZVEC_MODULE && !existsSync(indexHome)) return false;
  if (existsSync(indexHome) && (lstatSync(indexHome).isSymbolicLink() || !lstatSync(indexHome).isDirectory())) return false;
  if (JSON.stringify(listWorkspaceFiles(stateDir).sort()) !== JSON.stringify(expected)) return false;
  for (const entry of corpus.entries) {
    const path = join(workspace, ...entry.path.split("/"));
    try {
      let parent = workspace;
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) return false;
      for (const part of entry.path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) return false;
      }
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return false;
      if (sha256Hex(readFileSync(path)) !== entry.contentSha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Derived ADR-only materialization (exact bytes; derived, never authoritative)
// ---------------------------------------------------------------------------

function assertWorkspacePath(workspace, target) {
  const rel = relative(workspace, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(target) !== join(workspace, rel)) {
    throw fail("unsafe-workspace", `refusing to write outside the derived ADR workspace: ${target}`);
  }
  return target;
}

/**
 * Materialize the corpus's exact bytes into the derived ADR-only workspace and
 * remove anything else (the workspace is regenerable derived content, so it
 * always equals EXACTLY the corpus — that is what limits the index to ADR
 * documents). A pre-existing workspace symlink is refused (unsafe).
 */
export function materializeAdrCorpus(stateDir, corpus) {
  const dir = adrIndexDir(stateDir);
  const workspace = adrIndexWorkspace(stateDir);
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) {
    throw fail("unsafe-workspace", `the derived ADR index directory ${dir} is a symlink or non-directory; refusing to follow it`);
  }
  if (existsSync(workspace)) {
    const stat = lstatSync(workspace);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw fail("unsafe-workspace", `the derived ADR workspace ${workspace} exists but is a symlink or non-directory; refusing to follow or replace it`);
    }
    // Preserve the backend's own .zvec-grep index home: deleting the whole
    // root destroys the just-built index on every subsequent refresh. Remove
    // all other derived files instead; the indexed content remains ADR-only.
    for (const child of readdirSync(workspace)) {
      const target = join(workspace, child);
      if (child === ".zvec-grep") {
        if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) {
          throw fail("unsafe-workspace", "the derived ADR backend index home is a symlink or non-directory");
        }
      } else rmSync(target, { recursive: true, force: true });
    }
  }
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const entry of corpus.entries) {
    const target = assertWorkspacePath(workspace, join(workspace, ...entry.path.split("/")));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, Buffer.from(entry.content, "utf8"), { mode: 0o600 });
    files.push({ path: entry.path, version: entry.version });
  }
  return { workspace, files };
}

/** Walk the derived workspace (what the index backend actually sees). */
export function listWorkspaceFiles(stateDir) {
  const workspace = adrIndexWorkspace(stateDir);
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!prefix && dirent.name === ".zvec-grep") continue; // backend index home, not indexed documents
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) walk(join(dir, dirent.name), rel);
      else out.push(rel);
    }
  };
  walk(workspace, "");
  return out;
}

// ---------------------------------------------------------------------------
// The narrow index/update helper (for the next publisher phase; retryable)
// ---------------------------------------------------------------------------

/**
 * Build or refresh the derived ADR index from the pinned corpus snapshot.
 * Idempotent and independently retryable: a corpus whose hash already matches
 * the receipt (and an intact materialization) returns `status: "up-to-date"`
 * WITHOUT touching the backend — so a commit that changes only non-ADR files
 * never triggers a reindex. A publication-style ADR content change (new
 * corpus hash) or a config change rebuilds. Backend failure is an explicit
 * `status: "failed"` retryable result and NEVER records a fresh receipt.
 *
 * This helper performs no git publication, copies no ADR text through
 * implementer cycles, and schedules nothing.
 */
export async function updateAdrIndex({
  stateDir,
  projectRoot,
  revision = "HEAD",
  corpusDir,
  config = DEFAULT_ADR_INDEX_CONFIG,
  corpus = null,
  backend = null,
  backendFactory = null,
  force = false,
  now = () => Date.now(),
} = {}) {
  if (!stateDir) throw fail("invalid-arguments", "stateDir is required");
  let effectiveCorpus = corpus;
  if (!effectiveCorpus) {
    const loaded = await readAdrCorpus({ projectRoot, revision, ...(corpusDir ? { corpusDir } : {}) });
    if (!loaded.ok) return { ok: false, status: "failed", retryable: false, code: loaded.code, reason: loaded.reason, details: loaded.details ?? null };
    effectiveCorpus = loaded.corpus;
  }
  const configHash = indexConfigHash(config);
  const base = {
    corpus: {
      corpusHash: effectiveCorpus.corpusHash,
      sourceRevision: effectiveCorpus.sourceRevision,
      corpusDir: effectiveCorpus.corpusDir,
      count: effectiveCorpus.entries.length,
      entries: effectiveCorpus.entries.map((entry) => ({ adrId: entry.adrId, slug: entry.slug, stem: entry.stem, path: entry.path, version: entry.version })),
    },
    config: { ...config, configHash },
    backend: backend ? { ...backend.identity } : null,
  };

  if (effectiveCorpus.entries.length === 0) {
    return { ok: true, status: "empty-corpus", ...base, note: "the committed corpus contains no ADR documents; nothing is materialized or indexed (a true empty corpus is valid)" };
  }

  if (!force) {
    const status = adrIndexStatus(stateDir, { corpus: effectiveCorpus, config });
    if (status.state === "fresh") {
      return { ok: true, status: "up-to-date", ...base, receipt: status.receipt, reindexed: false, note: "the derived ADR index already matches this ADR corpus and config; nothing was reindexed" };
    }
  }

  let materialization;
  try {
    materialization = materializeAdrCorpus(stateDir, effectiveCorpus);
  } catch (error) {
    return { ok: false, status: "failed", retryable: false, ...base, code: error?.code ?? "unsafe-workspace", reason: String(error?.message ?? error) };
  }

  let activeBackend = backend;
  let opened = null;
  if (!activeBackend) {
    const factory = backendFactory ?? defaultBackendFactory;
    opened = await factory({ workspaceRoot: materialization.workspace });
    if (!opened.ok) {
      return { ok: false, status: "failed", retryable: true, ...base, code: "unsupported-backend", reason: opened.reason };
    }
    activeBackend = opened.backend;
    base.backend = { ...activeBackend.identity };
  }
  try {
    const update = await activeBackend.updateIndex({});
    if (!update.ok) {
      return { ok: false, status: "failed", retryable: update.retryable !== false, ...base, materialization: materialization.files, reason: update.reason };
    }
    const receipt = writeReceipt(stateDir, {
      schema: ADR_INDEX_SCHEMA,
      schemaVersion: ADR_INDEX_SCHEMA_VERSION,
      receiptId: `adridx-${sha256Hex(Buffer.from(`${effectiveCorpus.corpusHash}\n${configHash}\n${activeBackend.identity.name}`, "utf8")).slice(0, 32)}`,
      indexedAt: now(),
      ...base,
      status: "fresh",
      materialization: { workspace: materialization.workspace, files: materialization.files },
      indexUpdate: update.result ?? null,
    });
    return { ok: true, status: "indexed", ...base, receipt, reindexed: true, materialization: materialization.files };
  } finally {
    if (opened?.backend) await opened.backend.close?.();
  }
}

/** The default production backend factory (explicit resolver + adapter above). */
export async function defaultBackendFactory({ workspaceRoot, env = process.env, importImpl } = {}) {
  const resolved = await resolveZvecModule({ env, ...(importImpl ? { importImpl } : {}) });
  if (!resolved.ok) return { ok: false, supported: false, reason: resolved.reason, specifier: resolved.specifier };
  try {
    const backend = await createZvecBackend({ workspaceRoot, resolved });
    return { ok: true, supported: true, backend, specifier: resolved.specifier };
  } catch (error) {
    return { ok: false, supported: false, reason: `the zvec-grep backend could not be opened for ${workspaceRoot}: ${String(error?.message ?? error).slice(0, 200)}`, specifier: resolved.specifier };
  }
}
