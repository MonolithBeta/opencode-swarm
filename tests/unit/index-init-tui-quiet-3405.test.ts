/**
 * Issue #3405 — no raw console output on the plugin init path.
 *
 * The OpenCode TUI renders plugin stderr as a full-width overlay over the
 * UI (the #1249 class; contract: src/services/warning-buffer.ts advisoryWarn
 * docblock), so the init path must not write raw console.warn/console.log
 * for the startup version banner or the project-root ownership hints. This
 * is the shipped form of the frozen acceptance checks C1-C3
 * (.agents/issue-traces/3405-tui-raw-console-warn-init-overlay/repro/):
 * REAL plugin boots (src/index.ts default export's server()) with a
 * hand-built host ctx under XDG-only env isolation (the #2679 suite's
 * idiom — HOME/USERPROFILE stay real so the boundary walk's weak-container
 * rule keys on the real home).
 *
 * Contracts pinned:
 * - redirect hint: absent from BOTH captured console streams, present in the
 *   deferred-warning buffer (/swarm diagnose channel), ownership outcome
 *   unchanged (state lands in the owning parent).
 * - fail-closed hint: absent from both streams, present in the buffer.
 * - banner: silent by default on both streams; OPENCODE_SWARM_VERSION_BANNER=1
 *   restores exactly one raw stderr line; OPENCODE_SWARM_DEBUG=1 logs exactly
 *   one stdout line (never stderr).
 * - debug-mode hint leg: under OPENCODE_SWARM_DEBUG=1 the redirect hint text
 *   reaches console.log exactly once (advisoryWarn's log() leg) — the
 *   behavioral kill for partial advisoryWarn deletion.
 * - AC5 non-deletion pin: the retargeted #2679 suite still asserts the
 *   buffered hint (call-site count of expect(hasParentRootHint(...) >= 2).
 *
 * Env isolation is deliberately XDG-only (plus APPDATA/LOCALAPPDATA), NOT
 * createIsolatedTestEnv(): the boundary walk's weak-container rule keys on
 * the REAL user home (see index-bootstrap-root-ownership-2679.test.ts
 * header). Console capture is by reassignment with finally-restore. No
 * clock usage.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import { closeAllProjectDbs } from '../../src/db/project-db';
import OpenCodeSwarm from '../../src/index';
import { getDeferredWarnings } from '../../src/services/warning-buffer';
import { resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { safeRmRecursive } from '../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../helpers/tmpdir';

/** Fixed drain (ms) after server() resolves, for the wrapper-owned post-resolution writer queue. */
const SETTLE_MS = 3500;

const ISOLATED_ENV_KEYS = [
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'APPDATA',
	'LOCALAPPDATA',
] as const;

const fixtureRoots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
let isolatedEnvRoot = '';
let restoreEnv: (() => void) | null = null;

beforeAll(() => {
	isolatedEnvRoot = canonicalMkdtemp('swarm3405-quiet-env-');
	for (const key of ISOLATED_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		process.env[key] = isolatedEnvRoot;
	}
	restoreEnv = () => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
});

afterEach(async () => {
	// Release plugin-owned handles BEFORE removing fixtures (EBUSY on Windows).
	resetTelemetryForTesting();
	await closeAllProjectDbs();
	resetSwarmState();
	delete process.env.OPENCODE_SWARM_VERSION_BANNER;
	delete process.env.OPENCODE_SWARM_DEBUG;
	for (const dir of fixtureRoots.splice(0)) {
		try {
			safeRmRecursive(dir);
		} catch {
			/* best-effort */
		}
	}
});

afterAll(() => {
	restoreEnv?.();
	restoreEnv = null;
	if (isolatedEnvRoot) {
		try {
			safeRmRecursive(isolatedEnvRoot);
		} catch {
			/* best-effort */
		}
		isolatedEnvRoot = '';
	}
});

interface ConsoleCapture {
	warn: string[];
	log: string[];
}

function captureConsole(): { captured: ConsoleCapture; restore: () => void } {
	const captured: ConsoleCapture = { warn: [], log: [] };
	const originalWarn = console.warn;
	const originalLog = console.log;
	console.warn = (...args: unknown[]) => {
		captured.warn.push(args.map((a) => String(a)).join(' '));
	};
	console.log = (...args: unknown[]) => {
		captured.log.push(args.map((a) => String(a)).join(' '));
	};
	return {
		captured,
		restore: () => {
			console.warn = originalWarn;
			console.log = originalLog;
		},
	};
}

function ctxFor(directory: string) {
	return {
		client: {},
		project: {} as unknown,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as unknown,
	} as never;
}

function fixtureRoot(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fixtureRoots.push(dir);
	return dir;
}

