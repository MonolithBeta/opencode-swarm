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
 * armed, and the `finally` block tree-kills a child that is still running.
 * The deadline covers the WHOLE attempt — executable resolution is timed
 * against it too, so the advertised timeoutMs is an end-to-end bound. The
 * losing racer carries a no-op catch so a late completion can never surface
 * an unhandled rejection.
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
			/**
			 * Failure class: `ETIMEDOUT` (deadline), `ENOENT` (missing binary,
			 * both runtimes), `ESIGNAL` (terminated externally), `EOUTPUT`
			 * (output exceeded the read safety bound), or another spawn-error
			 * code (`EPERM`, `EBUSY`, …). Null only when the child ran and
			 * exited nonzero on its own.
			 */
			code: string | null;
			/** Child exit status when it ran and exited; null otherwise. */
			status: number | null;
			/** Bounded excerpt of the child's stderr (at most 200 characters, sanitized). */
			stderrTail: string;
	  };

/** Parity with the gates this module replaces (10 s bounded read). */
export const GIT_READ_DEFAULT_TIMEOUT_MS = 10_000;

/** Parity with the replaced wrappers' `maxBuffer: 1024 * 1024`. */
export const GIT_READ_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/** Bound for the `stderrTail` carried in failure results and abort text. */
export const GIT_READ_STDERR_TAIL_MAX_CHARS = 200;

const TRANSIENT_RETRY_CODES = new Set(['ETIMEDOUT', 'EBUSY', 'EPERM']);

/**
 * The bounded stderr excerpt that reaches operator- and agent-visible
 * refusal text: the LAST 200 characters (git prints the actionable `fatal:`
 * line at the END of stderr), with control characters collapsed so one
 * refusal stays one line (the house rule for untrusted diagnostic text —
 * cf. `excerptProbeOutput` in src/utils/git-executable.ts).
 */
function stderrTail(text: string): string {
	const tail = text.slice(-GIT_READ_STDERR_TAIL_MAX_CHARS);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — collapse, not strip-into-nothing
	return tail.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
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
				// Mark truncated but KEEP DRAINING: stopping the read would
				// apply backpressure and block the child's exit, turning an
				// overflow into a timeout. Collect what fit so a failure can
				// still carry real stderr detail.
				if (remaining > 0) chunks.push(value.slice(0, remaining));
				truncated = true;
				totalBytes += remaining;
				continue;
			}
			chunks.push(value);
			totalBytes += value.byteLength;
		}
		const joined = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { text: new TextDecoder().decode(joined), truncated };
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
	let proc: BunCompatSubprocess | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let childCompleted = false;
	try {
		// The deadline covers executable resolution too (#3317 review
		// PRR-009): a slow resolver must not silently extend the advertised
		// bound. Resolution has its own internal budget (~1.25 s max), so the
		// remaining-time slice is normally the full timeoutMs.
		const startedAt = Date.now();
		const executable = await gitStatusReadInternals.resolveExecutable();
		const remainingMs = timeoutMs - (Date.now() - startedAt);
		if (remainingMs <= 0) {
			return { ok: false, code: 'ETIMEDOUT', status: null, stderrTail: '' };
		}

		const options: BunCompatSpawnOptions = {
			cwd,
			stdin: 'ignore',
			// Exit-code-only probes (diagnose's rev-parse) ignore output volume
			// entirely: an overflowing child still answers with its exit code.
			stdout: ignoreOutput ? 'ignore' : 'pipe',
			stderr: ignoreOutput ? 'ignore' : 'pipe',
			killProcessTree: true,
			// The manual bounded drain below is authoritative on the
			// getReader() path (the wrapper's collect()-mode cap does not run
			// there); this threads the caller's bound for the buffered
			// consumers as defense-in-depth. Wrapper default: 5 MiB.
			maxBuffer: ignoreOutput ? undefined : maxBufferBytes,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		};
		proc = gitStatusReadInternals.spawn([executable, ...args], options);
		// Process-creation failures (for example ENOENT) are synchronous
		// values under Bun (Bun.spawn throws) — read them before awaiting.
		// Under the Node fallback the `error` event populates spawnError
		// ASYNC, so the same check runs again after `exited` settles below
		// (PRR-005) — never trust the fast path alone.
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
				timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs);
			}),
		]);
		if (result.kind === 'timeout') {
			return { ok: false, code: 'ETIMEDOUT', status: null, stderrTail: '' };
		}
		childCompleted = true;
		// Node-runtime re-check: `error` may have populated spawnError while
		// `exited` resolved (bun-compat resolves it with 1 on error). Without
		// this, a missing binary would render as a nonzero git exit (PRR-005).
		if (proc.spawnError) {
			return {
				ok: false,
				code: (proc.spawnError as NodeJS.ErrnoException).code ?? null,
				status: null,
				stderrTail: stderrTail(result.stderr.text),
			};
		}
		// Output-bound overflow BEFORE the exit-code arms (PRR-002): a child
		// that exited 0 (or nonzero) while overrunning the bound must never be
		// reported as "exited with status 0" or as an unexplained nonzero —
		// the bound is the measured cause.
		if (result.stdout.truncated || result.stderr.truncated) {
			return {
				ok: false,
				code: 'EOUTPUT',
				status: null,
				stderrTail: `output exceeded the ${maxBufferBytes}-byte bound`,
			};
		}
		if (result.exitCode === null || result.exitCode === -1) {
			// Externally signal-terminated child. bun-compat resolves a
			// signal-killed exit as `code ?? -1` (POSIX) or the platform kill
			// result (Windows taskkill) — neither runtime surfaces a POSIX
			// signal name through `exited`, so the uniform, consumer-friendly
			// class is ESIGNAL (PRR-006).
			return {
				ok: false,
				code: 'ESIGNAL',
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
		// Only a child that is still running needs killing (PRR-005/PRR-025):
		// the timeout path is the one case where `exited` has NOT settled.
		// Killing an already-reaped child spawned an extra `taskkill` per
		// successful read on Windows (PID-reuse hazard + subprocess churn).
		if (!childCompleted && proc && !proc.spawnError) {
			try {
				proc.kill('SIGKILL');
			} catch {
				// Best-effort cleanup for an already-exited process.
			}
			// Reap wait (#3317, AC3): on Windows a killed child keeps a
			// handle on its working directory until reaped, so callers
			// cleaning that directory need termination to have LANDED before
			// this read resolves. Bounded at 2 s for a kill-resistant child.
			let reapTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					proc.exited,
					new Promise<void>((resolve) => {
						reapTimer = setTimeout(resolve, 2_000);
					}),
				]);
			} catch {
				// Reap observation is best-effort; the kill was already issued.
			} finally {
				if (reapTimer) clearTimeout(reapTimer);
			}
		}
	}
}

/**
 * Test seam (repo convention): `resolveExecutable` defaults to the async git
 * resolver, `spawn` defaults to `bunSpawn`, and `readOnce` is the
 * single-attempt runner `readGitStatusAsync` wraps. All three are late-bound
 * through this object so sibling test files can stub them without
 * `mock.module`.
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
	spawn: typeof bunSpawn;
} = {
	readOnce: readOnceDefault,
	resolveExecutable: () => resolveGitExecutableAsync(),
	spawn: bunSpawn,
};

/**
 * Bounded git read with exactly one retry for transient spawn errors
 * (`ETIMEDOUT`, `EBUSY`, `EPERM`). Definite failures — `ENOENT`, `EOUTPUT`,
 * `ESIGNAL`, nonzero exits — are permanent: one attempt only. A second
 * transient failure is final (two attempts total).
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
