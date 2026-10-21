import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { safeRmRecursive } from '../../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

/*
 * Behavioral pins for the two merge-group fast paths in ci.yml's
 * detect-release job. The job's real `run:` script is extracted from the
 * workflow and executed, as GitHub executes it (bash -eo pipefail), against
 * real git fixture repositories shaped like merge-queue groups.
 *
 * is-release: a merge group is cumulative (it carries every queued PR ahead
 * of its head, and GitHub merges all of them when it passes), so the release
 * fast path, which skips every test, must only fire when the group is the
 * release merge alone. A release batched behind a code PR runs the full suite.
 *
 * docs-only: a group whose whole base..head delta stays inside docs/releases/
 * gets the pull-request tier of testing. Any path outside it, a rename out of
 * it, an empty delta, or a git failure must leave it false.
 */

const CI_YML = path.join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);
const BOT = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

function detectScript(): string {
	const workflow = yaml.load(fs.readFileSync(CI_YML, 'utf8')) as any;
	const step = workflow.jobs['detect-release'].steps.find(
		(s: any) => s.id === 'check',
	);
	if (!step?.run) throw new Error('detect-release check step not found');
	return step.run as string;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

interface Identity {
	name: string;
	email: string;
}

const DEV: Identity = { name: 'Dev', email: 'dev@example.com' };

function git(
	cwd: string,
	args: string[],
	author: Identity = DEV,
	committer: Identity = DEV,
): string {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: author.name,
			GIT_AUTHOR_EMAIL: author.email,
			GIT_COMMITTER_NAME: committer.name,
			GIT_COMMITTER_EMAIL: committer.email,
			GIT_CONFIG_NOSYSTEM: '1',
		},
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function write(repo: string, rel: string, content: string): void {
	const abs = path.join(repo, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

function newRepo(): { repo: string; base: string } {
	const repo = canonicalMkdtemp('merge-group-fast-path-');
	roots.push(repo);
	git(repo, ['init', '-q', '-b', 'main']);
	git(repo, ['config', 'commit.gpgsign', 'false']);
	write(repo, 'src/index.ts', 'export {};\n');
	write(repo, 'docs/releases/pending/old.md', 'old fragment\n');
	write(repo, 'package.json', '{"version":"1.0.0"}\n');
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-q', '-m', 'base']);
	return { repo, base: git(repo, ['rev-parse', 'HEAD']) };
}

/** Merge a side branch into main with a GitHub-shaped merge commit. */
function mergePr(
	repo: string,
	pr: number,
	branch: string,
	edit: () => void,
	sideAuthor: Identity = DEV,
	sideSubject = `change on ${branch}`,
): void {
	git(repo, ['checkout', '-q', '-b', branch, 'main']);
	edit();
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-q', '-m', sideSubject], sideAuthor, sideAuthor);
	git(repo, ['checkout', '-q', 'main']);
	git(repo, [
		'merge',
		'-q',
		'--no-ff',
		branch,
		'-m',
		`Merge pull request #${pr} from ZaxbyHub/${branch}`,
	]);
}

function mergeRelease(repo: string, pr: number): void {
	mergePr(
		repo,
		pr,
		'release-please--branches--main--components--opencode-swarm',
		() => {
			write(repo, 'package.json', `{"version":"1.0.${pr}"}\n`);
			write(repo, 'CHANGELOG.md', `## 1.0.${pr}\n`);
		},
		{ name: BOT, email: BOT_EMAIL },
		`chore(main): release 1.0.${pr}`,
	);
}

function squashRelease(repo: string): void {
	write(repo, 'package.json', '{"version":"1.1.0"}\n');
	git(repo, ['add', '-A']);
	git(
		repo,
		['commit', '-q', '-m', 'chore(main): release 1.1.0 (#77)'],
		{ name: BOT, email: BOT_EMAIL },
		{ name: 'GitHub', email: 'noreply@github.com' },
	);
}

function runDetect(
	repo: string,
	baseSha: string,
	headSha = git(repo, ['rev-parse', 'HEAD']),
): Record<string, string> {
	const runnerTemp = canonicalMkdtemp('merge-group-fast-path-runner-');
	roots.push(runnerTemp);
	const outputFile = path.join(runnerTemp, 'github-output');
	fs.writeFileSync(outputFile, '');
	const result = spawnSync(
		'bash',
		['--noprofile', '--norc', '-eo', 'pipefail', '-c', detectScript()],
		{
			cwd: repo,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000,
			env: {
				...process.env,
				EVENT: 'merge_group',
				ACTOR: 'github-merge-queue[bot]',
				BRANCH: '',
				REPOSITORY: 'ZaxbyHub/opencode-swarm',
				HEAD_SHA: headSha,
				BASE_SHA: baseSha,
				GITHUB_WORKSPACE: repo,
				RUNNER_TEMP: runnerTemp,
				GITHUB_OUTPUT: outputFile,
			},
		},
	);
	expect(result.status, result.stderr).toBe(0);
	const outputs: Record<string, string> = {};
	for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return outputs;
}

// GitHub runs this step on ubuntu; the Windows bash on PATH is not a
// dependable stand-in, so the behavioral fixtures run on POSIX hosts only.
const posix = process.platform !== 'win32';

describe('merge-group release fast path is limited to a lone release merge', () => {
	test.skipIf(!posix)('a group that is only the release merge skips', () => {
		const { repo, base } = newRepo();
		mergeRelease(repo, 90);
		expect(runDetect(repo, base)['is-release']).toBe('true');
	});

	test.skipIf(!posix)(
		'a release batched behind a code PR runs the full suite',
		() => {
			const { repo, base } = newRepo();
			mergePr(repo, 91, 'fix-thing', () =>
				write(repo, 'src/index.ts', 'export const x = 1;\n'),
			);
			mergeRelease(repo, 92);
			expect(runDetect(repo, base)['is-release']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'a lone squash-merged release skips; one behind a code PR does not',
		() => {
			const alone = newRepo();
			squashRelease(alone.repo);
			expect(runDetect(alone.repo, alone.base)['is-release']).toBe('true');

			const batched = newRepo();
			mergePr(batched.repo, 93, 'fix-other', () =>
				write(batched.repo, 'src/index.ts', 'export const y = 2;\n'),
			);
			squashRelease(batched.repo);
			expect(runDetect(batched.repo, batched.base)['is-release']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'an unreadable queue base never yields the release skip',
		() => {
			const { repo } = newRepo();
			mergeRelease(repo, 94);
			expect(runDetect(repo, '0'.repeat(40))['is-release']).toBe('false');
			expect(runDetect(repo, '')['is-release']).toBe('false');
		},
	);
});

describe('merge-group docs-only fast path', () => {
	test.skipIf(!posix)(
		'a group touching only docs/releases/ is docs-only',
		() => {
			const { repo, base } = newRepo();
			mergePr(repo, 95, 'chore/release-fragments-1.0.0', () => {
				write(repo, 'docs/releases/v1.0.0.md', 'notes\n');
				write(repo, 'docs/releases/manifests/v1.0.0.json', '{}\n');
				fs.rmSync(path.join(repo, 'docs/releases/pending/old.md'));
			});
			const out = runDetect(repo, base);
			expect(out['docs-only']).toBe('true');
			expect(out['is-release']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'any path outside docs/releases/ in the group disables it',
		() => {
			const { repo, base } = newRepo();
			mergePr(repo, 96, 'chore/release-fragments-1.0.1', () =>
				write(repo, 'docs/releases/v1.0.1.md', 'notes\n'),
			);
			mergePr(repo, 97, 'fix-code', () =>
				write(repo, 'src/index.ts', 'export const z = 3;\n'),
			);
			expect(runDetect(repo, base)['docs-only']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'lookalike prefixes outside the directory do not qualify',
		() => {
			const { repo, base } = newRepo();
			mergePr(repo, 98, 'sneaky', () => {
				write(repo, 'docs/releases-extra/x.md', 'x\n');
				write(repo, 'docs/releases.md', 'x\n');
			});
			expect(runDetect(repo, base)['docs-only']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'moving a file out of docs/releases/ is not docs-only',
		() => {
			const { repo, base } = newRepo();
			mergePr(repo, 99, 'move-out', () => {
				git(repo, ['mv', 'docs/releases/pending/old.md', 'src/old.ts']);
			});
			expect(runDetect(repo, base)['docs-only']).toBe('false');
		},
	);

	test.skipIf(!posix)(
		'moving source code into docs/releases/ is not docs-only',
		() => {
			// With rename detection a move reports only its new path, which here
			// sits under docs/releases/ and would hide the deleted source file.
			const { repo, base } = newRepo();
			mergePr(repo, 101, 'move-in', () => {
				git(repo, ['mv', 'src/index.ts', 'docs/releases/index.ts']);
			});
			expect(runDetect(repo, base)['docs-only']).toBe('false');
		},
	);

	test.skipIf(!posix)('an empty delta or a git failure fails closed', () => {
		const { repo, base } = newRepo();
		expect(runDetect(repo, base, base)['docs-only']).toBe('false');
		mergePr(repo, 100, 'docs-only', () =>
			write(repo, 'docs/releases/v1.0.2.md', 'notes\n'),
		);
		expect(runDetect(repo, '0'.repeat(40))['docs-only']).toBe('false');
		expect(runDetect(repo, '')['docs-only']).toBe('false');
	});
});
