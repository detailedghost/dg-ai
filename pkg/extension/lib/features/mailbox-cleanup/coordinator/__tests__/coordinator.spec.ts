import { describe, expect, it, mock } from "bun:test";
import type { MailboxInventory, MailboxMessage } from "@dg/common";
import {
	computeMailboxCaptureChunkDigest,
	consumeMailboxCaptureChunks,
	createMailboxCaptureCoordinator,
	MAILBOX_CAPTURE_LIMITS,
	validateMailboxCaptureChunk,
	type MailboxCaptureChunk,
	type MailboxCoordinatorProviderSeams,
} from "../index";
import {
	computeMailboxScopedFingerprint,
	createMailboxCleanupChoices,
	mailboxFingerprintsMatch,
} from "../../planning";
import { createFakeMailboxProviderHarness } from "../../providers/fake";

const NOW = "2026-07-27T12:00:00.000Z";
const ACCOUNT_ALIAS = "acct_00112233445566778899aabbccddeeff";
const OTHER_ACCOUNT_ALIAS = "acct_102132435465768798a9bacbdcedfe0f";
const RUN_ALIAS = "run_2031425364758697a8b9cadbecfd0e1f";
const OTHER_RUN_ALIAS = "run_30415263748596a7b8c9daebfc0d1e2f";
const REVISION_ALIAS = "rev_405162738495a6b7c8d9eafb0c1d2e3f";

function alias(
	prefix: "msg" | "fld" | "lbl" | "flt" | "act",
	seed: number,
): string {
	const uniqueSuffix = seed.toString(16).padStart(8, "0");
	return `${prefix}_89abcdef01234567fedcba98${uniqueSuffix}`;
}

function message(
	seed: number,
	overrides: Partial<MailboxMessage> = {},
): MailboxMessage {
	return {
		alias: alias("msg", seed),
		read: false,
		hasAttachments: false,
		receivedAt: "2026-07-20T12:00:00.000Z",
		category: "newsletter",
		...overrides,
	};
}

function inventory(
	overrides: Partial<MailboxInventory> = {},
): MailboxInventory {
	return {
		schemaVersion: 1,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		runAlias: RUN_ALIAS,
		capturedAt: NOW,
		partial: false,
		messages: [
			message(1),
			message(2, {
				read: true,
				category: "personal",
				receivedAt: "2026-07-27T11:00:00.000Z",
			}),
		],
		folders: [{ alias: alias("fld", 1), messageCount: 2 }],
		labels: [{ alias: alias("lbl", 1), messageCount: 1 }],
		filters: [{ alias: alias("flt", 1), active: true }],
		...overrides,
	};
}

function fingerprintInput() {
	return {
		inventory: inventory(),
		metadata: { tags: [], categories: [] },
		actions: [
			{ type: "archive" as const, messageAlias: alias("msg", 1) },
		],
		targets: {
			folderAliases: [] as string[],
			labelAliases: [] as string[],
			filterAliases: [] as string[],
		},
	};
}

