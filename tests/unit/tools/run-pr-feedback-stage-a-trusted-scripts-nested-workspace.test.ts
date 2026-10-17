import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const BASE_SHA = '2c1f4e8a9b0d3e6f7a8b9c0d1e2f3a4b5c6d7e8f';
const originalReadGitTextAtRevision = _internals.readGitTextAtRevision;
const createdDirs: string[] = [];

afterEach(() => {
	_internals.readGitTextAtRevision = originalReadGitTextAtRevision;
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) removeTreeWithRetry(dir);
	}
});

describe('run-pr-feedback-stage-a trusted compound scripts in nested workspaces (implementation-side, issue #3314)', () => {
	/**
	 * Implementation-side companion to the frozen trusted-scripts checks: the frozen
	 * fixtures are all root-only, so the helper's non-root manifest branch
	 * (`packages/<name>/package.json`) would otherwise ship with zero coverage.
	 * RED before the fix (discovery throws the opaque-script BLOCKED for the nested
	 * workspace), GREEN after; the mismatch leg stays BLOCKED at both ends.
	 */
	test('base-identical compound build script in packages/web is trusted; a differing base text stays BLOCKED', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-nested-');
		createdDirs.push(directory);
		const nestedManifest = `${JSON.stringify(
			{ scripts: { build: 'turbo run build --filter=web && echo done' } },
			null,
			'\t',
		)}\n`;
		fs.mkdirSync(path.join(directory, 'packages', 'web'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'packages', 'web', 'package.json'),
			nestedManifest,
		);
		_internals.readGitTextAtRevision = (
			_directory: string,
			revision: string,
			relativePath: string,
		): string | null =>
			revision === BASE_SHA && relativePath === 'packages/web/package.json'
				? nestedManifest
				: null;

		const trusted = _internals.discoverApplicableStageAObligations(directory, {
			baseRef: 'origin/main',
			baseSha: BASE_SHA,
		});
		expect(trusted).toEqual([
			{
				id: 'build:packages/web:package.json#build',
				category: 'build',
				workingDirectory: 'packages/web',
				source: 'package.json#build',
			},
		]);

		_internals.readGitTextAtRevision = (
			_directory: string,
			revision: string,
			relativePath: string,
		): string | null =>
			revision === BASE_SHA && relativePath === 'packages/web/package.json'
				? `${JSON.stringify(
						{ scripts: { build: 'turbo run build --filter=api && echo done' } },
						null,
						'\t',
					)}\n`
				: null;
		expect(() =>
			_internals.discoverApplicableStageAObligations(directory, {
				baseRef: 'origin/main',
				baseSha: BASE_SHA,
			}),
		).toThrow(
			'Stage A opaque package script packages/web/package.json#build requires a trusted base-identical contract validator for build',
		);
	});

	test('a base-identical non-string script value stays opaque', () => {
		const directory = canonicalMkdtemp('stage-a-trusted-nonstring-');
		createdDirs.push(directory);
		const nestedManifest = `${JSON.stringify(
			{ scripts: { build: true } },
			null,
			'\t',
		)}\n`;
		fs.mkdirSync(path.join(directory, 'packages', 'web'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'packages', 'web', 'package.json'),
			nestedManifest,
		);
		_internals.readGitTextAtRevision = (
			_directory: string,
			revision: string,
			relativePath: string,
		): string | null =>
			revision === BASE_SHA && relativePath === 'packages/web/package.json'
				? nestedManifest
				: null;
		expect(() =>
			_internals.discoverApplicableStageAObligations(directory, {
				baseRef: 'origin/main',
				baseSha: BASE_SHA,
			}),
		).toThrow(
			'Stage A opaque package script packages/web/package.json#build requires a trusted base-identical contract validator for build',
		);
	});
});
