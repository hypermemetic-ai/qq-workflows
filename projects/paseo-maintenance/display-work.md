# Paseo display-work delivery record

This record belongs to [reduce-paseo-display-work](../../openspec/changes/reduce-paseo-display-work/design.md). It distinguishes source delivery, native acceptance and installed Android activation. The ring is accepted and merged; the optional working-indicator source patch is rejected because the existing native behavior passes the selected-policy checks. The production Android client has replaced Play Paseo and reconnects to the existing daemon.

## Source preflight

- Comparison baseline: beta fork `qq/openspec-planning-beta` at `188feb1ccbe0eac0cd8e1c630813005d6f9a519a`.
- Upstream base: `0.11.0-beta.5`, peeled commit `15d774d4a17c69bc0f8a62a85842764fab3c038d`.
- Fork: `qqp-dev/paseo`; upstream: `getpaseo/paseo`.
- Upstream main checked at `33eb36c0210f3d79dd29596e4065805107f35605`; ring, loader and turn-footer have no changes from beta.5 that replace these outcomes.
- Implementation uses an isolated source worktree and preserves the stable/beta primary checkouts and their pre-existing untracked index directories.
- The child read the source instructions and native/testing documents, installed its own pinned dependencies and verified that the runtime scope remains at most two patches.

## Patch records

