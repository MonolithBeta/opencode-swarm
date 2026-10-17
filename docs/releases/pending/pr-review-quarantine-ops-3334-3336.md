---
issue: 3334, 3335, 3336
---

Closes #3334, #3335, #3336 (follow-ups from the swarm-pr-review of PR #3329).

- pr-review: quarantined verdict-row identifiers are now bounded at the source
  to a sentinel-safe identifier form (`(missing)` / `(invalid-id)` /
  `(redacted)`) before they reach composition diagnostics, the
  `verdict_row_pipe_recovery` telemetry payload, or operator-facing BLOCKED
  messages — model-authored row prose and control characters (including
  newline escapes decoded by the parser) can no longer be injected through the
  item-id field (#3334).
- pr-review: composition diagnostics now flush quarantined-row noise AFTER the
  lane-voiding evidence (unassigned-row and abandoned-lane diagnostics), so a
  stray-row-heavy scan can never crowd the "contains an unassigned verdict
  row" diagnostic out of the capped budget (#3334).
- pr-review: the reviewer/critic operator-prompt verdict-template guard now
  derives its row detection from the verdict-row parser itself and widens its
  mid-line anti-teaching shape to Unicode whitespace, closing the marker forms
  the parser accepts but the guard previously missed (`[REVIEWED]` followed by
  a fullwidth space, NBSP, BOM, narrow NBSP, or a lone CR before the pipe).
  This also closes the fullwidth-space residue item of #3362 (#3335).
- In-flight replay across the upgrade (no action required, disclosed for
  operators): reviewer artifacts written before v7.197.x that contain a
  `CONFIRMED` row with severity `NONE` now fail the live read schema — the
  item stays unclaimed and the phase re-runs (fail-closed; no forged or
  silently-dropped claim is possible). Critic artifacts written before the
  widening holding `UPHELD` at `LOW`/`INFO` (previously rejected at read) now
  become claimable without a re-run, provided their bound reviewer row still
  validates. No migration runs in either direction (#3336).
