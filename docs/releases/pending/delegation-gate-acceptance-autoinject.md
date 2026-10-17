# Delegation gate: configurable acceptance criteria auto-injection

## Summary

- Adds the opt-in `hooks.auto_inject_acceptance` setting (default: `false`).
- When enabled, a `coder` or `reviewer` delegation that has no `ACCEPTANCE:` line, or only an empty one, is no longer rejected with `ACCEPTANCE_FIELD_REQUIRED`. The gate writes a generic default requirement into the dispatch, marked `(auto-injected default: ...)`, and queues an `ACCEPTANCE AUTO-INJECTED` advisory for the dispatching session (when that session is registered).
- With the default (`false`), the existing strict fail-closed behavior is unchanged.

## Changes

- Adds `auto_inject_acceptance` to `HooksConfigSchema` in `src/config/schema.ts` and `opencode-swarm.schema.json`.
- `createDelegationGateHook` in `src/hooks/delegation-gate.ts` fills an empty `ACCEPTANCE:` header in the field that actually carries it (line endings preserved), or appends a block to `prompt` (else the first text field). It never fabricates a field: if the dispatch has no text field at all, the strict rejection stands. The signal is emitted only after the injected text passes the same validator.
- `config doctor` now derives its known-hook allowlist from `HooksConfigSchema`, so the new key (and the previously missing `background_subagents` and `background_pending_timeout_minutes`) is no longer reported as an unknown hook field that `--fix` would remove.
- Documents the setting in `docs/configuration.md`.
- Adds tests: `tests/unit/hooks/delegation-gate-acceptance-autoinject.test.ts` (injection, preservation, flag-off, field targeting, CRLF/NBSP, advisory) and `tests/unit/services/config-doctor-hooks-parity.test.ts`.

## Known caveats

- The injected requirement is generic, not task-derived. For a single task mapped to spec requirements the verbatim `FR-###`/`SC-###` text is still appended and coverage-checked, but an unmapped task or a multi-task phase/council reviewer dispatch only receives the generic line.
- Project config can set this key (as it can `hooks.delegation_gate`); it has no user-level-only protection.
- The motivating OpenCode v2 behavior (a hook-thrown rejection not being rendered to the model) is not verifiable in this repository.
