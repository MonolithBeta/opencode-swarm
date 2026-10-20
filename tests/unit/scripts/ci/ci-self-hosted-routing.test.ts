import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

/*
 * Security invariant for the self-hosted runner routing (issue #3404).
 *
 * `ZaxbyHub/opencode-swarm` is public and accepts fork PRs, and CI executes
 * PR-head code. Routing a `pull_request` job to a self-hosted runner would
 * therefore hand arbitrary code execution on that machine to anyone able to
 * open a fork PR. The routing is expressed per job as
 *
 *   runs-on: ${{ github.event_name == 'merge_group' && 'self-hosted' || 'ubuntu-latest' }}
 *
 * so one job definition keeps its untrusted leg on GitHub-hosted runners and
 * only its trusted merge-queue leg on the runner. These tests pin that split:
 * a future edit that makes a pull_request-triggered job run unconditionally on
 * `self-hosted`, or that gives an untrusted workflow an unconditional runner,
 * fails here instead of silently widening the trust boundary.
 *
 * The merge_group residual risk is accepted by the maintainer and documented in
 * docs/releases/pending/ci-self-hosted-runner-routing.md; it is not re-litigated
 * here. What IS pinned is that the untrusted leg never touches the runner.
 */

const WORKFLOWS_DIR = join(import.meta.dir, '../../../../.github/workflows');

