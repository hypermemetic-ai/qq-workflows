# mobile-panel-interaction Specification

## Purpose

Keep retained compact mobile panels consistent with visible content and the user's latest interaction, including when incoming agent activity delays application processing.

## Requirements

### Requirement: Visible panels own input

The compact native client SHALL direct panel-control taps to the visibly presented panel and SHALL prevent covered center controls from receiving those taps.

#### Scenario: Close during streaming

- **WHEN** the workspace list has visibly opened during concurrent streaming and the user first taps its Close control
- **THEN** that interaction closes to chat without opening the covered Explorer control or requiring a second tap

#### Scenario: Select a different workspace

- **WHEN** the user first taps a different workspace row in the visibly open list during streaming
- **THEN** the selected workspace opens and the list closes without activating covered chat content

### Requirement: Later intent supersedes pending motion

The client SHALL preserve the user's latest close, navigation or panel command when an earlier gesture's semantic processing is delayed. A stale gesture or settlement publication SHALL NOT reopen or replace the newer destination.

#### Scenario: Close overtakes delayed opening

- **WHEN** the list is visibly open before its opening gesture has finished semantic processing and the user closes it
- **THEN** the final destination remains chat after all pending opening callbacks complete

#### Scenario: Navigation overtakes delayed opening

- **WHEN** a workspace selection supersedes an opening gesture with delayed processing
- **THEN** the selected workspace remains active and stale opening callbacks do not reopen the list

#### Scenario: Cancellation and rapid commands

- **WHEN** a panel gesture is canceled or superseded by rapid panel commands
- **THEN** motion resolves to the latest valid destination without activating another retained panel's controls

### Requirement: Retained interaction behavior is preserved

The client SHALL preserve panel scrolling, horizontal gesture arbitration, keyboard interaction, accessibility, selected motion preferences and retained offsets while correcting input ownership.

#### Scenario: Return to a scrolled list

- **WHEN** the user scrolls the workspace list, closes it and reopens it
- **THEN** the retained offset and usable scrolling are preserved

#### Scenario: Keyboard and background transitions

- **WHEN** the user opens or closes panels with the keyboard present or backgrounds and resumes the client
- **THEN** controls and gestures remain usable and the visible destination, accessibility state and selected motion preferences remain consistent

### Requirement: Presentation optimizations preserve live state

Any covered-chat presentation suspension SHALL preserve incoming state, running sessions, drafts and conversation ordering, and SHALL restore current content and elapsed status when chat becomes visible.

#### Scenario: Stream while chat is covered

- **WHEN** an evaluated optimization pauses covered-chat presentation while new content arrives
- **THEN** returning to chat shows the latest ordered content and current elapsed status with the existing draft intact
