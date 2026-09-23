#!/usr/bin/env node
// Deterministic proof of the ADR corpus convention + pinned committed-snapshot
// reads (workflow/adr-corpus.mjs). Real git fixture repos with TRANSPARENTLY
// SYNTHETIC ADRs (tests only) — no live model inference, no indexing, no state
// outside temp dirs.
//
// Covers: naming/reference grammar (id vs advisory slug), case-sensitive
// canonical references, exact committed bytes despite a dirty root (and the
// dirty root stays untouched), pinned source revision, content-hash versions,
// corpus hash that ignores non-ADR commits (no needless reindex signal),
// publication-style ADR change invalidation, README/guides not being ADRs,
// duplicate-id / invalid-name / invalid-location / symlink refusals, unsafe
// path-like references, non-git and unresolved-revision honesty.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADR_CORPUS_DIR,
  contentVersionOf,
  extractAdrReferences,
  isUnsafeReference,
  parseAdrStem,
  readAdrCorpus,
  readAdrDocument,
  resolveAdrReference,
} from "../workflow/adr-corpus.mjs";
import { buildCorpusRepo, commitFiles, git, syntheticAdr, syntheticAdrPath, tmpRepo, writeFiles } from "./fixtures/adr-corpus/fixture.mjs";

const pass = (message) => console.log(`PASS ${message}`);

// ---------------------------------------------------------------------------
// Naming / reference grammar
// ---------------------------------------------------------------------------
{
  assert.deepEqual(parseAdrStem("ADR-0007"), { ok: true, adrId: "0007", slug: null, stem: "ADR-0007" });
  assert.deepEqual(parseAdrStem("ADR-0007-use-postgres"), { ok: true, adrId: "0007", slug: "use-postgres", stem: "ADR-0007-use-postgres" });
  assert.equal(parseAdrStem("ADR-0007-Use-Postgres").ok, false, "slugs are lowercase by convention");
  assert.equal(parseAdrStem("ADR-.md").ok, false);
  assert.equal(parseAdrStem("ADR-").ok, false);
  assert.equal(parseAdrStem("adr-0007").ok, false, "canonical spelling is case-sensitive");
  assert.equal(isUnsafeReference("docs/adr/ADR-0007.md"), true, "path-like references are unsafe");
  assert.equal(isUnsafeReference("../ADR-1"), true);
  assert.equal(isUnsafeReference("ADR-1\0"), true);
  assert.equal(isUnsafeReference("ADR-1"), false);

  // Case-sensitive extraction: canonical forms only.
  const refs = extractAdrReferences("See ADR-0007 and ADR-0008-use-x here; adr-0009 and Adr-0010 are not canonical; ADR-0007 repeats.");
  assert.deepEqual(refs.map((hit) => hit.reference), ["ADR-0007", "ADR-0008-use-x", "ADR-0007"], "case-sensitive canonical references; duplicates preserved in order");
  assert.deepEqual(extractAdrReferences("ADR-0007-Upper and docs/adr/ADR-0008.md; ADR-0009" ).map((hit) => hit.reference), ["ADR-0007-Upper", "ADR-0009"], "malformed uppercase slug stays whole for an explicit warning; paths are not references");
  pass("ADR naming/reference grammar is exact and case-sensitive (id alphanumeric, slug advisory lowercase)");
}

