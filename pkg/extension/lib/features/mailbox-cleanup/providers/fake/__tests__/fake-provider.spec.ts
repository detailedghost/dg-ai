import { describe, expect, it } from "bun:test";
import {
	assertMailboxProviderPageReady,
	defineMailboxProvider,
	guardedProviderApply,
	guardedProviderCapture,
	guardedProviderVerify,
	type MailboxProviderMutationRequest,
} from "../../index";
import {
	computeMailboxCaptureChunkDigest,
	type MailboxCaptureChunk,
} from "../../../coordinator";
import { createFakeMailboxProviderHarness } from "../index";

const NOW = "2026-07-27T12:00:00.000Z";
const ACCOUNT_ALIAS = "acct_00112233445566778899aabbccddeeff";
const RUN_ALIAS = "run_102132435465768798a9bacbdcedfe0f";
const REVISION_ALIAS = "rev_fedcba98765432100123456789abcdef";
const MESSAGE_ALIAS = "msg_89abcdef01234567fedcba9876543210";
const FOLDER_ALIAS = "fld_79abcdef01234567fedcba9876543210";
const LABEL_ALIAS = "lbl_69abcdef01234567fedcba9876543210";
const FILTER_ALIAS = "flt_59abcdef01234567fedcba9876543210";

function captureRequest() {
	return {
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		runAlias: RUN_ALIAS,
		revisionAlias: REVISION_ALIAS,
	};
}

function mutationRequest(
	action: MailboxProviderMutationRequest["action"] = {
		type: "archive",
		messageAlias: MESSAGE_ALIAS,
	},
	rawTarget = "provider-message-1",
): MailboxProviderMutationRequest {
	return {
		...captureRequest(),
		action,
		rawTarget,
	};
}

async function messageChunk(
	sequence = 0,
	declaredTotal = 1,
): Promise<MailboxCaptureChunk> {
	const payload = {
		kind: "messages",
		items: [
			{
				alias: MESSAGE_ALIAS,
				read: false,
				hasAttachments: false,
				receivedAt: "2026-07-20T12:00:00.000Z",
				category: "newsletter",
			},
		],
	};
	const envelope = {
		schemaVersion: 1 as const,
		runAlias: RUN_ALIAS,
		sequence,
		declaredTotal,
		itemCount: payload.items.length,
		payload,
	};
	return {
		...envelope,
		digest: await computeMailboxCaptureChunkDigest(envelope),
	};
}

const DEFAULT_MESSAGE_CHUNK = await messageChunk();

function rawInventory(
	messageOverrides: Record<string, unknown> = {},
	filterOverrides: Record<string, unknown> = {},
) {
	return {
		messages: [
			{
				id: "provider-message-1",
				read: false,
				hasAttachments: false,
				receivedAt: "2026-07-20T12:00:00.000Z",
				category: "newsletter",
				archived: false,
				folderId: "provider-folder-source",
				labelIds: [],
				...messageOverrides,
			},
		],
		folders: [
			{ id: "provider-folder-source", messageCount: 1 },
			{ id: "provider-folder-1", messageCount: 0 },
		],
		labels: [{ id: "provider-label-1", messageCount: 0 }],
		filters: [
			{
				id: "provider-filter-1",
				active: true,
				...filterOverrides,
			},
		],
	};
}

function harness(
	overrides: Parameters<typeof createFakeMailboxProviderHarness>[0] = {},
) {
	return createFakeMailboxProviderHarness({
		now: () => NOW,
		accountAlias: ACCOUNT_ALIAS,
		rawInventory: rawInventory(),
		chunks: [DEFAULT_MESSAGE_CHUNK],
		bindings: {
			[MESSAGE_ALIAS]: "provider-message-1",
			[FOLDER_ALIAS]: "provider-folder-1",
			[LABEL_ALIAS]: "provider-label-1",
			[FILTER_ALIAS]: "provider-filter-1",
		},
		...overrides,
	});
}

