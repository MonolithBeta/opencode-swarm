import { afterEach, describe, expect, test } from 'bun:test';
import {
	expectDropsVsControl,
	flatToolCalledEvents,
	inputStarted,
	progress,
	pumpEnvelopes,
	qualifyingParts,
	resetToolNameRegistry,
	toolCalled,
} from './_scope-activation-progress-3401-helpers';

/**
 * Issue #3401 fail-closed gating suite (PR #3402 review PRR-001 / repo
 * Directive 2): every branch of the new `session.tool.progress` gate in
 * src/host/v2/events.ts must be executed by a test, and every negative is
 * asserted DIFFERENTIALLY against a positive control in the same harness —
 * a lone "nothing synthesized" assertion passes vacuously when the pump
 * delivers nothing at all (the defect this suite layout fixes).
 */

afterEach(() => {
	resetToolNameRegistry();
});

const PARENT = 'ses_g3401';

describe('#3401 — non-subagent and untracked tool names fail closed', () => {
	test('a non-subagent tool name never synthesizes a task part', async () => {
		const call = 'call_g_nonagent';
		await expectDropsVsControl(
			[
				inputStarted(PARENT, call, 'execute'),
				toolCalled(PARENT, call),
				progress(PARENT, call, 'ses_c_nonagent'),
			],
			[
				inputStarted(PARENT, call, 'subagent'),
				toolCalled(PARENT, call),
				progress(PARENT, call, 'ses_c_nonagent'),
			],
		);
	});

	test('an untracked tool name (no input.started observed) fails closed', async () => {
		const call = 'call_g_untracked';
		await expectDropsVsControl(
			[toolCalled(PARENT, call), progress(PARENT, call, 'ses_c_untracked')],
			[
				inputStarted(PARENT, call, 'subagent'),
				toolCalled(PARENT, call),
				progress(PARENT, call, 'ses_c_untracked'),
			],
		);
	});

	test('a self-referencing child id (child === parent) is rejected', async () => {
		const call = 'call_g_selfref';
		await expectDropsVsControl(
			[inputStarted(PARENT, call, 'subagent'), progress(PARENT, call, PARENT)],
			[
				inputStarted(PARENT, call, 'subagent'),
				progress(PARENT, call, 'ses_c_selfref'),
			],
		);
	});

	test('a namespaced/dotted subagent tool id is recognized (v1 name-mapping parity)', async () => {
		// isV2SubagentToolId accepts `tool.<seg>.subagent` — the documented
		// #2529/#3169 name-mapping policy; pin that the gate honors it.
		const call = 'call_g_dotted';
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, 'tool.plugin.subagent'),
			progress(PARENT, call, 'ses_c_dotted'),
		]);
		expect(drained).toBe(true);
		expect(qualifyingParts(received).length).toBe(1);
	});
});

