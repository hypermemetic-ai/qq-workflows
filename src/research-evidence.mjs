import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";

export const RESEARCH_MANIFEST_SCHEMA = "qq.research-evidence/v1";
export const RESEARCH_REF = /^[WS]\d{3}$/;
export const RESEARCH_RUN_PREFIX = "research-";
export const MAX_ANSWER_BYTES = 256 * 1024;

function requireAbsolute(path, label) {
  if (typeof path !== "string" || !path || !isAbsolute(path)) {
    throw new Error(`qq-workflows: ${label} must be an absolute path`);
  }
  return path;
}

/** Default durable metadata/capsule parent, beside DSH_HOME like Land runs. */
export function defaultResearchDir(env = process.env, config = {}) {
  if (config.researchDir !== undefined) return requireAbsolute(config.researchDir, "researchDir");
  // Test deployments and embedders commonly relocate all workflow state by
  // setting landDir. Keep research beside that explicit workflow state root
  // unless it has its own override.
  if (config.landDir !== undefined) return join(dirname(requireAbsolute(config.landDir, "landDir")), "research");
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) return join(dirname(requireAbsolute(dshHome, "DSH_HOME")), ".qq-workflows-research");
  return join(requireAbsolute(env.HOME || homedir(), "HOME"), ".qq-workflows-research");
}

