# Tasks

## 1. Source and native comparison setup

- [x] 1.1 In a child agent, read the selected Paseo checkout's instructions and relevant native/testing docs; run the Git-status helper and verify fork/upstream remotes, the stable or beta target, exact upstream commit and other dirty worktrees/PRs in a recorded preflight.
- [x] 1.2 Create an isolated source checkout at the pinned target and check upstream for both planned outcomes; record which local changes remain necessary and verify that the scope contains at most the two planned runtime patches.
- [ ] 1.3 Identify installed app, any applicable OTA bundle, daemon and CLI separately; prepare the explicitly selected Android replacement under the production package, verify signing compatibility or record the signing transition and durable fork key, and establish recoverable pairings/settings before removal. Verify that running agents and all-zero Android animation settings remain intact; leave native acceptance pending until this path is usable.
- [ ] 1.4 Prepare synthetic sessions and a repeatable native comparison covering long timelines, running/idle and streaming states, hidden panels, app background/foreground, actions and native interactions; record workload, build configuration, restart/thermal controls and at least three repetitions per condition, and verify that baseline artifacts distinguish first feedback from operation completion.

## 2. Native status-ring lifecycle

- [x] 2.1 Implement eligibility from reduced motion, retained-panel activity and app visibility using local per-consumer shared values and the existing subscription pattern; verify that static running status remains recognizable and inactive rings receive no updates while another ring is active.
- [x] 2.2 Make registration/cleanup idempotent, stop the shared loop after the final eligible consumer leaves and resume at the current wall-clock phase; verify one loop for multiple consumers and exercise rapid eligibility changes without duplicate loops or replayed frames.
- [x] 2.3 Add the focused lifecycle regression checks warranted by the clock change and run the checkout's required lint, typecheck and format commands; verify multiple-consumer teardown and resumption while avoiding the prohibited full local suite.
- [ ] 2.4 Compare equivalent native baseline and ring builds using the setup above; verify eliminated inactive callbacks or lower wakeups/CPU, preserved status/interaction/gesture/keyboard behavior and correct resumption, and record action latency separately without claiming unmeasured battery savings.
- [ ] 2.5 Deliver the ring as one separately reviewable source commit through the required fork PR/merge path; link its exact upstream base, source commit, sanitized native evidence, acceptance decision and retirement condition from the maintenance entry point, verifying that the installed artifact is identified separately from source delivery. If native acceptance is pending or the patch is rejected, record that explicitly rather than calling it retained.

## 3. Background working indicators

- [ ] 3.1 After the ring's isolated comparison and acceptance decision, add app visibility to the existing loader eligibility and working elapsed-time activity flag; verify the reuse of existing hooks/timer behavior without new lifecycle infrastructure or cancellation of agent work.
- [ ] 3.2 Run focused loader/timer lifecycle checks and required lint, typecheck and format commands; verify background suspension, final-consumer clock shutdown, foreground wall-clock refresh, no tick backlog and existing panel/reduced-motion behavior.
- [ ] 3.3 Compare native builds with and without this patch against the accepted ring baseline using the same repeated workload; verify independently reduced callback activity, wakeups or CPU and preserved interactions/resumption, recording latency and any actually measured battery consumption separately.
- [ ] 3.4 Deliver any accepted working-indicator patch as its own source commit through the required fork PR/merge path; update the maintenance link with its exact upstream base, source commit, sanitized independent native evidence and retirement condition, verifying that its record can be reviewed or retired independently from the ring. Record rejection or pending native acceptance explicitly.

## 4. Integration and delivery

- [ ] 4.1 Review the combined accepted candidate through actions, streaming, long timelines, hidden panels, background/foreground, typing, scrolling, native gestures and keyboard use; verify selected settings, retained view identity, status meaning and agent continuity and confirm no third runtime optimization was added.
- [ ] 4.2 Replace the existing Play Store Android client with the verified production-package fork client using the reviewed signing and recovery procedure; verify installed version/bundle/certificate, restored pairing/connectivity, selected settings and observed behavior without restarting the main daemon. If any local data is unrecoverable, obtain an explicit loss decision on the concrete candidate before removal; source delivery alone does not complete this task.
- [ ] 4.3 Validate the final OpenSpec artifacts and maintenance/provenance links, deliver scoped maintenance commits through the required PR/merge path, stop temporary task-owned processes and run the Git-status helper in every worked checkout; verify no unattended task Git work or temporary processes remain. When archiving, update the maintenance entry point to the durable spec, archive or owning patch records.
