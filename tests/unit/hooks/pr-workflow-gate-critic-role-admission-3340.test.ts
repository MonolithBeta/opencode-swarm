// Issue #3340 — gate-side critic admission (AC1) and the PR_FEEDBACK
// closeout-critic role decision (AC2), enforced at the gate boundary rather
// than only at the dispatch call site.
//
// AC1: `recordPrReviewValidationBatch` must reject any critic-phase lane whose
// declared agent does not resolve to exactly `critic` (#3310 enforced this at
// dispatch only). RED at base: the recorder accepted any lane spec.
//
// AC2 (recorded decision): a PR_FEEDBACK closeout-critic child session that ran
// a critic-family role other than `critic` is NOT accepted — the closeout gate
// settles on one [CLOSEOUT-CRITIC] verdict row per feedback item, the same
// row-emission contract the other critic-family agents cannot produce. RED at
// base: `assertIndependentFeedbackGateSessions` admitted any `critic_`-prefixed
// role.
//
// Issue item 2: `analyzeLaneArtifactIntegrity` now asserts the critic role for
// `swarm-pr-review:critic` artifacts instead of only checking that the artifact
// role matches the delegation record.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrFeedbackGatePhaseSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	PR_REVIEW_BASE_DIMENSION_IDS,
	type PrFeedbackGatePhase,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID as REVIEW_SESSION,
	tempDir as reviewTempDir,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
} from './pr-workflow-gate.test-fixtures.js';

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension: string, index: number) => `C-${index}`,
);

const REVIEWER_ROWS = ITEM_IDS.map(
	(itemId: string) =>
		`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | LOW | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer`,
).join('\n');
const CRITIC_ROWS = ITEM_IDS.map(
	(itemId: string) =>
		`[CRITIC] | ${itemId} | UPHELD | LOW | reason long enough | required change text`,
).join('\n');

const ROLE_REJECTION = /must use the critic agent/;
const AGENT_DECLARATION_REJECTION = /must declare its agent/;

describe('issue #3340 AC1: gate-side critic admission in recordPrReviewValidationBatch', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('rejects a critic lane whose declared agent is critic_finding_validator (bypassing dispatch)', async () => {
		await expect(
			recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-bad-role',
						workflowLane: 'critic-bad-role',
						reviewItemIds: ITEM_IDS,
						agent: 'critic_finding_validator',
					},
				],
				{ batchId: 'critic-bad-role', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(ROLE_REJECTION);
	});

	test('rejects a critic lane that declares no agent at all (fail closed)', async () => {
		await expect(
			recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-no-agent',
						workflowLane: 'critic-no-agent',
						reviewItemIds: ITEM_IDS,
					},
				],
				{ batchId: 'critic-no-agent', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(AGENT_DECLARATION_REJECTION);
	});

	test('rejects an unregistered prefixed name when the generated-name registry is supplied (dispatch parity)', async () => {
		// 'foo_critic' is not a generated agent name; the strict registry
		// resolution must not collapse it onto the critic role.
		await expect(
			recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-foreign-suffix',
						workflowLane: 'critic-foreign-suffix',
						reviewItemIds: ITEM_IDS,
						agent: 'foo_critic',
					},
				],
				{
					batchId: 'critic-foreign-suffix',
					prHeadSha: HEAD_SHA,
					generatedAgentNames: ['mega_critic', 'mega_reviewer'],
				},
			),
		).rejects.toThrow(ROLE_REJECTION);
	});

	test("admits a registered prefixed critic agent ('mega_critic') — never a role rejection", async () => {
		// The batch may later be refused for unrelated setup reasons on this
		// fixture; the assertion is that the role rule itself is satisfied.
		let lateError: unknown = null;
		try {
			await recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-prefixed',
						workflowLane: 'critic-prefixed',
						reviewItemIds: ITEM_IDS,
						agent: 'mega_critic',
					},
				],
				{
					batchId: 'critic-prefixed',
					prHeadSha: HEAD_SHA,
					generatedAgentNames: ['mega_critic', 'mega_reviewer'],
				},
			);
		} catch (error) {
			lateError = error;
		}
		expect(lateError === null || !ROLE_REJECTION.test(String(lateError))).toBe(
			true,
		);
	});

	test('records the batch when the declared agent is exactly critic', async () => {
		await establishReviewPrerequisites();
		const reviewerLanes = [
			{ laneId: 'rv-3340', workflowLane: 'rv-3340', reviewItemIds: ITEM_IDS },
		];
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'reviewer',
			reviewerLanes,
			{ batchId: 'rv-3340', prHeadSha: HEAD_SHA },
		);
		await persistBatch('rv-3340', 'swarm-pr-review:reviewer', reviewerLanes, {
			textOverride: REVIEWER_ROWS,
		});
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
			[
				{
					laneId: 'critic-3340',
					workflowLane: 'critic-3340',
					reviewItemIds: ITEM_IDS,
					agent: 'critic',
				},
			],
			{ batchId: 'critic-3340', prHeadSha: HEAD_SHA },
		);
		// Recording succeeded; prove the batch is durable by persisting its
		// artifact and settling the critic phase on the real composition path.
		const criticLanes = [
			{
				laneId: 'critic-3340',
				workflowLane: 'critic-3340',
				reviewItemIds: ITEM_IDS,
			},
		];
		await persistBatch('critic-3340', 'swarm-pr-review:critic', criticLanes, {
			textOverride: CRITIC_ROWS,
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
		);
		expect(composed.unclaimed).toEqual([]);
	});
});

