// Bounded architect orientation supplied by qq-wiki. This adapter owns the
// workflow prompt shape; qq-wiki remains the sole owner of index validation
// and its byte/line limits.

import { repoRootFor } from "./git.mjs";

export const WIKI_INDEX_CONTEXT_NAME = "qq-workflows:wiki-index";
export const WIKI_INDEX_CONTEXT_ORDER = 15;
export const WIKI_INDEX_HEADER = "Repository wiki index (routing only; source and tests remain authoritative):";

// Short aliases keep the context vocabulary convenient for consumers.
export const WIKI_CONTEXT_NAME = WIKI_INDEX_CONTEXT_NAME;
export const WIKI_CONTEXT_ORDER = WIKI_INDEX_CONTEXT_ORDER;

export function wikiRepoRoot(cwd) {
  return repoRootFor(cwd);
}

export function renderWikiIndexContext(index) {
  const body = typeof index === "string" ? index.trim() : "";
  return body ? `${WIKI_INDEX_HEADER}\n\n${body}` : "";
}

function loaderFrom(ctx, supplied) {
  if (typeof supplied === "function") return supplied;
  if (typeof supplied?.loadIndex === "function") return supplied.loadIndex.bind(supplied);

  const service = ctx?.get?.("qq-wiki", false);
  if (typeof service === "function") return service;
  if (typeof service?.loadIndex === "function") return service.loadIndex.bind(service);
  return null;
}

/**
 * Load one prompt context without ever allowing wiki I/O or validation errors
 * to abort architect attachment. An absent loader/index returns no context;
 * callers surface `error` to the operator and logger.
 */
export function loadWikiIndexContext({ ctx, cwd, loadIndex } = {}) {
  let loader;
  try {
    loader = loaderFrom(ctx, loadIndex);
  } catch (error) {
    return { context: null, error };
  }
  if (!loader) return { context: null, error: null };

  try {
    const root = wikiRepoRoot(cwd);
    const index = loader(root);
    if (typeof index !== "string") {
      throw new Error("qq-wiki: loadIndex returned a malformed index");
    }
    const text = renderWikiIndexContext(index);
    if (!text) return { context: null, error: null };
    return {
      context: {
        name: WIKI_INDEX_CONTEXT_NAME,
        order: WIKI_INDEX_CONTEXT_ORDER,
        text: () => text,
      },
      error: null,
    };
  } catch (error) {
    return { context: null, error };
  }
}
