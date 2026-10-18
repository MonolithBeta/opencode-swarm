import { describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
	clearGuardrailsCaches,
	getLinkedGitWorktrees,
} from '../../../src/hooks/guardrails/file-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * TEMPORARY CI diagnostic (issue #3368 feedback round) — fails on purpose so
 * the assertion diff carries the full worktree-discovery trace into the CI
 * log on every platform. Remove before merge.
 */
describe('DIAG worktree discovery trace (temporary)', () => {
	it.skipIf(process.platform !== 'win32')('dumps discovery trace', () => {
		const sandboxDir = canonicalMkdtemp('w3368-diag-');
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
		const dotGitFile = fsSync.readFileSync(
			path.join(linkedDir, '.git'),
			'utf8',
		);
		const porcelain = execSync('git worktree list --porcelain', {
			cwd: mainRepoDir,
			encoding: 'utf8',
		});
		clearGuardrailsCaches();
		const trusted = getLinkedGitWorktrees(mainRepoDir);
		const trace = [
			`sandbox=${sandboxDir}`,
			`dotGitFile=${JSON.stringify(dotGitFile)}`,
			`porcelain=${JSON.stringify(porcelain)}`,
			`trusted=${JSON.stringify(trusted)}`,
			`realpathLinked=${fsSync.realpathSync(linkedDir)}`,
			`realpathMainGit=${fsSync.realpathSync(path.join(mainRepoDir, '.git'))}`,
		].join('\n');
		expect(trace).toBe('');
		fsSync.rmSync(sandboxDir, { recursive: true, force: true });
	});
});
