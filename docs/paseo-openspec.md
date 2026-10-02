# OpenSpec in Paseo

Set **OpenSpec planning** in the conversation's existing feature menu beside the
composer before sending the first message. On exposes the six stock OpenSpec
skills and supplies the approved planning preference. Off omits both. Skills
still use Codex's normal discovery and on-demand instruction loading.

The skills are installed once at `~/.local/share/openspec/skills`, outside Codex's
automatically scanned skill directories. Paseo adds that collection through
Codex's process-local `skills/extraRoots/set` when enabled. Each conversation has
its own native process; the setting does not change other conversations or the
user's global Codex configuration. After a skill's instructions have entered a
conversation's history, use a fresh conversation with the toggle off for a clean
start. There is no automatic clearing or additional lifecycle policy.

Discuss and propose changes in the planning conversation. Ask it to implement
when ready; existing child agents handle implementation. The pill above the
composer opens the child, and results return to the parent. Native children can
use their parent's native skill collection. A separate managed child can receive
an explicit task to read `~/.local/share/openspec/skills/openspec-apply-change/SKILL.md`
and apply the agreed change, without the parent's planning preference.

Project-specific `openspec/` specs, configuration and change history remain in
Git. Generic skill copies and their generation markers are removed from adopted
repos. Custom project skills remain where their owners put them. Native Plan is
mutually exclusive with this setting because it prevents OpenSpec artifact
writes. Android uses its existing feature menu and child UI.

The only added standing prompt remains the approved text:

> The default focus of this conversation is discussion, investigation and OpenSpec planning. Implementation of agreed changes normally runs in a child agent, with decisions and follow-up continuing here.

The unmodified OpenSpec 1.14.0 core collection is kept in
`vendor/openspec/skills`. Install its shared link with:

```sh
mkdir -p ~/.local/share/openspec
ln -s /home/qqp/projects/qq-workflows/vendor/openspec/skills ~/.local/share/openspec/skills
```

For an upstream update, generate the stock core skills with the installed
OpenSpec CLI in a disposable project (`openspec init --tools codex --profile core`),
then replace this collection with the generated files. No local template fork is
maintained. Running `openspec update` inside an adopted project may regenerate
local skill copies; update the central collection instead.

Source: [compatible Paseo branch](https://github.com/qqp-dev/paseo/tree/qq/openspec-planning),
based on upstream 0.10.2. The versioned runtime patch and manifest are in
`patches/paseo/0.10.2/openspec-planning.*`. Run
`node scripts/stage-paseo-openspec.mjs` to stage its Pi-compatible candidate and
`--verify` to check it. Normal activation selects the printed candidate in both
the service and CLI, then restarts at an idle boundary. The previous release
remains available for rollback.
