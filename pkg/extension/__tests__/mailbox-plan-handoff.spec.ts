import { describe, expect, it } from "bun:test";
import type {
	MailboxChatMarker,
	MailboxChatOutboundMessage,
} from "@/lib/features/mailbox-cleanup/bridge";
import {
	createMailboxChatBridge,
	createMailboxRuntimeChatTransport,
	registerMailboxRuntimeChatHandoff,
} from "@/lib/features/mailbox-cleanup/bridge";
import {
	consumeMailboxPlanBootstrap,
	ensureMailboxPlanBaseRevision,
	initializeMailboxPlanPage,
	MAILBOX_PLAN_BOOTSTRAP_KEY,
	type MailboxPlanWorkspaceInput,
	validateMailboxPlanBootstrap,
	writeAndOpenMailboxPlan,
} from "@/lib/features/mailbox-cleanup/plan-page";
import {
	alias,
	bindingScope,
	captureResult,
	fingerprint,
	localHints,
	NEXT_REVISION_ALIAS,
	NOW_MS,
	PLAN_ALIAS,
	RAW_DISPLAY_SENTINEL,
	revision,
} from "./mailbox-plan-page-fixtures";

const REQUEST_ALIAS = "act_00112233445566778899aabbccddeeff";
const NONCE = "102132435465768798a9bacbdcedfe0f";

function bootstrap(): MailboxPlanWorkspaceInput {
	return {
		capture: captureResult(),
		baseRevision: revision(),
		bindingScope: bindingScope(),
		bindingExpiresAt: NOW_MS + 60 * 60 * 1_000,
		planExpiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
	};
}

function changed(change: (value: Record<string, unknown>) => void): unknown {
	const value = structuredClone(bootstrap()) as unknown as Record<
		string,
		unknown
	>;
	change(value);
	return value;
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected record fixture");
	}
	return value as Record<string, unknown>;
}

function runtimeHarness() {
	type Listener = (value: unknown) => unknown;
	let listener: Listener | undefined;
	const sent: unknown[] = [];
	let added = 0;
	let removed = 0;
	const runtime = {
		async sendMessage(value: unknown) {
			sent.push(structuredClone(value));
		},
		onMessage: {
			addListener(next: Listener) {
				added += 1;
				listener = next;
			},
			removeListener(next: Listener) {
				if (listener === next) listener = undefined;
				removed += 1;
			},
		},
	};
	return {
		added: () => added,
		async dispatch(value: unknown) {
			if (!listener) throw new Error("Runtime listener is not registered");
			return listener(value);
		},
		removed: () => removed,
		runtime,
		sent,
	};
}

function marker(overrides: Partial<MailboxChatMarker> = {}): MailboxChatMarker {
	return {
		schemaVersion: 1,
		planAlias: PLAN_ALIAS,
		requestAlias: REQUEST_ALIAS,
		nonce: NONCE,
		...overrides,
	};
}

function outbound(
	value: MailboxChatMarker = marker(),
	overrides: Readonly<{
		inventory?: ReturnType<typeof captureResult>["inventory"];
		revision?: ReturnType<typeof revision>;
	}> = {},
): MailboxChatOutboundMessage {
	return {
		...value,
		type: "mailbox_chat_submit",
		inventory: overrides.inventory ?? captureResult().inventory,
		revision: overrides.revision ?? revision(),
	};
}

