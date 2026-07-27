import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { MailboxInventory, MailboxPlanRevision } from "@dg/common";
import {
	createMailboxChatBridge,
	type MailboxChatMarker,
} from "@/lib/features/mailbox-cleanup/bridge";
import {
	alias,
	captureResult,
	NEXT_REVISION_ALIAS,
	PLAN_ALIAS,
	RAW_DISPLAY_SENTINEL,
	RAW_LOCATOR_SENTINEL,
	revision,
} from "./mailbox-plan-page-fixtures";

type TransportMessage = Readonly<Record<string, unknown>>;

class FakeTransport {
	readonly operations: string[] = [];
	readonly opens: MailboxChatMarker[] = [];
	readonly reconnects: MailboxChatMarker[] = [];
	readonly cancels: MailboxChatMarker[] = [];
	readonly sends: TransportMessage[] = [];
	closed = 0;
	unsubscribed = 0;
	failNextOpen = false;
	failNextSend = false;
	private listener: ((message: unknown) => void) | undefined;

	subscribe(listener: (message: unknown) => void): () => void {
		this.operations.push("subscribe");
		this.listener = listener;
		return () => {
			this.unsubscribed += 1;
			this.listener = undefined;
		};
	}

	async open(marker: MailboxChatMarker): Promise<void> {
		this.operations.push("open");
		this.opens.push(marker);
		if (this.failNextOpen) {
			this.failNextOpen = false;
			throw new Error("receiver unavailable");
		}
	}

	async send(message: TransportMessage): Promise<void> {
		this.operations.push("send");
		if (this.failNextSend) {
			this.failNextSend = false;
			throw new Error("transport disconnected");
		}
		this.sends.push(structuredClone(message));
	}

	async reconnect(marker: MailboxChatMarker): Promise<void> {
		this.operations.push("reconnect");
		this.reconnects.push(marker);
	}

	async cancel(marker: MailboxChatMarker): Promise<void> {
		this.operations.push("cancel");
		this.cancels.push(marker);
	}

	close(): void {
		this.operations.push("close");
		this.closed += 1;
	}

	emit(message: unknown): void {
		this.listener?.(message);
	}
}

function bridgeHarness(
	options: Readonly<{
		randomBytes?: () => Uint8Array;
	}> = {},
) {
	const transport = new FakeTransport();
	const timers = new Map<object, () => void>();
	let randomSeed = 0;
	const bridge = createMailboxChatBridge({
		transport,
		randomBytes:
			options.randomBytes ??
			(() => {
				randomSeed += 1;
				return Uint8Array.from(
					{ length: 16 },
					(_unused, index) => (randomSeed * 31 + index) % 256,
				);
			}),
		now: () => Date.parse("2026-07-27T12:00:00.000Z"),
		setTimeout: (fn: () => void) => {
			const id = {};
			timers.set(id, fn);
			return id;
		},
		clearTimeout: (id: unknown) => {
			if (typeof id === "object" && id !== null) timers.delete(id);
		},
		timeoutMs: 5_000,
	} as never);
	return {
		bridge,
		fireTimers() {
			for (const callback of [...timers.values()]) callback();
			timers.clear();
		},
		timers,
		transport,
	};
}

function submission(
	overrides: Readonly<{
		inventory?: MailboxInventory;
		revision?: MailboxPlanRevision;
	}> = {},
) {
	return {
		inventory: overrides.inventory ?? captureResult().inventory,
		revision: overrides.revision ?? revision(),
	};
}

function ack(marker: MailboxChatMarker): TransportMessage {
	return {
		schemaVersion: 1,
		type: "mailbox_chat_ack",
		planAlias: marker.planAlias,
		requestAlias: marker.requestAlias,
		nonce: marker.nonce,
	};
}

