---
issue: 3311
---

# PR-Review: typed terminal classes on failed verdict lanes; typed-dead N-of-M settlement

## What

Every failed reviewer/critic verdict lane now carries a durable, typed terminal
class, and an item whose owner lanes all died with a typed terminal — not only
host-liveness deaths — can settle through N-of-M verdict settlement as a
disclosed, downgrade-only INCOMPLETE once the per-item retry budget
(`1 + PR_REVIEW_VERDICT_RETRY_BUDGET` attempt batches) is exhausted (#3275
RC3).

- New `verdict_contract` failure class: verdict-lane collection-validation
  failures (any predicate, keeping the `PR_REVIEW_VERDICT_CONTRACT_INVALID`
  error code) and transport-validation throws settle `error` with
  `workflowLaneFailureClass: 'verdict_contract'` for
  `swarm-pr-review:reviewer|critic` lanes. PR-feedback lanes keep their
  classless terminals; base/micro discovery keeps `contract`.
- Provider-terminal settlements that end `error` (never the aborted →
  `cancelled` arm) are typed `resource` for every lane, mirroring the #2615
  launch-rejection rule. A base dimension whose only failure is such a lane now
  derives FAILED/`resource` (also for pre-upgrade classless records carrying
  `terminalErrorClass`) and admits into partial base coverage instead of
  throwing "lacks a typed terminal failure"; under staged resilience it
  surfaces as a bounded `resource` retryable remainder.
- N-of-M admission accepts `verdict_contract`, `resource` and legacy
  `contract` verdict-mode owners as typed-dead evidence (legacy `contract`
  discloses as `verdict_contract`); a completed-but-unclaiming owner counts as
  a consumed attempt instead of a permanent blocker. A missing record,
  classless silence, `operator_cancelled` (default decision) and an aborted
  host cancellation still block — nothing widens identity, nothing admits
  silence, and no path yields APPROVE or a synthesized verdict.
- The settlement receipt now discloses the TRUE class per item
  (`liveness_dead`/`verdict_contract_dead`/`resource_dead`); old
  `liveness_dead` receipts keep parsing.
- Ghost-owner prevention: reviewer/critic dispatches validate every lane agent
  BEFORE the validation batch is recorded, and a dispatch that launches zero
  lanes rolls the batch back — a declared owner with no delegation record can
  no longer be created.
- Micro dead-family disclosure admits `resource`-class and pre-upgrade
  classless provider-terminal micro lanes under the same exhausted-budget
  rule; `operator_cancelled` and silence stay rejected.
- The reviewer/critic BLOCKED message now carries per-item attempt counts
  (`attempts: <used> of 3`, `remaining: <n>`) and names the blocking owner
  class; the unreachable "controller-observed liveness evidence" advice is
  gone. `pr_workflow_status` exposes the same counts as
  `prReviewProjection.verdictAttempts`.

## Why

Verdict lanes that failed for contract or provider reasons could never settle:
the admission predicate read exactly one class (`liveness`), the producers
stamped none, and the only exits were aborting the review or human
intervention — the #3275 wedge. Together with #3310 (which removed the
prompt-collision trigger), retries can now succeed, and persistent non-liveness
failures degrade honestly instead of wedging.

## Notes

- The gate's architect-parent repair predicate (base/micro lanes) is
  deliberately unchanged and stays strictly liveness-gated.
- `operator_cancelled` owners remain non-admissible by default (issue #3311
  AC13): an architect cancelling idle lanes must not convert unvalidated
  candidates into disclosed-dead evidence by its own act.