function readWorkflow(name: string): string {
	return readFileSync(join(WORKFLOWS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

function parseWorkflow(name: string): any {
	return yaml.load(readWorkflow(name)) as any;
}

/** Every event name a workflow declares, normalizing scalar/array/null forms. */
function declaredEvents(workflow: any): string[] {
	const on = workflow?.on ?? workflow?.[true];
	if (!on) return [];
	if (typeof on === 'string') return [on];
	if (Array.isArray(on)) return on.map(String);
	if (typeof on === 'object') return Object.keys(on);
	return [];
}

/** The `runs-on` value of a job, as a raw string (or '' when absent). */
function runsOnOf(job: any): string {
	const runsOn = job?.['runs-on'];
	if (typeof runsOn === 'string') return runsOn;
	if (Array.isArray(runsOn)) return runsOn.join(', ');
	return '';
}

const SELF_HOSTED = 'self-hosted';

/** True when the runs-on value can resolve to the self-hosted runner. */
function canUseSelfHosted(runsOn: string): boolean {
	return runsOn.includes(SELF_HOSTED);
}

/** True when the runs-on value is gated on the merge_group event. */
function isMergeGroupGated(runsOn: string): boolean {
	return runsOn.includes("github.event_name == 'merge_group'");
}

/** True when the runs-on value can resolve to a GitHub-hosted label. */
function canUseGitHubHosted(runsOn: string): boolean {
	return /ubuntu-latest|windows-latest|macos-latest/.test(runsOn);
}

/*
 * The two sanctioned spellings, pinned exactly. A pull_request-triggered job
 * may reach the runner ONLY through one of these; anything else — including a
 * plausible-looking inversion such as
 * `merge_group && 'ubuntu-latest' || 'self-hosted'`, which keeps a
 * GitHub-hosted label reachable but puts the RUNNER on the untrusted leg — is
 * rejected. Adding a third shape must be a deliberate edit here.
 */
const SANCTIONED_ROUTER_SHAPES: RegExp[] = [
	/github\.event_name == 'merge_group' && 'self-hosted' \|\| 'ubuntu-latest'/,
	/github\.event_name == 'pull_request' && 'ubuntu-latest' \|\| 'self-hosted'/,
];

function usesSanctionedRouterShape(runsOn: string): boolean {
	return SANCTIONED_ROUTER_SHAPES.some((shape) => shape.test(runsOn));
}

describe('self-hosted runner routing — security invariant (issue #3404)', () => {
	// Workflows that legitimately run on the runner unconditionally. Each one
	// MUST NOT declare a pull_request trigger, or the untrusted-code boundary
	// would be crossed.
	const RUNNER_ONLY_WORKFLOWS = [
		'release-and-publish.yml',
		'stale.yml',
		'quarantine-aging.yml',
	];

	// Workflows whose jobs may use the runner only on the merge_group leg.
	const PER_EVENT_WORKFLOWS = ['ci.yml', 'host-contract-check.yml'];

	test('no pull_request-triggered job anywhere runs unconditionally on the runner', () => {
		// The load-bearing assertion. Sweeps every workflow in the directory so
		// a NEW workflow added later is covered without editing this test.
		const fs = require('node:fs') as typeof import('node:fs');
		const offenders: string[] = [];
		for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
			if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
			let workflow: any;
			try {
				workflow = yaml.load(readWorkflow(file)) as any;
			} catch {
				continue; // unparseable workflows are covered by their own guards
			}
			const events = declaredEvents(workflow);
			if (!events.includes('pull_request')) continue;
			for (const [jobName, job] of Object.entries<any>(workflow?.jobs ?? {})) {
				const runsOn = runsOnOf(job);
				if (canUseSelfHosted(runsOn) && !usesSanctionedRouterShape(runsOn)) {
					offenders.push(`${file}:${jobName} -> ${runsOn}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('every workflow that runs on the runner declares no pull_request trigger', () => {
		for (const file of RUNNER_ONLY_WORKFLOWS) {
			const workflow = parseWorkflow(file);
			const events = declaredEvents(workflow);
			expect(events, `${file} must not run on pull_request`).not.toContain(
				'pull_request',
			);
			const jobs = Object.entries<any>(workflow.jobs ?? {});
			expect(jobs.length, `${file} has jobs`).toBeGreaterThan(0);
			// Non-vacuity: the workflow really is runner-routed. Not every job
			// must be (release-and-publish.yml keeps its multi-OS sandbox-runner
			// matrix on GitHub-hosted runners), but at least one must be.
			const runnerJobs = jobs.filter(([, job]) =>
				canUseSelfHosted(runsOnOf(job)),
			);
			expect(
				runnerJobs.length,
				`${file} routes at least one job to the runner`,
			).toBeGreaterThan(0);
			// Every runner-routed job here is unconditional, which is only safe
			// because the workflow never fires on an untrusted event.
			for (const [jobName, job] of runnerJobs) {
				expect(
					isMergeGroupGated(runsOnOf(job)),
					`${file}:${jobName} routes unconditionally`,
				).toBe(false);
			}
		}
	});

	test('per-event routing keeps a GitHub-hosted leg for the untrusted event', () => {
		// Both branches must exist: the runner leg is gated on the event name and
		// a GitHub-hosted label is reachable, so pull_request still runs somewhere.
		// The expression shape differs per workflow — ci.yml gates the runner on
		// merge_group, host-contract-check.yml gates the GitHub-hosted leg on
		// pull_request — so the pinned property is the event-gated expression plus
		// a reachable GitHub-hosted label, not one particular spelling.
		for (const file of PER_EVENT_WORKFLOWS) {
			const workflow = parseWorkflow(file);
			expect(declaredEvents(workflow)).toContain('pull_request');
			for (const [jobName, job] of Object.entries<any>(workflow.jobs ?? {})) {
				const runsOn = runsOnOf(job);
				if (!canUseSelfHosted(runsOn)) continue;
				expect(
					runsOn.includes('github.event_name'),
					`${file}:${jobName} gates the runner behind an event expression`,
				).toBe(true);
				expect(
					canUseGitHubHosted(runsOn),
					`${file}:${jobName} keeps a GitHub-hosted leg`,
				).toBe(true);
			}
		}
	});

	test('host-contract-check routes pull_request to GitHub-hosted, not the runner', () => {
		// Inverted expression shape (`pull_request && 'ubuntu-latest' || …`): the
		// untrusted leg is the one that must stay on GitHub-hosted runners.
		const runsOn = runsOnOf(
			parseWorkflow('host-contract-check.yml').jobs?.check,
		);
		expect(runsOn).toContain("github.event_name == 'pull_request'");
		expect(runsOn).toContain('ubuntu-latest');
	});

	test('the runner-routed ci.yml jobs are the declared set', () => {
		// Guards the migration's scope: only the four heavy single-OS jobs move.
		// A new runner-routed job in ci.yml must be a deliberate edit here.
		const jobs = Object.entries<any>(parseWorkflow('ci.yml').jobs ?? {});
		const routed = jobs
			.filter(([, job]) => canUseSelfHosted(runsOnOf(job)))
			.map(([name]) => name)
			.sort();
		expect(routed).toEqual([
			'coverage-shard',
			'package-check',
			'quality',
			'security',
		]);
	});

	test('per-OS matrix jobs and the Windows sandbox runner stay GitHub-hosted', () => {
		// One Linux runner cannot serve a three-OS matrix, and the sandbox
		// runner is built for Windows. Moving either would deadlock them.
		const jobs = Object.entries<any>(parseWorkflow('ci.yml').jobs ?? {});
		for (const name of ['unit', 'memory-recall-regression', 'smoke']) {
			const job = jobs.find(([jobName]) => jobName === name)?.[1];
			expect(job, `ci.yml has a ${name} job`).toBeDefined();
			expect(
				canUseSelfHosted(runsOnOf(job)),
				`${name} stays GitHub-hosted`,
			).toBe(false);
		}
		const sandbox = jobs.find(
			([jobName]) => jobName === 'rust-sandbox-runner',
		)?.[1];
		expect(sandbox, 'ci.yml has a rust-sandbox-runner job').toBeDefined();
		expect(runsOnOf(sandbox)).toContain('windows-latest');
	});
});
