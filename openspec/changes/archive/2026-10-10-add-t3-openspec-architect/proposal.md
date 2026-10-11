# Proposal

## Why

T3 Code now serves the operator's projects on Android, but its default agent setup
does not establish an interactive architecture-to-OpenSpec workflow. The operator
wants engineering discussion, delegated implementation and reviewed changes whose
delta specs become maintained project documentation.

## What Changes

- Add a Matt Pocock grilling-based OpenSpec architect skill with a bounded,
  evidence-grounded engineering conversation and a native worker/reviewer contract.
- Install the adapter and unchanged OpenSpec core skills into a dedicated T3
  Codex home with the existing login and configuration.
- Configure T3 to use this profile, full implementation access and worktrees,
  without changing the user's other Codex/Paseo profiles or project sources.
- Document and verify semantic delta sync, archive and Git delivery as separate
  steps that keep the landed specification aligned with the shipped behavior.

## Capabilities

### New Capabilities

- `t3-openspec-architecture`: T3-specific interactive planning, isolated skill
  activation, delegated implementation review and durable specification delivery.

### Modified Capabilities

None.

## Impact

New skill and installer in qq-workflows; T3's provider/workspace settings and a
dedicated machine-local Codex profile. Existing stock OpenSpec skills/schema,
project source trees and unrelated provider instances remain owned by their
current workflows. No T3 server fork or legacy Architect provider is required.