// ---------------------------------------------------------------------------
// Pinned snapshot reads: exact bytes, dirty root untouched, versions, hashes
// ---------------------------------------------------------------------------
{
  const { root, revision } = buildCorpusRepo({ count: 2 });
  const loaded = await readAdrCorpus({ projectRoot: root });
  assert.equal(loaded.ok, true, loaded.reason);
  const corpus = loaded.corpus;
  assert.equal(corpus.sourceRevision, revision, "reads are pinned to the committed source revision");
  assert.deepEqual(corpus.entries.map((entry) => entry.path).sort(), [
    syntheticAdrPath(1),
    syntheticAdrPath(2),
  ], "only ADR documents are corpus members");
  assert.deepEqual(corpus.entries.map((entry) => entry.adrId), ["0001", "0002"]);
  assert.ok(corpus.ignored.entries.includes("docs/adr/README.md"), "the README/guide is transparently ignored, never an ADR");
  assert.ok(corpus.ignored.entries.includes("docs/notes/historical-evidence.md") === false, "files outside docs/adr are not listed as corpus-ignored");
  const entry = corpus.entries[0];
  assert.equal(entry.content, syntheticAdr(1, "topic-1"), "exact committed bytes are returned");
  assert.equal(entry.version, contentVersionOf(entry.content), "the version is the content-hash of the exact bytes");
  assert.match(entry.version, /^sha256:[0-9a-f]{64}$/);
  assert.equal(entry.blobSha.length, 40);

  // Dirty root: edited + untracked ADRs are NEVER read, and stay untouched.
  const dirtyPath = join(root, syntheticAdrPath(1));
  writeFileSync(dirtyPath, "DIRTY WORKTREE CONTENT — MUST NEVER BE READ", "utf8");
  writeFileSync(join(root, "docs/adr/ADR-0009-uncommitted.md"), syntheticAdr(9), "utf8");
  const afterDirty = await readAdrCorpus({ projectRoot: root });
  assert.equal(afterDirty.ok, true);
  assert.equal(afterDirty.corpus.entries.length, 2, "uncommitted ADRs are not corpus members of the pinned snapshot");
  assert.equal(afterDirty.corpus.entries[0].content, syntheticAdr(1, "topic-1"), "the dirty edit is never read");
  assert.equal(readFileSync(dirtyPath, "utf8"), "DIRTY WORKTREE CONTENT — MUST NEVER BE READ", "the dirty root is unchanged by corpus reads");
  assert.equal(existsSync(join(root, "docs/adr/ADR-0009-uncommitted.md")), true, "the dirty root is unchanged by corpus reads");
  assert.equal(afterDirty.corpus.corpusHash, corpus.corpusHash, "dirty state never changes the corpus identity");

  // Restore the clean committed state before the commit sequence below (this
  // test's later commits must not carry the dirty-root material).
  writeFileSync(dirtyPath, syntheticAdr(1, "topic-1"), "utf8");
  rmSync(join(root, "docs/adr/ADR-0009-uncommitted.md"));

  // A commit that touches ONLY non-ADR files does not change the corpus hash
  // (the no-needless-reindex guarantee) ...
  commitFiles(root, { "src/app.js": "export const app = () => 'changed';\n" }, "non-ADR change");
  const afterNonAdr = await readAdrCorpus({ projectRoot: root });
  assert.equal(afterNonAdr.corpus.corpusHash, corpus.corpusHash, "non-ADR commits do not invalidate derived index/candidate state");
  assert.notEqual(afterNonAdr.corpus.sourceRevision, corpus.sourceRevision, "source revision provenance still advances");

  // ... while a publication-style ADR content change invalidates versions.
  commitFiles(root, { [syntheticAdrPath(1)]: `${syntheticAdr(1, "topic-1")}\nUpdated publication-style.\n` }, "publish ADR change");
  const afterPublish = await readAdrCorpus({ projectRoot: root });
  assert.notEqual(afterPublish.corpus.corpusHash, corpus.corpusHash, "publication-style content change invalidates the corpus identity");
  assert.notEqual(afterPublish.corpus.entries[0].version, entry.version, "the ADR version changes with its exact bytes");

  // Pinned revision: the older snapshot still reads the older exact bytes.
  const pinned = await readAdrCorpus({ projectRoot: root, revision: afterNonAdr.corpus.sourceRevision });
  assert.equal(pinned.corpus.entries[0].content, syntheticAdr(1, "topic-1"), "an explicit pinned revision returns THAT revision's exact bytes");
  assert.equal(pinned.corpus.corpusHash, corpus.corpusHash);
  pass("corpus reads are pinned committed snapshots: exact bytes, dirty root untouched, versions/hashes honest, no-needless-reindex");
}

