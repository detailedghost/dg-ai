import { describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
	createMailboxCleanupBackgroundComposition,
	type MailboxCleanupBrowserSeam,
} from "@/lib/background/mailbox-cleanup-composition";
import {
	MAILBOX_CLI_APPROVAL_DECISION_TYPE,
	MAILBOX_CLI_CONNECT_TYPE,
	type MailboxCliConnection,
	type MailboxCliRuntimeSender,
} from "@/lib/features/mailbox-cleanup/cli-transport";
import {
	createMailboxExecutionCoordinator,
	createMailboxExecutionJournal,
	buildMailboxExecutionAuthorityScope,
	buildMailboxExecutionGraph,
	validateCanonicalMailboxExecutionRevision,
	type CanonicalMailboxExecutionAction,
	type CanonicalMailboxExecutionRevision,
	type MailboxExecutionJournal,
} from "@/lib/features/mailbox-cleanup/execution";
import type {
	MailboxExecutionAtomicRecord,
	MailboxExecutionAtomicStorage,
	MailboxExecutionProvider,
} from "@/lib/features/mailbox-cleanup/execution/contracts";
import {
	createGuardedMailboxExecutionProvider,
	type MailboxProvider,
	type MailboxProviderDispatchRequest,
	type MailboxProviderOperationOptions,
} from "@/lib/features/mailbox-cleanup/providers";
import { createFakeMailboxProviderHarness } from "@/lib/features/mailbox-cleanup/providers/fake";
import { createMailboxLifecycle } from "@/lib/features/mailbox-cleanup/lifecycle";
import { createMailboxDebriefService } from "@/lib/features/mailbox-cleanup/debrief";
import {
	computeMailboxCaptureChunkDigest,
	type MailboxCaptureChunk,
} from "@/lib/features/mailbox-cleanup/coordinator";
import { computeMailboxScopedFingerprint } from "@/lib/features/mailbox-cleanup/planning";
import {
	consumeMailboxPlanBootstrap,
	createMailboxPlanWorkspace,
	initializeMailboxPlanPage,
	MAILBOX_PLAN_BOOTSTRAP_KEY,
} from "@/lib/features/mailbox-cleanup/plan-page";
import {
	createMailboxPlanStore,
	createRawBindingStore,
	type SessionStorageSeam,
} from "@/lib/features/mailbox-cleanup/storage";
import {
	ACCOUNT_ALIAS,
	alias,
	bindingScope,
	fingerprint,
	NEXT_REVISION_ALIAS,
	NOW,
	NOW_MS,
	PLAN_ALIAS,
	REVISION_ALIAS,
	revision,
	RUN_ALIAS,
} from "./mailbox-plan-page-fixtures";

const command = Object.freeze({
	planAlias: PLAN_ALIAS,
	revisionAlias: REVISION_ALIAS,
});
const MESSAGE_ALIAS = alias("msg", 1);
const TAG_ALIAS = alias("lbl", 101);
const CATEGORY_ALIAS = alias("lbl", 102);
const RAW_MESSAGE = "raw-message-1";
const RAW_TAG = "raw-tag-1";
const RAW_CATEGORY = "raw-category-1";

function providerScope() {
	const scope = bindingScope();
	return Object.freeze({
		providerId: scope.providerId,
		surface: scope.surface,
		accountAlias: scope.accountAlias,
		runAlias: scope.runAlias,
		revisionAlias: scope.revisionAlias,
	});
}

function actionAlias(index: number): string {
	return `act_89abcdef01234567fedcba98${index
		.toString(16)
		.padStart(8, "0")}`;
}

function canonicalAction(
	type: "archive" | "mark_read",
	index: number,
	messageAlias = MESSAGE_ALIAS,
): CanonicalMailboxExecutionAction {
	return Object.freeze({
		schemaVersion: 1,
		actionAlias: actionAlias(index),
		type,
		messageAlias,
	});
}

function acceptedRevision(
	actions: readonly CanonicalMailboxExecutionAction[] = [
		canonicalAction("archive", 1),
	],
): CanonicalMailboxExecutionRevision {
	const base = revision({
		state: "approved",
		inventoryFingerprint: fingerprint("a"),
	});
	const messageAliases = [
		...new Set(
			actions.flatMap((action) =>
				"messageAlias" in action ? [action.messageAlias] : [],
			),
		),
	];
	return validateCanonicalMailboxExecutionRevision(
		{
			...base,
			actions,
			cohorts:
				messageAliases.length === 0
					? base.cohorts
					: [
							{
								schemaVersion: 1,
								cohortKey: "production-smoke",
								category: "other",
								ageBucket: "recent",
								messageAliases,
								suggestedActions: [],
							},
						],
		},
	);
}

function providerDelta(
	action: CanonicalMailboxExecutionAction,
	changedAliases: readonly string[],
) {
	return Object.freeze({
		schemaVersion: 1 as const,
		scope: "entire_fingerprint" as const,
		actionAlias: action.actionAlias,
		changedAliases: Object.freeze([...changedAliases]),
	});
}

function journalVerification(
	action: CanonicalMailboxExecutionAction,
	beforeFingerprint = fingerprint("a"),
	afterFingerprint = fingerprint("b"),
) {
	return Object.freeze({
		status: "verified" as const,
		verifiedAt: NOW,
		delta: Object.freeze({
			...providerDelta(action, [MESSAGE_ALIAS]),
			beforeFingerprint,
			afterFingerprint,
			beforeScope:
				buildMailboxExecutionAuthorityScope([action]),
			afterScope: buildMailboxExecutionAuthorityScope([]),
		}),
	});
}

class AtomicMemoryStorage implements MailboxExecutionAtomicStorage {
	readonly records = new Map<string, MailboxExecutionAtomicRecord>();

	async read(key: string): Promise<MailboxExecutionAtomicRecord | undefined> {
		const current = this.records.get(key);
		return current === undefined
			? undefined
			: {
					version: current.version,
					value: structuredClone(current.value),
				};
	}

