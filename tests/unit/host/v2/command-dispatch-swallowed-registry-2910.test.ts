/**
 * #2910 W6 implementation-phase control for the safeHook swallowed-command-
 * error registry (#3318 AC6): the STALE-ENTRY control the frozen checks do
 * not carry — a prior run's unread registry entry must not poison a FRESH
 * dispatch, and the production cleanup path must empty the registry.
 *
 *  - Stale-entry control: seed the registry with an unread entry for
 *    (sessionID, command), then run a dispatch for the SAME pair whose
 *    safeHook-wrapped handler RESOLVES with real output (non-empty parts).
 *    The dispatch must use the handler's output (never the fallback), record
 *    NO warning naming the command, and leave the seeded entry untouched
 *    (read-once consumption belongs to a real empty-parts consult only).
 *  - Production-cleanup proof: after the v2 setup cleanup runs, the registry
 *    is empty (clearSwallowedCommandErrorRegistry wiring in setup.ts).
 *
 * Fakes only (no mock.module); the REAL safeHook and the REAL
 * registerV2AgentsAndCommands / openCodeSwarmV2Setup drive both legs.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	clearSwallowedCommandErrorRegistry,
	getLastSwallowedCommandError,
	safeHook,
} from '../../../../src/hooks/utils';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface RecordedPrompt {
	sessionID: string;
	text: string;
}

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

const STALE_SESSION = 'ses-2910-stale';
const STALE_COMMAND = 'swarm-status';
const STALE_MESSAGE = 'stale swallowed failure 2910 (prior run residue)';

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

/** Seed one unread registry entry via the REAL safeHook catch arm. */
async function seedStaleEntry(): Promise<void> {
	const throwingHandler = async (): Promise<void> => {
		throw new Error(STALE_MESSAGE);
	};
	await safeHook(throwingHandler)(
		{
			sessionID: STALE_SESSION,
			command: STALE_COMMAND,
			arguments: '',
		} as never,
		{ parts: [] } as never,
	);
}

afterEach(() => {
	clearSwallowedCommandErrorRegistry();
	clearDeferredWarnings();
	clearV2AgentTransformSurface();
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('#2910 W6 stale-entry control for the swallowed-command-error registry', () => {
	test('an unread stale entry does not warn on or alter a fresh successful dispatch (read-once intact)', async () => {
		clearSwallowedCommandErrorRegistry();
		clearDeferredWarnings();
		await seedStaleEntry();
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			STALE_MESSAGE,
		);
		// Re-seed: the assertion above consumed the entry (read-once) — the
		// control needs the entry PRESENT during the dispatch.
		await seedStaleEntry();

		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
		let hookInvocations = 0;
		// Production shape: the handler is safeHook-wrapped and RESOLVES with
		// real output (non-empty parts) — nothing fails in this dispatch.
		const cleanHandler = async (
			_input: unknown,
			output: { parts: unknown[] },
		): Promise<void> => {
			hookInvocations += 1;
			output.parts.splice(0, output.parts.length, {
				type: 'text',
				text: 'REAL-OUTPUT-2910',
			});
		};

		await registerV2AgentsAndCommands(
			{
				agent: {
					transform: async () => ({ dispose: async () => {} }),
					reload: async () => {},
				},
				command: {
					transform: async (
						cb: (e: { add(d: RegisteredCommand): void }) => void,
					) => {
						cb({
							add(d) {
								commands.push(d);
							},
						});
						return { dispose: async () => {} };
					},
					reload: async () => {},
				},
				session: {
					hook: async () => ({ dispose: async () => {} }),
					prompt: async (input: unknown) => {
						prompts.push(input as RecordedPrompt);
					},
				},
			} as never,
			{
				config: async (cfg: Record<string, unknown>) => {
					cfg.command = {
						'swarm-status': {
							template: '/swarm status',
							description: 'swarm status',
						},
					};
				},
				'command.execute.before': safeHook(cleanHandler),
			} as unknown as V1HooksSubset,
			trackedMkdtemp('v2-2910-stale-'),
			[],
		);

		const status = commands.find((c) => c.name === STALE_COMMAND);
		expect(status).toBeDefined();
		await status?.execute({ sessionID: STALE_SESSION, prompt: { text: '' } });

		// The dispatched prompt was used (never the template fallback).
		expect(hookInvocations).toBe(1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('REAL-OUTPUT-2910');

		// The stale entry produced NO warning naming the command.
		const warnings = getDeferredWarnings();
		expect(warnings.some((w) => w.includes(STALE_COMMAND))).toBe(false);

		// Read-once intact: a non-empty-parts dispatch never consults the
		// registry, so the seeded entry survives untouched for a real consumer.
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			STALE_MESSAGE,
		);
	}, 30_000);
});

describe('#2910 W6 production cleanup empties the swallowed-command-error registry', () => {
	test('after the v2 setup cleanup, a seeded registry entry is gone', async () => {
		clearSwallowedCommandErrorRegistry();
		await seedStaleEntry();
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			STALE_MESSAGE,
		);
		await seedStaleEntry();

		const directory = trackedMkdtemp('v2-2910-cleanup-');
		const registration = { dispose: async () => {} };
		const makeTransform = () => async (_fn: (editor: unknown) => void) =>
			registration;
		const ctx = {
			location: { directory },
			agent: { transform: makeTransform() },
			command: { transform: makeTransform() },
			tool: { transform: makeTransform(), hook: async () => registration },
			session: { hook: async () => registration },
			event: {},
		};
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () =>
				({
					config: (c: Record<string, unknown>) => {
						c.agent = {};
						c.command = {};
					},
					dispose: async () => {},
				}) as never,
		});
		// Still readable before the cleanup (the setup itself must not consume it).
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			STALE_MESSAGE,
		);
		await seedStaleEntry();

		await cleanup();

		// The v2 setup cleanup cleared the registry: nothing left to read.
		expect(
			getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND),
		).toBeUndefined();
	}, 30_000);
});
