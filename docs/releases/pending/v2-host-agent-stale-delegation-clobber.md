# Host v2: preserve host-provided agent across tool hooks and Task handoffs

## Summary

- On OpenCode v2 hosts, `onV2ToolBefore` and `onV2ToolAfter` supply the authoritative host-verified `agent` on every tool hook and seed session state via `seedV1SessionState`.
- Previously, `seedV1SessionState` did not refresh `session.lastAgentEventTime` when re-seeding an existing session with the same agent name, and `tool.execute.before` evaluated the v1 10-second `staleDelegation` heuristic (`!session.delegationActive && Date.now() - session.lastAgentEventTime > 10000`) even when `input.agent` was explicitly provided by the v2 host. For non-`architect` agents with `delegationActive === false`, this overwrote `activeAgent` and `session.agentName` to `'architect'` for one tool call every 10 seconds, allowing a hard-limit circuit breaker (`hardLimitHit === true`) to be bypassed intermittently.
- Additionally, `tool.execute.after` Task handoff unconditionally restored `ORCHESTRATOR_NAME` (`'architect'`) instead of preserving a host-provided parent `input.agent`.

## Changes

- Refreshes `session.lastAgentEventTime` in `seedV1SessionState` (`src/host/v2/setup.ts`) whenever a valid v2 agent reference is seeded.
- Guards the v1 `staleDelegation` fallback in `src/index.ts` `tool.execute.before` so it only runs when `input.agent` is not explicitly provided by the host.
- Restores `(input as { agent?: string }).agent?.trim() || ORCHESTRATOR_NAME` during `tool.execute.after` Task handoff in `src/index.ts`.
- Adds regression tests in `tests/unit/host/v2/adapter-behavior.test.ts`.
