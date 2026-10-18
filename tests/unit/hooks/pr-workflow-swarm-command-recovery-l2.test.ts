/**
 * Issue #3315 acceptance check AC17 (trace 3315-prescribed-tools-reachable) —
 * `swarm_command` recovery commands are reachable in BOTH PR gate modes.
 *
 * Discriminating check: RED at base, GREEN after the fix. At the unfixed base
 * `swarm_command` carries no `prWorkflow` capability, so PR_REVIEW rejects it
 * with "read-only and fail-closed" and PR_FEEDBACK rejects it with "rejects
 * unclassified plugin/MCP tools" — the `resolves.toBeUndefined()` assertions
 * below fail there. Once the E3 fix admits the two recovery commands, this
 * check turns GREEN.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const RECOVERY_COMMANDS = ['diagnose', 'guardrail reset'] as const;

describe('issue #3315 AC17 — swarm_command recovery commands reachable in both PR modes', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('admits diagnose and guardrail reset under a bound PR_REVIEW gate', async () => {
		const sessionId = `${SESSION_ID}-3315-ac17-review`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		for (const command of RECOVERY_COMMANDS) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
					command,
				}),
			).resolves.toBeUndefined();
		}
	});

	test('admits diagnose and guardrail reset under a bound PR_FEEDBACK gate', async () => {
		const sessionId = `${SESSION_ID}-3315-ac17-feedback`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		for (const command of RECOVERY_COMMANDS) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'swarm_command', {
					command,
				}),
			).resolves.toBeUndefined();
		}
	});
});
