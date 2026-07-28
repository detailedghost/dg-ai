import type { Command } from "commander";
import type { MailboxChatSubmitResult } from "../../../extension/lib/features/mailbox-cleanup/bridge/contracts";
import {
	launchMailboxCleanupPlan,
	type MailboxCleanupHostAdapter as ExtensionMailboxCleanupHostAdapter,
} from "../../../extension/lib/features/mailbox-cleanup/plan-page/launcher";
import { runMailboxCleanupLoopback } from "./mailbox-loopback";

export type MailboxCleanupHostAdapter =
	ExtensionMailboxCleanupHostAdapter;

export type MailboxCleanupCommandRunner =
	() => Promise<MailboxChatSubmitResult>;

export async function runMailboxCleanup(
	host: MailboxCleanupHostAdapter,
): Promise<MailboxChatSubmitResult> {
	return launchMailboxCleanupPlan(host);
}

export function registerMailboxCleanup(
	program: Command,
	host?: MailboxCleanupHostAdapter,
	runConcrete: MailboxCleanupCommandRunner = runMailboxCleanupLoopback,
): void {
	program
		.command("mailbox-cleanup")
		.description(
			"capture a mailbox and open a sanitized cleanup plan for review",
		)
		.action(async () => {
			const result =
				host === undefined
					? await runConcrete()
					: await runMailboxCleanup(host);
			switch (result.status) {
				case "proposal":
					console.error("Mailbox cleanup proposal is ready for review.");
					break;
				case "canceled":
					console.error("Mailbox cleanup was canceled.");
					break;
				case "error":
					console.error(`Mailbox cleanup stopped: ${result.code}.`);
					break;
			}
		});
}
