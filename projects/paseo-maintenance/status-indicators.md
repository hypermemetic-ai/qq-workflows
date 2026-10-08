# Paseo static-status delivery record

The approved [presentation change](../../openspec/changes/clarify-paseo-status-indicators/design.md)
replaces motion-dependent graphics under reduced motion, keeping existing text,
elapsed timing, actions and status semantics. The original ring optimization and
rejected background-timer patch remain owned by [display-work.md](display-work.md).

## Acceptance and ownership

This follow-up resolves the operator's observed legibility problem. Native
acceptance requires intentional static presentation, correct status transitions
and interaction/timer behavior, with repeated CPU/frame checks against the
ring-only fork on an isolated Android emulator, as requested by the operator.
Emulator results do not establish physical-phone CPU or battery savings. The
original ring's physical-device evidence remains separate.

Retire the presentation delta when upstream provides equivalent deliberate
reduced-motion workspace and active-turn graphics with shared status colors and
no additional recurring work. Reassess it independently of ring clock eligibility
on every update.

## Source delivery

The presentation source is [commit e94e96cda](https://github.com/qqp-dev/paseo/commit/e94e96cda0b9ce738f8b6adae2ebc7a282a6c3d5)
in [PR #2](https://github.com/qqp-dev/paseo/pull/2), targeting the existing beta fork.
The four-file runtime patch contains 62 additions and 5 removals: a complete native
reduced-motion ring outline, a static chat dot, existing status/permission wiring
and a screen-reader label. It adds no visible text, clock, timer or subscription.
The generic loader, accepted ring clock, footprint and containing controls are
unchanged.

The pinned source base is the installed ring-only beta fork at
`1ff50151c19ca8d870ded2727e8ed3c92133d041`, based on upstream
`0.11.0-beta.5` / `15d774d4a17c69bc0f8a62a85842764fab3c038d`. Upstream main
was checked at `99fc204c55c8c1666477282eeba562ba87a3135f`; these source areas
contain no equivalent presentation change. The isolated source worktree preserves
the previous ring branch and both primary checkouts' existing index directories.

Thirteen existing status-derivation checks, app typecheck, targeted npm lint,
formatting and formatting checks passed. The accessibility correction was followed
by another affected-source typecheck/lint/format check; the unchanged derivation
suite was not repeated. No full local suite was run.

## Native and Android delivery status

Native acceptance, source merge and installed activation are pending. The current
installed production APK was freshly verified to match the original ring-only
artifact and durable fork signer exactly. Main daemon identity and original
supervisor/worker processes match the previous delivery; all 13 original agent IDs
are still present. A private current session checkpoint is saved locally.

Delivery uses an in-place `sh.paseo` update with the existing durable fork signer,
preserving pairing and phone preferences while projects/sessions remain on the
existing daemon. The all-zero Android animation policy stays selected.
