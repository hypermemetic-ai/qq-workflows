// ADR corpus convention + pinned committed-snapshot reads.
//
// Purpose
// -------
// ONE narrow, discoverable convention for the project's architecture decision
// records so the shared ADR retrieval layer (Architect planning lookup + Jev
// candidate comparison) can read exact committed bytes:
//
//   * location:  `<projectRoot>/docs/adr/` (default; `ADR_CORPUS_DIR`),
//   * filename:  `ADR-<id>.md` or `ADR-<id>-<slug>.md`
//                `<id>`   = FIRST hyphen-delimited token after `ADR-`,
//                           strictly alphanumeric `[A-Za-z0-9]+` (the stable,
//                           safe identifier), e.g. `ADR-0007.md`,
//                `<slug>` = optional readable lowercase slug
//                           `[a-z0-9]+(-[a-z0-9]+)*`, e.g.
//                           `ADR-0007-use-postgres.md`,
//   * reference spelling (canonical, case-sensitive): `ADR-<id>`
//     (bare id) or the full stem `ADR-<id>-<slug>`. Resolution is exact-stem
//     first, then by UNIQUE id (the slug suffix is advisory); ambiguous ids
//     and unknown ids are explicit refusals, never a guess. `adr-0007` /
//     `Adr-0007` are NOT canonical references and are never resolved.
//   * version: `sha256:<hex>` over the exact UTF-8 bytes of the Markdown
//     content (content-hash version), plus the committed source revision
//     (full commit sha) the bytes were read from.
//
// Reads come ONLY from a pinned committed project snapshot via git plumbing
// (`ls-tree` / `cat-file` on one resolved commit) — never from dirty/stale
// worktree contents, never from the index, never from a second authority
// store. Historical/superseded decisions are NOT excluded by status: original
// rationale stays retrievable and supersession policy is not finalized here.
// Only actual ADR documents are corpus members; README/guides/tickets/
// reports/manifests/judgments are not (non `ADR-` files are ignored and
// listed transparently). There is no metadata framework and no history
// migration: the exact Markdown file IS the record.
//
// Fail-closed corpus validation (every condition is an explicit refusal with
// bounded offender lists, never a silent drop):
//   * an `ADR-*` file that violates the naming/location grammar,
//   * symlink/non-blob entries carrying `ADR-*` names (unsafe),
//   * two documents claiming the same `<id>` (duplicate/ambiguous id),
//   * non-UTF-8 content bytes (exact-byte versioning must stay honest),
//   * path-like/traversing references (unsafe reference strings).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const ADR_CORPUS_DIR = "docs/adr";

// `ADR-<id>[-<slug>]`: id is the first hyphen-delimited token (alphanumeric);
// the optional slug is lowercase-hyphen. Unambiguous by construction.
const ADR_STEM_RE = /^ADR-([A-Za-z0-9]+)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

const MAX_GIT_OUTPUT = 64 * 1024 * 1024; // bounded git plumbing output
const MAX_OFFENDERS = 20; // bounded offender detail lists

function clampList(items) {
  const list = [...items];
  return {
    count: list.length,
    entries: list.slice(0, MAX_OFFENDERS),
    truncated: list.length > MAX_OFFENDERS,
  };
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function contentVersionOf(content) {
  return `sha256:${sha256Hex(Buffer.from(content, "utf8"))}`;
}

async function runGit(cwd, args) {
  const { stdout } = await exec("git", args, { cwd, encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT });
  return stdout;
}

async function runGitText(cwd, args) {
  return (await runGit(cwd, args)).toString("utf8").trimEnd();
}

/**
 * Parse an ADR filename stem (no `.md`) or canonical reference into its
 * `{ adrId, slug, stem }` identity. `ok: false` means the string does not
 * match the convention grammar at all.
 */
export function parseAdrStem(stem) {
  if (typeof stem !== "string") return { ok: false, reason: "not a string" };
  const match = ADR_STEM_RE.exec(stem);
  if (!match) return { ok: false, reason: "does not match ADR-<id>[-<slug>]" };
  return { ok: true, adrId: match[1], slug: match[2] ?? null, stem };
}

/**
 * Whether a reference string is UNSAFE (path-like, traversal, NUL) as opposed
 * to merely unknown. Unsafe references are refused distinctly and are never
 * interpreted as paths.
 */
export function isUnsafeReference(reference) {
  if (typeof reference !== "string" || reference.trim() === "") return true;
  const value = reference.trim();
  return value !== reference
    || /[/\\]/.test(value)
    || value.includes("\0")
    || value.startsWith(".")
    || value.includes("..")
    || value.length > 128;
}

/**
 * Extract canonical `ADR-<id>[-<slug>]` references from verbatim text.
 * Case-SENSITIVE: `adr-0007` / `Adr-0007` are never extracted. Returns every
 * occurrence in order (duplicates preserved; callers dedupe).
 */
export function extractAdrReferences(text) {
  const out = [];
  if (typeof text !== "string") return out;
  // Capture a whole ADR-looking token before validation: an uppercase slug
  // must be reported as malformed, not silently shortened to a valid id.
  // Path-like mentions and filename citations are not canonical references.
  const re = /ADR-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const before = text[match.index - 1] ?? "";
    const after = text[re.lastIndex] ?? "";
    if (/[A-Za-z0-9/\\_-]/.test(before) || /[A-Za-z0-9/\\_-]/.test(after) || text.slice(re.lastIndex).startsWith(".md")) continue;
    out.push({ reference: match[0], index: match.index });
  }
  return out;
}