	async compareAndSet(
		key: string,
		expectedVersion: number | undefined,
		value: unknown,
	): Promise<boolean> {
		const current = this.records.get(key);
		if (current?.version !== expectedVersion) return false;
		this.records.set(key, {
			version: (current?.version ?? -1) + 1,
			value: structuredClone(value),
		});
		return true;
	}
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function waitFor<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		const value = await read();
		if (done(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Timed out waiting for mailbox cleanup state");
}

function browserHarness() {
	const listeners = new Set<
		(value: unknown, sender?: MailboxCliRuntimeSender) => unknown
	>();
	const session = new Map<string, unknown>();
	const local = new Map<string, unknown>();
	const tabs: string[] = [];
	const downloads: unknown[] = [];
	const downloadStates = new Map<
		number,
		"in_progress" | "complete" | "interrupted"
	>();
	const chatInbound: unknown[] = [];
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

function cliConnection(seed = 1): MailboxCliConnection {
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

function cliContentSender(
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

async function startApprovedCli(
	harness: ReturnType<typeof browserHarness>,
	connection: MailboxCliConnection,
	tabId: number,
): Promise<Readonly<{
	connectionResult: Promise<unknown>;
	approvalUrl: string;
}>> {
	const tabOffset = harness.tabs.length;
	const connectionResult = harness.dispatch(
		{
			type: MAILBOX_CLI_CONNECT_TYPE,
			connection,
		},
		cliContentSender(connection, tabId),
	);
	await waitFor(
		async () => harness.tabs.length,
		(length) => length > tabOffset,
	);
	const approvalUrl = harness.tabs[tabOffset]!;
	const parsed = new URL(approvalUrl);
	const approvalAlias = parsed.hash.slice("#approval=".length);
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
			tab: {
				id: tabOffset + 1,
				url: approvalUrl,
			},
		},
	);
	return Object.freeze({ connectionResult, approvalUrl });
}

async function captureChunk(
	sequence: number,
	declaredTotal: number,
	kind: string,
	items: readonly unknown[],
): Promise<MailboxCaptureChunk> {
	const payload = { kind, items };
	const envelope = {
		schemaVersion: 1 as const,
		runAlias: RUN_ALIAS,
		sequence,
		declaredTotal,
		itemCount: items.length,
		payload,
	};
	return {
		...envelope,
		digest: await computeMailboxCaptureChunkDigest(envelope),
	};
}

async function rawProviderFixture() {
	return createFakeMailboxProviderHarness({
		now: () => NOW,
		rawInventory: {
			messages: [
				{
					id: RAW_MESSAGE,
					read: false,
					archived: false,
					receivedAt: "2026-06-01T12:00:00.000Z",
				},
			],
			labels: [
				{ id: RAW_TAG, messageCount: 1, kind: "tag" },
				{ id: RAW_CATEGORY, messageCount: 1, kind: "category" },
			],
		},
		chunks: [
			await captureChunk(0, 3, "messages", [
				{
					alias: MESSAGE_ALIAS,
					read: false,
					hasAttachments: false,
					receivedAt: "2026-06-01T12:00:00.000Z",
					category: "newsletter",
				},
			]),
			await captureChunk(1, 3, "tags", [
				{ alias: TAG_ALIAS, messageCount: 1 },
			]),
			await captureChunk(2, 3, "categories", [
				{ alias: CATEGORY_ALIAS, messageCount: 1 },
			]),
		],
		bindings: {
			[MESSAGE_ALIAS]: RAW_MESSAGE,
			[TAG_ALIAS]: RAW_TAG,
			[CATEGORY_ALIAS]: RAW_CATEGORY,
		},
	});
}

function fakeExecutionProvider(
	actions: readonly CanonicalMailboxExecutionAction[],
) {
	const messageAliases = [
		...new Set(
			actions.flatMap((action) =>
				"messageAlias" in action ? [action.messageAlias] : [],
			),
		),
	];
	const rawBindings = Object.fromEntries(
		messageAliases.map((messageAlias, index) => [
			messageAlias,
			messageAlias === MESSAGE_ALIAS
				? RAW_MESSAGE
				: `raw-message-${index + 2}`,
		]),
	);
	const rawInventory = {
		messages: Object.values(rawBindings).map((rawId) => ({
				id: rawId,
				read: false,
				archived: false,
			})),
	};
	const fake = createFakeMailboxProviderHarness({
		now: () => NOW,
		accountAlias: ACCOUNT_ALIAS,
		bindings: rawBindings,
		rawInventory,
	});
	return {
		fake,
		rawBindings,
		provider: createGuardedMailboxExecutionProvider(fake.provider),
	};
}

function executionHarness(options: Readonly<{
	accepted?: CanonicalMailboxExecutionRevision;
	storage?: MailboxExecutionAtomicStorage;
	journal?: MailboxExecutionJournal;
	provider?: MailboxExecutionProvider;
	rawBindings?: Readonly<Record<string, string>>;
	now?: () => string;
	external?: { state: CanonicalMailboxExecutionRevision["state"] };
	computeFingerprint?: () => Promise<ReturnType<typeof fingerprint>>;
	generateDebrief?: (
		input: Readonly<Record<string, unknown>>,
	) => Promise<unknown>;
	transitionRevision?: (
		expected: "approved" | "in_flight",
		next: "in_flight" | "completed" | "canceled",
	) => Promise<void>;
}> = {}) {
	const accepted = options.accepted ?? acceptedRevision();
	const providerHarness = fakeExecutionProvider(accepted.actions);
	const now = options.now ?? (() => NOW);
	const external = options.external ?? { state: accepted.state };
	const storage = options.storage ?? new AtomicMemoryStorage();
	const journal =
		options.journal ??
		createMailboxExecutionJournal({
			storage,
			now,
		});
	const transitions: string[] = [];
	const fingerprintAfterDispatch = () => {
		const dispatchCount = providerHarness.fake.calls.dispatch.length;
		return dispatchCount === 0
			? accepted.inventoryFingerprint
			: {
					schemaVersion: 1 as const,
					algorithm: "sha256" as const,
					digest: dispatchCount.toString(16).padStart(64, "0"),
				};
	};
	const coordinator = createMailboxExecutionCoordinator({
		async loadRevision() {
			return { ...accepted, state: external.state };
		},
		async loadBinding() {
			return {
				scope: bindingScope(),
				bindings:
					options.rawBindings ?? providerHarness.rawBindings,
			};
		},
		async resolveProvider() {
			return options.provider ?? providerHarness.provider;
		},
		computeFingerprint:
			options.computeFingerprint ??
			(async () => fingerprintAfterDispatch()),
		journal,
		now,
		generateDebrief:
			options.generateDebrief ??
			(async () => ({ status: "downloaded" as const })),
		async transitionRevision(_planAlias, _revisionAlias, expected, next) {
			if (options.transitionRevision !== undefined) {
				await options.transitionRevision(expected, next);
				return;
			}
			if (external.state !== expected) {
				throw new Error("Lifecycle compare-and-set failed");
			}
			external.state = next;
			transitions.push(`${expected}->${next}`);
		},
	});
	return {
		accepted,
		coordinator,
		external,
		fake: providerHarness.fake,
		journal,
		storage,
		transitions,
	};
}

describe("mailbox cleanup production safety smoke", () => {
	it("runs default CLI capture through plan Accept and execution, with chat on the same orchestrator", async () => {
		const harness = browserHarness();
		const factory = new IDBFactory();
		const fake = await rawProviderFixture();
		const cliRequests: Array<Readonly<{ url: string; body: string }>> = [];
		const composition = createMailboxCleanupBackgroundComposition({
			browser: harness.browser,
			indexedDB: factory,
			providers: [fake.provider],
			now: () => NOW_MS,
			async fetch(url, init) {
				const body = String(init.body);
				cliRequests.push({
					url,
					body,
				});
				if (url.includes("/mailbox-cleanup/v1/author/")) {
					const message = JSON.parse(body) as {
						revision: {
							actions: readonly unknown[];
						};
					};
					const changedDraft = {
						...message.revision,
						actions: message.revision.actions.slice(
							0,
							Math.max(0, message.revision.actions.length - 1),
						),
					};
					return Response.json(
						{ status: "proposal", proposal: changedDraft },
						{ status: 200 },
					);
				}
				return new Response(null, { status: 204 });
			},
		});
		composition.register();
		const plans = createMailboxPlanStore({
			indexedDB: factory,
			now: () => NOW_MS,
		});
		const rawBindings = createRawBindingStore({
			session: harness.sessionSeam,
			now: () => NOW_MS,
		});

		try {
			const connection = cliConnection();
			const approved = await startApprovedCli(
				harness,
				connection,
				101,
			);
			await waitFor(
				async () => harness.tabs.length,
				(length) => length === 2,
			);
			expect(harness.tabs).toEqual([
				approved.approvalUrl,
				"chrome-extension://dgtest/mailbox-plan.html",
			]);
			const bootstrap = harness.session.get(MAILBOX_PLAN_BOOTSTRAP_KEY);
			expect(bootstrap).toBeDefined();
			const input = await consumeMailboxPlanBootstrap({
				session: harness.sessionSeam,
				computeFingerprint: computeMailboxScopedFingerprint,
			});
			expect(input).toBeDefined();
			expect(fake.calls.probe).toHaveLength(1);
			expect(fake.calls.capture).toHaveLength(1);
			expect(fake.calls.captureResult).toHaveLength(1);
			expect(input!.capture.metadata).toEqual({
				tags: [{ alias: TAG_ALIAS, messageCount: 1 }],
				categories: [
					{ alias: CATEGORY_ALIAS, messageCount: 1 },
				],
			});
			const lifecycle = createMailboxLifecycle({
				store: plans,
				now: () => NOW_MS,
				execution: {
					has: async (planAlias, revisionAlias) =>
						(await rawBindings.get({
							...input!.bindingScope,
							planAlias,
							revisionAlias,
						})) !== undefined,
					invalidate: (planAlias, revisionAlias, reason) =>
						rawBindings.invalidateRevision(
							planAlias,
							revisionAlias,
							reason,
						),
				},
			});

			const marker = {
				schemaVersion: 1 as const,
				planAlias: input!.baseRevision.planAlias,
				requestAlias: actionAlias(90),
				nonce: "0123456789abcdef0123456789abcdef",
			};
			await harness.browser.runtime.sendMessage({
				type: "dg-mailbox-cleanup:chat-open",
				marker,
			});
			const chatResult = await harness.browser.runtime.sendMessage({
				type: "dg-mailbox-cleanup:chat-submit",
				message: {
					...marker,
					type: "mailbox_chat_submit",
					inventory: input!.capture.inventory,
					revision: input!.baseRevision,
				},
			});
			const [chatProposal] = chatResult as readonly unknown[];
			expect(chatProposal).toMatchObject({
				status: "proposal",
				proposal: {
					planAlias: input!.baseRevision.planAlias,
				},
			});
			expect(
				(chatProposal as { proposal: unknown }).proposal,
			).not.toEqual(input!.baseRevision);
			expect(
				(chatProposal as {
					proposal: { actions: readonly unknown[] };
				}).proposal.actions,
			).toHaveLength(input!.baseRevision.actions.length - 1);
			await approved.connectionResult;
			expect(cliRequests).toHaveLength(1);
			expect(cliRequests[0]!.url).toBe(
				`${connection.origin}/mailbox-cleanup/v1/author/${connection.runAlias}`,
			);
			expect(cliRequests[0]!.body).not.toContain(RAW_MESSAGE);
			expect(cliRequests[0]!.body).not.toContain(RAW_TAG);
			expect(cliRequests[0]!.body).not.toContain(RAW_CATEGORY);

			let executionResult: unknown;
			let nextActionAlias = 100;
			const initialized = await initializeMailboxPlanPage(input!, {
				lifecycle,
				createWorkspace: (workspaceInput) =>
					createMailboxPlanWorkspace(workspaceInput, {
						lifecycle,
						rawBindings,
						computeFingerprint: computeMailboxScopedFingerprint,
						createRevisionAlias: () => NEXT_REVISION_ALIAS,
						createActionAlias: () =>
							actionAlias(nextActionAlias++),
						now: () => NOW_MS,
						bridge: {
							isOpen: () => true,
							async submit() {
								return { status: "canceled" as const };
							},
							async cancel() {},
							async reconnect() {},
						},
						async startExecution(nextCommand) {
							executionResult =
								await harness.browser.runtime.sendMessage({
									type: "dg-mailbox-cleanup:execution-start",
									command: nextCommand,
								});
							return executionResult;
						},
					}),
				mount: () => () => undefined,
			});
			const accepted = await initialized.workspace.acceptRevision();

			expect(executionResult).toMatchObject({
				status: "completed",
				debriefAvailable: true,
			});
			expect(fake.calls.dispatch.length).toBeGreaterThan(0);
			expect(fake.calls.verifyFresh).toHaveLength(
				fake.calls.dispatch.length,
			);
			expect(harness.downloads).toHaveLength(1);
			await expect(
				rawBindings.status({
					...input!.bindingScope,
					revisionAlias: accepted.revisionAlias,
				}),
			).resolves.toEqual({
				available: false,
				reason: "invalidated",
			});
		} finally {
			await plans.close();
			await composition.dispose();
		}
	});

	it("expires the old default binding and recaptures a fresh restart", async () => {
		const harness = browserHarness();
		const factory = new IDBFactory();
		const fake = await rawProviderFixture();
		let now = NOW_MS;
		const composition = createMailboxCleanupBackgroundComposition({
			browser: harness.browser,
			indexedDB: factory,
			providers: [fake.provider],
			now: () => now,
			async fetch() {
				return new Response(null, { status: 204 });
			},
		});
		composition.register();
		const rawBindings = createRawBindingStore({
			session: harness.sessionSeam,
			now: () => now,
		});

		try {
			const firstApproval = await startApprovedCli(
				harness,
				cliConnection(1),
				201,
			);
			await waitFor(
				async () => harness.session.get(MAILBOX_PLAN_BOOTSTRAP_KEY),
				(value) => value !== undefined,
			);
			const first = structuredClone(
				harness.session.get(MAILBOX_PLAN_BOOTSTRAP_KEY),
			) as {
				baseRevision: { planAlias: string };
				bindingScope: ReturnType<typeof bindingScope>;
			};
			await expect(rawBindings.status(first.bindingScope)).resolves.toMatchObject({
				available: true,
			});
			const firstMarker = {
				schemaVersion: 1 as const,
				planAlias: first.baseRevision.planAlias,
				requestAlias: actionAlias(201),
				nonce: "abcdef0123456789abcdef0123456789",
			};
			await harness.browser.runtime.sendMessage({
				type: "dg-mailbox-cleanup:chat-open",
				marker: firstMarker,
			});
			await harness.browser.runtime.sendMessage({
				type: "dg-mailbox-cleanup:chat-cancel",
				marker: firstMarker,
			});
			await firstApproval.connectionResult;

			now += 60 * 60 * 1_000 + 1;
			await expect(rawBindings.status(first.bindingScope)).resolves.toEqual({
				available: false,
				reason: "expired",
			});
			await startApprovedCli(harness, cliConnection(2), 202);
			await waitFor(
				async () =>
					harness.session.get(MAILBOX_PLAN_BOOTSTRAP_KEY) as
						| {
								baseRevision?: { planAlias?: string };
						  }
						| undefined,
				(value) =>
					value?.baseRevision?.planAlias !== undefined &&
					value.baseRevision.planAlias !==
						first.baseRevision.planAlias,
			);
			const restarted = harness.session.get(
				MAILBOX_PLAN_BOOTSTRAP_KEY,
			) as {
				baseRevision: { planAlias: string };
				bindingScope: ReturnType<typeof bindingScope>;
			};

			expect(restarted.baseRevision.planAlias).not.toBe(
				first.baseRevision.planAlias,
			);
			expect(restarted.bindingScope.revisionAlias).not.toBe(
				first.bindingScope.revisionAlias,
			);
			expect(fake.calls.capture).toHaveLength(2);
		} finally {
			await composition.dispose();
		}
	});

	it("recaptures the fake provider from live mutations instead of replaying scripted chunks", async () => {
		const fake = await rawProviderFixture();
		const capture = async () => {
			const signal = new AbortController().signal;
			const chunks: MailboxCaptureChunk[] = [];
			for await (const chunk of fake.coordinatorSeams.capture(
				providerScope(),
				signal,
			)) {
				chunks.push(chunk);
			}
			await fake.coordinatorSeams.captureResult(providerScope(), signal);
			return chunks;
		};
		const initial = await capture();
		const dispatch = fake.provider.dispatch;
		if (dispatch === undefined) {
			throw new Error("Fake provider execution seam is unavailable");
		}
		await dispatch({
			...providerScope(),
			action: canonicalAction("mark_read", 50),
			rawTargets: { [MESSAGE_ALIAS]: RAW_MESSAGE },
		});
		const read = await capture();
		await dispatch({
			...providerScope(),
			action: canonicalAction("archive", 51),
			rawTargets: { [MESSAGE_ALIAS]: RAW_MESSAGE },
		});
		const archived = await capture();

		expect(initial[0]?.payload.items).toEqual([
			expect.objectContaining({
				alias: MESSAGE_ALIAS,
				read: false,
			}),
		]);
		expect(read[0]?.payload.items).toEqual([
			expect.objectContaining({
				alias: MESSAGE_ALIAS,
				read: true,
			}),
		]);
		expect(read[0]?.digest).not.toBe(initial[0]?.digest);
		expect(
			archived.flatMap((chunk) => chunk.payload.items),
		).not.toContainEqual(
			expect.objectContaining({ alias: MESSAGE_ALIAS }),
		);
		expect(archived[0]?.payload).toEqual({
			kind: "messages",
			items: [],
		});
		expect(archived.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
		expect(
			archived.every((chunk) => chunk.declaredTotal === 3),
		).toBe(true);
	});

	it("prevents a raw provider mutation from landing after abort", async () => {
		const action = canonicalAction("archive", 1);
		const { fake, rawBindings } = fakeExecutionProvider([action]);
		const dispatchStarted = deferred();
		const releaseDispatch = deferred();
		const rawFinished = deferred();
		let mutations = 0;
		const rawProvider = {
			...fake.provider,
			async dispatch(
				_request: MailboxProviderDispatchRequest,
				options?: MailboxProviderOperationOptions,
			) {
				dispatchStarted.resolve();
				await releaseDispatch.promise;
				if (!options?.signal?.aborted) mutations += 1;
				rawFinished.resolve();
				return { status: "dispatched" as const };
			},
		} satisfies MailboxProvider;
		const guarded = createGuardedMailboxExecutionProvider(rawProvider);
		const controller = new AbortController();
		const pending = guarded.dispatch(
			{
				...providerScope(),
				action,
				rawTargets: rawBindings,
			},
			{ signal: controller.signal, timeoutMs: 1_000 },
		);

		await dispatchStarted.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({
			code: "provider_canceled",
		});
		releaseDispatch.resolve();
		await rawFinished.promise;

		expect(mutations).toBe(0);
	});

	it("terminates cancellation with an ambiguous dispatched action in needs_review", async () => {
		const accepted = acceptedRevision();
		const dispatchStarted = deferred();
		const provider: MailboxExecutionProvider = {
			async preflight() {
				return {
					status: "ready",
					providerId: "fake-mail",
					surface: "inbox",
					accountAlias: ACCOUNT_ALIAS,
					locale: "en-US",
					layout: "supported",
					capabilities: ["archive"],
					targets: "available",
				};
			},
			dispatch(_request, options) {
				dispatchStarted.resolve();
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => reject({ reasonCode: "canceled" }),
						{ once: true },
					);
				});
			},
			async observe() {
				return {
					status: "ambiguous",
					reasonCode: "verification_mismatch",
				};
			},
			async verifyFresh() {
				throw new Error("Ambiguous dispatch must not be verified");
			},
			async observeInbox() {
				throw new Error("Canceled execution must not claim Inbox Zero");
			},
		};
		const run = executionHarness({
			accepted,
			provider,
		});

		const execution = run.coordinator.start(command);
		await dispatchStarted.promise;
		await expect(run.coordinator.cancel(command)).resolves.toMatchObject({
			status: "paused",
			reasonCode: "canceled",
		});
		await expect(execution).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
			resumable: false,
		});
		const snapshot = await run.journal.snapshot(command);

		expect(snapshot).toMatchObject({
			terminalStatus: "canceled",
			terminalReasonCode: "canceled",
			actions: [
				{
					state: "needs_review",
					result: {
						status: "needs_review",
						reasonCode: "verification_mismatch",
					},
				},
			],
		});
	});