describe('#3401 — malformed progress payloads fail closed', () => {
	const cases: Array<{
		name: string;
		call: string;
		envelope: Record<string, unknown>;
	}> = [
		{
			name: 'missing call id',
			call: 'call_g_mal0',
			envelope: {
				type: 'session.tool.progress',
				data: { sessionID: PARENT, metadata: { sessionID: 'ses_c_mal0' } },
			},
		},
		{
			name: 'empty child id',
			call: 'call_g_mal1',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: PARENT,
					id: 'call_g_mal1',
					metadata: { sessionID: '' },
				},
			},
		},
		{
			name: 'non-string child id',
			call: 'call_g_mal2',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: PARENT,
					id: 'call_g_mal2',
					metadata: { sessionID: 42 },
				},
			},
		},
		{
			name: 'array metadata (isPlainObject gate)',
			call: 'call_g_mal3',
			envelope: {
				type: 'session.tool.progress',
				data: { sessionID: PARENT, id: 'call_g_mal3', metadata: ['ses_c_arr'] },
			},
		},
		{
			name: 'null metadata',
			call: 'call_g_mal4',
			envelope: {
				type: 'session.tool.progress',
				data: { sessionID: PARENT, id: 'call_g_mal4', metadata: null },
			},
		},
		{
			name: 'non-string parent session id',
			call: 'call_g_mal5',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: 7,
					id: 'call_g_mal5',
					metadata: { sessionID: 'ses_c_mal5' },
				},
			},
		},
		{
			name: 'over-long child id (bounded-id cap)',
			call: 'call_g_mal6',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: PARENT,
					id: 'call_g_mal6',
					metadata: { sessionID: 'x'.repeat(257) },
				},
			},
		},
		// (the bounded tool-NAME cap is exercised by its own test below — it
		// needs a long name registered on input.started, not a progress
		// envelope)
	];

	for (const testCase of cases) {
		test(`${testCase.name} drops the progress event`, async () => {
			await expectDropsVsControl(
				[inputStarted(PARENT, testCase.call, 'subagent'), testCase.envelope],
				[
					inputStarted(PARENT, testCase.call, 'subagent'),
					progress(PARENT, testCase.call, 'ses_c_control'),
				],
			);
		});
	}

	test('an over-long tool name is never recorded (control still qualifies)', async () => {
		const call = 'call_g_longname';
		const longName = `subagent${'x'.repeat(300)}`;
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, longName),
			progress(PARENT, call, 'ses_c_longname'),
		]);
		expect(drained).toBe(true);
		expect(qualifyingParts(received).length).toBe(0);
		// The same call with a bounded name qualifies — the drop was the name
		// cap, not a dead harness.
		await resetToolNameRegistry();
		const control = await pumpEnvelopes([
			inputStarted(PARENT, call, 'subagent'),
			progress(PARENT, call, 'ses_c_longname'),
		]);
		expect(qualifyingParts(control.received).length).toBe(1);
	});
});

describe('#3401 — hostile payload shapes cannot kill the pump', () => {
	test('a throwing metadata accessor is contained and the pump keeps dispatching', async () => {
		const call = 'call_g_thr';
		const hostile = {
			type: 'session.tool.progress',
			data: {
				sessionID: PARENT,
				id: call,
				metadata: {
					get sessionID(): string {
						throw new Error('boom');
					},
				},
			},
		};
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, 'subagent'),
			hostile,
			toolCalled(PARENT, 'call_g_after'),
		]);
		expect(drained).toBe(true);
		expect(qualifyingParts(received).length).toBe(0);
		// The pump survived the hostile envelope and kept dispatching.
		expect(flatToolCalledEvents(received).length).toBe(1);
	});

	test('whitespace-only ids are rejected by the production trim guards', async () => {
		const variants: Array<{ call: string; envelope: Record<string, unknown> }> =
			[
				{
					call: 'call_g_wsparent',
					envelope: {
						type: 'session.tool.progress',
						data: {
							sessionID: '   ',
							id: 'call_g_wsparent',
							metadata: { sessionID: 'ses_c_wsp' },
						},
					},
				},
				{
					call: 'call_g_wscall',
					envelope: {
						type: 'session.tool.progress',
						data: {
							sessionID: PARENT,
							id: '  ',
							metadata: { sessionID: 'ses_c_wsc' },
						},
					},
				},
				{
					call: 'call_g_wschild',
					envelope: {
						type: 'session.tool.progress',
						data: {
							sessionID: PARENT,
							id: 'call_g_wschild',
							metadata: { sessionID: ' \t ' },
						},
					},
				},
			];
		for (const variant of variants) {
			await resetToolNameRegistry();
			await expectDropsVsControl(
				[inputStarted(PARENT, variant.call, 'subagent'), variant.envelope],
				[
					inputStarted(PARENT, variant.call, 'subagent'),
					progress(PARENT, variant.call, 'ses_c_control'),
				],
			);
		}
	});
});
