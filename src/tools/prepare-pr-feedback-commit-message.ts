/**
 * prepare_pr_feedback_commit_message — sanctioned authoring surface for
 * PR_FEEDBACK commit messages that contain shell metacharacters (issue #3315
 * D8, Option B).
 *
 * The PR_FEEDBACK shell classifier deliberately rejects `git commit -m`
 * payloads containing `; & < >`, backtick, newline, or command substitution
 * regardless of quoting (cross-shell injection safety), so an attribution
 * trailer such as `Co-Authored-By: X <noreply@anthropic.com>` cannot be
 * committed inline. `git commit -F <file>` is admitted by the classifier, but
 * only for a message file that resolves OUTSIDE the repository (an in-repo
 * message file is an untracked file that breaks the clean-tree arming check,
 * and architect write containment refuses outside-repo writes). This tool is
 * the missing authoring step: it writes the exact message bytes to a
 * deterministic file under the OS temp directory (outside every repository)
 * and returns the path to hand to `git commit -F`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readPrWorkflowGateState } from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool';

const MAX_COMMIT_MESSAGE_CHARS = 8192;

const PreparePrFeedbackCommitMessageArgsSchema = z
	.object({
		message: z
			.string()
			.min(1)
			.max(MAX_COMMIT_MESSAGE_CHARS)
			.refine((value) => !value.includes('\0'), {
				message: 'message must not contain NUL bytes',
			}),
	})
	.strict();

/** Deterministic, outside-every-repository home for the authored message. */
export function resolvePrFeedbackCommitMessageFilePath(
	sessionID: string,
	message: string,
): string {
	const sanitizedSession = sessionID.replace(/[^A-Za-z0-9._-]/g, '_');
	const digest = createHash('sha256')
		.update(message, 'utf8')
		.digest('hex')
		.slice(0, 16);
	return path.join(
		tmpdir(),
		'swarm-pr-feedback-commit-msg',
		`${sanitizedSession}-${digest}.txt`,
	);
}

export async function executePreparePrFeedbackCommitMessage(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = PreparePrFeedbackCommitMessageArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid commit-message request: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const sessionID = context.sessionID?.trim();
	if (!sessionID) {
		return JSON.stringify({
			success: false,
			message: 'Commit-message authoring requires an active sessionID',
		});
	}
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state || state.mode !== 'PR_FEEDBACK' || !state.prHeadSha) {
		return JSON.stringify({
			success: false,
			message:
				'Commit-message authoring requires an active bound PR_FEEDBACK workflow; bind the PR head first',
		});
	}
	const targetDir = path.join(tmpdir(), 'swarm-pr-feedback-commit-msg');
	const targetPath = resolvePrFeedbackCommitMessageFilePath(
		sessionID,
		parsed.data.message,
	);
	// Defense in depth: the file name is derived from a sanitized session id
	// and a content digest, but still prove the resolved path stays inside the
	// dedicated temp subdirectory before writing.
	const resolvedTarget = path.resolve(targetPath);
	if (
		path.resolve(targetDir) !== resolvedTarget &&
		!resolvedTarget.startsWith(path.resolve(targetDir) + path.sep)
	) {
		return JSON.stringify({
			success: false,
			message:
				'Commit-message file path escaped the swarm-pr-feedback-commit-msg directory; refusing to write',
		});
	}
	try {
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(resolvedTarget, parsed.data.message, 'utf8');
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: `Could not author the commit-message file: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
	return JSON.stringify({
		success: true,
		path: resolvedTarget,
		message:
			'Commit-message file authored outside the repository; commit with git commit -F <path> (the classifier refuses in-repo message files). The file lives in the OS temp directory and never touches the bound checkout.',
	});
}

export const prepare_pr_feedback_commit_message: ReturnType<
	typeof createSwarmTool
> = createSwarmTool({
	description:
		'Author a PR_FEEDBACK commit message that contains shell metacharacters (e.g. a Co-Authored-By trailer with <...>) into a file OUTSIDE the repository, returning the path for the sanctioned git commit -F command. The inline -m form is rejected by the shell classifier by design; an in-repo message file would dirty the clean-tree arming check. Requires an active bound PR_FEEDBACK workflow.',
	args: {
		message: PreparePrFeedbackCommitMessageArgsSchema.shape.message,
	},
	execute: executePreparePrFeedbackCommitMessage,
});