| Patch | Source delivery | Native evidence | Retirement condition |
| --- | --- | --- | --- |
| Native status ring | Accepted [commit 46ae2e2bb](https://github.com/qqp-dev/paseo/commit/46ae2e2bbf5f5df388e09b569abab6705b674292), [PR #1](https://github.com/qqp-dev/paseo/pull/1) targeting `qq/openspec-planning-beta`; merged at `1ff50151c19ca8d870ded2727e8ed3c92133d041` | Three real-browser lifecycle regressions and controlled Android resource/interaction checks pass; measurements below. | Upstream honors reduced motion, panel and foreground eligibility, detaches inactive consumers, stops the final-consumer clock and resumes in a shared phase without interaction regressions. |
| Background working indicators | Rejected additional source patch; existing native implementation retained | Existing native timer suspension, reduced-motion loader gating, zero background frames and current-time resumption verified below; no added patch to compare | Upstream suspends loader and elapsed display work in the background and resumes from current time with panel/motion behavior intact. |

## Android delivery

The operator selected replacement of the existing Play Store app under the production package `sh.paseo`. At preflight the installed app reports `0.10.3` / `10003`, is non-debuggable, and uses a Play signing identity. The installed APK manifest explicitly disables Expo Updates and has no updates URL; no OTA bundle is active through that configured mechanism. This is separate from the independently observed `0.11.0-beta.5` daemon/CLI and the inspected source target.

The Play signer and the new durable private fork key have different certificates, so a normal in-place update is incompatible. The original five Play APK splits are preserved locally for rollback. The operator authorized the signing transition and confirmed that no phone-local drafts need keeping, then requested copying visible phone preferences. Sixteen preferences were captured locally before removal and verified after installation: theme, interface/content/code sizes, code font, syntax theme, language, default send, reasoning/tool display, terminal scrollback, legacy terminal renderer and four sidebar visibility choices. Sidebar order was preserved. Two preferences required restoration; the other fourteen already matched. Pairing was restored from the existing daemon's saved offer and its expected identity was checked before connecting. Keep private configuration, credential material, raw app data and the signing key outside this repository and agent/cloud inputs.

Source validation for the ring: three focused real-browser lifecycle tests exercise hidden consumers, reduced motion, final-consumer teardown and rapid synchronized resumption. The baseline fails the hidden-consumer assertion. Typecheck, targeted lint and formatting pass. Native resource measurements, interactions and background resumption also passed as recorded below.

Android builds use the pinned beta source, release Hermes optimizations, profiling support and one `arm64-v8a` ABI. Baseline and candidate share the same native build configuration and fork signer. Native comparisons use the supported `sh.paseo.debug` development package compiled as a profileable release, preserving the Play app until verification completes. This temporary comparison variant has the supported optional Firebase configuration absent; the delivered production `sh.paseo` variant preserves the existing installed app's Firebase client configuration locally. Normal QR/audio/notification modules remain present, without a source patch or published configuration values. The prior notification, microphone and local-network grants were restored; camera remains ungranted. End-to-end remote push delivery was not tested.

Native acceptance is recorded below. Battery consumption was not measured. Source delivery and installed activation are verified separately.

### Installed production artifact

- Source: ring commit `46ae2e2bbf5f5df388e09b569abab6705b674292`, merged as `1ff50151c19ca8d870ded2727e8ed3c92133d041`. The merge tree matches the audited build source exactly.
- Installed package: `sh.paseo`; Android manifest version `0.11.0` / `11000`, app bundle version `0.11.0-beta.5`; release/profileable Hermes, arm64. Expo Updates is disabled in the APK manifest; this build uses its embedded bundle.
- Pulled installed APK SHA-256: `ac57ff678bfdf48e836ab4d40ec048b504095999d55a3f8765174ee36d188221`.
- Embedded Hermes bundle SHA-256: `43c7ab78bbde9b90a13cf8756d08352e539a0c03a89800701b82b82dec7e6d1c`.
- Durable fork certificate SHA-256: `486587a12a3881dbc25a8fc63fdb8f740cfd8695a0f567a39fd0f51267fab734`. Subsequent fork builds use this key for in-place updates; returning to the Play signer needs another recovery transition.

The expected existing daemon was confirmed on the phone. Its Projects screen populated all 15 project rows. A separate read-only relay verification found all 13 original agent IDs with unchanged working paths, 12 workspaces and the original running agent still running. The existing running session opened on the phone and remained selected after a client-only cold restart; no message was sent to a real agent. Projects/sessions and daemon settings, including voice configuration, stayed on that daemon. Its original supervisor/worker PIDs remained alive; no daemon restart occurred. All three Android animation scales remain zero.

Private preference captures, pairing material, signing key, signed artifacts and the original Play splits remain on the operator's machine outside this repository. The temporary comparison app, synthetic daemon, ADB reverse and device observers were removed after delivery. No temporary task process remains.

## Native comparison checkpoint (2026-10-07)

Physical Pixel 10, Android 17/API 37; all three Android animation scales remain zero. The isolated synthetic daemon supplies one idle 60-turn timeline and two streaming sessions in the same workspace. Both comparison APKs use the same release/profileable Hermes configuration, production source baseline above, temporary package, fork signer and all 32 identical native libraries. Only the JavaScript ring patch differs. Each artifact was installed and launched as a fresh app process before its measurements. Both visible-panel series held the test app in the foreground throughout, with Android thermal status 1 and battery temperature approximately 40.0–40.2 °C.

| Visible running workspace ring, three repeats | Baseline `188feb1cc` | Ring `46ae2e2bb` |
| --- | --- | --- |
| Duration per sample | 10.154 / 10.163 / 10.193 s | 10.194 / 10.160 / 10.164 s |
| App frames reported by `dumpsys gfxinfo` | 1266 / 1287 / 1275 | 1 / 3 / 1 |
| Process CPU ticks per second | 89.7 / 90.9 / 92.6 | 9.6 / 12.7 / 12.3 |
| Main-thread CPU ticks per sample | 343 / 349 / 344 | 94 / 105 / 120 |

This provides native evidence of substantially less recurring rendering and CPU work for the ring under the operator's motion policy. It is not a comparison against Play 0.10.3 and does not establish faster actions or battery consumption. Motion-enabled native resumption is not measured because changing the selected animation settings is outside this task; focused lifecycle tests supply synchronization coverage.

Three synthetic native message sends reached each build's fixture and completed. Ring first visual feedback upper bounds were 1451 / 1557 / 887 ms, running events arrived 416 / 328 / 304 ms after input, and completion arrived 10426 / 10335 / 10302 ms after input. Baseline first-feedback upper bounds were 1002 / 1090 / 986 ms, running arrived 313 / 305 / 319 ms after input and completion arrived 10315 / 10311 / 10319 ms after input. Local cropped-pixel observation includes capture/input overhead; completion comes from separate synthetic daemon events. Action runs were collected in separate windows, so these values verify the distinction and successful operations without supporting an action-latency improvement claim.

Native candidate controls passed: message sends, rewind restoring the previous synthetic message in the composer, question Dismiss, choices/freeform answer and Submit, switching sessions and back, scrolling in both directions, keyboard input/hiding and native edge-back/resume. Synthetic sessions isolate these checks from real conversations. Focused lifecycle tests cover retained views and synchronized motion-enabled resumption; the operator's native motion policy remains unchanged. Baseline measurements whose panel state was not freshly verified, one interrupted background sample and two unsuccessful injected baseline-send attempts are excluded.

## Optional working-indicator decision

Reject adding the second source patch. On the accepted ring build, three background samples during a selected running turn rendered zero app frames for 10.120 / 10.165 / 10.140 s, with every foreground check false. A final 10.343 s recheck also rendered zero frames. Synthetic daemon agents continued running. After returning to the same selected turn and allowing two seconds for its normal update, elapsed time advanced from 25m 55s to 26m 21s over approximately 26 seconds; it did not count through the missing ticks.

React Native 0.81.5's `JavaTimerManager` already removes ordinary timer frame callbacks on host pause when there is no headless task, restores one on resume and schedules repeats from the current frame. Paseo has no registered headless task, its elapsed display calculates from `Date.now()`, and its loader already disables animation under the selected reduced-motion policy. The first immediate resume observation can still show the old value until the normal foreground update. Existing behavior satisfies the approved requirement; there is no demonstrated gap for another maintained patch. Total background process CPU is not attributed to these components. Reevaluate if the runtime, headless-task use or motion policy changes, or if measured recurring background display work appears.
