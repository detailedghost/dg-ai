import { describe, expect, it, mock } from "bun:test";
import type {
	MailboxProviderDispatchRequest,
	MailboxProvider,
	MailboxProviderMutationRequest,
	MailboxProviderVerificationRequest,
} from "../index";
import {
	assertMailboxProviderPageReady,
	createGuardedMailboxExecutionProvider,
	defineMailboxProvider,
	discoverMailboxProviders,
	guardedProviderApply,
	guardedProviderCapture,
	guardedProviderDispatch,
	guardedProviderObserve,
	guardedProviderObserveInbox,
	guardedProviderPreflight,
	guardedProviderVerify,
	guardedProviderVerifyFresh,
} from "../index";

const ACCOUNT_ALIAS = "acct_00112233445566778899aabbccddeeff";
const RUN_ALIAS = "run_102132435465768798a9bacbdcedfe0f";
const REVISION_ALIAS = "rev_fedcba98765432100123456789abcdef";
const MESSAGE_ALIAS = "msg_89abcdef01234567fedcba9876543210";
const ACTION_ALIAS = "act_79abcdef01234567fedcba9876543210";

function provider(
	id: string,
	overrides: Partial<MailboxProvider> = {},
): MailboxProvider {
	return {
		id,
		surfaces: ["inbox"],
		coordinator: {
			async probe(request) {
				return {
					status: "ready",
					accountAlias: request.accountAlias,
					surface: request.surface,
				};
			},
			async *capture() {},
			async readBodies() {
				return [];
			},
			async captureResult() {
				return { status: "complete" };
			},
			async bindings() {
				return {};
			},
		},
		readLocale: mock(() => "en_us"),
		hasPositiveLayoutSignature: mock(() => true),
		capture: mock(() => ({ messages: [] })),
		apply: mock(() => ({
				schemaVersion: 1 as const,
				code: "changed" as const,
				aliases: [MESSAGE_ALIAS],
			count: 1,
			observedAt: "2026-07-27T12:00:00.000Z",
		})),
		verify: mock((request: MailboxProviderVerificationRequest) => ({
			schemaVersion: 1 as const,
			action: request.action,
			status: "completed" as const,
			affectedCount: 1,
			observations: [],
		})),
		preflight: mock((preflight) => ({
			status: "ready" as const,
			providerId: id,
			surface: preflight.surface,
			accountAlias: preflight.accountAlias,
			locale: "en-US",
			layout: "supported" as const,
			capabilities: ["archive"] as const,
			targets: "available" as const,
		})),
		dispatch: mock(() => ({ status: "dispatched" as const })),
		observe: mock(() => ({
			status: "observed" as const,
			observedAt: "2026-07-27T12:00:01.000Z",
		})),
		verifyFresh: mock(() => ({
			status: "verified" as const,
			verifiedAt: "2026-07-27T12:00:02.000Z",
			delta: {
				schemaVersion: 1 as const,
				scope: "entire_fingerprint" as const,
				actionAlias: ACTION_ALIAS,
				changedAliases: [MESSAGE_ALIAS],
			},
		})),
		observeInbox: mock(() => ({
			status: "observed" as const,
			count: 0,
			observedAt: "2026-07-27T12:00:03.000Z",
		})),
		...overrides,
	};
}

function dispatchRequest(): MailboxProviderDispatchRequest {
	return {
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		runAlias: RUN_ALIAS,
		revisionAlias: REVISION_ALIAS,
		action: {
			schemaVersion: 1,
			actionAlias: ACTION_ALIAS,
			type: "archive",
			messageAlias: MESSAGE_ALIAS,
		},
		rawTargets: {
			[MESSAGE_ALIAS]: "provider-message-42",
		},
	};
}

function request(): MailboxProviderMutationRequest {
	return {
			providerId: "fake-mail",
			surface: "inbox",
			accountAlias: ACCOUNT_ALIAS,
			runAlias: RUN_ALIAS,
			revisionAlias: REVISION_ALIAS,
			action: { type: "archive", messageAlias: MESSAGE_ALIAS },
		rawTarget: "provider-message-42",
	};
}

