# Paseo static-status delivery record

The approved [presentation change](../../openspec/changes/clarify-paseo-status-indicators/design.md)
replaces motion-dependent graphics under reduced motion, keeping existing text,
elapsed timing, actions and status semantics. The original ring optimization and
rejected background-timer patch remain owned by [display-work.md](display-work.md).

## Acceptance and ownership

This follow-up resolves the operator's observed legibility problem. Native
acceptance requires intentional static presentation, correct status transitions
and interaction/timer behavior, with repeated CPU/frame checks against the
ring-only fork. Further CPU reduction and battery savings are not presumed.

Retire the presentation delta when upstream provides equivalent deliberate
reduced-motion workspace and active-turn graphics with shared status colors and
no additional recurring work. Reassess it independently of ring clock eligibility
on every update.

## Delivery status

Source implementation, native acceptance and installed activation are pending.
The pinned candidate base is the installed ring-only beta fork at
`1ff50151c19ca8d870ded2727e8ed3c92133d041`, based on upstream
`0.11.0-beta.5` / `15d774d4a17c69bc0f8a62a85842764fab3c038d`.
Delivery uses an in-place `sh.paseo` update with the existing durable fork signer,
preserving pairing and phone preferences while projects/sessions remain on the
existing daemon. The all-zero Android animation policy stays selected.
