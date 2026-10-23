/**
 * v2 context write-back must survive a v1 chain that changes the view count
 * when the host's messages carry no `id`.
 *
 * The pinned v2 host hands `session.hook('context')` messages shaped
 * `{ role, content }` — no `id` (observed on opencode 2.1.3). `onV2ContextEvent`
 * (src/host/v2/guidance.ts) pairs each transformed v1 view back to its v2
 * message by `id`, falling back to POSITION for id-less messages. The v1
 * chain does change the view count: `materializeSystemGuidanceInPlace`
 * converts a mid-history `role:'system'` entry into a guidance carrier (which
 * is re-homed to `event.system` and removed from the list), and other stages
 * splice in verdict messages. Positional pairing then shifts every later view
 * onto the wrong v2 message and drops the trailing original — an assistant
 * `tool-call` loses its `tool` result and the provider rejects the request:
 *
 *   messages.N.content.0: unexpected `tool_use_id` found in `tool_result`
 *   blocks … must have a corresponding `tool_use` block in the previous message
 *
 * Separately, `writeBackTextParts` rebuilt every message as
 * `[...nonText, ...text]`, moving an assistant's preamble text AFTER its
 * tool call.
 *
 * Tests 1–3 are RED at base and GREEN after the fix; 4–5 are regression floors
 * (GREEN at both ends).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { materializeSystemGuidanceInPlace } from '../../../../src/hooks/messages-transform';
import { onV2ContextEvent } from '../../../../src/host/v2/guidance';
import type {
	V1HooksSubset,
	V2Message,
	V2SessionContextEvent,
} from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

type ViewMessage = {
	info: { id?: string; role?: string; [key: string]: unknown };
	parts: Array<{ type: string; text?: string }>;
};
type Transform = (messages: ViewMessage[]) => void;

function hooksWith(transform: Transform): V1HooksSubset {
	return {
		'experimental.chat.messages.transform': async (
			_input: unknown,
			output: { messages: ViewMessage[] },
		) => {
			transform(output.messages);
		},
	} as unknown as V1HooksSubset;
}

const call = (id: string) => ({
	type: 'tool-call',
	id,
	name: 'shell',
	input: { command: 'true' },
});
const result = (id: string) => ({
	type: 'tool-result',
	id,
	name: 'shell',
	result: { type: 'text', value: 'ok' },
});

/** A real-shaped v2 history: no `id`, a system entry between tool turns. */
function idlessHistory(): V2Message[] {
	return [
		{ role: 'user', content: [{ type: 'text', text: 'run three steps' }] },
		{
			role: 'assistant',
			content: [{ type: 'text', text: 'step 1' }, call('t1')],
		},
		{ role: 'tool', content: [result('t1')] },
		{
			role: 'system',
			content: [{ type: 'text', text: 'mid-history reminder' }],
		},
		{
			role: 'assistant',
			content: [{ type: 'text', text: 'step 2' }, call('t2')],
		},
		{ role: 'tool', content: [result('t2')] },
		{
			role: 'assistant',
			content: [{ type: 'text', text: 'step 3' }, call('t3')],
		},
		{ role: 'tool', content: [result('t3')] },
	];
}

function event(messages: V2Message[]): V2SessionContextEvent {
	return {
		sessionID: 'idless-pairing-session',
		agent: undefined,
		system: [],
		messages,
		options: {},
		tools: {},
	};
}

/** Every tool-result must answer a tool-call in the message right before it. */
function orphanedResults(messages: V2Message[]): string[] {
	const orphans: string[] = [];
	messages.forEach((message, index) => {
		for (const part of message.content) {
			if (part.type !== 'tool-result') continue;
			const previous = messages[index - 1];
			const answered = previous?.content.some(
				(p) => p.type === 'tool-call' && p.id === part.id,
			);
			if (!answered) orphans.push(String(part.id));
		}
	});
	return orphans;
}

const toolIds = (messages: V2Message[], type: string) =>
	messages.flatMap((m) =>
		m.content.filter((p) => p.type === type).map((p) => p.id),
	);

afterEach(() => {
	resetSwarmState();
});

describe('v2 context write-back with id-less host messages', () => {
	test('RED at base — a system entry materialized by the v1 chain does not orphan any tool result', async () => {
		const ev = event(idlessHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) =>
				materializeSystemGuidanceInPlace(messages as never),
			),
			canonicalMkdtemp('swarm-idless-materialize-'),
		);

		expect(toolIds(ev.messages, 'tool-call')).toEqual(['t1', 't2', 't3']);
		expect(toolIds(ev.messages, 'tool-result')).toEqual(['t1', 't2', 't3']);
		expect(orphanedResults(ev.messages)).toEqual([]);
		// The system entry's text was re-homed, not left in the message list.
		expect(ev.messages.some((m) => m.role === 'system')).toBe(false);
		expect(ev.system.map((part) => part.text).join('\n')).toContain(
			'mid-history reminder',
		);
	});

	test('RED at base — a view inserted by the v1 chain does not shift text onto other messages', async () => {
		const ev = event(idlessHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				messages.unshift({
					info: { role: 'user' },
					parts: [{ type: 'text', text: 'verdict' }],
				});
			}),
			canonicalMkdtemp('swarm-idless-insert-'),
		);

		const texts = ev.messages.map((m) =>
			m.content
				.filter((p) => p.type === 'text')
				.map((p) => p.text)
				.join(''),
		);
		expect(texts).toEqual([
			'run three steps',
			'step 1',
			'',
			'mid-history reminder',
			'step 2',
			'',
			'step 3',
			'',
		]);
		expect(orphanedResults(ev.messages)).toEqual([]);
	});

	test('RED at base — write-back keeps an assistant preamble before its tool call', async () => {
		const ev = event(idlessHistory());
		await onV2ContextEvent(
			ev,
			hooksWith(() => {}),
			canonicalMkdtemp('swarm-idless-order-'),
		);

		for (const message of ev.messages.filter((m) => m.role === 'assistant')) {
			expect(message.content.map((part) => part.type)).toEqual([
				'text',
				'tool-call',
			]);
		}
	});

	test('regression floor — transformed text is written back onto the message it came from', async () => {
		const ev = event(idlessHistory());
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				for (const message of messages) {
					for (const part of message.parts) {
						if (part.type === 'text') part.text = `${part.text}!`;
					}
				}
			}),
			canonicalMkdtemp('swarm-idless-rewrite-'),
		);

		const assistantTexts = ev.messages
			.filter((m) => m.role === 'assistant')
			.map((m) => m.content.find((p) => p.type === 'text')?.text);
		expect(assistantTexts).toEqual(['step 1!', 'step 2!', 'step 3!']);
	});

	test('regression floor — id-bearing messages still pair by id and dropped text-only views are removed', async () => {
		const ev = event([
			{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'keep' }] },
			{ id: 'm2', role: 'user', content: [{ type: 'text', text: 'drop' }] },
			{
				id: 'm3',
				role: 'assistant',
				content: [{ type: 'text', text: 'reply' }],
			},
		]);
		await onV2ContextEvent(
			ev,
			hooksWith((messages) => {
				const index = messages.findIndex((m) => m.info.id === 'm2');
				messages.splice(index, 1);
			}),
			canonicalMkdtemp('swarm-id-pairing-'),
		);

		expect(ev.messages.map((m) => m.id)).toEqual(['m1', 'm3']);
		expect(ev.messages[1]?.content).toEqual([{ type: 'text', text: 'reply' }]);
	});
});
