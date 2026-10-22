# CI: merge-queue and release jobs now run on self-hosted Linux and macOS runners

## What

CI has been rebalanced onto the organization's self-hosted runner pool (Linux X64 and macOS ARM64 machines):

- **Merge-queue legs** (`ci.yml` on `merge_group` events):
  - `quality`, `coverage-shard`, `coverage`, `integration`, `package-check` and `security` run on `[self-hosted, Linux, X64]`.
  - The per-OS matrix job `memory-recall-regression` sends its `ubuntu-latest` cells to `[self-hosted, Linux, X64]` and its `macos-latest` cells to `[self-hosted, macOS, ARM64]`.
  - The `unit` and `smoke` matrices stay on GitHub-hosted runners for every OS. In the first routed queue run the self-hosted Linux hosts ran `unit` shards at 29-40+ minutes against this job's 40-minute ceiling (two of six shards were killed at the limit) and could not finish `smoke` inside its 15-minute window, while the self-hosted macs failed a broad class of subprocess-spawning suites (spawned children exited before the bounds under test could fire). Both stay GitHub-hosted until those are root-caused on the pool.
  - `php-validation`, the Windows `rust-sandbox-runner`, and the small gate jobs (`detect-release`, `release-owner-guard`, `detect-paths`, `unit-passed`) stay on GitHub-hosted runners.
- **Trusted-event jobs**: all non-matrix jobs in `release-and-publish.yml` (which only ever runs on `push` to `main`), plus `stale.yml`, `quarantine-aging.yml`, and the scheduled/`workflow_dispatch` legs of `host-contract-check.yml`, run on `[self-hosted, Linux, X64]`.

Routing is expressed per job, so one job definition keeps every leg on the right runner. Every route names an explicit OS and architecture: every self-hosted runner carries the `self-hosted` label whatever its OS, so a bare `self-hosted` could land on the wrong machine. Matrix values are unchanged, so required-check names such as `unit (macos-latest, 3)` are unchanged.

Self-hosted machines persist between jobs and run several runner instances per host, so the seven routed `ci.yml` jobs each begin by pointing `TMPDIR` at their per-job `RUNNER_TEMP` (emptied by the runner for every job). Files left behind by an earlier job, such as a stray `.swarm` directory, cannot leak into the next one. Each of them also probes for a Bun already on the runner's `PATH` and skips setup-bun's release download when one is present, so a host with a pre-staged Bun never touches the WAN for toolchain setup.

The jobs in `release-and-publish.yml`, `stale.yml`, `quarantine-aging.yml` and `host-contract-check.yml` keep the runner's default temp root. None of them runs the repository test suite, which is what creates the `.swarm` scratch state the isolation above guards against; `publish-npm` is the largest of them at eleven steps, running a build and the package smoke check. If any of them later gains a test-suite step, it needs the isolation step too.

## Why

The org's 20-job GitHub-hosted pool has been the bottleneck: at peak, merge-group matrices from several queued PRs queued 50-200+ jobs deep with 10-90 minute waits, and PRs were evicted from the merge queue after hours without a runner. Moving the merge-queue matrix and the trusted-event jobs onto the self-hosted pool takes that load off the shared pool.

## Security posture (deliberate)

`ZaxbyHub/opencode-swarm` is a public repository that accepts pull requests from forks. CI executes code from pull-request heads, so:

- **`pull_request` jobs are never routed to self-hosted runners.** Anyone able to open a fork PR would otherwise get arbitrary code execution on those machines. `tests/unit/scripts/ci/ci-self-hosted-routing.test.ts` sweeps every workflow and fails if a `pull_request`-triggered job can reach the self-hosted pool outside the sanctioned expressions.
- **`merge_group` jobs are routed with the maintainer's explicit approval.** A queued PR's merged state (including any fork-PR code that passed review) executes on the self-hosted pool. This is an accepted residual risk; the per-job expressions are the single place to revisit it.
- `workflow_run`-triggered jobs (e.g. `flake-detection`) were not moved, since they consume artifacts produced by untrusted runs.

## Verification

- `tests/unit/scripts/ci/ci-self-hosted-routing.test.ts` pins the routing: no untrusted leg reaches the pool, every self-hosted label set names a supported OS/arch pair, Windows legs stay GitHub-hosted, the routed job set is declared, and every routed job isolates its temp dir. Each check was falsified by an executed mutation.
- Every test suite that reads `.github/workflows/` passes, as do `scripts/check-workflow-timeouts.ts`, `bun run drift:check --enforce` and the required-check contract (the `ci.yml` sha256 in `docs/ci/required-check-evidence.json` is refreshed in the same change).
- No job was renamed or removed, so the required-check contexts and the ruleset contract are unchanged.

## Migration

No action required for contributors. Maintainers: the self-hosted runners must be in a runner group that allows public repositories, or GitHub will not assign this repository's jobs to them. If no online runner matches a route's labels, merge-queue jobs queue on it indefinitely: watch for jobs stuck in `queued` and either bring a matching runner back or revert this change.