function revisionWithExternalTarget(
	kind: "folder" | "label" | "filter",
): ReturnType<typeof revision> {
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

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("mailbox plan bootstrap handoff", () => {
	it("initializes the exact base revision before constructing or mounting the production page", async () => {
		const input = bootstrap();
		const gate = deferred();
		const events: string[] = [];
		const loadedBase = structuredClone(input.baseRevision);
		const initializing = initializeMailboxPlanPage(input, {
			lifecycle: {
				async get() {
					events.push("get");
					await gate.promise;
					return undefined;
				},
				async create(value) {
					events.push("create");
					expect(value).toEqual(input.baseRevision);
					return loadedBase;
				},
			},
			createWorkspace(value) {
				events.push("workspace");
				expect(value.baseRevision).toBe(loadedBase);
				return { value };
			},
			mount(workspace) {
				events.push("mount");
				return () => workspace;
			},
		});

		await Promise.resolve();
		expect(events).toEqual(["get"]);
		gate.resolve();
		const initialized = await initializing;
		expect(events).toEqual(["get", "create", "workspace", "mount"]);
		expect(initialized.workspace.value.baseRevision).toBe(loadedBase);
		expect(typeof initialized.dispose).toBe("function");
	});

	it("creates a missing base revision once, loads an exact existing revision, and rejects same-alias drift", async () => {
		const base = revision();
		const creationEvents: string[] = [];
		const created = await ensureMailboxPlanBaseRevision(base, {
			async get(planAlias) {
				creationEvents.push("get");
				expect(planAlias).toBe(base.planAlias);
				return undefined;
			},
			async create(value) {
				creationEvents.push("create");
				expect(value).toEqual(base);
				return base;
			},
		});
		expect(created).toEqual(base);
		expect(creationEvents).toEqual(["get", "create"]);

		const exactEvents: string[] = [];
		const loaded = await ensureMailboxPlanBaseRevision(base, {
			async get(planAlias) {
				exactEvents.push("get");
				return {
					schemaVersion: 1,
					planAlias,
					revisions: [structuredClone(base)],
				};
			},
			async create() {
				exactEvents.push("create");
				throw new Error("exact base must not be recreated");
			},
		});
		expect(loaded).toEqual(base);
		expect(exactEvents).toEqual(["get"]);

		const drift = revision({ actions: [] });
		await expect(
			ensureMailboxPlanBaseRevision(base, {
				async get(planAlias) {
					return {
						schemaVersion: 1,
						planAlias,
						revisions: [drift],
					};
				},
				async create() {
					throw new Error("drift must not be overwritten");
				},
			}),
		).rejects.toThrow("Mailbox base revision mismatch");
	});

	it("validates an exact bootstrap and rejects unknown fields and every scope cross-reference mismatch", () => {
		expect(validateMailboxPlanBootstrap(bootstrap())).toEqual(bootstrap());

		const alternate = {
			plan: "plan_ffffffffffffffffffffffffffffffff",
			account: "acct_ffffffffffffffffffffffffffffffff",
			run: "run_ffffffffffffffffffffffffffffffff",
			revision: "rev_ffffffffffffffffffffffffffffffff",
		};
		const invalidValues = [
			changed((value) => {
				value.extra = true;
			}),
			changed((value) => {
				record(value.capture).extra = true;
			}),
			changed((value) => {
				record(value.bindingScope).extra = true;
			}),
			changed((value) => {
				record(record(value.capture).metadata).extra = true;
			}),
			changed((value) => {
				const capture = record(value.capture);
				const inventory = record(capture.inventory);
				const labels = inventory.labels as Array<Record<string, unknown>>;
				record(capture.metadata).tags = [
					{ alias: labels[0]!.alias, messageCount: 1 },
				];
			}),
			changed((value) => {
				const capture = record(value.capture);
				const inventory = record(capture.inventory);
				const labels = inventory.labels as Array<Record<string, unknown>>;
				record(capture.metadata).categories = [
					{ alias: labels[0]!.alias, messageCount: 1 },
				];
			}),
			changed((value) => {
				const metadata = record(record(value.capture).metadata);
				const tags = metadata.tags as Array<Record<string, unknown>>;
				metadata.categories = [{ alias: tags[0]!.alias, messageCount: 1 }];
			}),
			changed((value) => {
				record(value.bindingScope).planAlias = alternate.plan;
			}),
			changed((value) => {
				record(value.bindingScope).accountAlias = alternate.account;
			}),
			changed((value) => {
				record(value.bindingScope).runAlias = alternate.run;
			}),
			changed((value) => {
				record(value.bindingScope).providerId = "other-mail";
			}),
			changed((value) => {
				record(value.bindingScope).surface = "archive";
			}),
			changed((value) => {
				record(value.bindingScope).revisionAlias = alternate.revision;
			}),
			changed((value) => {
				record(value.baseRevision).cohorts = [];
			}),
			changed((value) => {
				record(record(value.baseRevision).targets).folderAliases = [
					alias("fld", 999),
				];
			}),
			changed((value) => {
				record(record(value.baseRevision).targets).labelAliases = [
					alias("lbl", 999),
				];
			}),
			changed((value) => {
				record(record(value.baseRevision).targets).filterAliases = [
					alias("flt", 999),
				];
			}),
			changed((value) => {
				record(value.baseRevision).actions = [
					{ type: "archive", messageAlias: alias("msg", 999) },
				];
			}),
			changed((value) => {
				record(value.baseRevision).actions = [
					{
						type: "move_to_folder",
						messageAlias: alias("msg", 1),
						folderAlias: alias("fld", 999),
					},
				];
			}),
			changed((value) => {
				record(value.baseRevision).actions = [
					{
						type: "apply_label",
						messageAlias: alias("msg", 1),
						labelAlias: alias("lbl", 999),
					},
				];
			}),
			changed((value) => {
				record(value.baseRevision).actions = [
					{
						type: "deactivate_filter",
						filterAlias: alias("flt", 999),
					},
				];
			}),
			changed((value) => {
				record(record(value.capture).counts).messages = 7;
			}),
			changed((value) => {
				record(value.capture).choices = [];
			}),
			changed((value) => {
				value.localHints = [
					{
						...localHints()[0],
						cohortKey: "unknown-cohort",
					},
				];
			}),
			changed((value) => {
				value.localHints = [{ ...localHints()[0], extra: true }];
			}),
		];

		for (const value of invalidValues) {
			expect(() => validateMailboxPlanBootstrap(value)).toThrow(
				"Invalid mailbox plan bootstrap",
			);
		}
	});

	it("rejects invalid Date expiries and binding deadlines that do not precede plan expiry", () => {
		const createdAt = Date.parse(revision().createdAt);
		const invalidExpiries = [
			changed((value) => {
				value.bindingExpiresAt = createdAt;
			}),
			changed((value) => {
				value.bindingExpiresAt = createdAt - 1;
			}),
			changed((value) => {
				value.bindingExpiresAt = value.planExpiresAt;
			}),
			changed((value) => {
				value.bindingExpiresAt = (value.planExpiresAt as number) + 1;
			}),
			changed((value) => {
				value.bindingExpiresAt = 8_640_000_000_000_001;
			}),
			changed((value) => {
				value.planExpiresAt = 8_640_000_000_000_001;
			}),
		];

		for (const value of invalidExpiries) {
			expect(() => validateMailboxPlanBootstrap(value)).toThrow(
				"Invalid mailbox plan bootstrap",
			);
		}
	});

	it("consumes and deletes the exact key once, then verifies the persisted fingerprint", async () => {
		const calls: unknown[] = [];
		const value = bootstrap();
		const consumed = await consumeMailboxPlanBootstrap({
			session: {
				async get(key) {
					calls.push(["get", key]);
					return value;
				},
				async delete(key) {
					calls.push(["delete", key]);
				},
			},
			async computeFingerprint(input) {
				calls.push(["fingerprint", structuredClone(input)]);
				return fingerprint();
			},
		});

		expect(consumed).toEqual(value);
		expect(calls.map((call) => (call as unknown[])[0])).toEqual([
			"get",
			"delete",
			"fingerprint",
		]);
		expect(calls[0]).toEqual(["get", MAILBOX_PLAN_BOOTSTRAP_KEY]);
		expect(calls[1]).toEqual(["delete", MAILBOX_PLAN_BOOTSTRAP_KEY]);

		await expect(
			consumeMailboxPlanBootstrap({
				session: {
					async get() {
						return value;
					},
					async delete() {},
				},
				async computeFingerprint() {
					return fingerprint("b");
				},
			}),
		).rejects.toThrow("Invalid mailbox plan bootstrap");
	});

	it("writes only the validated sanitized bootstrap before opening the built mailbox-plan page", async () => {
		const calls: unknown[] = [];
		const value = structuredClone(bootstrap());
		record(value.capture).bodyChecks = RAW_DISPLAY_SENTINEL;

		await writeAndOpenMailboxPlan(value, {
			session: {
				async set(key, stored) {
					calls.push(["set", key, structuredClone(stored)]);
				},
				async delete(key) {
					calls.push(["delete", key]);
				},
			},
			async computeFingerprint() {
				return fingerprint();
			},
			runtime: {
				getURL(path) {
					calls.push(["getURL", path]);
					return `chrome-extension://dg-ai/${path}`;
				},
			},
			tabs: {
				async create(input) {
					calls.push(["create", input]);
				},
			},
		});

		expect(calls.map((call) => (call as unknown[])[0])).toEqual([
			"set",
			"getURL",
			"create",
		]);
		expect(calls[0]).toEqual(["set", MAILBOX_PLAN_BOOTSTRAP_KEY, bootstrap()]);
		expect(calls[1]).toEqual(["getURL", "mailbox-plan.html"]);
		expect(calls[2]).toEqual([
			"create",
			{ url: "chrome-extension://dg-ai/mailbox-plan.html" },
		]);
		expect(JSON.stringify(calls)).not.toContain(RAW_DISPLAY_SENTINEL);
	});

	it("deletes the staged bootstrap if opening the built page fails", async () => {
		const calls: unknown[] = [];
		await expect(
			writeAndOpenMailboxPlan(bootstrap(), {
				session: {
					async set(key) {
						calls.push(["set", key]);
					},
					async delete(key) {
						calls.push(["delete", key]);
					},
				},
				async computeFingerprint() {
					return fingerprint();
				},
				runtime: {
					getURL(path) {
						return `chrome-extension://dg-ai/${path}`;
					},
				},
				tabs: {
					async create() {
						throw new Error("tab failed");
					},
				},
			}),
		).rejects.toThrow("tab failed");
		expect(calls).toEqual([
			["set", MAILBOX_PLAN_BOOTSTRAP_KEY],
			["delete", MAILBOX_PLAN_BOOTSTRAP_KEY],
		]);
	});
});

describe("mailbox runtime chat handoff", () => {
	it("retries receiver open after an initial rejection, then delivers one submission", async () => {
		const harness = runtimeHarness();
		let openCalls = 0;
		const submissions: unknown[] = [];
		const registration = registerMailboxRuntimeChatHandoff({
			runtime: harness.runtime,
			receiver: {
				open() {
					openCalls += 1;
					if (openCalls === 1) throw new Error("receiver unavailable");
				},
				submit(value) {
					submissions.push(structuredClone(value));
				},
				reconnect() {},
				cancel() {},
				close() {},
			},
		});
		let bridgeListener: ((message: unknown) => void) | undefined;
		let randomSeed = 0;
		const bridge = createMailboxChatBridge({
			transport: {
				open: (value) =>
					harness.dispatch({
						type: "dg-mailbox-cleanup:chat-open",
						marker: value,
					}) as Promise<void>,
				send: (message) =>
					harness.dispatch({
						type: "dg-mailbox-cleanup:chat-submit",
						message,
					}) as Promise<void>,
				subscribe(listener) {
					bridgeListener = listener;
					return () => {
						bridgeListener = undefined;
					};
				},
				reconnect: (value) =>
					harness.dispatch({
						type: "dg-mailbox-cleanup:chat-reconnect",
						marker: value,
					}) as Promise<void>,
				cancel: (value) =>
					harness.dispatch({
						type: "dg-mailbox-cleanup:chat-cancel",
						marker: value,
					}) as Promise<void>,
				close: () => undefined,
			},
			randomBytes: () => {
				randomSeed += 1;
				return Uint8Array.from(
					{ length: 16 },
					(_unused, index) => randomSeed * 31 + index,
				);
			},
			now: () => NOW_MS,
			setTimeout: () => ({}),
			clearTimeout: () => undefined,
		});

		await expect(bridge.open(PLAN_ALIAS)).rejects.toMatchObject({
			code: "disconnected",
		});
		await bridge.reconnect();
		const waiting = bridge.submit({
			inventory: captureResult().inventory,
			revision: revision(),
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(openCalls).toBe(2);
		expect(submissions).toHaveLength(1);
		expect(bridgeListener).toBeDefined();
		await bridge.cancel();
		await expect(waiting).resolves.toEqual({ status: "canceled" });
		bridge.dispose();
		registration.dispose();
	});

	it("delivers explicit cancel with the exact marker and never aliases disposal to cancel", async () => {
		const explicit = runtimeHarness();
		const cancelMarkers: unknown[] = [];
		let explicitCloses = 0;
		const explicitRegistration = registerMailboxRuntimeChatHandoff({
			runtime: explicit.runtime,
			receiver: {
				open() {},
				submit() {},
				reconnect() {},
				cancel(value) {
					cancelMarkers.push(structuredClone(value));
				},
				close() {
					explicitCloses += 1;
				},
			},
		});
		const scope = marker();
		await explicit.dispatch({
			type: "dg-mailbox-cleanup:chat-open",
			marker: scope,
		});
		await explicit.dispatch({
			type: "dg-mailbox-cleanup:chat-cancel",
			marker: scope,
		});
		expect(cancelMarkers).toEqual([scope]);
		expect(explicitCloses).toBe(0);
		explicitRegistration.dispose();
		expect(explicitCloses).toBe(1);

		const disposed = runtimeHarness();
		let disposedCancels = 0;
		let disposedCloses = 0;
		const disposedRegistration = registerMailboxRuntimeChatHandoff({
			runtime: disposed.runtime,
			receiver: {
				open() {},
				submit() {},
				reconnect() {},
				cancel() {
					disposedCancels += 1;
				},
				close() {
					disposedCloses += 1;
				},
			},
		});
		await disposed.dispatch({
			type: "dg-mailbox-cleanup:chat-open",
			marker: scope,
		});
		disposedRegistration.dispose();
		expect(disposedCancels).toBe(0);
		expect(disposedCloses).toBe(1);
	});

	it("emits exact open, submit, reconnect, close envelopes and only forwards exact inbound envelopes", async () => {
		const harness = runtimeHarness();
		const transport = createMailboxRuntimeChatTransport({
			runtime: harness.runtime,
		});
		const inbound: unknown[] = [];
		const unsubscribe = transport.subscribe((value) => inbound.push(value));
		const scope = marker();
		const message = outbound(scope);

		await transport.open(scope);
		await transport.send(message);
		await transport.reconnect(scope);
		await transport.cancel(scope);
		await transport.close();
		await harness.dispatch({
			type: "dg-mailbox-cleanup:chat-inbound",
			payload: { status: "ack" },
		});
		await harness.dispatch({
			type: "dg-mailbox-cleanup:chat-inbound",
			payload: { status: "ignored" },
			extra: true,
		});

		expect(harness.sent).toEqual([
			{ type: "dg-mailbox-cleanup:chat-open", marker: scope },
			{ type: "dg-mailbox-cleanup:chat-submit", message },
			{ type: "dg-mailbox-cleanup:chat-reconnect", marker: scope },
			{ type: "dg-mailbox-cleanup:chat-cancel", marker: scope },
			{ type: "dg-mailbox-cleanup:chat-close" },
		]);
		expect(inbound).toEqual([{ status: "ack" }]);
		expect(harness.added()).toBe(1);
		unsubscribe();
		expect(harness.removed()).toBe(1);
	});

	it("delivers duplicate request/nonce submissions to the receiver exactly once and rejects conflicting replay", async () => {
		const harness = runtimeHarness();
		const submitGate = deferred<string>();
		const opens: unknown[] = [];
		const submissions: unknown[] = [];
		const reconnects: unknown[] = [];
		let closes = 0;
		let emitInbound: ((payload: unknown) => Promise<void>) | undefined;
		const registration = registerMailboxRuntimeChatHandoff({
			runtime: harness.runtime,
			receiver: {
				open(value, emit) {
					opens.push(value);
					emitInbound = emit;
				},
				submit(value) {
					submissions.push(structuredClone(value));
					return submitGate.promise;
				},
				reconnect(value) {
					reconnects.push(value);
				},
				cancel() {},
				close() {
					closes += 1;
				},
			},
		});
		const scope = marker();
		const message = outbound(scope);
		await harness.dispatch({
			type: "dg-mailbox-cleanup:chat-open",
			marker: scope,
		});
		const first = harness.dispatch({
			type: "dg-mailbox-cleanup:chat-submit",
			message,
		});
		const duplicate = harness.dispatch(
			structuredClone({
				type: "dg-mailbox-cleanup:chat-submit",
				message,
			}),
		);
		await Promise.resolve();

		expect(opens).toEqual([scope]);
		expect(submissions).toEqual([message]);
		submitGate.resolve("received");
		await expect(first).resolves.toBe("received");
		await expect(duplicate).resolves.toBe("received");

		const inboundAck = {
			...scope,
			type: "mailbox_chat_ack",
		};
		await emitInbound?.(inboundAck);
		expect(harness.sent).toEqual([
			{
				type: "dg-mailbox-cleanup:chat-inbound",
				payload: inboundAck,
			},
		]);
		await harness.dispatch({
			type: "dg-mailbox-cleanup:chat-reconnect",
			marker: scope,
		});
		expect(reconnects).toEqual([scope]);
		await expect(
			harness.dispatch({
				type: "dg-mailbox-cleanup:chat-reconnect",
				marker: marker({
					requestAlias: "act_ffffffffffffffffffffffffffffffff",
				}),
			}),
		).rejects.toThrow("Invalid mailbox chat runtime envelope");

		const conflict = structuredClone(message);
		record(conflict.inventory).messages = conflict.inventory.messages.slice(1);
		await expect(
			harness.dispatch({
				type: "dg-mailbox-cleanup:chat-submit",
				message: conflict,
			}),
		).rejects.toThrow("Invalid mailbox chat runtime envelope");

		registration.dispose();
		registration.dispose();
		expect(closes).toBe(1);
		expect(harness.removed()).toBe(1);
	});

	it("rejects first-delivery inventory, cohort, action, and target mismatches before the runtime receiver", async () => {
		const invalidMessages = [
			{
				name: "cohort inventory mismatch",
				message: outbound(marker(), {
					inventory: captureResult({ count: 7 }).inventory,
				}),
			},
			...(["folder", "filter"] as const).map((kind) => ({
				name: `${kind} target inventory mismatch`,
				message: outbound(marker(), {
					revision: revisionWithExternalTarget(kind),
				}),
			})),
		];

		for (const { name, message } of invalidMessages) {
			const harness = runtimeHarness();
			const submissions: unknown[] = [];
			const registration = registerMailboxRuntimeChatHandoff({
				runtime: harness.runtime,
				receiver: {
					open() {},
					submit(value) {
						submissions.push(value);
					},
					reconnect() {},
					cancel() {},
					close() {},
				},
			});
			await harness.dispatch({
				type: "dg-mailbox-cleanup:chat-open",
				marker: marker(),
			});
			try {
				await expect(
					harness.dispatch({
						type: "dg-mailbox-cleanup:chat-submit",
						message,
					}),
				).rejects.toThrow("Invalid mailbox chat runtime envelope");
			} catch (error) {
				throw new Error(`runtime accepted ${name}`, { cause: error });
			}
			expect(submissions).toEqual([]);
			registration.dispose();
		}
	});

	it("rejects proposal cohort, action, and target expansion beyond the submitted revision", async () => {
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

		for (const proposal of invalidProposals) {
			const harness = runtimeHarness();
			let emitInbound: ((payload: unknown) => Promise<void>) | undefined;
			const registration = registerMailboxRuntimeChatHandoff({
				runtime: harness.runtime,
				receiver: {
					open(_marker, emit) {
						emitInbound = emit;
					},
					submit() {
						return "received";
					},
					reconnect() {},
					cancel() {},
					close() {},
				},
				async verifyProposalFingerprint() {
					return true;
				},
			});
			const scope = marker();
			await harness.dispatch({
				type: "dg-mailbox-cleanup:chat-open",
				marker: scope,
			});
			await harness.dispatch({
				type: "dg-mailbox-cleanup:chat-submit",
				message: outbound(scope),
			});
			if (emitInbound === undefined) {
				throw new Error("Runtime receiver did not expose inbound seam");
			}

			await expect(
				emitInbound({
					...scope,
					type: "mailbox_chat_proposal",
					proposal,
				}),
			).rejects.toThrow("Invalid mailbox chat runtime envelope");
			expect(harness.sent).toEqual([]);
			registration.dispose();
		}
	});
});