function proposal(
	marker: MailboxChatMarker,
	value: MailboxPlanRevision = revision({
		revisionAlias: NEXT_REVISION_ALIAS,
		state: "draft",
	}),
): TransportMessage {
	return {
		schemaVersion: 1,
		type: "mailbox_chat_proposal",
		planAlias: marker.planAlias,
		requestAlias: marker.requestAlias,
		nonce: marker.nonce,
		proposal: value,
	};
}

function revisionWithExternalTarget(
	kind: "folder" | "label" | "filter",
): MailboxPlanRevision {
	const value = revision();
	const messageAlias = captureResult().inventory.messages[0]!.alias;
	switch (kind) {
		case "folder": {
			const folderAlias = alias("fld", 999);
			return revision({
				targets: {
					...value.targets,
					folderAliases: [...value.targets.folderAliases, folderAlias],
				},
				actions: [{ type: "move_to_folder", messageAlias, folderAlias }],
			});
		}
		case "label": {
			const labelAlias = alias("lbl", 999);
			return revision({
				targets: {
					...value.targets,
					labelAliases: [...value.targets.labelAliases, labelAlias],
				},
				actions: [{ type: "apply_label", messageAlias, labelAlias }],
			});
		}
		case "filter": {
			const filterAlias = alias("flt", 999);
			return revision({
				targets: {
					...value.targets,
					filterAliases: [...value.targets.filterAliases, filterAlias],
				},
				actions: [{ type: "deactivate_filter", filterAlias }],
			});
		}
	}
}

function canceledMessage(marker: MailboxChatMarker): TransportMessage {
	return {
		schemaVersion: 1,
		type: "mailbox_chat_canceled",
		planAlias: marker.planAlias,
		requestAlias: marker.requestAlias,
		nonce: marker.nonce,
	};
}

function failure(marker: MailboxChatMarker): TransportMessage {
	return {
		schemaVersion: 1,
		type: "mailbox_chat_error",
		planAlias: marker.planAlias,
		requestAlias: marker.requestAlias,
		nonce: marker.nonce,
		code: "internal_failure",
	};
}

async function nextMicrotask(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function rejectionCode(value: Promise<unknown>): Promise<string> {
	try {
		await value;
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string"
		) {
			return error.code;
		}
		throw error;
	}
	throw new Error("Expected promise to reject");
}