/**
 * Resolve ONE canonical reference against corpus entries (metadata only).
 * Exact-stem match first, then unique-id resolution (slug suffix advisory).
 * Ambiguous ids and unknown ids are explicit refusals — never a guess.
 */
export function resolveAdrReference(entries, reference) {
  if (isUnsafeReference(reference)) {
    return { ok: false, code: "unsafe-reference", reference, reason: `reference ${JSON.stringify(reference)} is path-like or unsafe; an ADR reference is an identifier, never a path` };
  }
  const parsed = parseAdrStem(reference);
  if (!parsed.ok) {
    return { ok: false, code: "malformed-reference", reference, reason: `reference ${JSON.stringify(reference)} is not a canonical ADR reference (expected ADR-<id> or ADR-<id>-<slug>, case-sensitive)` };
  }
  const byStem = entries.find((entry) => entry.stem === reference);
  if (byStem) return { ok: true, entry: byStem, resolvedBy: "stem" };
  const byId = entries.filter((entry) => entry.adrId === parsed.adrId);
  if (byId.length === 1) return { ok: true, entry: byId[0], resolvedBy: "id" };
  if (byId.length > 1) {
    return { ok: false, code: "ambiguous-reference", reference, candidates: clampList(byId.map((entry) => entry.stem)), reason: `reference '${reference}' is ambiguous: ${byId.length} ADR documents claim id '${parsed.adrId}'` };
  }
  return { ok: false, code: "unknown-reference", reference, reason: `no ADR document in the corpus claims id '${parsed.adrId}'` };
}

function refuse(code, reason, details = null) {
  return { ok: false, code, reason, ...(details ? { details } : {}) };
}

function validateCorpusDir(corpusDir) {
  if (typeof corpusDir !== "string" || corpusDir.trim() === "" || corpusDir !== corpusDir.trim()) {
    return refuse("unsafe-corpus-path", `corpusDir must be a non-empty trimmed relative path (got ${JSON.stringify(corpusDir)})`);
  }
  if (isAbsolute(corpusDir) || corpusDir.includes("\\") || corpusDir.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return refuse("unsafe-corpus-path", `corpusDir ${JSON.stringify(corpusDir)} must be a plain relative path without traversal`);
  }
  return { ok: true, value: posix.normalize(corpusDir) };
}

/**
 * Read the ADR corpus from ONE pinned committed project snapshot. The exact
 * Markdown bytes of every corpus member are returned with its content-hash
 * version and the committed source revision.
 *
 * Returns `{ ok: true, corpus }` or `{ ok: false, code, reason, details }`.
 * Conditions that invalidate the whole corpus (naming/location violations,
 * unsafe entries, duplicate ids, non-UTF-8 bytes) fail closed: an ambiguous or
 * unsafe corpus never partially resolves.
 */