// ---------------------------------------------------------------------------
// Fail-closed validation: duplicates, names, locations, symlinks, roots
// ---------------------------------------------------------------------------
{
  // Duplicate ids refuse the whole corpus.
  const dupRepo = tmpRepo("adr-dup-");
  commitFiles(dupRepo, {
    [syntheticAdrPath(1)]: syntheticAdr(1),
    "docs/adr/ADR-0001-second.md": syntheticAdr(1, "dup"),
  }, "duplicate ids");
  const dup = await readAdrCorpus({ projectRoot: dupRepo });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "duplicate-id");
  assert.match(dup.reason, /ambiguous id is never silently resolved/);

  // An ADR-named file that violates the grammar refuses the corpus.
  const badName = tmpRepo("adr-badname-");
  commitFiles(badName, { "docs/adr/ADR-0001-Bad_Slug.md": syntheticAdr(1) }, "bad name");
  const bad = await readAdrCorpus({ projectRoot: badName });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid-corpus");
  assert.match(bad.reason, /naming convention/);

  // An ADR-named file in a nested location refuses the corpus.
  const nested = tmpRepo("adr-nested-");
  commitFiles(nested, { "docs/adr/notes/ADR-0007.md": syntheticAdr(7) }, "nested");
  const nestedBad = await readAdrCorpus({ projectRoot: nested });
  assert.equal(nestedBad.ok, false);
  assert.match(nestedBad.reason, /outside the direct corpus directory/);

  // A symlinked ADR is unsafe and refused (never followed).
  const symRepo = tmpRepo("adr-symlink-");
  writeFiles(symRepo, { "target.md": "elsewhere", "docs/adr/README.md": "guide" });
  execFileSync("ln", ["-s", "target.md", join(symRepo, "docs/adr/ADR-0009-sym.md")], { cwd: symRepo });
  git(symRepo, ["add", "-A"]);
  git(symRepo, ["commit", "-q", "-m", "symlinked ADR"]);
  const sym = await readAdrCorpus({ projectRoot: symRepo });
  assert.equal(sym.ok, false);
  assert.equal(sym.code, "invalid-corpus");
  assert.match(sym.reason, /symlink\/non-blob/);

  // A committed symlink for the corpus DIRECTORY (not an ADR filename) must
  // not masquerade as an empty corpus or cross into a foreign root.
  const dirSym = tmpRepo("adr-dir-sym-");
  writeFiles(dirSym, { "docs/README.md": "guide", "foreign/ADR-0001.md": syntheticAdr(1) });
  execFileSync("ln", ["-s", "../foreign", join(dirSym, "docs/adr")]);
  git(dirSym, ["add", "-A"]);
  git(dirSym, ["commit", "-q", "-m", "symlinked corpus directory"]);
  const dirRefusal = await readAdrCorpus({ projectRoot: dirSym });
  assert.equal(dirRefusal.ok, false);
  assert.equal(dirRefusal.code, "unsafe-corpus-path");

  // Non-git root and unresolvable revision are honest failures.
  const plain = mkdtempSync(join(tmpdir(), "adr-plain-"));
  const notGit = await readAdrCorpus({ projectRoot: plain });
  assert.equal(notGit.ok, false);
  assert.equal(notGit.code, "not-a-git-repository");
  const { root } = buildCorpusRepo({ count: 1, prefix: "adr-rev-" });
  const badRev = await readAdrCorpus({ projectRoot: root, revision: "no-such-ref" });
  assert.equal(badRev.ok, false);
  assert.equal(badRev.code, "unresolved-revision");
  const injectRev = await readAdrCorpus({ projectRoot: root, revision: "--output=/tmp/evil" });
  assert.equal(injectRev.ok, false, "option-like revision strings are refused");
  pass("unsafe paths/symlinks/traversal and duplicate IDs refuse the corpus honestly");
}

// ---------------------------------------------------------------------------
// Reference resolution: unique id, advisory slug, ambiguity, unsafe forms
// ---------------------------------------------------------------------------
{
  const entries = [
    { adrId: "0007", slug: null, stem: "ADR-0007", path: "docs/adr/ADR-0007.md" },
    { adrId: "0008", slug: "use-x", stem: "ADR-0008-use-x", path: "docs/adr/ADR-0008-use-x.md" },
    { adrId: "0009", slug: "a", stem: "ADR-0009-a", path: "docs/adr/ADR-0009-a.md" },
    { adrId: "0009", slug: "b", stem: "ADR-0009-b", path: "docs/adr/ADR-0009-b.md" },
  ];
  assert.equal(resolveAdrReference(entries, "ADR-0007").resolvedBy, "stem");
  assert.equal(resolveAdrReference(entries, "ADR-0008-use-x").resolvedBy, "stem", "full stems resolve exactly");
  assert.equal(resolveAdrReference(entries, "ADR-0008").entry.stem, "ADR-0008-use-x", "a bare id resolves to the uniquely slugged document");
  assert.equal(resolveAdrReference(entries, "ADR-0008-use-y").entry.stem, "ADR-0008-use-x", "the slug suffix is advisory when the id is unique");
  const ambiguous = resolveAdrReference(entries, "ADR-0009");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "ambiguous-reference", "ambiguous ids are refused, never guessed");
  assert.deepEqual(ambiguous.candidates.entries, ["ADR-0009-a", "ADR-0009-b"]);
  const unknown = resolveAdrReference(entries, "ADR-0001");
  assert.equal(unknown.code, "unknown-reference");
  const unsafe = resolveAdrReference(entries, "docs/adr/ADR-0007.md");
  assert.equal(unsafe.code, "unsafe-reference", "path-like references are refused as unsafe, never opened as paths");
  const malformed = resolveAdrReference(entries, "adr-0007");
  assert.equal(malformed.code, "malformed-reference", "non-canonical casing is explicit, never resolved");
  pass("reference resolution refuses ambiguity/unknown/unsafe explicitly; slug suffix is advisory only");
}

// ---------------------------------------------------------------------------
// readAdrDocument: exact bytes through the reference API
// ---------------------------------------------------------------------------
{
  const { root, revision } = buildCorpusRepo({ count: 1, prefix: "adr-read-" });
  const read = await readAdrDocument({ projectRoot: root, reference: "ADR-0001" });
  assert.equal(read.ok, true, read.reason);
  assert.equal(read.entry.content, syntheticAdr(1, "topic-1"));
  assert.equal(read.sourceRevision, revision);
  assert.equal(read.entry.version, contentVersionOf(syntheticAdr(1, "topic-1")));
  const missing = await readAdrDocument({ projectRoot: root, reference: "ADR-404" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "unknown-reference");
  pass("readAdrDocument returns the exact committed bytes with version and source revision");
}

console.log("Passed tests/adr-corpus.mjs");
