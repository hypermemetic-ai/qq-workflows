# t3-openspec-architecture Specification

## Purpose

Let an engineer plan, delegate and deliver T3-hosted changes whose OpenSpec delta
specifications become accurate maintained documentation after reviewed implementation.

## Requirements

### Requirement: Evidence-grounded engineering conversation
The architect SHALL follow the original grilling instructions for the architecture
conversation, including dependency-aware frontier rounds, recommended answers,
delegated factual investigation and engineer confirmation of shared understanding.

#### Scenario: A decision depends on an unresolved choice
- **WHEN** a technical decision depends on a product choice the engineer has not settled
- **THEN** the architect asks about the prerequisite before requesting the dependent decision

#### Scenario: A codebase fact can answer a question
- **WHEN** source, specs or configuration establish a relevant fact
- **THEN** the architect uses that evidence rather than asking the engineer to repeat it

#### Scenario: Multiple decisions are currently answerable
- **WHEN** several unsettled decisions have settled prerequisites
- **THEN** the architect asks the whole frontier in one round with recommended answers

#### Scenario: Discussion has not been confirmed complete
- **WHEN** the frontier still has unanswered decisions or shared understanding has not been confirmed
- **THEN** the architect continues the original grilling conversation before capturing the change

### Requirement: OpenSpec planning contract
The architect SHALL own the OpenSpec phases and capture agreed behavioral changes
as proposal, delta specs, architecture design and tasks using the project's stock
schema and instructions, preserving their confirmation and handoff rules. Grilling
SHALL be the sole interview controller for the architecture round.

#### Scenario: An architecture round settles a behavioral change
- **WHEN** the agreed scope is ready for capture
- **THEN** the change artifacts describe the scope, observable behavior, decisions and acceptance evidence
- **AND** the delta specs validate before implementation begins

#### Scenario: Planning is the only authorized work
- **WHEN** the engineer requests a planning round without implementation authority
- **THEN** the architect presents the concrete artifacts and leaves implementation pending

#### Scenario: Architecture planning overlaps OpenSpec exploration
- **WHEN** the T3 architect runs a grilling round
- **THEN** OpenSpec exploration instructions do not replace or join the grilling interview

#### Scenario: Change artifacts have just been proposed
- **WHEN** the architect presents artifacts through the stock propose workflow
- **THEN** implementation follows that workflow's subsequent-request handoff

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