type ChunkOptions = Readonly<{
	runAlias?: string;
	sequence?: number;
	declaredTotal?: number;
	final?: true;
	kind?: string;
	items?: readonly unknown[];
}>;

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function settlesWithin<T>(
	promise: Promise<T>,
	milliseconds = 2_000,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Promise did not settle within ${milliseconds}ms`)),
					milliseconds,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function captureChunk(
	options: ChunkOptions = {},
): Promise<MailboxCaptureChunk> {
	const payload = {
		kind: options.kind ?? "messages",
		items: options.items ?? [message(1)],
	};
	const termination =
		options.final === true
			? { final: true as const }
			: { declaredTotal: options.declaredTotal ?? 1 };
	const envelope = {
		schemaVersion: 1 as const,
		runAlias: options.runAlias ?? RUN_ALIAS,
		sequence: options.sequence ?? 0,
		itemCount: payload.items.length,
		payload,
		...termination,
	};
	return {
		...envelope,
		digest: await computeMailboxCaptureChunkDigest(envelope),
	};
}

async function captureChunks(
	groups: readonly Readonly<{
		kind?: string;
		items: readonly unknown[];
	}>[],
): Promise<readonly MailboxCaptureChunk[]> {
	const payloads = groups.flatMap((group) => {
		const chunks = [];
		for (
			let offset = 0;
			offset < group.items.length;
			offset += MAILBOX_CAPTURE_LIMITS.chunkItems
		) {
			chunks.push({
				kind: group.kind,
				items: group.items.slice(
					offset,
					offset + MAILBOX_CAPTURE_LIMITS.chunkItems,
				),
			});
		}
		return chunks;
	});
	return await Promise.all(
		payloads.map((payload, sequence) =>
			captureChunk({
				sequence,
				declaredTotal: payloads.length,
				kind: payload.kind,
				items: payload.items,
			}),
		),
	);
}

const DEFAULT_CAPTURE_CHUNK = await captureChunk();

function captureRequest(bodyMessageAliases: readonly string[] = []) {
	return {
		schemaVersion: 1 as const,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		runAlias: RUN_ALIAS,
		revisionAlias: REVISION_ALIAS,
		bodyMessageAliases,
	};
}

function mailboxHarness(
	script: Parameters<typeof createFakeMailboxProviderHarness>[0] = {},
) {
	const bodyResults = script.bodyResults ?? [];
	const bodyBindings = Object.fromEntries(
		bodyResults.map((result, index) => [
			result.messageAlias,
			`provider-body-${index + 1}`,
		]),
	);
	const fake = createFakeMailboxProviderHarness({
		now: () => NOW,
		accountAlias: ACCOUNT_ALIAS,
		chunks: [DEFAULT_CAPTURE_CHUNK],
		...script,
		rawInventory:
			script.rawInventory ??
			{
				messages: bodyResults.map((_result, index) => ({
					id: `provider-body-${index + 1}`,
				})),
			},
		bindings: {
			...bodyBindings,
			...script.bindings,
		},
	});
	const states: string[] = [];
	const bodyConsent = mock(async (request: {
		runAlias: string;
		messageAliases: readonly string[];
	}) => ({
		granted: true,
		runAlias: request.runAlias,
		messageAliases: request.messageAliases,
	}));
	const coordinator = createMailboxCaptureCoordinator({
		provider: fake.coordinatorSeams,
		now: () => NOW,
		requestBodyConsent: bodyConsent,
		onProgress: (progress) => states.push(progress.state),
	});
	return { bodyConsent, coordinator, fake, states };
}

function coordinatorProvider(
	overrides: Partial<MailboxCoordinatorProviderSeams> = {},
): MailboxCoordinatorProviderSeams {
	return {
		probe: async () => ({
			status: "ready",
			accountAlias: ACCOUNT_ALIAS,
			surface: "inbox",
		}),
		async *capture() {
			yield await captureChunk({ final: true });
		},
		captureResult: async () => ({ status: "complete" }),
		readBodies: async () => [],
		...overrides,
	};
}

describe("mailbox capture chunk contract", () => {
	it("accepts one canonical total-based stream and one final-marker stream", async () => {
		const totalBased = await consumeMailboxCaptureChunks(
			[await captureChunk({ declaredTotal: 1 })],
			{ runAlias: RUN_ALIAS, limits: MAILBOX_CAPTURE_LIMITS },
		);
		const finalBased = await consumeMailboxCaptureChunks(
			[await captureChunk({ final: true })],
			{ runAlias: RUN_ALIAS, limits: MAILBOX_CAPTURE_LIMITS },
		);

		expect(totalBased).toEqual(finalBased);
		expect(totalBased.counts.messages).toBe(1);
	});

	it.each([
		[
			"missing run ID",
			async () => {
				const { runAlias: _runAlias, ...chunk } = await captureChunk();
				return [chunk as never];
			},
		],
		[
			"missing sequence",
			async () => {
				const { sequence: _sequence, ...chunk } = await captureChunk();
				return [chunk as never];
			},
		],
		[
			"missing total or final marker",
			async () => {
				const { declaredTotal: _declaredTotal, ...chunk } =
					await captureChunk();
				return [chunk as never];
			},
		],
		[
			"missing item count",
			async () => {
				const { itemCount: _itemCount, ...chunk } = await captureChunk();
				return [chunk as never];
			},
		],
		[
			"missing digest",
			async () => {
				const { digest: _digest, ...chunk } = await captureChunk();
				return [chunk as never];
			},
		],
		[
			"duplicate sequence",
			async () => [
				await captureChunk({ sequence: 0, declaredTotal: 2 }),
				await captureChunk({ sequence: 0, declaredTotal: 2 }),
			],
		],
		[
			"reordered sequence",
			async () => [
				await captureChunk({ sequence: 1, declaredTotal: 2 }),
				await captureChunk({ sequence: 0, declaredTotal: 2 }),
			],
		],
		[
			"cross-run chunk",
			async () => [await captureChunk({ runAlias: OTHER_RUN_ALIAS })],
		],
		[
			"incomplete declared total",
			async () => [await captureChunk({ sequence: 0, declaredTotal: 2 })],
		],
		[
			"incorrect item count",
			async () => [{ ...(await captureChunk()), itemCount: 2 }],
		],
		[
			"incorrect digest",
			async () => [{ ...(await captureChunk()), digest: "0".repeat(64) }],
		],
	])("rejects a %s as malformed_stream", async (_name, chunks) => {
		await expect(
			consumeMailboxCaptureChunks(await chunks(), {
				runAlias: RUN_ALIAS,
				limits: MAILBOX_CAPTURE_LIMITS,
			}),
		).rejects.toMatchObject({ code: "malformed_stream" });
	});

	it("keeps provider-declared truncation distinct from a broken stream", async () => {
		const partial = mailboxHarness({ captureStatus: "partial" });
		const broken = mailboxHarness({
			chunks: [await captureChunk({ declaredTotal: 2 })],
		});

		await expect(partial.coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "partial",
			reasonCode: "provider_partial",
			inventory: { partial: true },
		});
		await expect(broken.coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		});
	});
});

describe("mailbox capture coordinator", () => {
	it("publishes an explicit summary-first state machine and complete result", async () => {
		const { coordinator, states } = mailboxHarness({
			chunks: [
				await captureChunk({ sequence: 0, declaredTotal: 2 }),
				await captureChunk({
					sequence: 1,
					declaredTotal: 2,
					kind: "folders",
					items: [{ alias: alias("fld", 1), messageCount: 1 }],
				}),
			],
		});

		expect(coordinator.getState()).toBe("idle");
		await expect(coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "complete",
			counts: {
				messages: 1,
				folders: 1,
				labels: 0,
				tags: 0,
				categories: 0,
				filters: 0,
			},
			cohorts: expect.any(Array),
		});
		expect(states).toEqual([
			"probing",
			"binding_account",
			"capturing_summary",
			"capturing_metadata",
			"deriving_cohorts",
			"complete",
		]);
		expect(coordinator.getState()).toBe("complete");
	});

	it.each([
		["refused", "signed_out", "provider_refused"],
		["blocked_prompt", "security_prompt", "blocked_prompt"],
		["wrong_account", "wrong_account", "wrong_account"],
		["worker_suspended", "worker_suspended", "worker_suspended"],
	] as const)(
		"returns %s for provider probe result %s",
		async (status, probeStatus, reasonCode) => {
			const { coordinator } = mailboxHarness({
				probeResult: { status: probeStatus },
			});

			await expect(coordinator.start(captureRequest())).resolves.toMatchObject({
				status,
				reasonCode,
			});
			expect(coordinator.getState()).toBe(status);
		},
	);

	it.each([
		[
			"ready result with a reason code",
			{
				status: "ready",
				accountAlias: ACCOUNT_ALIAS,
				surface: "inbox",
				reasonCode: "provider_refused",
			},
		],
		[
			"failure result with account and surface",
			{
				status: "security_prompt",
				accountAlias: ACCOUNT_ALIAS,
				surface: "inbox",
			},
		],
		[
			"failure result with an extra key",
			{
				status: "wrong_account",
				extra: true,
			},
		],
	] as const)(
		"refuses a probe %s instead of accepting an inexact discriminant",
		async (_name, probeResult) => {
			const capture = mock(async function* () {
				yield await captureChunk({ final: true });
			});
			const coordinator = createMailboxCaptureCoordinator({
				provider: coordinatorProvider({
					probe: async () => probeResult as never,
					capture,
				}),
				now: () => NOW,
			});

			await expect(
				coordinator.start(captureRequest()),
			).resolves.toMatchObject({
				status: "refused",
				reasonCode: "provider_refused",
			});
			expect(capture).not.toHaveBeenCalled();
		},
	);

	it("fails closed on an ambiguous surface", async () => {
		const { coordinator, fake } = mailboxHarness({
			probeResult: { status: "ambiguous_surface" },
		});

		await expect(coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "refused",
			reasonCode: "layout_mismatch",
		});
		expect(fake.calls.capture).toHaveLength(0);
	});

	it("uses one abort signal and accepts no later chunk or body read after cancellation", async () => {
		let captureSignal: AbortSignal | undefined;
		let releaseSecondChunk = () => {};
		let reportFirstChunk = () => {};
		const firstChunkRead = new Promise<void>((resolve) => {
			reportFirstChunk = resolve;
		});
		const secondChunkGate = new Promise<void>((resolve) => {
			releaseSecondChunk = resolve;
		});
		const readBodies = mock(async () => []);
		const provider: MailboxCoordinatorProviderSeams = {
			probe: async () => ({
				status: "ready",
				accountAlias: ACCOUNT_ALIAS,
				surface: "inbox",
			}),
			async *capture(_request, signal) {
				captureSignal = signal;
				yield await captureChunk({ sequence: 0, declaredTotal: 2 });
				reportFirstChunk();
				await secondChunkGate;
				yield await captureChunk({ sequence: 1, declaredTotal: 2 });
			},
			captureResult: async () => ({ status: "complete" }),
			readBodies,
		};
		const coordinator = createMailboxCaptureCoordinator({
			provider,
			now: () => NOW,
			requestBodyConsent: async () => ({
				granted: true,
				runAlias: RUN_ALIAS,
				messageAliases: [alias("msg", 1)],
			}),
		});
		const running = coordinator.start(captureRequest([alias("msg", 1)]));
		await firstChunkRead;

		coordinator.cancel();
		releaseSecondChunk();

		await expect(running).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(captureSignal?.aborted).toBe(true);
		expect(readBodies).not.toHaveBeenCalled();
		expect(coordinator.getState()).toBe("canceled");
	});

	it("cancels promptly while the provider probe is unresolved", async () => {
		const entered = deferred();
		let probeSignal: AbortSignal | undefined;
		const provider = coordinatorProvider({
			probe: async (_request, signal) => {
				probeSignal = signal;
				entered.resolve();
				return await new Promise<never>(() => {});
			},
		});
		const coordinator = createMailboxCaptureCoordinator({
			provider,
			now: () => NOW,
		});
		const running = coordinator.start(captureRequest());
		await entered.promise;

		coordinator.cancel();

		await expect(settlesWithin(running)).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(probeSignal?.aborted).toBe(true);
	});

	it("cancels an unresolved iterator and closes it with return", async () => {
		const entered = deferred();
		const iteratorReturned = mock(async () => ({
			done: true as const,
			value: undefined,
		}));
		const stream: AsyncIterable<MailboxCaptureChunk> = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						entered.resolve();
						return new Promise<IteratorResult<MailboxCaptureChunk>>(() => {});
					},
					return: iteratorReturned,
				};
			},
		};
		const coordinator = createMailboxCaptureCoordinator({
			provider: coordinatorProvider({
				capture: () => stream,
			}),
			now: () => NOW,
		});
		const running = coordinator.start(captureRequest());
		await entered.promise;

		coordinator.cancel();

		await expect(settlesWithin(running)).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(iteratorReturned).toHaveBeenCalledTimes(1);
	});

	it("cancels promptly while post-stream capture status is unresolved", async () => {
		const entered = deferred();
		const provider = coordinatorProvider({
			captureResult: async (..._args: unknown[]) => {
				entered.resolve();
				return await new Promise<never>(() => {});
			},
		});
		const coordinator = createMailboxCaptureCoordinator({
			provider,
			now: () => NOW,
		});
		const running = coordinator.start(captureRequest());
		await entered.promise;

		coordinator.cancel();

		await expect(settlesWithin(running)).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
	});

	it("cancels promptly while body consent is unresolved", async () => {
		const entered = deferred();
		const coordinator = createMailboxCaptureCoordinator({
			provider: coordinatorProvider(),
			now: () => NOW,
			requestBodyConsent: async (..._args: unknown[]) => {
				entered.resolve();
				return await new Promise<never>(() => {});
			},
		});
		const running = coordinator.start(
			captureRequest([alias("msg", 1)]),
		);
		await entered.promise;

		coordinator.cancel();

		await expect(settlesWithin(running)).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
	});

	it("cancels promptly while body reads are unresolved", async () => {
		const entered = deferred();
		let bodySignal: AbortSignal | undefined;
		const provider = coordinatorProvider({
			readBodies: async (_request, signal) => {
				bodySignal = signal;
				entered.resolve();
				return await new Promise<never>(() => {});
			},
		});
		const coordinator = createMailboxCaptureCoordinator({
			provider,
			now: () => NOW,
			requestBodyConsent: async (request) => ({
				granted: true,
				runAlias: request.runAlias,
				messageAliases: request.messageAliases,
			}),
		});
		const running = coordinator.start(
			captureRequest([alias("msg", 1)]),
		);
		await entered.promise;

		coordinator.cancel();

		await expect(settlesWithin(running)).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(bodySignal?.aborted).toBe(true);
	});

	it("lets a timer cancel a many-chunk capture before the stream completes", async () => {
		const chunkCount = 256;
		const chunks = await Promise.all(
			Array.from({ length: chunkCount }, (_unused, sequence) =>
				captureChunk({
					sequence,
					declaredTotal: chunkCount,
					items: [message(sequence + 1)],
				}),
			),
		);
		let yielded = 0;
		const captureResult = mock(async () => ({ status: "complete" as const }));
		let coordinator!: ReturnType<typeof createMailboxCaptureCoordinator>;
		const provider = coordinatorProvider({
			capture() {
				return {
					async *[Symbol.asyncIterator]() {
						for (const chunk of chunks) {
							yielded += 1;
							if (yielded === 1) {
								setTimeout(() => coordinator.cancel(), 0);
							}
							yield chunk;
						}
					},
				};
			},
			captureResult,
		});
		coordinator = createMailboxCaptureCoordinator({
			provider,
			now: () => NOW,
		});

		await expect(
			settlesWithin(coordinator.start(captureRequest()), 5_000),
		).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(yielded).toBeGreaterThan(0);
		expect(yielded).toBeLessThan(chunkCount);
		expect(captureResult).not.toHaveBeenCalled();
	});

	it.each([
		["probing", "probe"],
		["binding_account", "capture"],
		["capturing_summary", "capture"],
		["capturing_metadata", "captureResult"],
		["awaiting_body_consent", "bodyConsent"],
		["checking_bodies", "readBodies"],
	] as const)(
		"honors synchronous cancellation from %s progress before calling %s",
		async (cancelState, nextSeam) => {
			const chunk = await captureChunk({ final: true });
			const states: string[] = [];
			const calls = {
				probe: 0,
				capture: 0,
				captureResult: 0,
				bodyConsent: 0,
				readBodies: 0,
			};
			const provider: MailboxCoordinatorProviderSeams = {
				probe: async () => {
					calls.probe += 1;
					return {
						status: "ready",
						accountAlias: ACCOUNT_ALIAS,
						surface: "inbox",
					};
				},
				capture() {
					calls.capture += 1;
					return {
						async *[Symbol.asyncIterator]() {
							yield chunk;
						},
					};
				},
				captureResult: async () => {
					calls.captureResult += 1;
					return { status: "complete" };
				},
				readBodies: async () => {
					calls.readBodies += 1;
					return [
						{
							messageAlias: alias("msg", 1),
							text: "safe",
							attachments: [],
							quotedHistory: "",
						},
					];
				},
			};
			let coordinator!: ReturnType<typeof createMailboxCaptureCoordinator>;
			coordinator = createMailboxCaptureCoordinator({
				provider,
				now: () => NOW,
				requestBodyConsent: async (request) => {
					calls.bodyConsent += 1;
					return {
						granted: true,
						runAlias: request.runAlias,
						messageAliases: request.messageAliases,
					};
				},
				onProgress: ({ state }) => {
					states.push(state);
					if (state === cancelState) coordinator.cancel();
				},
			});
			const needsBody =
				cancelState === "awaiting_body_consent" ||
				cancelState === "checking_bodies";

			await expect(
				coordinator.start(
					captureRequest(needsBody ? [alias("msg", 1)] : []),
				),
			).resolves.toMatchObject({
				status: "canceled",
				reasonCode: "canceled",
			});
			expect(calls[nextSeam]).toBe(0);
			if (cancelState === "binding_account") {
				expect(states).toEqual([
					"probing",
					"binding_account",
					"canceled",
				]);
			}
		},
	);

	it("honors synchronous cancellation before deriving cohorts or publishing completion", async () => {
		const states: string[] = [];
		let coordinator!: ReturnType<typeof createMailboxCaptureCoordinator>;
		coordinator = createMailboxCaptureCoordinator({
			provider: coordinatorProvider(),
			now: () => NOW,
			onProgress: ({ state }) => {
				states.push(state);
				if (state === "deriving_cohorts") coordinator.cancel();
			},
		});

		await expect(coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(states).not.toContain("complete");
	});

	it("lets a timer cancel deriving and planning before any later progress", async () => {
		const messages = Array.from({ length: 1_000 }, (_unused, index) =>
			message(index + 1),
		);
		const chunks = await captureChunks([{ items: messages }]);
		const states: string[] = [];
		let cancellationScheduledAt = 0;
		let coordinator!: ReturnType<typeof createMailboxCaptureCoordinator>;
		coordinator = createMailboxCaptureCoordinator({
			provider: coordinatorProvider({
				async *capture() {
					for (const chunk of chunks) yield chunk;
				},
			}),
			now: () => NOW,
			onProgress: ({ state }) => {
				states.push(state);
				if (state === "deriving_cohorts") {
					cancellationScheduledAt = performance.now();
					setTimeout(() => coordinator.cancel(), 0);
				}
			},
		});

		await expect(
			settlesWithin(coordinator.start(captureRequest()), 10_000),
		).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(performance.now() - cancellationScheduledAt).toBeLessThan(2_000);
		const derivingIndex = states.indexOf("deriving_cohorts");
		expect(derivingIndex).toBeGreaterThanOrEqual(0);
		expect(states.slice(derivingIndex + 1)).toEqual(["canceled"]);
	});

	it("honors a post-capture-result timer cancellation without later completion progress", async () => {
		const messages = Array.from({ length: 1_000 }, (_unused, index) =>
			message(index + 1),
		);
		const chunks = await captureChunks([{ items: messages }]);
		const states: string[] = [];
		let cancellationScheduledAt = 0;
		let progressCountAtCancel = -1;
		let coordinator!: ReturnType<typeof createMailboxCaptureCoordinator>;
		coordinator = createMailboxCaptureCoordinator({
			provider: coordinatorProvider({
				async *capture() {
					for (const chunk of chunks) yield chunk;
				},
				captureResult: async () => {
					cancellationScheduledAt = performance.now();
					setTimeout(() => {
						progressCountAtCancel = states.length;
						coordinator.cancel();
					}, 0);
					return { status: "complete" };
				},
			}),
			now: () => NOW,
			onProgress: ({ state }) => {
				states.push(state);
			},
		});

		await expect(
			settlesWithin(coordinator.start(captureRequest()), 10_000),
		).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
		});
		expect(progressCountAtCancel).toBeGreaterThanOrEqual(0);
		expect(performance.now() - cancellationScheduledAt).toBeLessThan(5_000);
		expect(states.slice(progressCountAtCancel)).toEqual(["canceled"]);
		expect(states).not.toContain("complete");
	});

	it.each([
		["empty", 0],
		["within the limit", MAILBOX_CAPTURE_LIMITS.bodyAliases],
	] as const)(
		"uses the call-time frozen body selection when the %s request array later grows to 21",
		async (_name, initialCount) => {
			const aliases = Array.from(
				{ length: MAILBOX_CAPTURE_LIMITS.bodyAliases + 1 },
				(_unused, index) => alias("msg", index + 1),
			);
			const chunks = await captureChunks([
				{
					items: aliases.map((_messageAlias, index) =>
						message(index + 1),
					),
				},
			]);
			const probeGate = deferred();
			const bodyMessageAliases = aliases.slice(0, initialCount);
			const consentedAliases: string[][] = [];
			const readAliases: string[][] = [];
			const exposedArraysWereFrozen: boolean[] = [];
			const provider = coordinatorProvider({
				probe: async () => {
					await probeGate.promise;
					return {
						status: "ready",
						accountAlias: ACCOUNT_ALIAS,
						surface: "inbox",
					};
				},
				async *capture() {
					for (const chunk of chunks) yield chunk;
				},
				readBodies: async (request) => {
					exposedArraysWereFrozen.push(
						Object.isFrozen(request.messageAliases),
					);
					readAliases.push([...request.messageAliases]);
					return request.messageAliases.map((messageAlias) => ({
						messageAlias,
						text: "safe",
						attachments: [],
						quotedHistory: "",
					}));
				},
			});
			const coordinator = createMailboxCaptureCoordinator({
				provider,
				now: () => NOW,
				requestBodyConsent: async (request) => {
					exposedArraysWereFrozen.push(
						Object.isFrozen(request.messageAliases),
					);
					consentedAliases.push([...request.messageAliases]);
					return {
						granted: true,
						runAlias: request.runAlias,
						messageAliases: request.messageAliases,
					};
				},
			});

			const running = coordinator.start({
				...captureRequest(),
				bodyMessageAliases,
			});
			bodyMessageAliases.push(...aliases.slice(initialCount));
			probeGate.resolve();

			const result = await running;
			expect(bodyMessageAliases).toHaveLength(
				MAILBOX_CAPTURE_LIMITS.bodyAliases + 1,
			);
			expect(result).toMatchObject({ status: "complete" });
			const expectedAliases = aliases.slice(0, initialCount);
			expect(consentedAliases).toEqual(
				initialCount === 0 ? [] : [expectedAliases],
			);
			expect(readAliases).toEqual(
				initialCount === 0 ? [] : [expectedAliases],
			);
			expect(exposedArraysWereFrozen).toEqual(
				initialCount === 0 ? [] : [true, true],
			);
			if (result.status === "complete") {
				expect(result.bodyChecks?.results ?? []).toHaveLength(
					initialCount,
				);
			}
		},
	);

	it("keeps summary-first ordering and rejects metadata-first capture", async () => {
		const statesAtPull: string[] = [];
		let coordinator!: ReturnType<typeof createMailboxCaptureCoordinator>;
		const provider = coordinatorProvider({
			async *capture() {
				yield await captureChunk({ sequence: 0, declaredTotal: 2 });
				statesAtPull.push(coordinator.getState());
				yield await captureChunk({
					sequence: 1,
					declaredTotal: 2,
					kind: "folders",
					items: [{ alias: alias("fld", 1), messageCount: 1 }],
				});
				statesAtPull.push(coordinator.getState());
			},
		});
		coordinator = createMailboxCaptureCoordinator({
			provider,
			now: () => NOW,
		});

		await expect(coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "complete",
		});
		expect(statesAtPull).toEqual([
			"capturing_summary",
			"capturing_metadata",
		]);

		const metadataFirst = createMailboxCaptureCoordinator({
			provider: coordinatorProvider({
				async *capture() {
					yield await captureChunk({
						final: true,
						kind: "folders",
						items: [{ alias: alias("fld", 1), messageCount: 1 }],
					});
				},
			}),
			now: () => NOW,
		});
		await expect(
			metadataFirst.start(captureRequest()),
		).resolves.toMatchObject({
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		});
	});

	it("queries capture status after the stream with the same scoped request and signal", async () => {
		let streamFinished = false;
		let captureSignal: AbortSignal | undefined;
		let captureResultArgs: readonly unknown[] = [];
		const provider = coordinatorProvider({
			async *capture(_request, signal) {
				captureSignal = signal;
				yield await captureChunk({ final: true });
				streamFinished = true;
			},
			captureResult: async (...args: unknown[]) => {
				captureResultArgs = args;
				if (!streamFinished) throw new Error("capture status requested too early");
				return {
					status: "partial",
					reasonCode: "provider_partial",
				};
			},
		});
		const coordinator = createMailboxCaptureCoordinator({
			provider,
			now: () => NOW,
		});

		await expect(coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "partial",
			reasonCode: "provider_partial",
			inventory: { partial: true },
		});
		expect(captureResultArgs[0]).toEqual({
			providerId: "fake-mail",
			surface: "inbox",
			accountAlias: ACCOUNT_ALIAS,
			runAlias: RUN_ALIAS,
			revisionAlias: REVISION_ALIAS,
		});
		expect(captureResultArgs[1]).toBe(captureSignal);
	});

	it.each([
		["unknown status", { status: "garbage" }],
		["extra completion key", { status: "complete", extra: true }],
		[
			"complete result with an own undefined reason",
			{ status: "complete", reasonCode: undefined },
		],
		[
			"partial result with an extra key",
			{
				status: "partial",
				reasonCode: "provider_partial",
				extra: true,
			},
		],
		[
			"partial result without its reason",
			{ status: "partial" },
		],
	] as const)(
		"classifies a malformed post-stream %s as malformed_stream",
		async (_name, completion) => {
			const coordinator = createMailboxCaptureCoordinator({
				provider: coordinatorProvider({
					captureResult: async () => completion as never,
				}),
				now: () => NOW,
			});

			await expect(
				coordinator.start(captureRequest()),
			).resolves.toMatchObject({
				status: "malformed_stream",
				reasonCode: "malformed_stream",
			});
		},
	);

	it("keeps an active run state unchanged when a concurrent start is refused", async () => {
		const entered = deferred();
		const coordinator = createMailboxCaptureCoordinator({
			provider: coordinatorProvider({
				probe: async () => {
					entered.resolve();
					return await new Promise<never>(() => {});
				},
			}),
			now: () => NOW,
		});
		const active = coordinator.start(captureRequest());
		await entered.promise;

		await expect(
			coordinator.start(captureRequest()),
		).resolves.toMatchObject({
			status: "refused",
			reasonCode: "provider_refused",
		});
		expect(coordinator.getState()).toBe("probing");

		coordinator.cancel();
		await expect(settlesWithin(active)).resolves.toMatchObject({
			status: "canceled",
		});
	});

	it("recognizes typed worker suspension without trusting an error message", async () => {
		const typed = mailboxHarness({
			failures: { capture: "worker_suspended" },
		});
		const untyped = createMailboxCaptureCoordinator({
			provider: coordinatorProvider({
				async *capture() {
					throw new Error("worker_suspended");
				},
			}),
			now: () => NOW,
		});

		await expect(typed.coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "worker_suspended",
			reasonCode: "worker_suspended",
		});
		await expect(untyped.start(captureRequest())).resolves.toMatchObject({
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		});
	});
});

describe("mailbox coordinator stream bounds, limits, and body consent", () => {
	it("publishes exact message and body limits plus concrete bounded collection limits", () => {
		expect(MAILBOX_CAPTURE_LIMITS.messages).toBe(5_000);
		expect(MAILBOX_CAPTURE_LIMITS.bodyAliases).toBe(20);
		expect(MAILBOX_CAPTURE_LIMITS.bodyUnicodeCharacters).toBe(2_000);
		for (const key of [
			"folders",
			"labels",
			"tags",
			"categories",
			"filters",
			"chunks",
			"chunkItems",
			"bufferedChunks",
			"assembledInventoryItems",
			"sanitizedTextCharacters",
			"chatPayloadCharacters",
		] as const) {
			expect(Number.isSafeInteger(MAILBOX_CAPTURE_LIMITS[key])).toBe(true);
			expect(MAILBOX_CAPTURE_LIMITS[key]).toBeGreaterThan(0);
		}
		expect(MAILBOX_CAPTURE_LIMITS.chunkItems).toBeLessThan(
			MAILBOX_CAPTURE_LIMITS.messages,
		);
	});

	it("binds the digest to the full envelope and rejects re-enveloping or cross-run replay", async () => {
		const original = await captureChunk({ declaredTotal: 1 });
		const { declaredTotal: _declaredTotal, ...withoutTotal } = original;
		const reEnveloped = {
			...withoutTotal,
			final: true as const,
		};
		const crossRun = await captureChunk({
			runAlias: OTHER_RUN_ALIAS,
			declaredTotal: 1,
		});

		await expect(
			consumeMailboxCaptureChunks([reEnveloped], {
				runAlias: RUN_ALIAS,
				limits: MAILBOX_CAPTURE_LIMITS,
			}),
		).rejects.toMatchObject({ code: "malformed_stream" });
		await expect(
			consumeMailboxCaptureChunks([crossRun], {
				runAlias: RUN_ALIAS,
				limits: MAILBOX_CAPTURE_LIMITS,
			}),
		).rejects.toMatchObject({ code: "malformed_stream" });
	});

	it("returns an immutable digest-bound snapshot when an item mutates during WebCrypto", async () => {
		const expectedItem = message(1);
		const mutableItem = { ...expectedItem };
		const source = await captureChunk({ items: [mutableItem] });
		const validating = validateMailboxCaptureChunk(source);
		queueMicrotask(() => {
			mutableItem.category = "personal";
			mutableItem.read = true;
		});

		const validated = await validating;
		const { digest, ...envelope } = validated;
		const assembled = await consumeMailboxCaptureChunks([validated], {
			runAlias: RUN_ALIAS,
			limits: MAILBOX_CAPTURE_LIMITS,
		});

		expect(mutableItem).toMatchObject({
			category: "personal",
			read: true,
		});
		expect(validated.payload.items).toEqual([expectedItem]);
		expect(await computeMailboxCaptureChunkDigest(envelope)).toBe(digest);
		expect(assembled.messages).toEqual([expectedItem]);
		expect(Object.isFrozen(validated)).toBe(true);
		expect(Object.isFrozen(validated.payload)).toBe(true);
		expect(Object.isFrozen(validated.payload.items)).toBe(true);
		expect(Object.isFrozen(validated.payload.items[0])).toBe(true);
	});

	it("does not append a microtask item past the digest count or stream limits", async () => {
		const expectedItem = message(1);
		const mutableItems = [{ ...expectedItem }];
		const source = await captureChunk({ items: mutableItems });
		const validating = validateMailboxCaptureChunk(source);
		queueMicrotask(() => {
			mutableItems.push(message(2));
		});

		const validated = await validating;
		const { digest, ...envelope } = validated;
		const assembled = await consumeMailboxCaptureChunks([validated], {
			runAlias: RUN_ALIAS,
			limits: {
				...MAILBOX_CAPTURE_LIMITS,
				messages: 1,
				chunkItems: 1,
				assembledInventoryItems: 1,
			},
		});

		expect(mutableItems).toHaveLength(2);
		expect(validated.itemCount).toBe(1);
		expect(validated.payload.items).toEqual([expectedItem]);
		expect(await computeMailboxCaptureChunkDigest(envelope)).toBe(digest);
		expect(assembled.counts.messages).toBe(1);
		expect(assembled.messages).toEqual([expectedItem]);
		expect(Object.isFrozen(assembled.messages)).toBe(true);
	});

	it("accepts one bounded empty message summary and rejects other non-final empty chunks", async () => {
		const empty = await captureChunk({
			sequence: 0,
			declaredTotal: 2,
			items: [],
		});
		const following = await captureChunk({
			sequence: 1,
			declaredTotal: 2,
			kind: "tags",
			items: [{ alias: alias("lbl", 1), messageCount: 0 }],
		});
		await expect(
			consumeMailboxCaptureChunks([empty, following], {
				runAlias: RUN_ALIAS,
				limits: MAILBOX_CAPTURE_LIMITS,
			}),
		).resolves.toMatchObject({
			counts: { messages: 0, tags: 1 },
			messages: [],
		});

		const invalidEmpty = await captureChunk({
			sequence: 1,
			declaredTotal: 2,
			kind: "tags",
			items: [],
		});
		await expect(
			consumeMailboxCaptureChunks([empty, invalidEmpty], {
				runAlias: RUN_ALIAS,
				limits: MAILBOX_CAPTURE_LIMITS,
			}),
		).rejects.toMatchObject({ code: "malformed_stream" });
	});

	it("rejects impossible declared totals before pulling again", async () => {

		const iteratorReturned = mock(async () => ({
			done: true as const,
			value: undefined,
		}));
		let pulls = 0;
		const never = new Promise<IteratorResult<MailboxCaptureChunk>>(() => {});
		const impossibleTotal = await captureChunk({
			declaredTotal: Number.MAX_SAFE_INTEGER,
		});
		const stream: AsyncIterable<MailboxCaptureChunk> = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						pulls += 1;
						if (pulls === 1) {
							return Promise.resolve({
								done: false as const,
								value: impossibleTotal,
							});
						}
						return never;
					},
					return: iteratorReturned,
				};
			},
		};

		await expect(
			settlesWithin(
				consumeMailboxCaptureChunks(stream, {
					runAlias: RUN_ALIAS,
					limits: MAILBOX_CAPTURE_LIMITS,
				}),
			),
		).rejects.toMatchObject({ code: "malformed_stream" });
		expect(pulls).toBe(1);
		expect(iteratorReturned).toHaveBeenCalledTimes(1);
	});

	it("accepts exactly 5000 messages, truthfully truncates there, and rejects 5001", async () => {
		const maximum = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.messages },
			(_, index) => message(index + 1),
		);
		const accepted = mailboxHarness({
			chunks: await captureChunks([{ items: maximum }]),
			captureStatus: "partial",
		});
		const overflow = mailboxHarness({
			chunks: await captureChunks([
				{ items: [...maximum, message(5_001)] },
			]),
		});
		const startedAt = performance.now();

		await expect(accepted.coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "partial",
			counts: { messages: 5_000 },
			inventory: { messages: expect.any(Array), partial: true },
		});
		await expect(overflow.coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		});
		expect(performance.now() - startedAt).toBeLessThan(15_000);
	});

	it("accepts the combined published collection maxima within a coarse runtime budget", async () => {
		const messages = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.messages },
			(_, index) => message(index + 1),
		);
		const folders = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.folders },
			(_, index) => ({
				alias: alias("fld", index + 1),
				messageCount: 0,
			}),
		);
		const labels = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.labels },
			(_, index) => ({
				alias: alias("lbl", index + 1),
				messageCount: 0,
			}),
		);
		const tags = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.tags },
			(_, index) => ({
				alias: alias("lbl", MAILBOX_CAPTURE_LIMITS.labels + index + 1),
				messageCount: 0,
			}),
		);
		const categories = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.categories },
			(_, index) => ({
				alias: alias(
					"lbl",
					MAILBOX_CAPTURE_LIMITS.labels +
						MAILBOX_CAPTURE_LIMITS.tags +
						index +
						1,
				),
				messageCount: 0,
			}),
		);
		const filters = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.filters },
			(_, index) => ({
				alias: alias("flt", index + 1),
				active: true,
			}),
		);
		const chunks = await captureChunks([
			{ items: messages },
			{ kind: "folders", items: folders },
			{ kind: "labels", items: labels },
			{ kind: "tags", items: tags },
			{ kind: "categories", items: categories },
			{ kind: "filters", items: filters },
		]);
		const { coordinator } = mailboxHarness({ chunks });
		const startedAt = performance.now();

		await expect(coordinator.start(captureRequest())).resolves.toMatchObject({
			status: "complete",
			counts: {
				messages: MAILBOX_CAPTURE_LIMITS.messages,
				folders: MAILBOX_CAPTURE_LIMITS.folders,
				labels: MAILBOX_CAPTURE_LIMITS.labels,
				tags: MAILBOX_CAPTURE_LIMITS.tags,
				categories: MAILBOX_CAPTURE_LIMITS.categories,
				filters: MAILBOX_CAPTURE_LIMITS.filters,
			},
		});
		expect(performance.now() - startedAt).toBeLessThan(30_000);
	});

	it.each([
		["folders", "fld"],
		["labels", "lbl"],
		["tags", "lbl"],
		["categories", "lbl"],
		["filters", "flt"],
	] as const)(
		"enforces the published %s collection limit",
		async (kind, prefix) => {
			const limit = MAILBOX_CAPTURE_LIMITS[kind];
			const item = (index: number) =>
				kind === "filters"
					? { alias: alias(prefix, index + 1), active: true }
					: { alias: alias(prefix, index + 1), messageCount: 0 };
			const atLimit = Array.from({ length: limit }, (_, index) => item(index));
			const accepted = await captureChunks([
				{ items: [message(1)] },
				{ kind, items: atLimit },
			]);
			const overflow = await captureChunks([
				{ items: [message(1)] },
				{ kind, items: [...atLimit, item(limit)] },
			]);

			await expect(
				consumeMailboxCaptureChunks(accepted, {
					runAlias: RUN_ALIAS,
					limits: MAILBOX_CAPTURE_LIMITS,
				}),
			).resolves.toMatchObject({ counts: { [kind]: limit } });
			await expect(
				consumeMailboxCaptureChunks(overflow, {
					runAlias: RUN_ALIAS,
					limits: MAILBOX_CAPTURE_LIMITS,
				}),
			).rejects.toMatchObject({ code: "malformed_stream" });
		},
	);

	it("processes an async stream with one-chunk backpressure", async () => {
		let pendingNext = 0;
		let maximumPendingNext = 0;
		const chunks = [
			await captureChunk({ sequence: 0, declaredTotal: 2 }),
			await captureChunk({
				sequence: 1,
				declaredTotal: 2,
				items: [message(2)],
			}),
		];
		const stream: AsyncIterable<MailboxCaptureChunk> = {
			[Symbol.asyncIterator]() {
				let index = 0;
				return {
					async next() {
						pendingNext += 1;
						maximumPendingNext = Math.max(maximumPendingNext, pendingNext);
						await Promise.resolve();
						const value = chunks[index];
						index += 1;
						pendingNext -= 1;
						return value === undefined
							? { done: true, value: undefined }
							: { done: false, value };
					},
				};
			},
		};

		await consumeMailboxCaptureChunks(stream, {
			runAlias: RUN_ALIAS,
			limits: MAILBOX_CAPTURE_LIMITS,
		});
		expect(maximumPendingNext).toBe(1);
	});

	it("enforces chunk and assembled-inventory limits before buffering more input", async () => {
		const twoMessages = [message(1), message(2)];
		const tinyLimits = {
			...MAILBOX_CAPTURE_LIMITS,
			chunkItems: 1,
			assembledInventoryItems: 1,
		};

		await expect(
			consumeMailboxCaptureChunks(
				[await captureChunk({ items: twoMessages })],
				{ runAlias: RUN_ALIAS, limits: tinyLimits },
			),
		).rejects.toMatchObject({ code: "malformed_stream" });
	});

	it("asks once per run for explicit aliases and never reads bodies after refusal", async () => {
		const aliases = [alias("msg", 1), alias("msg", 2)];
		const { bodyConsent, coordinator, fake } = mailboxHarness({
			chunks: [
				await captureChunk({
					items: aliases.map((_messageAlias, index) => message(index + 1)),
				}),
			],
			bodyResults: aliases.map((messageAlias) => ({
				messageAlias,
				text: "safe body",
				attachments: [],
				quotedHistory: "",
			})),
		});
		bodyConsent.mockResolvedValueOnce({
			granted: false,
			runAlias: RUN_ALIAS,
			messageAliases: aliases,
		});

		await expect(coordinator.start(captureRequest(aliases))).resolves.toMatchObject({
			status: "refused",
			reasonCode: "provider_refused",
		});
		expect(bodyConsent).toHaveBeenCalledTimes(1);
		const consentCall = bodyConsent.mock.calls[0] as unknown as readonly unknown[];
		expect(consentCall[0]).toEqual({
			runAlias: RUN_ALIAS,
			messageAliases: aliases,
		});
		expect(fake.calls.readBodies).toHaveLength(0);
	});

	it("accepts an exact body-read result and rejects an extra own key without body output", async () => {
		const exactBody = {
			messageAlias: alias("msg", 1),
			text: "safe body",
			attachments: [],
			quotedHistory: "",
		};
		const accepted = mailboxHarness({
			bodyResults: [exactBody],
		});
		const extraKeySentinel = "RAW_PROVIDER_BODY_SENTINEL";
		const rejected = mailboxHarness({
			bodyResults: [
				{
					...exactBody,
					rawProviderValue: extraKeySentinel,
				} as never,
			],
		});

		await expect(
			accepted.coordinator.start(
				captureRequest([exactBody.messageAlias]),
			),
		).resolves.toMatchObject({
			status: "complete",
			bodyChecks: {
				results: [
					{
						messageAlias: exactBody.messageAlias,
						text: exactBody.text,
					},
				],
			},
		});
		const malformed = await rejected.coordinator.start(
			captureRequest([exactBody.messageAlias]),
		);
		expect(malformed).toEqual({
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		});
		expect("bodyChecks" in malformed).toBe(false);
		expect(JSON.stringify(malformed)).not.toContain(extraKeySentinel);
	});

	it("preserves tags and categories as planning-visible label metadata", async () => {
		const tagAlias = alias("lbl", 101);
		const categoryAlias = alias("lbl", 102);
		const { coordinator } = mailboxHarness({
			chunks: [
				await captureChunk({ sequence: 0, declaredTotal: 3 }),
				await captureChunk({
					sequence: 1,
					declaredTotal: 3,
					kind: "tags",
					items: [{ alias: tagAlias, messageCount: 1 }],
				}),
				await captureChunk({
					sequence: 2,
					declaredTotal: 3,
					kind: "categories",
					items: [{ alias: categoryAlias, messageCount: 1 }],
				}),
			],
		});

		const result = await coordinator.start(captureRequest());
		expect(result).toMatchObject({
			status: "complete",
			metadata: {
				tags: [
					{ alias: tagAlias, messageCount: 1 },
				],
				categories: [
					{ alias: categoryAlias, messageCount: 1 },
				],
			},
		});
		if (result.status !== "complete") {
			throw new Error("Expected complete capture");
		}
		for (const choice of result.choices) {
			expect(choice.metadata).toEqual({
				tagAliases: [tagAlias],
				categoryAliases: [categoryAlias],
			});
		}
	});

	it("allows at most 20 explicitly consented aliases", async () => {
		const maximum = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.bodyAliases },
			(_, index) => alias("msg", index + 1),
		);
		const accepted = mailboxHarness({
			chunks: [
				await captureChunk({
					items: maximum.map((_messageAlias, index) => message(index + 1)),
				}),
			],
			bodyResults: maximum.map((messageAlias) => ({
				messageAlias,
				text: "safe",
				attachments: [],
				quotedHistory: "",
			})),
		});
		const overflowAliases = [
			...maximum,
			alias("msg", maximum.length + 1),
		];
		const overflow = mailboxHarness({
			chunks: [
				await captureChunk({
					items: overflowAliases.map(
						(_messageAlias, index) => message(index + 1),
					),
				}),
			],
		});

		await expect(accepted.coordinator.start(captureRequest(maximum))).resolves.toMatchObject({
			status: "complete",
			bodyChecks: { results: expect.any(Array) },
		});
		await expect(
			overflow.coordinator.start(
				captureRequest(overflowAliases),
			),
		).resolves.toMatchObject({
			status: "refused",
			reasonCode: "provider_refused",
		});
		expect(overflow.fake.calls.readBodies).toHaveLength(0);
	});

	it("rejects body aliases that were not captured in this run", async () => {
		const unknownAlias = alias("msg", 99);
		const { bodyConsent, coordinator, fake } = mailboxHarness({
			bodyResults: [
				{
					messageAlias: unknownAlias,
					text: "must not be read",
					attachments: [],
					quotedHistory: "",
				},
			],
		});

		await expect(
			coordinator.start(captureRequest([unknownAlias])),
		).resolves.toMatchObject({
			status: "refused",
			reasonCode: "provider_refused",
		});
		expect(bodyConsent).not.toHaveBeenCalled();
		expect(fake.calls.readBodies).toHaveLength(0);
	});

	it.each([
		[
			"Outlook original-message block",
			"-----Original Message-----\nFrom: someone@example.com\nQuoted secret",
		],
		[
			"On-wrote reply block",
			"On Monday, July 27, 2026, someone@example.com wrote:\nQuoted secret",
		],
		[
			"HTML blockquote",
			"<blockquote><p>Quoted secret</p></blockquote>",
		],
	] as const)("removes a start-of-body %s", async (_name, text) => {
		const { coordinator } = mailboxHarness({
			bodyResults: [
				{
					messageAlias: alias("msg", 1),
					text,
					attachments: [],
					quotedHistory: "",
				},
			],
		});

		await expect(
			coordinator.start(captureRequest([alias("msg", 1)])),
		).resolves.toMatchObject({
			status: "complete",
			bodyChecks: {
				results: [
					{
						messageAlias: alias("msg", 1),
						text: "",
						characterCount: 0,
					},
				],
			},
		});
	});

	it("fails closed by removing localized quoted-history markers", async () => {
		const { coordinator } = mailboxHarness({
			bodyResults: [
				{
					messageAlias: alias("msg", 1),
					text: "El lunes, alguien@example.com escribió:\nSecreto citado",
					attachments: [],
					quotedHistory: "",
				},
			],
		});

		await expect(
			coordinator.start(captureRequest([alias("msg", 1)])),
		).resolves.toMatchObject({
			status: "complete",
			bodyChecks: {
				results: [
					{
						messageAlias: alias("msg", 1),
						text: "",
						characterCount: 0,
					},
				],
			},
		});
	});

	it.each([
		[
			"On-wrote header",
			"<div>On Monday, July 27, 2026, someone@example.com wrote:</div><div>HTML_ON_SECRET</div>",
			"HTML_ON_SECRET",
		],
		[
			"Original Message header",
			"<div>-----Original Message-----</div><p>HTML_ORIGINAL_SECRET</p>",
			"HTML_ORIGINAL_SECRET",
		],
		[
			"blockquote",
			"<div>Current text</div><blockquote><p>HTML_BLOCKQUOTE_SECRET</p></blockquote>",
			"HTML_BLOCKQUOTE_SECRET",
		],
		[
			"encoded quote prefix",
			"<div>Current text</div><div>&gt; HTML_ENTITY_SECRET</div>",
			"HTML_ENTITY_SECRET",
		],
		[
			"localized quote header",
			"<div>El lunes, alguien@example.com escribió:</div><p>HTML_LOCALIZED_SECRET</p>",
			"HTML_LOCALIZED_SECRET",
		],
		[
			"plain encoded quote prefix",
			"&gt; PLAIN_ENTITY_SECRET",
			"PLAIN_ENTITY_SECRET",
		],
		[
			"inline On-wrote header",
			"<span>On Monday, July 27, 2026, someone@example.com wrote:</span><span>INLINE_ON_SECRET</span>",
			"INLINE_ON_SECRET",
		],
		[
			"inline Original Message header",
			"<span>-----Original Message-----</span><span>INLINE_ORIGINAL_SECRET</span>",
			"INLINE_ORIGINAL_SECRET",
		],
		[
			"inline localized quote header",
			"<span>El lunes, alguien@example.com escribió:</span><span>INLINE_LOCALIZED_SECRET</span>",
			"INLINE_LOCALIZED_SECRET",
		],
		[
			"inline encoded quote prefix",
			"<span>&gt; INLINE_ENTITY_SECRET</span>",
			"INLINE_ENTITY_SECRET",
		],
		[
			"split inline On-wrote header",
			"<span>On Monday,</span><span>Alice wrote:</span><span>SPLIT_ON_SECRET</span>",
			"SPLIT_ON_SECRET",
		],
		[
			"split inline Original Message header",
			"<span>-----Original</span><span> Message-----</span><span>SPLIT_ORIGINAL_SECRET</span>",
			"SPLIT_ORIGINAL_SECRET",
		],
		[
			"split inline localized quote header",
			"<span>El lunes,</span><span>Alice escribió:</span><span>SPLIT_LOCALIZED_SECRET</span>",
			"SPLIT_LOCALIZED_SECRET",
		],
	] as const)(
		"removes a quoted-history %s or fails the body closed",
		async (_name, text, quotedSentinel) => {
			const { coordinator } = mailboxHarness({
				bodyResults: [
					{
						messageAlias: alias("msg", 1),
						text,
						attachments: [],
						quotedHistory: "",
					},
				],
			});

			const result = await coordinator.start(
				captureRequest([alias("msg", 1)]),
			);
			expect(["complete", "malformed_stream"]).toContain(result.status);
			expect(JSON.stringify(result)).not.toContain(quotedSentinel);
			if (result.status === "complete") {
				expect(result.bodyChecks?.results).toHaveLength(1);
			}
		},
	);

	it("rejects a huge body before expensive scrubbing within a coarse runtime budget", async () => {
		const { coordinator } = mailboxHarness({
			bodyResults: [
				{
					messageAlias: alias("msg", 1),
					text: "x".repeat(2_000_000),
					attachments: [],
					quotedHistory: "",
				},
			],
		});
		const startedAt = performance.now();

		await expect(
			coordinator.start(captureRequest([alias("msg", 1)])),
		).resolves.toMatchObject({
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		});
		expect(performance.now() - startedAt).toBeLessThan(5_000);
	});

	it("counts Unicode code points after removing attachments and quoted history", async () => {
		const safeText = "😀".repeat(
			MAILBOX_CAPTURE_LIMITS.bodyUnicodeCharacters,
		);
		const attachmentSentinel = "ATTACHMENT-PRIVATE-SENTINEL";
		const quotedSentinel = "QUOTED-PRIVATE-SENTINEL";
		const { coordinator } = mailboxHarness({
			bodyResults: [
				{
					messageAlias: alias("msg", 1),
					text: safeText,
					attachments: [{ filename: attachmentSentinel, text: "private" }],
					quotedHistory: quotedSentinel.repeat(500),
				},
			],
		});

		const result = await coordinator.start(
			captureRequest([alias("msg", 1)]),
		);
		expect(result).toMatchObject({
			status: "complete",
			bodyChecks: {
				results: [
					{
						messageAlias: alias("msg", 1),
						text: safeText,
						characterCount: 2_000,
					},
				],
			},
		});
		expect(JSON.stringify(result)).not.toContain(attachmentSentinel);
		expect(JSON.stringify(result)).not.toContain(quotedSentinel);
	});

	it("hard-rejects 2001 scrubbed Unicode characters", async () => {
		const { coordinator } = mailboxHarness({
			bodyResults: [
				{
					messageAlias: alias("msg", 1),
					text: "😀".repeat(
						MAILBOX_CAPTURE_LIMITS.bodyUnicodeCharacters + 1,
					),
					attachments: [],
					quotedHistory: "",
				},
			],
		});

		await expect(
			coordinator.start(captureRequest([alias("msg", 1)])),
		).resolves.toMatchObject({
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		});
	});
});

describe("scoped mailbox fingerprint", () => {
	it("is canonical over the provider, surface, account, referenced observations, and targets", async () => {
		const base = inventory();
		const input = {
			inventory: base,
			metadata: { tags: [], categories: [] },
			actions: [
				{ type: "archive" as const, messageAlias: alias("msg", 1) },
				{
					type: "apply_label" as const,
					messageAlias: alias("msg", 1),
					labelAlias: alias("lbl", 1),
				},
			],
			targets: {
				folderAliases: [alias("fld", 1)],
				labelAliases: [alias("lbl", 1)],
				filterAliases: [alias("flt", 1)],
			},
		};
		const first = await computeMailboxScopedFingerprint(input);
		const reordered = await computeMailboxScopedFingerprint({
			...input,
			inventory: {
				...base,
				messages: [...base.messages].reverse(),
				folders: [...base.folders].reverse(),
				labels: [...base.labels].reverse(),
				filters: [...base.filters].reverse(),
			},
			targets: {
				folderAliases: [...input.targets.folderAliases].reverse(),
				labelAliases: [...input.targets.labelAliases].reverse(),
				filterAliases: [...input.targets.filterAliases].reverse(),
			},
		});

		expect(first).toEqual(reordered);
		expect(first).toMatchObject({
			schemaVersion: 1,
			algorithm: "sha256",
			digest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("fingerprints fresh existing state without requiring desired create or replacement bindings in inventory", async () => {
		const base = inventory();
		const desiredFolder = alias("fld", 90);
		const replacementFolder = alias("fld", 91);
		const request = {
			inventory: base,
			metadata: { tags: [], categories: [] },
			actions: [
				{
					schemaVersion: 1 as const,
					actionAlias: alias("act", 90),
					type: "create_folder" as const,
					folderAlias: desiredFolder,
				},
				{
					schemaVersion: 1 as const,
					actionAlias: alias("act", 91),
					type: "rename_folder" as const,
					folderAlias: alias("fld", 1),
					replacementFolderAlias: replacementFolder,
				},
			],
			targets: {
				folderAliases: [
					alias("fld", 1),
					desiredFolder,
					replacementFolder,
				],
				labelAliases: [],
				filterAliases: [],
			},
		};
		const accepted = await computeMailboxScopedFingerprint(request);
		const freshReconstruction = await computeMailboxScopedFingerprint({
			...request,
			inventory: structuredClone(base),
		});
		const sourceDrift = await computeMailboxScopedFingerprint({
			...request,
			inventory: {
				...base,
				folders: base.folders.map((folder) =>
					folder.alias === alias("fld", 1)
						? { ...folder, messageCount: 999 }
						: folder,
				),
			},
		});

		expect(mailboxFingerprintsMatch(accepted, freshReconstruction)).toBe(true);
		expect(mailboxFingerprintsMatch(accepted, sourceDrift)).toBe(false);
	});

	it("invalidates referenced drift but ignores unrelated new mail and global counts", async () => {
		const base = inventory();
		const request = {
			inventory: base,
			metadata: { tags: [], categories: [] },
			actions: [{ type: "archive" as const, messageAlias: alias("msg", 1) }],
			targets: {
				folderAliases: [alias("fld", 1)],
				labelAliases: [],
				filterAliases: [],
			},
		};
		const expected = await computeMailboxScopedFingerprint(request);
		const unrelated = await computeMailboxScopedFingerprint({
			...request,
			inventory: {
				...base,
				messages: [...base.messages, message(99)],
				labels: [
					...base.labels,
					{ alias: alias("lbl", 99), messageCount: 999 },
				],
			},
		});
		const referencedItemDrift = await computeMailboxScopedFingerprint({
			...request,
			inventory: {
				...base,
				messages: base.messages.map((item) =>
					item.alias === alias("msg", 1)
						? { ...item, read: !item.read }
						: item,
				),
			},
		});
		const referencedTargetDrift = await computeMailboxScopedFingerprint({
			...request,
			inventory: {
				...base,
				folders: [{ ...base.folders[0]!, messageCount: 999 }],
			},
		});

		expect(mailboxFingerprintsMatch(expected, unrelated)).toBe(true);
		expect(mailboxFingerprintsMatch(expected, referencedItemDrift)).toBe(false);
		expect(mailboxFingerprintsMatch(expected, referencedTargetDrift)).toBe(false);
	});

	it("fingerprints planner-exposed tag and category targets while ignoring unrelated metadata", async () => {
		const tagAlias = alias("lbl", 101);
		const categoryAlias = alias("lbl", 102);
		const unrelatedAlias = alias("lbl", 103);
		const metadata = {
			tags: [{ alias: tagAlias, messageCount: 1 }],
			categories: [{ alias: categoryAlias, messageCount: 2 }],
		};
		const base = inventory();
		const plannerMetadata = createMailboxCleanupChoices(
			base,
			metadata,
		)[0]!.metadata;
		const request = {
			inventory: base,
			metadata,
			actions: [
				{
					type: "apply_label" as const,
					messageAlias: alias("msg", 1),
					labelAlias: plannerMetadata.tagAliases[0]!,
				},
				{
					type: "apply_label" as const,
					messageAlias: alias("msg", 1),
					labelAlias: plannerMetadata.categoryAliases[0]!,
				},
			],
			targets: {
				folderAliases: [],
				labelAliases: [
					...plannerMetadata.tagAliases,
					...plannerMetadata.categoryAliases,
				],
				filterAliases: [],
			},
		};
		const expected = await computeMailboxScopedFingerprint(request);
		const referencedTagDrift = await computeMailboxScopedFingerprint({
			...request,
			metadata: {
				...metadata,
				tags: [{ alias: tagAlias, messageCount: 2 }],
			},
		});
		const referencedCategoryDrift = await computeMailboxScopedFingerprint({
			...request,
			metadata: {
				...metadata,
				categories: [{ alias: categoryAlias, messageCount: 3 }],
			},
		});
		const unrelatedMetadata = await computeMailboxScopedFingerprint({
			...request,
			metadata: {
				...metadata,
				tags: [
					...metadata.tags,
					{ alias: unrelatedAlias, messageCount: 999 },
				],
			},
		});

		expect(plannerMetadata).toEqual({
			tagAliases: [tagAlias],
			categoryAliases: [categoryAlias],
		});
		expect(mailboxFingerprintsMatch(expected, referencedTagDrift)).toBe(false);
		expect(mailboxFingerprintsMatch(expected, referencedCategoryDrift)).toBe(false);
		expect(mailboxFingerprintsMatch(expected, unrelatedMetadata)).toBe(true);
	});

	it("fingerprints exact label, tag, and category limits with scoped drift semantics", async () => {
		const labels = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.labels },
			(_unused, index) => ({
				alias: alias("lbl", index + 1),
				messageCount: index,
			}),
		);
		const tags = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.tags },
			(_unused, index) => ({
				alias: alias("lbl", 10_001 + index),
				messageCount: index,
			}),
		);
		const categories = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.categories },
			(_unused, index) => ({
				alias: alias("lbl", 20_001 + index),
				messageCount: index,
			}),
		);
		const referencedAliases = [
			labels[0]!.alias,
			tags[0]!.alias,
			categories[0]!.alias,
		];
		const request = {
			inventory: inventory({
				messages: [],
				folders: [],
				labels,
				filters: [],
			}),
			metadata: { tags, categories },
			actions: [],
			targets: {
				folderAliases: [],
				labelAliases: referencedAliases,
				filterAliases: [],
			},
		};
		const expected = await computeMailboxScopedFingerprint(request);
		const fingerprintWith = async (
			collection: "labels" | "tags" | "categories",
			index: number,
		) => {
			const source =
				collection === "labels"
					? labels
					: collection === "tags"
						? tags
						: categories;
			const changed = source.map((item, itemIndex) =>
				itemIndex === index
					? { ...item, messageCount: item.messageCount + 1 }
					: item,
			);
			return await computeMailboxScopedFingerprint({
				...request,
				...(collection === "labels"
					? {
							inventory: {
								...request.inventory,
								labels: changed,
							},
						}
					: {
							metadata: {
								...request.metadata,
								[collection]: changed,
							},
						}),
			});
		};

		expect(expected.digest).toMatch(/^[a-f0-9]{64}$/);
		for (const collection of [
			"labels",
			"tags",
			"categories",
		] as const) {
			expect(
				mailboxFingerprintsMatch(
					expected,
					await fingerprintWith(collection, 0),
				),
			).toBe(false);
			expect(
				mailboxFingerprintsMatch(
					expected,
					await fingerprintWith(collection, 1),
				),
			).toBe(true);
		}
	});

	it.each([
		["labels", MAILBOX_CAPTURE_LIMITS.labels + 1, 1],
		["tags", MAILBOX_CAPTURE_LIMITS.tags + 1, 10_001],
		[
			"categories",
			MAILBOX_CAPTURE_LIMITS.categories + 1,
			20_001,
		],
	] as const)(
		"rejects a one-over %s collection before fingerprinting",
		async (collection, length, firstSeed) => {
			const items = Array.from({ length }, (_unused, index) => ({
				alias: alias("lbl", firstSeed + index),
				messageCount: index,
			}));
			const request = {
				...fingerprintInput(),
				...(collection === "labels"
					? {
							inventory: inventory({
								labels: items,
							}),
						}
					: {
							metadata: {
								tags: collection === "tags" ? items : [],
								categories:
									collection === "categories" ? items : [],
							},
						}),
			};

			await expect(
				computeMailboxScopedFingerprint(request),
			).rejects.toThrow(
				collection === "labels"
					? "Mailbox fingerprint rejected inventory"
					: "Mailbox fingerprint rejected metadata",
			);
		},
	);

	it("keeps a 5000-message scoped fingerprint bounded, responsive, and cancelable", async () => {
		const messages = Array.from(
			{ length: MAILBOX_CAPTURE_LIMITS.messages },
			(_unused, index) => message(index + 1),
		);
		const request = {
			inventory: inventory({
				messages,
				folders: [],
				labels: [],
				filters: [],
			}),
			metadata: { tags: [], categories: [] },
			actions: [
				{ type: "archive" as const, messageAlias: alias("msg", 1) },
			],
			targets: {
				folderAliases: [],
				labelAliases: [],
				filterAliases: [],
			},
		};
		const abort = new AbortController();
		let cancellationFired = false;
		const canceling = computeMailboxScopedFingerprint(
			request,
			abort.signal,
		);
		setTimeout(() => {
			cancellationFired = true;
			abort.abort();
		}, 0);

		await expect(
			settlesWithin(canceling, 2_000),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(cancellationFired).toBe(true);
		const startedAt = performance.now();

		const fingerprint = await computeMailboxScopedFingerprint(request);

		expect(fingerprint.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(performance.now() - startedAt).toBeLessThan(5_000);
	});

	it("fingerprints the call-time observation when a late referenced item mutates during an abortable scan", async () => {
		const mutableLateMessage = {
			...message(MAILBOX_CAPTURE_LIMITS.messages),
		};
		const messages = [
			...Array.from(
				{ length: MAILBOX_CAPTURE_LIMITS.messages - 1 },
				(_unused, index) => message(index + 1),
			),
			mutableLateMessage,
		];
		const request = {
			inventory: inventory({
				messages,
				folders: [],
				labels: [],
				filters: [],
			}),
			metadata: { tags: [], categories: [] },
			actions: [
				{
					type: "archive" as const,
					messageAlias: mutableLateMessage.alias,
				},
			],
			targets: {
				folderAliases: [],
				labelAliases: [],
				filterAliases: [],
			},
		};
		const expected = await computeMailboxScopedFingerprint(request);
		const signal = new AbortController().signal;
		const startedAt = performance.now();

		const fingerprinting = computeMailboxScopedFingerprint(
			request,
			signal,
		);
		mutableLateMessage.read = true;

		await expect(
			settlesWithin(fingerprinting, 5_000),
		).resolves.toEqual(expected);
		expect(performance.now() - startedAt).toBeLessThan(5_000);
	});

	it.each([
		["provider", { providerId: "other-mail" }],
		["surface", { surface: "archive" }],
		["account", { accountAlias: OTHER_ACCOUNT_ALIAS }],
	] as const)("invalidates a changed scoped %s", async (_name, change) => {
		const base = inventory();
		const request = {
			inventory: base,
			metadata: { tags: [], categories: [] },
			actions: [{ type: "archive" as const, messageAlias: alias("msg", 1) }],
			targets: {
				folderAliases: [],
				labelAliases: [],
				filterAliases: [],
			},
		};
		const expected = await computeMailboxScopedFingerprint(request);
		const changed = await computeMailboxScopedFingerprint({
			...request,
			inventory: { ...base, ...change },
		});

		expect(mailboxFingerprintsMatch(expected, changed)).toBe(false);
	});

	it("rejects accessor-backed input, collections, targets, and inventory items without executing getters", async () => {
		const cases = [
			() => {
				const base = fingerprintInput();
				let getterCalls = 0;
				const unsafeInventory = { ...base.inventory };
				Object.defineProperty(unsafeInventory, "messages", {
					enumerable: true,
					get() {
						getterCalls += 1;
						return base.inventory.messages;
					},
				});
				return {
					input: { ...base, inventory: unsafeInventory as never },
					getterCalls: () => getterCalls,
				};
			},
			() => {
				const base = fingerprintInput();
				let getterCalls = 0;
				const unsafeActions = [...base.actions];
				Object.defineProperty(unsafeActions, "0", {
					enumerable: true,
					get() {
						getterCalls += 1;
						return base.actions[0];
					},
				});
				return {
					input: { ...base, actions: unsafeActions as never },
					getterCalls: () => getterCalls,
				};
			},
			() => {
				const base = fingerprintInput();
				let getterCalls = 0;
				const unsafeTargets = { ...base.targets };
				Object.defineProperty(unsafeTargets, "folderAliases", {
					enumerable: true,
					get() {
						getterCalls += 1;
						return [];
					},
				});
				return {
					input: { ...base, targets: unsafeTargets as never },
					getterCalls: () => getterCalls,
				};
			},
			() => {
				const base = fingerprintInput();
				let getterCalls = 0;
				const unsafeMessage = { ...base.inventory.messages[0]! };
				Object.defineProperty(unsafeMessage, "alias", {
					enumerable: true,
					get() {
						getterCalls += 1;
						return alias("msg", 1);
					},
				});
				return {
					input: {
						...base,
						inventory: {
							...base.inventory,
							messages: [unsafeMessage as never],
						},
					},
					getterCalls: () => getterCalls,
				};
			},
		];

		for (const buildCase of cases) {
			const unsafe = buildCase();
			await expect(
				computeMailboxScopedFingerprint(unsafe.input),
			).rejects.toThrow();
			expect(unsafe.getterCalls()).toBe(0);
		}
	});

	it("rejects oversized inventory, action, and target arrays within a coarse runtime budget", async () => {
		const baseAction = {
			type: "archive" as const,
			messageAlias: alias("msg", 1),
		};
		const cases = [
			{
				name: "inventory messages",
				input: {
					...fingerprintInput(),
					inventory: inventory({
						messages: Array.from(
							{ length: MAILBOX_CAPTURE_LIMITS.messages + 1 },
							(_unused, index) => message(index + 1),
						),
					}),
				},
			},
			{
				name: "actions",
				input: {
					...fingerprintInput(),
					actions: Array.from(
						{
							length:
								MAILBOX_CAPTURE_LIMITS.assembledInventoryItems +
								1,
						},
						() => baseAction,
					),
				},
			},
			{
				name: "target folders",
				input: {
					...fingerprintInput(),
					targets: {
						folderAliases: Array.from(
							{ length: MAILBOX_CAPTURE_LIMITS.folders + 1 },
							(_unused, index) => alias("fld", index + 1),
						),
						labelAliases: [],
						filterAliases: [],
					},
				},
			},
		];

		for (const current of cases) {
			const startedAt = performance.now();
			await expect(
				computeMailboxScopedFingerprint(current.input),
			).rejects.toThrow();
			expect(performance.now() - startedAt).toBeLessThan(2_000);
		}
	});
});

describe("deterministic mailbox cleanup choices", () => {
	it("always returns deterministic Conservative, Balanced, and Inbox Zero choices", () => {
		const current = inventory();
		const first = createMailboxCleanupChoices(current);
		const second = createMailboxCleanupChoices({
			...current,
			messages: [...current.messages],
		});

		expect(first).toEqual(second);
		expect(first.map((choice) => choice.id)).toEqual([
			"conservative",
			"balanced",
			"inbox_zero",
		]);
		expect(first.map((choice) => choice.sliderPosition)).toEqual([0, 50, 100]);
		expect(first.every((choice) => choice.actions.every(
			(action) => !JSON.stringify(action).match(/delete|trash/i),
		))).toBe(true);
	});

	it("covers every captured message in Inbox Zero without promising it for a partial capture", () => {
		const complete = createMailboxCleanupChoices(inventory());
		const partial = createMailboxCleanupChoices(
			inventory({ partial: true }),
		);
		const completeInboxZero = complete.find(
			(choice) => choice.id === "inbox_zero",
		);
		const partialInboxZero = partial.find(
			(choice) => choice.id === "inbox_zero",
		);

		expect(completeInboxZero).toMatchObject({
			promisesInboxZero: true,
		});
		expect(
			new Set([
				...(completeInboxZero?.actions.flatMap((action) =>
					"messageAlias" in action ? [action.messageAlias] : []
				) ?? []),
				...(completeInboxZero?.reviewMessageAliases ?? []),
			]),
		).toEqual(new Set(inventory().messages.map((item) => item.alias)));
		expect(partialInboxZero).toMatchObject({
			promisesInboxZero: false,
			partial: true,
			reviewMessageAliases: expect.arrayContaining(
				inventory().messages.map((item) => item.alias),
			),
		});
	});
});