	it("rechecks live preflight and fingerprint before every dispatch", async () => {
		const accepted = acceptedRevision([
			canonicalAction("archive", 1),
			canonicalAction("mark_read", 2),
		]);
		let fingerprints = 0;
		const run = executionHarness({
			accepted,
			async computeFingerprint() {
				fingerprints += 1;
				if (fingerprints === 1) {
					return accepted.inventoryFingerprint;
				}
				return fingerprints === 2
					? fingerprint("b")
					: fingerprint("c");
			},
		});

		await expect(run.coordinator.start(command)).resolves.toMatchObject({
			status: "failed",
			reasonCode: "stale_binding",
		});
		expect(fingerprints).toBe(3);
		expect(run.fake.calls.preflight).toHaveLength(2);
		expect(run.fake.calls.dispatch).toHaveLength(1);
	});

	it("advances authority only for exact action deltas, then stops on unrelated drift", async () => {
		const firstMessage = alias("msg", 301);
		const secondMessage = alias("msg", 302);
		const thirdMessage = alias("msg", 303);
		const accepted = acceptedRevision([
			canonicalAction("mark_read", 301, firstMessage),
			canonicalAction("mark_read", 302, secondMessage),
			canonicalAction("mark_read", 303, thirdMessage),
		]);
		const fingerprints = [
			accepted.inventoryFingerprint,
			fingerprint("b"),
			fingerprint("b"),
			fingerprint("c"),
			fingerprint("d"),
		];
		let fingerprintCalls = 0;
		const run = executionHarness({
			accepted,
			async computeFingerprint() {
				return fingerprints[fingerprintCalls++] ?? fingerprint("d");
			},
		});

		await expect(run.coordinator.start(command)).resolves.toMatchObject({
			status: "failed",
			reasonCode: "stale_binding",
		});
		const snapshot = await run.journal.snapshot(command);

		expect(run.fake.calls.dispatch).toHaveLength(2);
		expect(snapshot?.actions[0]).toMatchObject({
			state: "verified",
			verification: {
				delta: {
					actionAlias: accepted.actions[0]!.actionAlias,
					changedAliases: [firstMessage],
					beforeFingerprint: accepted.inventoryFingerprint,
					afterFingerprint: fingerprint("b"),
				},
			},
		});
		expect(snapshot?.actions[1]).toMatchObject({
			state: "verified",
			verification: {
				delta: {
					actionAlias: accepted.actions[1]!.actionAlias,
					changedAliases: [secondMessage],
					beforeFingerprint: fingerprint("b"),
					afterFingerprint: fingerprint("c"),
				},
			},
		});
		expect(snapshot?.actions[2]).toMatchObject({
			state: "skipped",
			result: {
				status: "skipped",
				reasonCode: "stale_binding",
			},
		});
	});

