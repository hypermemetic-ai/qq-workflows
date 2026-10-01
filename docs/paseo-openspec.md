# OpenSpec planning in Paseo

Enable **OpenSpec planning** in the conversation's existing feature menu beside
the composer. Discuss and propose changes in that conversation. Ask it to
implement when ready; implementation uses existing child agents. The child pill
above the composer opens the child, and results return to the parent.

The preference is saved per conversation and disables native Plan mode, which
prevents the file writes OpenSpec planning needs. New implementation sessions do
not inherit the parent's planning preference. Stock OpenSpec skills stay intact.
Android uses its existing feature menu and child UI; no custom APK is needed.

The only added standing prompt is the approved text:

> The default focus of this conversation is discussion, investigation and OpenSpec planning. Implementation of agreed changes normally runs in a child agent, with decisions and follow-up continuing here.

Source: [compatible Paseo branch](https://github.com/qqp-dev/paseo/tree/qq/openspec-planning),
commit `e5c4a073ee7011c50eddc42f70bedad6d558b4bd`, based on upstream 0.10.2.
The daemon patch also gives CLI-created children the existing parent completion
notification already used by MCP-created children.

The versioned patch and manifest are in `patches/paseo/0.10.2/openspec-planning.*`.
`node scripts/stage-paseo-openspec.mjs` copies the existing Pi-compatible release
and layers this patch onto that copy; `--verify` checks the staged files. Normal
activation selects its printed candidate in both the service and CLI, then
restarts at an idle boundary. Preserve the previous release for rollback.

Validation: 46 focused server tests, workspace typecheck/lint/build, real browser
proposal → child implementation → child-tab acceptance, and 25 offline Pi
integration checks against the staged release. Browser acceptance used the
provider's default model; production model selections are unchanged.
