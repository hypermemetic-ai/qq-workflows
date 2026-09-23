#!/usr/bin/env node
// Production-adapter contract tests for the zvec-grep backend adapter
// (workflow/adr-index.mjs `resolveZvecModule` / `createZvecBackend`), per the
// operator's verification mandate: resolver/config/model selection and the
// ACTUAL index/query arguments via injected boundaries. NO live model load:
// the zvec-grep module itself is faked at the module/createZvecGrep boundary
// and the real resolver failure path uses a bogus specifier only.
//
// Verified wiring these tests pin down (see docs/adr-retrieval.md):
//   * the backend is `@zvec/zvec-grep` `createZvecGrep()` direct API — the
//     only route whose per-group `limit N` has no 50 cap (the MCP/daemon
//     route rejects limit > 50; CLI --json no longer exists);
//   * MODEL SELECTION: createZvecGrep is called with `{ root }` ONLY — no
//     embedding/model/apiKey/endpoint/device override — upstream resolves its
//     configured/default embedding; an effective Qwen model is NOT asserted;
//   * the index update is the plain `index()` (never rebuild/drop/ignore);
//   * search is ONE `context()` call (the single retrieval operation) with
//     caller-selected per-group limit, trace on and autoUpdate OFF;
//   * scores are reported as RRF rank fusion, NOT similarity — and the
//     separate `jinaai/jina-reranker-v3.5` wrapper (bin/zg-rerank.py) is
//     explicitly NOT part of this path (bare zg does not invoke Jina either).

import assert from "node:assert/strict";

import {
  DEFAULT_ZVEC_MODULE,
  ENV_ADR_ZVEC_MODULE,
  ZVEC_IDENTITY,
  ZVEC_RECALL_DEPTH_PER_ROUTE,
  ZVEC_SCORE_KIND,
  createZvecBackend,
  resolveZvecModule,
} from "../workflow/adr-index.mjs";

const pass = (message) => console.log(`PASS ${message}`);

// ---------------------------------------------------------------------------
// Resolver contract: declared package by default, explicit override only,
// honest unsupported state (never a silent fallback, never an implicit
// absolute-path import)
// ---------------------------------------------------------------------------
{
  const seen = [];
  const fakeModule = { createZvecGrep: async () => ({}) };
  const resolved = await resolveZvecModule({
    env: {},
    importImpl: async (specifier) => {
      seen.push(specifier);
      return fakeModule;
    },
  });
  assert.deepEqual(seen, [DEFAULT_ZVEC_MODULE], "the DECLARED package name is imported by default");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.module, fakeModule);
  assert.equal(resolved.configured, false);

  const override = await resolveZvecModule({
    env: { [ENV_ADR_ZVEC_MODULE]: "/explicit/operator/configured/module.mjs" },
    importImpl: async (specifier) => {
      seen.push(specifier);
      return fakeModule;
    },
  });
  assert.equal(override.ok, true);
  assert.equal(override.configured, true, "an absolute/alternate path is taken ONLY from explicit configuration");
  assert.equal(seen.at(-1), "/explicit/operator/configured/module.mjs");

  const broken = await resolveZvecModule({
    env: {},
    importImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.supported, false, "an unresolvable backend is an honest unsupported state");
  assert.match(broken.reason, /could not be imported/);
  assert.match(broken.reason, /never an empty result/);

  const wrongShape = await resolveZvecModule({ env: {}, importImpl: async () => ({}) });
  assert.equal(wrongShape.ok, false);
  assert.match(wrongShape.reason, /does not export createZvecGrep/);

  // Real import failure path (no model load happens at import; nothing is created).
  const real = await resolveZvecModule({ env: { [ENV_ADR_ZVEC_MODULE]: "@not-a-real/package-xyz" } });
  assert.equal(real.ok, false);
  assert.equal(real.supported, false);
  assert.equal(real.specifier, "@not-a-real/package-xyz");
  pass("backend resolver: declared package default, explicit-only override, honest unsupported state");
}

