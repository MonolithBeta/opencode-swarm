# Delegation gate: configurable acceptance criteria auto-injection

## Summary

- Adds `hooks.auto_inject_acceptance` configuration flag (default: `false`).
- When enabled, delegations to `coder` and `reviewer` agents that lack explicit `ACCEPTANCE:` criteria blocks automatically receive a synthesized default requirement block instead of failing closed with `ACCEPTANCE_FIELD_REQUIRED` or `ACCEPTANCE_FIELD_EMPTY`.

## Changes

- Adds `auto_inject_acceptance` boolean option to `HooksConfigSchema` in `src/config/schema.ts` and `opencode-swarm.schema.json`.
- Updates `createDelegationGateHook` in `src/hooks/delegation-gate.ts` to detect missing or empty `ACCEPTANCE:` fields when `auto_inject_acceptance` is true and inject a synthesized default requirement block into the delegation arguments.
- Emits warning on auto-injection for traceability while allowing the workflow to proceed safely.
- Adds comprehensive unit test coverage in `tests/unit/hooks/delegation-gate-acceptance-autoinject.test.ts`.
