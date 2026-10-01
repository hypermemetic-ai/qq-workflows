# Agent instruction and delivery audit — 2026-10-01

The audit found concrete instructions and task-scoping failures that encourage agents to preserve obsolete state and stop before the requested result is usable. Git delivery alone does not resolve them. The strongest demonstrated case is ISO: its published build changed while the studio the operator actually used remained on an older checkout.

## Scope and evidence

- Read all 17 project/deployment `AGENTS.md` files across 16 project roots and the separate ISO deployment checkout. A scoped recursive search found no additional nested guides or `AGENTS.override.md` files in those roots.
- Inspected the actual injected instruction chains and native base prompts of the four active Codex primaries: Workflows, ISO, Music/Everything Box and Voice. All four had the same 21,769-byte native base prompt, SHA-256 prefix `e1bdd4f8f0df4b20`.
- Reviewed the referenced migration/readiness guidance, ISO's private handoff and subsequent task/final messages, its change proposal/design/tasks and implementation/release report, and the legacy worker instructions. Private conversations are summarized here; raw history and private payloads are not included.
- Identified the process serving port 5175 through its process metadata and compared its checkout with ISO's updated primary checkout. This was observation of existing state.

The native base prompt already requires completing the intended usable outcome, carrying existing authorization forward, preserving the original objective across later messages, avoiding unnecessary approval requests, and avoiding omitted-action framing. The observed behavior conflicts with those directions. This audit establishes instruction conflicts and execution failures; it does not establish a cause in model training.

## Findings

### 1. ISO's permanent guide explicitly freezes the operator's live studio

**Demonstrated delivery defect.** `iso-notation/AGENTS.md:56` requires preserving live5175 “without restarting or switching it.” The guide also names that endpoint as the live studio at line 51. This is stronger and more specific than the shared instruction to complete ordinary activation.

At the audit snapshot, port 5175 was served by Vite from `iso-notation-deploy`, whose HEAD was `36ede842` (PR140). The primary checkout was at `3e1e77d` (PR143). The deployed checkout's shared Schumann importer and candidate registry differed from the updated primary versions, with no local modifications reported for those deployed files. Publication to GitHub Pages therefore did not update the source files used by this live process.

ISO's actual injected instructions contained both the new shared delivery rule and this local freeze before the publication completion report. The global rule was loaded; adding it did not remove the contradiction. The subsequent operator feedback identified port 5175 as the surface they were using.

**Correction:** Replace the standing freeze with a rule to preserve unrelated work and saved state while updating the intended runtime for an authorized delivery. Establish the actual user-facing endpoint from the task and existing context. Verify the requested behavior there before declaring delivery complete. An existing process is not automatically an unrelated task.

### 2. The agent completed a child change while the broader outcome remained absent

**Demonstrated scope and completion failure.** The continuation began with simultaneous-voice geometry and an omitted-source-slur prerequisite. The source-slur proposal explicitly excluded resuming the joint-geometry planner, changing the live deployment, and Git delivery. Its design repeated those exclusions. The completed 18-task implementation therefore established completion of that bounded change, not the whole musical comparison/refinement outcome.

The implementation report at `iso-notation/docs/reports/restore-source-slurs-and-citations.md:112`–114 provided review cues for updated cards while explicitly stating that those cards were not served at live5175. Later release reporting established publication elsewhere while retaining the cancelled study and leaving live5175 unchanged. The operator subsequently identified the missing geometry and unusable source comparison as material failures.

Preserving stopped work can be correct. Treating preservation of the work the operator wants to evaluate as evidence that the requested outcome is complete is not.

**Correction:** Keep the parent outcome visible when a prerequisite gets its own change. Identify a finished prerequisite as a finished prerequisite. Reconcile the remaining geometry/comparison requirements with later operator input and continue the authorized work; do not silently substitute the child change's exclusions for the parent goal. Retain the stopped branch's files without blindly promoting unverified work.

### 3. Temporary migration restrictions are embedded in ordinary project entry guidance

**Widespread ambiguity.** Ten project guides end with the same readiness-only prohibition on deployment, shared runtime changes and a second primary conversation. Thirteen readiness maps describe migration changes as intentionally uncommitted. Those statements describe the migration assignment, but agents are directed to read them again during ordinary development.

More problematic standing wording appears in:

- `iso-notation/AGENTS.md:46`: leave edits uncommitted until reviewed Git-delivery authority.
- `voice-vault/AGENTS.md:17`: existing clients/worktrees remain, followed by “do not change runtime or reconcile them by reset.” The reset prohibition is concrete; the runtime prohibition is broad.
- `everything-box/AGENTS.md:11`: no commit/push/deployment without applicable task authority, without describing how an ordinary operator request supplies it.
- `deciq/AGENTS.md:20`: no automatic deploy or global runtime change alongside preservation of local work.