describe("discoverMailboxProviders", () => {
	it("orders bundled providers by immutable ID and rejects duplicate IDs", () => {
		const alpha = provider("alpha-mail");
		const zeta = provider("zeta-mail");

		expect(
			discoverMailboxProviders({
				"./adapters/zeta/index.ts": { default: zeta },
				"./adapters/alpha/index.ts": { default: alpha },
			}).map((item) => item.id),
		).toEqual(["alpha-mail", "zeta-mail"]);
		expect(() =>
			discoverMailboxProviders({
				"./adapters/one/index.ts": { default: alpha },
				"./adapters/two/index.ts": { default: provider("alpha-mail") },
			}),
		).toThrow(/provider_id/i);
	});

	it("rejects runtime URLs and provider network escape hatches", () => {
		expect(() =>
			discoverMailboxProviders({
				"https://example.test/provider.ts": { default: provider("remote") },
			}),
		).toThrow(/provider_shape/i);
		expect(() =>
			defineMailboxProvider({
				...provider("unsafe-mail"),
				endpoint: "https://example.test/mail",
			} as MailboxProvider),
		).toThrow(/provider_shape/i);
	});

	it("accepts a real module namespace shape and rejects unsafe exports", () => {
		const namespace = Object.create(null);
		Object.defineProperties(namespace, {
			default: {
				enumerable: true,
				value: provider("namespace-mail"),
			},
			[Symbol.toStringTag]: {
				value: "Module",
			},
		});
		Object.freeze(namespace);

		expect(
			discoverMailboxProviders({
				"./adapters/namespace.ts": namespace,
			}).map((item) => item.id),
		).toEqual(["namespace-mail"]);
		expect(() =>
			discoverMailboxProviders({
				"./adapters/unsafe.ts": {
					default: provider("unsafe-mail"),
					debug: true,
				} as never,
			}),
		).toThrow(/provider_shape/i);

		let accessorRead = false;
		const accessorModule = Object.defineProperty({}, "default", {
			enumerable: true,
			get() {
				accessorRead = true;
				return provider("accessor-mail");
			},
		});
		expect(() =>
			discoverMailboxProviders({
				"./adapters/accessor.ts": accessorModule,
			}),
		).toThrow(/provider_shape/i);
		expect(accessorRead).toBe(false);
	});

	it("keeps production discovery as an unconditional literal Vite macro", async () => {
		const source = await Bun.file(
			new URL("../bundled.ts", import.meta.url),
		).text();

		expect(source).toContain(
			'import.meta.glob<\n\tReadonly<{ default?: unknown; provider?: unknown }>\n>("./adapters/*.ts", { eager: true })',
		);
		expect(source).not.toContain("typeof import.meta.glob");
	});
});

