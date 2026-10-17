# Guardrails: evaluate authorityEnabled before role policy and retain rules when disabled

## Summary

- When file authority is disabled (`authority.enabled: false`), requests from custom or non-standard host agents (e.g., `sre-planner`, `builder`, `infra`) could still be rejected if the agent was not in the hardcoded known-agent list.
- Root cause: Role policy checks (`isKnownAgent`, `isStrictAgent`) were evaluated prior to checking if `authorityEnabled` was toggled off, and configuring `authority.enabled: false` caused custom user rules to be dropped from configuration.
- Fix: `authorityEnabled` is evaluated before role policy enforcement, and rules are retained even when authority is disabled so universal and state protections stay active.

## Changes

- Updates `createFileAuthorityHook` in `src/hooks/guardrails/file-authority.ts` to evaluate `authorityEnabled` prior to agent role validation.
- Retains rules configuration when `authority.enabled` is false so state and universal deny rules remain enforced.
- Adds comprehensive unit test coverage in `tests/unit/hooks/guardrails-authority-disabled-hook-feedback.test.ts`.
