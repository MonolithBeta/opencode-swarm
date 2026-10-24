/**
 * #2910 W3 implementation-phase controls — the OWNER-ISOLATION and V1-PARITY
 * legs of the registration-refresh work (split from
 * registration-refresh-trigger-2910.test.ts for the 500-line test-file cap;
 * the trigger predicate + production-path legs live there).
 *
 *  - owner isolation (rebuild source): owner A's detach leaves owner B's
 *    source serving the refresh — one instance's cleanup never removes a
 *    concurrent live instance's entry;
 *  - owner isolation (quiet): a setup instance whose config sets quiet=true
 *    keeps its quiet flag through ANOTHER instance's cleanup;
 *  - v1 parity: buildV2RegistrationTables' agent table equals the REAL
 *    getAgentConfigs output for the same on-disk config (key set + mode +
 *    permission blocks) — the same table the v1 config hook merges.
 *
 * Fakes only (no mock.module); plain-object recording contexts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentConfigs } from '../../../../src/agents';
import { loadPluginConfigWithMetaAsync } from '../../../../src/config/loader';
import { clearSwallowedCommandErrorRegistry } from '../../../../src/hooks/utils';
import {
	deferredV2RefreshRegistrations,
	registerV2ConfigRebuildSourceForOwner,
	resetV2OperatorWarningState,
	setV2OperatorQuietForOwner,
} from '../../../../src/host/v2/agents-commands';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { buildV2RegistrationTables } from '../../../../src/index';
import { clearDeferredWarnings } from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface RegisteredCommand {
	name: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

function writeProjectConfig(dir: string, body: Record<string, unknown>): void {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(body),
	);
}

afterEach(() => {
	registerV2ConfigRebuildSourceForOwner('iso-a', undefined);
	registerV2ConfigRebuildSourceForOwner('iso-b', undefined);
	setV2OperatorQuietForOwner('iso-a', undefined);
	setV2OperatorQuietForOwner('iso-b', undefined);
	resetV2OperatorWarningState();
	clearSwallowedCommandErrorRegistry();
	clearDeferredWarnings();
	clearV2AgentTransformSurface();
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('#2910 W3 owner isolation (rebuild source + quiet)', () => {
	test('owner A detach leaves owner B serving: the refresh resolves through B', async () => {
		const served: string[] = [];
		registerV2ConfigRebuildSourceForOwner('iso-a', async () => {
			served.push('a');
			return { agentTable: {}, commandTable: {} };
		});
		registerV2ConfigRebuildSourceForOwner('iso-b', async () => {
			served.push('b');
			return { agentTable: {}, commandTable: {} };
		});
		// A's cleanup: only A's entry is unregistered.
		registerV2ConfigRebuildSourceForOwner('iso-a', undefined);

		const registration = { dispose: async () => {} };
		const ctx = {
			agent: {
				transform: async (cb: (editor: unknown) => void) => {
					cb({});
					return registration;
				},
				reload: async () => {},
			},
			command: {
				transform: async (cb: (editor: unknown) => void) => {
					cb({});
					return registration;
				},
				reload: async () => {},
			},
			session: { hook: async () => registration, prompt: async () => {} },
		};
		await deferredV2RefreshRegistrations(
			ctx as never,
			{ config: async () => {} } as V1HooksSubset,
			trackedMkdtemp('v2-2910-trig-iso-'),
			[],
		);
		expect(served).toEqual(['b']);
	});

	test('quiet isolation: instance A cleanup does not reset live instance B quiet=true', async () => {
		const dirA = trackedMkdtemp('v2-2910-quiet-a-');
		const dirB = trackedMkdtemp('v2-2910-quiet-b-');
		writeProjectConfig(dirA, { quiet: false });
		writeProjectConfig(dirB, { quiet: true });

		const warnTexts: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			if (args.length > 0 && typeof args[0] === 'string')
				warnTexts.push(args[0]);
		};

		const makeQuietCtx = (
			directory: string,
			commands: RegisteredCommand[],
		): Record<string, unknown> => {
			const registration = { dispose: async () => {} };
			const makeTransform = () => async (fn: (editor: unknown) => void) => {
				fn({});
				return registration;
			};
			return {
				location: { directory },
				agent: { transform: makeTransform(), reload: async () => {} },
				command: {
					transform: async (
						fn: (e: { add(d: RegisteredCommand): void }) => void,
					) => {
						fn({
							add(d) {
								commands.push(d);
							},
						});
						return registration;
					},
					reload: async () => {},
				},
				tool: { transform: makeTransform(), hook: async () => registration },
				// Deliberately NO session.prompt: executing a command warns
				// through the operator channel (quiet-gated console.warn).
				session: { hook: async () => registration },
				event: {},
			};
		};

		const commandsA: RegisteredCommand[] = [];
		const commandsB: RegisteredCommand[] = [];
		try {
			// A first (quiet=false): its own warning IS audible.
			const cleanupA = await openCodeSwarmV2Setup(
				makeQuietCtx(dirA, commandsA) as never,
				{
					runInit: async () =>
						({
							config: (c: Record<string, unknown>) => {
								c.agent = {};
								c.command = {
									'swarm-a1': {
										template: '/swarm a1',
										description: 'A probe',
									},
								};
							},
						}) as never,
				},
			);
			await commandsA[0]?.execute({
				sessionID: 'quiet-a',
				prompt: { text: '' },
			});
			expect(warnTexts.some((t) => t.includes('swarm-a1'))).toBe(true);

			// B second (quiet=true, most recent owner): its warning is silent.
			const cleanupB = await openCodeSwarmV2Setup(
				makeQuietCtx(dirB, commandsB) as never,
				{
					runInit: async () =>
						({
							config: (c: Record<string, unknown>) => {
								c.agent = {};
								c.command = {
									'swarm-b1': {
										template: '/swarm b1',
										description: 'B probe 1',
									},
									'swarm-b2': {
										template: '/swarm b2',
										description: 'B probe 2',
									},
								};
							},
						}) as never,
				},
			);
			await commandsB[0]?.execute({
				sessionID: 'quiet-b1',
				prompt: { text: '' },
			});
			expect(warnTexts.some((t) => t.includes('swarm-b1'))).toBe(false);

			// A's cleanup must not reset B's quiet: B's SECOND (distinct)
			// warning stays silent afterwards.
			await cleanupA();
			await commandsB[1]?.execute({
				sessionID: 'quiet-b2',
				prompt: { text: '' },
			});
			expect(warnTexts.some((t) => t.includes('swarm-b2'))).toBe(false);
			await cleanupB();
		} finally {
			console.warn = originalWarn;
		}
	}, 60_000);
});

describe('#2910 W3 v1 parity of the fresh builder', () => {
	test('buildV2RegistrationTables agent table == REAL getAgentConfigs output (key set + mode + permission blocks)', async () => {
		const dir = trackedMkdtemp('v2-2910-parity-');
		writeProjectConfig(dir, {
			memory: { enabled: false },
			tool_filter: { enabled: true },
		});
		const { agentTable } = await buildV2RegistrationTables(dir);
		const loaded = await loadPluginConfigWithMetaAsync(dir);
		// The v1 config hook's agent table IS the getAgentConfigs output
		// (Object.assign verbatim); parity is pinned on key set + mode +
		// permission blocks (auto-review resolution affects prompts, not
		// these fields).
		const expected = getAgentConfigs(loaded.config, dir) as Record<
			string,
			{ mode?: string; permission?: Record<string, unknown> }
		>;
		expect(Object.keys(agentTable).sort()).toEqual(
			Object.keys(expected).sort(),
		);
		for (const [name, entry] of Object.entries(expected)) {
			const fromBuilder = agentTable[name] as {
				mode?: string;
				permission?: Record<string, unknown>;
			};
			expect(
				fromBuilder,
				`agent ${name} present in builder output`,
			).toBeDefined();
			expect(fromBuilder.mode).toBe(entry.mode);
			expect(fromBuilder.permission).toEqual(entry.permission);
		}
	}, 60_000);
});
