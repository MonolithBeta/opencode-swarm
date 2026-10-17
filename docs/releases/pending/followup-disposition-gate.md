# Follow-up issues: a necessity gate and one collated issue per PR

PR-feedback rounds no longer turn every unfixed review finding into its own GitHub issue.

## Changes

- **`contributing.md`: new "Filing follow-up issues" section.** It applies to agents and contributors alike.
  - **One disposition per unfixed item:** `FIX-NOW`, `ABSORB`, `FILE`, `RECORD` or `ASK`.
    - `ABSORB` means commenting on an existing issue.
    - `RECORD` means a "Considered, not filed" row in the PR body. It closes the item without opening an issue.
  - **A four-part necessity gate before filing:** verified, consequential, material, and untracked/not fixable here.
  - **One collated `Follow-up from PR #N: <theme>` issue per PR.** More than two follow-up issues from one PR needs the maintainer's go-ahead.
  - **Priority versus Improvement tiers.** Improvement items are proposed for approval, not filed automatically.
  - **The filing checklist gains a follow-up line.**
- **swarm-pr-feedback skill:**
  - The closure ledger now records a follow-up disposition for every unfixed item.
  - The "never defer" rule now routes every unfixed item through the new `references/followup-dispositions.md`, which holds the gate, the collation budget, the tiers and the PR-body table.
  - `SKILL.md` stays at its progressive-disclosure line budget, and its `swarm-contract-digest` stamp is refreshed.

## Why

Before this change, every unfixed finding became its own issue: about 100 follow-up issues in 45 days, none ever closed as not needed. Two things drove that:
- no rule said what deserves an issue or how to group them;
- the "never defer" rule left filing as the only allowed outcome.

Published guidance and the major AI review tools point the other way:
- they report residual findings on the PR rather than filing one issue per finding;
- only roughly a third of AI review comments lead to a code change.
