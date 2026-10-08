# Working agreements

Exercise judgment in pursuit of the user's purpose. Treat plans, rules and assumptions as revisable tools: understand what they are for and whether they apply here. Investigate uncertainty that matters, act when you know enough, and let observed consequences improve your understanding of both the problem and your next move.

Repository work includes scoped commits and pushes to the established remote, its required PR/merge path, and ordinary activation needed for the usable outcome. Aim for zero unattended Git work. At task start and before completion, run `node /home/qqp/projects/qq-workflows/scripts/git-status.mjs` from the checkout being worked on. Use `--cached` offline; remote freshness is then unknown. Investigate other worktrees or PRs when the task involves them.

Before finishing, stop temporary servers and background processes started for the task, including by child agents, unless they are part of the requested live result.

<!-- ZVEC_GREP_START -->
## zvec-grep

Choose the evidence source before the retrieval mode.

### Workspace evidence
- Use the current workspace as the evidence source when the user asks about local material, prior context establishes it as relevant, or the question concerns how the current project works—even if the workspace is not mentioned explicitly.
- A workspace may contain any mix of code, documents, configuration, and data.
- Do not use workspace retrieval for unrelated open-world questions, current external facts, or web content that does not depend on local evidence.

### Retrieval routing
- When an exact word, phrase, name, date, identifier, filename, path, configuration key, error message, source fragment, literal, or regex is known and locating its occurrences is sufficient, use `zvec_grep_rg` when it is listed by the current host; otherwise native Grep or `rg`.
- Use `zvec_grep_search` when wording or location is unknown, or when the answer requires semantic, conceptual, fuzzy, or paraphrase discovery; relationships, chronology, causality, architecture, or data or control flow; or comparison or synthesis across files, sections, or documents.
- For a mixed task with exact anchors that still requires relationships or cross-file synthesis, call `zvec_grep_search` with the concept and anchors, then use `zvec_grep_rg` when it is listed by the current host; otherwise native Grep or `rg` for focused follow-up.
- When no sufficient exact anchor is available and the user asks whether conceptually related material exists locally, make at most one focused `zvec_grep_search` probe using the question plus distinctive names, dates, or terms. This probe does not apply to exact quotations, configuration keys, filenames, regexes, or exhaustive occurrence requests. Continue only when results are relevant; otherwise stop and report that the indexed workspace did not establish the answer.
- Before broad file reads or delegating workspace discovery, use the appropriate search route. Do not delegate solely to locate material, and stop when the evidence is sufficient.

### Search evidence
- Search results include bounded source snippets. Treat a sufficient snippet as already-read evidence, and read a cited file only when a required detail falls outside the snippet.

### Freshness and index lifecycle
- Pass a daemon-visible absolute `root` on every zvec-grep workspace call.
- Read `freshness` and `background_refresh` from search results without a status preflight.
- When results are `served_from_current_index`, use them when sufficient instead of waiting for the background refresh.
- If the index is missing but exact or regex lookup can answer the task, use `zvec_grep_rg` when it is listed by the current host; otherwise native Grep or `rg`.
- Creating, rebuilding, or dropping a persistent index requires an explicit user request or authorization; never do so silently.

<!-- ZVEC_GREP_END -->

<!-- QQ_JOB_RESOURCE_START -->
## Heavy command resources

Where the current execution context already permits access to the user systemd
manager, run tests, builds, package installation, data processing and other
potentially heavy commands through /home/qqp/.local/bin/qq-job. Use its default profile for
ordinary work, for example `/home/qqp/.local/bin/qq-job -- npm test`. Wrap an entire shell pipeline
with `/home/qqp/.local/bin/qq-job --shell-command '<literal command>'`, keeping the tool's normal
working directory, sandbox and approval settings. Quote the command as shell
data; preserve literal variables and newlines.

The launcher enforces total job RAM, swap and task limits before execution.
The default Codex sandbox on this host denies its systemd socket. Preserve that
sandbox and normal approval settings; do not request broader access solely to
use the launcher. In that context, the independent host guard protects recognized
Codex Node test workers. Use bounded inputs, compact assertion diagnostics and
low test concurrency for other commands, whose total memory is not automatically
contained. In a context with manager access, a placement or verification failure
must be repaired before retrying that job. Lightweight read-only lookups may run
directly. A persistent task service should have its own declared limits;
background descendants of an ordinary qq-job invocation are cleaned up on exit.

A resource intervention can reflect a job budget or host memory pressure. Reduce input,
concurrency or oversized failure diagnostics before retrying. A larger named
profile is appropriate for an understood workload whose budget fits the available
host memory and aggregate job limit; do not repeatedly increase a runaway test's
budget. Heap flags alone do not limit native buffers or a whole process tree.
<!-- QQ_JOB_RESOURCE_END -->
