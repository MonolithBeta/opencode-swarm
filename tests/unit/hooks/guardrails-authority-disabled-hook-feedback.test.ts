import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type AuthorityConfig,
	GuardrailsConfigSchema,
} from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('authority.enabled=false hard-policy hook coverage (FB-006)', () => {
	let directory = '';
	let cleanup = () => {};

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('authority-disabled-feedback-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		const session = ensureAgentSession('coder-disabled', 'coder', directory);
		session.delegationActive = true;
		swarmState.activeAgent.set('coder-disabled', 'coder');
		beginInvocation('coder-disabled', 'coder');
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('keeps universal, swarm-state, and verifier denies active', async () => {
		const authority: AuthorityConfig = {
			enabled: false,
			universal_deny_prefixes: ['secrets/'],
			verifier_config_paths: ['**/biome.json'],
			rules: { coder: { allowedPrefix: ['src/'] } },
		};
		const hook = createGuardrailsHooks(
			directory,
			GuardrailsConfigSchema.parse({ enabled: true }),
			undefined,
			authority,
		).toolBefore;
		const cases = [
			['secrets/token.txt', 'AUTHORITY_UNIVERSAL_DENY'],
			['.swarm/state.json', 'AUTHORITY_PROTECTED_PATH'],
			['biome.json', 'AUTHORITY_VERIFIER_CONFIG'],
		] as const;
		for (const [filePath, code] of cases) {
			await expect(
				hook(
					{
						tool: 'write',
						sessionID: 'coder-disabled',
						callID: `write-${code}`,
					},
					{ args: { filePath } },
				),
			).rejects.toThrow(code);
		}
	});

	test('allows custom or unknown host agent writes when authority.enabled is false', async () => {
		const authority: AuthorityConfig = {
			enabled: false,
			universal_deny_prefixes: ['secrets/'],
		};
		const hook = createGuardrailsHooks(
			directory,
			GuardrailsConfigSchema.parse({ enabled: true }),
			undefined,
			authority,
		).toolBefore;

		const customSession = ensureAgentSession(
			'sre-session',
			'sre-planner',
			directory,
		);
		customSession.delegationActive = true;
		swarmState.activeAgent.set('sre-session', 'sre-planner');
		beginInvocation('sre-session', 'sre-planner');

		// Unknown / host agent write to regular path succeeds when authority is disabled
		await expect(
			hook(
				{
					tool: 'write',
					sessionID: 'sre-session',
					callID: 'write-sre-test',
				},
				{ args: { filePath: 'tests/unit/test_smart_router.py' } },
			),
		).resolves.toBeUndefined();

		// Universal deny still protects secrets even when authority is disabled
		await expect(
			hook(
				{
					tool: 'write',
					sessionID: 'sre-session',
					callID: 'write-sre-secret',
				},
				{ args: { filePath: 'secrets/token.txt' } },
			),
		).rejects.toThrow('AUTHORITY_UNIVERSAL_DENY');
	});

	test('checkFileAuthority allows custom agent when authority is disabled or configured in rules', () => {
		const {
			checkFileAuthority,
		} = require('../../../src/hooks/guardrails/file-authority');

		// 1. When authority is disabled, unknown agents are allowed for normal paths
		const disabledResult = checkFileAuthority(
			'sre-planner',
			'tests/unit/test.py',
			directory,
			{
				enabled: false,
			},
		);
		expect(disabledResult.allowed).toBe(true);

		// 2. When authority is enabled, configured custom agent in rules is allowed
		const configuredResult = checkFileAuthority(
			'builder',
			'src/file.py',
			directory,
			{
				enabled: true,
				rules: { builder: {} },
			},
		);
		expect(configuredResult.allowed).toBe(true);

		// 3. When authority is enabled, unconfigured custom agent is denied with AUTHORITY_UNKNOWN_AGENT
		const unknownResult = checkFileAuthority(
			'builder',
			'src/file.py',
			directory,
			{
				enabled: true,
			},
		);
		expect(unknownResult.allowed).toBe(false);
		expect(unknownResult.code).toBe('AUTHORITY_UNKNOWN_AGENT');
	});
});
