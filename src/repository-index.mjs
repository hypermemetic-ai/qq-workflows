// Bounded architect orientation supplied by qq-index. This adapter owns the
// workflow prompt shape; qq-index owns index validation and size limits.

import { repoRootFor } from "./git.mjs";

export const REPOSITORY_INDEX_CONTEXT_NAME = "qq-workflows:repository-index";
export const REPOSITORY_INDEX_CONTEXT_ORDER = 15;
export const REPOSITORY_INDEX_HEADER = "Repository index (routing only; source and tests remain authoritative):";

export function repositoryRoot(cwd) {
  return repoRootFor(cwd);
}

export function renderRepositoryIndexContext(index) {
  const body = typeof index === "string" ? index.trim() : "";
  return body ? `${REPOSITORY_INDEX_HEADER}\n\n${body}` : "";
}

function loaderFrom(ctx, supplied) {
  if (typeof supplied === "function") return supplied;
  if (typeof supplied?.loadIndex === "function") return supplied.loadIndex.bind(supplied);

  const service = ctx?.get?.("qq-index", false);
  if (typeof service === "function") return service;
  if (typeof service?.loadIndex === "function") return service.loadIndex.bind(service);
  return null;
}

/**
 * Load one prompt context without allowing index lookup, I/O, or validation
 * errors to abort architect attachment. An absent loader or empty index returns
 * no context; callers surface returned errors to the operator and logger.
 */
export function loadRepositoryIndexContext({ ctx, cwd, loadIndex } = {}) {
  let loader;
  try {
    loader = loaderFrom(ctx, loadIndex);
  } catch (error) {
    return { context: null, error };
  }
  if (!loader) return { context: null, error: null };

  try {
    const root = repositoryRoot(cwd);
    const index = loader(root);
    if (typeof index !== "string") {
      throw new Error("qq-index: loadIndex returned a malformed index");
    }
    const text = renderRepositoryIndexContext(index);
    if (!text) return { context: null, error: null };
    return {
      context: {
        name: REPOSITORY_INDEX_CONTEXT_NAME,
        order: REPOSITORY_INDEX_CONTEXT_ORDER,
        text: () => text,
      },
      error: null,
    };
  } catch (error) {
    return { context: null, error };
  }
}