	it("requires exhaustive relational deltas for message and destination count changes", async () => {
		const unrelatedLabel = alias("lbl", 402);
		const unrelatedRawLabel = "raw-tag-unrelated";
		const applyLabel = Object.freeze({
			schemaVersion: 1 as const,
			actionAlias: actionAlias(401),
			type: "apply_label" as const,
			messageAlias: MESSAGE_ALIAS,
			labelAlias: TAG_ALIAS,
		});
		const accepted = acceptedRevision([applyLabel]);
		const rawBindings = {
			[MESSAGE_ALIAS]: RAW_MESSAGE,
			[TAG_ALIAS]: RAW_TAG,
			[unrelatedLabel]: unrelatedRawLabel,
		};
		const createRelationalFake = async () =>
			createFakeMailboxProviderHarness({
				now: () => NOW,
				accountAlias: ACCOUNT_ALIAS,
				rawInventory: {
					messages: [
						{
							id: RAW_MESSAGE,
							read: false,
							archived: false,
							labelIds: [],
						},
					],
					labels: [
						{ id: RAW_TAG, messageCount: 0, kind: "tag" },
						{
							id: unrelatedRawLabel,
							messageCount: 0,
							kind: "tag",
						},
					],
				},
				chunks: [
					await captureChunk(0, 2, "messages", [
						{
							alias: MESSAGE_ALIAS,
							read: false,
							hasAttachments: false,
							receivedAt: "2026-06-01T12:00:00.000Z",
							category: "other",
						},
					]),
					await captureChunk(1, 2, "tags", [
						{ alias: TAG_ALIAS, messageCount: 0 },
						{ alias: unrelatedLabel, messageCount: 0 },
					]),
				],
				bindings: rawBindings,
			});
		const positiveFake = await createRelationalFake();
		let positiveFingerprints = 0;
		const positive = executionHarness({
			accepted,
			provider: createGuardedMailboxExecutionProvider(
				positiveFake.provider,
			),
			rawBindings,
			async computeFingerprint() {
				positiveFingerprints += 1;
				return positiveFingerprints === 1
					? accepted.inventoryFingerprint
					: fingerprint("b");
			},
		});

		await expect(positive.coordinator.start(command)).resolves.toMatchObject({
			status: "completed",
		});
		const positiveSnapshot = await positive.journal.snapshot(command);
		expect(
			positiveSnapshot?.actions[0]?.verification?.delta.changedAliases,
		).toEqual([TAG_ALIAS, MESSAGE_ALIAS].sort());
		const recaptured: MailboxCaptureChunk[] = [];
		const signal = new AbortController().signal;
		for await (const chunk of positiveFake.coordinatorSeams.capture(
			providerScope(),
			signal,
		)) {
			recaptured.push(chunk);
		}
		expect(
			recaptured.find((chunk) => chunk.payload.kind === "tags")?.payload
				.items,
		).toContainEqual({
			alias: TAG_ALIAS,
			messageCount: 1,
		});

		const negativeFake = await createRelationalFake();
		const guarded = createGuardedMailboxExecutionProvider(
			negativeFake.provider,
		);
		const unrelatedDeltaProvider: MailboxExecutionProvider = {
			...guarded,
			async verifyFresh(request, options) {
				const result = await guarded.verifyFresh(request, options);
				return result.status === "verified"
					? {
							...result,
							delta: {
								...result.delta,
								changedAliases: [
									...result.delta.changedAliases,
									unrelatedLabel,
								],
							},
						}
					: result;
			},
		};
		let negativeFingerprints = 0;
		const negative = executionHarness({
			accepted,
			provider: unrelatedDeltaProvider,
			rawBindings,
			async computeFingerprint() {
				negativeFingerprints += 1;
				return negativeFingerprints === 1
					? accepted.inventoryFingerprint
					: fingerprint("b");
			},
		});

		await expect(negative.coordinator.start(command)).resolves.toMatchObject({
			status: "failed",
			reasonCode: "verification_mismatch",
		});
		await expect(negative.journal.snapshot(command)).resolves.toMatchObject({
			actions: [
				{
					state: "needs_review",
					result: {
						status: "needs_review",
						reasonCode: "verification_mismatch",
					},
				},
			],
		});
	});

