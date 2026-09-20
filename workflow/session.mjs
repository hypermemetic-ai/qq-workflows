// Workflow identity and durable session association.
//
// A workflow session is identified by an explicit, stable session key. For the
// Paseo-native Architect that key is the Paseo agent ID, so reopening or
// resuming the agent keeps the same ticket. Nothing here infers a session from
// directory recency: a missing association is an error, not a guess.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const SESSION_ID_ENV = "QQ_WORKFLOW_SESSION_ID";
export const OWNER_AGENT_ENV = "QQ_ARCHITECT_OWNER_AGENT_ID";
export const PASEO_AGENT_ID_ENV = "PASEO_AGENT_ID";
export const STATE_DIR_ENV = "QQ_WORKFLOW_STATE_DIR";

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function stateDirFor(root, env = process.env) {
  const override = env?.[STATE_DIR_ENV];
  if (typeof override === "string" && override.trim()) return override.trim();
  return join(root, ".architect", "state");
}

export function sessionsDir(stateDir) {
  return join(stateDir, "sessions");
}

// Stable session key: explicit argument first, then the injected workflow
// identity, then the Paseo agent ID. Absent means "no workflow identity".
export function resolveSessionKey({ explicit, env = process.env } = {}) {
  const candidates = [explicit, env?.[SESSION_ID_ENV], env?.[PASEO_AGENT_ID_ENV]];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Ticket filenames use the session key verbatim when it already is a UUID.
// Anything else maps deterministically (sha256 → UUID layout) so a key that is
// not a UUID, e.g. a slug used by tests or a CLI run, still gets one stable
// ticket file across reopen.
export function sessionIdFor(key) {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) throw new Error("session key is required");
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();
  const hex = createHash("sha256").update(`qq-workflow-session:${trimmed}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

function associationPath(stateDir, key) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return join(sessionsDir(stateDir), `${safe}.json`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function readAssociation(stateDir, key) {
  try {
    const raw = readFileSync(associationPath(stateDir, key), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listAssociations(stateDir) {
  const dir = sessionsDir(stateDir);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      /* a corrupt association is skipped, never guessed at */
    }
  }
  return out;
}

// Ensure the durable association for a session key. Idempotent: the first call
// records root/ticket/owner, later calls return the same record and only refresh
// the owner/updatedAt fields.
export function ensureAssociation({
  stateDir,
  key,
  root,
  ownerAgentId = null,
  sessionId = null,
  ticketRelPath = null,
  now = Date.now(),
} = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!key) throw new Error("session key is required");
  if (!root) throw new Error("repository root is required");
  const resolvedSessionId = sessionId || sessionIdFor(key);
  const existing = readAssociation(stateDir, key);
  if (existing && existing.sessionId && existing.root === root) {
    const next = {
      ...existing,
      ownerAgentId: ownerAgentId ?? existing.ownerAgentId ?? null,
      updatedAt: now,
    };
    if (next.ownerAgentId !== existing.ownerAgentId) writeJsonAtomic(associationPath(stateDir, key), next);
    return next;
  }
  if (existing && existing.sessionId && existing.root !== root) {
    throw new Error(
      `session key '${key}' is already associated with repository '${existing.root}' (requested '${root}'); refusing to re-point an established workflow session`,
    );
  }
  const record = {
    schema: 1,
    sessionKey: key,
    sessionId: resolvedSessionId,
    root,
    ticketPath: ticketRelPath || join(".architect", "tickets", `${resolvedSessionId}.md`),
    ownerAgentId: ownerAgentId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(associationPath(stateDir, key), record);
  return record;
}

// Resolve a session without guessing: the key's association is authoritative.
export function resolveAssociation({ stateDir, key }) {
  const record = readAssociation(stateDir, key);
  if (!record) {
    throw new Error(
      `no durable association for session key '${key}'; create the workflow session first (ticket identity is never inferred from directory recency)`,
    );
  }
  return record;
}
