import { describe, expect, it, mock } from "bun:test";
import type {
	MailboxProvider,
	MailboxProviderMutationRequest,
	MailboxProviderVerificationRequest,
} from "../index";
import {
	assertMailboxProviderPageReady,
	defineMailboxProvider,
	discoverMailboxProviders,
	guardedProviderApply,
	guardedProviderCapture,
	guardedProviderVerify,
} from "../index";

const ACCOUNT_ALIAS = "acct_00112233445566778899aabbccddeeff";
const RUN_ALIAS = "run_102132435465768798a9bacbdcedfe0f";
const REVISION_ALIAS = "rev_fedcba98765432100123456789abcdef";
const MESSAGE_ALIAS = "msg_89abcdef01234567fedcba9876543210";

function provider(
	id: string,
	overrides: Partial<MailboxProvider> = {},
): MailboxProvider {
	return {
		id,
		surfaces: ["inbox"],
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
		...overrides,
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
	});
