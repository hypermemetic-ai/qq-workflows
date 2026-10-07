# Spec Delta

## Purpose

Bound the lifetime of native status animation and working-indicator timers to when their output is useful, while preserving interactions and maintaining a small, reviewable Paseo fork across upstream updates.

## ADDED Requirements

### Requirement: Reduced motion preserves static running status
The native running-status ring SHALL display its running meaning without recurring animation work when the selected reduced-motion policy disables motion.

#### Scenario: Running agent with reduced motion
- **WHEN** an agent is running and reduced motion is selected
- **THEN** its running indicator remains recognizable and its containing control remains tappable
- **AND** the indicator schedules no recurring rotation updates

### Requirement: Inactive rings stop contributing animation work
A native status ring SHALL animate only when motion is enabled, its retained panel is active and the app is foregrounded. A hidden or backgrounded ring SHALL stop contributing recurring animation work without unmounting its retained view.

#### Scenario: Retained sidebar becomes hidden
- **WHEN** a panel containing running indicators becomes inactive
- **THEN** its mounted indicators cease receiving recurring rotation updates
- **AND** their retained native views remain mounted

#### Scenario: App enters the background
- **WHEN** the app leaves the foreground while a panel contains running indicators
- **THEN** those indicators stop contributing recurring animation work

### Requirement: No eligible rings means no running ring clock
The shared native ring clock SHALL stop scheduling recurring callbacks when its final eligible consumer leaves. It SHALL run only one recurring loop when eligible consumers exist.

#### Scenario: Final eligible ring is hidden
- **WHEN** the final eligible ring becomes hidden, backgrounded, motion-disabled or unmounted
- **THEN** any already scheduled callback can finish teardown
- **AND** no subsequent recurring ring callback is scheduled

#### Scenario: One visible ring among hidden rings
- **WHEN** one ring is eligible and other mounted rings are inactive
- **THEN** one shared clock services the eligible ring
- **AND** inactive rings receive no recurring rotation updates

### Requirement: Ring resumption preserves synchronization
Native rings that become eligible SHALL resume at the current shared wall-clock phase without replaying missed animation frames or starting independent loops.

#### Scenario: Hidden running indicator returns
- **WHEN** a hidden running indicator becomes visible with motion enabled
- **THEN** it resumes in phase with other visible running indicators
- **AND** no animation backlog is replayed

### Requirement: Background working indicators suspend display work
The working elapsed-time display and native loader SHALL stop recurring display updates while the app is backgrounded, in addition to their existing panel-visibility and motion policies. Foregrounding SHALL refresh their output from current wall-clock time without replaying missed ticks.

#### Scenario: Backgrounded running turn
- **WHEN** the app is backgrounded during a running turn
- **THEN** the elapsed-time display stops its periodic display updates
- **AND** the native loader stops recurring animation callbacks
- **AND** the agent continues independently on its daemon

#### Scenario: Running turn is shown again
- **WHEN** the app returns to the foreground and the running turn's panel is active
- **THEN** elapsed time reflects the actual time since the turn began
- **AND** the loader resumes only if its motion policy permits animation
- **AND** missed ticks are not replayed

### Requirement: Interaction and selected settings are preserved
The changes SHALL preserve status meaning, message submission, rewind, dismissal, session selection, scrolling, keyboard use and native gestures. They MUST preserve retained native view identity and the operator's selected Android animation settings.

#### Scenario: Static indicators during normal use
- **WHEN** reduced motion is selected and the user submits, rewinds, dismisses or switches sessions
- **THEN** the existing action and gesture semantics remain available
- **AND** the selected Android animation settings remain unchanged

### Requirement: Each retained patch has independent native evidence
Each retained runtime patch SHALL have independent controlled native evidence of less unnecessary callback activity, wakeups or CPU, together with interaction and resume checks. Faster actions are not required for acceptance. Battery-life improvement SHALL be reported as measured only when battery consumption was actually compared.

#### Scenario: Ring saves work without improving tap latency
- **WHEN** repeated same-device comparisons show stopped inactive ring work and regression checks pass while tap latency stays unchanged
- **THEN** the ring patch can be retained on its demonstrated resource benefit
- **AND** a battery-life percentage is not claimed without a battery measurement

#### Scenario: Second patch is evaluated
- **WHEN** working-indicator suspension is evaluated after the ring
- **THEN** its baseline includes the accepted ring patch
- **AND** the evidence distinguishes the second patch's contribution

### Requirement: Update integration keeps patches visible and replaceable
Paseo maintenance SHALL link the active plan and keep each retained patch's source commit, upstream base, native evidence and retirement condition discoverable. Every upstream update SHALL reassess each patch independently and retire a local patch when upstream provides equivalent behavior.

#### Scenario: Updating the fork
- **WHEN** an upstream Paseo update is integrated
- **THEN** the update owner checks both display-work outcomes against upstream
- **AND** retires equivalent local deltas while preserving any remaining needed outcome
- **AND** updates the patch's source and native verification references

#### Scenario: Plan is archived
- **WHEN** the completed change is archived
- **THEN** the maintenance link is updated to its durable spec, archive or owning patch record
- **AND** update integration still finds every retained runtime patch

### Requirement: Runtime scope stays bounded
This change SHALL contain at most two separately reviewable runtime patches. Additional optimizations SHALL require a measured problem and a new explicit scope decision. The change MUST preserve package identity, pairings, running agents and daemon operation. The selected fork signing identity SHALL remain stable across subsequent fork updates; any initial Play-to-fork signing transition SHALL be recorded.

#### Scenario: Another candidate is discovered
- **WHEN** implementation finds a possible Markdown, badge, networking or framework optimization
- **THEN** it records the finding without adding it to these runtime patches
- **AND** further implementation awaits a separate scope decision

#### Scenario: Verification build cannot replace the Play app
- **WHEN** a native verification build has a different signing identity
- **THEN** the explicitly selected replacement uses a reviewed signing-transition and data-transfer or recovery procedure
- **AND** the installed Play app is not removed before recoverability is established

### Requirement: Delivery includes the Android client replacement
Delivery SHALL finish with the verified fork client replacing the existing Play Store client under the production Android package. It SHALL verify the installed artifact, restored connectivity and selected settings separately from source delivery. Any unrecoverable local-data loss SHALL require an explicit operator decision before removal.

#### Scenario: Fork client is activated
- **WHEN** the accepted client build is delivered
- **THEN** the installed Android artifact is verified as the fork build
- **AND** it connects to the existing daemon with pairings and selected settings preserved or restored
- **AND** a source merge alone does not count as completed delivery
