import { browser } from "wxt/browser";
import {
	MAILBOX_CLI_APPROVAL_DECISION_TYPE,
	MAILBOX_CLI_APPROVAL_INSPECT_TYPE,
	type MailboxCliApprovalView,
} from "@/lib/features/mailbox-cleanup/cli-transport";

const APPROVAL_ALIAS = /^cli_[a-f0-9]{32}$/;
const RETRY_LIMIT = 20;
const RETRY_DELAY_MS = 100;

function approvalAlias(): string {
	const parameters = new URLSearchParams(location.hash.slice(1));
	const values = parameters.getAll("approval");
	if (
		values.length !== 1 ||
		[...parameters.keys()].some((key) => key !== "approval") ||
		!APPROVAL_ALIAS.test(values[0] ?? "")
	) {
		throw new Error("Invalid mailbox CLI approval");
	}
	return values[0] as string;
}

function element(id: string): HTMLElement {
	const value = document.getElementById(id);
	if (value === null) throw new Error("Mailbox CLI approval is unavailable");
	return value;
}

function validView(value: unknown): value is MailboxCliApprovalView {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return false;
	}
	const input = value as Record<string, unknown>;
	return (
		Object.keys(input).length === 4 &&
		input.schemaVersion === 1 &&
		typeof input.origin === "string" &&
		typeof input.runAlias === "string" &&
		typeof input.expiresAt === "string"
	);
}

async function inspect(alias: string): Promise<MailboxCliApprovalView> {
	for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
		try {
			const value = await browser.runtime.sendMessage({
				type: MAILBOX_CLI_APPROVAL_INSPECT_TYPE,
				approvalAlias: alias,
			});
			if (validView(value)) return value;
		} catch {
			// The approval tab can load before the pending record is installed.
		}
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	}
	throw new Error("Mailbox CLI approval expired");
}

async function main(): Promise<void> {
	const alias = approvalAlias();
	const approve = element("approve") as HTMLButtonElement;
	const deny = element("deny") as HTMLButtonElement;
	const status = element("status");
	let decided = false;
	const setDisabled = (value: boolean): void => {
		approve.disabled = value;
		deny.disabled = value;
	};
	const decide = async (decision: "approve" | "deny"): Promise<void> => {
		if (decided) return;
		decided = true;
		setDisabled(true);
		try {
			await browser.runtime.sendMessage({
				type: MAILBOX_CLI_APPROVAL_DECISION_TYPE,
				approvalAlias: alias,
				decision,
			});
			status.textContent =
				decision === "approve"
					? "Connection authorized once. You may close this tab."
					: "Connection denied. You may close this tab.";
		} catch {
			status.textContent =
				"Authorization was not completed. Start the CLI command again.";
		}
	};

	window.addEventListener("pagehide", () => {
		if (decided) return;
		decided = true;
		void browser.runtime.sendMessage({
			type: MAILBOX_CLI_APPROVAL_DECISION_TYPE,
			approvalAlias: alias,
			decision: "deny",
		}).catch(() => undefined);
	});
	approve.addEventListener("click", () => void decide("approve"));
	deny.addEventListener("click", () => void decide("deny"));
	setDisabled(true);
	try {
		const view = await inspect(alias);
		element("origin").textContent = view.origin;
		element("run").textContent = view.runAlias;
		element("expires").textContent = new Date(view.expiresAt).toLocaleTimeString();
		status.textContent =
			"Review the endpoint, then authorize or deny this one-time connection.";
		setDisabled(false);
	} catch {
		status.textContent =
			"This request is unavailable or expired. Start the CLI command again.";
	}
}

void main();
