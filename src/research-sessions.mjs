import { readFile } from "node:fs/promises";

import { materializeEvidence, readManifest, workspacePaths } from "./research-evidence.mjs";

export const SESSION_SEARCH_LIMIT = 8;
export const SESSION_RAW_EVENT_BOUND = 24;
export const SESSION_MESSAGE_LIMIT = 9;
export const SESSION_MESSAGE_MAX_CHARS = 4_000;
export const SESSION_SNAPSHOT_MAX_CHARS = 32_000;

function compact(value, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sessionIdOf(hit) {
  return hit?.header?.id ?? hit?.session?.id ?? hit?.sessionId ?? hit?.id ?? "";
}

function seqOf(value) {
  for (const candidate of [value?.seq, value?.event?.seq, value?.match?.seq, value?.matches?.[0]?.seq, value?.evidence?.[0]?.seq]) {
    if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

function textBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** The only allowed projection: visible conversational message text. */
export function visibleConversationEvent(event) {
  let text = "";
  if (event?.type === "user/message") {
    text = textBlocks(event?.data?.content ?? event?.data?.message?.content ?? event?.content);
  } else if (event?.type === "assistant/message") {
    text = textBlocks(event?.data?.message?.content ?? event?.data?.content ?? event?.message?.content);
  } else {
    return null;
  }
  if (!text) return null;
  const truncated = text.length > SESSION_MESSAGE_MAX_CHARS;
  return {
    seq: Number.isSafeInteger(event?.seq) ? event.seq : null,
    time: event?.time ?? null,
    type: event.type,
    text: truncated ? `${text.slice(0, SESSION_MESSAGE_MAX_CHARS)}\n[MESSAGE TRUNCATED]` : text,
    truncated,
  };
}

function evidenceOf(hit) {
  const rows = [];
  for (const value of [
    ...(Array.isArray(hit?.matches) ? hit.matches : []),
    ...(Array.isArray(hit?.evidence) ? hit.evidence : []),
    hit?.bestMatch,
    hit?.match,
    hit?.event,
  ]) {
    if (!value) continue;
    const text = value?.text ?? value?.snippet ?? value?.content;
    const seq = seqOf(value);
    if (typeof text === "string" && text.trim()) rows.push({ text, seq });
  }
  if (rows.length === 0) {
    const text = hit?.snippet ?? hit?.text ?? hit?.title ?? "";
    if (typeof text === "string" && text.trim()) rows.push({ text, seq: seqOf(hit) });
  }
  return rows;
}

function searchItems(raw) {
  return Array.isArray(raw) ? raw : raw?.items ?? raw?.results ?? raw?.sessions ?? [];
}

function candidateSource(sessionId, seq) {
  return `session:${sessionId}#${seq}`;
}

export class ResearchSessionsAdapter {
  #workspace;
  #query;
  #byIdentity = new Map();
  #byRef = new Map();
  #next = 1;
  #onCandidates;

  constructor({ workspace, sessionQuery, candidates = [], onCandidates } = {}) {
    this.#workspace = typeof workspace === "string" ? workspacePaths(workspace) : workspace;
    if (!this.#workspace?.root) throw new Error("session adapter requires a research workspace");
    if (!sessionQuery || typeof sessionQuery.searchSessions !== "function" || typeof sessionQuery.readEvent !== "function") {
      throw new Error("session evidence is unavailable: ctx.sessionQuery searchSessions/readEvent are required");
    }
    this.#query = sessionQuery;
    for (const candidate of candidates) this.#remember(candidate, candidate.ref, false);
    this.#onCandidates = typeof onCandidates === "function" ? onCandidates : null;
  }

  #remember(hit, assignedRef, notify = true) {
    const sessionId = String(hit.sessionId ?? "");
    const seq = hit.seq;
    if (!sessionId || !Number.isSafeInteger(seq) || seq < 0) return null;
    const identity = `${sessionId}#${seq}`;
    const prior = this.#byIdentity.get(identity);
    if (prior) return prior;
    const ref = assignedRef ?? `S${String(this.#next).padStart(3, "0")}`;
    if (!/^S\d{3}$/.test(ref) || this.#byRef.has(ref)) throw new Error(`invalid or duplicate session ref: ${ref}`);
    this.#next = Math.max(this.#next, Number(ref.slice(1)) + 1);
    const candidate = Object.freeze({
      ref,
      sessionId,
      seq,
      title: compact(hit.title, 120),
      snippet: compact(hit.snippet, 220),
    });
    this.#byIdentity.set(identity, candidate);
    this.#byRef.set(ref, candidate);
    if (notify) this.#onCandidates?.(this.candidates());
    return candidate;
  }

  candidates() { return [...this.#byRef.values()].map((value) => ({ ...value })); }

  async search(...input) {
    const phrases = (input.length === 1 && Array.isArray(input[0]) ? input[0] : input)
      .map((value) => String(value ?? "").trim()).filter(Boolean);
    if (phrases.length === 0) throw new Error("session-search requires at least one non-empty phrase");
    const discovered = [];
    const seen = new Set();
    const acquiredByIdentity = new Map();
    for (const record of (await readManifest(this.#workspace)).filter((item) => item.surface === "sessions")) {
      this.#next = Math.max(this.#next, Number(record.ref.slice(1)) + 1);
      const match = record.source.match(/^session:(.+)#(\d+)$/);
      if (match) acquiredByIdentity.set(`${match[1]}#${match[2]}`, record.ref);
    }
    // Each phrase is a literal lexical source request. Results are retained in
    // source order; there is no semantic rescue, provider fusion, or hidden reranking.
    for (const phrase of phrases) {
      const raw = await this.#query.searchSessions({
        query: phrase,
        eventFilters: [
          { kind: "type", values: ["user/message", "assistant/message"] },
          { kind: "surface", values: ["current", "shadowed"] },
        ],
        limit: SESSION_SEARCH_LIMIT,
      });
      for (const hit of searchItems(raw)) {
        const sessionId = String(sessionIdOf(hit));
        if (!sessionId) continue;
        for (const match of evidenceOf(hit)) {
          const seq = Number.isSafeInteger(match.seq) ? match.seq : seqOf(hit);
          if (!Number.isSafeInteger(seq) || seq < 0) continue;
          const identity = `${sessionId}#${seq}`;
          if (seen.has(identity)) continue;
          // Search indexes provide leads only. Verify the exact detached event
          // before surfacing any snippet so hidden assistant blocks cannot leak.
          const verified = await this.#query.readEvent({ sessionId, seq, before: 0, after: 0 });
          const visible = visibleConversationEvent(verified?.target);
          if (!visible || visible.seq !== seq
            || !visible.text.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())) continue;
          seen.add(identity);
          const candidate = this.#remember({
            sessionId,
            seq,
            title: hit?.title?.title ?? hit?.title ?? hit?.header?.title ?? "",
            snippet: visible.text,
          }, acquiredByIdentity.get(identity));
          if (candidate) discovered.push(candidate);
          if (discovered.length >= SESSION_SEARCH_LIMIT) break;
        }
        if (discovered.length >= SESSION_SEARCH_LIMIT) break;
      }
      if (discovered.length >= SESSION_SEARCH_LIMIT) break;
    }
    if (discovered.length === 0) return "No session candidates.\n";
    return ["REF\tSESSION\tSEQ\tTITLE\tSNIPPET", ...discovered.map((hit) =>
      `${hit.ref}\t${hit.sessionId}\t${hit.seq}\t${hit.title}\t${hit.snippet}`)].join("\n") + "\n";
  }

  async get(ref) {
    const key = String(ref ?? "").trim();
    const existing = (await readManifest(this.#workspace)).find((record) => record.ref === key);
    if (existing) {
      const markdown = await readFile(`${this.#workspace.root}/${existing.path}`, "utf8");
      return { ...existing, markdown, existing: true };
    }
    const candidate = this.#byRef.get(key);
    if (!candidate) throw new Error(`unknown session ref: ${key}`);
    // This is the sole authoritative content read for one session-get.
    const observation = await this.#query.readEvent({
      sessionId: candidate.sessionId,
      seq: candidate.seq,
      before: SESSION_RAW_EVENT_BOUND,
      after: SESSION_RAW_EVENT_BOUND,
    });
    if (observation?.target && observation.target.seq !== candidate.seq) {
      throw new Error(`session-get ${key} target changed`);
    }
    const raw = Array.isArray(observation?.events) ? observation.events : [
      ...(Array.isArray(observation?.before) ? observation.before : []),
      observation?.target,
      ...(Array.isArray(observation?.after) ? observation.after : []),
    ];
    const projected = raw.map(visibleConversationEvent).filter(Boolean)
      .filter((event) => Number.isSafeInteger(event.seq))
      .sort((left, right) => left.seq - right.seq);
    if (!projected.some((event) => event.seq === candidate.seq)) {
      const target = visibleConversationEvent(observation?.target);
      if (target && Number.isSafeInteger(target.seq)) projected.push(target);
    }
    projected.sort((left, right) => left.seq - right.seq);
    const targetIndex = projected.findIndex((event) => event.seq === candidate.seq);
    if (targetIndex < 0) throw new Error(`session-get ${key} target is not a visible conversation message`);
    const half = Math.floor(SESSION_MESSAGE_LIMIT / 2);
    let start = Math.max(0, targetIndex - half);
    let end = Math.min(projected.length, start + SESSION_MESSAGE_LIMIT);
    start = Math.max(0, end - SESSION_MESSAGE_LIMIT);
    const selected = projected.slice(start, end);
    const heading = [
      `# Session evidence ${key}`,
      "",
      `Source session: ${candidate.sessionId}`,
      `Target sequence: ${candidate.seq}`,
      "",
    ];
    const rows = selected.flatMap((event) => [
      `## ${event.type === "user/message" ? "User" : "Assistant"} (seq ${event.seq})`,
      "",
      event.text,
      "",
    ]);
    let markdown = [...heading, ...rows].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    let truncated = start > 0 || end < projected.length || selected.some((event) => event.truncated);
    if (markdown.length > SESSION_SNAPSHOT_MAX_CHARS) {
      markdown = `${markdown.slice(0, SESSION_SNAPSHOT_MAX_CHARS - 32)}\n\n[SNAPSHOT TRUNCATED]\n`;
      truncated = true;
    }
    return materializeEvidence(this.#workspace, {
      ref: key,
      surface: "sessions",
      source: candidateSource(candidate.sessionId, candidate.seq),
      markdown,
      metadata: {
        session_id: candidate.sessionId,
        target_seq: candidate.seq,
        first_seq: selected[0]?.seq ?? null,
        last_seq: selected.at(-1)?.seq ?? null,
        messages: selected.length,
        truncated,
      },
    });
  }
}

export function createResearchSessions(options) {
  return new ResearchSessionsAdapter(options);
}