export async function readAdrCorpus({ projectRoot, revision = "HEAD", corpusDir = ADR_CORPUS_DIR } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    return refuse("unsafe-root", "projectRoot is required: the ADR corpus is read from an explicit project repository, never a guessed root");
  }
  const root = resolve(projectRoot);
  const dirCheck = validateCorpusDir(corpusDir);
  if (!dirCheck.ok) return dirCheck;
  const dir = dirCheck.value;

  let sourceRevision;
  try {
    const isRepo = await runGitText(root, ["rev-parse", "--is-inside-work-tree"]);
    if (isRepo !== "true") return refuse("not-a-git-repository", `project root ${root} is not a git work tree; no committed ADR snapshot exists to read`);
    const topLevel = await runGitText(root, ["rev-parse", "--show-toplevel"]);
    if (resolve(topLevel) !== root) return refuse("unsafe-root", `projectRoot must name the repository top-level exactly; '${root}' is a nested or foreign root`);
  } catch {
    return refuse("not-a-git-repository", `project root ${root} is not a git work tree; no committed ADR snapshot exists to read`);
  }
  try {
    if (typeof revision !== "string" || revision.trim() === "" || revision !== revision.trim() || revision.startsWith("-")) {
      return refuse("unresolved-revision", `revision ${JSON.stringify(revision)} is not a safe commit-ish`);
    }
    sourceRevision = await runGitText(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
    if (!/^[0-9a-f]{40,64}$/.test(sourceRevision)) {
      return refuse("unresolved-revision", `revision ${JSON.stringify(revision)} did not resolve to a full commit sha`);
    }
  } catch (error) {
    return refuse("unresolved-revision", `revision ${JSON.stringify(revision)} could not be resolved in ${root}: ${String(error?.message ?? error)}`);
  }

  // Refuse symlink/foreign-root directory components in the committed tree.
  // A symlink at docs/adr itself otherwise makes recursive ls-tree return a
  // non-ADR blob and looks like a valid empty corpus.
  let prefix = "";
  for (const part of dir.split("/")) {
    prefix = prefix ? `${prefix}/${part}` : part;
    let node;
    try {
      node = (await runGit(root, ["ls-tree", "-z", sourceRevision, "--", prefix])).toString("utf8");
    } catch (error) {
      return refuse("corpus-unreadable", `the committed corpus directory '${prefix}' could not be inspected: ${String(error?.message ?? error)}`);
    }
    if (!node) break; // a genuinely absent corpus subtree is valid/empty
    const record = node.split("\0")[0];
    const [head, path] = record.split("\t");
    if (path === prefix && head?.split(" ")[1] !== "tree") {
      return refuse("unsafe-corpus-path", `the committed corpus directory '${prefix}' is a symlink or non-directory; refusing a foreign root`);
    }
  }

  let tree;
  try {
    tree = await runGit(root, ["ls-tree", "-r", "-z", "--full-tree", sourceRevision, "--", dir]);
  } catch (error) {
    return refuse("corpus-unreadable", `the committed tree for '${dir}' could not be listed: ${String(error?.message ?? error)}`);
  }

  const offenders = { names: [], locations: [], symlinks: [], };
  const ignored = [];
  const candidates = [];
  for (const record of tree.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const head = record.slice(0, tab).split(" ");
    const mode = head[0];
    const type = head[1];
    const blobSha = head[2];
    const path = record.slice(tab + 1);
    const rel = path === dir ? "" : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
    if (rel === null) continue; // outside the corpus subtree (defensive)
    const base = rel.split("/").pop();
    if (!base.startsWith("ADR-")) {
      ignored.push(path);
      continue;
    }
    if (rel.includes("/")) {
      offenders.locations.push(path);
      continue;
    }
    const parsed = parseAdrStem(base.endsWith(".md") ? base.slice(0, -3) : "");
    if (!base.endsWith(".md") || !parsed.ok) {
      offenders.names.push(path);
      continue;
    }
    if (mode !== "100644" || type !== "blob") {
      offenders.symlinks.push(path);
      continue;
    }
    candidates.push({ ...parsed, path, rel, blobSha });
  }

  const badNames = offenders.names.length > 0;
  const badLocations = offenders.locations.length > 0;
  const badSymlinks = offenders.symlinks.length > 0;
  if (badNames || badLocations || badSymlinks) {
    const parts = [];
    if (badNames) parts.push(`ADR-named files that violate the naming convention (expected ADR-<id>[-<slug>].md): ${JSON.stringify(clampList(offenders.names))}`);
    if (badLocations) parts.push(`ADR-named files outside the direct corpus directory (only ${dir}/ADR-*.md are ADR documents): ${JSON.stringify(clampList(offenders.locations))}`);
    if (badSymlinks) parts.push(`symlink/non-blob ADR-named entries are unsafe and refused: ${JSON.stringify(clampList(offenders.symlinks))}`);
    return refuse("invalid-corpus", parts.join("; "), offenders);
  }

  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Map();
  for (const candidate of candidates) {
    const list = seen.get(candidate.adrId) ?? [];
    list.push(candidate.stem);
    seen.set(candidate.adrId, list);
  }
  const duplicates = [...seen.entries()].filter(([, stems]) => stems.length > 1);
  if (duplicates.length > 0) {
    return refuse(
      "duplicate-id",
      `duplicate ADR ids refuse the whole corpus (an ambiguous id is never silently resolved): ${JSON.stringify(clampList(duplicates.map(([adrId, stems]) => ({ adrId, stems }))))}`,
      clampList(duplicates.map(([adrId, stems]) => ({ adrId, stems }))),
    );
  }

  const entries = [];
  for (const candidate of candidates) {
    let buffer;
    try {
      buffer = await runGit(root, ["cat-file", "blob", candidate.blobSha]);
    } catch (error) {
      return refuse("corpus-unreadable", `the committed bytes of '${candidate.path}' could not be read: ${String(error?.message ?? error)}`);
    }
    const content = buffer.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(buffer)) {
      return refuse("non-utf8-content", `the committed bytes of '${candidate.path}' are not valid UTF-8; exact-byte versioning refuses them`);
    }
    const contentSha256 = sha256Hex(buffer);
    entries.push({
      adrId: candidate.adrId,
      slug: candidate.slug,
      stem: candidate.stem,
      path: candidate.path,
      blobSha: candidate.blobSha,
      content,
      contentSha256,
      version: `sha256:${contentSha256}`,
    });
  }

  // Corpus hash covers ONLY the ADR documents (path + exact content hash), so
  // a commit that touches only non-ADR files never invalidates derived index
  // or candidate state. The committed source revision is provenance beside it.
  const corpusHash = sha256Hex(Buffer.from(entries.map((entry) => `${entry.path}\0${entry.contentSha256}\n`).join(""), "utf8"));

  return {
    ok: true,
    corpus: {
      corpusDir: dir,
      sourceRevision,
      corpusHash,
      version: `sha256:${corpusHash}`,
      entries,
      ignored: clampList(ignored),
    },
  };
}

