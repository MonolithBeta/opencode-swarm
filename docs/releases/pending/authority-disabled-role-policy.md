# Guardrails: `authority.enabled: false` no longer rejects custom or host agents as unknown

## Summary

- With `authority.enabled: false`, writes by agents that the plugin has no authority classification for (for example custom host agents such as `sre-planner`, `builder` or `infra`) were rejected with `AUTHORITY_UNKNOWN_AGENT` ("Unknown agent: no authority classification exists"), even though authority enforcement had been switched off.
- Root cause: in `checkFileAuthorityWithRules` the unknown-agent denial ran for every agent regardless of `authority.enabled`, and `buildEffectiveRules` returns only the built-in role rules while authority is disabled.
- Fix: while authority is disabled, an agent without a classification is no longer denied merely for being unknown. It still passes through the hard-policy checks first and is then allowed.

## Behavior change

- This applies only when you set `authority.enabled: false`. The default (`true`) is unchanged: unclassified agents are still denied with `AUTHORITY_UNKNOWN_AGENT`.
- While authority is disabled, these checks still apply to every agent that reaches them: path safety and workspace containment, the configured `authority.universal_deny_prefixes` (empty by default), the canonical read-only and dedicated-tool-only roles, the coder `.git`/`.swarm` protection, and verifier-config protection for the built-in swarm roles.
- Newly admitted (unclassified) agents are additionally denied writes to `.git/` and `.swarm/` with `AUTHORITY_PROTECTED_PATH` when they use the file-write tools (write, edit, patch). Shell-command writes keep following the existing shell-path rules, which are unchanged. They remain able to write other workspace paths, including verifier and CI configuration, because the built-in host agents (`build`, `general`) already could. Set `authority.universal_deny_prefixes` (for example `.opencode/`, `.github/workflows/`) to keep further paths protected.
- Per-agent `authority.rules` (including `readOnly`) are still not applied while authority is disabled, exactly as before.
- The literal agent name `unknown` (a session registered without an agent name) keeps being denied with `AUTHORITY_UNKNOWN_AGENT` even while authority is disabled.

## Changes

- `checkFileAuthorityWithRules` (`src/hooks/guardrails/file-authority.ts`) treats an unclassified agent as allowed-through when `authorityEnabled === false`, after universal deny, control-state protection and the other hard-policy checks.
- Adds unit coverage in `tests/unit/hooks/guardrails-authority-disabled-hook-feedback.test.ts` for the disabled-mode allow, the retained denials, and the unchanged decision codes and layers.
