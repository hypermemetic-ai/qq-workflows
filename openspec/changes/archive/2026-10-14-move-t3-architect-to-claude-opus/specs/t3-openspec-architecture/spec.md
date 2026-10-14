# Spec Delta

## MODIFIED Requirements

### Requirement: T3-specific activation
The installation SHALL make the architect adapter and unchanged OpenSpec core
skills discoverable to T3's Claude provider running Claude Opus, through a
private profile added to each session, reusing the existing Claude login and
configuration without writing them, disabling T3's Codex provider and
preserving unrelated T3 settings and providers.

#### Scenario: Installation activates the dedicated profile
- **WHEN** the installer completes successfully
- **THEN** T3's Claude provider discovers the adapter and all six core skills
- **AND** new threads select Claude Opus and T3's text generation selects Claude Haiku
- **AND** the Claude home and unrelated T3 providers remain unchanged

#### Scenario: The Codex profile is retired
- **WHEN** the installer runs where the Codex profile was installed
- **THEN** T3's Codex provider is disabled and only installer-owned Codex settings are removed
- **AND** existing Codex conversation history remains on disk

#### Scenario: Installation is repeated
- **WHEN** the installer runs against its existing installation
- **THEN** the settings remain valid and skill registrations do not duplicate

### Requirement: Autonomous workers with architect review
The architect SHALL assign research agents factual prerequisites and implementation
agents bounded code tasks, review their evidence or changes, and own OpenSpec
state. Independent implementation agents SHALL use separate worktrees; accepted
commits SHALL be integrated sequentially.

#### Scenario: Independent tasks run concurrently
- **WHEN** multiple workers implement independent tasks
- **THEN** each receives a distinct worktree and a bounded contract
- **AND** the architect alone updates shared progress and integrates their commits

#### Scenario: A worker reports completion
- **WHEN** an implementer returns its commits and verification
- **THEN** the architect checks the diff and evidence against the change before accepting it

#### Scenario: Grilling needs a discoverable fact
- **WHEN** a frontier question depends on an unknown codebase fact
- **THEN** a research agent investigates without modifying project files and returns source evidence and uncertainty
- **AND** the architect continues questions whose prerequisites are already settled

#### Scenario: An implementation task is delegated
- **WHEN** the architect dispatches a task from the stock apply workflow
- **THEN** the worker implements the assignment and returns results without running parent OpenSpec workflows or updating shared task progress

#### Scenario: A delegate's work is integrated or rejected
- **WHEN** the architect has integrated or rejected a delegate's commits
- **THEN** that delegate's worktree and branch are removed

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

#### Scenario: The delivery pull request merges
- **WHEN** the change's pull request has merged
- **THEN** the thread's local branch is deleted and its clean worktree is removed
- **AND** no delegate worktrees or branches remain
