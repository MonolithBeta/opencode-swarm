import { describe, expect, test } from 'bun:test';
import { isTaskToolId } from '../../../../src/hooks/normalize-tool-name';
import { startDeferredEventPump } from '../../../../src/host/v2/events';
import type { V2EventEnvelope } from '../../../../src/host/v2/types';
import {
	bindPendingTaskModelRouteChild,
	resolveSessionChatAgent,
} from '../../../../src/models/task-model-routing';

/**
 * Issue #3401 regression suite: on OpenCode 2 hosts the subagent tool
 * publishes the CHILD session id as live progress metadata
 * (`session.tool.progress` with `metadata.sessionID`), and the v2 event pump
 * must translate that into the v1 `message.part.updated` ToolPart shape the
 * scope-activation handler requires (src/index.ts ~3884: part.type/tool/
 * callID/sessionID/state.metadata.sessionId). Before the fix the pump dropped
 * the progress event entirely and passed `session.tool.called` through flat,
 * so the coder child's scope-binding claim (`taskMetadata`) was unreachable
 * and every standard single-workspace coder dispatch failed closed at first
 * write with `SCOPE_NOT_DECLARED ... for task unknown`.
 *
 * Fixtures mirror the live capture (host 2.0.29, shapes identical at the
 * v2.0.32 tag): see .agents/issue-traces/3401-scope-not-declared-child-task-
 * unknown/02-reproduction.md. No mocks: the real pump and real modules.
 */

interface DeliveredEvent {
	type: string;
	properties: Record<string, unknown>;
}

function inputStarted(sessionID: string, callID: string, name: string) {
	return {
		type: 'session.tool.input.started',
		data: { sessionID, assistantMessageID: 'msg_PARENT', id: callID, name },
	};
}

function toolCalled(sessionID: string, callID: string) {
	return {
		type: 'session.tool.called',
		data: {
			sessionID,
			assistantMessageID: 'msg_PARENT',
			id: callID,
			input: { agent: 'coder', description: 'task 2.1', prompt: 'FILE: x' },
			executed: false,
		},
	};
}

function progress(sessionID: string, callID: string, childSessionID: string) {
	return {
		type: 'session.tool.progress',
		data: {
			sessionID,
			assistantMessageID: 'msg_PARENT',
			id: callID,
			metadata: { sessionID: childSessionID, status: 'running' },
		},
	};
}

/** Drives the real detached pump over a finite envelope list and collects
 * everything it delivered to the (fake) v1 event handler. */
async function pumpEnvelopes(
	envelopes: Array<Record<string, unknown>>,
): Promise<DeliveredEvent[]> {
	const received: DeliveredEvent[] = [];
	const hooks = {
		event: async (input: { event: DeliveredEvent }): Promise<void> => {
			received.push(input.event);
		},
	};
	let drained = false;
	async function* gen(): AsyncGenerator<Record<string, unknown>> {
		for (const envelope of envelopes) yield envelope;
		drained = true;
	}
	const ctx = { event: { subscribe: async () => gen() } };
	const stop = startDeferredEventPump(
		ctx as never,
		hooks as unknown as Parameters<typeof startDeferredEventPump>[1],
	);
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline && !drained) {
		await Bun.sleep(25);
	}
	// The pump awaits each dispatch sequentially; let the last one settle.
	await Bun.sleep(150);
	stop();
	return received;
}

/** The v1 scope-activation guard's qualification predicate (src/index.ts
 * ~3907-3916), applied to a delivered event. */
function qualifyingPart(event: DeliveredEvent):
	| {
			type: 'tool';
			tool: string;
			callID: string;
			sessionID: string;
			state: { metadata: { sessionId: string } };
	  }
	| undefined {
	if (event.type !== 'message.part.updated') return undefined;
	const part = event.properties.part as Record<string, unknown> | undefined;
	if (!part || part.type !== 'tool' || typeof part.tool !== 'string') {
		return undefined;
	}
	if (!isTaskToolId(part.tool)) return undefined;
	const metadata = (part.state as Record<string, unknown> | undefined)
		?.metadata as Record<string, unknown> | undefined;
	if (typeof part.callID !== 'string' || typeof part.sessionID !== 'string') {
		return undefined;
	}
	if (typeof metadata?.sessionId !== 'string') return undefined;
	if (part.sessionID === metadata.sessionId) return undefined;
	return {
		type: 'tool',
		tool: part.tool,
		callID: part.callID,
		sessionID: part.sessionID,
		state: { metadata: { sessionId: metadata.sessionId } },
	};
}

