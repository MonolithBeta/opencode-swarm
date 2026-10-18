/**
 * PR #3387 follow-up (pre-existing items FB-027 + FB-029): quote-aware
 * comment stripping in the skill-frontmatter detector, and the user-global
 * shadowing comparison running regardless of the repo-side stamp state.
 * RED at base fd8532c33 (both defects pre-existed there), GREEN after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	_internals,
	detectSkillFrontmatterSpecDrift,
	detectUserGlobalSkillStaleness,
	SKILL_CONTRACT_DIGEST_KEY,
	skillContractDigest,
} from '../../../scripts/drift-check.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];
const originalHome = _internals.resolveUserGlobalHome;

afterEach(() => {
	_internals.resolveUserGlobalHome = originalHome;
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

function makeTree(files: Record<string, string>): string {
	const root = canonicalMkdtemp('fm-followup-3387-');
	tempRoots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const target = join(root, rel);
		mkdirSync(join(target, '..'), { recursive: true });
		writeFileSync(target, content, 'utf-8');
	}
	return root;
}

function makeTempRoot(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	tempRoots.push(root);
	return root;
}

function writeSkill(
	root: string,
	relativePath: string,
	body: string,
	stamp?: string,
): void {
	const full = join(root, relativePath);
	mkdirSync(join(full, '..'), { recursive: true });
	const frontmatter = [
		'---',
		'name: swarm-pr-review',
		'audience: swarm-plugin',
	];
	if (stamp) frontmatter.splice(1, 0, `${SKILL_CONTRACT_DIGEST_KEY}: ${stamp}`);
	writeFileSync(full, `${frontmatter.join('\n')}\n---\n${body}`, 'utf8');
}

describe('detector comment strip is quote-aware (FB-027)', () => {
	test('flow collection with a quoted hash and trailing comment is flagged', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				'  list: [a, "b # c"] # note',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].message).toContain('flow collection');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('apostrophe in a plain flow scalar does not hide the trailing comment (fix-review round 2)', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				"  list: [it's, b] # note",
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].message).toContain('flow collection');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('bare scalar with a trailing comment is still flagged (PRR-011b guard)', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				'  enabled: true # note',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].message).toContain('bare non-string scalar');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('quoted scalar containing a hash with no trailing comment is clean', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				'  note: "a # b"',
				'---',
			].join('\n'),
		});
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('inline metadata value with a quoted hash is still a finding', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata: {note: "a # b", audience: swarm-plugin}',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].message).toContain('carries an inline value');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('user-global shadowing runs regardless of repo stamp state (FB-029)', () => {
	test('stale repo stamp AND stale user-global copy produce BOTH findings', () => {
		const repo = makeTempRoot('f3387-repo-');
		const home = makeTempRoot('f3387-home-');
		const body = '# canonical body\n\nguidance\n';
		writeSkill(
			repo,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			body,
			'000000000000', // stale stamp (body hashes to something else)
		);
		writeSkill(home, '.opencode/skills/swarm-pr-review/SKILL.md', '# stale\n');
		_internals.resolveUserGlobalHome = () => home;

		const findings = detectUserGlobalSkillStaleness(repo);
		const severities = findings.map((f) => f.severity).sort();
		// Pre-fix: only the repo-side stamp warning fired (the shadowing
		// comparison was skipped by the `continue`).
		expect(severities).toEqual(['notice', 'warning']);
	});

	test('missing repo stamp AND stale user-global copy produce BOTH findings', () => {
		const repo = makeTempRoot('f3387-repo-');
		const home = makeTempRoot('f3387-home-');
		writeSkill(repo, '.opencode/skills/swarm-pr-review/SKILL.md', '# body\n');
		writeSkill(home, '.opencode/skills/swarm-pr-review/SKILL.md', '# stale\n');
		_internals.resolveUserGlobalHome = () => home;

		const findings = detectUserGlobalSkillStaleness(repo);
		const severities = findings.map((f) => f.severity).sort();
		expect(severities).toEqual(['notice', 'warning']);
	});

	test('healthy repo stamp with a stale user-global copy still fires notice only', () => {
		const repo = makeTempRoot('f3387-repo-');
		const home = makeTempRoot('f3387-home-');
		const body = '# canonical body\n\nguidance\n';
		writeSkill(
			repo,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			body,
			skillContractDigest(body),
		);
		writeSkill(home, '.opencode/skills/swarm-pr-review/SKILL.md', '# stale\n');
		_internals.resolveUserGlobalHome = () => home;

		const findings = detectUserGlobalSkillStaleness(repo);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('notice');
	});
});
