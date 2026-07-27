import type { Command } from "commander";
import type { MailboxChatSubmitResult } from "../../../extension/lib/features/mailbox-cleanup/bridge/contracts";
import {
	launchMailboxCleanupPlan,
	type MailboxCleanupHostAdapter as ExtensionMailboxCleanupHostAdapter,
} from "../../../extension/lib/features/mailbox-cleanup/plan-page/launcher";

export type MailboxCleanupHostAdapter =
	ExtensionMailboxCleanupHostAdapter;

export async function runMailboxCleanup(
	host: MailboxCleanupHostAdapter,
): Promise<MailboxChatSubmitResult> {
	return launchMailboxCleanupPlan(host);
}

export function registerMailboxCleanup(
	program: Command,
	host?: MailboxCleanupHostAdapter,
): void {
	program
		.command("mailbox-cleanup")
		.description(
			"capture a mailbox and open a sanitized cleanup plan for review",
		)
		.action(async () => {
			if (host === undefined) {
				throw new Error(
					"mailbox-cleanup requires an installed, connected dg-ai-extension mailbox host",
				);
			}
			const result = await runMailboxCleanup(host);
			switch (result.status) {
				case "proposal":
					console.log("Mailbox cleanup proposal is ready for review.");
					break;
				case "canceled":
					console.log("Mailbox cleanup was canceled.");
					break;
				case "error":
					console.log(`Mailbox cleanup stopped: ${result.code}.`);
					break;
			}
		});
}