describe('issue #3340 item 2: critic-mode artifact integrity asserts the critic role', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a critic lane whose child record ran critic_finding_validator cannot claim items', async () => {
		await establishReviewPrerequisites();
		const reviewerLanes = [
			{
				laneId: 'rv-wrong-role',
				workflowLane: 'rv-wrong-role',
				reviewItemIds: ITEM_IDS,
			},
		];
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'reviewer',
			reviewerLanes,
			{ batchId: 'rv-wrong-role', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'rv-wrong-role',
			'swarm-pr-review:reviewer',
			reviewerLanes,
			{ textOverride: REVIEWER_ROWS },
		);
		// The batch is admitted at record time (the lane declares the critic
		// agent), but the child delegation record that actually ran carries
		// critic_finding_validator — artifact + record are self-consistent on
		// that wrong role, so only the role assertion can reject the pair.
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
			[
				{
					laneId: 'critic-wrong-role',
					workflowLane: 'critic-wrong-role',
					reviewItemIds: ITEM_IDS,
					agent: 'critic',
				},
			],
			{ batchId: 'critic-wrong-role', prHeadSha: HEAD_SHA },
		);
		const criticLanes = [
			{
				laneId: 'critic-wrong-role',
				workflowLane: 'critic-wrong-role',
				reviewItemIds: ITEM_IDS,
			},
		];
		await persistBatch(
			'critic-wrong-role',
			'swarm-pr-review:critic',
			criticLanes,
			{ textOverride: CRITIC_ROWS, recordAgent: 'critic_finding_validator' },
		);
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
		);
		expect(composed.claims.size).toBe(0);
		expect(composed.unclaimed).toEqual(ITEM_IDS);
	});
});

