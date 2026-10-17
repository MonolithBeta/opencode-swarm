/**
 * Issue #3310 AC25 — a quarantined short row naming an ASSIGNED id does not
 * fail the valid row for that same id.
 *
 * When an assigned id has one legal-arity row plus one illegal-arity short
 * row naming the same id, the short row must be quarantined (not counted) and
 * the valid row must settle the item.
 *
 * RED at base, GREEN after the fix: at base the short duplicate counts in the
 * exact-set check (observedIds carries the id twice), which voids the lane and
 * also blocks the per-item parse (two rows for one id); after the fix the
 * illegal-arity duplicate is quarantined and the valid row settles.
 */

import {
	analyzePrReviewVerdictRowContract,
	type PrReviewItemClaim,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

const REVIEWER_CLAIMS: ReadonlyMap<string, PrReviewItemClaim> = new Map([
	[
		'C-1',
		{
			batchId: 'batch-1',
			laneId: 'lane-1',
			workflowLane: 'workflow-lane-1',
			classification: 'CONFIRMED',
			severity: 'HIGH',
		},
	],
]);

describe('issue #3310 AC25: quarantined short duplicate does not fail the valid row for the same id', () => {
	test('reviewer: valid row settles despite a short 4-field row naming the same assigned id', () => {
		const artifact = [
			'[REVIEWED] | C-1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			'[REVIEWED] | C-1 | APPROVED | fine',
		].join('\n');
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['C-1'],
			'reviewer',
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(artifact, ['C-1'], 'reviewer');
		expect(parsed.has('C-1')).toBe(true);
		expect(parsed.get('C-1')?.classification).toBe('CONFIRMED');
		expect(parsed.get('C-1')?.severity).toBe('HIGH');
	});

	test('critic: valid row settles despite a short 4-field row naming the same assigned id', () => {
		const artifact = [
			'[CRITIC] | C-1 | UPHELD | HIGH | rationale long enough | required change text',
			'[CRITIC] | C-1 | UPHELD | MEDIUM',
		].join('\n');
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS,
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			artifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS,
		);
		expect(parsed.has('C-1')).toBe(true);
		expect(parsed.get('C-1')?.classification).toBe('UPHELD');
		expect(parsed.get('C-1')?.severity).toBe('HIGH');
	});

	test('#3334 AC3 (parse-level): 16+ stray rows stay distinct, bounded, and never disturb the valid row', () => {
		// Parse-level arm of the 16+ stray rows case this file's issue argv
		// names: every stray id survives bounded and distinct, and the valid
		// sibling row still settles. (The composition-level ordering contract
		// is pinned by
		// tests/unit/hooks/pr-workflow-gate-quarantine-diagnostic-order-3334.test.ts;
		// per-lane aggregation versus per-row emission is not distinguished
		// there — see the PR body's considered-not-filed row.)
		const artifact = [
			'[REVIEWED] | C-1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			...Array.from(
				{ length: 20 },
				(_v, index) => `[REVIEWED] | stray-${index} | APPROVED | looks fine`,
			),
		].join('\n');
		const { quarantined, parsed } = parsePrReviewVerdictRows(
			artifact,
			['C-1'],
			'reviewer',
		);
		expect(quarantined).toHaveLength(20);
		// Every stray id is bounded and distinct; the valid row still settles.
		expect(new Set(quarantined.map((entry) => entry.itemId)).size).toBe(20);
		expect(parsed.has('C-1')).toBe(true);
	});
});
