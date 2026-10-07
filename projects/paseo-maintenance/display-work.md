# Paseo display-work delivery record

This record belongs to [reduce-paseo-display-work](../../openspec/changes/reduce-paseo-display-work/design.md). It distinguishes source delivery, native acceptance and installed Android activation. Both patches remain candidates until their independent native checks pass.

## Source preflight

- Target: current beta fork `qq/openspec-planning-beta` at `188feb1ccbe0eac0cd8e1c630813005d6f9a519a`.
- Upstream base: `0.11.0-beta.5`, peeled commit `15d774d4a17c69bc0f8a62a85842764fab3c038d`.
- Fork: `qqp-dev/paseo`; upstream: `getpaseo/paseo`.
- Upstream main checked at `33eb36c0210f3d79dd29596e4065805107f35605`; ring, loader and turn-footer have no changes from beta.5 that replace these outcomes.
- Implementation uses an isolated source worktree and preserves the stable/beta primary checkouts and their pre-existing untracked index directories.
- The child read the source instructions and native/testing documents, installed its own pinned dependencies and verified that the runtime scope remains at most two patches.

## Patch records

| Patch | Source delivery | Native evidence | Retirement condition |
| --- | --- | --- | --- |
| Native status ring | Candidate [commit 46ae2e2bb](https://github.com/qqp-dev/paseo/commit/46ae2e2bbf5f5df388e09b569abab6705b674292), [PR #1](https://github.com/qqp-dev/paseo/pull/1) targeting `qq/openspec-planning-beta`; source acceptance pending native verification | Three real-browser lifecycle regressions pass; Android comparison pending. Browser scheduler evidence does not prove native resource improvement. | Upstream honors reduced motion, panel and foreground eligibility, detaches inactive consumers, stops the final-consumer clock and resumes in a shared phase without interaction regressions. |
| Background working indicators | Not started; follows isolated ring acceptance | Pending independent comparison against the accepted ring baseline | Upstream suspends loader and elapsed display work in the background and resumes from current time with panel/motion behavior intact. |

## Android delivery

The operator selected replacement of the existing Play Store app under the production package `sh.paseo`. At preflight the installed app reports `0.10.3` / `10003`, is non-debuggable, and uses a Play signing identity. The installed APK manifest explicitly disables Expo Updates and has no updates URL; no OTA bundle is active through that configured mechanism. This is separate from the independently observed `0.11.0-beta.5` daemon/CLI and the inspected source target.

The Play signer and the new durable private fork key have different certificates, so a normal in-place update is incompatible. The original five Play APK splits are preserved locally for rollback. The operator explicitly confirmed that no phone-local drafts or settings need keeping and authorized their reset during replacement. A fresh pairing link from the existing live daemon is saved locally for reconnection; its configuration and agents remain untouched. Native acceptance and the production installation remain pending. Keep private configuration, credential material, raw app data and the signing key outside this repository and agent/cloud inputs.

Source validation for the ring: three focused real-browser lifecycle tests exercise hidden consumers, reduced motion, final-consumer teardown and rapid synchronized resumption. The baseline fails the hidden-consumer assertion. Typecheck, targeted lint and formatting pass. The actual Android UI worklet runtime and interactions still require native verification.

Android builds use the pinned beta source, release Hermes optimizations, profiling support and one `arm64-v8a` ABI. Baseline and candidate share the same native build configuration and fork signer. Native comparisons use the supported `sh.paseo.debug` development package compiled as a profileable release, preserving the Play app until verification completes. This temporary comparison variant has the supported optional Firebase configuration absent; the delivered production `sh.paseo` variant preserves the existing installed app's Firebase client configuration locally. Normal QR/audio/notification modules remain present, without a source patch or published configuration values. Production notification behavior requires its own activation check.

Native acceptance must record repeated controlled callback/wakeup/CPU evidence and interactions/resumption. Battery improvement is unmeasured unless an actual consumption comparison is added. Source merge alone is not completed Android delivery.

## Native comparison checkpoint (2026-10-07)

Physical Pixel 10, Android 17/API 37; all three Android animation scales remain zero. The isolated synthetic daemon supplies one idle 60-turn timeline and two streaming sessions in the same workspace. Both comparison APKs use the same release/profileable Hermes configuration, production source baseline above, temporary package, fork signer and all 32 identical native libraries. Only the JavaScript ring patch differs. Each artifact was installed and launched as a fresh app process before its measurements. Both visible-panel series held the test app in the foreground throughout, with Android thermal status 1 and battery temperature approximately 40.0–40.2 °C.

| Visible running workspace ring, three repeats | Baseline `188feb1cc` | Ring `46ae2e2bb` |
| --- | --- | --- |
| Duration per sample | 10.154 / 10.163 / 10.193 s | 10.194 / 10.160 / 10.164 s |
| App frames reported by `dumpsys gfxinfo` | 1266 / 1287 / 1275 | 1 / 3 / 1 |
| Process CPU ticks per second | 89.7 / 90.9 / 92.6 | 9.6 / 12.7 / 12.3 |
| Main-thread CPU ticks per sample | 343 / 349 / 344 | 94 / 105 / 120 |

This provides native evidence of substantially less recurring rendering and CPU work for the ring under the operator's motion policy. It is not a comparison against Play 0.10.3 and does not establish faster actions or battery consumption. Motion-enabled native resumption is not measured because changing the selected animation settings is outside this task; focused lifecycle tests supply synchronization coverage.

Three synthetic native message sends reached the fixture, began running 304–416 ms after injected input and completed 10.302–10.426 s after input. Local composer pixel observation bounded first visual feedback at 887–1557 ms, including capture/input overhead. Completion comes from separate daemon status events. No equivalent baseline action timing was collected, so these values do not support a latency improvement claim.

Native acceptance remains pending. Rewind, question dismissal/submission, retained-panel transitions and final production activation still need completion. The baseline's recurring accessibility updates prevented fresh idle UI snapshots; measurements whose panel state could not be freshly verified are excluded from acceptance. The phone subsequently moved to another app, and device input was stopped pending a new uninterrupted test window. Task helpers now require a fresh accessibility snapshot and check the focused test package before input; unrelated screen content is not a verification artifact. Play Paseo remains installed and the main daemon remains untouched.
