# Guardrails: allow file authority within linked git worktrees

## Summary

- When executing agent sessions inside a Git worktree or inspecting files across worktrees of the same repository, file authority checks could incorrectly fail with `AUTHORITY_ROOT_ESCAPE` (`target resolves outside the working directory`).
- Root cause: `checkFileAuthorityWithRules` assumed all valid file paths must be strictly contained within `dir` (`cwd`). In multi-worktree workflows, worktrees of the same repository live in sibling directories outside `dir`.
- Fix: `checkFileAuthorityWithRules` now discovers linked worktrees via `git worktree list --porcelain` (cached in LRU with a 60 s TTL) and treats files located within any valid linked worktree of the repository as workspace-contained.

## Changes

- Adds bounded discovery: `getLinkedGitWorktrees(dir)` with LRU cache (60 s expiry, so worktrees created or removed mid-session — and transient git failures — are re-queried), a 1500 ms timeout, explicit byte bound, `windowsHide`, and `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` stripped from the subprocess environment.
- Worktree roots are validated before they can widen containment: `bare` records are skipped, and every linked root must back-anchor to this repository — its `.git` file must reference a registration under this repository's `.git/worktrees/` whose own `gitdir` entry names the root back. This rejects registrations whose target has no cooperating `.git` file and registrations naming other repositories. Scope: worktree trust remains git-native trust — a directory that already contains an attacker-written `.git` pointer can still validate (git itself cannot distinguish that from a real `git worktree add`), and sessions inside a bare clone's linked worktree get no trusted roots (fail-closed, same as before this change).
- Re-roots to the LONGEST (most specific) matching worktree root, so deny rules resolve against the right root in nested layouts.
- A re-rooted target whose ancestor chain crosses a symlink/junction inside the matched worktree is denied (`AUTHORITY_ROOT_ESCAPE`), closing the new-file-write redirect path.
- Declared scope for coders is evaluated once, in the re-rooted coordinate system (the raw-path second evaluation is removed).
- Unit coverage in `tests/unit/hooks/guardrails-worktree-authority.test.ts` (sibling-layout allow/deny paths) and `tests/unit/hooks/guardrails-worktree-containment-hardening.test.ts` (cooperating and non-cooperating forged registrations, bare repositories, longest-match re-rooting, planted symlinks). Repository content that a trusted worktree's own scripts invoke (hook scripts, build steps) remains subject to the repository's own policies, as at base.

## Known caveats

- The worktree-root cache expires after 60 s; within that window a worktree added or removed mid-session is not reflected.
- Discovery runs a bounded synchronous `git worktree list` on the guard path for targets that escape `cwd` containment (at most once per directory per 60 s).
