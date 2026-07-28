import { describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { validateCanonicalMailboxAction } from "@dg/common";
import { createMailboxCleanupBackgroundComposition } from "@/lib/background/mailbox-cleanup-composition";
import { createMailboxExecutionIndexedDbStorage } from "@/lib/background/mailbox-cleanup-storage";
import { computeMailboxCaptureChunkDigest } from "@/lib/features/mailbox-cleanup/coordinator";
import { validateCanonicalMailboxExecutionRevision } from "@/lib/features/mailbox-cleanup/execution";
import { createMailboxLifecycle } from "@/lib/features/mailbox-cleanup/lifecycle";
import {
	consumeMailboxPlanBootstrap,
	createMailboxPlanWorkspace,
	initializeMailboxPlanPage,
} from "@/lib/features/mailbox-cleanup/plan-page";
import { computeMailboxScopedFingerprint } from "@/lib/features/mailbox-cleanup/planning";
import {
	createMailboxPlanStore,
	createRawBindingStore,
} from "@/lib/features/mailbox-cleanup/storage";
import {
	assertMailboxProviderPageReady,
	createGuardedMailboxExecutionProvider,
	runMailboxProviderConformance,
	type MailboxProviderConformanceSeams,
} from "../lib/features/mailbox-cleanup/providers";
import { createFakeMailboxProviderHarness } from "../lib/features/mailbox-cleanup/providers/fake";
import {
	alias,
	NEXT_REVISION_ALIAS,
	NOW_MS,
	RUN_ALIAS as CORE_RUN_ALIAS,
} from "./mailbox-plan-page-fixtures";
import {
	approveMailboxCoreCli,
	createMailboxCoreConformanceBrowserHarness,
	mailboxCoreCliConnection,
	waitForMailboxCore,
} from "./mailbox-core-conformance-harness";

const NOW = "2026-07-28T12:00:00.000Z";
const ACCOUNT_ALIAS = "acct_00112233445566778899aabbccddeeff";
const RUN_ALIAS = "run_102132435465768798a9bacbdcedfe0f";
const REVISION_ALIAS = "rev_fedcba98765432100123456789abcdef";
const MESSAGE_ALIAS = "msg_89abcdef01234567fedcba9876543210";
const ACTION_ALIAS = "act_79abcdef01234567fedcba9876543210";
const RAW_MESSAGE = "provider-message-1";
const TAG_ALIAS = alias("lbl", 101);
const CATEGORY_ALIAS = alias("lbl", 102);
const RAW_TAG = "provider-tag-1";
const RAW_CATEGORY = "provider-category-1";
const CORE_MESSAGE_ALIAS = alias("msg", 1);

async function fullLifecycleProvider() {
	const payload = {
		kind: "messages",
		items: [{
			alias: CORE_MESSAGE_ALIAS,
			read: false,
			hasAttachments: false,
			receivedAt: "2026-07-20T12:00:00.000Z",
			category: "newsletter",
		}],
	};
	const envelope = {
		schemaVersion: 1 as const,
		runAlias: CORE_RUN_ALIAS,
		sequence: 0,
		declaredTotal: 3,
		itemCount: 1,
		payload,
	};
	const labelPayload = {
		kind: "tags",
		items: [{ alias: TAG_ALIAS, messageCount: 1 }],
	};
	const labelEnvelope = {
		...envelope,
		sequence: 1,
		itemCount: 1,
		payload: labelPayload,
	};
	const categoryPayload = {
		kind: "categories",
		items: [{ alias: CATEGORY_ALIAS, messageCount: 1 }],
	};
	const categoryEnvelope = {
		...envelope,
		sequence: 2,
		itemCount: 1,
		payload: categoryPayload,
	};
	return createFakeMailboxProviderHarness({
		now: () => NOW,
		rawInventory: {
			messages: [{
				id: RAW_MESSAGE,
				read: false,
				archived: false,
				receivedAt: "2026-07-20T12:00:00.000Z",
			}],
			labels: [
				{ id: RAW_TAG, messageCount: 1, kind: "tag" },
				{
					id: RAW_CATEGORY,
					messageCount: 1,
					kind: "category",
				},
			],
		},
		chunks: [
			{
				...envelope,
				digest: await computeMailboxCaptureChunkDigest(envelope),
			},
			{
				...labelEnvelope,
				digest:
					await computeMailboxCaptureChunkDigest(labelEnvelope),
			},
			{
				...categoryEnvelope,
				digest:
					await computeMailboxCaptureChunkDigest(
						categoryEnvelope,
					),
			},
		],
		bindings: {
			[CORE_MESSAGE_ALIAS]: RAW_MESSAGE,
			[TAG_ALIAS]: RAW_TAG,
			[CATEGORY_ALIAS]: RAW_CATEGORY,
		},
	});
}

function subject(
	failures: NonNullable<
		Parameters<typeof createFakeMailboxProviderHarness>[0]
	>["failures"] = {},
) {
	const fake = createFakeMailboxProviderHarness({
		now: () => NOW,
		accountAlias: ACCOUNT_ALIAS,
		rawInventory: {
			messages: [{
				id: RAW_MESSAGE,
				read: false,
				archived: false,
			}],
		},
		bindings: { [MESSAGE_ALIAS]: RAW_MESSAGE },
		failures,
	});
	return {
		fake,
		subject: {
			provider: fake.provider,
			captureRequest: {
				providerId: fake.provider.id,
				surface: "inbox",
				accountAlias: ACCOUNT_ALIAS,
				runAlias: RUN_ALIAS,
				revisionAlias: REVISION_ALIAS,
			},
			action: {
				schemaVersion: 1 as const,
				actionAlias: ACTION_ALIAS,
				type: "mark_read" as const,
				messageAlias: MESSAGE_ALIAS,
			},
			rawTargets: { [MESSAGE_ALIAS]: RAW_MESSAGE },
		},
	};
}

function seams() {
	const stored = new Map<string, unknown>();
	const restarts: string[] = [];
	const downloads: Array<Readonly<{ name: string; content: string }>> = [];
	const value: MailboxProviderConformanceSeams = {
		now: () => NOW,
		storage: {
			async read(key) {
				return stored.get(key);
			},
			async write(key, item) {
				stored.set(key, item);
			},
		},
		restart: {
			async restart() {
				restarts.push(NOW);
			},
		},
		downloads: {
			async save(name, content) {
				downloads.push({ name, content });
				return { downloadId: "download-1" };
			},
		},
	};
	return { downloads, restarts, seams: value, stored };
}

describe("mailbox-provider-v1 core conformance", () => {
	it("drives the fake provider through production capture, plan, immutable acceptance, execution, and durable debrief", async () => {
		const harness = createMailboxCoreConformanceBrowserHarness();
		const indexedDB = new IDBFactory();
		const fake = await fullLifecycleProvider();
		let nowMs = NOW_MS;
		const composition = createMailboxCleanupBackgroundComposition({
			browser: harness.browser,
			indexedDB,
			providers: [fake.provider],
			now: () => nowMs,
			async fetch() {
				return new Response(null, { status: 204 });
			},
		});
		composition.register();
		const plans = createMailboxPlanStore({
			indexedDB,
			now: () => nowMs,
		});
		const bindings = createRawBindingStore({
			session: harness.sessionSeam,
			now: () => nowMs,
		});
		try {
			const connection = mailboxCoreCliConnection(77);
			const approved = await approveMailboxCoreCli(
				harness,
				connection,
				77,
			);
			void approved.connectionResult.catch(() => undefined);
			await waitForMailboxCore(
				async () => harness.tabs.length,
				(count) => count >= 2,
			);
			const input = await consumeMailboxPlanBootstrap({
				session: harness.sessionSeam,
				computeFingerprint: computeMailboxScopedFingerprint,
			});
			expect(input).toBeDefined();
			expect(
				input!.capture.choices.map(
					({ id, sliderPosition }) => ({
						id,
						sliderPosition,
					}),
				),
			).toEqual([
				{ id: "conservative", sliderPosition: 0 },
				{ id: "balanced", sliderPosition: 50 },
				{ id: "inbox_zero", sliderPosition: 100 },
			]);
			const lifecycle = createMailboxLifecycle({
				store: plans,
				now: () => nowMs,
				execution: {
					has: async (planAlias, revisionAlias) =>
						(await bindings.get({
							...input!.bindingScope,
							planAlias,
							revisionAlias,
						})) !== undefined,
					invalidate: (planAlias, revisionAlias, reason) =>
						bindings.invalidateRevision(
							planAlias,
							revisionAlias,
							reason,
						),
				},
			});
			let executionResult: unknown;
			let nextActionAlias = 100;
			const initialized = await initializeMailboxPlanPage(input!, {
				lifecycle,
				registerRevision: async (planAlias, revisionAlias) => {
					await harness.browser.runtime.sendMessage({
						type: "dg-mailbox-plans:register",
						command: { planAlias, revisionAlias },
					});
				},
				createWorkspace: (workspaceInput) =>
					createMailboxPlanWorkspace(workspaceInput, {
						lifecycle,
						rawBindings: bindings,
						computeFingerprint:
							computeMailboxScopedFingerprint,
							createRevisionAlias: () => NEXT_REVISION_ALIAS,
							createActionAlias: () =>
								`act_89abcdef01234567fedcba98${(nextActionAlias++)
									.toString(16)
									.padStart(8, "0")}`,
						now: () => nowMs,
						bridge: {
							isOpen: () => true,
							async submit() {
								return { status: "canceled" as const };
							},
							async cancel() {},
							async reconnect() {},
						},
						async startExecution(command) {
							executionResult =
								await harness.browser.runtime.sendMessage({
									type: "dg-mailbox-cleanup:execution-start",
									command,
								});
							return executionResult;
						},
						registerRevision: async (
							planAlias,
							revisionAlias,
						) => {
							await harness.browser.runtime.sendMessage({
								type: "dg-mailbox-plans:register",
								command: { planAlias, revisionAlias },
							});
						},
					}),
				mount: () => () => undefined,
			});
			const before = structuredClone(input!.baseRevision);
			const accepted = await initialized.workspace.acceptRevision();

			expect(input!.baseRevision).toEqual(before);
			expect(accepted.state).toBe("approved");
			expect(executionResult).toMatchObject({
				status: "completed",
				debriefAvailable: true,
			});
			expect(fake.calls.capture.length).toBeGreaterThanOrEqual(1);
			expect(fake.calls.dispatch.length).toBeGreaterThan(0);
			expect(fake.calls.verifyFresh).toHaveLength(
				fake.calls.dispatch.length,
			);
			expect(harness.downloads).toHaveLength(1);

			const stalePlanAlias =
				"plan_89abcdef01234567fedcba9800000770";
			const staleRevisionAlias =
				"rev_89abcdef01234567fedcba9800000770";
			const stale = validateCanonicalMailboxExecutionRevision({
				...accepted,
				planAlias: stalePlanAlias,
				revisionAlias: staleRevisionAlias,
				revisionNumber: 1,
				state: "approved",
			});
			const staleScope = {
				...input!.bindingScope,
				planAlias: stalePlanAlias,
				revisionAlias: staleRevisionAlias,
			};
			const oldBindings = {
				[CORE_MESSAGE_ALIAS]: RAW_MESSAGE,
				[TAG_ALIAS]: RAW_TAG,
				[CATEGORY_ALIAS]: RAW_CATEGORY,
			};
			await plans.putRevision(stale, {
				expiresAt: nowMs + 7 * 24 * 60 * 60 * 1_000,
			});
			await bindings.put(staleScope, oldBindings);
			await harness.browser.runtime.sendMessage({
				type: "dg-mailbox-plans:register",
				command: {
					planAlias: stalePlanAlias,
					revisionAlias: staleRevisionAlias,
				},
			});
			nowMs += 60 * 60 * 1_000;
			await expect(bindings.status(staleScope)).resolves.toEqual({
				available: false,
				reason: "expired",
			});
			const dispatchesBeforeRestart = fake.calls.dispatch.length;
			const restart = await composition.planList.perform({
				schemaVersion: 1,
				type: "restart",
				planAlias: stalePlanAlias,
				revisionAlias: staleRevisionAlias,
				requestAlias:
					"req_89abcdef01234567fedcba9800000770",
			});
			expect(restart).toMatchObject({
				status: "completed",
				action: "restart",
				planAlias: stalePlanAlias,
			});
			if (restart.status !== "completed") {
				throw new Error("Conformance restart did not complete");
			}
			expect(restart.revisionAlias).not.toBe(staleRevisionAlias);
			const registry = await createMailboxExecutionIndexedDbStorage(
				indexedDB,
				"dg-mailbox-plan-list-v1",
			).read("dg:mailbox-plan-list:v1");
			const context = (
				registry?.value as {
					contexts?: readonly Readonly<{
						planAlias: string;
						revisionAlias: string;
						providerId: string;
						surface: string;
						accountAlias: string;
						runAlias: string;
					}>[];
				} | undefined
			)?.contexts?.find(
				(item) =>
					item.planAlias === stalePlanAlias &&
					item.revisionAlias === restart.revisionAlias,
			);
			expect(context).toBeDefined();
			const freshBindings = await bindings.get({
				planAlias: context!.planAlias,
				revisionAlias: context!.revisionAlias,
				providerId: context!.providerId,
				surface: context!.surface,
				accountAlias: context!.accountAlias,
				runAlias: context!.runAlias,
			});
			expect(freshBindings).toBeDefined();
			expect(
				Object.keys(freshBindings!).some((alias) =>
					Object.hasOwn(oldBindings, alias),
				),
			).toBe(false);
			expect(fake.calls.dispatch).toHaveLength(
				dispatchesBeforeRestart,
			);
			expect(harness.downloads).toHaveLength(1);
			const durableDebrief = [...harness.local.values()].find(
				(value) =>
					value !== null &&
					typeof value === "object" &&
					(value as { filename?: unknown }).filename ===
						`mailbox-cleanup-debrief-v1-${accepted.planAlias}-${accepted.revisionAlias}.txt`,
			);
			expect(durableDebrief).toMatchObject({
				schemaVersion: 1,
				delivery: { status: "available" },
			});
			const sanitizedPersistence = JSON.stringify({
				downloads: harness.downloads,
				local: [...harness.local.entries()],
				registry: registry?.value,
			});
			for (const raw of [RAW_MESSAGE, RAW_TAG, RAW_CATEGORY]) {
				expect(sanitizedPersistence).not.toContain(raw);
			}
		} finally {
			await plans.close();
			await composition.dispose();
		}
	}, 30_000);

	it("runs the fake provider through the unchanged provider-neutral journey", async () => {
		const fixture = subject();
		const platform = seams();

		await expect(
			runMailboxProviderConformance(
				fixture.subject,
				platform.seams,
			),
		).resolves.toEqual({
			providerId: "fake-mail",
			locale: "en-US",
			observedAt: NOW,
			verifiedAt: NOW,
			inboxCount: 1,
			downloadId: "download-1",
		});
		expect(platform.restarts).toEqual([NOW]);
		expect(platform.stored.has("mailbox-provider-v1:capture")).toBe(true);
		expect(platform.stored.has("mailbox-provider-v1:accepted")).toBe(true);
		expect(platform.stored.has("mailbox-provider-v1:debrief")).toBe(true);
		expect(platform.downloads).toHaveLength(1);
		expect(fixture.fake.calls.dispatch).toHaveLength(1);
		expect(fixture.fake.calls.verifyFresh).toHaveLength(1);
		expect(JSON.stringify([...platform.stored.entries()])).not.toContain(
			RAW_MESSAGE,
		);
		expect(JSON.stringify(platform.downloads)).not.toContain(RAW_MESSAGE);
	});

	it("fails closed for unsupported locale and layout drift", async () => {
		await expect(
			assertMailboxProviderPageReady(
				subject({ locale: "unsupported_locale" }).subject.provider,
				"inbox",
			),
		).rejects.toMatchObject({ code: "provider_failure" });
		await expect(
			assertMailboxProviderPageReady(
				subject({ layout: "layout_mismatch" }).subject.provider,
				"inbox",
			),
		).rejects.toMatchObject({ code: "layout_signature" });
	});

	it("rejects forbidden actions and missing raw session bindings", async () => {
		expect(() =>
			validateCanonicalMailboxAction({
				schemaVersion: 1,
				actionAlias: ACTION_ALIAS,
				type: "trash",
				messageAlias: MESSAGE_ALIAS,
			}),
		).toThrow();
		const fixture = subject();
		const provider = createGuardedMailboxExecutionProvider(
			fixture.subject.provider,
		);
		await expect(
			provider.preflight({
				...fixture.subject.captureRequest,
				actions: [fixture.subject.action],
				rawTargets: {},
			}),
		).rejects.toMatchObject({ code: "provider_shape" });
	});

	it("rejects non-canonical action fields before capture or persistence", async () => {
		const fixture = subject();
		const platform = seams();
		const invalidSubject = {
			...fixture.subject,
			action: {
				...fixture.subject.action,
				rawTarget: RAW_MESSAGE,
			} as unknown as typeof fixture.subject.action,
		};

		await expect(
			runMailboxProviderConformance(invalidSubject, platform.seams),
		).rejects.toThrow();
		expect(platform.stored.size).toBe(0);
		expect(platform.downloads).toEqual([]);
		expect(platform.restarts).toEqual([]);
		expect(fixture.fake.calls.capture).toEqual([]);
		expect(fixture.fake.calls.dispatch).toEqual([]);
	});

	it("reports a verification mismatch without claiming success", async () => {
		const fixture = subject({ verifyFresh: "verification_mismatch" });
		const provider = createGuardedMailboxExecutionProvider(
			fixture.subject.provider,
		);
		await expect(
			provider.verifyFresh({
				...fixture.subject.captureRequest,
				action: fixture.subject.action,
				rawTargets: fixture.subject.rawTargets,
			}),
		).resolves.toMatchObject({
			status: "ambiguous",
			reasonCode: "verification_mismatch",
		});
	});
});
