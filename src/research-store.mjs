import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";

export { defaultResearchDir } from "./research-evidence.mjs";

export const RESEARCH_DELEGATION_SCHEMA = "qq.research-delegation/v2";
export const RESEARCH_DELEGATION_STATUSES = Object.freeze(["researching", "reviewing", "completed", "blocked"]);
const STATUS = new Set(RESEARCH_DELEGATION_STATUSES);
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELEGATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_RESEARCH_SCHEMA = "qq.research-run/v1";
const LEGACY_RESEARCH_ID = /^research-[0-9a-f]{8}$/i;

function canonicalId(value) { return String(value ?? "").toLowerCase(); }

function upgradeLegacy(raw, sourceId, mintId) {
  const rawId = canonicalId(raw?.id);
  const legacy = raw?.schema === LEGACY_RESEARCH_SCHEMA
    || LEGACY_RESEARCH_ID.test(rawId)
    || LEGACY_RESEARCH_ID.test(sourceId);
  if (!legacy) return { raw, changed: false, aliases: [] };
  const id = mintId();
  const aliases = [...new Set([sourceId, rawId])].filter((candidate) =>
    (DELEGATION_ID.test(candidate) || LEGACY_RESEARCH_ID.test(candidate)) && candidate !== id);
  return {
    raw: { ...raw, schema: RESEARCH_DELEGATION_SCHEMA, id },
    changed: true,
    aliases,
  };
}

function clone(value) { return structuredClone(value); }
function optionalString(value) { return typeof value === "string" ? value : ""; }
function candidates(value, prefix) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    ref: String(item?.ref ?? ""),
    ...(prefix === "W"
      ? { url: String(item?.url ?? ""), title: optionalString(item?.title), snippet: optionalString(item?.snippet) }
      : { sessionId: String(item?.sessionId ?? ""), seq: item?.seq, title: optionalString(item?.title), snippet: optionalString(item?.snippet) }),
  })).filter((item) => new RegExp(`^${prefix}\\d{3}$`).test(item.ref));
}

export function validateResearchRun(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== RESEARCH_DELEGATION_SCHEMA
    || !DELEGATION_ID.test(raw.id) || !STATUS.has(raw.status) || !SESSION_ID.test(raw.parentSessionUuid)
    || typeof raw.root !== "string" || !raw.root || typeof raw.repoRoot !== "string" || !raw.repoRoot
    || typeof raw.question !== "string" || typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    throw new Error("research delegation is malformed");
  }
  if (raw.researchSession && !SESSION_ID.test(raw.researchSession)) throw new Error("research delegation has invalid research session");
  if (raw.reviewSession && !SESSION_ID.test(raw.reviewSession)) throw new Error("research delegation has invalid review session");
  if (!Array.isArray(raw.webCandidates) || !Array.isArray(raw.sessionCandidates)) throw new Error("research candidate state is malformed");
  if (!Array.isArray(raw.reviewFindings)) throw new Error("research review findings are malformed");
  if (raw.answerSha256 && !/^[0-9a-f]{64}$/.test(raw.answerSha256)) throw new Error("research answer digest is malformed");
  if (!Number.isSafeInteger(raw.answerBytes) || raw.answerBytes < 0) throw new Error("research answer size is malformed");
  if (raw.manifestSha256 && !/^[0-9a-f]{64}$/.test(raw.manifestSha256)) throw new Error("research manifest digest is malformed");
  if (typeof raw.reported !== "boolean") throw new Error("research reported flag is malformed");
  return raw;
}

function normalize(raw) {
  const value = {
    schema: RESEARCH_DELEGATION_SCHEMA,
    id: String(raw.id ?? "").toLowerCase(),
    status: raw.status,
    parentSessionUuid: raw.parentSessionUuid,
    root: raw.root,
    repoRoot: raw.repoRoot,
    question: raw.question,
    researchSession: optionalString(raw.researchSession),
    reviewSession: optionalString(raw.reviewSession),
    webCandidates: candidates(raw.webCandidates, "W"),
    sessionCandidates: candidates(raw.sessionCandidates, "S"),
    citationCheck: raw.citationCheck && typeof raw.citationCheck === "object" ? clone(raw.citationCheck) : null,
    answerSha256: optionalString(raw.answerSha256),
    answerBytes: Number.isSafeInteger(raw.answerBytes) && raw.answerBytes >= 0 ? raw.answerBytes : 0,
    manifestSha256: optionalString(raw.manifestSha256),
    reviewFindings: Array.isArray(raw.reviewFindings) ? clone(raw.reviewFindings) : [],
    blockedReason: optionalString(raw.blockedReason),
    reportMessageId: optionalString(raw.reportMessageId),
    reported: raw.reported === true,
    createdAt: raw.createdAt,
    updatedAt: optionalString(raw.updatedAt) || raw.createdAt,
  };
  return validateResearchRun(value);
}

