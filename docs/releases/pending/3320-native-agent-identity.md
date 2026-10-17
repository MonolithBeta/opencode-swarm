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
`info.agent` on USER views, and the pipeline-tracker / delegation-gate message
stages resolve identity through the shared
`resolveMessageTransformContext` (also fixing prefixed architects —
`mega_architect` — never receiving the workflow reminder, and treating the
`unknown` placeholder identity as unmapped so first-turn architect sessions
keep their guidance); the full test-suite block is scoped to swarm-owned
sessions (destructive-command, containment, and symlink checks stay universal;
the Task-to-coder ACCEPTANCE gate stays target-keyed); sessionless
`system.transform` calls (title, summary, agent generation) emit no
swarm-specific system text, including the swarm-command-rule banner and the
sessionless HF-1b emission.

## Deliberately updated pinned tests

Two pre-existing suites pinned the OLD sessionless behavior and are updated
under the issue's replacement discipline (replaced, not weakened; each new
assertion pins the replacement contract):

- `tests/integration/system-transform-global-mode-fallback.test.ts` — its
  three sessionless cases asserted borrowing another session's TURBO/FULL-AUTO
  flags and the PLANNING PROFILE producer; they now assert the new
  no-swarm-text contract with byte-exact equality. Independently pinned by the
  new `system-transform-sessionless-no-swarm-text.test.ts`.
- `tests/unit/hooks/system-enhancer-hf1b-adversarial.test.ts` (ATTACK 7) —
  pinned a sessionless HF-1b emission; sessionless surfaces execute no tools,
  so the guard's protective value there was nil. ATTACK 7 now asserts the
  sessionless call emits nothing. Session-bound HF-1b behavior is unchanged
  (ATTACK 1-6).

## Known caveats

- The primary-owner record is in-memory: after a plugin restart an unmapped
  session keeps today's architect-default behavior until its next
  chat.message / v2 seeding event (documented out of scope in #3320).
- A v2 plan/build session's very first `prompt` event (before any context
  event records its owner) still follows today's behavior until the next
  seeding event.
- With `auto_select_architect` enabled, an agent-less turn IS the default
  architect taking over — it re-arms the primary owner to `architect`. A
  session that ran one native-agent turn and then returns to agent-less
  default turns is an architect session again (per that option's own
  semantics).
- Message-view identity stamping is USER views only (the v1 SDK shape carries
  `agent` on `UserMessage`, never on `AssistantMessage`), so role-unfiltered
  consumers keep matching user-authored turns only.
- `/swarm memory` instruction-pairing can still re-stamp a session identity
  to architect — same defect class, separate surface, filed as #3372.

No migration required.