describe("mailbox waiting-chat bridge", () => {
	it("opens with only bounded opaque marker fields and subscribes before transport exposure", async () => {
		const { bridge, transport } = bridgeHarness();

		const marker = await bridge.open(PLAN_ALIAS);

		expect(transport.operations.slice(0, 2)).toEqual(["subscribe", "open"]);
		expect(Object.keys(marker).sort()).toEqual([
			"nonce",
			"planAlias",
			"requestAlias",
			"schemaVersion",
		]);
		expect(marker.schemaVersion).toBe(1);
		expect(marker.planAlias).toBe(PLAN_ALIAS);
		expect(/^act_[a-f0-9]{32}$/.test(marker.requestAlias)).toBe(true);
		expect(/^[a-f0-9]{32}$/.test(marker.nonce)).toBe(true);
		expect(marker.requestAlias.slice(4)).not.toBe(marker.nonce);
		expect(new Set(marker.requestAlias.slice(4)).size).toBeGreaterThan(8);
		expect(new Set(marker.nonce).size).toBeGreaterThan(8);
		expect(JSON.stringify(marker)).not.toContain(
			captureResult().inventory.messages[0]!.alias,
		);
		expect(JSON.stringify(marker)).not.toContain(RAW_DISPLAY_SENTINEL);
		expect(transport.sends).toEqual([]);

		bridge.dispose();
	});

	it("rejects short or low-entropy marker material before opening the transport", async () => {
		for (const randomBytes of [
			() => new Uint8Array(15),
			() => new Uint8Array(16),
			() => Uint8Array.from({ length: 16 }, (_unused, index) => index % 2),
		]) {
			const { bridge, transport } = bridgeHarness({ randomBytes });
			expect(await rejectionCode(bridge.open(PLAN_ALIAS))).toBe(
				"invalid_marker",
			);
			expect(transport.operations).toEqual([]);
			expect(transport.opens).toEqual([]);
		}
	});

	it("sends nothing before explicit Submit, then waits for an exact acknowledgement and one typed Draft", async () => {
		const { bridge, transport } = bridgeHarness();
		const marker = await bridge.open(PLAN_ALIAS);
		await nextMicrotask();
		expect(transport.sends).toEqual([]);

		const waiting = bridge.submit(submission());
		await nextMicrotask();
		expect(transport.sends).toHaveLength(1);
		const outbound = transport.sends[0]!;
		expect(Object.keys(outbound).sort()).toEqual([
			"inventory",
			"nonce",
			"planAlias",
			"requestAlias",
			"revision",
			"schemaVersion",
			"type",
		]);
		expect(outbound).toMatchObject({
			schemaVersion: 1,
			type: "mailbox_chat_submit",
			planAlias: marker.planAlias,
			requestAlias: marker.requestAlias,
			nonce: marker.nonce,
		});
		expect(outbound.inventory).toEqual(captureResult().inventory);
		expect(outbound.revision).toEqual(revision());

		let settled = false;
		void waiting.finally(() => {
			settled = true;
		});
		transport.emit(ack(marker));
		await nextMicrotask();
		expect(settled).toBe(false);
		const draft = revision({
			revisionAlias: NEXT_REVISION_ALIAS,
			state: "draft",
		});
		transport.emit(proposal(marker, draft));

		await expect(waiting).resolves.toMatchObject({
			status: "proposal",
			proposal: draft,
		});
		expect(transport.unsubscribed).toBe(1);
		expect(transport.closed).toBe(1);
	});

	it("rejects partial, unversioned, unknown-key, and raw-text submissions before transport", async () => {
		const cases: unknown[] = [
			submission({
				inventory: captureResult({ partial: true }).inventory,
			}),
			{
				...submission(),
				schemaVersion: undefined,
			},
			{
				...submission(),
				extra: true,
			},
			{
				...submission(),
				inventory: {
					...captureResult().inventory,
					messages: [
						{
							...captureResult().inventory.messages[0]!,
							subject: RAW_DISPLAY_SENTINEL,
							rawLocator: RAW_LOCATOR_SENTINEL,
						},
					],
				},
			},
		];

		for (const value of cases) {
			const { bridge, transport } = bridgeHarness();
			await bridge.open(PLAN_ALIAS);
			await expect(bridge.submit(value as never)).rejects.toThrow();
			expect(transport.sends).toEqual([]);
			bridge.dispose();
		}
	});

	it("rejects a revision whose cohorts do not describe the exact submitted inventory", async () => {
		const { bridge, transport } = bridgeHarness();
		await bridge.open(PLAN_ALIAS);

		const code = rejectionCode(
			bridge.submit({
				inventory: captureResult({ count: 7 }).inventory,
				revision: revision(),
			}),
		);
		await nextMicrotask();
		const sends = [...transport.sends];
		bridge.dispose();
		expect(sends).toEqual([]);
		expect(await code).toBe("invalid_submission");
	});

	it("rejects submitted actions and targets that are internally valid but absent from the exact inventory", async () => {
		for (const kind of ["folder", "filter"] as const) {
			const { bridge, transport } = bridgeHarness();
			await bridge.open(PLAN_ALIAS);
			await expect(
				bridge.submit(
					submission({ revision: revisionWithExternalTarget(kind) }),
				),
			).rejects.toMatchObject({ code: "invalid_submission" });
			expect(transport.sends).toEqual([]);
			bridge.dispose();
		}
	});

	it("rejects proposals whose cohorts, actions, or targets do not match the submitted inventory", async () => {
		const invalidProposals = [
			revision({
				revisionAlias: NEXT_REVISION_ALIAS,
				cohorts: captureResult({ count: 7 }).cohorts,
			}),
			...(["folder", "label", "filter"] as const).map((kind) => ({
				...revisionWithExternalTarget(kind),
				revisionAlias: NEXT_REVISION_ALIAS,
			})),
		];

		for (const invalidProposal of invalidProposals) {
			const { bridge, transport } = bridgeHarness();
			const bridgeMarker = await bridge.open(PLAN_ALIAS);
			const waiting = bridge.submit(submission());
			await nextMicrotask();
			transport.emit(ack(bridgeMarker));
			transport.emit(proposal(bridgeMarker, invalidProposal));
			await expect(waiting).rejects.toMatchObject({
				code: "invalid_message",
			});
			expect(transport.unsubscribed).toBe(1);
			expect(transport.closed).toBe(1);
		}
	});

	it("snapshots mutable submissions before any asynchronous transport handoff", async () => {
		const { bridge, transport } = bridgeHarness();
		const marker = await bridge.open(PLAN_ALIAS);
		const value = submission();
		const originalAlias = value.inventory.messages[0]!.alias;

		const waiting = bridge.submit(value);
		(value.inventory.messages as unknown as unknown[]).splice(0, 1);
		(value.revision.actions as unknown as unknown[]).splice(0, 1);
		await nextMicrotask();

		expect(transport.sends[0]?.inventory).toEqual(captureResult().inventory);
		expect(
			(transport.sends[0]?.revision as MailboxPlanRevision | undefined)
				?.actions,
		).toEqual(revision().actions);
		expect(JSON.stringify(transport.sends[0])).toContain(originalAlias);
		transport.emit(ack(marker));
		transport.emit(proposal(marker));
		await waiting;
	});

	it("rejects arbitrary chat text, mismatched scope, unknown keys, accepted revisions, and replay", async () => {
		const invalidMessages: readonly ((marker: MailboxChatMarker) => unknown)[] =
			[
				() => "archive everything",
				(marker) => ({
					...proposal(marker),
					nonce: "0".repeat(32),
				}),
				(marker) => ({
					...proposal(marker),
					extra: true,
				}),
				(marker) =>
					proposal(
						marker,
						revision({
							revisionAlias: NEXT_REVISION_ALIAS,
							state: "approved",
						}),
					),
			];

		for (const invalidMessage of invalidMessages) {
			const { bridge, fireTimers, transport } = bridgeHarness();
			const marker = await bridge.open(PLAN_ALIAS);
			const waiting = bridge.submit(submission());
			await nextMicrotask();
			transport.emit(invalidMessage(marker));
			fireTimers();
			expect(
				/invalid|timeout|replay|scope/.test(await rejectionCode(waiting)),
			).toBe(true);
			bridge.dispose();
		}

		const { bridge, transport } = bridgeHarness();
		const marker = await bridge.open(PLAN_ALIAS);
		const waiting = bridge.submit(submission());
		await nextMicrotask();
		transport.emit(ack(marker));
		transport.emit(proposal(marker));
		await waiting;
		transport.emit(proposal(marker));
		expect(
			/replay|closed|one_shot/.test(
				await rejectionCode(bridge.submit(submission())),
			),
		).toBe(true);
		expect(transport.sends).toHaveLength(1);
	});

	it("requires exact keys on every inbound schema and an acknowledgement before a proposal", async () => {
		const invalidMessages: readonly ((marker: MailboxChatMarker) => unknown)[] =
			[
				(marker) => proposal(marker),
				(marker) => ({ ...ack(marker), extra: true }),
				(marker) => {
					const { nonce: _nonce, ...missingNonce } = ack(marker);
					return missingNonce;
				},
				(marker) => ({ ...canceledMessage(marker), extra: true }),
				(marker) => {
					const { requestAlias: _requestAlias, ...missingRequest } =
						canceledMessage(marker);
					return missingRequest;
				},
				(marker) => ({ ...failure(marker), extra: true }),
				(marker) => ({ ...failure(marker), code: "not_a_reason_code" }),
				(marker) => {
					const { proposal: _proposal, ...missingProposal } = proposal(marker);
					return missingProposal;
				},
			];

		for (const invalidMessage of invalidMessages) {
			const { bridge, transport } = bridgeHarness();
			const marker = await bridge.open(PLAN_ALIAS);
			const waiting = bridge.submit(submission());
			await nextMicrotask();
			transport.emit(invalidMessage(marker));
			expect(/invalid|scope/.test(await rejectionCode(waiting))).toBe(true);
			expect(transport.unsubscribed).toBe(1);
			expect(transport.closed).toBe(1);
		}
	});

	it("maps Cancel and typed errors to one terminal result and always cleans up", async () => {
		const canceled = bridgeHarness();
		const canceledMarker = await canceled.bridge.open(PLAN_ALIAS);
		const canceledWaiting = canceled.bridge.submit(submission());
		await nextMicrotask();
		await canceled.bridge.cancel();
		await expect(canceledWaiting).resolves.toMatchObject({
			status: "canceled",
		});
		expect(canceled.transport.unsubscribed).toBe(1);
		expect(canceled.transport.closed).toBe(1);
		canceled.transport.emit(ack(canceledMarker));
		expect(canceled.transport.sends).toHaveLength(1);

		const failed = bridgeHarness();
		const failedMarker = await failed.bridge.open(PLAN_ALIAS);
		const failedWaiting = failed.bridge.submit(submission());
		await nextMicrotask();
		failed.transport.emit(ack(failedMarker));
		failed.transport.emit({
			schemaVersion: 1,
			type: "mailbox_chat_error",
			planAlias: failedMarker.planAlias,
			requestAlias: failedMarker.requestAlias,
			nonce: failedMarker.nonce,
			code: "internal_failure",
		});
		await expect(failedWaiting).resolves.toEqual({
			status: "error",
			code: "internal_failure",
		});
		expect(failed.transport.unsubscribed).toBe(1);
		expect(failed.transport.closed).toBe(1);

		const remoteCanceled = bridgeHarness();
		const remoteMarker = await remoteCanceled.bridge.open(PLAN_ALIAS);
		const remoteWaiting = remoteCanceled.bridge.submit(submission());
		await nextMicrotask();
		remoteCanceled.transport.emit(canceledMessage(remoteMarker));
		await expect(remoteWaiting).resolves.toEqual({
			status: "canceled",
		});
		expect(remoteCanceled.transport.unsubscribed).toBe(1);
		expect(remoteCanceled.transport.closed).toBe(1);
	});

	it("emits an exact cancel marker that is distinct from ordinary disposal", async () => {
		const canceled = bridgeHarness();
		const marker = await canceled.bridge.open(PLAN_ALIAS);
		await canceled.bridge.cancel();
		expect(canceled.transport.cancels).toEqual([marker]);
		expect(canceled.transport.operations).toContain("cancel");
		expect(canceled.transport.closed).toBe(1);

		const disposed = bridgeHarness();
		await disposed.bridge.open(PLAN_ALIAS);
		disposed.bridge.dispose();
		expect(disposed.transport.cancels).toEqual([]);
		expect(disposed.transport.operations).not.toContain("cancel");
		expect(disposed.transport.closed).toBe(1);
	});

	it("recovers an unacknowledged timeout by replaying the exact frozen submission", async () => {
		const { bridge, fireTimers, transport } = bridgeHarness();
		const marker = await bridge.open(PLAN_ALIAS);
		const firstWait = bridge.submit(submission());
		await nextMicrotask();
		expect(transport.sends).toHaveLength(1);
		fireTimers();
		await expect(firstWait).rejects.toMatchObject({
			code: "timeout",
		});

		await bridge.reconnect();
		expect(transport.reconnects).toEqual([marker]);
		const resumed = bridge.submit(submission());
		await nextMicrotask();
		expect(transport.sends).toHaveLength(2);
		expect(transport.sends[1]).toEqual(transport.sends[0]);
		transport.emit(ack(marker));
		transport.emit(proposal(marker));

		await expect(resumed).resolves.toMatchObject({
			status: "proposal",
		});
		expect(transport.sends).toHaveLength(2);
		expect(transport.unsubscribed).toBe(1);
		expect(transport.closed).toBe(1);
	});

	it("recovers an initial open with no receiver, then processes exactly one delivery", async () => {
		const { bridge, transport } = bridgeHarness();
		transport.failNextOpen = true;

		await expect(bridge.open(PLAN_ALIAS)).rejects.toMatchObject({
			code: "disconnected",
		});
		expect(bridge.isOpen()).toBe(false);
		expect(transport.operations).toEqual(["subscribe", "open"]);

		await bridge.reconnect();
		expect(bridge.isOpen()).toBe(true);
		expect(transport.operations).toEqual(["subscribe", "open", "open"]);
		expect(transport.opens).toHaveLength(2);
		expect(transport.opens[1]).toEqual(transport.opens[0]);

		const marker = transport.opens[0]!;
		const waiting = bridge.submit(submission());
		await nextMicrotask();
		expect(transport.sends).toHaveLength(1);
		transport.emit(ack(marker));
		transport.emit(proposal(marker));
		await expect(waiting).resolves.toMatchObject({ status: "proposal" });
		expect(transport.sends).toHaveLength(1);
		expect(transport.unsubscribed).toBe(1);
		expect(transport.closed).toBe(1);
	});

	it("recovers a failed send by retrying the exact frozen submission", async () => {
		const { bridge, transport } = bridgeHarness();
		transport.failNextSend = true;
		const marker = await bridge.open(PLAN_ALIAS);
		const firstWait = bridge.submit(submission());
		await nextMicrotask();
		expect(await rejectionCode(firstWait)).toBe("disconnected");
		expect(
			transport.operations.filter((operation) => operation === "send"),
		).toHaveLength(1);

		await bridge.reconnect();
		const resumed = bridge.submit(submission());
		await nextMicrotask();
		expect(
			transport.operations.filter((operation) => operation === "send"),
		).toHaveLength(2);
		expect(transport.sends).toHaveLength(1);
		expect(transport.sends[0]).toMatchObject({
			planAlias: marker.planAlias,
			requestAlias: marker.requestAlias,
			nonce: marker.nonce,
		});
		transport.emit(ack(marker));
		transport.emit(proposal(marker));
		await expect(resumed).resolves.toMatchObject({
			status: "proposal",
		});
		expect(transport.unsubscribed).toBe(1);
		expect(transport.closed).toBe(1);
	});

	it("enforces one open and cleans up a pending request exactly once on dispose", async () => {
		const { bridge, transport } = bridgeHarness();
		await bridge.open(PLAN_ALIAS);
		expect(await rejectionCode(bridge.open(PLAN_ALIAS))).toBe("one_shot");
		const waiting = bridge.submit(submission());
		await nextMicrotask();

		bridge.dispose();
		bridge.dispose();

		expect(await rejectionCode(waiting)).toBe("closed");
		expect(transport.unsubscribed).toBe(1);
		expect(transport.closed).toBe(1);
		expect(transport.sends).toHaveLength(1);
	});

	it("never transmits or retains local-only sentinels in markers, messages, errors, or cleanup state", async () => {
		const { bridge, transport } = bridgeHarness();
		const marker = await bridge.open(PLAN_ALIAS);
		const waiting = bridge.submit(submission());
		await nextMicrotask();
		transport.emit(ack(marker));
		transport.emit(proposal(marker));
		await waiting;

		const corpus = JSON.stringify({
			marker,
			opens: transport.opens,
			reconnects: transport.reconnects,
			sends: transport.sends,
			operations: transport.operations,
		});
		expect(corpus).not.toContain(RAW_DISPLAY_SENTINEL);
		expect(corpus).not.toContain(RAW_LOCATOR_SENTINEL);
		expect(corpus).not.toContain("Alice Example");
		expect(transport.closed).toBe(1);
	});
});