	it("does not let an expired fence owner cancel the active replacement owner", async () => {
		const accepted = acceptedRevision();
		const storage = new AtomicMemoryStorage();
		let nowMilliseconds = Date.parse(NOW);
		const now = () => new Date(nowMilliseconds).toISOString();
		const firstJournal = {
			...createMailboxExecutionJournal({
				storage,
				now,
				leaseDurationMs: 30,
			}),
			heartbeatIntervalMs: 1_000_000,
		};
		const secondJournal = {
			...createMailboxExecutionJournal({
				storage,
				now,
				leaseDurationMs: 30,
			}),
			heartbeatIntervalMs: 1_000_000,
		};
		const dispatchStarted = deferred();
		const releaseDispatch = deferred();
		const replacementObserveStarted = deferred();
		const releaseReplacementObserve = deferred();
		const staleObserveStarted = deferred();
		const releaseStaleObserve = deferred();
		const replacementVerifyStarted = deferred();
		const releaseReplacementVerify = deferred();
		let observeCalls = 0;
		let applied = false;
		const provider: MailboxExecutionProvider = {
			async preflight() {
				return {
					status: "ready",
					providerId: "fake-mail",
					surface: "inbox",
					accountAlias: ACCOUNT_ALIAS,
					locale: "en-US",
					layout: "supported",
					capabilities: ["archive"],
					targets: "available",
				};
			},
			async dispatch() {
				dispatchStarted.resolve();
				await releaseDispatch.promise;
				applied = true;
				return { status: "dispatched" };
			},
			async observe() {
				observeCalls += 1;
				if (observeCalls === 1) {
					replacementObserveStarted.resolve();
					await releaseReplacementObserve.promise;
				} else {
					staleObserveStarted.resolve();
					await releaseStaleObserve.promise;
				}
				return applied
					? { status: "observed", observedAt: now() }
					: {
							status: "ambiguous",
							reasonCode: "verification_mismatch",
						};
			},
			async verifyFresh() {
				replacementVerifyStarted.resolve();
				await releaseReplacementVerify.promise;
				return {
					status: "verified",
					verifiedAt: now(),
					delta: providerDelta(accepted.actions[0]!, [
						MESSAGE_ALIAS,
					]),
				};
			},
			async observeInbox() {
				return { status: "observed", count: 0, observedAt: now() };
			},
		};
		const external = { state: "approved" as const } as {
			state: CanonicalMailboxExecutionRevision["state"];
		};
		const transitions: string[] = [];
		const transitionRevision = async (
			expected: "approved" | "in_flight",
			next: "in_flight" | "completed" | "canceled",
		) => {
			if (external.state !== expected) {
				throw new Error("Lifecycle compare-and-set failed");
			}
			external.state = next;
			transitions.push(`${expected}->${next}`);
		};
		const first = executionHarness({
			accepted,
			external,
			journal: firstJournal,
			provider,
			now,
			computeFingerprint: async () =>
				applied ? fingerprint("b") : accepted.inventoryFingerprint,
			transitionRevision,
		});
		const replacement = executionHarness({
			accepted,
			external,
			journal: secondJournal,
			provider,
			now,
			computeFingerprint: async () =>
				applied ? fingerprint("b") : accepted.inventoryFingerprint,
			transitionRevision,
		});

		const staleRun = first.coordinator.start(command);
		await dispatchStarted.promise;
		nowMilliseconds += 31;
		const replacementRun = replacement.coordinator.resume(command);
		await replacementObserveStarted.promise;
		releaseDispatch.resolve();
		await staleObserveStarted.promise;
		releaseReplacementObserve.resolve();
		await replacementVerifyStarted.promise;
		releaseStaleObserve.resolve();
		await staleRun;

		expect(external.state).toBe("in_flight");
		expect(transitions).not.toContain("in_flight->canceled");

		releaseReplacementVerify.resolve();
		await expect(replacementRun).resolves.toMatchObject({
			status: "completed",
		});
	});