export function createResearchStore(dirPath, { onChange } = {}) {
  if (typeof dirPath !== "string" || !dirPath) throw new Error("research store requires a directory");
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const info = lstatSync(dirPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("research store directory is unsafe");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("research store directory is not owned by this user");
  if ((info.mode & 0o077) !== 0) chmodSync(dirPath, 0o700);

  const fileFor = (id) => join(dirPath, `${canonicalId(id)}.json`);
  const aliases = new Map();
  function mintId() {
    let id;
    do { id = randomUUID(); } while (existsSync(fileFor(id)));
    return id;
  }
  function persist(record, { exclusive = false } = {}) {
    const normalized = normalize(record);
    const path = fileFor(normalized.id);
    if (exclusive && existsSync(path)) throw new Error(`research delegation already exists: ${normalized.id}`);
    const temporary = join(dirPath, `.${normalized.id}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL });
    renameSync(temporary, path);
    return clone(normalized);
  }

  const store = {
    dirPath,
    fileFor,
    create(input) {
      const now = new Date().toISOString();
      const result = persist({
        schema: RESEARCH_DELEGATION_SCHEMA,
        status: "researching",
        researchSession: "",
        reviewSession: "",
        webCandidates: [],
        sessionCandidates: [],
        citationCheck: null,
        answerSha256: "",
        answerBytes: 0,
        manifestSha256: "",
        reviewFindings: [],
        blockedReason: "",
        reportMessageId: "",
        reported: false,
        createdAt: now,
        updatedAt: now,
        ...input,
      }, { exclusive: true });
      onChange?.(result);
      return result;
    },
    save(input) {
      const normalized = normalize(input);
      const previous = store.load(normalized.id);
      if (!previous) throw new Error(`research delegation does not exist: ${String(input?.id ?? "")}`);
      for (const field of ["id", "parentSessionUuid", "root", "repoRoot", "question", "researchSession", "createdAt"]) {
        if (normalized[field] !== previous[field]) throw new Error(`research delegation ${field} is immutable`);
      }
      for (const field of ["answerSha256", "answerBytes", "manifestSha256"]) {
        if (previous.answerSha256 && normalized[field] !== previous[field]) {
          throw new Error(`research delegation ${field} is immutable after submission`);
        }
      }
      const result = persist({ ...normalized, updatedAt: new Date().toISOString() });
      onChange?.(result);
      return result;
    },
    load(id) {
      const requestedId = canonicalId(id);
      if (!DELEGATION_ID.test(requestedId) && !LEGACY_RESEARCH_ID.test(requestedId)) return null;
      const sourceId = aliases.get(requestedId) ?? requestedId;
      let raw;
      try { raw = JSON.parse(readFileSync(fileFor(sourceId), "utf8")); }
      catch (error) {
        if (error?.code === "ENOENT") {
          if (sourceId !== requestedId) aliases.delete(requestedId);
          return null;
        }
        throw error;
      }
      const upgraded = upgradeLegacy(raw, sourceId, mintId);
      const normalized = normalize(upgraded.raw);
      if (upgraded.changed) {
        persist(normalized, { exclusive: true });
        if (normalized.id !== sourceId) {
          try { unlinkSync(fileFor(sourceId)); }
          catch (error) { if (error?.code !== "ENOENT") throw error; }
        }
        for (const alias of upgraded.aliases) aliases.set(alias, normalized.id);
      }
      return clone(normalized);
    },
    list() {
      return readdirSync(dirPath).filter((name) => {
        if (!name.endsWith(".json")) return false;
        const id = name.slice(0, -5);
        return DELEGATION_ID.test(id) || LEGACY_RESEARCH_ID.test(id);
      }).sort().map((name) => store.load(name.slice(0, -5))).filter(Boolean);
    },
    byDelegation(delegationId) {
      return store.load(delegationId);
    },
    bySession(sessionId) {
      if (!SESSION_ID.test(String(sessionId ?? ""))) return null;
      return store.list().find((run) => run.researchSession === sessionId || run.reviewSession === sessionId) ?? null;
    },
  };
  return Object.freeze(store);
}