// ---------------------------------------------------------------------------
// createZvecBackend contract: actual create/index/context arguments
// ---------------------------------------------------------------------------
{
  const captured = { create: [], index: [], context: [] };
  const fakeGz = {
    async index(options) {
      captured.index.push(options);
      return { indexed: 3 };
    },
    async context(options) {
      captured.context.push(options);
      return {
        query: options.queries.join(" | "),
        root: "/derived/workspace",
        source: "index",
        coverage: "ranked_sample",
        groupResults: options.queries.map((text, i) => ({
          id: `g${i}`,
          query: text,
          role: "primary",
          items: [
            {
              kind: "indexed_entity",
              rank: 1,
              file: { relativePath: "docs/adr/ADR-0001.md", absolutePath: "/derived/workspace/docs/adr/ADR-0001.md" },
              content: "exact excerpt bytes",
              score: 0.34,
              matchedBy: "fts+vector",
              trace: { raw: "route scores live here" },
            },
          ],
        })),
        items: [],
        diagnostics: { index: { routes: [{ id: "fts", mode: "fts" }, { id: "vector", mode: "vector" }] } },
      };
    },
    async close() {},
  };
  const resolved = await resolveZvecModule({
    env: {},
    importImpl: async () => ({
      createZvecGrep: async (options) => {
        captured.create.push(options);
        return fakeGz;
      },
    }),
  });
  const backend = await createZvecBackend({ workspaceRoot: "/derived/workspace", resolved });

  // Model/config selection: root ONLY. Reusing the operator's existing
  // configured embedding stack means passing NO model override at all.
  assert.deepEqual(captured.create, [{ root: "/derived/workspace" }], "createZvecGrep receives exactly { root }: no embedding/model/apiKey/endpoint/device override is ever passed");
  assert.deepEqual(backend.createOptions, { root: "/derived/workspace" });
  assert.equal(backend.identity.embedding, ZVEC_IDENTITY.embedding);
  assert.match(backend.identity.jinaReranker, /NOT invoked/, "the Jina wrapper is explicitly NOT part of this path");
  assert.doesNotMatch(backend.identity.reranking, /jina/i, "zvec-grep RRF fusion is never described as Jina reranking");
  assert.equal(backend.identity.recallDepthPerRoute, ZVEC_RECALL_DEPTH_PER_ROUTE);
  assert.equal(ZVEC_RECALL_DEPTH_PER_ROUTE, 2000, "the verified per-route adaptive recall bound (200 -> 2000) is surfaced");

  // Index update: the plain index() on the derived workspace — never
  // rebuild/drop/ignore flags.
  const update = await backend.updateIndex({});
  assert.equal(update.ok, true);
  assert.deepEqual(captured.index, [{}], "index() is the exact plain update with no rebuild/drop/ignore flags");

  // Search: ONE context() call — the single retrieval operation — with the
  // caller-selected per-group limit (no 50 cap), trace on, autoUpdate off.
  const search = await backend.search({
    queries: [
      { id: "u1", role: "primary", text: "first evidence query" },
      { id: "u2", role: "primary", text: "second evidence query" },
    ],
    limit: 120,
  });
  assert.equal(search.ok, true);
  assert.equal(captured.context.length, 1, "retrieval is ONE retrieval operation (no separate rerank/model-decision stage)");
  const options = captured.context[0];
  assert.deepEqual(options.queries, ["first evidence query", "second evidence query"]);
  assert.equal(options.limit, 120, "a caller-selected per-group limit above 50 passes through the supported direct interface");
  assert.equal(options.trace, true, "structured trace is requested (raw route scores live in trace/evidence)");
  assert.equal(options.autoUpdate, false, "search never schedules index work");
  assert.equal(options.fuse, false, "query-group metadata is retained");

  // Result mapping preserves exact excerpts, trace, and honest score semantics.
  assert.equal(search.groups.length, 2);
  const item = search.groups[0].items[0];
  assert.equal(item.relativePath, "docs/adr/ADR-0001.md");
  assert.equal(item.excerpt, "exact excerpt bytes");
  assert.equal(item.score, 0.34);
  assert.equal(item.scoreKind, ZVEC_SCORE_KIND);
  assert.match(item.scoreKind, /NOT a similarity probability/);
  assert.deepEqual(item.trace, { raw: "route scores live here" });
  assert.deepEqual(search.diagnostics.routes, [{ id: "fts", mode: "fts" }, { id: "vector", mode: "vector" }]);

  // A thrown context() is an explicit failed search, never an empty result.
  const failing = await createZvecBackend({
    workspaceRoot: "/derived/workspace",
    resolved: await resolveZvecModule({ env: {}, importImpl: async () => ({ createZvecGrep: async () => ({ index: async () => ({}), context: async () => { throw new Error("engine exploded"); }, close: async () => {} }) }) }),
  });
  const failed = await failing.search({ queries: [{ id: "q", text: "x" }], limit: 5 });
  assert.equal(failed.ok, false);
  assert.equal(failed.retryable, true);
  assert.match(failed.message, /engine exploded/);
  pass("zvec adapter: root-only model/config reuse, plain index(), one context() call with per-group limit + trace, honest score semantics");
}

console.log("Passed tests/adr-zvec-adapter.mjs");
