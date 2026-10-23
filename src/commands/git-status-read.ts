/**
 * Async, bounded, killable git-read runner for the user-facing gate paths
 * (issue #3317): /swarm close's destructive-purge gate, the pre-destruction
 * re-check, /swarm rollback's destruction measurement, /swarm diagnose's
 * repository check, and /swarm finalize --dry-run's repository probe.
 *
 * Replaces the private blocking `spawnSync` wrappers that collapsed every
 * failure class (timeout, missing binary, nonzero exit) into `null`, leaving
 * the abort text no cause to name. The gate stays fail-closed — a read that
 * cannot complete is reported as a structured failure, never as a clean tree.
 *
 * Deadline convention (the repo's discriminated-timeout rule, mirroring
 * `runGitAsyncDetailed` in src/background/workspace-snapshot.ts): the
 * caller-side `Promise.race` owns the deadline; `bunSpawn` with
 * `killProcessTree: true` deletes the native timeout so exactly one timer is
 * armed, and the `finally` block tree-kills the child. The losing racer
 * carries a no-op catch so a late completion can never surface an unhandled
 * rejection.
 */
import {
	type BunCompatSpawnOptions,
	type BunCompatSubprocess,
	bunSpawn,
} from '../utils/bun-compat';
import { resolveGitExecutableAsync } from '../utils/git-executable';

export type GitStatusReadResult =
	| { ok: true; stdout: string }
	| {
			ok: false;
			/** Spawn-error code (`ETIMEDOUT`, `ENOENT`, …) or signal name; null when the child exited nonzero without a spawn error. */
			code: string | null;
			/** Child exit status when it ran and exited; null otherwise. */
			status: number | null;
			/** Bounded excerpt of the child's stderr (at most 200 characters). */
			stderrTail: string;
	  };

/** Parity with the gates this module replaces (10 s bounded read). */
export const GIT_READ_DEFAULT_TIMEOUT_MS = 10_000;

/** Parity with the replaced wrappers' `maxBuffer: 1024 * 1024`. */
export const GIT_READ_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/** Bound for the `stderrTail` carried in failure results and abort text. */
export const GIT_READ_STDERR_TAIL_MAX_CHARS = 200;

const TRANSIENT_RETRY_CODES = new Set(['ETIMEDOUT', 'EBUSY', 'EPERM']);

function stderrTail(text: string): string {
	return text.slice(0, GIT_READ_STDERR_TAIL_MAX_CHARS);
}

interface BoundedOutput {
	text: string;
	truncated: boolean;
}

async function readBoundedOutput(
	stream: BunCompatSubprocess['stdout'],
	maxBytes: number,
): Promise<BoundedOutput> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const remaining = maxBytes - totalBytes;
			if (value.byteLength > remaining) {
				// Mark truncated but KEEP DRAINING (discarding): stopping the
				// read would apply backpressure and block the child's exit,
				// turning an overflow into a timeout.
				truncated = true;
				totalBytes += value.byteLength;
				continue;
			}
			if (!truncated) chunks.push(value);
			totalBytes += value.byteLength;
		}
		if (truncated) return { text: '', truncated: true };
		const joined = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { text: new TextDecoder().decode(joined), truncated: false };
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Stream already closed.
		}
	}
}

