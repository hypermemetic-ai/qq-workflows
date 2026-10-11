# Design

## Context

See `proposal.md` for motivation. T3 Code 0.0.45 runs as a user service and uses
the installed Codex CLI. Twenty-six project folders are registered; some have
OpenSpec roots and others do not. qq-workflows owns a byte-unmodified OpenSpec
1.14.0 core collection. Paseo exposes that collection per conversation, so global
activation would change its existing off/on semantics.

## Goals / Non-Goals

The integration should be discoverable in fresh T3 sessions, preserve native
delegation and permission handling, and keep OpenSpec as the only change/spec
authority. It does not replace T3's server, introduce a legacy Architect provider,
change model selection, or silently initialize every registered repository.

## Decisions

### Grilling-based adapter

Matt Pocock's decision-tree method focuses on consequential engineering decisions.
The adapter limits questions to the material frontier and defaults to one focused
question per turn on a phone. OpenSpec supplies persistent artifacts and final
semantic sync. The original grilling reference and MIT license are pinned and
unmodified; the adapter states its adaptations.

Superpowers also covers execution but brings its own design/plan/ledger lifecycle.
Compound Engineering offers a broad planning and review suite with its own unified
plan contract. Both can work, but layering either complete suite over OpenSpec
would create two competing artifact systems. The focused questioning adapter fits
the existing native core without that extra authority.

### Dedicated T3 Codex home

Copy the current Codex configuration into a T3-only home and link the existing
auth file without reading credentials. Add the approved profile instructions,
six stock skills and the adapter there. Preserve existing model/MCP settings and
override only implementation permissions and native-agent settings in that home.
T3's existing provider home setting selects it; native settings reload avoids an
unnecessary service restart. Shared global skill installation was rejected because
it would also affect Paseo and unrelated native sessions.

### Native worktrees and one integration owner

T3's worktree default provides a thread checkout; the architect reuses that
checkout rather than nesting it. Independent workers get separate worktrees from
the integration base, while dependent or overlapping tasks run sequentially.
The architect owns shared task progress, review, integration, spec sync and archive.
This preserves routine worker autonomy without concurrent writes to the shared
index or authoritative spec tree.

### Explicit spec and Git finalization

The change contract remains active until implementation is reviewed. Stock sync
merges delta requirements into the selected main-spec root and verifies every
operation before archive moves the delta. The branch then delivers the code,
maintained specs and archive together. A separate planning store has its own Git
delivery, and successful local sync never stands in for a landed PR or activation.

## Risks / Trade-offs

- Profile isolation changes Codex's session home for T3 → install before any
  provider sessions are active and preserve the source home and histories.
- Skill discovery differs between host versions → verify with actual Codex
  app-server `skills/list` and a live T3 provider probe.
- Instructions guide agents rather than enforce a state machine → independently
  review realistic planning and worker scenarios and keep the contract concise.
- Source configuration can evolve after installation → rerun the installer to
  refresh the dedicated profile; keep private backups before replacement.
- Some projects lack OpenSpec → resolve setup when that project's planning round
  requests it rather than writing unrelated configuration during activation.

## Migration Plan

Install the dedicated profile and T3 settings through the idempotent installer.
Verify unchanged upstream skills, the existing login, actual skill discovery,
worktree/full-access defaults and server health. Start a fresh T3 thread to load
the profile. Roll back using the installer's private backups of settings/profile
files; the original Codex home remains untouched.
