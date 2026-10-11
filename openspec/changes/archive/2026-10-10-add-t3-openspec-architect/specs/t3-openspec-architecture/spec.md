# Spec Delta

## Purpose

Let an engineer plan, delegate and deliver T3-hosted changes whose OpenSpec delta
specifications become accurate maintained documentation after reviewed implementation.

## ADDED Requirements

### Requirement: Evidence-grounded engineering conversation
The architect SHALL investigate discoverable facts and discuss material product
and architecture decisions with the engineer in dependency order, with grounded
recommendations and explicit distinctions between decisions and assumptions.

#### Scenario: A decision depends on an unresolved choice
- **WHEN** a technical decision depends on a product choice the engineer has not settled
- **THEN** the architect asks about the prerequisite before requesting the dependent decision

#### Scenario: A codebase fact can answer a question
- **WHEN** source, specs or configuration establish a relevant fact
- **THEN** the architect uses that evidence rather than asking the engineer to repeat it

### Requirement: OpenSpec planning contract
The workflow SHALL capture agreed behavioral changes as OpenSpec proposal, delta
specs, architecture design and actionable tasks using the selected project's
stock schema and instructions, without creating a competing planning document.

#### Scenario: An architecture round settles a behavioral change
- **WHEN** the agreed scope is ready for capture
- **THEN** the change artifacts describe the scope, observable behavior, decisions and acceptance evidence
- **AND** the delta specs validate before implementation begins

#### Scenario: Planning is the only authorized work
- **WHEN** the engineer requests a planning round without implementation authority
- **THEN** the architect presents the concrete artifacts and leaves implementation pending

### Requirement: T3-specific activation
The installation SHALL make the architect adapter and unchanged OpenSpec core
skills discoverable to T3's Codex provider through an independent home, retaining
the existing login and unrelated configuration while preserving other agent homes.

#### Scenario: Installation activates the dedicated profile
- **WHEN** the installer completes successfully
- **THEN** T3's Codex provider uses the dedicated home and discovers the adapter and all six core skills
- **AND** the original Codex configuration and unrelated T3 providers remain unchanged

#### Scenario: Installation is repeated
- **WHEN** the installer runs against its existing installation
- **THEN** the settings remain valid and skill registrations do not duplicate

### Requirement: Autonomous workers with architect review
After implementation is authorized, the architect SHALL delegate bounded work
with isolated checkout ownership and agreed interfaces, review actual changes
and acceptance evidence, and integrate accepted commits sequentially.

#### Scenario: Independent tasks run concurrently
- **WHEN** multiple workers implement independent tasks
- **THEN** each receives a distinct worktree and a bounded contract
- **AND** the architect alone updates shared progress and integrates their commits

#### Scenario: A worker reports completion
- **WHEN** an implementer returns its commits and verification
- **THEN** the architect checks the diff and evidence against the change before accepting it

### Requirement: Durable specification delivery
The workflow SHALL sync verified implemented deltas into main specifications,
verify the resulting requirements, archive the change only after sync finishes,
and deliver the implementation, updated specs and archive through the project's
authorized Git and activation path.

#### Scenario: Reviewed implementation is ready to land
- **WHEN** implementation and acceptance checks are complete
- **THEN** the resulting main specs describe the implemented behavior and preserve unrelated requirements
- **AND** the archive and specification update are committed on the delivered branch

#### Scenario: Specification sync succeeds before Git delivery
- **WHEN** a delta has synced but its branch has not landed
- **THEN** the architect reports that Git delivery remains pending rather than claiming the change shipped
