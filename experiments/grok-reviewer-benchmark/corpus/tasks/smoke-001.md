# Sessions chooser all-project overview

- Tapping/clicking genuinely empty space in the Sessions chooser clears the project filter and enters an all-project overview.
- Overview shows every project’s sessions on the right, in project order.
- Use one very thin, restrained orthogonal (90-degree) connector per project to visually link the relevant project row on the left with the boundary/label of that project’s session group on the right.
- The connector system should organize space rather than decorate it: no cards, gradients, counts, backgrounds, or excessive labels; use a single quiet line per group, deliberate vertical centering, balanced spacing, and the original monochrome visual language.
- Filtered mode remains the simple one-project session list. Selecting a project restores filtered mode; selecting a session retains existing behavior.
- Empty-space clearing must not steal taps from projects, sessions, create controls, menus, or other interactive elements.
- Geometry must stay correct across mobile/desktop sizing, scrolling, SSE swaps, and project/session count changes; decorative connectors must be hidden from assistive technology and degrade cleanly without JS.
- Add focused interaction/render/style coverage and run the full suite before a separate merge-commit PR.

## Scope
Only qq-ui Sessions view render/browser/CSS/proof files. Keep sts2 and unrelated qq-workflows work out of scope.