async function readOnceDefault(
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
	maxBufferBytes = GIT_READ_DEFAULT_MAX_BUFFER_BYTES,
	ignoreOutput = false,
): Promise<GitStatusReadResult> {
	const executable = await gitStatusReadInternals.resolveExecutable();
	let proc: BunCompatSubprocess | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const options: BunCompatSpawnOptions = {
			cwd,
			stdin: 'ignore',
			// Exit-code-only probes (diagnose's rev-parse) ignore output volume
			// entirely: an overflowing child still answers with its exit code.
			stdout: ignoreOutput ? 'ignore' : 'pipe',
			stderr: ignoreOutput ? 'ignore' : 'pipe',
			killProcessTree: true,
			// Route the per-call bound into the wrapper too: bunSpawn's own
			// default stream cap (512 KB) would silently truncate piped output
			// before the manual bounded drain below sees it (observed on CI
			// linux/macos bun 1.3.13; local Windows 1.3.14 raw streams differ).
			maxBuffer: ignoreOutput ? undefined : maxBufferBytes,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		};
		proc = bunSpawn([executable, ...args], options);
		// Process-creation failures (for example ENOENT) are reported as a
		// VALUE on every runtime (see bunSpawn's #2236 handling) — read them
		// before awaiting anything.
		if (proc.spawnError) {
			return {
				ok: false,
				code: (proc.spawnError as NodeJS.ErrnoException).code ?? null,
				status: null,
				stderrTail: '',
			};
		}
		const completed = Promise.all([
			proc.exited,
			ignoreOutput
				? Promise.resolve({ text: '', truncated: false })
				: readBoundedOutput(proc.stdout, maxBufferBytes),
			ignoreOutput
				? Promise.resolve({ text: '', truncated: false })
				: readBoundedOutput(proc.stderr, maxBufferBytes),
		]).then(([exitCode, stdout, stderr]) => ({
			kind: 'completed' as const,
			exitCode,
			stdout,
			stderr,
		}));
		// Losing-racer no-op catch (the withTimeout unhandled-rejection hazard).
		completed.catch(() => {});
		const result = await Promise.race([
			completed,
			new Promise<{ kind: 'timeout' }>((resolve) => {
				timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
			}),
		]);
		if (result.kind === 'timeout') {
			return { ok: false, code: 'ETIMEDOUT', status: null, stderrTail: '' };
		}
		if (result.exitCode === null) {
			// Externally signal-terminated child — keep the signal name so the
			// diagnose timeout-like arms cannot regress to "not a repository".
			return {
				ok: false,
				code: proc.signalCode ?? null,
				status: null,
				stderrTail: stderrTail(result.stderr.text),
			};
		}
		if (result.exitCode !== 0) {
			return {
				ok: false,
				code: null,
				status: result.exitCode,
				stderrTail: stderrTail(result.stderr.text),
			};
		}
		if (result.stdout.truncated || result.stderr.truncated) {
			// A read that overran its bound must never read as a complete
			// measurement — fail closed with an honest bounded reason.
			return {
				ok: false,
				code: null,
				status: result.exitCode,
				stderrTail: `output exceeded the ${maxBufferBytes}-byte bound`,
			};
		}
		return { ok: true, stdout: result.stdout.text };
	} catch (err) {
		return {
			ok: false,
			code: (err as NodeJS.ErrnoException)?.code ?? null,
			status: null,
			stderrTail: '',
		};
	} finally {
		if (timer) clearTimeout(timer);
		if (proc && !proc.spawnError) {
			try {
				proc.kill('SIGKILL');
			} catch {
				// Best-effort tree cleanup for an already-exited process.
			}
			// Reap wait (#3317, AC3 "kill the child"): on Windows a killed
			// child keeps a handle on its working directory until it is reaped,
			// so callers cleaning that directory up need the termination to
			// have LANDED before this read resolves. Bounded: a healthy child
			// already exited (the completed race awaited it), and even a
			// kill-resistant one cannot hold us past 2 s.
			try {
				await Promise.race([
					proc.exited,
					new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
				]);
			} catch {
				// Reap observation is best-effort; the kill was already issued.
			}
		}
	}
}

/**
 * Test seam (repo convention): `resolveExecutable` defaults to the async git
 * resolver; `readOnce` is the single-attempt runner `readGitStatusAsync`
 * wraps. Both are late-bound through this object so sibling test files can
 * stub them without `mock.module`.
 */
export const gitStatusReadInternals: {
	readOnce: (
		args: readonly string[],
		cwd: string,
		timeoutMs: number,
		maxBufferBytes?: number,
		ignoreOutput?: boolean,
	) => Promise<GitStatusReadResult>;
	resolveExecutable: () => Promise<string>;
} = {
	readOnce: readOnceDefault,
	resolveExecutable: () => resolveGitExecutableAsync(),
};

/**
 * Bounded git read with exactly one retry for transient spawn errors
 * (`ETIMEDOUT`, `EBUSY`, `EPERM`). Definite failures — `ENOENT`, nonzero
 * exits — are permanent: one attempt only. A second transient failure is
 * final (two attempts total).
 */
export async function readGitStatusAsync(
	args: readonly string[],
	cwd: string,
	opts?: { timeoutMs?: number; maxBufferBytes?: number },
): Promise<GitStatusReadResult> {
	const timeoutMs = opts?.timeoutMs ?? GIT_READ_DEFAULT_TIMEOUT_MS;
	const maxBufferBytes =
		opts?.maxBufferBytes ?? GIT_READ_DEFAULT_MAX_BUFFER_BYTES;
	const first = await gitStatusReadInternals.readOnce(
		args,
		cwd,
		timeoutMs,
		maxBufferBytes,
	);
	if (first.ok || first.code === null) return first;
	if (!TRANSIENT_RETRY_CODES.has(first.code)) return first;
	return gitStatusReadInternals.readOnce(args, cwd, timeoutMs, maxBufferBytes);
}

/**
 * Single-attempt repository probe for `/swarm finalize --dry-run`
 * (issue #3317): `rev-parse --git-dir` through the shared reader, mapped to a
 * boolean. Single attempt by design — the dry-run report must stay a fast,
 * non-blocking preview, with no transient-retry chain.
 */
export async function readGitRepositoryStatusAsync(
	cwd: string,
): Promise<boolean> {
	const result = await gitStatusReadInternals.readOnce(
		['rev-parse', '--git-dir'],
		cwd,
		GIT_READ_DEFAULT_TIMEOUT_MS,
	);
	return result.ok;
}
