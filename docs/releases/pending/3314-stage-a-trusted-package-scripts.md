---
issue: 3314
---

# Stage A trusts base-identical compound package scripts

## What

`/swarm pr-feedback` Stage A no longer hard-fails on repositories whose `build`,
`typecheck` or `lint` package script is a compound shell string (`&&`, `|`, `;`, …).
When the caller supplies `base_ref`/`base_sha` provenance and the script text is
byte-identical at that immutable merge base, discovery now returns the normal
`package.json#<script>` obligation instead of throwing
`BLOCKED: Stage A opaque package script …`. This repository itself was wedged: its
own `build` script is an `&&` chain and no `.pr-validation.json` exists, so every
content-changing PR-feedback run died on its first Stage A call.

Trust is exactly the merge-base identity the `.pr-validation.json` path already
enforces: a script the PR itself adds or modifies, a missing base manifest, a
non-string script value, or absent provenance all stay BLOCKED. The Stage A check
must still select the script exactly through the package manager
(`bun run build`), and the BLOCKED text for the remaining untrusted case now names
the `.pr-validation.json` remedy. One inherited path-shape limit (fail-closed, same
as the contract path): workspaces whose directory names fall outside the git
snapshot reader's manifest-path pattern (scoped packages like `@acme/ui`, spaced or
Unicode directory names) stay BLOCKED even when base-identical. For
discovery-scanned workspaces of that shape (anything directly under
`packages`/`apps`/`services`/`libs`/`crates`) there is no `.pr-validation.json`
escape either — the contract read fails the same path pattern — so the way out is
renaming the directory to a conforming shape or making the script non-compound.

Recorded residual (merge-base-owned, not PR-introducible): base-identical compound
text is trusted without the plausibility screen simple scripts pass, so a
repository whose merge base already carries a trivially-passing compound script
gets a vacuous Stage A green; and sibling scripts/files the trusted script invokes
(`bun run clean`, `scripts/*.ts`) remain repository content, as they already are
for simple scripts.

## Why

Issue #3314 (wedge-audit slot L1, tracker #3309): the opaque-script throw ran
before every other Stage A precondition, leaving no in-band path to completion —
the defining wedge of the audit program.

## Verification

Nine frozen acceptance checks (C1-C9) in trace
`3314-stage-a-trusted-package-scripts`: five DISCRIMINATING checks reproduce the
BLOCKED throw at base and pass after the fix (discovery-level, this repository's
verbatim `build` text, end-to-end receipt recording, remedy text, exact script
selection); four PRESERVING checks pin the unchanged floors (PR-modified and
base-absent scripts stay BLOCKED, no-provenance stays BLOCKED, simple and
non-matching scripts unchanged, the `.pr-validation.json` contract path
unchanged). Full stage-a suite battery green (43/43 siblings).
