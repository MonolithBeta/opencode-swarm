import { describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
	canonicalizeWindowsPathPublic as canonicalize,
	clearGuardrailsCaches,
	getLinkedGitWorktrees,
} from '../../../src/hooks/guardrails/file-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Windows-CI regression pins for the worktree-containment fix (issue #3368
 * feedback round 2): on GitHub windows-latest runners the temp root is
 * reported in 8.3 short-name form (C:\Users\RUNNER~1\...) while git's
 * porcelain reports long-form (runneradmin) roots — the plain JS realpath
 * does not expand short names, so lexical containment matching rejected
 * every real linked worktree. These tests pin the native canonicalization
 * that re-unifies the two forms.
 */
describe('guardrails worktree short-name canonicalization (win32)', () => {
	it('expands 8.3 short-name segments via native realpath', () => {
		if (process.platform !== 'win32') return;
		const longDir = canonicalMkdtemp('w3368-short-pin-');
		// Ask NTFS for the 8.3 form; skip when short-name creation is disabled
		// on the volume (some runners/disks disable it).
		let shortDir: string | null = null;
		try {
			shortDir = execSync(`cmd /c for %A in ("${longDir}") do @echo %~sA`, {
				encoding: 'utf8',
			}).trim();
		} catch {
			shortDir = null;
		}
		if (!shortDir || shortDir === longDir || !shortDir.includes('~')) return;

		expect(shortDir).not.toBe(longDir);
		const canonical = canonicalize(shortDir);
		// The canonical form must not retain any 8.3 segment and must name the
		// same directory as the long form.
		expect(canonical.includes('~')).toBe(false);
		expect(fsSync.realpathSync(canonical)).toBe(fsSync.realpathSync(longDir));
		fsSync.rmSync(longDir, { recursive: true, force: true });
	});

	it('returns long-form (no 8.3 tilde segments) worktree roots on win32', () => {
		if (process.platform !== 'win32') return;
		const sandboxDir = canonicalMkdtemp('w3368-roots-');
		const mainRepoDir = path.join(sandboxDir, 'main-repo');
		fsSync.mkdirSync(mainRepoDir, { recursive: true });
		const g = (a: string) =>
			execSync(`git ${a}`, { cwd: mainRepoDir, stdio: 'pipe' });
		g('init -b main');
		g('config user.name "Test"');
		g('config user.email "test@example.com"');
		g('commit --allow-empty -m "initial commit"');
		const linkedDir = path.join(sandboxDir, 'linked');
		g(`worktree add "${linkedDir}" -b feat/linked`);
		clearGuardrailsCaches();
		const roots = getLinkedGitWorktrees(mainRepoDir);
		// Whatever form the caller's cwd used, the discovered roots must not
		// carry 8.3 segments (the porcelain is canonicalized through
		// realpathSync.native), so later lexical matching against long-form
		// caller paths is coherent.
		for (const root of roots) {
			expect(
				root.split(path.sep).some((segment) => segment.includes('~')),
			).toBe(false);
		}
		fsSync.rmSync(sandboxDir, { recursive: true, force: true });
	});
});
