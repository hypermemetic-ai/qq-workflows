# Design

## Context

See proposal.md for motivation. The original MIT grilling reference is already
pinned and available. OpenSpec core skills/schema are shared with other native
consumers and must remain unchanged. Some project-local copies are also
advertised by native skill discovery.

## Goals / Non-Goals

The integration selects phase owners and delegates without redefining either
source's behavior. No alternate interview, approval policy, artifact format,
worker runtime or source-skill patch is introduced.

## Decisions

### Original interview and one small routing skill

The router reads the existing byte-original grilling reference as the sole
interview controller. Remove the adapted phone preference, material-frontier
stopping rule and alternate questioning instructions. Explicitly exclude
OpenSpec explore during this round. Keep all custom phase and delegation glue
in the single routing skill, with only a short profile entry pointing to it.

Changing implicit-invocation metadata on the global collection alone was rejected:
project-local OpenSpec copies are independently discoverable. Per-project
rewrites would broaden this correction. A direct phase instruction in the
profile's AGENTS route applies across these discovery locations.

### Architect-owned stock OpenSpec phases

After original grilling completes and the engineer confirms understanding, the
architect follows stock propose/update. Propose's subsequent implementation
request, update's edit confirmations and archive's choices remain intact.
The architect runs apply and delegates implementation steps, then reviews,
integrates and updates task state. Workers do not invoke apply themselves.
Sync verifies maintained requirements before archive moves their source change.

### Two bounded assignment contracts

Research returns evidence for the original grilling decision tree without
project edits. Implementation returns scoped commits and checks for architect
review. Separate worktrees apply to independent implementation; research can
read an existing checkout. No separate delegation framework or repetitive
engineering guidelines remain.

## Risks / Trade-offs

- Routing remains an agent instruction, not a state machine: independently
  evaluate phase transitions and delegated roles against the original sources.
- Existing threads may retain old loaded instructions: refresh the dedicated
  profile from landed sources and use a fresh T3 conversation.
- Stock source handoffs can require further user input: preserve them explicitly
  rather than inventing overrides in the integration.

## Migration Plan

Land the reviewed router and documentation/spec update through the established
PR path. Rerun the existing installer from the permanent checkout to refresh
profile instructions; skill references are already linked. Verify source hashes,
native discovery and installation drift. Private profile backups provide rollback.
