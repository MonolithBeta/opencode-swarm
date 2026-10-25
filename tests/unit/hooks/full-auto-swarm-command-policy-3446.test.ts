/**
 * #3446 — Full-Auto passes only READ-ONLY /swarm commands without a critic. The
 * tool policy's agent allowlist also contains state-changing and
 * process-spawning commands, so it is not a safety classification.
 */
import { describe, expect, test } from 'bun:test';
import {
	isSwarmCommandReadOnly,
	READ_ONLY_SWARM_COMMANDS,
} from '../../../src/hooks/full-auto-permission';

describe('isSwarmCommandReadOnly', () => {
	test('true for read-only commands the tool policy permits', () => {
		for (const args of [
			{ command: 'status', args: [] },
			{ command: 'status' },
			{ command: 'diagnose', args: [] },
			{ command: 'sdd status', args: [] },
			{ command: 'sdd validate', args: [] },
			{ command: 'show-plan', args: [] },
			{ command: 'history', args: [] },
			{ command: 'costs', args: ['--json'] },
		]) {
			expect(isSwarmCommandReadOnly(args)).toBe(true);
		}
	});

	test('false for state-changing or process-spawning commands that the tool policy allows an agent to run', () => {
		for (const command of [
			'sdd project',
			'auto-proceed',
			'guardrail reset',
			'attest',
			'ci-simulate',
			'gate-audit',
			'review',
			'post-mortem',
			'pr subscribe',
			'pr unsubscribe',
			'memory compact',
			'memory import',
			'memory migrate',
			'memory link',
			'memory unlink',
			'memory export',
			'export',
			'recover',
			'harness-opt run',
			'harness-opt stop',
			'benchmark',
			'config doctor',
		]) {
			expect(isSwarmCommandReadOnly({ command, args: [] })).toBe(false);
		}
	});

	test('false for human-only, restricted and unknown commands', () => {
		for (const command of [
			'full-auto',
			'epic',
			'approve-write',
			'reset-session',
			'rollback',
			'definitely-not-a-command',
			'',
		]) {
			expect(isSwarmCommandReadOnly({ command, args: [] })).toBe(false);
		}
	});

	test('false when the tool policy rejects the arguments', () => {
		expect(
			isSwarmCommandReadOnly({ command: 'config doctor', args: ['--fix'] }),
		).toBe(false);
	});

	test('false for malformed input', () => {
		for (const bad of [
			undefined,
			null,
			'status',
			42,
			{},
			{ command: 7 },
			{ command: 'status', args: 'x' },
			{ command: 'status', args: [1] },
		]) {
			expect(isSwarmCommandReadOnly(bad)).toBe(false);
		}
	});

	test('every entry of the read-only set is a registered command key', async () => {
		const { COMMAND_REGISTRY } = await import('../../../src/commands/registry');
		for (const key of READ_ONLY_SWARM_COMMANDS) {
			expect(Object.hasOwn(COMMAND_REGISTRY, key)).toBe(true);
		}
	});
});
