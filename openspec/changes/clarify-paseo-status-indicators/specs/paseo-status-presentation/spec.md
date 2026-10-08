# Spec Delta

## Purpose

Make existing workspace and chat status indicators legible under reduced motion, with consistent status colors and no additional recurring display work.

## ADDED Requirements

### Requirement: Reduced-motion running indicators look intentionally static
The native workspace running indicator SHALL present an intentional static mark under reduced motion, preserving its existing color, placement and containing control.

#### Scenario: Running workspace on Android with motion disabled
- **WHEN** a workspace is running and reduced motion is selected
- **THEN** its running indicator displays a deliberate static mark instead of a frozen partial spinner
- **AND** the existing workspace control remains tappable

### Requirement: Chat uses a static status-colored graphic
Under reduced motion, the existing active-turn chat indicator SHALL replace the moving dot grid with a static mark using the application's established status colors. Its existing text, elapsed timer, visibility and actions SHALL remain unchanged. It MUST add no visible status labels.

#### Scenario: Active turn is working
- **WHEN** the existing chat working indicator is visible for a running turn under reduced motion
- **THEN** its graphic uses the established blue working color
- **AND** existing timing and controls continue to behave as before

#### Scenario: Active turn needs permission
- **WHEN** the selected agent has a pending permission and its existing active-turn indicator is visible
- **THEN** the static graphic uses the established amber needs-input color
- **AND** submitting or dismissing the permission retains its existing behavior

#### Scenario: Turn completes
- **WHEN** an active turn completes
- **THEN** the existing completed-turn footer behavior is preserved
- **AND** no new persistent status row or visible label is added

### Requirement: Presentation reacts to state and theme without a new clock
Static indicators SHALL update from existing status and theme changes without an animation loop, polling or an additional timer. They MUST preserve the accepted ring eligibility and existing elapsed-time suspension and resumption behavior.

#### Scenario: Status or theme changes
- **WHEN** an existing status input or the selected theme changes
- **THEN** the static indicator reflects that change through normal rendering
- **AND** it schedules no recurring graphic updates

#### Scenario: Hidden or backgrounded panels
- **WHEN** a retained panel becomes hidden or the app enters the background
- **THEN** the accepted ring and working-timer suspension behavior continues to hold
- **AND** returning refreshes existing elapsed time normally without replaying missed ticks

### Requirement: Native acceptance preserves resource use and interactions
Acceptance SHALL verify native legibility, status transitions, typing, scrolling, taps, gestures and background resumption, with repeated same-device CPU/frame comparisons against the ring-only fork. A resource regression MUST be investigated before activation. Battery savings MUST NOT be asserted without measurement.

#### Scenario: Static presentation is evaluated
- **WHEN** the candidate is compared against the ring-only fork on the same controlled workload with all Android animation scales zero
- **THEN** at least three samples per artifact record CPU and rendering behavior
- **AND** the evidence separates legibility from any demonstrated additional performance benefit

### Requirement: Delivery and update ownership remain visible
The follow-up SHALL record its source, upstream base, native evidence and retirement condition in Paseo maintenance. Android activation SHALL use an in-place update with the existing fork package and signer, preserving pairing, phone preferences and daemon sessions without restarting the daemon.

#### Scenario: Android update is delivered
- **WHEN** the accepted candidate is activated
- **THEN** the installed artifact and existing connectivity are verified separately from source merge
- **AND** user data and all-zero motion settings are preserved

#### Scenario: Upstream provides equivalent presentation
- **WHEN** an upstream update supplies deliberate static status graphics with equivalent behavior
- **THEN** the maintenance owner retires the corresponding local presentation delta while independently retaining any still-needed ring lifecycle fix