function assertRunId(value) {
  const runId = String(value ?? "");
  if (!/^research-[0-9a-f]{8}$/i.test(runId)) throw new Error("invalid research run id");
  return runId;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe research directory: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`research directory is not owned by this user: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700);
}

async function writeNewFile(path, contents) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function workspacePaths(root) {
  const absolute = requireAbsolute(root, "research workspace");
  return Object.freeze({
    root: absolute,
    question: join(absolute, "question.md"),
    notebook: join(absolute, "notebook.md"),
    answer: join(absolute, "answer.md"),
    evidence: join(absolute, "evidence"),
    manifest: join(absolute, "evidence", "manifest.jsonl"),
    web: join(absolute, "evidence", "web"),
    sessions: join(absolute, "evidence", "sessions"),
    repo: join(absolute, "repo"),
  });
}

/** Create one private capsule. repo is a symlink; no project files are copied. */
export async function createResearchWorkspace({ parentDir, repoRoot, question, runId } = {}) {
  const parent = requireAbsolute(parentDir, "researchDir");
  const repository = await realpath(requireAbsolute(repoRoot, "repoRoot"));
  const repoInfo = await lstat(repository);
  if (!repoInfo.isDirectory()) throw new Error("research repoRoot must be a directory");
  const id = assertRunId(runId ?? `${RESEARCH_RUN_PREFIX}${randomUUID().slice(0, 8)}`);
  await privateDirectory(parent);
  const paths = workspacePaths(join(parent, id));
  await mkdir(paths.root, { mode: 0o700 });
  await privateDirectory(paths.root);
  await privateDirectory(paths.evidence);
  await privateDirectory(paths.web);
  await privateDirectory(paths.sessions);
  await writeNewFile(paths.question, String(question ?? "").trimEnd() + "\n");
  await writeNewFile(paths.manifest, "");
  await symlink(repository, paths.repo, "dir");
  return Object.freeze({ id, repoRoot: repository, ...paths });
}

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function surfaceFor(ref, surface) {
  if (!RESEARCH_REF.test(String(ref ?? ""))) throw new Error(`invalid evidence ref: ${String(ref ?? "")}`);
  const expected = ref[0] === "W" ? "web" : "sessions";
  if (surface !== expected) throw new Error(`evidence ref ${ref} does not belong to ${surface}`);
  return expected;
}

function cleanSource(source) {
  const value = String(source ?? "").trim();
  if (!value || value.includes("\0") || value.includes("\n")) throw new Error("evidence source is invalid");
  return value;
}

export async function readManifest(workspace) {
  const paths = typeof workspace === "string" ? workspacePaths(workspace) : workspace;
  let source;
  try { source = await readFile(paths.manifest, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error(`malformed evidence manifest line ${index + 1}`); }
    if (!RESEARCH_REF.test(record?.ref) || !["web", "sessions"].includes(record?.surface)
      || typeof record?.source !== "string" || typeof record?.fetched_at !== "string"
      || !/^[0-9a-f]{64}$/.test(record?.sha256 ?? "") || typeof record?.path !== "string") {
      throw new Error(`malformed evidence manifest line ${index + 1}`);
    }
    if (records.some((prior) => prior.ref === record.ref)) throw new Error(`duplicate evidence manifest ref ${record.ref}`);
    records.push(record);
  }
  return records;
}

async function appendLine(path, line) {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Host-only immutable materialization. The markdown bytes are what get hashed. */
export async function materializeEvidence(workspace, {
  ref,
  surface,
  source,
  markdown,
  metadata = {},
  fetchedAt = new Date().toISOString(),
} = {}) {
  const paths = typeof workspace === "string" ? workspacePaths(workspace) : workspace;
  const selectedSurface = surfaceFor(ref, surface);
  const safeSource = cleanSource(source);
  const body = String(markdown ?? "");
  if (!body.trim()) throw new Error("evidence snapshot is empty");
  const digest = sha256(body);
  const relativePath = `evidence/${selectedSurface}/${ref}.md`;
  const markdownPath = join(paths.root, relativePath);
  const jsonPath = join(paths.root, `evidence/${selectedSurface}/${ref}.json`);
  const existing = (await readManifest(paths)).find((record) => record.ref === ref);
  if (existing) {
    if (existing.surface !== selectedSurface || existing.source !== safeSource || existing.sha256 !== digest) {
      throw new Error(`evidence ref ${ref} is immutable`);
    }
    return Object.freeze({ ...existing, markdownPath, jsonPath, existing: true });
  }
  const record = {
    ref,
    surface: selectedSurface,
    source: safeSource,
    fetched_at: fetchedAt,
    sha256: digest,
    path: relativePath,
  };
  const sidecar = {
    schema: RESEARCH_MANIFEST_SCHEMA,
    ...record,
    metadata,
  };
  try {
    await writeNewFile(markdownPath, body);
    await writeNewFile(jsonPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    await appendLine(paths.manifest, `${JSON.stringify(record)}\n`);
  } catch (error) {
    // O_EXCL plus manifest validation make concurrent/conflicting acquisitions fail closed.
    const after = (await readManifest(paths).catch(() => [])).find((item) => item.ref === ref);
    if (after?.sha256 === digest && after?.source === safeSource) {
      return Object.freeze({ ...after, markdownPath, jsonPath, existing: true });
    }
    throw error;
  }
  return Object.freeze({ ...record, markdownPath, jsonPath, existing: false });
}

function repoCitations(answer) {
  const refs = new Set();
  // Markdown links, inline code, and ordinary prose are all accepted. Stop at
  // whitespace or markdown punctuation; line anchors are checked as part of the file.
  const pattern = /(?:^|[\s`("'])((?:\.\/)?repo\/[A-Za-z0-9._~!$&'()*+,;=:@%+\/-]+)(?=$|[\s`)"',;])/gm;
  let match;
  while ((match = pattern.exec(answer))) {
    refs.add(match[1].replace(/^\.\//, "").replace(/[.:]+$/, ""));
  }
  return [...refs];
}

function safeRelativeRepoPath(citation) {
  const value = citation.slice("repo/".length).split("#", 1)[0].replace(/:\d+(?:-\d+)?$/, "");
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/")
    || value.split("/").some((part) => part === ".." || part === "")) return null;
  return value;
}

/** Validate answer existence and every evidence/repository citation. */
export async function checkAnswerCitations(workspace) {
  const paths = typeof workspace === "string" ? workspacePaths(workspace) : workspace;
  let answer;
  try {
    const answerInfo = await lstat(paths.answer);
    if (!answerInfo.isFile() || answerInfo.isSymbolicLink()) {
      return { ok: false, reason: "answer.md must be a regular capsule file", refs: [], repoPaths: [] };
    }
    answer = await readFile(paths.answer, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reason: "answer.md is required before submission", refs: [], repoPaths: [] };
    throw error;
  }
  if (!answer.trim()) return { ok: false, reason: "answer.md must not be empty", refs: [], repoPaths: [] };
  if (Buffer.byteLength(answer, "utf8") > MAX_ANSWER_BYTES) {
    return { ok: false, reason: "answer.md exceeds the size limit", refs: [], repoPaths: [] };
  }
  const manifest = await readManifest(paths);
  const acquired = new Map(manifest.map((record) => [record.ref, record]));
  const mentionedRefs = [...new Set(answer.match(/\b[WS]\d+\b/g) ?? [])];
  const malformed = mentionedRefs.filter((ref) => !RESEARCH_REF.test(ref));
  if (malformed.length) {
    return { ok: false, reason: `malformed evidence citation (use W### or S###): ${malformed.join(", ")}`, refs: mentionedRefs, repoPaths: [] };
  }
  const refs = mentionedRefs;
  const unknown = refs.filter((ref) => !acquired.has(ref));
  if (unknown.length) {
    return { ok: false, reason: `unknown or unfetched evidence citation: ${unknown.join(", ")}`, refs, repoPaths: [] };
  }
  if (/https?:\/\//i.test(answer) || /\bsession:session-[0-9a-f-]+#\d+/i.test(answer)) {
    return { ok: false, reason: "direct web/session citations are not allowed; cite an acquired W### or S### snapshot", refs, repoPaths: [] };
  }
  for (const ref of refs) {
    const record = acquired.get(ref);
    const expectedSurface = ref.startsWith("W") ? "web" : "sessions";
    const expectedPath = `evidence/${expectedSurface}/${ref}.md`;
    if (record.surface !== expectedSurface || record.path !== expectedPath) {
      return { ok: false, reason: `evidence citation has a non-canonical manifest path: ${ref}`, refs, repoPaths: [] };
    }
    try {
      const snapshotPath = join(paths.root, expectedPath);
      const info = await lstat(snapshotPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
      if (sha256(await readFile(snapshotPath, "utf8")) !== record.sha256) throw new Error("hash mismatch");
    } catch {
      return { ok: false, reason: `evidence snapshot does not match its manifest: ${ref}`, refs, repoPaths: [] };
    }
  }
  const repoPaths = repoCitations(answer);
  const repoRoot = await realpath(paths.repo);
  for (const citation of repoPaths) {
    const relativePath = safeRelativeRepoPath(citation);
    if (!relativePath) return { ok: false, reason: `invalid repository citation: ${citation}`, refs, repoPaths };
    const candidate = resolve(repoRoot, relativePath);
    const rel = relative(repoRoot, candidate);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      return { ok: false, reason: `repository citation escapes repo/: ${citation}`, refs, repoPaths };
    }
    try {
      const actual = await realpath(candidate);
      const actualRel = relative(repoRoot, actual);
      if (actualRel.startsWith(`..${sep}`) || actualRel === ".." || isAbsolute(actualRel)) throw new Error("escape");
      await lstat(actual);
    } catch {
      return { ok: false, reason: `repository citation does not resolve: ${citation}`, refs, repoPaths };
    }
  }
  return { ok: true, refs, repoPaths, manifestCount: manifest.length, answerPath: paths.answer };
}

export async function requireValidAnswer(workspace) {
  const result = await checkAnswerCitations(workspace);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
