import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

describe('delegation-gate acceptance auto-injection', () => {
	let directory = '';
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const SESSION_ID = 'test-session-autoinject';

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		directory = await mkdtemp(join(tmpdir(), 'swarm-autoinject-test-'));
		await mkdir(join(directory, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		resetSwarmState();
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	test('auto-injects ACCEPTANCE requirement block when missing in reviewer dispatch', async () => {
		ensureAgentSession(SESSION_ID, 'architect', directory);
		const delegationGate = createDelegationGateHook(
			makeConfig({ hooks: { auto_inject_acceptance: true } }),
			directory,
		);

		const args = {
			subagent_type: 'coder',
			prompt: 'Implement the feature on branch feat/xyz',
		};

		try {
			await delegationGate.toolBefore(
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'coder-call-1' },
				{ args },
			);
		} catch (e: any) {
			// Expected SCOPE_NOT_DECLARED because no plan was written, but acceptance check passed!
		}

		// args.prompt should have had an ACCEPTANCE block appended by the auto-injection
		expect(args.prompt).toContain('ACCEPTANCE:');
		expect(args.prompt).toContain('Complete verification of changes, tests, and documentation');
	});

	test('auto-populates ACCEPTANCE requirement block when empty in reviewer dispatch', async () => {
		ensureAgentSession(SESSION_ID, 'architect', directory);
		const delegationGate = createDelegationGateHook(
			makeConfig({ hooks: { auto_inject_acceptance: true } }),
			directory,
		);

		const args = {
			subagent_type: 'reviewer',
			prompt: 'Review the changes\nACCEPTANCE:\n',
		};

		await expect(
			delegationGate.toolBefore(
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'reviewer-call-2' },
				{ args },
			),
		).resolves.toBeUndefined();

		expect(args.prompt).toContain('ACCEPTANCE:\n- Complete verification of changes, tests, and documentation');
	});
});
