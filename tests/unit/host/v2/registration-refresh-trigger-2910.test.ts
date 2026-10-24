/**
 * #2910 W3 implementation-phase controls for the config-doctor --fix
 * registration-refresh TRIGGER (the frozen C5
 * registration-reload-2910.test.ts pins the refresh SEAMS; this suite pins
 * the trigger predicate and the production-path leg).
 *
 *  - generic-route trigger: a dispatch through registry key `swarm` whose
 *    arguments canonicalize to `config doctor --fix` fires the refresh
 *    (swarm-command-routing.test.ts:303-306 shows the real generic shape);
 *  - shortcut trigger: the `swarm-config-doctor` registry shortcut fires too;
 *  - read-only commands (`swarm status`, `swarm config`) NEVER trigger;
 *  - error dispatches NEVER trigger: the canonical
 *    `Error executing /swarm …` envelope (executeSwarmCommand's catch arm)
 *    and a safeHook-swallowed handler failure (empty parts + registry
 *    record);
 *  - PRODUCTION PATH: a real on-disk config, the REAL
 *    buildV2RegistrationTables (imported from src/index.ts) as the rebuild
 *    source, and a memory.enabled flip between rebuilds — the second
 *    config-doctor --fix dispatch observes changed tables and reloads BOTH
 *    domains.
 *
 * Sibling suites: registration-refresh-owner-parity-2910.test.ts (owner
 * isolation + v1 parity of the fresh builder).
 *
 * Fakes only (no mock.module); plain-object recording contexts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	clearSwallowedCommandErrorRegistry,
	safeHook,
} from '../../../../src/hooks/utils';
import {
	registerV2AgentsAndCommands,
	registerV2ConfigRebuildSource,
	resetV2OperatorWarningState,
} from '../../../../src/host/v2/agents-commands';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { buildV2RegistrationTables } from '../../../../src/index';
import { clearDeferredWarnings } from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

interface TriggerCtx {
	ctx: unknown;
	commands: RegisteredCommand[];
	prompts: Array<{ sessionID?: string; text?: string }>;
	agentReloads: number;
	commandReloads: number;
}

function makeTriggerCtx(): TriggerCtx {
	const commands: RegisteredCommand[] = [];
	const prompts: Array<{ sessionID?: string; text?: string }> = [];
	const counters = { agentReloads: 0, commandReloads: 0 };
	const registration = { dispose: async () => {} };
	const ctx = {
		agent: {
			transform: async (cb: (editor: unknown) => void) => {
				cb({
					update: (_id: string, fn: (agent: unknown) => void) => {
						fn({});
					},
					remove: () => {},
					list: () => [],
				});
				return registration;
			},
			reload: async () => {
				counters.agentReloads += 1;
			},
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
				return registration;
			},
			reload: async () => {
				counters.commandReloads += 1;
			},
		},
		session: {
			hook: async () => registration,
			prompt: async (input: unknown) => {
				prompts.push(input as { sessionID?: string; text?: string });
			},
		},
	};
	return {
		ctx,
		commands,
		prompts,
		get agentReloads() {
			return counters.agentReloads;
		},
		get commandReloads() {
			return counters.commandReloads;
		},
	};
}

const OK_DOCTOR_PARTS = async (
	_input: unknown,
	output: { parts: unknown[] },
): Promise<void> => {
	output.parts.splice(0, output.parts.length, {
		type: 'text',
		text: 'Config Doctor: all checks passed.',
	});
};

const DOCTOR_TABLE = {
	swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
	'swarm-config-doctor': {
		template: '/swarm config doctor',
		description: 'config doctor shortcut',
	},
};

const tableA = {
	coder_2910: {
		mode: 'subagent',
		prompt: 'You write code (v1).',
		description: 'coder',
		permission: { write: 'allow', edit: 'allow' },
	},
};
const tableB = {
	coder_2910: {
		mode: 'subagent',
		prompt: 'You write code (v2 — config written by a command).',
		description: 'coder',
		permission: { write: 'deny', edit: 'deny' },
	},
};

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	registerV2ConfigRebuildSource(undefined);
	resetV2OperatorWarningState();
	clearSwallowedCommandErrorRegistry();
	clearDeferredWarnings();
	clearV2AgentTransformSurface();
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('#2910 W3 config-doctor --fix refresh trigger', () => {
	test('generic route: /swarm config doctor --fix through key `swarm` fires the refresh', async () => {
		const h = makeTriggerCtx();
		let current = tableA;
		registerV2ConfigRebuildSource(async () => ({
			agentTable: current,
			commandTable: DOCTOR_TABLE,
		}));
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tableA;
				cfg.command = DOCTOR_TABLE;
			},
			'command.execute.before': OK_DOCTOR_PARTS,
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(
			h.ctx as never,
			hooks,
			trackedMkdtemp('v2-2910-trig-generic-'),
			[],
		);
		const generic = h.commands.find((c) => c.name === 'swarm');
		expect(generic).toBeDefined();
		expect(h.agentReloads).toBe(0);

		current = tableB;
		await generic?.execute({
			sessionID: 'trig-generic',
			prompt: { text: 'config doctor --fix' },
		});

		expect(h.agentReloads).toBe(1);
		expect(h.commandReloads).toBe(1);
		// The dispatched handler output was still delivered.
		expect(h.prompts.length).toBe(1);
		expect(h.prompts[0]?.text).toBe('Config Doctor: all checks passed.');
	});

	test('shortcut route: the swarm-config-doctor registry key with --fix fires the refresh', async () => {
		const h = makeTriggerCtx();
		let current = tableA;
		registerV2ConfigRebuildSource(async () => ({
			agentTable: current,
			commandTable: {},
		}));
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tableA;
				cfg.command = DOCTOR_TABLE;
			},
			'command.execute.before': OK_DOCTOR_PARTS,
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(
			h.ctx as never,
			hooks,
			trackedMkdtemp('v2-2910-trig-shortcut-'),
			[],
		);
		const doctor = h.commands.find((c) => c.name === 'swarm-config-doctor');
		expect(doctor).toBeDefined();

		current = tableB;
		await doctor?.execute({
			sessionID: 'trig-shortcut',
			prompt: { text: '--fix' },
		});

		expect(h.agentReloads).toBe(1);
		expect(h.commandReloads).toBe(1);
	});

	test('read-only commands never trigger: swarm status and swarm config dispatch without reloads', async () => {
		const h = makeTriggerCtx();
		let served = 0;
		registerV2ConfigRebuildSource(async () => {
			served += 1;
			return { agentTable: tableB, commandTable: {} };
		});
		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tableA;
				cfg.command = {
					swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
				};
			},
			'command.execute.before': async (
				_input: unknown,
				output: { parts: unknown[] },
			) => {
				output.parts.splice(0, output.parts.length, {
					type: 'text',
					text: 'REAL OUTPUT (read-only)',
				});
			},
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(
			h.ctx as never,
			hooks,
			trackedMkdtemp('v2-2910-trig-readonly-'),
			[],
		);
		const generic = h.commands.find((c) => c.name === 'swarm');
		expect(generic).toBeDefined();

		await generic?.execute({
			sessionID: 'trig-readonly',
			prompt: { text: 'status' },
		});
		await generic?.execute({
			sessionID: 'trig-readonly',
			prompt: { text: 'config' },
		});

		// The dispatches succeeded and delivered, but no reload fired — and no
		// refresh even consulted a rebuild source for read-only commands.
		expect(h.prompts.length).toBe(2);
		expect(h.agentReloads).toBe(0);
		expect(h.commandReloads).toBe(0);
		expect(served).toBe(0);
	});

	test('error dispatches never trigger: canonical error envelope and safeHook-swallowed failure', async () => {
		// (a) The handler RESOLVED, but with the canonical error envelope the
		// repo's own executeSwarmCommand catch arm produces
		// (src/commands/command-dispatch.ts: `Error executing /swarm …`).
		{
			const h = makeTriggerCtx();
			registerV2ConfigRebuildSource(async () => ({
				agentTable: tableB,
				commandTable: {},
			}));
			const hooks = {
				config: async (cfg: Record<string, unknown>) => {
					cfg.agent = tableA;
					cfg.command = DOCTOR_TABLE;
				},
				'command.execute.before': async (
					_input: unknown,
					output: { parts: unknown[] },
				) => {
					output.parts.splice(0, output.parts.length, {
						type: 'text',
						text: 'Error executing /swarm config doctor: disk exploded',
					});
				},
			} as unknown as V1HooksSubset;
			await registerV2AgentsAndCommands(
				h.ctx as never,
				hooks,
				trackedMkdtemp('v2-2910-trig-err-text-'),
				[],
			);
			const generic = h.commands.find((c) => c.name === 'swarm');
			await generic?.execute({
				sessionID: 'trig-err-text',
				prompt: { text: 'config doctor --fix' },
			});
			expect(h.prompts.length).toBe(1);
			expect(h.agentReloads).toBe(0);
			expect(h.commandReloads).toBe(0);
		}
		// (b) Production shape: the handler is safeHook-wrapped and THROWS —
		// empty parts + a swallowed-error registry record; fallback submitted.
		{
			const h = makeTriggerCtx();
			registerV2ConfigRebuildSource(async () => ({
				agentTable: tableB,
				commandTable: {},
			}));
			const throwing = async (): Promise<void> => {
				throw new Error('doctor handler exploded (deliberate)');
			};
			const hooks = {
				config: async (cfg: Record<string, unknown>) => {
					cfg.agent = tableA;
					cfg.command = DOCTOR_TABLE;
				},
				'command.execute.before': safeHook(throwing),
			} as unknown as V1HooksSubset;
			await registerV2AgentsAndCommands(
				h.ctx as never,
				hooks,
				trackedMkdtemp('v2-2910-trig-err-swallow-'),
				[],
			);
			const generic = h.commands.find((c) => c.name === 'swarm');
			await generic?.execute({
				sessionID: 'trig-err-swallow',
				prompt: { text: 'config doctor --fix' },
			});
			// Template fallback was submitted, no reload fired.
			expect(h.prompts.length).toBe(1);
			expect(h.prompts[0]?.text).toBe('/swarm config doctor --fix');
			expect(h.agentReloads).toBe(0);
			expect(h.commandReloads).toBe(0);
		}
	});

	test('production path: real buildV2RegistrationTables + on-disk memory.enabled flip reloads both domains', async () => {
		const dir = trackedMkdtemp('v2-2910-trig-prod-');
		mkdirSync(join(dir, '.opencode'), { recursive: true });
		const configPath = join(dir, '.opencode', 'opencode-swarm.json');
		writeFileSync(configPath, JSON.stringify({ memory: { enabled: false } }));

		// The loader may merge a user-level multi-swarm config, so the
		// architect entry is located generically (bare or *_architect).
		const architectOf = (table: Record<string, unknown>) => {
			const entry = Object.entries(table).find(
				([name]) => name === 'architect' || name.endsWith('_architect'),
			)?.[1] as { permission?: Record<string, string> } | undefined;
			if (entry === undefined) throw new Error('no architect entry in table');
			return entry;
		};

		const h = makeTriggerCtx();
		// Registration snapshot = the REAL fresh builder's first output for
		// BOTH tables (the real command table carries the `swarm` key).
		const tables1 = await buildV2RegistrationTables(dir);
		expect(
			architectOf(tables1.agentTable).permission?.swarm_memory_recall,
		).toBe('deny');

		const hooks = {
			config: async (cfg: Record<string, unknown>) => {
				cfg.agent = tables1.agentTable;
				cfg.command = tables1.commandTable;
			},
			'command.execute.before': OK_DOCTOR_PARTS,
		} as unknown as V1HooksSubset;
		await registerV2AgentsAndCommands(h.ctx as never, hooks, dir, []);
		registerV2ConfigRebuildSource(buildV2RegistrationTables);
		const generic = h.commands.find((c) => c.name === 'swarm');
		expect(generic).toBeDefined();

		// Disk unchanged: the real rebuild observes the SAME tables — no churn.
		await generic?.execute({
			sessionID: 'trig-prod',
			prompt: { text: 'config doctor --fix' },
		});
		expect(h.agentReloads).toBe(0);
		expect(h.commandReloads).toBe(0);

		// A config-writing doctor flipped the opt-in on disk.
		writeFileSync(configPath, JSON.stringify({ memory: { enabled: true } }));
		await generic?.execute({
			sessionID: 'trig-prod',
			prompt: { text: 'config doctor --fix' },
		});
		expect(h.agentReloads).toBe(1);
		expect(h.commandReloads).toBe(1);

		// And the fresh builder really dropped the deny for the new state.
		const tables2 = await buildV2RegistrationTables(dir);
		expect(
			architectOf(tables2.agentTable).permission?.swarm_memory_recall,
		).not.toBe('deny');
	}, 60_000);
});
