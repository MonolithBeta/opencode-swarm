/**
 * #2909 durable coverage guardrails for the v1→v2 hook inventory.
 *
 * Two properties, both CI-permanent:
 *  1. Every hook surface the plugin registers (quoted hook keys and structural
 *     registrations in src/index.ts; ctx registration surfaces used by the
 *     src/host/v2 adapter) has a row in docs/host/v2-hook-inventory.md, and
 *     every AGENTS.md invariant-10 contract sentence has a coverage token in
 *     that document (issue #2909 AC1/AC7 — the acceptance census that closed
 *     the slot, kept enforceable after the trace-local frozen checks die with
 *     the git-excluded trace directory).
 *  2. The slot's acceptance evidence artifacts (dual-host spike logs, ADR
 *     appendices, release fragment-or-consumed trail) cannot be silently
 *     deleted (issue #2909 closure contract "add tests for every acceptance
 *     row").
 *
 * Reads files only; no mocks, no tmp, no clock.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const SRC_INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const INVENTORY = path.join(REPO_ROOT, 'docs', 'host', 'v2-hook-inventory.md');
const ADR = path.join(
	REPO_ROOT,
	'docs',
	'decisions',
	'0003-opencode-v2-plugin-api.md',
);
const SPIKE_DIR = path.join(REPO_ROOT, 'spikes', 'v2-dual-shape');

const HOOK_KEY_RE =
	/'(experimental\.[a-zA-Z0-9.]+|tool\.execute\.before|tool\.execute\.after|chat\.message|command\.execute\.before)'/g;

/** The registration surfaces the v2 adapter is allowed to use; mirrors the
 * frozen C7 census (trace 2909) — extend deliberately, never by regex drift. */
const V2_REGISTRATION_SURFACES = [
	'tool.transform',
	'tool.hook',
	'agent.transform',
	'command.transform',
	'session.hook',
	'event.subscribe',
] as const;

/** AGENTS.md invariant-10 contract sentences → acceptable inventory coverage
 * patterns. A superset of the frozen C1 token set (trace 2909). */
const INVARIANT_10_SENTENCE_TOKENS: Array<[string, RegExp]> = [
	['v1 output.system string surface', /output\.system/],
	['multiple output.system entries materialize (v1)', /output\.system/],
	['v1 in-place output mutation rule', /in place|in-place/],
	['v2 in-place event.system/event.messages mutation', /event\.messages/],
	[
		'USER-role carriers via system-guidance-carrier',
		/system-guidance-carrier|swarm-guidance/,
	],
	['carrier re-homing into event.system', /re-home|rehome/],
	['one destination per guidance unit', /one destination/],
	['zero system entries after materialization', /materializ/],
	[
		'event.agent Agent.Info normalization',
		/event\.agent|Agent\.Info|normalized to a name/,
	],
	['chat.params/chat.headers carve-out recorded', /chat\.params/],
	['deliveredGuidanceDelta host-render predicates', /deliveredGuidanceDelta/],
];

describe('hook inventory coverage (#2909 AC1/AC7)', () => {
	const indexSrc = fs.readFileSync(SRC_INDEX, 'utf8');
	const inventory = fs.readFileSync(INVENTORY, 'utf8');

	test('every quoted hook key registered in src/index.ts has an inventory row', () => {
		const keys = [
			...new Set([...indexSrc.matchAll(HOOK_KEY_RE)].map((m) => m[1])),
		];
		// Anti-vacuity: the census must extract the full registration set.
		expect(keys.length).toBeGreaterThanOrEqual(8);
		const missing = keys.filter((k) => !inventory.includes(k));
		expect(missing).toEqual([]);
	});

	test('structural registrations (tool map, event, config, automation) are covered', () => {
		expect(inventory).toContain('buildPluginToolObject');
		expect(inventory).toMatch(/`event` observer/);
		expect(inventory).toMatch(/`config` hook/);
		expect(inventory).toContain('automation:');
	});

	test('every AGENTS.md invariant-10 contract sentence has a coverage token', () => {
		for (const [sentence, pattern] of INVARIANT_10_SENTENCE_TOKENS) {
			expect(
				pattern.test(inventory),
				`invariant-10 sentence uncovered: ${sentence}`,
			).toBe(true);
		}
	});

	test('every v2 ctx registration surface used by the adapter has an inventory row', () => {
		const adapterDir = path.join(REPO_ROOT, 'src', 'host', 'v2');
		const adapterSrc = fs
			.readdirSync(adapterDir)
			.filter((f) => f.endsWith('.ts'))
			.map((f) => fs.readFileSync(path.join(adapterDir, f), 'utf8'))
			.join('\n');
		const used = V2_REGISTRATION_SURFACES.filter((s) => adapterSrc.includes(s));
		// Anti-vacuity: the adapter must still use the full registration set.
		expect(used).toEqual([...V2_REGISTRATION_SURFACES]);
		const missing = used.filter((s) => !inventory.includes(s));
		expect(missing).toEqual([]);
	});
});