describe("fake mailbox-provider-v1", () => {
	it("is an exact frozen provider contract with positive English readiness", async () => {
		const fake = harness();
		const provider = defineMailboxProvider(fake.provider);

		expect(Object.keys(provider).sort()).toEqual(
			[
				"id",
				"surfaces",
				"readLocale",
				"hasPositiveLayoutSignature",
				"capture",
				"apply",
				"verify",
			].sort(),
		);
		expect(Object.isFrozen(provider)).toBe(true);
		expect(provider.id).toBe("fake-mail");
		expect(await assertMailboxProviderPageReady(provider, "inbox")).toBe(
			"en-US",
		);
	});

	it("runs capture, preflight, apply, fresh observation, and verification", async () => {
		const fake = harness();
		const abort = new AbortController();

		await expect(
			guardedProviderCapture(fake.provider, captureRequest()),
		).resolves.toMatchObject({
			messages: [{ id: "provider-message-1", read: false }],
		});
		await expect(
			fake.coordinatorSeams.probe(captureRequest(), abort.signal),
		).resolves.toEqual({
			status: "ready",
			accountAlias: ACCOUNT_ALIAS,
			surface: "inbox",
		});
		await expect(
			guardedProviderApply(fake.provider, mutationRequest()),
		).resolves.toMatchObject({
			schemaVersion: 1,
			code: "changed",
			aliases: [MESSAGE_ALIAS],
			count: 1,
		});
		await expect(
			fake.coordinatorSeams.observe(
				{
					...captureRequest(),
					messageAliases: [MESSAGE_ALIAS],
				},
				abort.signal,
			),
		).resolves.toEqual({
			schemaVersion: 1,
			code: "matched",
			aliases: [MESSAGE_ALIAS],
			count: 1,
			observedAt: NOW,
		});
		await expect(
			guardedProviderVerify(fake.provider, mutationRequest()),
		).resolves.toMatchObject({
			action: mutationRequest().action,
			status: "completed",
			affectedCount: 1,
			observations: [
				{
					code: "verified",
					aliases: [MESSAGE_ALIAS],
				},
			],
		});
		expect(fake.calls.capture).toHaveLength(1);
		expect(fake.calls.probe).toHaveLength(1);
		expect(fake.calls.apply).toHaveLength(1);
		expect(fake.calls.observe).toHaveLength(1);
		expect(fake.calls.verify).toHaveLength(1);
	});

	it("streams the scripted capture chunks in order and reports truthful partial", async () => {
		const chunks = [
			await messageChunk(0, 2),
			await messageChunk(1, 2),
		];
		const fake = harness({
			chunks,
			captureStatus: "partial",
		});
		const abort = new AbortController();
		const received: MailboxCaptureChunk[] = [];

		for await (const chunk of fake.coordinatorSeams.capture(
			captureRequest(),
			abort.signal,
		)) {
			received.push(chunk);
		}

		expect(received).toEqual(chunks);
		expect(
			await fake.coordinatorSeams.captureResult(
				captureRequest(),
				abort.signal,
			),
		).toEqual({
			status: "partial",
			reasonCode: "provider_partial",
		});
	});

	it("uses fresh state rather than cached capture data for observation and verification", async () => {
		let now = NOW;
		const fake = harness({ now: () => now });
		const abort = new AbortController();
		const markRead = mutationRequest({
			type: "mark_read",
			messageAlias: MESSAGE_ALIAS,
		});
		await guardedProviderCapture(fake.provider, captureRequest());
		now = "2026-07-27T12:01:00.000Z";
		await guardedProviderApply(fake.provider, markRead);
		now = "2026-07-27T12:02:00.000Z";

		await expect(
			fake.coordinatorSeams.observe(
				{
					...captureRequest(),
					messageAliases: [MESSAGE_ALIAS],
				},
				abort.signal,
			),
		).resolves.toMatchObject({
			code: "matched",
			aliases: [MESSAGE_ALIAS],
			count: 1,
			observedAt: now,
		});
		await expect(
			guardedProviderVerify(fake.provider, markRead),
		).resolves.toMatchObject({
			status: "completed",
			observations: [{ code: "verified" }],
		});
	});

	it.each([
		[
			"archive",
			{ type: "archive", messageAlias: MESSAGE_ALIAS },
			"provider-message-1",
			rawInventory(),
			{ messages: [{ archived: true }] },
		],
		[
			"mark_read",
			{ type: "mark_read", messageAlias: MESSAGE_ALIAS },
			"provider-message-1",
			rawInventory(),
			{ messages: [{ read: true }] },
		],
		[
			"move_to_folder",
			{
				type: "move_to_folder",
				messageAlias: MESSAGE_ALIAS,
				folderAlias: FOLDER_ALIAS,
			},
			"provider-message-1",
			rawInventory(),
			{ messages: [{ folderId: "provider-folder-1" }] },
		],
		[
			"apply_label",
			{
				type: "apply_label",
				messageAlias: MESSAGE_ALIAS,
				labelAlias: LABEL_ALIAS,
			},
			"provider-message-1",
			rawInventory(),
			{ messages: [{ labelIds: ["provider-label-1"] }] },
		],
		[
			"remove_label",
			{
				type: "remove_label",
				messageAlias: MESSAGE_ALIAS,
				labelAlias: LABEL_ALIAS,
			},
			"provider-message-1",
			rawInventory({ labelIds: ["provider-label-1"] }),
			{ messages: [{ labelIds: [] }] },
		],
		[
			"deactivate_filter",
			{ type: "deactivate_filter", filterAlias: FILTER_ALIAS },
			"provider-filter-1",
			rawInventory(),
			{ filters: [{ active: false }] },
		],
	] as const)(
		"mutates fresh provider state and verifies %s from that state",
		async (_name, action, rawTarget, initialInventory, expectedState) => {
			const fake = harness({ rawInventory: initialInventory });
			const request = mutationRequest(action, rawTarget);

			await expect(
				guardedProviderApply(fake.provider, request),
			).resolves.toMatchObject({
				code: "changed",
				count: 1,
			});
			await expect(
				guardedProviderCapture(fake.provider, captureRequest()),
			).resolves.toMatchObject(expectedState);
			await expect(
				guardedProviderVerify(fake.provider, request),
			).resolves.toMatchObject({
				status: "completed",
				affectedCount: 1,
				observations: [{ code: "verified" }],
			});
		},
	);

	it("fails closed on raw-target mismatch without mutating provider state", async () => {
		const fake = harness();
		const mismatched = mutationRequest(
			{ type: "archive", messageAlias: MESSAGE_ALIAS },
			"provider-message-other",
		);

		await expect(
			guardedProviderApply(fake.provider, mismatched),
		).rejects.toThrow(/provider_failure/i);
		await expect(
			guardedProviderCapture(fake.provider, captureRequest()),
		).resolves.toMatchObject({
			messages: [{ archived: false }],
		});
	});

	it("detects state drift after apply instead of trusting the applied-action log", async () => {
		const fake = harness();
		const applyLabel = mutationRequest({
			type: "apply_label",
			messageAlias: MESSAGE_ALIAS,
			labelAlias: LABEL_ALIAS,
		});
		const removeLabel = mutationRequest({
			type: "remove_label",
			messageAlias: MESSAGE_ALIAS,
			labelAlias: LABEL_ALIAS,
		});
		await guardedProviderApply(fake.provider, applyLabel);
		await guardedProviderApply(fake.provider, removeLabel);

		await expect(
			guardedProviderVerify(fake.provider, applyLabel),
		).resolves.toMatchObject({
			status: "failed",
			reasonCode: "verification_mismatch",
			affectedCount: 0,
			observations: [{ code: "verification_mismatch" }],
		});
	});

	it.each([
		["capture", () => guardedProviderCapture(
			harness({ failures: { capture: "provider_refused" } }).provider,
			captureRequest(),
		)],
		["apply", () => guardedProviderApply(
			harness({ failures: { apply: "blocked_prompt" } }).provider,
			mutationRequest(),
		)],
		["verify", () => guardedProviderVerify(
			harness({ failures: { verify: "verification_mismatch" } }).provider,
			mutationRequest(),
		)],
	] as const)(
		"surfaces a sanitized scripted %s failure through the guarded provider",
		async (_stage, run) => {
			await expect(run()).rejects.toThrow(/provider_failure/i);
		},
	);

	it.each([
		["probe", "blocked_prompt"],
		["capture", "worker_suspended"],
		["observe", "verification_mismatch"],
	] as const)(
		"supports deterministic coordinator-side %s failure scripting",
		async (stage, reasonCode) => {
			const fake = harness({
				failures: { [stage]: reasonCode },
			});
			const abort = new AbortController();

			if (stage === "probe") {
				await expect(
					fake.coordinatorSeams.probe(captureRequest(), abort.signal),
				).resolves.toEqual({
					status: "blocked_prompt",
					reasonCode: "blocked_prompt",
				});
			} else if (stage === "capture") {
				const chunks = fake.coordinatorSeams.capture(
					captureRequest(),
					abort.signal,
				);
				await expect((async () => {
					for await (const _chunk of chunks) {
						// The scripted suspension must fail before any chunk escapes.
					}
				})()).rejects.toThrow(/worker_suspended/i);
			} else {
				await expect(
					fake.coordinatorSeams.observe(
						{
							...captureRequest(),
							messageAliases: [MESSAGE_ALIAS],
						},
						abort.signal,
					),
				).resolves.toMatchObject({
					code: "verification_mismatch",
					aliases: [MESSAGE_ALIAS],
				});
			}
		},
	);

	it("surfaces scripted body-read failures with their typed reason", async () => {
		const fake = harness({
			failures: { readBodies: "provider_refused" },
		});
		const abort = new AbortController();

		await expect(
			fake.coordinatorSeams.readBodies(
				{
					...captureRequest(),
					messageAliases: [MESSAGE_ALIAS],
				},
				abort.signal,
			),
		).rejects.toMatchObject({
			reasonCode: "provider_refused",
		});
	});

	it("surfaces non-mismatch observation failures instead of reporting matched", async () => {
		const fake = harness({
			failures: { observe: "worker_suspended" },
		});
		const abort = new AbortController();

		await expect(
			fake.coordinatorSeams.observe(
				{
					...captureRequest(),
					messageAliases: [MESSAGE_ALIAS],
				},
				abort.signal,
			),
		).rejects.toMatchObject({
			reasonCode: "worker_suspended",
		});
	});

	it.each([
		["locale", "provider_failure"],
		["layout", "layout_signature"],
	] as const)(
		"surfaces a scripted %s readiness failure",
		async (stage, expectedCode) => {
			const fake = harness({
				failures: { [stage]: "provider_refused" },
			});

			await expect(
				assertMailboxProviderPageReady(fake.provider, "inbox"),
			).rejects.toThrow(new RegExp(expectedCode, "i"));
		},
	);

	it("surfaces scripted post-stream capture-result failures", async () => {
		const fake = harness({
			failures: { captureResult: "provider_refused" },
		});
		const abort = new AbortController();
		for await (const _chunk of fake.coordinatorSeams.capture(
			captureRequest(),
			abort.signal,
		)) {
			// Exhaustion establishes the scoped capture before status is queried.
		}

		await expect(
			fake.coordinatorSeams.captureResult(
				captureRequest(),
				abort.signal,
			),
		).rejects.toMatchObject({
			reasonCode: "provider_refused",
		});
	});

	it("rejects capture-result queries without both the completed scope and signal", async () => {
		const fake = harness();
		const abort = new AbortController();
		for await (const _chunk of fake.coordinatorSeams.capture(
			captureRequest(),
			abort.signal,
		)) {
			// Exhaustion establishes the only scope eligible for completion.
		}
		const captureResult = fake.coordinatorSeams.captureResult as unknown as (
			request?: unknown,
			signal?: unknown,
		) => Promise<unknown>;

		await expect(
			captureResult(undefined, abort.signal),
		).rejects.toMatchObject({
			reasonCode: "malformed_stream",
		});
		await expect(
			captureResult(captureRequest()),
		).rejects.toMatchObject({
			reasonCode: "malformed_stream",
		});
	});

	it("honors an already-aborted signal before capture, observation, or body reads", async () => {
		const fake = harness({
			bodyResults: [
				{
					messageAlias: MESSAGE_ALIAS,
					text: "safe",
					attachments: [],
					quotedHistory: "",
				},
			],
		});
		const abort = new AbortController();
		abort.abort();

		await expect((async () => {
			for await (const _chunk of fake.coordinatorSeams.capture(
				captureRequest(),
				abort.signal,
			)) {
				// An aborted stream must not yield.
			}
		})()).rejects.toThrow(/canceled/i);
		await expect(
			fake.coordinatorSeams.observe(
				{
					...captureRequest(),
					messageAliases: [MESSAGE_ALIAS],
				},
				abort.signal,
			),
		).rejects.toThrow(/canceled/i);
		await expect(
			fake.coordinatorSeams.readBodies(
				{
					...captureRequest(),
					messageAliases: [MESSAGE_ALIAS],
				},
				abort.signal,
			),
		).rejects.toThrow(/canceled/i);
		expect(fake.calls.capture).toHaveLength(0);
		expect(fake.calls.observe).toHaveLength(0);
		expect(fake.calls.readBodies).toHaveLength(0);
	});
});
