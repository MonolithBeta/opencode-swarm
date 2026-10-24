/**
 * #3434 (trace 3427-3434-rollback-gate-hardening, check C5): both porcelain
 * parsers exclude `../`-bearing records from the destroy-scope set and
 * surface them as a diagnostic instead of joining them into the
 * confirm-token scope digest unvalidated.
 *
 * Coverage: both parsers (NUL form rollback-gate.ts, newline form
 * destructive-purge.ts) at the API level, plus the production surfaces —
 * measureGitDestruction's excludedOutOfRoot + filtered dirtyRelPaths, the
 * /swarm rollback preview text (dirty + all-excluded clean-tree cases, via
 * the real handleRollbackCommand with a seeded checkpoint log), and the
 * close gate result field (through the close gate's own runGit seam).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _closeGateInternals } from '../../../src/commands/close/orchestrator';
import {
	parseTrackedDirtyPaths as parseNewline,
	parseTrackedDirtyPathsWithExclusions as parseNewlineWithExclusions,
} from '../../../src/commands/destructive-purge';
import { handleRollbackCommand } from '../../../src/commands/rollback';
import {
	_rollbackGateInternals,
	isOutOfRootRelativePath,
	measureGitDestruction,
	parseTrackedDirtyPaths as parseNul,
	parseTrackedDirtyPathsWithExclusions as parseNulWithExclusions,
} from '../../../src/commands/rollback-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalRunGit = _rollbackGateInternals.runGit;
const originalRunGitBuffered = _rollbackGateInternals.runGitBuffered;
const originalCloseRunGit = _closeGateInternals.runGit;

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = canonicalMkdtemp('c5-repo-');
	tempRoots.push(root);
	// CI runners carry no git user config — pass identity inline so the
	// empty commit exists everywhere.
	execSync('git -c init.defaultBranch=main init -q', { cwd: root });
	execSync(
		'git -c user.name=swarm-test -c user.email=swarm-test@example.com commit -q --allow-empty -m init',
		{ cwd: root },
	);
	return root;
}

function seedCheckpoint(root: string, label: string): void {
	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'checkpoints.json'),
		JSON.stringify({
			version: 1,
			checkpoints: [
				{ label, sha: 'HEAD', timestamp: '2026-10-24T00:00:00.000Z' },
			],
		}),
	);
}

function stubRollbackStatus(statusOutput: string): void {
	_rollbackGateInternals.runGit = (async () => ({
		ok: true as const,
		stdout: statusOutput,
	})) as unknown as typeof _rollbackGateInternals.runGit;
	_rollbackGateInternals.runGitBuffered = (async () => ({
		ok: true as const,
		stdout: '',
	})) as unknown as typeof _rollbackGateInternals.runGitBuffered;
}

afterEach(() => {
	_rollbackGateInternals.runGit = originalRunGit;
	_rollbackGateInternals.runGitBuffered = originalRunGitBuffered;
	_closeGateInternals.runGit = originalCloseRunGit;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('containment predicate', () => {
	test('out-of-root and absolute forms are rejected; in-root forms pass', () => {
		expect(isOutOfRootRelativePath('../outside.txt')).toBe(true);
		expect(isOutOfRootRelativePath('a/../../outside.txt')).toBe(true);
		expect(isOutOfRootRelativePath('/abs/path.txt')).toBe(true);
		expect(isOutOfRootRelativePath('..')).toBe(true);
		expect(isOutOfRootRelativePath('src/file.ts')).toBe(false);
		expect(isOutOfRootRelativePath('a/b/../c.txt')).toBe(false);
	});
});

describe('NUL parser (rollback-gate) excludes out-of-root records (#3434 C5)', () => {
	test('dirty ../-bearing record excluded and surfaced; in-root record kept', () => {
		const result = parseNulWithExclusions(
			'M  src/kept.ts\0M  ../outside.txt\0',
		);
		expect(result.dirtyPaths).toEqual(['src/kept.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../outside.txt']);
	});

	test('rename record with an out-of-root ORIG side excludes only that side', () => {
		const result = parseNulWithExclusions('R  src/new.ts\0../evil-old.txt\0');
		expect(result.dirtyPaths).toEqual(['src/new.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../evil-old.txt']);
	});

	test('legacy string[] export returns only in-root paths', () => {
		expect(parseNul('M  src/kept.ts\0M  ../outside.txt\0')).toEqual([
			'src/kept.ts',
		]);
	});
});

describe('newline parser (destructive-purge) excludes out-of-root records (#3434 C5)', () => {
	test('dirty ../-bearing record excluded and surfaced; in-root record kept', () => {
		const result = parseNewlineWithExclusions(
			'M  src/kept.ts\nM  ../outside.txt\n',
		);
		expect(result.dirtyPaths).toEqual(['src/kept.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../outside.txt']);
	});

	test('rename record with an out-of-root side excludes only that side', () => {
		const result = parseNewlineWithExclusions(
			'R  ../evil-old.txt -> src/new.ts\n',
		);
		expect(result.dirtyPaths).toEqual(['src/new.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../evil-old.txt']);
	});

	test('legacy string[] export returns only in-root paths', () => {
		expect(parseNewline('M  src/kept.ts\nM  ../outside.txt\n')).toEqual([
			'src/kept.ts',
		]);
	});
});

describe('measureGitDestruction surfaces exclusions and filters the scope (#3434 C5)', () => {
	test('mixed dirty set: ../-bearing record excluded from dirtyRelPaths, carried on the result', async () => {
		const root = makeRepo();
		stubRollbackStatus('M  src/kept.ts\0M  ../outside.txt\0');

		const measurement = await measureGitDestruction(root, 'HEAD');

		expect(measurement.kind).toBe('ok');
		if (measurement.kind === 'ok') {
			expect(measurement.dirtyRelPaths).toEqual(['src/kept.ts']);
			expect(measurement.excludedOutOfRoot).toEqual(['../outside.txt']);
		}
	});
});

describe('production diagnostic surfaces (#3434 C5)', () => {
	test('rollback preview carries the bounded exclusion line on the dirty path', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-preview');
		stubRollbackStatus('M  src/kept.ts\0M  ../outside.txt\0');

		const text = await handleRollbackCommand(root, ['c5-preview']);

		expect(text).toContain('DESTROY 1 uncommitted tracked file(s)');
		expect(text).toContain('src/kept.ts');
		expect(text).toContain(
			'1 out-of-root porcelain record(s) were excluded from this scope',
		);
		// The excluded path never enters the preview's file list.
		expect(text).not.toContain('  - ../outside.txt');
	});

	test('rollback all-excluded clean-tree restore still surfaces the exclusion', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-clean');
		stubRollbackStatus('M  ../outside.txt\0');

		const text = await handleRollbackCommand(root, ['c5-clean']);

		// Every dirty record was excluded — the clean-tree branch restored
		// (reset --hard HEAD on the temp repo), and the diagnostic rides the
		// response instead of being silently dropped.
		expect(text).toContain(
			'1 out-of-root porcelain record(s) were excluded from this scope',
		);
	});

	test('close gate result carries excludedOutOfRoot through its own runGit seam', async () => {
		const root = makeRepo();
		const swarmDir = path.join(root, '.swarm');
		_closeGateInternals.runGit = (async () => ({
			ok: true as const,
			stdout: 'M  src/kept.ts\nM  ../outside.txt\n',
		})) as unknown as typeof _closeGateInternals.runGit;

		const { evaluateClosePurgeGate } = await import(
			'../../../src/commands/close/orchestrator'
		);
		const gate = await evaluateClosePurgeGate(root, swarmDir);

		expect(gate.dirtyPaths).toEqual(['src/kept.ts']);
		expect(gate.excludedOutOfRoot).toEqual(['../outside.txt']);
		expect(gate.wouldDestroyTrackedWork).toBe(true);
	});
});
