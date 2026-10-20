# CI: merge-queue and release jobs now run on the self-hosted runner

## What

CI has been rebalanced onto the organization's new self-hosted runner (label `self-hosted`):

- **Merge-queue legs** (`ci.yml` on `merge_group` events): the four heavy single-OS jobs — `quality`, `coverage-shard`, `package-check`, and `security` — now run on `self-hosted` while their `pull_request` legs stay on GitHub-hosted `ubuntu-latest`. The per-OS matrix jobs (`unit`, `memory-recall-regression`, `smoke`) and the Windows `rust-sandbox-runner` remain on GitHub-hosted runners.
- **Trusted-event jobs**: all non-matrix jobs in `release-and-publish.yml` (which only ever runs on `push` to `main`), plus `stale.yml`, `quarantine-aging.yml`, and the scheduled/`workflow_dispatch` legs of `host-contract-check.yml`, now run on `self-hosted`.

Routing is expressed as a per-job expression, e.g. `runs-on: ${{ github.event_name == 'merge_group' && 'self-hosted' || 'ubuntu-latest' }}`, so a single job definition keeps both legs on the right runner. The `pull_request` legs of every workflow stay on GitHub-hosted runners.

## Why

The org's 20-job GitHub-hosted pool has been the bottleneck: at peak, merge-group matrices from several queued PRs queued 50-200+ jobs deep with 10-90 minute waits, stalling merges repo-wide. Moving the heaviest merge-queue jobs and all trusted-event jobs to the self-hosted runner takes that load off the shared pool.

## Security posture (deliberate)

`ZaxbyHub/opencode-swarm` is a public repository that accepts pull requests from forks. CI executes code from pull-request heads, so:

- **`pull_request` jobs are never routed to the self-hosted runner.** Anyone able to open a fork PR would otherwise get arbitrary code execution on that machine.
- **`merge_group` jobs are routed only with the maintainer's explicit approval.** A queued PR's merged state (including any fork-PR code that passed review) executes on the runner. This is an accepted residual risk, not an oversight; if it needs to be revisited, the per-job expressions above are the single place to change.
- `workflow_run`-triggered jobs (e.g. `flake-detection`) were not moved, since they consume artifacts produced by untrusted runs.

## Verification

- All five workflow files parse; `scripts/check-workflow-timeouts.ts` reports 0 findings across the 10 workflow files.
- `bun run scripts/check-required-check-contract.ts` and `bun run drift:check --enforce` both pass (the `ci.yml` sha256 in `docs/ci/required-check-evidence.json` is refreshed in the same change, as the contract-owned-workflow gate requires).
- `tests/security/ci-workflow-security.test.ts`, `tests/unit/scripts/ci/host-contract-check-workflow-2902.test.ts`, `tests/unit/scripts/release-fragment-cleanup-workflow.test.ts`, `tests/unit/scripts/check-workflow-timeouts*.test.ts`, and `tests/unit/scripts/fragment-gate-workflow-contract.test.ts` all pass.
- No job was renamed or removed, so the required-check contexts and the ruleset contract are unchanged.

## Migration

No action required for contributors. If the self-hosted runner is offline, merge-queue runs will queue on it — watch for `quality`/`package-check`/`security` jobs stuck in `queued` and either bring the runner back or revert this change.
