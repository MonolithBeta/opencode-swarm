/**
 * #3427 (trace 3427-3434-rollback-gate-hardening, check C1): the checkpoint
 * tool's TWO repository probes — the `execute` entry preflight and
 * `saveCheckpointRecord`'s probe inside the mutation lock — ride the shared
 * async reader instead of the local sync gitExec retry chain.
 *
 * Discrimination design: a spawn-slot counter on
 * `checkpoint._internals.resolveGitExecutable` (the call slot every local
 * gitExec spawn passes through) proves ZERO sync spawns on the probe paths,
 * while a counting stub on the reader seam proves the probes actually ran
 * through it. At base the probes were sync (slots >= 1, reader never called);
 * at head both legs are async (0 slots, reader called).
 *
 * The saveCheckpointRecord leg acquires the mutation lock (run() executes
 * only after acquisition) with the reader stubbed FALSE, which skips the
 * intentional getCurrentSha sync spawn entirely — 0 slots at head, 1 slot at
 * base (the old sync probe). This file covers src/tools/checkpoint.ts; it is
 * the DIFFERENT GUARD the no-sync-spawn ratchet's SCANNED_FILES comment
 * names for checkpoint.ts (the scanner does not model the
 * repository-status seam, and checkpoint.ts intentionally retains sync
 * spawns in its save/restore action bodies).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as realGitStatusRead from '../../../src/commands/git-status-read';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Reader seam: spread the real module, override only the boolean twin this
// suite exercises (the detailed twin has its own classifier tests in
// align-stage-async-probe-3317.test.ts).
let readerIsRepo = false;
let readerCalls = 0;
mock.module('../../../src/commands/git-status-read', () => ({
	...realGitStatusRead,
	readGitRepositoryStatusAsync: async () => {
		readerCalls += 1;
		return readerIsRepo;
	},
}));

const { checkpoint, _internals } = await import(
	'../../../src/tools/checkpoint'
);

const originalResolver = _internals.resolveGitExecutable;
const originalTryAcquireLock = _internals.tryAcquireLock;

let syncSpawnSlots = 0;

function armSlotCounter(): void {
	syncSpawnSlots = 0;
	_internals.resolveGitExecutable = () => {
		syncSpawnSlots += 1;
		return originalResolver();
	};
}

function armReader(isRepo: boolean): void {
	readerIsRepo = isRepo;
	readerCalls = 0;
}

afterEach(() => {
	// Restore only the _internals seams. The git-status-read module mock is a
	// file-scoped fixture (the checkpoint module's import binding captured it
	// at load); calling mock.restore() here would break that binding for the
	// later tests in this file — the suite runs per-file-isolated in CI, so
	// the module mock's file lifetime is the intended scope.
	_internals.resolveGitExecutable = originalResolver;
	_internals.tryAcquireLock = originalTryAcquireLock;
});

describe('execute preflight rides the async reader (#3427 C1)', () => {
	test('list on a non-repo temp dir: zero sync spawn slots, reader called, uniform refusal', async () => {
		const tempDir = canonicalMkdtemp('c1-preflight-');
		try {
			armSlotCounter();
			armReader(false);

			const result = await checkpoint.execute({ action: 'list' }, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe(
				'not a git repository - checkpoint tools require a git repository',
			);
			expect(readerCalls).toBe(1);
			expect(syncSpawnSlots).toBe(0);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe('saveCheckpointRecord probe rides the async reader (#3427 C1)', () => {
	test('acquired lock + reader false: zero sync spawn slots, reader called, record saved without a SHA', async () => {
		const tempDir = canonicalMkdtemp('c1-save-record-');
		try {
			armSlotCounter();
			armReader(false);
			// run() executes only after lock ACQUISITION — supply the full
			// FileLock shape (checkpoint-locking.test.ts convention).
			_internals.tryAcquireLock = (async () => ({
				acquired: true,
				lock: {
					filePath: '.swarm/checkpoints.json',
					agent: 'checkpoint',
					taskId: 'c1-save-record',
					// Static literals: inert fixture fields (the acquired stub
					// short-circuits every expiry check), kept off the raw
					// clock per check:test-clock.
					timestamp: '2026-10-24T00:00:00.000Z',
					expiresAt: 1_800_000_000_000,
					_release: async () => {},
				},
			})) as unknown as typeof _internals.tryAcquireLock;

			const { saveCheckpointRecord } = await import(
				'../../../src/tools/checkpoint'
			);
			const result = await saveCheckpointRecord('c1-probe', tempDir);

			expect(result.success).toBe(true);
			// Reader-false skips getCurrentSha — nothing sync may spawn, and
			// the record ships without a SHA plus the no-restore-target warning.
			expect(result.sha).toBe('');
			expect(result.warning).toContain('no git restore target');
			expect(readerCalls).toBe(1);
			expect(syncSpawnSlots).toBe(0);
			// The record landed in the temp project's checkpoint log.
			expect(
				fs.existsSync(path.join(tempDir, '.swarm', 'checkpoints.json')),
			).toBe(true);
		} finally {
			_internals.tryAcquireLock = originalTryAcquireLock;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
