/** Official zvec-grep installer AGENTS.md block (default Codex/Claude names). */

export const ZVEC_GREP_AGENTS_START = "<!-- ZVEC_GREP_START -->";
export const ZVEC_GREP_AGENTS_END = "<!-- ZVEC_GREP_END -->";

export const ZVEC_GREP_AGENT_GUIDANCE = `${ZVEC_GREP_AGENTS_START}
## zvec-grep

Choose the evidence source before the retrieval mode.

### Workspace evidence
- Use the current workspace as the evidence source when the user asks about local material, prior context establishes it as relevant, or the question concerns how the current project works—even if the workspace is not mentioned explicitly.
- A workspace may contain any mix of code, documents, configuration, and data.
- Do not use workspace retrieval for unrelated open-world questions, current external facts, or web content that does not depend on local evidence.

### Retrieval routing
- When an exact word, phrase, name, date, identifier, filename, path, configuration key, error message, source fragment, literal, or regex is known and locating its occurrences is sufficient, use native Grep or \`rg\`.
- Use \`zvec_grep_search\` when wording or location is unknown, or when the answer requires semantic, conceptual, fuzzy, or paraphrase discovery; relationships, chronology, causality, architecture, or data or control flow; or comparison or synthesis across files, sections, or documents.
- For a mixed task with exact anchors that still requires relationships or cross-file synthesis, call \`zvec_grep_search\` with the concept and anchors, then use native Grep or \`rg\` for focused follow-up.
- When no sufficient exact anchor is available and the user asks whether conceptually related material exists locally, make at most one focused \`zvec_grep_search\` probe using the question plus distinctive names, dates, or terms. This probe does not apply to exact quotations, configuration keys, filenames, regexes, or exhaustive occurrence requests. Continue only when results are relevant; otherwise stop and report that the indexed workspace did not establish the answer.
- Before broad file reads or delegating workspace discovery, use the appropriate search route. Do not delegate solely to locate material, and stop when the evidence is sufficient.

### Search evidence
- Search results include bounded source snippets. Treat a sufficient snippet as already-read evidence, and read a cited file only when a required detail falls outside the snippet.

### Freshness and index lifecycle
- Pass a daemon-visible absolute \`root\` on every zvec-grep workspace call.
- Read \`freshness\` and \`background_refresh\` from search results without a status preflight.
- When results are \`served_from_current_index\`, use them when sufficient instead of waiting for the background refresh.
- If the index is missing but exact or regex lookup can answer the task, use native Grep or \`rg\`.
- Creating, rebuilding, or dropping a persistent index requires an explicit user request or authorization; never do so silently.

If the MCP connection is unavailable, the same indexed search and optional managed-rg route remain available from the shell:

\`\`\`
zg query "where theme preferences are restored"
zg query --rg -F "loadTheme" src
\`\`\`
${ZVEC_GREP_AGENTS_END}`;
