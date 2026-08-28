import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { materializeEvidence, readManifest, workspacePaths } from "./research-evidence.mjs";

export const WEB_SEARCH_LIMIT = 8;
export const WEB_SNAPSHOT_MAX_CHARS = 80_000;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_BYTES = 1024 * 1024;

function compact(value, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value ?? "")
    .replace(/&#(\d+);/g, (all, digits) => {
      const point = Number(digits);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all;
    })
    .replace(/&#x([0-9a-f]+);/gi, (all, digits) => {
      const point = parseInt(digits, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all;
    })
    .replace(/&([a-z]+);/gi, (all, name) => named[name.toLowerCase()] ?? all);
}

/** Deliberately small, dependency-free conversion. Snapshots are evidence, not a browser DOM. */
export function htmlToBoundedMarkdown(html, { source = "", maxChars = WEB_SNAPSHOT_MAX_CHARS } = {}) {
  let text = String(html ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n---\n")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_all, level, body) => `\n${"#".repeat(Number(level))} ${body}\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|li|table|tr|blockquote)>/gi, "\n")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_all, href, label) => `[${label}](${href})`)
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const heading = source ? `Source: ${source}\n\n` : "";
  const budget = Math.max(0, maxChars - heading.length - 64);
  const truncated = text.length > budget;
  if (truncated) text = `${text.slice(0, budget)}\n\n[SNAPSHOT TRUNCATED]`;
  return { markdown: `${heading}${text}\n`, truncated };
}

function normalizeUrl(raw) {
  const value = String(raw ?? "").trim();
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`invalid web result URL: ${value}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`unsupported web result URL: ${value}`);
  if (parsed.href.length > 4096) throw new Error("web result URL exceeds the size limit");
  parsed.hash = "";
  return parsed.href;
}

function normalizeHits(raw) {
  const list = Array.isArray(raw) ? raw
    : raw?.results ?? raw?.items ?? raw?.web?.results ?? raw?.data ?? [];
  if (!Array.isArray(list)) return [];
  const hits = [];
  const seen = new Set();
  for (const value of list) {
    let url;
    try { url = normalizeUrl(value?.url ?? value?.link ?? value?.id); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({
      url,
      title: compact(value?.title ?? value?.name ?? url, 120),
      snippet: compact(value?.snippet ?? value?.description ?? value?.text ?? value?.content, 200),
    });
    if (hits.length >= WEB_SEARCH_LIMIT) break;
  }
  return hits;
}

function jsonHeaders(extra = {}) {
  return { Accept: "application/json", "Content-Type": "application/json", ...extra };
}

export function createBraveProvider(apiKey, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!apiKey || typeof fetchImpl !== "function") throw new Error("Brave web provider is unavailable");
  return Object.freeze({
    async search(query) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(WEB_SEARCH_LIMIT));
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      });
      if (!response.ok) throw new Error(`Brave search failed (${response.status})`);
      return response.json();
    },
  });
}

export function createExaProvider(apiKey, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!apiKey || typeof fetchImpl !== "function") throw new Error("Exa web provider is unavailable");
  return Object.freeze({
    async search(query) {
      const response = await fetchImpl("https://api.exa.ai/search", {
        method: "POST",
        headers: jsonHeaders({ "x-api-key": apiKey }),
        body: JSON.stringify({ query, numResults: WEB_SEARCH_LIMIT, type: "auto" }),
      });
      if (!response.ok) throw new Error(`Exa search failed (${response.status})`);
      return response.json();
    },
  });
}

/** One provider only: explicit fake, otherwise Brave, otherwise Exa. */
export function selectWebProvider({ provider, env = process.env, fetch: fetchImpl } = {}) {
  if (provider) {
    if (typeof provider.search !== "function") throw new Error("web provider must implement search");
    return provider;
  }
  if (env?.BRAVE_API_KEY) return createBraveProvider(env.BRAVE_API_KEY, { fetch: fetchImpl });
  if (env?.EXA_API_KEY) return createExaProvider(env.EXA_API_KEY, { fetch: fetchImpl });
  throw new Error("web evidence is unavailable: BRAVE_API_KEY or EXA_API_KEY is required");
}

async function fetchWithLimit(fetchImpl, url) {
  if (typeof fetchImpl !== "function") throw new Error("web fetch is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`web fetch failed (${response.status})`);
    let content = "";
    let transportTruncated = false;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        const remaining = WEB_FETCH_MAX_BYTES - total;
        if (chunk.length > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          transportTruncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
      content = Buffer.concat(chunks).toString("utf8");
    } else {
      const bytes = Buffer.from(await response.text(), "utf8");
      transportTruncated = bytes.length > WEB_FETCH_MAX_BYTES;
      content = bytes.subarray(0, WEB_FETCH_MAX_BYTES).toString("utf8");
    }
    return {
      source: response.url || url,
      content,
      contentType: response.headers?.get?.("content-type") ?? "",
      status: response.status,
      transportTruncated,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function acquiredPath(workspace, record) {
  return { ...record, markdownPath: join(workspace.root, record.path) };
}

export class ResearchWebAdapter {
  #workspace;
  #provider;
  #fetch;
  #byUrl = new Map();
  #byRef = new Map();
  #next = 1;
  #onCandidates;

  constructor({ workspace, provider, env, fetch: fetchImpl, candidates = [], onCandidates } = {}) {
    this.#workspace = typeof workspace === "string" ? workspacePaths(workspace) : workspace;
    if (!this.#workspace?.root) throw new Error("web adapter requires a research workspace");
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#provider = selectWebProvider({ provider, env, fetch: this.#fetch });
    for (const candidate of candidates) this.#remember(candidate, candidate.ref, false);
    this.#onCandidates = typeof onCandidates === "function" ? onCandidates : null;
  }

  #remember(hit, assignedRef, notify = true) {
    const url = normalizeUrl(hit.url);
    const prior = this.#byUrl.get(url);
    if (prior) return prior;
    const ref = assignedRef ?? `W${String(this.#next).padStart(3, "0")}`;
    if (!/^W\d{3}$/.test(ref) || this.#byRef.has(ref)) throw new Error(`invalid or duplicate web ref: ${ref}`);
    this.#next = Math.max(this.#next, Number(ref.slice(1)) + 1);
    const candidate = Object.freeze({ ref, url, title: compact(hit.title, 120), snippet: compact(hit.snippet, 200) });
    this.#byUrl.set(url, candidate);
    this.#byRef.set(ref, candidate);
    if (notify) this.#onCandidates?.(this.candidates());
    return candidate;
  }

  candidates() { return [...this.#byRef.values()].map((value) => ({ ...value })); }

  async search(query) {
    const phrase = String(query ?? "").trim();
    if (!phrase) throw new Error("web-search requires a non-empty query");
    const [raw, manifest] = await Promise.all([this.#provider.search(phrase), readManifest(this.#workspace)]);
    const acquiredBySource = new Map();
    for (const record of manifest.filter((item) => item.surface === "web")) {
      this.#next = Math.max(this.#next, Number(record.ref.slice(1)) + 1);
      acquiredBySource.set(record.source, record.ref);
    }
    const candidates = normalizeHits(raw).map((hit) => this.#remember(hit, acquiredBySource.get(hit.url)));
    if (candidates.length === 0) return "No web candidates.\n";
    return ["REF\tTITLE\tURL\tSNIPPET", ...candidates.map((hit) =>
      `${hit.ref}\t${hit.title}\t${hit.url}\t${hit.snippet}`)].join("\n") + "\n";
  }

  async get(ref) {
    const key = String(ref ?? "").trim();
    const existing = (await readManifest(this.#workspace)).find((record) => record.ref === key);
    if (existing) {
      const markdown = await readFile(joinPath(this.#workspace.root, existing.path), "utf8");
      return { ...acquiredPath(this.#workspace, existing), markdown, existing: true };
    }
    const candidate = this.#byRef.get(key);
    if (!candidate) throw new Error(`unknown web ref: ${key}`);
    let fetched;
    if (typeof this.#provider.get === "function") fetched = await this.#provider.get(candidate.url, { ref: key });
    else if (typeof this.#provider.fetch === "function") fetched = await this.#provider.fetch(candidate.url, { ref: key });
    else fetched = await fetchWithLimit(this.#fetch, candidate.url);
    if (typeof fetched === "string") fetched = { source: candidate.url, content: fetched, contentType: "text/html", status: 200 };
    let content = fetched?.content ?? fetched?.html ?? fetched?.text ?? fetched?.body;
    if (typeof content !== "string") throw new Error(`web-get ${key} returned no text`);
    const rawBytes = Buffer.from(content, "utf8");
    if (rawBytes.length > WEB_FETCH_MAX_BYTES) {
      content = rawBytes.subarray(0, WEB_FETCH_MAX_BYTES).toString("utf8");
      fetched = { ...fetched, transportTruncated: true };
    }
    // The searched URL remains authoritative provenance even when redirects occur;
    // final_url is retained in the sidecar without changing the stable source.
    const converted = /html|xhtml/i.test(fetched?.contentType ?? "") || /<\s*(?:html|body|article|main|p|h1)\b/i.test(content)
      ? htmlToBoundedMarkdown(content, { source: candidate.url })
      : htmlToBoundedMarkdown(content.replace(/[<>]/g, (char) => char === "<" ? "&lt;" : "&gt;"), { source: candidate.url });
    return materializeEvidence(this.#workspace, {
      ref: key,
      surface: "web",
      source: candidate.url,
      markdown: converted.markdown,
      metadata: {
        title: candidate.title,
        final_url: compact(fetched?.source ?? fetched?.url ?? candidate.url, 2048),
        content_type: compact(fetched?.contentType, 120),
        status: Number.isInteger(fetched?.status) ? fetched.status : null,
        truncated: converted.truncated || fetched?.transportTruncated === true,
      },
    });
  }
}

function joinPath(root, relativePath) {
  return `${root}/${relativePath}`.replace(/\/+/g, "/");
}

export function createResearchWeb(options) {
  return new ResearchWebAdapter(options);
}