// AC2: PR_FEEDBACK closeout-critic role decision, enforced at the settle gate.
// Mirrors the ladder harness of pr-feedback-gate-verdict-floor-l3.test.ts.
describe('issue #3340 AC2: PR_FEEDBACK closeout-critic requires exactly the critic role', () => {
	const SESSION_ID = 'feedback-critic-role-3340';
	const FEEDBACK_HEAD_SHA = 'abc123';
	const REVISION = 'revision-1';
	const ITEM_ID = 'FB-001';
	let directory = '';
	const seamSnapshot = { ..._test_exports };

	const LADDER: readonly PrFeedbackGatePhase[] = [
		'stage-b-reviewer',
		'stage-b-test',
		'closeout-reviewer',
		'closeout-critic',
	];

	const PHASE_ARTIFACT: Readonly<
		Record<PrFeedbackGatePhase, { mode: string; role: string; text: string }>
	> = {
		'stage-b-reviewer': {
			mode: 'swarm-pr-feedback:stage-b-reviewer',
			role: 'reviewer',
			text: `[STAGE-B-REVIEW] | ${ITEM_ID} | APPROVE | evidence`,
		},
		'stage-b-test': {
			mode: 'swarm-pr-feedback:stage-b-test',
			role: 'test_engineer',
			text: `[STAGE-B-TEST] | ${ITEM_ID} | PASS | evidence`,
		},
		'closeout-reviewer': {
			mode: 'swarm-pr-feedback:closeout-reviewer',
			role: 'reviewer',
			text: `[CLOSEOUT-REVIEW] | ${ITEM_ID} | APPROVE | evidence`,
		},
		'closeout-critic': {
			mode: 'swarm-pr-feedback:closeout-critic',
			role: 'critic',
			text: `[CLOSEOUT-CRITIC] | ${ITEM_ID} | APPROVE | evidence`,
		},
	};

	async function persistFeedbackLaneArtifact(options: {
		batchId: string;
		laneId: string;
		mode: string;
		role: string;
		text: string;
	}): Promise<void> {
		const correlationId = `${options.batchId}--${options.laneId}`;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: SESSION_ID,
			callID: `call-${correlationId}`,
			normalizedAgent: options.role,
			swarmPrefixedAgent: options.role,
			planTaskId: null,
			evidenceTaskId: null,
			batchId: options.batchId,
			laneId: options.laneId,
			mode: options.mode,
			workflowLane: options.laneId,
			workspace: {
				directory,
				gitHead: FEEDBACK_HEAD_SHA,
				dirtyHash: REVISION,
				prHeadSha: FEEDBACK_HEAD_SHA,
				scope: null,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId: options.batchId,
			laneId: options.laneId,
			agent: options.role,
			role: options.role,
			sessionId: correlationId,
			parentSessionId: SESSION_ID,
			mode: options.mode,
			workflowLane: options.laneId,
			prHeadSha: FEEDBACK_HEAD_SHA,
			gitHead: FEEDBACK_HEAD_SHA,
			revisionDigest: REVISION,
			source: 'collect_lane_results',
			text: options.text,
		});
		await appendDelegationTransition(directory, correlationId, {
			status: 'completed',
			result: {
				text: options.text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				outputRef: stored.ref,
			},
		});
	}

	async function settleThroughStageA(): Promise<void> {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(directory, SESSION_ID, [ITEM_ID], {
			prHeadSha: FEEDBACK_HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			directory,
			SESSION_ID,
			[{ laneId: 'verify', ownedItemIds: [ITEM_ID] }],
			{ batchId: 'verify-1', prHeadSha: FEEDBACK_HEAD_SHA },
		);
		await persistFeedbackLaneArtifact({
			batchId: 'verify-1',
			laneId: 'verify',
			mode: 'swarm-pr-feedback:verification',
			role: 'reviewer',
			text: `[FEEDBACK-VERIFIED] | ${ITEM_ID} | CONFIRMED | evidence`,
		});
		await recordPrFeedbackStageA(directory, SESSION_ID, REVISION, [
			{ category: 'build', command: ['build'], durationMs: 1 },
			{ category: 'typecheck', command: ['typecheck'], durationMs: 1 },
			{ category: 'lint', command: ['lint'], durationMs: 1 },
			{
				category: 'diff-check',
				command: ['git', 'diff', '--check'],
				durationMs: 1,
			},
			{
				category: 'reproduction',
				command: ['test', 'regression'],
				targets: ['regression'],
				feedbackTargets: [
					{
						feedbackItemId: ITEM_ID,
						target: 'regression',
						expectedBehavior: 'regression remains fixed',
					},
				],
				durationMs: 1,
			},
		]);
	}

	async function recordGateBatch(
		phase: PrFeedbackGatePhase,
		role: string,
	): Promise<void> {
		const info = PHASE_ARTIFACT[phase];
		const batchId = `gate-${phase}`;
		await recordPrFeedbackGateBatch(
			directory,
			SESSION_ID,
			phase,
			{ laneId: phase, ownedItemIds: [ITEM_ID] },
			{ batchId, prHeadSha: FEEDBACK_HEAD_SHA, revisionDigest: REVISION },
		);
		await persistFeedbackLaneArtifact({
			batchId,
			laneId: phase,
			mode: info.mode,
			role,
			text: info.text,
		});
	}

	beforeEach(() => {
		directory = canonicalMkdtemp('gate-critic-role-3340-');
		mkdirSync(path.join(directory, '.git'), { recursive: true });
		_test_exports.resetTrackedStateCache();
		_test_exports.resolveCurrentGitHead = () => FEEDBACK_HEAD_SHA;
		_test_exports.resolveCurrentGitHeadAsync = async () => FEEDBACK_HEAD_SHA;
		_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION;
		_test_exports.resolveIsWorkingTreeClean = () => true;
		_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
		_test_exports.resolveCurrentUpstreamPushTarget = () => ({
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/pr-head',
			remoteTrackingRef: 'refs/remotes/origin/pr-head',
		});
		_test_exports.resolveCurrentUpstreamPushTargetAsync = async () => ({
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/pr-head',
			remoteTrackingRef: 'refs/remotes/origin/pr-head',
		});
		_test_exports.resolveRemoteRefsContainingHead = () => [
			'refs/remotes/origin/pr-head',
		];
		_test_exports.resolveRemoteRefsContainingHeadAsync = async () => [
			'refs/remotes/origin/pr-head',
		];
	});

	afterEach(async () => {
		Object.assign(_test_exports, seamSnapshot);
		_test_exports.resetTrackedStateCache();
		safeRmRecursive(directory);
	});

	test('a critic_finding_validator closeout child session is refused at the settle gate', async () => {
		await settleThroughStageA();
		for (const phase of LADDER.slice(0, LADDER.indexOf('closeout-critic'))) {
			await recordGateBatch(phase, PHASE_ARTIFACT[phase].role);
		}
		// The closeout-critic batch records, but its child session ran
		// critic_finding_validator — a critic-family role other than `critic`.
		// Decision (issue #3340): NOT accepted.
		await recordGateBatch('closeout-critic', 'critic_finding_validator');
		await expect(
			assertPrFeedbackGatePhaseSettled(
				directory,
				SESSION_ID,
				'closeout-critic',
			),
		).rejects.toThrow(
			/requires role critic, received critic_finding_validator/,
		);
	});

	test("a closeout child session that ran exactly 'critic' settles", async () => {
		await settleThroughStageA();
		for (const phase of LADDER) {
			await recordGateBatch(phase, PHASE_ARTIFACT[phase].role);
		}
		await expect(
			assertPrFeedbackGatePhaseSettled(
				directory,
				SESSION_ID,
				'closeout-critic',
			),
		).resolves.toBeDefined();
	});
});
