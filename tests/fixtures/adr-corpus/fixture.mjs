// Transparently SYNTHETIC ADR corpus fixtures + fake retrieval backends for
// the ADR retrieval test suites ONLY. Every ADR document generated here is
// invented test content ("SYNTHETIC TEST ADR") and must never ship as a
// corpus fixture outside tests. No live model inference, no GPU model load,
// no real project reindex ever happens through these helpers.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd();
}

export function tmpRepo(prefix = "adr-corpus-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "adr-tests@example.invalid"]);
  git(root, ["config", "user.name", "ADR Tests"]);
  return root;
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

export function commitFiles(root, files, message) {
  writeFiles(root, files);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

export function tmpStateDir(prefix = "adr-index-state-") {
  return join(mkdtempSync(join(tmpdir(), prefix)), "state");
}

/**
 * One transparently synthetic ADR document body. `topic` words drive the
 * deterministic fake retrieval; the text is clearly labelled synthetic.
 */
export function syntheticAdr(n, topic = `topic-${n}`) {
  return [
    `# SYNTHETIC TEST ADR ${n}: ${topic}`,
    "",
    `> Transparently synthetic test fixture content. NOT a real architectural decision.`,
    "",
    `## Status`,
    "",
    `Synthetic-${n}`,
    "",
    `## Context`,
    "",
    `The synthetic fixture system ${topic} needs a deterministic corpus entry for retrieval tests. Vocabulary: ${topic} fixture vocabulary ${topic}.`,
    "",
    `## Decision`,
    "",
    `SYNTHETIC TEST ADR ${n} decides nothing real: the fixture uses ${topic} exclusively for deterministic retrieval ranking in tests.`,
    "",
  ].join("\n");
}

/** Filename for one synthetic ADR (convention: ADR-<id>[-<slug>].md). */
export function syntheticAdrPath(n, slug = null) {
  const id = String(n).padStart(4, "0");
  return `docs/adr/ADR-${id}${slug ? `-${slug}` : ""}.md`;
}

/**
 * Build a committed fixture repo with `count` synthetic ADRs (topics
 * `topic-N`), a non-ADR README in docs/adr (ignored by convention), and a
 * "historical evidence" doc that must never surface as an ADR result.
 */
export function buildCorpusRepo({ count = 2, prefix = "adr-corpus-", extraFiles = {} } = {}) {
  const root = tmpRepo(prefix);
  const files = {
    "docs/adr/README.md": "# ADR guide\n\nThis README is a guide, not an ADR document.\n",
    "docs/notes/historical-evidence.md": "# Historical evidence note\n\ntopic-0 evidence archive: this must NEVER surface as an ADR search result.\n",
    "src/app.js": "export const app = () => 'app';\n",
    ...extraFiles,
  };
  for (let n = 1; n <= count; n += 1) {
    files[syntheticAdrPath(n)] = syntheticAdr(n, `topic-${n}`);
  }
  const revision = commitFiles(root, files, `synthetic ADR corpus (${count})`);
  return { root, revision, count };
}

// ---------------------------------------------------------------------------
// Fake retrieval backends (the provider boundary tests inject at)
// ---------------------------------------------------------------------------

function walkFiles(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) out.push(...walkFiles(join(dir, dirent.name), rel));
    else out.push(rel);
  }
  return out;
}

const words = (text) => String(text).toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length > 2);

function bestExcerpt(content, queryText, span = 240) {
  const queryWords = new Set(words(queryText));
  const lines = String(content).split("\n");
  let best = 0;
  let bestStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const score = words(lines[i]).filter((word) => queryWords.has(word)).length;
    if (score > best) {
      best = score;
      bestStart = i;
    }
  }
  const text = lines.slice(bestStart, bestStart + 6).join("\n");
  return text.length > span ? text.slice(0, span) : text;
}

/**
 * Deterministic keyword-overlap search over EXACTLY the files captured at
 * `updateIndex` time (i.e. the ADR-only materialization). A hit is one chunk
 * per file with rank/RRF-like scores; nothing outside the captured files can
 * ever be returned (proving historical evidence never surfaces).
 */
