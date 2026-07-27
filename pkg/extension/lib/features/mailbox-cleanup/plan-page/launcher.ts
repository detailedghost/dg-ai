import {
	MAILBOX_REASON_CODES,
	preflightMailboxValue,
	validateMailboxPlanRevision,
	type MailboxPlanRevision,
	type MailboxReasonCode,
} from "@dg/common";
import type { MailboxChatSubmitResult } from "../bridge";
import {
	validateMailboxPlanBootstrap,
	writeAndOpenMailboxPlan,
	type MailboxPlanOpenDeps,
} from "./bootstrap";
import type { MailboxPlanWorkspaceInput } from "./contracts";

export type MailboxCleanupHostAdapter = MailboxPlanOpenDeps &
	Readonly<{
		capture(): Promise<MailboxPlanWorkspaceInput>;
		waitForChatTerminal(
			marker: Readonly<{ planAlias: string }>,
		): Promise<unknown>;
	}>;

export class MailboxCleanupLaunchError extends Error {
	override readonly name = "MailboxCleanupLaunchError";

	constructor(
		readonly code:
			| "capture_failed"
			| "handoff_failed"
			| "terminal_failed",
	) {
		super(`Mailbox cleanup host failed safely: ${code}`);
	}
}

function invalidTerminal(): never {
	throw new Error("Invalid mailbox cleanup terminal result");
}

function exactTerminal(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	try {
		preflightMailboxValue(value);
	} catch {
		invalidTerminal();
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		invalidTerminal();
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Object.keys(descriptors).length !== keys.length ||
		keys.some(
			(key) =>
				!Object.hasOwn(descriptors, key) ||
				!("value" in (descriptors[key] ?? {})),
		) ||
		Object.keys(descriptors).some((key) => !keys.includes(key))
	) {
		invalidTerminal();
	}
	return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function terminalResult(
	value: unknown,
	planAlias: string,
): MailboxChatSubmitResult {
	const status =
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
			? Object.getOwnPropertyDescriptor(value, "status")?.value
			: undefined;
	if (status === "canceled") {
		exactTerminal(value, ["status"]);
		return Object.freeze({ status: "canceled" });
	}
	if (status === "error") {
		const input = exactTerminal(value, ["status", "code"]);
		if (
			typeof input.code !== "string" ||
			!MAILBOX_REASON_CODES.includes(input.code as MailboxReasonCode)
		) {
			invalidTerminal();
		}
		return Object.freeze({
			status: "error",
			code: input.code as MailboxReasonCode,
		});
	}
	if (status === "proposal") {
		const input = exactTerminal(value, ["status", "proposal"]);
		let proposal: MailboxPlanRevision;
		try {
			proposal = deepFreeze(
				validateMailboxPlanRevision(structuredClone(input.proposal)),
			);
		} catch {
			invalidTerminal();
		}
		if (proposal.planAlias !== planAlias || proposal.state !== "draft") {
			invalidTerminal();
		}
		return deepFreeze({ status: "proposal", proposal });
	}
	invalidTerminal();
}

export async function launchMailboxCleanupPlan(
	host: MailboxCleanupHostAdapter,
): Promise<MailboxChatSubmitResult> {
	let input: MailboxPlanWorkspaceInput;
	try {
		const captured = structuredClone(await host.capture()) as
			MailboxPlanWorkspaceInput & {
				capture: MailboxPlanWorkspaceInput["capture"] & {
					bodyChecks?: unknown;
				};
			};
		delete captured.capture.bodyChecks;
		input = validateMailboxPlanBootstrap(captured);
	} catch {
		throw new MailboxCleanupLaunchError("capture_failed");
	}
	try {
		await writeAndOpenMailboxPlan(input, host);
	} catch {
		throw new MailboxCleanupLaunchError("handoff_failed");
	}
	try {
		return terminalResult(
			await host.waitForChatTerminal(
				Object.freeze({ planAlias: input.baseRevision.planAlias }),
			),
			input.baseRevision.planAlias,
		);
	} catch {
		throw new MailboxCleanupLaunchError("terminal_failed");
	}
}
