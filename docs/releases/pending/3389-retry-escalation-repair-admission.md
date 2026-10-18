---
issue: 3389
---

# Retry-escalation wedge gains a one-step audited repair (TASK_RETRY_USER_ESCALATION_REQUIRED while in_progress)

## What

A task whose coder retry ladder reached its durable `user_escalation` rung
refused every further coder dispatch with `TASK_RETRY_USER_ESCALATION_REQUIRED`,
and the remedy the message named — "authorize repair" — was itself refused
(`TASK_REPAIR_NOT_BACKWARD`) for the only plan status the wedged task can have
(`in_progress`). No documented, audited exit existed for the combination.

- The audited force repair (`update_task_status` with `status: "in_progress"`,
  `force: true`, exact CAS fields, `target_state: "idle"`, reason, and
  transition id) is now admitted exactly when a durable `user_escalation` exists
  for the task's CURRENT retry epoch and `retryCount` sits at the threshold —
  the ladder's own user-decision proof. `repair_idle` then reopens the task and
  clears the whole retry circuit (`retryCount`/`retryHistory`/`retryEpoch`
  reset, generation rotated), so the next coder dispatch starts fresh.
- Every other `in_progress` repair still fails closed with
  `TASK_REPAIR_NOT_BACKWARD`, and an unreadable escalation index fails closed
  with the new typed `TASK_REPAIR_ESCALATION_INDEX_UNREADABLE` (remapped like
  the sibling audit-index errors) instead of guessing admission.
- The `TASK_RETRY_USER_ESCALATION_REQUIRED` message now names the reachable
  action (the `update_task_status` force repair with its CAS fields) instead of
  the unreachable bare wording; the `update_task_status` schema descriptions
  and force-override log line no longer call the repair "backward-only".
- Docs: the recovery runbook gains a retry-escalation user-decision wedge
  section (including why `approve_retry_sounding_board` and
  `recover_rework_task` do not apply, and noting the superseded blocked
  round-trip workaround); the reset-session retry-gate disclosure,
  plan-durability, and engineering-invariants FR-005 entries name the new
  admission.

## Why

The repair machinery already carried every required property (CAS, PREPARED →
COMMITTED WAL, audit event, generation rotation, retry-circuit reset); only the
admission guard excluded the one state the escalation ladder itself creates,
leaving users with no verified supported recovery path.

## Verification

- `tests/unit/workflow/task-repair-escalation-wedge-3389.test.ts` — admission
  (with `generation ≠ retryEpoch`), fail-closed partial-ladder/foreign-epoch/
  below-threshold refusals, guard order, and the index remap.
- `tests/unit/tools/update-task-status-escalation-wedge-3389.test.ts` —
  handler-level repair, circuit cleared, post-repair dispatch admission, the
  remedy-naming message pin, and the schema-wording pin.