describe("guarded mailbox providers", () => {
	it("normalizes English locale and requires a positive layout signature", async () => {
		expect(await assertMailboxProviderPageReady(provider("fake-mail"), "inbox")).toBe(
			"en-US",
		);
		await expect(
			assertMailboxProviderPageReady(
				provider("fake-mail", { readLocale: () => "fr-FR" }),
				"inbox",
			),
		).rejects.toThrow(/provider_locale/i);
		await expect(
			assertMailboxProviderPageReady(
				provider("fake-mail", {
					hasPositiveLayoutSignature: () => false,
				}),
				"inbox",
			),
		).rejects.toThrow(/layout_signature/i);
	});

	it("checks readiness before capture, apply, and verify", async () => {
		const calls: string[] = [];
		const guarded = provider("fake-mail", {
			readLocale: () => {
				calls.push("locale");
				return "en";
			},
			hasPositiveLayoutSignature: () => {
				calls.push("layout");
				return true;
			},
			capture: () => {
				calls.push("capture");
				return {};
			},
			apply: () => {
				calls.push("apply");
				return {
					schemaVersion: 1,
					code: "changed",
					aliases: [MESSAGE_ALIAS],
					count: 1,
					observedAt: "2026-07-27T12:00:00.000Z",
				};
			},
			verify: (verification: MailboxProviderVerificationRequest) => {
				calls.push("verify");
				return {
					schemaVersion: 1,
					action: verification.action,
					status: "completed",
					affectedCount: 1,
					observations: [],
				};
			},
			});
			const mutation = request();
			const {
				action: _action,
				rawTarget: _rawTarget,
				...capture
			} = mutation;

			await guardedProviderCapture(guarded, capture);
		await guardedProviderApply(guarded, mutation);
		await guardedProviderVerify(
			guarded,
			mutation as MailboxProviderVerificationRequest,
		);

			expect(calls).toEqual([
			"locale",
			"layout",
			"capture",
			"locale",
			"layout",
			"apply",
			"locale",
			"layout",
			"verify",
			]);
		});

		it("rejects unknown request keys before they reach a provider", async () => {
			const apply = mock(() => ({
				schemaVersion: 1 as const,
				code: "changed" as const,
				aliases: [MESSAGE_ALIAS],
				count: 1,
				observedAt: "2026-07-27T12:00:00.000Z",
			}));

			await expect(
				guardedProviderApply(
					provider("fake-mail", { apply }),
					{ ...request(), selector: "#raw-message" } as never,
				),
			).rejects.toThrow(/provider_shape/i);
			expect(apply).not.toHaveBeenCalled();
		});

		it("rejects forged low-entropy scope aliases before provider dispatch", async () => {
			const capture = mock(() => ({}));
			const {
				action: _action,
				rawTarget: _rawTarget,
				...captureRequest
			} = request();

			await expect(
				guardedProviderCapture(
					provider("fake-mail", { capture }),
					{
						...captureRequest,
						revisionAlias: `rev_${"1".repeat(32)}`,
					},
				),
			).rejects.toThrow(/provider_shape/i);
			expect(capture).not.toHaveBeenCalled();
		});

		it("dispatches through the provider snapshot validated before readiness", async () => {
			const originalApply = mock(() => ({
				schemaVersion: 1 as const,
				code: "changed" as const,
				aliases: [MESSAGE_ALIAS],
				count: 1,
				observedAt: "2026-07-27T12:00:00.000Z",
			}));
			const replacementApply = mock(originalApply);
			const mutable = {
				...provider("fake-mail"),
				apply: originalApply,
				hasPositiveLayoutSignature: () => {
					mutable.apply = replacementApply;
					return true;
				},
			};

			await guardedProviderApply(mutable, request());

			expect(originalApply).toHaveBeenCalledTimes(1);
			expect(replacementApply).not.toHaveBeenCalled();
		});

	it("rejects verification for a different canonical action", async () => {
			await expect(
				guardedProviderVerify(
					provider("fake-mail", {
						verify: () => ({
							schemaVersion: 1,
							action: {
								type: "mark_read",
								messageAlias: MESSAGE_ALIAS,
							},
							status: "completed",
							affectedCount: 1,
							observations: [],
						}),
					}),
					request(),
				),
			).rejects.toThrow(/action_mismatch/i);
	});

	it("guards the complete execution preflight and fresh-observation facade", async () => {
		const guarded = provider("fake-mail");
		const dispatch = dispatchRequest();
		const { action, rawTargets, ...scope } = dispatch;

		await expect(
			guardedProviderPreflight(guarded, {
				...scope,
				actions: [action],
				rawTargets,
			}),
		).resolves.toMatchObject({
			status: "ready",
			providerId: "fake-mail",
			accountAlias: ACCOUNT_ALIAS,
			locale: "en-US",
			layout: "supported",
			targets: "available",
		});
		await expect(
			guardedProviderDispatch(guarded, dispatch),
		).resolves.toEqual({ status: "dispatched" });
		await expect(
			guardedProviderObserve(guarded, dispatch),
		).resolves.toMatchObject({ status: "observed" });
		await expect(
			guardedProviderVerifyFresh(guarded, dispatch),
		).resolves.toMatchObject({ status: "verified" });
		await expect(
			guardedProviderObserveInbox(guarded, scope),
		).resolves.toMatchObject({ status: "observed", count: 0 });
	});

	it("binds the execution coordinator to exact projected results and call-scoped deadlines", async () => {
		const dispatch = dispatchRequest();
		const facade = createGuardedMailboxExecutionProvider(
			provider("fake-mail", {
				observe: async () => ({
					status: "observed",
					observedAt: "2026-07-27T12:00:01.000Z",
					rawSubject: "must-not-cross",
				}) as never,
			}),
		);
		await expect(
			facade.observe(dispatch, { timeoutMs: 100 }),
		).rejects.toThrow(/provider_shape/i);

		const hanging = createGuardedMailboxExecutionProvider(
			provider("fake-mail", {
				dispatch: () => new Promise(() => undefined),
			}),
		);
		await expect(
			hanging.dispatch(dispatch, { timeoutMs: 1 }),
		).rejects.toThrow(/provider_timeout/i);
	});

	it("rejects extra raw authority and classifies aborts and bounded timeouts", async () => {
		const dispatch = dispatchRequest();
		const apply = mock(() => ({ status: "dispatched" as const }));
		await expect(
			guardedProviderDispatch(
				provider("fake-mail", { dispatch: apply }),
				{
					...dispatch,
					rawTargets: {
						...dispatch.rawTargets,
						[`msg_${"a".repeat(32)}`]: "selector-or-token",
					},
				},
			),
		).rejects.toThrow(/provider_shape/i);
		expect(apply).not.toHaveBeenCalled();

		const abort = new AbortController();
		abort.abort();
		await expect(
			guardedProviderDispatch(provider("fake-mail"), dispatch, {
				signal: abort.signal,
			}),
		).rejects.toThrow(/provider_canceled/i);

		await expect(
			guardedProviderDispatch(
				provider("fake-mail", {
					dispatch: () => new Promise(() => undefined),
				}),
				dispatch,
				{ timeoutMs: 1 },
			),
		).rejects.toThrow(/provider_timeout/i);
	});

	it("propagates the dispatch deadline signal so cooperative providers cannot mutate late", async () => {
		let receivedSignal: AbortSignal | undefined;
		let mutated = false;
		const guarded = createGuardedMailboxExecutionProvider(
			provider("fake-mail", {
				async dispatch(_request, options) {
					receivedSignal = options?.signal;
					await new Promise<void>((resolve) =>
						options?.signal?.addEventListener(
							"abort",
							() => resolve(),
							{ once: true },
						)
					);
					if (options?.signal?.aborted) {
						throw new Error("dispatch canceled");
					}
					mutated = true;
					return { status: "dispatched" };
				},
			}),
		);

		await expect(
			guarded.dispatch(dispatchRequest(), { timeoutMs: 1 }),
		).rejects.toThrow(/provider_timeout/i);
		await Promise.resolve();

		expect(receivedSignal?.aborted).toBe(true);
		expect(mutated).toBe(false);
	});
});