async function bootAndSettle(directory: string): Promise<ConsoleCapture> {
	const { captured, restore } = captureConsole();
	try {
		const manifest = (await OpenCodeSwarm.server(ctxFor(directory))) as Record<
			string,
			unknown
		>;
		expect(typeof manifest).toBe('object');
		await Bun.sleep(SETTLE_MS);
		return captured;
	} finally {
		restore();
	}
}

function hintLines(captured: ConsoleCapture): string[] {
	return [...captured.warn, ...captured.log].filter((l) =>
		l.includes('project-root ownership'),
	);
}

function bufferedHintLines(): string[] {
	return getDeferredWarnings().filter((l) =>
		l.includes('project-root ownership'),
	);
}

function bannerWarnLines(captured: ConsoleCapture): string[] {
	return captured.warn.filter((l) => l.includes('[opencode-swarm] running v'));
}

function bannerLogLines(captured: ConsoleCapture): string[] {
	return captured.log.filter((l) => l.includes('[opencode-swarm] running v'));
}

/** parent(.git + .swarm + .opencode config) + ordinary child. */
function makeClaimedFixture(name: string) {
	const root = fixtureRoot(`swarm3405-quiet-${name}-`);
	const parent = path.join(root, 'outer');
	const child = path.join(parent, 'child');
	fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
	fs.mkdirSync(path.join(parent, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(parent, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(parent, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, quiet: true }, null, 2),
	);
	fs.mkdirSync(child, { recursive: true });
	return { parent, child };
}

describe('init-path raw console silence (#3405)', () => {
	test('redirect boot: no hint on any raw stream, hint buffered, ownership unchanged', async () => {
		const { parent, child } = makeClaimedFixture('redirect');

		const captured = await bootAndSettle(child);

		expect(hintLines(captured)).toEqual([]);
		expect(bufferedHintLines().length).toBeGreaterThanOrEqual(1);
		expect(fs.existsSync(path.join(child, '.swarm'))).toBe(false);
		expect(fs.existsSync(path.join(parent, '.swarm'))).toBe(true);
	});

	test('fail-closed boot: no hint on any raw stream, hint buffered', async () => {
		const root = fixtureRoot('swarm3405-quiet-failclosed-');
		const missing = path.join(root, 'does', 'not', 'exist');

		const captured = await bootAndSettle(missing);

		expect(hintLines(captured)).toEqual([]);
		expect(bufferedHintLines().length).toBeGreaterThanOrEqual(1);
	});

	test('banner: silent by default, raw stderr only via opt-in env, stdout log only via debug', async () => {
		const root = fixtureRoot('swarm3405-quiet-banner-');
		fs.writeFileSync(
			path.join(root, 'package.json'),
			JSON.stringify(
				{ name: 'swarm3405-banner', version: '0.0.0', private: true },
				null,
				2,
			),
		);
		fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ version_check: false, quiet: true }, null, 2),
		);

		delete process.env.OPENCODE_SWARM_VERSION_BANNER;
		delete process.env.OPENCODE_SWARM_DEBUG;
		const defaultCaptured = await bootAndSettle(root);
		expect(bannerWarnLines(defaultCaptured)).toEqual([]);
		expect(bannerLogLines(defaultCaptured)).toEqual([]);

		process.env.OPENCODE_SWARM_VERSION_BANNER = '1';
		const optInCaptured = await bootAndSettle(root);
		expect(bannerWarnLines(optInCaptured)).toHaveLength(1);
		expect(bannerLogLines(optInCaptured)).toEqual([]);

		delete process.env.OPENCODE_SWARM_VERSION_BANNER;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const debugCaptured = await bootAndSettle(root);
		expect(bannerLogLines(debugCaptured)).toHaveLength(1);
		expect(bannerWarnLines(debugCaptured)).toEqual([]);
	});

	test('debug-mode hint leg: under OPENCODE_SWARM_DEBUG=1 the redirect hint reaches console.log once', async () => {
		const { child } = makeClaimedFixture('debug-hint');

		process.env.OPENCODE_SWARM_DEBUG = '1';
		const captured = await bootAndSettle(child);

		expect(
			captured.warn.filter((l) => l.includes('project-root ownership')),
		).toEqual([]);
		expect(
			captured.log.filter((l) => l.includes('project-root ownership')),
		).toHaveLength(1);
	});

	test('AC5 pin: the #2679 suite still asserts the buffered hint at both call sites', () => {
		const source = fs.readFileSync(
			path.resolve(
				import.meta.dir,
				'index-bootstrap-root-ownership-2679.test.ts',
			),
			'utf8',
		);
		const callSites = source.match(/expect\(\s*hasParentRootHint\(/g) ?? [];
		expect(callSites.length).toBeGreaterThanOrEqual(2);
	});
});
