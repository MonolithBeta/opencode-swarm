/**
 * Supplementary test for issue #3317 (not frozen, critic-recommended): AC3's
 * wording says the reader KILLS the child that exceeds its timeout. C3 proves
 * the event loop stays live and the result is ETIMEDOUT, but a 5 s sleeper can
 * outlive the 300 ms result unnoticed. This test pins pid-liveness: the child
 * writes its own pid to a file, and after the read resolves ETIMEDOUT the pid
 * must be gone (ESRCH) within a bounded settle window.
 *
 * GREEN only after the fix (the module does not exist at base).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitStatusReadInternals } from '../../../src/commands/git-status-read';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalResolveExecutable = gitStatusReadInternals.resolveExecutable;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	gitStatusReadInternals.resolveExecutable = originalResolveExecutable;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function pidIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ESRCH';
	}
}

describe('git-status reader kills the timed-out child (#3317 supplement)', () => {
	test('after an ETIMEDOUT read the sleeping child is actually killed', async () => {
		const cwd = canonicalMkdtemp('3317-kill-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;
		const pidFile = path.join(cwd, 'child.pid');
		const args = [
			'-e',
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise((r) => setTimeout(r, 30000));`,
		];

		// The deadline must exceed cold-start so the child announces itself
		// BEFORE the kill (PRR-021: measured pid write at 586-1984 ms; a
		// 300 ms deadline raced it and threw ENOENT instead of asserting).
		const result = await gitStatusReadInternals.readOnce(args, cwd, 5000);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ETIMEDOUT');
		}

		// The child must have announced itself before the kill landed.
		const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
		expect(Number.isInteger(pid)).toBe(true);

		// Bounded settle: the SIGKILL was issued synchronously in the read's
		// finally, but process teardown can lag a few milliseconds.
		let gone = false;
		for (let i = 0; i < 40 && !gone; i++) {
			gone = pidIsGone(pid);
			if (!gone) await new Promise((r) => setTimeout(r, 50));
		}
		expect(gone).toBe(true);
	}, 30_000);
});