describe('acceptance evidence durability (#2909 closure contract)', () => {
	test('dual-host spike evidence present with entrypoint, hook-firing, version, and ablation markers', () => {
		const readme = fs.readFileSync(path.join(SPIKE_DIR, 'README.md'), 'utf8');
		expect(readme).toContain('Method');
		expect(readme).toContain('Warnings');
		expect(readme).toContain('1.19.0');
		expect(readme).toContain('2.0.29');

		const v1Log = fs.readFileSync(
			path.join(SPIKE_DIR, 'logs', 'v1-host.log'),
			'utf8',
		);
		expect(v1Log).toMatch(/^HOST:.*1\.19\.0/m);
		// Anchored past the colon: the marker must NAME server() as the invoked
		// entrypoint, not merely contain the substring somewhere in the line
		// (implementation-review finding 1: prose mentioning the other host's
		// key satisfied the loose form).
		expect(v1Log).toMatch(/^ENTRYPOINT: server/m);
		expect(v1Log).toMatch(/^HOOK-FIRED:/m);

		const v2Log = fs.readFileSync(
			path.join(SPIKE_DIR, 'logs', 'v2-host.log'),
			'utf8',
		);
		expect(v2Log).toMatch(/^HOST:.*2\.0\.29/m);
		expect(v2Log).toMatch(/^ENTRYPOINT: setup/m);
		expect(v2Log).toMatch(/^HOOK-FIRED:/m);

		const ablationLogs = fs
			.readdirSync(path.join(SPIKE_DIR, 'logs'))
			.filter((f) => f.includes('ablation'));
		expect(ablationLogs.length).toBe(4);
		const ablationText = ablationLogs
			.map((f) => fs.readFileSync(path.join(SPIKE_DIR, 'logs', f), 'utf8'))
			.join('\n');
		// Every ablation leg must carry a computed MATCH verdict, and the v2
		// no-setup leg must quote the host's literal decode error.
		expect(ablationText.match(/^ABLATION:[^\n]*MATCH/gm)?.length).toBe(4);
		expect(ablationText).not.toMatch(
			/^ABLATION:[^\n]*(MISMATCH|HARNESS ERROR)/m,
		);
		expect(
			fs.readFileSync(
				path.join(SPIKE_DIR, 'logs', 'v2-nosetup-ablation.log'),
				'utf8',
			),
		).toContain(
			'Plugin must export a default definition with an id and an effect or setup function.',
		);
	});

	test('ADR-0003 appendices: first-turn window measurement and dated invalidation re-check', () => {
		const adr = fs.readFileSync(ADR, 'utf8');
		// AC3 durable arm (final-critic finding 3): the ADR's status contract
		// must not silently flip after the trace-local frozen checks die.
		expect(adr).toContain('Accepted (2026-09-30)');
		expect(adr).toMatch(/^\*\*GO\.\*\*/m);
		const firstTurn =
			/#[# ]*[^\n]*First-turn window[^\n]*\n([\s\S]*?)(\n#[#] |\n$)/.exec(adr);
		expect(firstTurn).toBeTruthy();
		const section = firstTurn?.[1] ?? '';
		expect(section).toContain('Method');
		expect(section).toMatch(/\d+\s*ms/);
		expect(section).toMatch(/\d+\.\d+\.\d+/);
		expect(adr).toMatch(/no V1 compatibility shim/i);
		expect(adr).toContain('migrate-v1');
		expect(adr).toMatch(/2026-\d{2}-\d{2}/);
	});

	test('release fragment for #2909: pending, or consumed with a manifest/body trail', () => {
		const fragmentName = '2909-adr0003-v2-hook-inventory-closure.md';
		const pending = fs.existsSync(
			path.join(REPO_ROOT, 'docs', 'releases', 'pending', fragmentName),
		);
		if (pending) return; // arm 1: still pending
		const releasesDir = path.join(REPO_ROOT, 'docs', 'releases');
		// arm 2: a release manifest records the consumed fragment path
		const manifests = fs
			.readdirSync(path.join(releasesDir, 'manifests'))
			.filter((f) => f.endsWith('.json'));
		const inManifest = manifests.some((f) =>
			fs
				.readFileSync(path.join(releasesDir, 'manifests', f), 'utf8')
				.includes(`docs/releases/pending/${fragmentName}`),
		);
		// arm 3: the fragment body's unique token landed in a release history doc
		const histories = fs
			.readdirSync(releasesDir)
			.filter((f) => /^v.*\.md$/.test(f));
		const inBody = histories.some((f) =>
			fs
				.readFileSync(path.join(releasesDir, f), 'utf8')
				.includes('2909-adr0003-v2-hook-inventory'),
		);
		expect(
			inManifest || inBody,
			`fragment ${fragmentName} neither pending nor consumed with a trail`,
		).toBe(true);
	});
});
