# Review, memory and automation

## Seeing the delivered character

Put the reference and the assembled character beside each other at the same usable scale. State the camera, light and version in the image. Supply a full-size crop when the material or anatomy occupies a few pixels in a sheet. Include at least the view that motivated the change. Choose the other views and movement to reveal its likely cost. Compare before and after on the same renderer and card. A light sweep reveals painted or misplaced highlights. A short turn reveals depth that a contact sheet can hide.

Before involving the owner, look at the *whole* at ordinary size. Describe what your eye goes to first. Ask whether a person seeing the picture cold could tell what it is, who it is, and what expression it carries. Then inspect the overlay, measurements and technical checks. Record an internal preference as an agent judgment. A visually rejected result can still yield an excellent camera match or a reliable edit operation.

## The inexpensive handoff

Keep one short current-state entry per character. A new artist should find the following without reading the conversation:

- The owner's desired appearance, accepted references, which version they last saw, and exactly what they accepted or rejected. Preserve a dated decision when a newer one supersedes it.
- The source to open and where it came from, the tool/version and local command to produce a first render, and the approved light or camera settings the comparison depends on.
- One before/after beside the reference, the whole playable result if available, and one example of a failed approach whose repetition would waste time.
- What was observed, what the artist suspects, and the cheapest way to tell the remaining explanations apart.

Keep these entries brief. Link a subject-specific note for the detailed procedure, a working example, and primary sources for external claims. Preserve valuable text, marked-up images and parameters in durable private storage. Include the original location and version. Separate archival evidence from live dependencies of a build. Record a failed proposal in its own dated study so it cannot silently become the next baseline.

## When to make a tool

First do the real edit and its follow-up. Record elapsed time to first useful view, which operations repeated, time spent locating the right control, render wait and whether the next edit survived export. A good abstraction removes repetitive setup and keeps controls the artist actually needed.

For example, “compare this editable variant through these saved cameras” can load the source, export, render and assemble labels. Let the caller choose source, region, state, light, camera and crop; return the images and the exact settings. A shader-only change may reuse geometry. A change in shape may invalidate baked illumination and require a fresh build. Undo should work by reopening a saved source even when a headless application lacks interactive undo.

Start with a callable script and a recipe when those suffice. Consider exposing it through MCP when repeated calls reveal a stable operation. Keep an escape to the underlying editor or script. Record what the wrapper actually verifies, and measure the next artist's time to a usable result. Faster iteration that produces more rejected pictures is a reason to revisit the diagnosis.