export function fakeBackendFactory({
  failOpen = false,
  failIndex = false,
  failSearch = false,
  failSearchAfter = Infinity,
  hitFilter = null,
  onOpen = null,
  onIndex = null,
  onSearch = null,
  identityOverrides = {},
} = {}) {
  const calls = { open: [], index: [], search: [], close: 0 };
  // Index state persists per workspace root ACROSS backend instances, like the
  // real on-disk derived index (update and search may open separate handles).
  const indexes = new Map();
  let searchCount = 0;
  const factory = async ({ workspaceRoot = null, purpose = null } = {}) => {
    calls.open.push({ workspaceRoot, purpose });
    onOpen?.({ workspaceRoot, purpose });
    if (failOpen) return { ok: false, supported: false, reason: "fake backend unavailable (open failure)" };
    const backend = {
      identity: {
        name: "fake-zvec-backend",
        api: "fake",
        embedding: "fake (never a real model)",
        reranking: "fake",
        jinaReranker: "NOT invoked (fake seam)",
        recallDepthPerRoute: 2000,
        recallRoutes: ["fts", "vector"],
        scoreKind: "rrf-rank-fusion (rank-based, NOT a similarity probability; no score cutoff is applied)",
        ...identityOverrides,
      },
      async updateIndex({} = {}) {
        if (failIndex) return { ok: false, retryable: true, reason: "fake index failure" };
        const files = new Map();
        for (const rel of walkFiles(workspaceRoot)) files.set(rel, readFileSync(join(workspaceRoot, rel), "utf8"));
        indexes.set(workspaceRoot, files);
        const names = [...files.keys()];
        onIndex?.(names);
        calls.index.push({ root: workspaceRoot, files: names });
        return { ok: true, result: { indexed: names.length } };
      },
      async search({ queries, limit } = {}) {
        searchCount += 1;
        calls.search.push({ queries: queries.map((query) => ({ id: query.id, text: query.text })), limit });
        onSearch?.({ queries, limit, call: searchCount });
        if (failSearch || searchCount > failSearchAfter) {
          return { ok: false, retryable: true, errorType: "SEARCH_FAILED", message: "fake search failure" };
        }
        const files = indexes.get(workspaceRoot) ?? new Map();
        const groups = (queries ?? []).map((query) => {
          const queryWords = new Set(words(query.text));
          const scored = [];
          for (const [rel, content] of files) {
            if (hitFilter && !hitFilter(rel, content, query)) continue;
            const score = words(content).filter((word) => queryWords.has(word)).length;
            if (score <= 0) continue;
            scored.push({ rel, content, score });
          }
          scored.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : 1));
          const items = scored.slice(0, limit).map((entry, index) => ({
            relativePath: entry.rel,
            absolutePath: join(workspaceRoot, entry.rel),
            excerpt: bestExcerpt(entry.content, query.text),
            range: { startLine: 1, endLine: 6 },
            rank: index + 1,
            score: 1 / (index + 2),
            scoreKind: "rrf-rank-fusion (rank-based, NOT a similarity probability; no score cutoff is applied)",
            matchedBy: "fake-hybrid",
            trace: { fake: true },
          }));
          return { id: query.id, query: query.text, role: query.role ?? "primary", items };
        });
        return {
          ok: true,
          groups,
          items: groups.flatMap((group) => group.items),
          source: "index",
          coverage: "ranked_sample",
          diagnostics: { emptyReason: groups.every((group) => group.items.length === 0) ? "no_matches" : null, index: { routes: [{ id: "fts", mode: "fts" }, { id: "vector", mode: "vector" }] } },
        };
      },
      async close() {
        calls.close += 1;
      },
    };
    return { ok: true, supported: true, backend, specifier: "fake://zvec" };
  };
  factory.calls = calls;
  return factory;
}

export const SYNTHETIC_NOTE = "Transparently synthetic test fixture content. NOT a real architectural decision.";