/** Reference-only corpus summary (no prose) for results and receipts. */
export function corpusSummary(corpus) {
  return {
    corpusDir: corpus.corpusDir,
    sourceRevision: corpus.sourceRevision,
    corpusHash: corpus.corpusHash,
    count: corpus.entries.length,
    entries: corpus.entries.map((entry) => ({ adrId: entry.adrId, slug: entry.slug, stem: entry.stem, path: entry.path, version: entry.version })),
    ignored: corpus.ignored,
  };
}

/** The first markdown heading line of an ADR (deterministic candidate heading). */
export function adrHeading(content) {
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const match = /^(#{1,6})[ \t]+\S/.exec(line);
    if (match) return line.replace(/^#{1,6}[ \t]+/, "").trim();
  }
  return null;
}

/**
 * Read ONE ADR document's exact committed bytes by canonical reference at a
 * pinned revision. Bounded paging of the exact text is the caller's concern
 * (see workflow/adr-retrieval.mjs `readAdr`).
 */
export async function readAdrDocument({ projectRoot, reference, revision = "HEAD", corpusDir = ADR_CORPUS_DIR } = {}) {
  if (isUnsafeReference(reference)) {
    return refuse("unsafe-reference", `reference ${JSON.stringify(reference)} is path-like or unsafe; an ADR reference is an identifier, never a path`);
  }
  const loaded = await readAdrCorpus({ projectRoot, revision, corpusDir });
  if (!loaded.ok) return loaded;
  const corpus = loaded.corpus;
  const resolved = resolveAdrReference(corpus.entries, reference);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    entry: resolved.entry,
    resolvedBy: resolved.resolvedBy,
    sourceRevision: corpus.sourceRevision,
    corpusDir: corpus.corpusDir,
    corpusHash: corpus.corpusHash,
  };
}
