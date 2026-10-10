# Spec Delta

## Purpose

Provide reusable isolated Android evidence that responsiveness changes preserve interaction correctness and improve the measured workload without exposing private operator data.

## ADDED Requirements

### Requirement: Reusable native stress workload

Maintenance QA SHALL provide an isolated synthetic workload and repeatable native controls for idle and concurrent streaming, workspace selection, scrolling, submission, long histories and provider-child activity.

#### Scenario: Repeat a future client change

- **WHEN** a compatible client tweak is evaluated
- **THEN** the recorded fixture and control commands can be reused with the accepted baseline and candidate without taking over the operator's phone or connecting synthetic tests to production

### Requirement: Interaction and resource evidence are distinct

Acceptance SHALL record first-tap outcomes and interaction latency separately from CPU, rendering and transport measurements. Baseline and candidate provenance, workload, observer overhead and platform limitations SHALL be explicit.

#### Scenario: CPU improves without faster controls

- **WHEN** an optimization reduces CPU while interaction latency stays unchanged
- **THEN** the result claims the measured resource improvement and preserves the unresolved responsiveness finding

#### Scenario: Setup is storage-confounded

- **WHEN** emulator startup or host pressure stalls Android system apps as well as the client
- **THEN** those setup failures are excluded from app acceptance and a stable warm workload is established before comparison

### Requirement: Runtime changes require attributable evidence

Each added runtime delta SHALL have its own acceptance evidence and upstream retirement condition. Covered-chat suspension SHALL be retained only after repeated native benefit and correct resume controls; evaluation SHALL record either retention or rejection.

#### Scenario: Optional patch gives no repeatable gain

- **WHEN** covered-chat suspension produces no useful repeatable native improvement or fails restoration controls
- **THEN** it is rejected and the measured outcome is recorded without retaining that runtime delta

### Requirement: Remaining freezes are investigated across the path

The investigation SHALL distinguish local input handling, client queued work, transport and daemon delays using aggregate measurements. It SHALL record attributable findings and unresolved gaps without claiming that one reproduced defect explains every reported freeze.

#### Scenario: Server delay and local input differ

- **WHEN** a daemon pause or outgoing queue coincides with slow server-dependent actions
- **THEN** it is reported separately from local control delivery unless a trace establishes the connecting cause

### Requirement: Private and temporary state has explicit ownership

QA SHALL keep production credentials and conversation content out of test fixtures and public artifacts. Task-owned services and resources SHALL be stopped after verification while retained toolchain and accepted artifacts remain reusable.

#### Scenario: Finish native verification

- **WHEN** a verification window ends
- **THEN** the owned emulator and fixture stop, temporary forwarding and helpers are removed, and evidence and reusable caches are retained

### Requirement: Android delivery is independently verified

Client delivery SHALL record source integration, release acceptance and production Android activation separately. An in-place update SHALL retain the established signer, package, pairing and visible phone preferences.

#### Scenario: Source is merged but phone is disconnected

- **WHEN** the accepted release is ready but the phone cannot be reached
- **THEN** activation remains pending rather than being reported complete from source or APK provenance alone