	it("recovers a crash after terminal lifecycle intent but before terminal status", async () => {
		const accepted = acceptedRevision();
		const storage = new AtomicMemoryStorage();
		const journal = createMailboxExecutionJournal({
			storage,
			now: () => NOW,
		});
		await journal.initialize(command, {
			accountAlias: ACCOUNT_ALIAS,
			revision: accepted,
			order: [0],
		});
		const lease = await journal.acquireLease(
			command,
			ACCOUNT_ALIAS,
			"worker:crashed",
		);
		expect(lease).toBeDefined();
		await journal.prepareLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		await journal.commitLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		await journal.transitionAction(
			command,
			lease!,
			0,
			"pending",
			"dispatched",
		);
		await journal.transitionAction(
			command,
			lease!,
			0,
			"dispatched",
			"observed",
			{ observation: { status: "observed", observedAt: NOW } },
		);
		await journal.transitionAction(
			command,
			lease!,
			0,
			"observed",
			"verified",
			{
				verification: journalVerification(accepted.actions[0]!),
				authorityFingerprint: fingerprint("b"),
				authorityScope:
					buildMailboxExecutionAuthorityScope([]),
				result: {
					schemaVersion: 1,
					index: 0,
					action: accepted.actions[0]!,
					status: "completed",
					affectedCount: 1,
				},
			},
		);
		await journal.prepareLifecycle(
			command,
			lease!,
			"in_flight",
			"completed",
			{ status: "completed" },
		);
		await journal.releaseLease(command, lease!);
		const external = {
			state: "in_flight" as CanonicalMailboxExecutionRevision["state"],
		};
		const restarted = executionHarness({
			accepted,
			external,
			journal,
		});

		await expect(restarted.coordinator.resume(command)).resolves.toMatchObject({
			status: "completed",
			debriefAvailable: true,
		});
		expect(external.state).toBe("completed");
		expect(restarted.fake.calls.dispatch).toHaveLength(0);
	});

