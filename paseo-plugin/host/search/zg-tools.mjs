/** Whitelisted zg MCP tools. Descriptions are the live zvec-grep MCP strings. */

export const ZVEC_GREP_SEARCH = Object.freeze({
  name: "zvec_grep_search",
  title: "Search with zvec-grep",
  description:
    "Search an existing workspace index for semantic, relational, cross-file, or multi-hop evidence such as architecture, call chains, dependencies, lifecycle, data or control flow, design rationale, and comparisons. Use it when exact lookup alone cannot answer a workspace-grounded question. Results include bounded source snippets and query-group metadata; treat sufficient snippets as already-read evidence. Use zvec_grep_rg instead when exact lookup alone is sufficient. Read freshness and background_refresh from the response; when results are served_from_current_index, use them if sufficient.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      root: {
        type: "string",
        description: "Absolute workspace root visible to the daemon.",
      },
      query: {
        type: "string",
        description: "One primary hybrid-search group using natural-language or exact terms.",
      },
      queries: {
        description: "One or more primary hybrid-search groups.",
      },
      fts: {
        description: "Supplemental lexical-route groups for exact anchors such as symbols, flags, or error messages; these are retrieval routes, not hard result constraints.",
      },
      vector: {
        description: "Supplemental semantic/vector-route groups; these are retrieval routes, not hard result constraints.",
      },
      limit: {
        type: "integer",
        description: "Maximum returned items per query group, or for the single fused plan.",
      },
      globs: { description: "Ordered case-sensitive rg-style glob rules. Later rules override earlier rules." },
      fuse: {
        type: "boolean",
        description: "Collapse all primary and supplemental groups into one ranked search plan; otherwise search groups separately and retain group metadata.",
      },
      freshness: {
        type: "string",
        description: "Whether to search immediately or wait for the active index to become fresh.",
      },
    }),
    required: Object.freeze(["root"]),
  }),
});

export const ZVEC_GREP_RG = Object.freeze({
  name: "zvec_grep_rg",
  title: "Search with managed ripgrep",
  description:
    "Run exhaustive, AST-enriched ripgrep across code or non-code workspace material without an index. Use it when a known word, symbol, filename, source fragment, or regex can answer the workspace-grounded question. Pass a command starting with `rg`; results are exhaustive unless a trailing `| head -N` explicitly bounds them.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      root: {
        type: "string",
        description: "Absolute workspace root visible to the daemon. Keep this at the workspace root; scope the search with command paths or globs.",
      },
      command: {
        type: "string",
        description: "The command MUST start with `rg`; it is parsed as arguments and never executed by a shell. Search is exhaustive by default; append `| head -N` only to request a bounded result set.",
      },
    }),
    required: Object.freeze(["root", "command"]),
  }),
});

export const ZG_WHITELIST = Object.freeze([
  ZVEC_GREP_SEARCH.name,
  ZVEC_GREP_RG.name,
]);
