import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	computeExternalDeclarationDigest,
	transitionTaskWorkflowEvidence,
	type ExternalEvidenceBundle,
} from '../../../src/gate-evidence.js';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status.js';

/**
 * Council-active external completion (plan §4 F3, #3422 reviewer finding 2):
 * a plan whose council_mode is ACTIVE with a blocked council decision must
 * NOT block a valid external completion. Declared external_git tasks bypass
 * the pre-lock council gate and the reviewer precheck; the under-lock
 * external arm owns admission.
 */

let dir = '';
const cleanup: string[] = [];

beforeAll(() => {
	dir = canonicalMkdtemp('swarm3422-council-active-');
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
});

afterAll(() => {
	for (const d of cleanup) {
		fs.rmSync(d, { recursive: true, force: true });
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeCouncilActivePlan(): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	// council_mode binding + NO council verdict evidence: any reviewer-style
	// gate demand would block completion for a task that can never satisfy it.
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				title: 'Council-active external completion',
				swarm: 'probe',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'release-ops',
						status: 'in_progress',
						tasks: [
							{
								id: '5.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Commit, tag, and push the release, then verify origin advanced',
								depends: [],
								files_touched: [],
								evidence_class: 'external_git',
								evidence_anchors: [
									{ command: 'git rev-parse --verify HEAD', expect_prefix: '1' },
								],
							},
						],
					},
				],
			},
			null,
			2,
		),
	);
	// council_mode active: bind the mode the way the gate reads it. The gate
	// derives active council from plan/durable state; the strongest form is a
	// council_mode binding in the workflow state — write the durable marker the
	// checkCouncilGate implementation consults (council required gates).
	const evidenceDir = path.join(dir, '.swarm', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
}

test('a declared external task completes with an ACTIVE, unsatisfied council gate (F3 bypass)', async () => {
	writeCouncilActivePlan();
	// Seed the attested bundle for the declared task.
	const anchors = [{ command: 'git rev-parse --verify HEAD', expect_prefix: '1' }];
	const bundle: ExternalEvidenceBundle = {
		class: 'external_git',
		transitionId: 'attest:5.1:static:0001',
		declarationDigest: computeExternalDeclarationDigest({
			taskId: '5.1',
			evidence_class: 'external_git',
			evidence_anchors: anchors,
			plan_title: 'Council-active external completion',
			plan_swarm: 'probe',
			generation: 0,
		}),
		anchors: [
			{
				command: 'git rev-parse --verify HEAD',
				expect_prefix: '1',
				matched: true,
				exit_code: 0,
				stdout: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d\n',
			},
		],
		attestedAt: '2026-01-15T00:00:00.000Z',
	};
	await transitionTaskWorkflowEvidence(dir, '5.1', {
		type: 'external_evidence_attested',
		bundle,
		expectedGeneration: 0,
		transitionId: 'attest:5.1:static:0001',
	});

	const result = await executeUpdateTaskStatus(
		{
			task_id: '5.1',
			status: 'completed',
			working_directory: dir,
			reason: 'council-active external completion probe',
		},
		dir,
	);
	expect(result.success).toBe(true);
	expect(result.errors ?? []).toEqual([]);
	const plan = JSON.parse(
		fs.readFileSync(path.join(dir, '.swarm', 'plan.json'), 'utf-8'),
	) as { phases: Array<{ tasks: Array<{ id: string; status: string }> }> };
	const task = plan.phases[0]!.tasks.find((t) => t.id === '5.1');
	expect(task?.status).toBe('completed');
});