	it("discovers and resumes an orphaned journal when a fresh composition registers", async () => {
		const harness = browserHarness();
		const factory = new IDBFactory();
		const storage = new AtomicMemoryStorage();
		const accepted = acceptedRevision();
		const providerHarness = fakeExecutionProvider(accepted.actions);
		const plans = createMailboxPlanStore({
			indexedDB: factory,
			now: () => NOW_MS,
		});
		const rawBindings = createRawBindingStore({
			session: harness.sessionSeam,
			now: () => NOW_MS,
		});
		const journal = createMailboxExecutionJournal({
			storage,
			now: () => NOW,
		});
		await plans.putRevision({ ...accepted, state: "in_flight" });
		await rawBindings.put(bindingScope(), providerHarness.rawBindings);
		await journal.initialize(command, {
			accountAlias: ACCOUNT_ALIAS,
			revision: accepted,
			order: [0],
		});
		const orphanLease = await journal.acquireLease(
			command,
			ACCOUNT_ALIAS,
			"worker:orphaned",
		);
		await journal.prepareLifecycle(
			command,
			orphanLease!,
			"approved",
			"in_flight",
		);
		await journal.commitLifecycle(
			command,
			orphanLease!,
			"approved",
			"in_flight",
		);
		await journal.releaseLease(command, orphanLease!);
		await plans.close();

		const composition = createMailboxCleanupBackgroundComposition({
			browser: harness.browser,
			indexedDB: factory,
			executionStorage: storage,
			providers: [providerHarness.fake.provider],
			now: () => NOW_MS,
			async computeFingerprint() {
				return providerHarness.fake.calls.dispatch.length === 0
					? accepted.inventoryFingerprint
					: fingerprint("b");
			},
		});
		try {
			composition.register();
			const terminal = await waitFor(
				() => composition.execution.status(command),
				(result) =>
					result.status === "completed" &&
					result.debriefAvailable === true,
			);

			expect(terminal).toMatchObject({
				status: "completed",
				debriefAvailable: true,
			});
			expect(providerHarness.fake.calls.dispatch).toHaveLength(1);
			await expect(journal.activeCommands()).resolves.toEqual([]);
		} finally {
			await composition.dispose();
		}
	});

