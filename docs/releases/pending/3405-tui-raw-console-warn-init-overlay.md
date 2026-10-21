# TUI: no raw console output on the plugin init path (issue #3405)

## What

The three unconditional raw `console.warn` calls on the plugin init path in `src/index.ts` are gone or opt-in:

- The startup version banner (`[opencode-swarm] running vX.Y.Z`, issue #2236) now rides the debug-gated logger (visible under `OPENCODE_SWARM_DEBUG=1`). A raw stderr leg remains available behind the new opt-in `OPENCODE_SWARM_VERSION_BANNER=1` env var for headless/CLI stale-cache diagnosis; the exact banner text is unchanged so log scrapers and the v2-dual-shape spike harness keep matching it.
- The project-root ownership redirect and fail-closed hints (issue #2679) no longer have a raw stderr leg. They were already double-buffered — the same text still reaches the operator via `/swarm diagnose` (`addDeferredWarning` + `advisoryWarn`) and the debug log, and the redirect record under `.swarm/advisories/` is unchanged.

## Why

In an in-process OpenCode TUI, plugin stderr renders as a full-width overlay pasted over the UI/input area, corrupting the session transcript (the #1249 class; the repo's `advisoryWarn` contract already forbids raw stderr/stdout on TUI-owned paths). The version banner fired on every boot; the ownership hints fired on every redirected or fail-closed boot.

## Consumer coordination

- `spikes/v2-dual-shape/run-spike.mjs` now sets `OPENCODE_SWARM_VERSION_BANNER=1` in its host-spawn env so its banner-detection regexes keep proving plugin load (v2 does not relay plugin stdout, so the debug-logger leg is not a dependable spike signal).
- The #2679 ownership suites' hint assertion was retargeted from the raw console capture to the deferred-warning buffer (same child-path-masking hygiene; both call sites kept), with a new negative assertion that neither console stream carries the hint.
- New guardrails: `tests/unit/index-init-tui-quiet-3405.test.ts` (real plugin boots in redirect / fail-closed / banner / debug-hint modes) and statement-anchored source pins in `tests/unit/plugin-tui-safety.test.ts` (no raw hint warn statements; advisory legs retained; exactly one banner warn gated by the env var).

## Environment

- New env var `OPENCODE_SWARM_VERSION_BANNER=1` (default off) — documented in `docs/configuration.md`.
