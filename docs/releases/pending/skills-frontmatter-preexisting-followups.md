---
issue: 3387
---

# Skill-frontmatter pre-existing hardening: quote-aware comment strip, CRLF-tolerant split, staleness shadowing always runs

## What changed

Three pre-existing defects in the skill-frontmatter pipeline — surfaced by the
PR #3387 review cycle and explicitly approved as a follow-up — are fixed:

- The drift-check `skill-frontmatter` detector's comment stripping is now
  quote-aware: a `#` inside a quoted scalar (`[a, "b # c"] # note`) is
  content, so the value still triggers the flow-collection and bare-scalar
  checks that a value trailing comment previously escaped. A quote opens only
  at a value start, so an interior apostrophe in a plain flow scalar
  (`[it's, b] # note`) does not hide a trailing comment. A `#` at value start
  remains a comment-only value (no finding).
- `splitSkillFrontmatter` is CRLF-tolerant: line endings normalize before the
  fence scan, so a CRLF file returns real frontmatter/body slices instead of
  an empty split. Previously every bounded frontmatter surgery (version
  bumps, status flips) silently no-op'd on CRLF files while the skill
  reviser's revision notes still claimed a bump the file never received.
  Digests are unchanged (the digest normalizes the body), and returned slices
  are LF — the repo's checked-out policy.
- The `user-global-skill-staleness` detector's user-global shadowing
  comparison now runs regardless of the repo-side stamp state. Previously a
  missing or stale repo stamp `continue`d past the loop — exactly the
  situation where the canonical body is least vouched for — letting a stale
  user-global copy escape the shadowing notice. The repo-side stamp warning
  itself is unchanged.

## Why

All three were verified findings from the PR #3387 review cycle that
pre-dated that PR (each probe-confirmed at the merge base) and were approved
as a follow-up rather than expanded into an already-large diff.

## Verification

- New batteries: `drift-check-frontmatter-followups-3387.test.ts` (8 tests:
  quoted-hash flow collection fires, apostrophe plain scalar fires,
  quoted-hash-clean stays clean, inline-with-quoted-hash fires, bare-scalar
  trailing comment fires, and the three staleness combinations) and
  `skill-contract-digest-crlf-3387.test.ts` (6 tests: CRLF slices, digest
  parity, no-fence passthrough, stamp parity, reviser version bump and inline
  canonicalization on CRLF files) — all RED on the pre-fix base behavior,
  GREEN after.
- The pre-existing #2859 suite's byte-pin on the old no-normalize return was
  updated to the documented normalized contract, with a new CRLF-slice case.
- Full focused battery (16 test files, 242 tests) green; `typecheck`,
  `drift:check --enforce`, and the stamp script (ok ×4) all exit 0.