	it("withholds download availability and retries identical durable bytes after restart", async () => {
		const durable = new Map<string, unknown>();
		const executionStorage = new AtomicMemoryStorage();
		const storage = {
			async get(key: string) {
				return structuredClone(durable.get(key));
			},
			async set(key: string, value: unknown) {
				durable.set(key, structuredClone(value));
			},
			async remove(key: string) {
				durable.delete(key);
			},
		};
		const firstReports: unknown[] = [];
		let firstDownloadState:
			| "in_progress"
			| "complete"
			| "interrupted"
			| "missing" = "in_progress";
		const first = createMailboxDebriefService({
			now: () => NOW,
			storage,
			async download(report) {
				firstReports.push(structuredClone(report));
				return 41;
			},
			async downloadState() {
				return firstDownloadState;
			},
		});
		const firstRun = executionHarness({
			storage: executionStorage,
			generateDebrief: (input) => first.generate(input),
		});
		await expect(firstRun.coordinator.start(command)).resolves.toMatchObject({
			status: "completed",
			debriefAvailable: false,
		});
		expect(durable.size).toBe(1);
		await expect(firstRun.journal.activeCommands()).resolves.toEqual([
			command,
		]);
		firstDownloadState = "interrupted";

		const restartedReports: unknown[] = [];
		const restarted = createMailboxDebriefService({
			now: () => new Date(NOW_MS + 60_000).toISOString(),
			storage,
			async download(report) {
				restartedReports.push(structuredClone(report));
				return 42;
			},
			async downloadState(downloadId) {
				return downloadId === 41 ? "interrupted" : "complete";
			},
		});
		const restartedDebriefs: unknown[] = [];
		const restartedRun = executionHarness({
			storage: executionStorage,
			external: firstRun.external,
			async generateDebrief(input) {
				const result = await restarted.generate(input);
				restartedDebriefs.push(result);
				return result;
			},
		});
		const retryPending = await restartedRun.coordinator.resume(command);

		expect(restartedDebriefs).toEqual([
			expect.objectContaining({
				status: "download_pending",
				downloadId: 42,
			}),
		]);
		expect(retryPending).toMatchObject({
			status: "completed",
			debriefAvailable: false,
		});
		const restartedResult = await restartedRun.coordinator.resume(command);
		expect(restartedDebriefs[1]).toMatchObject({
			status: "downloaded",
			downloadId: 42,
		});
		expect(restartedResult).toMatchObject({
			status: "completed",
			debriefAvailable: true,
		});
		await expect(restartedRun.journal.activeCommands()).resolves.toEqual([]);

		expect(firstReports).toHaveLength(1);
		expect(restartedReports).toEqual(firstReports);
		expect(
			new TextEncoder().encode(
				(firstReports[0] as { content: string }).content,
			),
		).toEqual(
			new TextEncoder().encode(
				(restartedReports[0] as { content: string }).content,
			),
		);
	});

	it("rejects completed terminal status until every action is verified", async () => {
		const accepted = acceptedRevision();
		const journal = createMailboxExecutionJournal({
			storage: new AtomicMemoryStorage(),
			now: () => NOW,
		});
		await journal.initialize(command, {
			accountAlias: ACCOUNT_ALIAS,
			revision: accepted,
			order: [0],
		});
		const lease = await journal.acquireLease(
			command,
			ACCOUNT_ALIAS,
			"worker:completion-check",
		);
		await journal.prepareLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		await journal.commitLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		await journal.transitionAction(
			command,
			lease!,
			0,
			"pending",
			"dispatched",
		);
		await journal.transitionAction(
			command,
			lease!,
			0,
			"dispatched",
			"observed",
			{ observation: { status: "observed", observedAt: NOW } },
		);
		await journal.prepareLifecycle(
			command,
			lease!,
			"in_flight",
			"completed",
			{ status: "completed" },
		);

		await expect(
			journal.finish(command, lease!, "completed"),
		).rejects.toMatchObject({
			code: "invalid_snapshot",
		});
	});

	it("rejects missing semantic prerequisites and replacement collisions", () => {
		const folder = alias("fld", 20);
		const replacement = alias("fld", 21);
		const create = {
			schemaVersion: 1 as const,
			actionAlias: actionAlias(20),
			type: "create_folder" as const,
			folderAlias: folder,
		};
		const move = {
			schemaVersion: 1 as const,
			actionAlias: actionAlias(21),
			type: "move_to_folder" as const,
			messageAlias: MESSAGE_ALIAS,
			folderAlias: folder,
		};
		expect(() => buildMailboxExecutionGraph([move, create])).toThrow();
		expect(
			buildMailboxExecutionGraph([
				create,
				{ ...move, dependsOn: [create.actionAlias] },
			]),
		).toEqual([0, 1]);

		const conflictingRenames = [
			{
				schemaVersion: 1 as const,
				actionAlias: actionAlias(22),
				type: "rename_folder" as const,
				folderAlias: alias("fld", 22),
				replacementFolderAlias: replacement,
			},
			{
				schemaVersion: 1 as const,
				actionAlias: actionAlias(23),
				type: "rename_folder" as const,
				folderAlias: alias("fld", 23),
				replacementFolderAlias: replacement,
			},
		];
		expect(() => buildMailboxExecutionGraph(conflictingRenames)).toThrow();
	});

	it("executes and verifies actions on both sides of the 100-action unit boundary", async () => {
		const actions = Array.from({ length: 101 }, (_, index) =>
			canonicalAction(
				"mark_read",
				index + 1_000,
				alias("msg", index + 1_000),
			),
		);
		const run = executionHarness({
			accepted: acceptedRevision(actions),
		});

		await expect(run.coordinator.start(command)).resolves.toMatchObject({
			status: "completed",
			debriefAvailable: true,
		});
		const snapshot = await run.journal.snapshot(command);

		expect(run.fake.calls.dispatch).toHaveLength(101);
		expect(run.fake.calls.verifyFresh).toHaveLength(101);
		expect(
			run.fake.calls.dispatch.map(
				(call) =>
					(call as MailboxProviderDispatchRequest).action.actionAlias,
			),
		).toEqual(actions.map((action) => action.actionAlias));
		expect(snapshot?.units).toEqual([
			{ startIndex: 0, endIndex: 99, state: "verified" },
			{ startIndex: 100, endIndex: 100, state: "verified" },
		]);
		expect(snapshot?.actions[100]).toMatchObject({
			state: "verified",
			result: {
				status: "completed",
				action: actions[100],
			},
		});
	});
});
