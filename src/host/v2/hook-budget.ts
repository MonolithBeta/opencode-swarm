/**
 * Budget for the OpenCode 2 `tool.execute.before` guard chain (#3446).
 *
 * The v2 adapter wraps the whole v1 before-chain in one timeout. The chain is
 * normally instant, but while Full-Auto is running it can contain an LLM
 * oversight dispatch whose own deadline (`full_auto.oversight.total_timeout_ms`,
 * default 120 s, up to 300 s) is LONGER than the fixed 60 s the adapter used.
 * The host then reported "tool.execute.before exceeded budget" at 60 s while the
 * critic kept running to its own deadline, and the run paused.
 *
 * Resolution order:
 *   1. `full_auto.oversight.hook_timeout_ms` when set (explicit, always applies);
 *   2. else, while a Full-Auto run is active for the session:
 *      `oversight.total_timeout_ms + 30 s` (never below the base);
 *   3. else the 60 s base.
 */

export const V2_TOOL_BEFORE_BASE_MS = 60_000;
export const V2_TOOL_BEFORE_MARGIN_MS = 30_000;
export const V2_TOOL_BEFORE_MAX_MS = 900_000;
const DEFAULT_OVERSIGHT_TOTAL_MS = 120_000;

interface BudgetConfig {
	hookTimeoutMs?: number;
	oversightTotalMs: number;
}

let budgetConfig: BudgetConfig = {
	oversightTotalMs: DEFAULT_OVERSIGHT_TOTAL_MS,
};

function finitePositive(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

/** Record the relevant `full_auto.oversight` settings (call once at setup). */
export function configureV2ToolBeforeBudget(fullAuto: unknown): void {
	const oversight = (
		fullAuto as { oversight?: Record<string, unknown> } | undefined
	)?.oversight;
	const hook = finitePositive(oversight?.hook_timeout_ms);
	budgetConfig = {
		...(hook !== undefined
			? { hookTimeoutMs: Math.min(V2_TOOL_BEFORE_MAX_MS, Math.round(hook)) }
			: {}),
		oversightTotalMs:
			finitePositive(oversight?.total_timeout_ms) ?? DEFAULT_OVERSIGHT_TOTAL_MS,
	};
}

/** Budget, in ms, for one `tool.execute.before` chain. */
export function resolveV2ToolBeforeBudgetMs(fullAutoActive: boolean): number {
	if (budgetConfig.hookTimeoutMs !== undefined)
		return budgetConfig.hookTimeoutMs;
	if (!fullAutoActive) return V2_TOOL_BEFORE_BASE_MS;
	return Math.min(
		V2_TOOL_BEFORE_MAX_MS,
		Math.max(
			V2_TOOL_BEFORE_BASE_MS,
			budgetConfig.oversightTotalMs + V2_TOOL_BEFORE_MARGIN_MS,
		),
	);
}

/** Test seam: restore defaults. */
export function resetV2ToolBeforeBudget(): void {
	budgetConfig = { oversightTotalMs: DEFAULT_OVERSIGHT_TOTAL_MS };
}
