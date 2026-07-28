import { readFile } from "node:fs/promises";
import type { MailboxCanonicalAction } from "@dg/common";
import { describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { registerMailboxCleanupBackground } from "@/lib/background/mailbox-cleanup";
import { createMailboxCleanupBackgroundComposition } from "@/lib/background/mailbox-cleanup-composition";
import {
	createMailboxExecutionCoordinator,
	createMailboxExecutionJournal,
	mailboxExecutionChangedAliases,
} from "@/lib/features/mailbox-cleanup/execution";
import {
	ACCOUNT_ALIAS,
	bindingScope,
	RUN_ALIAS,
} from "./mailbox-plan-page-fixtures";
import { workspaceHarness } from "./mailbox-plan-page-harness";

const command = Object.freeze({
	planAlias: "plan_0123456789abcdef0123456789abcdef",
	revisionAlias: "rev_fedcba9876543210fedcba9876543210",
});

type Listener = (message: unknown) => unknown;

type Registration = Readonly<{
	dispose(): void;
}>;

const registerBackground = registerMailboxCleanupBackground as unknown as (
	deps: Readonly<{
		runtime: Readonly<{
			sendMessage(value: unknown): Promise<unknown>;
			onMessage: Readonly<{
				addListener(listener: Listener): void;
				removeListener(listener: Listener): void;
			}>;
		}>;
		chatReceiver: Readonly<{
			open(marker: unknown, emit: (payload: unknown) => Promise<void>): void;
			submit(message: unknown): unknown;
			reconnect(marker: unknown): void;
			cancel(marker: unknown): void;
			close(): void;
		}>;
		execution: Readonly<{
			start(value: typeof command): Promise<unknown>;
			resume(value: typeof command): Promise<unknown>;
			cancel(value: typeof command): Promise<unknown>;
		}>;
	}>,
) => Registration;

function runtimeHarness() {
	const listeners = new Set<Listener>();
	let added = 0;
	let removed = 0;
	return {
		runtime: {
			async sendMessage() {},
			onMessage: {
				addListener(listener: Listener) {
					added += 1;
					listeners.add(listener);
				},
				removeListener(listener: Listener) {
					removed += 1;
					listeners.delete(listener);
				},
			},
		},
		async dispatch(value: unknown) {
			return Promise.all([...listeners].map((listener) => listener(value)));
		},
		added: () => added,
		removed: () => removed,
		active: () => listeners.size,
	};
}

describe("mailbox cleanup background assembly", () => {
	it("shares one runtime registration for the Slice 4 chat handoff and Slice 5 execution commands without duplicate delivery", async () => {
		const harness = runtimeHarness();
		const chat: string[] = [];
		const execution: string[] = [];
		const executionCommands: unknown[] = [];
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const deps = {
			runtime: harness.runtime,
			chatReceiver: {
				open() {
					chat.push("open");
				},
				submit() {
					chat.push("submit");
				},
				reconnect() {
					chat.push("reconnect");
				},
				cancel() {
					chat.push("cancel");
				},
				close() {
					chat.push("close");
				},
			},
			execution: {
				async start(value: typeof command) {
					execution.push("start");
					executionCommands.push(structuredClone(value));
					await startGate;
					return { status: "completed", resumable: false };
				},
				async resume(value: typeof command) {
					execution.push("resume");
					executionCommands.push(structuredClone(value));
					return { status: "completed", resumable: false };
				},
				async cancel(value: typeof command) {
					execution.push("cancel");
					executionCommands.push(structuredClone(value));
					return { status: "canceled", resumable: false };
				},
			},
		};
		const first = registerBackground(deps);
		const duplicate = registerBackground(deps);
		expect(harness.added()).toBe(1);
		expect(harness.active()).toBe(1);

		await harness.dispatch({
			type: "dg-mailbox-cleanup:chat-open",
			marker: {
				schemaVersion: 1,
				planAlias: command.planAlias,
				requestAlias: "act_89abcdef0123456789abcdef01234567",
				nonce: "0123456789abcdef0123456789abcdef",
			},
		});
		const firstDelivery = harness.dispatch({
			type: "dg-mailbox-cleanup:execution-start",
			command,
		});
		const duplicateDelivery = harness.dispatch({
			type: "dg-mailbox-cleanup:execution-start",
			command,
		});
		await Promise.resolve();

		expect(chat).toEqual(["open"]);
		expect(execution).toEqual(["start"]);
		expect(executionCommands).toEqual([command]);
		releaseStart();
		await Promise.all([firstDelivery, duplicateDelivery]);
		expect(JSON.stringify(executionCommands)).not.toMatch(
			/selector|command|action|provider|account|revision"\s*:/i,
		);
		duplicate.dispose();
		expect(harness.active()).toBe(1);
		first.dispose();
		expect(harness.active()).toBe(0);
		expect(harness.removed()).toBe(1);
	});

	it("coalesces only simultaneous delivery and re-enters Resume after an earlier result settles", async () => {
		const harness = runtimeHarness();
		let resumeCalls = 0;
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const registration = registerBackground({
			runtime: harness.runtime,
			chatReceiver: {
				open() {},
				submit() {},
				reconnect() {},
				cancel() {},
				close() {},
			},
			execution: {
				async start() {
					return { status: "completed", resumable: false };
				},
				async resume() {
					resumeCalls += 1;
					if (resumeCalls === 1) await firstGate;
					return resumeCalls === 1
						? {
								status: "paused",
								reasonCode: "blocked_prompt",
								resumable: true,
							}
						: { status: "completed", resumable: false };
				},
				async cancel() {
					return { status: "canceled", resumable: false };
				},
			},
		});
		const message = {
			type: "dg-mailbox-cleanup:execution-resume",
			command,
		};

		const first = harness.dispatch(message);
		const simultaneous = harness.dispatch(message);
		await Promise.resolve();
		expect(resumeCalls).toBe(1);
		releaseFirst();
		await expect(Promise.all([first, simultaneous])).resolves.toEqual([
			[
				{
					status: "paused",
					reasonCode: "blocked_prompt",
					resumable: true,
				},
			],
			[
				{
					status: "paused",
					reasonCode: "blocked_prompt",
					resumable: true,
				},
			],
		]);

		await expect(harness.dispatch(message)).resolves.toEqual([
			{ status: "completed", resumable: false },
		]);
		expect(resumeCalls).toBe(2);
		registration.dispose();
	});

	it("routes exact opaque Start, Resume, and Cancel envelopes while rejecting injected revision or page-command authority", async () => {
		const harness = runtimeHarness();
		const calls: unknown[] = [];
		const registration = registerBackground({
			runtime: harness.runtime,
			chatReceiver: {
				open() {},
				submit() {},
				reconnect() {},
				cancel() {},
				close() {},
			},
			execution: {
				async start(value) {
					calls.push(["start", structuredClone(value)]);
					return { status: "completed", resumable: false };
				},
				async resume(value) {
					calls.push(["resume", structuredClone(value)]);
					return { status: "completed", resumable: false };
				},
				async cancel(value) {
					calls.push(["cancel", structuredClone(value)]);
					return { status: "canceled", resumable: false };
				},
			},
		});

		for (const type of [
			"dg-mailbox-cleanup:execution-start",
			"dg-mailbox-cleanup:execution-resume",
			"dg-mailbox-cleanup:execution-cancel",
		]) {
			await harness.dispatch({ type, command });
		}
		expect(calls).toEqual([
			["start", command],
			["resume", command],
			["cancel", command],
		]);

		await expect(
			harness.dispatch({
				type: "dg-mailbox-cleanup:execution-start",
				command: {
					...command,
					revision: {
						state: "approved",
						actions: [{ command: "click", selector: "#private-row" }],
					},
				},
			}),
		).rejects.toThrow("Invalid mailbox cleanup execution envelope");
		expect(calls).toHaveLength(3);
		registration.dispose();
	});

	it("assembles the concrete mailbox composition exactly once in the production background entrypoint", async () => {
		const source = await readFile(
			new URL("../entrypoints/background.ts", import.meta.url),
			"utf8",
		);
		expect(
			source.match(/createMailboxCleanupBackgroundComposition\s*\(/g),
		).toHaveLength(1);
		expect(source).toMatch(
			/import\s*\{[^}]*createMailboxCleanupBackgroundComposition[^}]*\}\s*from\s*"@\/lib\/background"/s,
		);
		expect(source).toMatch(/mailbox\.register\s*\(\s*\)/);
	});

	it("installs a functional listener through the concrete production composition", async () => {
		const listeners = new Set<Listener>();
		const sessionValues = new Map<string, unknown>();
		const localValues = new Map<string, unknown>();
		const storageArea = (values: Map<string, unknown>) => ({
			async get(key: string) {
				return values.has(key) ? { [key]: values.get(key) } : {};
			},
			async set(next: Record<string, unknown>) {
				for (const [key, value] of Object.entries(next)) {
					values.set(key, structuredClone(value));
				}
			},
			async remove(key: string) {
				values.delete(key);
			},
		});
		const composition = createMailboxCleanupBackgroundComposition({
			browser: {
				runtime: {
					getURL(path) {
						return `chrome-extension://dgtest/${path}`;
					},
					async sendMessage() {},
					onMessage: {
						addListener(listener) {
							listeners.add(listener);
						},
						removeListener(listener) {
							listeners.delete(listener);
						},
					},
				},
				storage: {
					session: storageArea(sessionValues),
					local: storageArea(localValues),
				},
				downloads: {
					async download() {
						throw new Error("download must not run");
					},
				},
				tabs: {
					async create() {
						throw new Error("tab must not open");
					},
				},
			},
			indexedDB: new IDBFactory(),
			providers: [],
		});

		composition.register();
		expect(listeners.size).toBe(1);
		const results = await Promise.all(
			[...listeners].map((listener) =>
				listener({
					type: "dg-mailbox-cleanup:execution-start",
					command,
				}),
			),
		);
		expect(results).toEqual([
			{
				status: "failed",
				reasonCode: "internal_failure",
				resumable: false,
			},
		]);

		await composition.dispose();
		expect(listeners.size).toBe(0);
	});

	it("passes the exact canonical revision produced by plan Accept into opaque execution and reaches provider dispatch without re-authorization", async () => {
		const plan = workspaceHarness();
		const accepted = await plan.workspace.acceptRevision();
		expect(accepted.state).toBe("approved");
		expect(
			accepted.actions.every((action) => {
				const candidate = action as unknown as Record<string, unknown>;
				return (
					candidate.schemaVersion === 1 &&
					typeof candidate.actionAlias === "string"
				);
			}),
		).toBe(true);

		const values = new Map<string, unknown>();
		const versions = new Map<string, number>();
		const journal = createMailboxExecutionJournal({
			storage: {
				async read(key) {
					const value = values.get(key);
					return value === undefined
						? undefined
						: {
								version: versions.get(key) ?? 0,
								value: structuredClone(value),
							};
				},
				async compareAndSet(key, expectedVersion, value) {
					const currentVersion = values.has(key)
						? versions.get(key) ?? 0
						: undefined;
					if (currentVersion !== expectedVersion) return false;
					values.set(key, structuredClone(value));
					versions.set(key, (currentVersion ?? -1) + 1);
					return true;
				},
			},
			now: () => "2026-07-27T12:30:00.000Z",
		});
		const dispatched: unknown[] = [];
		const transitions: string[] = [];
		let fingerprintReads = 0;
		const coordinatorFactory =
			createMailboxExecutionCoordinator as unknown as (
				deps: Record<string, unknown>,
			) => Readonly<{
				start(value: Readonly<{
					planAlias: string;
					revisionAlias: string;
				}>): Promise<unknown>;
			}>;
		const coordinator = coordinatorFactory({
			async loadRevision() {
				return accepted;
			},
			async loadBinding() {
				const scope = bindingScope();
				return {
					scope: {
						providerId: scope.providerId,
						surface: scope.surface,
						accountAlias: ACCOUNT_ALIAS,
						runAlias: RUN_ALIAS,
						revisionAlias: accepted.revisionAlias,
					},
					bindings: Object.fromEntries(
						[...new Set(
							accepted.actions.flatMap((action) =>
								Object.values(action).filter(
									(value): value is string =>
										typeof value === "string" &&
										/^(msg|fld|lbl|flt)_[a-f0-9]{32}$/.test(
											value,
										),
								),
							),
						)].map((value, index) => [value, `raw-${index}`]),
					),
				};
			},
			async resolveProvider() {
				return {
					async preflight() {
						return {
							status: "ready",
							providerId: "fake-mail",
							surface: "inbox",
							accountAlias: ACCOUNT_ALIAS,
							locale: "en-US",
							layout: "supported",
							capabilities: accepted.actions.map(
								(action) => action.type,
							),
							targets: "available",
						};
					},
					async dispatch(input: unknown) {
						dispatched.push(structuredClone(input));
						return { status: "dispatched" };
					},
					async observe() {
						return {
							status: "observed",
							observedAt: "2026-07-27T12:30:01.000Z",
						};
					},
					async verifyFresh(request: {
						action: MailboxCanonicalAction;
					}) {
						return {
							status: "verified",
							verifiedAt: "2026-07-27T12:30:02.000Z",
							delta: {
								schemaVersion: 1,
								scope: "entire_fingerprint",
								actionAlias: request.action.actionAlias,
								changedAliases:
									mailboxExecutionChangedAliases(
										request.action,
									),
							},
						};
					},
					async observeInbox() {
						return {
							status: "observed",
							count: 1,
							observedAt: "2026-07-27T12:30:03.000Z",
						};
					},
				};
			},
			async computeFingerprint() {
				fingerprintReads += 1;
				return fingerprintReads === 1
					? accepted.inventoryFingerprint
					: {
							schemaVersion: 1,
							algorithm: "sha256",
							digest: (Math.floor(fingerprintReads / 2) + 1)
								.toString(16)
								.padStart(64, "0"),
						};
			},
			journal,
			now: () => "2026-07-27T12:30:00.000Z",
			async generateDebrief() {},
			async transitionRevision(
				_planAlias: string,
				_revisionAlias: string,
				expected: string,
				next: string,
			) {
				transitions.push(`${expected}->${next}`);
			},
		});
		const result = await coordinator.start({
			planAlias: accepted.planAlias,
			revisionAlias: accepted.revisionAlias,
		});

		expect(result).toMatchObject({ status: "completed" });
		expect(dispatched).toHaveLength(accepted.actions.length);
		expect(
			dispatched.map(
				(input) =>
					(input as { action: unknown }).action,
			),
		).toEqual([...accepted.actions]);
		expect(JSON.stringify(dispatched)).not.toMatch(
			/selector|providerCommand|script|javascript:/i,
		);
		expect(transitions).toEqual([
			"approved->in_flight",
			"in_flight->completed",
		]);
	});
});