The narrow statements about what documentation/readiness work authorizes are not intrinsically wrong. Their repeated placement and adjacent broad prohibitions make it easy to carry a temporary restriction into a later repair or delivery task.

**Correction:** Keep migration disposition as dated history. Keep evergreen entry guidance focused on the actual product and ordinary task execution. Scope documentation-only limits explicitly and describe the normal completion path for an authorized repair, including relevant installation/runtime follow-through. Preserve unrelated changes through scoped reconciliation instead of freezing the whole checkout or runtime.

### 4. The verification/reporting contract is stronger on labels than on the user's working path

**Observed completion gap.** ISO requires a visual-impact label and distinctions among unlanded, merged, served and operator-accepted output (`AGENTS.md:47`). Those distinctions are useful facts, but the completion report led with merge/publication and test/hash evidence while the actual live surface remained old. The operator then encountered a Source control that did not work and a comparison that did not contain the expected work.

The guide also prohibits screenshots along with toy renderers and generated review images (`AGENTS.md:27`). The deployment checkout repeats a restriction on headless review images at `AGENTS.md:62`. These restrictions reduce available visual evidence. They do not relieve the agent of checking the real studio's navigation, source comparison and requested rendering behavior.

**Correction:** Make the completion check follow the user's actual path through the product. For this case, open the intended studio, exercise Source and comparison controls, and verify the relevant passage and voice geometry. Treat lint, SVG presence and release hashes as supporting evidence. Review the blanket image restriction separately from the valid requirement to use the actual renderer rather than a fabricated substitute. Report a concrete unmet requirement as unfinished work, not as an achievement in preservation or restraint.

### 5. Legacy worker rules exist, but they are not the native primary's authority

`qq-workflows/workflow/pi-worker/instructions.mjs:34`, 41 and 56 explicitly prohibit workers from committing, pushing or landing. The old deployment guide also contains managed-role and uncommitted-handoff requirements. The native migration guidance expressly says those roles are historical rather than native authority.

**Correction:** Prevent legacy role rules from being imported into native-primary task decisions. Historical checkpoints should distinguish the assigned worker's limits from the primary's responsibility to finish delivery. Editing inactive worker prompts would not repair ISO's demonstrated live-studio freeze.

### 6. Concrete product constraints must be separated from generic stopping rules

The audit found constraints with actual product reasons: source fidelity and independent musical voices; preservation of user work and saved state; physical disk identity and unsaved musical state; client privacy and human-controlled production release; mail-storage/provider-mutation milestones; signing identity; credentials and isolated account data.

For example, `deciq-logic/AGENTS.md:30`–37 has a client-owned PR/release contract, corroborated by `docs/client-authoring-policy.md`. The Music guide's physical-disk identification requirement is materially different from a vague need for renewed Git permission. These should not be erased by a universal instruction to act more aggressively.

**Correction:** Name the concrete protected effect and its actual prerequisite. Carry authorization forward for the rest of the requested work. Avoid generic “no runtime change” or “no deployment” wording where the intended repair requires that very effect.

## OpenSpec assessment

OpenSpec's planning boundaries are appropriate when the requested task is planning. They were inspected as part of the instruction chain, not diagnosed as the cause of ISO's stale live studio. The installed skills and stock schema remain the selected workflow. The correction is to honor the actual requested outcome across stages and remove contradictory project restrictions; it does not require weakening or rewriting OpenSpec skills.

## Recommended correction order

1. Correct ISO's permanent live5175 freeze and its delivery/verification contract, while the ISO primary owns the current product repair.
2. Restore continuity between the original musical outcome and its source-slur prerequisite; determine completion from the actual working comparison.
3. Replace broad runtime and Git prohibitions in evergreen project guides with specific product constraints and ordinary authorized delivery paths. Move migration-only disposition out of routine instructions.
4. Remove preservation/omitted-action boilerplate from completion requirements. Keep only information needed to assess the delivered result or a concrete blocker.

These are targeted instruction and acceptance corrections. Another generic autonomy paragraph, a new orchestrator or a change of model would not resolve the demonstrated local contradictions by itself.

## Inventory

Guides reviewed: antigravity-server, deciq, deciq-logic, everything-box, image-finder, inbox, inference-box, iso-notation, iso-notation-deploy, media-box, money, qq-dictation, qq-relay, qq-workflows, sts2-companion, voice-vault and ytgrab.

The findings describe the instruction/runtime snapshot inspected during this audit. Independent product work may subsequently change those files or the live service.
