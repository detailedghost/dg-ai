import type { MailboxCleanupBrowserSeam } from "@/lib/background/mailbox-cleanup-composition";
import {
	MAILBOX_CLI_APPROVAL_DECISION_TYPE,
	MAILBOX_CLI_CONNECT_TYPE,
	type MailboxCliConnection,
	type MailboxCliRuntimeSender,
} from "@/lib/features/mailbox-cleanup/cli-transport";
import type { SessionStorageSeam } from "@/lib/features/mailbox-cleanup/storage";

export type MailboxCoreConformanceBrowserHarness = ReturnType<
	typeof createMailboxCoreConformanceBrowserHarness
>;

export async function waitForMailboxCore<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 5_000; attempt += 1) {
		const value = await read();
		if (done(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Timed out waiting for mailbox core conformance");
}

export function createMailboxCoreConformanceBrowserHarness() {
	const listeners = new Set<
		(value: unknown, sender?: MailboxCliRuntimeSender) => unknown
	>();
	const session = new Map<string, unknown>();
	const local = new Map<string, unknown>();
	const tabs: string[] = [];
	const downloads: unknown[] = [];
	const chatInbound: unknown[] = [];
	const downloadStates = new Map<
		number,
		"in_progress" | "complete" | "interrupted"
	>();
	const area = (values: Map<string, unknown>) => ({
		async get(key: string) {
			return values.has(key)
				? { [key]: structuredClone(values.get(key)) }
				: {};
		},
		async set(input: Record<string, unknown>) {
			for (const [key, value] of Object.entries(input)) {
				values.set(key, structuredClone(value));
			}
		},
		async remove(key: string) {
			values.delete(key);
		},
	});
	const dispatch = async (
		value: unknown,
		sender?: MailboxCliRuntimeSender,
	): Promise<unknown> => {
		const results = await Promise.all(
			[...listeners].map((listener) => listener(value, sender)),
		);
		return results[0];
	};
	const browser: MailboxCleanupBrowserSeam = {
		runtime: {
			getURL: (path) => `chrome-extension://dgtest/${path}`,
			async sendMessage(value) {
				if (
					value !== null &&
					typeof value === "object" &&
					(value as { type?: unknown }).type ===
						"dg-mailbox-cleanup:chat-inbound"
				) {
					chatInbound.push(structuredClone(value));
					return;
				}
				return dispatch(value);
			},
			onMessage: {
				addListener: (listener) => listeners.add(listener),
				removeListener: (listener) => listeners.delete(listener),
			},
		},
		storage: {
			session: area(session),
			local: area(local),
		},
		downloads: {
			async download(value) {
				downloads.push(structuredClone(value));
				const id = downloads.length;
				downloadStates.set(id, "complete");
				return id;
			},
			async search({ id }) {
				const state = downloadStates.get(id);
				return state === undefined ? [] : [{ id, state }];
			},
		},
		tabs: {
			async create(value) {
				tabs.push(value.url);
				return { id: tabs.length };
			},
		},
	};
	const sessionSeam: SessionStorageSeam = {
		async get(key) {
			return session.get(key);
		},
		async set(key, value) {
			session.set(key, structuredClone(value));
		},
		async delete(key) {
			session.delete(key);
		},
	};
	return {
		browser,
		chatInbound,
		dispatch,
		downloads,
		downloadStates,
		listeners,
		local,
		session,
		sessionSeam,
		tabs,
	};
}

export function mailboxCoreCliConnection(seed = 1): MailboxCliConnection {
	return Object.freeze({
		schemaVersion: 1,
		origin: "http://127.0.0.1:45678",
		runAlias: `run_0123456789abcdef01234567${seed
			.toString(16)
			.padStart(8, "0")}`,
		nonce: `fedcba9876543210fedcba98${seed
			.toString(16)
			.padStart(8, "0")}`,
		token:
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	});
}

function cliSender(
	connection: MailboxCliConnection,
	tabId: number,
): MailboxCliRuntimeSender {
	const url =
		`${connection.origin}/mailbox-cleanup/v1/connect/${connection.runAlias}`;
	return Object.freeze({
		id: "dgtest",
		url,
		frameId: 0,
		tab: Object.freeze({ id: tabId, url }),
	});
}

export async function approveMailboxCoreCli(
	harness: MailboxCoreConformanceBrowserHarness,
	connection: MailboxCliConnection,
	tabId: number,
): Promise<Readonly<{
	approvalUrl: string;
	connectionResult: Promise<unknown>;
}>> {
	const tabOffset = harness.tabs.length;
	const connectionResult = harness.dispatch(
		{ type: MAILBOX_CLI_CONNECT_TYPE, connection },
		cliSender(connection, tabId),
	);
	await waitForMailboxCore(
		async () => harness.tabs.length,
		(length) => length > tabOffset,
	);
	const approvalUrl = harness.tabs[tabOffset]!;
	const approvalAlias = new URL(approvalUrl).hash.slice(
		"#approval=".length,
	);
	await harness.dispatch(
		{
			type: MAILBOX_CLI_APPROVAL_DECISION_TYPE,
			approvalAlias,
			decision: "approve",
		},
		{
			id: "dgtest",
			url: approvalUrl,
			frameId: 0,
			tab: { id: tabOffset + 1, url: approvalUrl },
		},
	);
	return Object.freeze({ approvalUrl, connectionResult });
}
