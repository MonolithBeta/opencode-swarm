# Rollback/close pipeline hardening: async checkpoint+align probes, fail-closed destruction enumeration, porcelain path containment

## What

Follow-ups from PR #3426, collated (issues #3427 + #3434):

- The checkpoint tool's entry preflight and `saveCheckpointRecord`'s probe
  now ride the shared async git reader (`readGitRepositoryStatusAsync`)
  instead of the local sync `gitExec` retry chain — on a host whose sync
  child spawns stall (#3275), `/swarm checkpoint` no longer blocks up to the
  transient-retry horizon (~150 s) before refusing. Behavior change to note:
  the checkpoint preflight's refusal text is now the uniform
  `not a git repository - checkpoint tools require a git repository` for
  every failure mode (timeout, missing binary, EACCES alike) — the old sync
  probe's reason-bearing warning texts were part of the removed helper;
  reason-specific checkpoint refusal is tracked as a follow-up. The finalize
  align stage's repository probe moved to the same reader through a new
  `readGitRepositoryStatusDetailedAsync` that preserves the exact
  `GitRepositoryStatus` reason vocabulary (`not_git_repo`,
  `git_unavailable`, `git_error`) the sync probe produced, including the
  #2236 three-way ENOENT cwd/binary split.
- The rollback destruction measurement now fails CLOSED when its
  `ls-tree`/`ls-files` enumeration cannot be read: `measureGitDestruction`
  reports `unreadable` with the structured cause instead of folding an
  empty in-the-way set into an `ok` measurement whose scope silently
  shrank below what `git reset --hard` would actually overwrite.
- Both porcelain parsers (NUL and newline forms) now exclude `../`-bearing
  (or absolute) records from the destroy scope and surface them as a
  bounded diagnostic on every consumer — the `/swarm rollback` preview and
  clean-tree restore, the checkpoint restore preview and clean-tree
  response, and the `/swarm close` early confirmation preview plus close
  summary warnings — instead of joining them into the confirm-token scope
  digest unvalidated.
- The no-sync-spawn ratchet covers `src/commands/close/align-stage.ts`
  (sync-spawn-free after the conversion) with a runtime membership
  self-pin; `src/tools/checkpoint.ts`'s probe conversions are guarded by a
  dedicated spawn-slot-counting suite named in the ratchet as their
  different guard.

## Why

#3427 (priority:high): the two residual sync git probes sat on paths that
cross EVERY checkpoint invocation and the finalize pipeline — under the
#3275 loaded-host condition each probe could block ~150 s and then blame the
repository. #3434: an unreadable enumeration reading as "nothing in the
way" is the exact fail-open class #3317 closed for the status reads
("unreadable must never read as clean"), one call-site deeper — the
confirm token bound a scope smaller than the destruction; and porcelain
records joined the digest with no root-containment check anywhere on the
push path.