describe('#3401 — v2 subagent progress synthesizes the v1 scope-activation part', () => {
	test('regression: a subagent dispatch sequence delivers exactly one qualifying task part', async () => {
		const parent = 'ses_p3401a';
		const child = 'ses_c3401a';
		const call = 'call_d3401a';
		const received = await pumpEnvelopes([
			inputStarted(parent, call, 'subagent'),
			toolCalled(parent, call),
			progress(parent, call, child),
		]);
		const qualifying = received
			.map((event) => qualifyingPart(event))
			.filter((part) => part !== undefined);
		expect(qualifying.length).toBe(1);
		expect(qualifying[0]).toEqual({
			type: 'tool',
			tool: 'task',
			callID: call,
			sessionID: parent,
			state: { metadata: { sessionId: child } },
		});
		expect(isTaskToolId(qualifying[0]!.tool)).toBe(true);
	});

	test('a non-subagent tool name never synthesizes a task part', async () => {
		const parent = 'ses_p3401b';
		const call = 'call_d3401b';
		const received = await pumpEnvelopes([
			inputStarted(parent, call, 'execute'),
			toolCalled(parent, call),
			progress(parent, call, 'ses_c3401b'),
		]);
		expect(
			received.filter((event) => qualifyingPart(event) !== undefined).length,
		).toBe(0);
	});

	test('an untracked tool name (no input.started observed) fails closed', async () => {
		const received = await pumpEnvelopes([
			toolCalled('ses_p3401c', 'call_d3401c'),
			progress('ses_p3401c', 'call_d3401c', 'ses_c3401c'),
		]);
		expect(
			received.filter((event) => qualifyingPart(event) !== undefined).length,
		).toBe(0);
	});

	test('a self-referencing child id (child === parent) is rejected', async () => {
		const parent = 'ses_p3401d';
		const received = await pumpEnvelopes([
			inputStarted(parent, 'call_d3401d', 'subagent'),
			progress(parent, 'call_d3401d', parent),
		]);
		expect(
			received.filter((event) => qualifyingPart(event) !== undefined).length,
		).toBe(0);
	});

	test('malformed progress payloads fail closed', async () => {
		const parent = 'ses_p3401e';
		const cases: Array<Record<string, unknown>> = [
			// missing call id
			{
				type: 'session.tool.progress',
				data: { sessionID: parent, metadata: { sessionID: 'ses_c1' } },
			},
			// empty child id
			{
				type: 'session.tool.progress',
				data: {
					sessionID: parent,
					id: 'call_x1',
					metadata: { sessionID: '' },
				},
			},
			// non-string child id
			{
				type: 'session.tool.progress',
				data: {
					sessionID: parent,
					id: 'call_x2',
					metadata: { sessionID: 42 },
				},
			},
		];
		for (const [index, envelope] of cases.entries()) {
			const received = await pumpEnvelopes([
				inputStarted(parent, `call_mal${index}`, 'subagent'),
				envelope,
			]);
			expect(
				received.filter((event) => qualifyingPart(event) !== undefined).length,
			).toBe(0);
		}
	});

	test('flat tool-event passthrough is preserved (called maps without a part)', async () => {
		const parent = 'ses_p3401f';
		const received = await pumpEnvelopes([
			inputStarted(parent, 'call_d3401f', 'subagent'),
			toolCalled(parent, 'call_d3401f'),
		]);
		const called = received.filter(
			(event) =>
				event.type === 'message.part.updated' &&
				(event.properties as { input?: unknown }).input !== undefined,
		);
		expect(called.length).toBe(1);
		expect(called[0]!.properties.part).toBeUndefined();
	});

	test('the tool-name registry is bounded (FIFO eviction)', async () => {
		const parent = 'ses_p3401g';
		// 600 distinct dispatch names evict the earliest entries (cap 512).
		const names: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 600; i++) {
			names.push(inputStarted(parent, `call_evict${i}`, 'subagent'));
		}
		const received = await pumpEnvelopes([
			...names,
			progress(parent, 'call_evict0', 'ses_c3401g0'),
			progress(parent, 'call_evict599', 'ses_c3401g599'),
		]);
		const qualifying = received
			.map((event) => qualifyingPart(event))
			.filter((part) => part !== undefined);
		expect(qualifying.length).toBe(1);
		expect(qualifying[0]!.callID).toBe('call_evict599');
	});
});

describe('#3401 — v1 activation-block side consumers restored on v2 (no-op without staged state)', () => {
	test('the synthesized triple leaves unstaged model routes and full-auto bindings inert', async () => {
		// The same v1 activation block that claims the scope binding also calls
		// bindPendingTaskModelRouteChild and (when a full-auto run is active)
		// bindFullAutoSevereChildSession. Once the synthesized part reaches the
		// v1 handler these consumers start firing on v2 as v1-parity
		// restorations; without staged state they must stay inert.
		const parent = 'ses_p3401h';
		const child = 'ses_c3401h';
		const call = 'call_d3401h';
		await pumpEnvelopes([
			inputStarted(parent, call, 'subagent'),
			toolCalled(parent, call),
			progress(parent, call, child),
		]);
		const routeBinding = bindPendingTaskModelRouteChild({
			parentSessionID: parent,
			callID: call,
			childSessionID: child,
		});
		expect(routeBinding).toBeUndefined();
		// No full-auto run generation is staged in this suite, so the index.ts
		// activation block never reaches bindFullAutoSevereChildSession here;
		// resolveSessionChatAgent is likewise untouched by the pump sequence.
		expect(resolveSessionChatAgent(child)).toBeUndefined();
	});
});
