/**
 * Supplementary failure-class coverage for the #3317 reader (PR-feedback
 * round PRR-002/005/006/009 fixes): pins the classes that gained new
 * branches and had zero tests — EOUTPUT (bound overflow), ESIGNAL
 * (terminated child), ENOENT-after-await (Node-runtime async spawnError),
 * the end-to-end deadline covering executable resolution, and the
 * consumer-side cause arms (close gate + shared rollback/checkpoint
 * descriptor).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleCloseCommand } from '../../../src/commands/close/orchestrator';
import {
	type GitStatusReadResult,
	gitStatusReadInternals,
	readGitStatusAsync,
} from '../../../src/commands/git-status-read';
import { describeUnreadableCause } from '../../../src/commands/rollback-gate';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalResolveExecutable = gitStatusReadInternals.resolveExecutable;
const originalSpawn = gitStatusReadInternals.spawn;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	gitStatusReadInternals.resolveExecutable = originalResolveExecutable;
	gitStatusReadInternals.spawn = originalSpawn;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function stubSpawnResult(overrides: {
	exitCode?: number | null;
	spawnError?: Error | null;
}): ReturnType<typeof originalSpawn> {
	return {
		stdout: {
			getReader: () => ({
				read: async () => ({ done: true, value: undefined }),
				releaseLock: () => {},
			}),
		},
		stderr: {
			getReader: () => ({
				read: async () => ({ done: true, value: undefined }),
				releaseLock: () => {},
			}),
		},
		exited: Promise.resolve(overrides.exitCode ?? 0),
		exitCode: null,
		signalCode: null,
		spawnError: overrides.spawnError ?? null,
		kill() {},
	} as unknown as ReturnType<typeof originalSpawn>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('git-status reader failure classes (#3317 feedback supplement)', () => {
	test('EOUTPUT: bound overflow carries the bound code with a null status (never "exited with status 0")', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-eout-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;
		const result = await readGitStatusAsync(
			[
				'-e',
				"const b = Buffer.alloc(64 * 1024, 120); for (let i = 0; i < 4; i++) require('node:fs').writeSync(1, b);",
			],
			cwd,
			{ timeoutMs: 20_000, maxBufferBytes: 16 * 1024 },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('EOUTPUT');
			expect(result.status).toBeNull();
			expect(result.stderrTail).toContain('exceeded');
		}
	}, 30_000);

	test('ESIGNAL: a child whose exit resolves the signal sentinel (-1) is classed as terminated, not a nonzero git exit', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-sig-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => 'git';
		gitStatusReadInternals.spawn = (() =>
			stubSpawnResult({ exitCode: -1 })) as typeof gitStatusReadInternals.spawn;
		const result = await readGitStatusAsync(['status'], cwd);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ESIGNAL');
			expect(result.status).toBeNull();
		}
	}, 30_000);

	test('ENOENT-after-await: a spawnError that populates ASYNC (Node-runtime shape) is still classified as ENOENT, not status 1', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-late-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => 'git';
		// The Node fallback populates spawnError from the async 'error' event;
		// model it as a value that is null at spawn time and populated before
		// `exited` settles.
		let lateError: Error | null = null;
		const proc = stubSpawnResult({ exitCode: 1 }) as Record<string, unknown>;
		Object.defineProperty(proc, 'spawnError', {
			get: () => lateError,
			configurable: true,
		});
		proc.exited = (async () => {
			await sleep(30);
			lateError = Object.assign(new Error('spawn ENOENT'), {
				code: 'ENOENT',
			});
			return 1;
		})();
		gitStatusReadInternals.spawn = (() =>
			proc) as unknown as typeof gitStatusReadInternals.spawn;
		const result = await readGitStatusAsync(['status'], cwd);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ENOENT');
			expect(result.status).toBeNull();
		}
	}, 30_000);

	test('the deadline covers executable resolution: a slow resolver exhausts the timeout before any child spawns', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-deadline-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => {
			await sleep(400);
			return process.execPath;
		};
		let spawns = 0;
		gitStatusReadInternals.spawn = (() => {
			spawns += 1;
			return stubSpawnResult({ exitCode: 0 });
		}) as typeof gitStatusReadInternals.spawn;
		const startedAt = performance.now();
		const result = await gitStatusReadInternals.readOnce(['status'], cwd, 80);
		const elapsedMs = performance.now() - startedAt;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ETIMEDOUT');
		}
		expect(spawns).toBe(0);
		// End-to-end bound (post-push automation review): the refusal must
		// arrive near the advertised 80 ms deadline, NOT after the resolver's
		// own 400 ms sleep. Charging resolution against the deadline without
		// racing it (the pre-fix shape) returned at ~400 ms; the race returns
		// at ~80 ms. 300 ms separates the two shapes with wide margins in
		// both directions (timer slack on loaded CI runners).
		expect(elapsedMs).toBeLessThan(300);
	}, 30_000);

	test('close gate renders EOUTPUT and ESIGNAL causes (never the availability or index-repair remedy)', async () => {
		const root = canonicalMkdtemp('3317-fclass-close-');
		tempRoots.push(root);
		fs.mkdirSync(path.join(root, '.git'), { recursive: true });
		fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
		fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });

		const { _closeGateInternals } = await import(
			'../../../src/commands/close/orchestrator'
		);
		const originalRunGit = _closeGateInternals.runGit;
		try {
			_closeGateInternals.runGit = async () =>
				({
					ok: false,
					code: 'EOUTPUT',
					status: null,
					stderrTail: 'output exceeded the 1048576-byte bound',
				}) satisfies GitStatusReadResult;
			const out = await handleCloseCommand(root, []);
			expect(out).toContain('output safety bound');
			expect(out).not.toContain('Ensure git is available');
			expect(out).not.toContain('damaged .git/index');
			expect(out).toContain('Nothing was closed, archived, or destroyed');

			_closeGateInternals.runGit = async () =>
				({
					ok: false,
					code: 'ESIGNAL',
					status: null,
					stderrTail: 'git process was terminated',
				}) satisfies GitStatusReadResult;
			const out2 = await handleCloseCommand(root, []);
			expect(out2).toContain('terminated before it answered');
			expect(out2).not.toContain('failed to spawn');
			expect(out2).not.toContain('Ensure git is available');
		} finally {
			_closeGateInternals.runGit = originalRunGit;
		}
	}, 60_000);

	test('the shared rollback/checkpoint cause descriptor covers every reader class with a matched remedy', () => {
		expect(
			describeUnreadableCause({
				code: 'ETIMEDOUT',
				status: null,
				stderrTail: '',
			}),
		).toContain('timed out');
		expect(
			describeUnreadableCause({
				code: 'EOUTPUT',
				status: null,
				stderrTail: 'output exceeded the 1048576-byte bound',
			}),
		).toContain('safety bound');
		expect(
			describeUnreadableCause({
				code: 'ESIGNAL',
				status: null,
				stderrTail: '',
			}),
		).toContain('terminated before it answered');
		expect(
			describeUnreadableCause({
				code: null,
				status: 128,
				stderrTail: 'fatal: x',
			}),
		).toContain('status 128');
		expect(
			describeUnreadableCause({ code: null, status: null, stderrTail: '' }),
		).toBe('retry, or inspect git status manually');
	});
});
