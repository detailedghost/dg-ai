import { createHash } from "node:crypto";
import { join } from "node:path";
import { getNumberFlag, type CliFlags } from "../cli/args";
import { type CliContext, workspaceDirForContext } from "../cli/context";
import { printJson } from "../cli/output";
import { inboxRuntimeFor } from "../runtime";
import { writeJsonFile } from "../utils/json";
import { createMailAccessClient } from "./factory";
import { resolveId, UNKNOWN_MESSAGE_ID } from "./ids";
import type { MailMessage } from "./types";

const SEND_APPROVAL_TIMEOUT_PATTERN = /timed out/i;

type SendAuditRecord = {
	draftIdHash: string;
	contentHash: string;
	approvedAt: string;
	provider: string;
	sent: boolean;
};

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function contentHashOf(
	draft: Pick<MailMessage, "to" | "cc" | "subject" | "text">,
): string {
	return sha256Hex(
		JSON.stringify({
			to: draft.to,
			cc: draft.cc,
			subject: draft.subject,
			text: draft.text,
		}),
	);
}

function validateWaitSeconds(flags: CliFlags): number {
	const wait = getNumberFlag(flags, "wait", 300);
	if (!Number.isInteger(wait) || wait < 1 || wait > 600)
		throw new Error("--wait must be between 1 and 600");
	return wait;
}

async function writeSendAudit(
	context: CliContext,
	record: SendAuditRecord,
): Promise<void> {
	const path = join(
		workspaceDirForContext(context),
		"audit",
		`${new Date().toISOString().replace(/[:.]/g, "-")}-mail-send.json`,
	);
	await writeJsonFile(path, record);
}

/** Drives a draft through human approval, a post-decision hash re-check, and send. */
export async function sendDraftWithApproval(
	context: CliContext,
	hashedDraftId: string,
): Promise<void> {
	const runtime = inboxRuntimeFor(context.config).runtime;
	if (!runtime.sendApproval) {
		printJson({ kind: "mail-send-refused", reason: "no-approval-channel" });
		process.exitCode = 1;
		return;
	}
	const waitSeconds = validateWaitSeconds(context.args.flags);
	const workspaceDir = workspaceDirForContext(context);
	const providerId = await resolveId(workspaceDir, hashedDraftId);
	if (!providerId) throw new Error(UNKNOWN_MESSAGE_ID);
	const client = createMailAccessClient(context.config, runtime);
	const draft = await client.getDraft(providerId);
	const contentHash = contentHashOf(draft);

	let decision: { approved: boolean; decidedAt: string };
	try {
		decision = await runtime.sendApproval({
			provider: context.config.provider,
			profile: inboxRuntimeFor(context.config).profile,
			draftId: hashedDraftId,
			to: draft.to,
			cc: draft.cc,
			subject: draft.subject,
			text: draft.text,
			attachments: draft.attachments.map((attachment) => attachment.name),
			contentHash,
			timeoutMs: waitSeconds * 1000,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (SEND_APPROVAL_TIMEOUT_PATTERN.test(message)) {
			printJson({
				kind: "mail-send-timeout",
				draftId: hashedDraftId,
				waitedSeconds: waitSeconds,
			});
			process.exitCode = 1;
			return;
		}
		throw error;
	}

	if (!decision.approved) {
		printJson({
			kind: "mail-send-rejected",
			draftId: hashedDraftId,
			decidedAt: decision.decidedAt,
		});
		process.exitCode = 1;
		return;
	}

	const refreshed = await client.getDraft(providerId);
	if (contentHashOf(refreshed) !== contentHash) {
		printJson({ kind: "mail-send-aborted", reason: "draft-changed" });
		process.exitCode = 1;
		return;
	}

	try {
		await client.sendDraft(providerId);
	} catch {
		await writeSendAudit(context, {
			draftIdHash: hashedDraftId,
			contentHash,
			approvedAt: decision.decidedAt,
			provider: context.config.provider,
			sent: false,
		});
		printJson({
			kind: "mail-send-failed",
			draftId: hashedDraftId,
			approval: { by: "extension", decidedAt: decision.decidedAt },
		});
		process.exitCode = 1;
		return;
	}

	await writeSendAudit(context, {
		draftIdHash: hashedDraftId,
		contentHash,
		approvedAt: decision.decidedAt,
		provider: context.config.provider,
		sent: true,
	});
	printJson({
		kind: "mail-sent",
		draftId: hashedDraftId,
		approval: { by: "extension", decidedAt: decision.decidedAt },
	});
}
