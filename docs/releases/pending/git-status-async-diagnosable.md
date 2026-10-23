# /swarm close and rollback gate reads are async and say why they failed

## What

The git-status gate reads behind `/swarm finalize` (alias `/swarm close`),
`/swarm rollback`, and the `/swarm diagnose` "Git Repository" check now run
through one shared async, bounded, killable reader instead of private blocking
`spawnSync` wrappers, and every converted status read passes
`--no-optional-locks` so a read-only check never contends on the git index
write lock.

When a gate read fails, the refusal text now names the cause instead of the
old generic "Ensure git is available and the repository is readable" hint:

- a timed-out read reports `ETIMEDOUT` and advises restarting the OpenCode
  host (or inspecting the host runtime / security software) — the right
  remedy when git is present and the host could not complete the child spawn;
- a nonzero exit reports the exit status and the git stderr tail (for
  example a damaged `.git/index`), with a repair-the-repository remedy;
- a missing git binary reports `ENOENT` with the install hint.

The fail-closed contracts are unchanged: an unreadable status still refuses
the destructive pipeline with "Nothing was closed, archived, or destroyed",
the close gate and the pre-destruction re-check still share one argv and one
parser, and an unreadable rollback measurement still refuses the restore.
`/swarm finalize --dry-run`'s repository probe is a single bounded async
attempt — it no longer falls into the blocking 5-attempt synchronous retry
chain (up to ~150 s of frozen host event loop when git hangs). The git
executable resolver's async entry now probes candidates through an async
spawn (never the synchronous probe), and a probe cycle that times out is no
longer negative-cached as the 60-second bare-`git` fallback.

The no-sync-spawn ratchet now also covers the four converted files
(`src/commands/close/orchestrator.ts`, `src/commands/destructive-purge.ts`,
`src/commands/rollback-gate.ts`, `src/services/diagnose-service.ts`), so the
blocking wrappers cannot return.

## Why

On a loaded Windows OpenCode host (issue #3275 field report), every
synchronous child spawn inside the host timed out while async spawns worked;
`/swarm close` aborted with no cause named and advice that blamed git
availability. The same detail-collapsing wrapper sat in front of the
rollback gate, the diagnose repository check, and the dry-run probe.
