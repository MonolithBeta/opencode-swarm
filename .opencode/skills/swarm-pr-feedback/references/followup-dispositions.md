# Follow-up dispositions for unfixed items

This file is the routing rule for every closure-ledger item the PR does not fix. It applies at closeout, after Stage B and before the reviewer and critic closeout gate. It is the swarm-pr-feedback form of `contributing.md` "Filing follow-up issues".

Nothing is silently dropped. Each unfixed `FB-###` item gets exactly one disposition in the closure ledger.

| Disposition | Use when | What you write |
|---|---|---|
| `FIX-NOW` | The PR introduced the problem (mandatory), or it is small and inside this PR's files and scope | The fix, under the normal Stage A/B gates |
| `ABSORB` | An open issue already covers it | A comment on that issue with the new evidence, plus the issue number in the ledger. No new issue. |
| `FILE` | It passes the necessity gate below | One collated follow-up issue (see Collation) |
| `RECORD` | It fails the necessity gate | One row in the PR body's "Considered, not filed" table: item, reason, which gate test failed, re-evaluation trigger. This is a complete closure. |
| `ASK` | It needs a product or maintainer decision | A question to the user. Nothing is filed until they answer. |

## Necessity gate

`FILE` only when all four hold. Otherwise the item is `RECORD` (or `ASK`).

1. **Verified.** An executed probe or an exact source trace at `path:line` proves it on the current head. Never file an `INFERENCE`; record it, or add it to the repository's standing investigation issue if one exists.
2. **Consequential.** There is a concrete, reachable trigger with a correctness, safety/security, data-loss, or workflow-blocking (wedge) consequence. Coverage gaps, docs, wording, and "could harden" items fail unless they hide a real defect. Severity alone never qualifies.
3. **Material.** It sits on a hot path, invalidates a gate or contract, or blocks planned work. Low-interest debt in rarely touched code is `RECORD` with a re-evaluation trigger such as "revisit when `<file>` is next edited".
4. **Untracked and not fixable here.** No open issue covers it (check before filing), and it cannot be fixed in this PR without leaving the PR's files or scope.

## Collation and budget

- All `FILE` items from one PR go into **one** issue titled `Follow-up from PR #<N>: <theme>`. Use the repository issue format, with one acceptance criterion per item.
- Split into a second issue only when the items genuinely need separate PRs, for example different hotspot files that cannot share a review.
- A HIGH-severity item (fail-open gate, security, data loss) may stand alone.
- **Budget: at most two follow-up issues per PR.** If the gate passes more, stop and present the list to the user before filing.

## Tiers

- **Priority.** A wedge, fail-open gate, security, or data-loss item. File it at closeout.
- **Improvement.** Passes the gate but is not Priority. Present these as a proposed list in the closeout report, and file them only after the user approves.

## Findings about the review process itself

When the PR under feedback is PR-review or PR-feedback tooling, findings about the review or feedback process itself are `RECORD` unless they block a workflow. Examples: an incomplete ledger table, or a missed disposition.

## Truthfulness

A disposition must be true on the live artifact before the ledger or PR body states it:
- the issue exists before `FILE` is written;
- the comment is posted before `ABSORB` is written;
- the row is in the PR body before `RECORD` is written.

## PR body table

```md
### Considered, not filed
| Item | Reason | Gate test failed | Re-evaluate when |
|---|---|---|---|
| FB-007 | Coverage gap for the macOS fallback label; no behavior defect | 2 (consequence) | the probe cleanup path is next edited |
```
