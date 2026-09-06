import { loadResearchSecrets } from "../providers/secrets.mjs";

const VISIT_MAX = 12_000;

function researchKey(name, env = process.env) {
  const fromEnv = String(env?.[name] ?? "").trim();
  if (fromEnv) return fromEnv;
  return loadResearchSecrets({ env })[name] ?? "";
}

export async function braveSearch(query, { fetchFn = fetch, env = process.env } = {}) {
  const key = researchKey("BRAVE_API_KEY", env);
  if (!key) throw new Error("BRAVE_API_KEY is not set");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  const response = await fetchFn(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`brave_search HTTP ${response.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const results = (json?.web?.results ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    description: item.description,
  }));
  return JSON.stringify(results, null, 2);
}

export async function exaSearch(query, { fetchFn = fetch, env = process.env } = {}) {
  const key = researchKey("EXA_API_KEY", env);
  if (!key) throw new Error("EXA_API_KEY is not set");
  const response = await fetchFn("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: 8, type: "auto" }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`exa_search HTTP ${response.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const results = (json?.results ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    text: item.text ?? item.summary,
  }));
  return JSON.stringify(results, null, 2);
}

export async function visitWebpage(url, { fetchFn = fetch, max = VISIT_MAX } = {}) {
  const response = await fetchFn(url, { redirect: "follow" });
  const text = await response.text();
  if (!response.ok) throw new Error(`visit_webpage HTTP ${response.status}`);
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > max ? `${stripped.slice(0, max)}\n…` : stripped;
}
