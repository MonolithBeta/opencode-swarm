---
issue: 3320
---

# Native agents keep their identity across the swarm plugin (v1 + v2)

## What

Sessions whose primary agent is one of OpenCode's built-in agents (Build,
Plan, general) are no longer silently re-labelled `architect` by the swarm
plugin, on either the v1 or the v2 host. Build and Plan keep their own file
authority, receive no architect-only directives (ARCHITECT WORKFLOW REMINDER,
`[NEXT]` delegation directive, guardrail/knowledge/PLANNING PROFILE
injections), and are no longer subject to the swarm-only in-session
full-test-suite block. Explicit architects, `auto_select_architect` default
architects, and the subagent-identity repair keep today's behavior exactly.

## Why

Several code paths overwrote or inferred the session identity as `architect`
without asking who the primary agent actually is, defeating the earlier
per-surface native-agent exemptions (#559, #942, #808). The fix introduces a
per-session PRIMARY-owner record (`getPrimaryOwner` / `isSwarmOwnedSession` /
`isRegisteredSwarmSubagent` in `src/state.ts`) and restores it at every
handoff: the Task-completion handoff and the delegation tracker's no-agent
branch restore `primaryOwner ?? architect`; the stale-delegation revert now
applies only to registered swarm subagents; v2 message views stamp
`info.agent`, the v2 prompt adapter passes the last-known agent, and the
pipeline-tracker / delegation-gate message stages resolve identity through
the shared `resolveMessageTransformContext` (also fixing prefixed architects
— `mega_architect` — never receiving the workflow reminder); the full
test-suite block is scoped to swarm-owned sessions (destructive-command,
containment, and symlink checks stay universal; the Task-to-coder ACCEPTANCE
gate stays target-keyed); sessionless `system.transform` calls (title,
summary, agent generation) emit no swarm-specific system text, including the
swarm-command-rule banner.

## Deliberately updated pinned test

`tests/integration/system-transform-global-mode-fallback.test.ts` pinned the
OLD sessionless-emission behavior (borrowing another session's TURBO/FULL-AUTO
flags and the PLANNING PROFILE producer). Its three sessionless cases now
assert the new no-swarm-text contract with byte-exact equality; the sanction
comes from the issue body itself ("they are replaced; they are not deleted or
weakened without replacement"), and the new contract is also pinned by the
new `tests/integration/system-transform-sessionless-no-swarm-text.test.ts`.

## Known caveats

- The primary-owner record is in-memory: after a plugin restart an unmapped
  session keeps today's architect-default behavior until its next
  chat.message / v2 seeding event (documented out of scope in #3320).
- A v2 plan/build session's very first `prompt` event (before any context
  event records its owner) still follows today's behavior until the next
  seeding event.
- `/swarm memory` instruction-pairing can still re-stamp a session identity
  to architect — same defect class, separate surface, filed as #3372.

No migration required.
