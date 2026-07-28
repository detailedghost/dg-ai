import { describe, expect, it } from "bun:test";
import { IDBFactory, indexedDB } from "fake-indexeddb";
import {
	createMailboxCleanupBackgroundComposition,
	type MailboxCleanupBrowserSeam,
} from "@/lib/background/mailbox-cleanup-composition";
import { createMailboxExecutionIndexedDbStorage } from "@/lib/background/mailbox-cleanup-storage";
import {
	computeMailboxCaptureChunkDigest,
	type MailboxCaptureChunk,
} from "@/lib/features/mailbox-cleanup/coordinator";
import {
	MAILBOX_CLI_APPROVAL_DECISION_TYPE,
	MAILBOX_CLI_APPROVAL_INSPECT_TYPE,
	MAILBOX_CLI_CONNECT_TYPE,
	MAILBOX_CLI_MARKER_KEY,
	parseMailboxCliMarker,
	stripMailboxCliMarker,
	type MailboxCliRuntimeSender,
} from "@/lib/features/mailbox-cleanup/cli-transport";
import { MAILBOX_PLAN_BOOTSTRAP_KEY } from "@/lib/features/mailbox-cleanup/plan-page";
import { createFakeMailboxProviderHarness } from "@/lib/features/mailbox-cleanup/providers/fake";
import {
	createBrowserRawBindingAlarms,
	createMailboxPlanStore,
	createRawBindingStore,
} from "@/lib/features/mailbox-cleanup/storage";
import {
	alias,
	bindingScope,
	captureResult,
	fingerprint,
	NOW_MS,
	revision,
} from "./mailbox-plan-page-fixtures";

const connection = Object.freeze({
	schemaVersion: 1 as const,
	origin: "http://127.0.0.1:45678",
	runAlias: "run_0123456789abcdef0123456789abcdef",
	nonce: "fedcba9876543210fedcba9876543210",
	token:
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});

function markerUrl(): string {
	const marker = Buffer.from(JSON.stringify(connection)).toString("base64url");
	return `${connection.origin}/mailbox-cleanup/v1/connect/${connection.runAlias}#${MAILBOX_CLI_MARKER_KEY}=${marker}`;
}

