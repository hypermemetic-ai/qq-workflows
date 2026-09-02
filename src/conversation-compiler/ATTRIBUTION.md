# Source attribution

The deterministic normalization, ranked-brief, extraction, merge, and budget behavior in this directory was adapted from
`@sting8k/pi-vcc` 0.7.0 at commit `f7b80bbbe22315acf9f7925c0c3be2d4ae9feee5` after an engineering audit.

This is attribution only. The local implementation is the neutral **child conversation compiler** and deliberately uses DSH event
sequences, DSH compaction transactions, and the existing `session_history` interaction rather than the upstream transcript store,
provider identity, or retrieval command.