function browserHarness() {
	const listeners = new Set<
		(value: unknown, sender?: MailboxCliRuntimeSender) => unknown
	>();
	const session = new Map<string, unknown>();
	const local = new Map<string, unknown>();
	const openedTabs: string[] = [];
	const openedTabIds: number[] = [];
	const area = (values: Map<string, unknown>) => ({
		async get(key: string) {
			return { [key]: values.get(key) };
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
	const browser: MailboxCleanupBrowserSeam = {
		runtime: {
			getURL: (path) => `chrome-extension://dgtest/${path}`,
			async sendMessage() {},
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
			async download() {
				return 1;
			},
			async search(query) {
				return [{ id: query.id, state: "complete" }];
			},
		},
		tabs: {
			async create(value) {
				openedTabs.push(value.url);
				const id = openedTabs.length;
				openedTabIds.push(id);
				return { id };
			},
		},
	};
	return {
		browser,
		session,
		local,
		openedTabs,
		openedTabIds,
		async dispatch(value: unknown, sender?: MailboxCliRuntimeSender) {
			return Promise.all(
				[...listeners].map((listener) => listener(value, sender)),
			);
		},
		activeListeners: () => listeners.size,
	};
}

async function approvedConnect(
	harness: ReturnType<typeof browserHarness>,
): Promise<unknown[]> {
	const pending = harness.dispatch(
		{
			type: MAILBOX_CLI_CONNECT_TYPE,
			connection,
		},
		{
			id: "dgtest",
			frameId: 0,
			url:
				`${connection.origin}/mailbox-cleanup/v1/connect/` +
				connection.runAlias,
			tab: { id: 40 },
		},
	);
	while (
		!harness.openedTabs.some((url) =>
			url.includes("mailbox-cli-approval.html"),
		)
	) {
		await Promise.resolve();
	}
	const index = harness.openedTabs.findIndex((url) =>
		url.includes("mailbox-cli-approval.html"),
	);
	const approvalUrl = harness.openedTabs[index]!;
	const approvalAlias = new URL(approvalUrl).hash.slice(
		"#approval=".length,
	);
	const sender = {
		id: "dgtest",
		frameId: 0,
		url: approvalUrl,
		tab: { id: harness.openedTabIds[index] },
	};
	await Promise.resolve();
	await Promise.resolve();
	await harness.dispatch(
		{
			type: MAILBOX_CLI_APPROVAL_INSPECT_TYPE,
			approvalAlias,
		},
		sender,
	);
	await harness.dispatch(
		{
			type: MAILBOX_CLI_APPROVAL_DECISION_TYPE,
			approvalAlias,
			decision: "approve",
		},
		sender,
	);
	return pending;
}

describe("mailbox CLI browser transport", () => {
	it("uses one transactional CAS authority across production journal instances", async () => {
		const factory = new IDBFactory();
		const first = createMailboxExecutionIndexedDbStorage(
			factory,
			"mailbox-cas-test",
		);
		const second = createMailboxExecutionIndexedDbStorage(
			factory,
			"mailbox-cas-test",
		);
		const acquired = await Promise.all([
			first.compareAndSet("lease", undefined, { owner: "first" }),
			second.compareAndSet("lease", undefined, { owner: "second" }),
		]);
		expect(acquired.filter(Boolean)).toHaveLength(1);
		expect((await first.read("lease"))?.version).toBe(0);
	});

	it("physically purges raw session bindings when the browser alarm fires", async () => {
		const values = new Map<string, unknown>();
		const listeners = new Set<(alarm: Readonly<{ name: string }>) => void>();
		let alarmName = "";
		const alarmRegistration = createBrowserRawBindingAlarms({
			alarms: {
				create(name) {
					alarmName = name;
				},
				clear: () => true,
				onAlarm: {
					addListener: (listener) => listeners.add(listener),
					removeListener: (listener) => listeners.delete(listener),
				},
			},
			session: {
				async remove(key) {
					values.delete(key);
				},
			},
		});
		const store = createRawBindingStore({
			now: () => NOW_MS,
			alarms: alarmRegistration.alarms,
			session: {
				get: async (key) => values.get(key),
				async set(key, value) {
					values.set(key, structuredClone(value));
				},
				async delete(key) {
					values.delete(key);
				},
			},
		});
		await store.put(bindingScope(), {
			[alias("msg", 1)]: "raw-message-1",
		});
		expect(
			[...values.values()].some(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					Object.hasOwn(value, "bindings"),
			),
		).toBe(true);
		for (const listener of listeners) listener({ name: alarmName });
		await Promise.resolve();
		expect(
			[...values.values()].some(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					Object.hasOwn(value, "bindings"),
			),
		).toBe(false);
		alarmRegistration.dispose();
	});

	it("accepts one exact loopback fragment and strips the capability", () => {
		expect(parseMailboxCliMarker(markerUrl())).toEqual(connection);
		const stripped = stripMailboxCliMarker(markerUrl());
		expect(new URL(stripped).hash).toBe("");
		expect(stripped).not.toContain(connection.token);
		expect(() =>
			parseMailboxCliMarker(markerUrl().replace("127.0.0.1", "localhost")),
		).toThrow("Invalid mailbox CLI");
	});

	it("registers the production composition and delivers one authenticated terminal result", async () => {
		const harness = browserHarness();
		const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
		let terminals = 0;
		const composition = createMailboxCleanupBackgroundComposition({
			browser: harness.browser,
			indexedDB,
			providers: [],
			async cliTerminal() {
				terminals += 1;
				return { status: "canceled" };
			},
			async fetch(url, init) {
				requests.push({ url, init });
				return new Response(null, { status: 204 });
			},
		});
		composition.register();
		expect(harness.activeListeners()).toBe(1);
		await approvedConnect(harness);
		expect(terminals).toBe(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			`${connection.origin}/mailbox-cleanup/v1/result/${connection.runAlias}`,
		);
		const headers = requests[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${connection.token}`);
		expect(headers["x-dg-mailbox-nonce"]).toBe(connection.nonce);
		expect(requests[0]?.init.body).toBe(
			JSON.stringify({ status: "canceled" }),
		);
		await composition.dispose();
		expect(harness.activeListeners()).toBe(0);
	});

	it("uses the default production provider path to capture, bind, and open a real plan", async () => {
		const harness = browserHarness();
		const factory = new IDBFactory();
		const captured = captureResult();
		const collections = [
			["messages", captured.inventory.messages],
			["folders", captured.inventory.folders],
			["labels", captured.inventory.labels],
			["tags", captured.metadata.tags],
			["categories", captured.metadata.categories],
			["filters", captured.inventory.filters],
		] as const;
		const chunks: MailboxCaptureChunk[] = [];
		for (const [kind, items] of collections) {
			const envelope = {
				schemaVersion: 1,
				runAlias: bindingScope().runAlias,
				sequence: chunks.length,
				declaredTotal: collections.length,
				itemCount: items.length,
				payload: { kind, items },
			};
			chunks.push({
				...envelope,
				digest: await computeMailboxCaptureChunkDigest(envelope),
			});
		}
		const rawBindings = Object.fromEntries([
			...captured.inventory.messages.map((item, index) => [
				item.alias,
				`raw-message-${index + 1}`,
			]),
			...captured.inventory.folders.map((item, index) => [
				item.alias,
				`raw-folder-${index + 1}`,
			]),
			...captured.inventory.labels.map((item, index) => [
				item.alias,
				`raw-label-${index + 1}`,
			]),
			...captured.metadata.tags.map((item, index) => [
				item.alias,
				`raw-tag-${index + 1}`,
			]),
			...captured.metadata.categories.map((item, index) => [
				item.alias,
				`raw-category-${index + 1}`,
			]),
			...captured.inventory.filters.map((item, index) => [
				item.alias,
				`raw-filter-${index + 1}`,
			]),
		]);
		const fake = createFakeMailboxProviderHarness({
			now: () => new Date(NOW_MS).toISOString(),
			chunks,
			bindings: rawBindings,
		});
		const terminalBodies: string[] = [];
		const composition = createMailboxCleanupBackgroundComposition({
			browser: harness.browser,
			indexedDB: factory,
			providers: [fake.provider],
			now: () => NOW_MS,
			async fetch(_url, init) {
				terminalBodies.push(String(init.body));
				return new Response(null, { status: 204 });
			},
		});
		composition.register();
		const connected = approvedConnect(harness);
		for (
			let attempt = 0;
			attempt < 100 &&
			!harness.openedTabs.includes(
				"chrome-extension://dgtest/mailbox-plan.html",
			);
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		if (!harness.openedTabs.includes(
			"chrome-extension://dgtest/mailbox-plan.html",
		)) {
			await connected;
			throw new Error(
				`Mailbox plan did not open: ${terminalBodies.join(",")}`,
			);
		}
		expect(fake.calls.capture).toHaveLength(1);
		expect(harness.openedTabs).toEqual([
			expect.stringContaining(
				"chrome-extension://dgtest/mailbox-cli-approval.html#approval=cli_",
			),
			"chrome-extension://dgtest/mailbox-plan.html",
		]);
		expect(harness.session.has(MAILBOX_PLAN_BOOTSTRAP_KEY)).toBe(true);
		const bootstrap = harness.session.get(
			MAILBOX_PLAN_BOOTSTRAP_KEY,
		) as { capture: { metadata: unknown } };
		expect(bootstrap.capture.metadata).toEqual(captured.metadata);
		expect(terminalBodies).toEqual([]);
		await composition.dispose();
		await connected;
	});

	it("runs the fake provider end to end through the concrete production composition", async () => {
		const harness = browserHarness();
		const factory = new IDBFactory();
		const messageAlias = alias("msg", 1);
		const accepted = {
			...revision(),
			state: "approved" as const,
			inventoryFingerprint: fingerprint("c"),
			actions: [
				{
					schemaVersion: 1 as const,
					actionAlias:
						"act_89abcdef01234567fedcba9876543210",
					type: "archive" as const,
					messageAlias,
				},
			],
		};
		const planStore = createMailboxPlanStore({
			indexedDB: factory,
			now: () => NOW_MS,
		});
		await planStore.putRevision(accepted);
		const session = {
			async get(key: string) {
				return harness.session.get(key);
			},
			async set(key: string, value: unknown) {
				harness.session.set(key, structuredClone(value));
			},
			async delete(key: string) {
				harness.session.delete(key);
			},
		};
		const rawBindings = createRawBindingStore({
			session,
			now: () => NOW_MS,
		});
		await rawBindings.put(bindingScope(), {
			[messageAlias]: "raw-message-1",
		});
		const fake = createFakeMailboxProviderHarness({
			now: () => new Date(NOW_MS).toISOString(),
			accountAlias: bindingScope().accountAlias,
			bindings: { [messageAlias]: "raw-message-1" },
			rawInventory: {
				messages: [
					{
						id: "raw-message-1",
						read: false,
						archived: false,
					},
				],
			},
		});
		let fingerprintReads = 0;
		const composition = createMailboxCleanupBackgroundComposition({
			browser: harness.browser,
			indexedDB: factory,
			providers: [fake.provider],
			now: () => NOW_MS,
			computeFingerprint: async () => {
				fingerprintReads += 1;
				return fingerprintReads === 1
					? accepted.inventoryFingerprint
					: fingerprint("d");
			},
		});
		composition.register();
		const [result] = await harness.dispatch({
			type: "dg-mailbox-cleanup:execution-start",
			command: {
				planAlias: accepted.planAlias,
				revisionAlias: accepted.revisionAlias,
			},
		});
		expect(result).toMatchObject({
			status: "completed",
			resumable: false,
			debriefAvailable: true,
		});
		expect(fake.calls.dispatch).toHaveLength(1);
		expect(fake.calls.verifyFresh).toHaveLength(1);
		await composition.dispose();
		await planStore.close();
	});
});
