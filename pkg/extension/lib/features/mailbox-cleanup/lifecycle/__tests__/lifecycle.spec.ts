import { describe, expect, it, mock } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
	createMailboxPlanStore,
	createRawBindingStore,
	type RawBindingInvalidationReason,
} from "../../storage";
import { createMailboxLifecycle } from "../index";

const DAY = 24 * 60 * 60 * 1_000;

function opaqueAlias(prefix: string, seed: number): string {
	const bytes = Uint8Array.from(
		{ length: 16 },
		(_, index) => (seed * 17 + index * 13) % 256,
	);
	return `${prefix}_${[...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

const PLAN_ALIAS = opaqueAlias("plan", 1);

function clock(at = Date.UTC(2026, 6, 27, 12)) {
	let current = at;
		return {
		now: () => current,
		set(value: number) {
			current = value;
		},
	};
}

function revision(
	state: "draft" | "approved" | "in_flight" | "completed" = "draft",
	number = 1,
) {
	return {
		schemaVersion: 1 as const,
			planAlias: PLAN_ALIAS,
			revisionAlias: opaqueAlias("rev", number + 1),
		revisionNumber: number,
		state,
		restartRequired: false,
		createdAt: "2026-07-27T12:00:00.000Z",
		inventoryFingerprint: {
			schemaVersion: 1 as const,
			algorithm: "sha256" as const,
			digest: "a".repeat(64),
			},
			cohorts: [],
			targets: {
				folderAliases: [],
				labelAliases: [],
				filterAliases: [],
			},
			actions: [],
	};
}

function harness() {
	const time = clock();
	const store = createMailboxPlanStore({
		indexedDB: new IDBFactory(),
		now: time.now,
	});
	let present = true;
	const execution = {
		has: mock(() => present),
		invalidate: mock(async () => {
			present = false;
		}),
		remove: mock(async () => {
			present = false;
		}),
	};
	return {
		time,
		store,
		execution,
		lifecycle: createMailboxLifecycle({
			store,
			now: time.now,
			execution,
		}),
	};
}

async function reserveInFlightCompletion(
	store: ReturnType<typeof createMailboxPlanStore>,
	now: number,
) {
	const active = revision("in_flight");
	await store.putRevision(active, { expiresAt: now + 7 * DAY });
	const reservation = await store.reserveTerminalTransition(
		PLAN_ALIAS,
		active.revisionAlias,
		"in_flight",
		"completed",
		now + 7 * DAY,
	);
	return { active, reservation };
}

async function seedV3TerminalDatabase(
	indexedDB: IDBFactory,
	databaseName: string,
	terminal: ReturnType<typeof revision>,
	expiresAt: number,
) {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open(databaseName, 3);
		request.onupgradeneeded = () => {
			const plans = request.result.createObjectStore("plans", {
				keyPath: "planAlias",
			});
			const revisions = request.result.createObjectStore("revisions", {
				keyPath: "key",
			});
			plans.add({
				schemaVersion: 1,
				planAlias: terminal.planAlias,
				revisionAliases: [terminal.revisionAlias],
			});
			revisions.add({
				schemaVersion: 1,
				key: `${terminal.planAlias.length}:${terminal.planAlias}|${terminal.revisionAlias.length}:${terminal.revisionAlias}`,
				planAlias: terminal.planAlias,
				revisionAlias: terminal.revisionAlias,
				revision: terminal,
				expiresAt,
			});
		};
		request.onsuccess = () => {
			request.result.close();
			resolve();
		};
		request.onerror = () => reject(request.error);
	});
}

describe("mailbox plan lifecycle", () => {
	it("uses compare-and-set transitions and preserves an approved revision when editing creates a later draft", async () => {
		const { lifecycle } = harness();
		await lifecycle.create(revision());
			await lifecycle.transition({
				planAlias: PLAN_ALIAS,
				revisionAlias: revision().revisionAlias,
			expectedState: "draft",
			nextState: "approved",
		});
		await expect(
				lifecycle.transition({
					planAlias: PLAN_ALIAS,
					revisionAlias: revision().revisionAlias,
				expectedState: "draft",
				nextState: "completed",
			}),
		).rejects.toThrow(/state|compare/i);

			const edited = await lifecycle.edit(
				PLAN_ALIAS,
				revision().revisionAlias,
				revision("draft", 2),
			);
		expect(edited.revisionNumber).toBe(2);
		expect(edited.state).toBe("draft");
			expect((await lifecycle.get(PLAN_ALIAS))?.revisions).toMatchObject([
			{ revisionNumber: 1, state: "approved" },
			{ revisionNumber: 2, state: "draft" },
		]);
	});

	it("applies state-anchored retention and blocks access at the exact expiry boundary", async () => {
		for (const [state, retention] of [
			["draft", 30 * DAY],
			["approved", 7 * DAY],
			["in_flight", 7 * DAY],
			["completed", 7 * DAY],
		] as const) {
			const { lifecycle, time } = harness();
			const createdAt = time.now();
			await lifecycle.create({
				...revision(state),
				restartRequired: state === "draft",
			});

			time.set(createdAt + retention - 1);
				expect(await lifecycle.get(PLAN_ALIAS)).toBeDefined();
			time.set(createdAt + retention);
				expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
			time.set(createdAt + retention + 1);
			expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
		}
	});

	it("reconciles get, list, and resume and marks missing execution state restart-required", async () => {
		const { lifecycle } = harness();
			await lifecycle.create(revision("approved"));
			await lifecycle.removeExecutionState(
				PLAN_ALIAS,
				revision().revisionAlias,
			);

			const fromGet = await lifecycle.get(PLAN_ALIAS);
			const fromList = await lifecycle.list();
			const fromResume = await lifecycle.resume(PLAN_ALIAS);
		expect(fromGet?.revisions[0]?.restartRequired).toBe(true);
		expect(fromList[0]?.revisions[0]?.restartRequired).toBe(true);
		expect(fromResume?.restartRequired).toBe(true);
		expect(fromResume?.canExecute).toBe(false);
	});

	it("keeps a later draft after its approved base expires", async () => {
		const { lifecycle, time } = harness();
		const createdAt = time.now();
		await lifecycle.create(revision("approved"));
		await lifecycle.edit(
			PLAN_ALIAS,
			revision().revisionAlias,
			revision("draft", 2),
		);

		time.set(createdAt + 7 * DAY);
		expect((await lifecycle.get(PLAN_ALIAS))?.revisions).toMatchObject([
			{ revisionNumber: 2, state: "draft" },
		]);
		time.set(createdAt + 30 * DAY);
		expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
	});

	it("permits only one concurrent compare-and-set transition", async () => {
		const { lifecycle, execution, store } = harness();
		await lifecycle.create(revision());
		const base = {
			planAlias: PLAN_ALIAS,
			revisionAlias: revision().revisionAlias,
			expectedState: "draft" as const,
		};

		const results = await Promise.allSettled([
			lifecycle.transition({ ...base, nextState: "approved" }),
			lifecycle.transition({ ...base, nextState: "canceled" }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
			1,
		);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(
			1,
		);
		const finalState = (
			await store.getRevision(PLAN_ALIAS, revision().revisionAlias)
		)?.state;
		expect(execution.invalidate).toHaveBeenCalledTimes(
			finalState === "canceled" ? 1 : 0,
		);
	});

	it("blocks logically expired work even when startup cleanup cannot delete it", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
			const schedule = mock(async () => {});
			const cancel = mock(async () => {});
			const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				deleteRevision: async () => {
					throw new Error("browser suspended cleanup");
				},
			},
				now: time.now,
				execution: {
					has: async () => true,
					invalidate: async () => {},
				},
					alarms: { schedule, cancel },
		});
		await lifecycle.create(revision());

			time.set(time.now() + 30 * DAY);
			expect(await lifecycle.reconcileAll()).toEqual([]);
			expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
			expect(schedule).toHaveBeenLastCalledWith(PLAN_ALIAS, time.now());
			expect(cancel).not.toHaveBeenCalled();
		});

	it("delegates fingerprint comparison and fails closed after mismatch or storage failure", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const matches = mock(() => false);
		const invalidate = mock(async () => {});
		const mark = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
				fingerprints: { matches },
				execution: { has: async () => true, invalidate },
				restart: { mark },
		});
		const approved = revision("approved");
		await lifecycle.create(approved);
		const currentFingerprint = {
			schemaVersion: 1 as const,
			algorithm: "sha256" as const,
			digest: "b".repeat(64),
		};

		expect(
			(await lifecycle.resume(PLAN_ALIAS, currentFingerprint))
				?.restartRequired,
		).toBe(true);
		expect(matches).toHaveBeenCalledWith(
			approved.inventoryFingerprint,
			currentFingerprint,
		);
		expect(invalidate).toHaveBeenCalledWith(
			PLAN_ALIAS,
			approved.revisionAlias,
			"restart_required",
		);

		const failed = createMailboxLifecycle({
			store: {
				...store,
				getPlan: async () => {
					throw new Error("corrupt state");
				},
				deletePlan: async () => {
					throw new Error("cleanup unavailable");
				},
			},
				now: time.now,
				execution: {
					has: async () => false,
					invalidate: async () => {},
				},
				restart: { mark },
		});
		expect(await failed.get(PLAN_ALIAS)).toBeUndefined();
			expect(mark).toHaveBeenCalledWith(
				PLAN_ALIAS,
				undefined,
				"storage_failure",
			);
		});

	it("atomically rejects transitions and edits at the expiry boundary", async () => {
		const { lifecycle, time } = harness();
		await lifecycle.create(revision());
		time.set(time.now() + 30 * DAY);

		await expect(
			lifecycle.transition({
				planAlias: PLAN_ALIAS,
				revisionAlias: revision().revisionAlias,
				expectedState: "draft",
				nextState: "approved",
			}),
		).rejects.toThrow(/compare/i);
		await expect(
			lifecycle.edit(
				PLAN_ALIAS,
				revision().revisionAlias,
				revision("draft", 2),
			),
		).rejects.toThrow(/compare/i);
	});

	it("invalidates execution state before terminal CAS and safely retries cleanup failure", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		let failCleanup = true;
		const invalidate = mock(async () => {
			if (failCleanup) throw new Error("session unavailable");
		});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: { has: async () => true, invalidate },
		});
		const active = revision("in_flight");
		await lifecycle.create(active);
		const transition = {
			planAlias: PLAN_ALIAS,
			revisionAlias: active.revisionAlias,
			expectedState: "in_flight" as const,
			nextState: "completed" as const,
		};

		await expect(lifecycle.transition(transition)).rejects.toThrow(
			/session unavailable/,
		);
		expect(
			(await store.getRevision(PLAN_ALIAS, active.revisionAlias))?.state,
		).toBe("in_flight");
		failCleanup = false;
		await expect(lifecycle.transition(transition)).resolves.toMatchObject({
			state: "completed",
		});
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it("rechecks repository time after terminal cleanup", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => true,
				invalidate: async () => {
					time.set(time.now() + 7 * DAY);
				},
			},
		});
		const active = revision("in_flight");
		await lifecycle.create(active);

		await expect(
			lifecycle.transition({
				planAlias: PLAN_ALIAS,
				revisionAlias: active.revisionAlias,
				expectedState: "in_flight",
				nextState: "completed",
			}),
		).rejects.toThrow(/compare/i);
		expect(
			(await store.getRevision(PLAN_ALIAS, active.revisionAlias))?.state,
		).toBe("in_flight");
	});

	it("persists restart-required when execution storage is unavailable", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const mark = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => {
					throw new Error("session unavailable");
				},
				invalidate: async () => {
					throw new Error("session unavailable");
				},
			},
			restart: { mark },
		});
		const approved = revision("approved");
		await lifecycle.create(approved);

		expect(
			(await lifecycle.get(PLAN_ALIAS))?.revisions[0]?.restartRequired,
		).toBe(true);
		expect(mark).toHaveBeenCalledWith(
			PLAN_ALIAS,
			approved.revisionAlias,
			"storage_failure",
		);
	});

	it("fails closed when the current record vanishes before resume", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const approved = revision("approved");
		await store.putRevision(approved, { expiresAt: time.now() + 7 * DAY });
		const invalidate = mock(async () => {});
		const mark = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				getRecord: async () => undefined,
			},
			now: time.now,
			execution: { has: async () => true, invalidate },
			restart: { mark },
		});

		expect(await lifecycle.resume(PLAN_ALIAS)).toBeUndefined();
		expect(invalidate).toHaveBeenCalledWith(
			PLAN_ALIAS,
			approved.revisionAlias,
			"restart_required",
		);
		expect(mark).toHaveBeenCalledWith(
			PLAN_ALIAS,
			approved.revisionAlias,
			"storage_failure",
		);
	});

	it("recovers a reservation created during the final resume read", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const active = revision("in_flight");
		await store.putRevision(active, { expiresAt: time.now() + 7 * DAY });
		let injected = false;
		const invalidate = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				async getRecord(planAlias, revisionAlias) {
					if (!injected) {
						injected = true;
						await store.reserveTerminalTransition(
							planAlias,
							revisionAlias,
							"in_flight",
							"completed",
							time.now() + 7 * DAY,
						);
					}
					return store.getRecord(planAlias, revisionAlias);
				},
			},
			now: time.now,
			execution: { has: async () => true, invalidate },
		});

		expect(await lifecycle.resume(PLAN_ALIAS)).toMatchObject({
			canExecute: false,
			revision: { state: "completed" },
		});
		expect(invalidate).toHaveBeenCalledWith(
			PLAN_ALIAS,
			active.revisionAlias,
			"completion",
		);
	});

	it("converges concurrent identical terminal transitions", async () => {
		const { lifecycle } = harness();
		const active = revision("in_flight");
		await lifecycle.create(active);
		const transition = {
			planAlias: PLAN_ALIAS,
			revisionAlias: active.revisionAlias,
			expectedState: "in_flight" as const,
			nextState: "completed" as const,
		};

		const results = await Promise.all([
			lifecycle.transition(transition),
			lifecycle.transition(transition),
		]);

		expect(results).toMatchObject([
			{ state: "completed" },
			{ state: "completed" },
		]);
	});

	it("rejects a stale terminal request from a different expected state", async () => {
		const { lifecycle } = harness();
		const draft = revision();
		await lifecycle.create(draft);
		await lifecycle.transition({
			planAlias: PLAN_ALIAS,
			revisionAlias: draft.revisionAlias,
			expectedState: "draft",
			nextState: "canceled",
		});

		await expect(
			lifecycle.transition({
				planAlias: PLAN_ALIAS,
				revisionAlias: draft.revisionAlias,
				expectedState: "approved",
				nextState: "canceled",
			}),
		).rejects.toThrow(/compare/i);
	});

	it("converges when reconciliation commits between reserve and caller commit", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const active = revision("in_flight");
		await store.putRevision(active, { expiresAt: time.now() + 7 * DAY });
		const reconciler = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => true,
				invalidate: async () => {},
			},
		});
		let reconciled = false;
		const caller = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => true,
				invalidate: async () => {
					if (!reconciled) {
						reconciled = true;
						await reconciler.get(PLAN_ALIAS);
					}
				},
			},
		});

		await expect(
			caller.transition({
				planAlias: PLAN_ALIAS,
				revisionAlias: active.revisionAlias,
				expectedState: "in_flight",
				nextState: "completed",
			}),
		).resolves.toMatchObject({ state: "completed" });
		expect(
			(await store.getRevision(PLAN_ALIAS, active.revisionAlias))?.state,
		).toBe("completed");
	});

	it("retries raced terminal cleanup durably across restart", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const sessionValues = new Map<string, unknown>();
		const rawBindings = createRawBindingStore({
			session: {
				get: async (key) => sessionValues.get(key),
				set: async (key, value) => {
					sessionValues.set(key, value);
				},
				delete: async (key) => {
					sessionValues.delete(key);
				},
			},
			now: time.now,
		});
		const draft = revision();
		const scope = {
			planAlias: PLAN_ALIAS,
			providerId: "fake-mail",
			surface: "inbox",
			accountAlias: opaqueAlias("acct", 30),
			runAlias: opaqueAlias("run", 31),
			revisionAlias: draft.revisionAlias,
		};
		await rawBindings.put(scope, {
			[opaqueAlias("msg", 32)]: "provider-message-race",
		});
		await store.putRevision(draft, {
			expiresAt: time.now() + 30 * DAY,
		});
		const targetExpiresAt = time.now() + 7 * DAY;
		await store.reserveTerminalTransition(
			PLAN_ALIAS,
			draft.revisionAlias,
			"draft",
			"canceled",
			targetExpiresAt,
		);
		const winner = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => true,
				invalidate: async (_planAlias, _revisionAlias, reason) => {
					return rawBindings.invalidateRevision(
						scope.planAlias,
						scope.revisionAlias,
						reason,
					);
				},
			},
		});
		let winnerRan = false;
		const loserSchedule = mock(async () => {});
		const loser = createMailboxLifecycle({
			store: {
				...store,
				async failTerminalReservation(
					planAlias,
					revisionAlias,
					reservationNonce,
				) {
					if (!winnerRan) {
						winnerRan = true;
						await winner.get(planAlias);
					}
					return store.failTerminalReservation(
						planAlias,
						revisionAlias,
						reservationNonce,
					);
				},
			},
			now: time.now,
			alarms: {
				schedule: loserSchedule,
				cancel: async () => {},
			},
			execution: {
				has: async () => true,
				invalidate: async () => {
					throw new Error("losing cleanup unavailable");
				},
			},
		});

		expect(await loser.get(PLAN_ALIAS)).toMatchObject({
			revisions: [{ state: "canceled" }],
		});
		expect(await rawBindings.get(scope)).toBeUndefined();
		expect(loserSchedule).toHaveBeenLastCalledWith(PLAN_ALIAS, time.now());
		expect(
			(await store.getRecord(PLAN_ALIAS, draft.revisionAlias))
				?.terminalCleanupPending,
		).toBe(true);

		const restartedSchedule = mock(async () => {});
		const restarted = createMailboxLifecycle({
			store,
			now: time.now,
			alarms: {
				schedule: restartedSchedule,
				cancel: async () => {},
			},
			execution: {
				has: async () => true,
				invalidate: async (_planAlias, _revisionAlias, reason) => {
					return rawBindings.invalidateRevision(
						scope.planAlias,
						scope.revisionAlias,
						reason,
					);
				},
			},
		});
		expect(await restarted.get(PLAN_ALIAS)).toMatchObject({
			revisions: [{ state: "canceled" }],
		});
		expect(
			(await store.getRecord(PLAN_ALIAS, draft.revisionAlias))
				?.terminalCleanupPending,
		).toBeUndefined();
		expect(restartedSchedule).toHaveBeenLastCalledWith(
			PLAN_ALIAS,
			targetExpiresAt,
		);
	});

	it("converges two failing reconcilers on the exact restart outcome", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const draft = revision();
		const originalExpiresAt = time.now() + 30 * DAY;
		await store.putRevision(draft, { expiresAt: originalExpiresAt });
		await store.reserveTerminalTransition(
			PLAN_ALIAS,
			draft.revisionAlias,
			"draft",
			"canceled",
			time.now() + 7 * DAY,
		);
		const invalidate = mock(async () => {
			throw new Error("session unavailable");
		});
		const schedule = mock(async () => {});
		const reconciler = () =>
			createMailboxLifecycle({
				store,
				now: time.now,
				alarms: {
					schedule,
					cancel: async () => {},
				},
				execution: {
					has: async () => true,
					invalidate,
				},
			});

		const results = await Promise.all([
			reconciler().get(PLAN_ALIAS),
			reconciler().get(PLAN_ALIAS),
		]);

		expect(results).toMatchObject([
			{ revisions: [{ state: "draft", restartRequired: true }] },
			{ revisions: [{ state: "draft", restartRequired: true }] },
		]);
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(schedule).toHaveBeenLastCalledWith(
			PLAN_ALIAS,
			originalExpiresAt,
		);
		expect(
			await store.getRecord(PLAN_ALIAS, draft.revisionAlias),
		).toMatchObject({
			expiresAt: originalExpiresAt,
			revision: { restartRequired: true, state: "draft" },
		});
	});

	it("re-arms cleanup at the logical expiry before terminal invalidation", async () => {
		const time = clock();
		const createdAt = time.now();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const scheduled: number[] = [];
		const schedule = mock((_planAlias: string, when: number) => {
			scheduled.push(when);
		});
		const targetExpiresAt = createdAt + 7 * DAY;
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			alarms: {
				schedule,
				cancel: async () => {},
			},
			execution: {
				has: async () => true,
				invalidate: async () => {
					expect(scheduled.at(-1)).toBe(targetExpiresAt);
					throw new Error("simulated crash window");
				},
			},
		});
		const draft = revision();
		await lifecycle.create(draft);

		await expect(
			lifecycle.transition({
				planAlias: PLAN_ALIAS,
				revisionAlias: draft.revisionAlias,
				expectedState: "draft",
				nextState: "canceled",
			}),
		).rejects.toThrow(/crash window/i);

		expect(scheduled).toEqual([
			createdAt + 30 * DAY,
			targetExpiresAt,
		]);
		expect(
			(await store.getRecord(PLAN_ALIAS, draft.revisionAlias))
				?.terminalReservation?.targetExpiresAt,
		).toBe(targetExpiresAt);
	});

	it("does not revive a reservation when failed cleanup crosses its target expiry", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const draft = revision();
		await store.putRevision(draft, {
			expiresAt: time.now() + 30 * DAY,
		});
		const targetExpiresAt = time.now() + 7 * DAY;
		await store.reserveTerminalTransition(
			PLAN_ALIAS,
			draft.revisionAlias,
			"draft",
			"canceled",
			targetExpiresAt,
		);
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => true,
				invalidate: async () => {
					time.set(targetExpiresAt);
					throw new Error("session unavailable");
				},
			},
		});

		expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
		expect(
			await store.getRecord(PLAN_ALIAS, draft.revisionAlias),
		).toBeUndefined();
	});

	it("retries physical cleanup when successful invalidation crosses target expiry", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const draft = revision();
		await store.putRevision(draft, {
			expiresAt: time.now() + 30 * DAY,
		});
		const targetExpiresAt = time.now() + 7 * DAY;
		await store.reserveTerminalTransition(
			PLAN_ALIAS,
			draft.revisionAlias,
			"draft",
			"canceled",
			targetExpiresAt,
		);
		let deleteAttempts = 0;
		const scheduled: number[] = [];
		const cancel = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				async deleteRevision(planAlias, revisionAlias) {
					deleteAttempts += 1;
					if (deleteAttempts === 1) {
						throw new Error("cleanup unavailable");
					}
					await store.deleteRevision(planAlias, revisionAlias);
				},
			},
			now: time.now,
			alarms: {
				schedule: async (_planAlias, when) => {
					scheduled.push(when);
				},
				cancel,
			},
			execution: {
				has: async () => true,
				invalidate: async () => {
					time.set(targetExpiresAt);
				},
			},
		});

		expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
		expect(deleteAttempts).toBe(1);
		expect(scheduled.at(-1)).toBe(targetExpiresAt);
		expect(cancel).not.toHaveBeenCalled();
		expect(
			(await store.getRecord(PLAN_ALIAS, draft.revisionAlias))
				?.terminalReservation,
		).toBeDefined();

		expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
		expect(deleteAttempts).toBe(2);
		expect(
			await store.getRecord(PLAN_ALIAS, draft.revisionAlias),
		).toBeUndefined();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("continues terminal invalidation when alarm scheduling rejects", async () => {
		for (const [state, nextState] of [
			["in_flight", "completed"],
			["draft", "canceled"],
		] as const) {
			const time = clock();
			const store = createMailboxPlanStore({
				indexedDB: new IDBFactory(),
				now: time.now,
			});
			const invalidate = mock(async () => {});
			const schedule = mock(async () => {
				throw new Error("alarm unavailable");
			});
			const lifecycle = createMailboxLifecycle({
				store,
				now: time.now,
				alarms: {
					schedule,
					cancel: async () => {},
				},
				execution: {
					has: async () => true,
					invalidate,
				},
			});
			const current = revision(state);
			await lifecycle.create(current);

			await expect(
				lifecycle.transition({
					planAlias: PLAN_ALIAS,
					revisionAlias: current.revisionAlias,
					expectedState: state,
					nextState,
				}),
			).resolves.toMatchObject({ state: nextState });
			expect(invalidate).toHaveBeenCalledWith(
				PLAN_ALIAS,
				current.revisionAlias,
				nextState === "completed" ? "completion" : "cancellation",
			);
			expect(schedule).toHaveBeenCalled();
		}
	});

	it("expires reserved cancellation at its shorter target boundary", async () => {
		for (const offset of [-1, 0, 1] as const) {
			const time = clock();
			const store = createMailboxPlanStore({
				indexedDB: new IDBFactory(),
				now: time.now,
			});
			const draft = revision();
			await store.putRevision(draft, {
				expiresAt: time.now() + 30 * DAY,
			});
			const targetExpiresAt = time.now() + 7 * DAY;
			await store.reserveTerminalTransition(
				PLAN_ALIAS,
				draft.revisionAlias,
				"draft",
				"canceled",
				targetExpiresAt,
			);
			const lifecycle = createMailboxLifecycle({
				store,
				now: time.now,
				execution: {
					has: async () => true,
					invalidate: async () => {},
				},
			});
			time.set(targetExpiresAt + offset);

			const plan = await lifecycle.get(PLAN_ALIAS);
			if (offset < 0) {
				expect(plan?.revisions[0]).toMatchObject({ state: "canceled" });
			} else {
				expect(plan).toBeUndefined();
			}
		}
	});

	it("retries restart-required binding cleanup after session recovery", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const sessionValues = new Map<string, unknown>();
		const rawBindings = createRawBindingStore({
			session: {
				get: async (key) => sessionValues.get(key),
				set: async (key, value) => {
					sessionValues.set(key, value);
				},
				delete: async (key) => {
					sessionValues.delete(key);
				},
			},
			now: time.now,
		});
		const active = revision("approved");
		const scope = {
			planAlias: PLAN_ALIAS,
			providerId: "fake-mail",
			surface: "inbox",
			accountAlias: opaqueAlias("acct", 20),
			runAlias: opaqueAlias("run", 21),
			revisionAlias: active.revisionAlias,
		};
		await rawBindings.put(scope, {
			[opaqueAlias("msg", 22)]: "provider-message-42",
		});
		let available = false;
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => {
					if (!available) throw new Error("session unavailable");
					return (await rawBindings.get(scope)) !== undefined;
				},
				invalidate: async (_planAlias, _revisionAlias, reason) => {
					if (!available) throw new Error("session unavailable");
					return rawBindings.invalidateRevision(
						scope.planAlias,
						scope.revisionAlias,
						reason,
					);
				},
			},
		});
		await lifecycle.create(active);

		expect((await lifecycle.get(PLAN_ALIAS))?.revisions[0]).toMatchObject({
			restartRequired: true,
		});
		expect(await rawBindings.get(scope)).toBeDefined();

		available = true;
		expect((await lifecycle.get(PLAN_ALIAS))?.revisions[0]).toMatchObject({
			restartRequired: true,
		});
		expect(await rawBindings.get(scope)).toBeUndefined();
	});

	it("allocates concurrent edit numbers atomically", async () => {
		const { lifecycle } = harness();
		const approved = revision("approved");
		await lifecycle.create(approved);

		const edits = await Promise.all([
			lifecycle.edit(
				PLAN_ALIAS,
				approved.revisionAlias,
				revision("draft", 2),
			),
			lifecycle.edit(
				PLAN_ALIAS,
				approved.revisionAlias,
				revision("draft", 3),
			),
		]);

		expect(edits.map((item) => item.revisionNumber).sort()).toEqual([2, 3]);
	});

	it("emits a bounded store-corrupt signal when listing is unavailable", async () => {
		const { store } = harness();
		const mark = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				listPlans: async () => {
					throw new Error("raw database failure");
				},
			},
			now: () => Date.UTC(2026, 6, 27, 12),
			execution: {
				has: async () => true,
				invalidate: async () => {},
			},
			restart: { mark },
		});

		await expect(lifecycle.list()).rejects.toThrow(
			"Mailbox lifecycle rejected: store_corrupt",
		);
		expect(mark).toHaveBeenCalledWith(
			undefined,
			undefined,
			"storage_failure",
		);
	});

	it("queries live session state after a service-worker restart", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const first = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => true,
				invalidate: async () => {},
			},
		});
		await first.create(revision("approved"));
		const has = mock(async () => false);
		const restarted = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has,
				invalidate: async () => {},
			},
		});

		expect(
			(await restarted.get(PLAN_ALIAS))?.revisions[0]?.restartRequired,
		).toBe(true);
		expect(has).toHaveBeenCalledWith(
			PLAN_ALIAS,
			revision().revisionAlias,
		);
	});

	it("recovers a crash after terminal reservation before invalidation", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const { active, reservation } = await reserveInFlightCompletion(
			store,
			time.now(),
		);
		const invalidate = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: { has: async () => true, invalidate },
		});

		expect(reservation.nonce).toMatch(/^term_[a-f0-9]{32}$/);
		expect((await lifecycle.get(PLAN_ALIAS))?.revisions[0]).toMatchObject({
			revisionAlias: active.revisionAlias,
			state: "completed",
			restartRequired: false,
		});
		expect(invalidate).toHaveBeenCalledWith(
			PLAN_ALIAS,
			active.revisionAlias,
			"completion",
		);
		expect(
			(await lifecycle.resume(PLAN_ALIAS))?.canExecute,
		).toBe(false);
	});

	it("idempotently recovers a crash after invalidation before commit", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const { active } = await reserveInFlightCompletion(store, time.now());
		let executionPresent = false;
		const invalidate = mock(async () => {
			executionPresent = false;
		});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => executionPresent,
				invalidate,
			},
		});

		expect((await lifecycle.get(PLAN_ALIAS))?.revisions[0]?.state).toBe(
			"completed",
		);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(
			(await store.getRecord(PLAN_ALIAS, active.revisionAlias))
				?.terminalReservation,
		).toBeUndefined();
	});

	it("recovers a reservation after repository and service-worker recreation", async () => {
		const time = clock();
		const indexedDB = new IDBFactory();
		const databaseName = "mailbox-terminal-recovery-restart";
		const firstStore = createMailboxPlanStore({
			indexedDB,
			databaseName,
			now: time.now,
		});
		const { active, reservation } = await reserveInFlightCompletion(
			firstStore,
			time.now(),
		);
		await firstStore.close();

		const restartedStore = createMailboxPlanStore({
			indexedDB,
			databaseName,
			now: time.now,
		});
		expect(
			(
				await restartedStore.getRecord(
					PLAN_ALIAS,
					active.revisionAlias,
				)
			)?.terminalReservation?.nonce,
		).toBe(reservation.nonce);
		const invalidate = mock(async () => {});
		const restartedLifecycle = createMailboxLifecycle({
			store: restartedStore,
			now: time.now,
			execution: { has: async () => true, invalidate },
		});

		expect(
			(await restartedLifecycle.resume(PLAN_ALIAS))?.revision.state,
		).toBe("completed");
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("does not repeat terminal cleanup after successful reconciliation", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		await reserveInFlightCompletion(store, time.now());
		const invalidate = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: { has: async () => true, invalidate },
		});

		expect(await lifecycle.get(PLAN_ALIAS)).toBeDefined();
		expect(await lifecycle.get(PLAN_ALIAS)).toBeDefined();
		expect(await lifecycle.resume(PLAN_ALIAS)).toMatchObject({
			canExecute: false,
			revision: { state: "completed" },
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("converts a reserved transition to restart-required when cleanup fails", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const { active } = await reserveInFlightCompletion(store, time.now());
		const mark = mock(async () => {});
		const invalidate = mock(async () => {
			throw new Error("session unavailable");
		});
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: { has: async () => true, invalidate },
			restart: { mark },
		});

		expect((await lifecycle.get(PLAN_ALIAS))?.revisions[0]).toMatchObject({
			state: "in_flight",
			restartRequired: true,
		});
		const record = await store.getRecord(PLAN_ALIAS, active.revisionAlias);
		expect(record?.terminalReservation).toBeUndefined();
		expect(record?.revision.restartRequired).toBe(true);
		expect((await lifecycle.resume(PLAN_ALIAS))?.canExecute).toBe(false);
		expect(mark).toHaveBeenCalledWith(
			PLAN_ALIAS,
			active.revisionAlias,
			"storage_failure",
		);
	});

	it("migrates v3 terminal records to pending cleanup and deletes live bindings", async () => {
		const time = clock();
		const indexedDB = new IDBFactory();
		const databaseName = "mailbox-v3-terminal-cleanup";
		const terminal = revision("completed");
		await seedV3TerminalDatabase(
			indexedDB,
			databaseName,
			terminal,
			time.now() + 7 * DAY,
		);
		const values = new Map<string, unknown>();
		const bindings = createRawBindingStore({
			session: {
				get: async (key) => values.get(key),
				set: async (key, value) => void values.set(key, value),
				delete: async (key) => void values.delete(key),
			},
			now: time.now,
		});
		const scope = {
			planAlias: PLAN_ALIAS,
			providerId: "fake-mail",
			surface: "inbox",
			accountAlias: opaqueAlias("acct", 40),
			runAlias: opaqueAlias("run", 41),
			revisionAlias: terminal.revisionAlias,
		};
		await bindings.put(scope, {
			[opaqueAlias("msg", 42)]: "provider-message-v3",
		});
		const store = createMailboxPlanStore({
			indexedDB,
			databaseName,
			now: time.now,
		});
		expect(
			(await store.getRecord(PLAN_ALIAS, terminal.revisionAlias))
				?.terminalCleanupPending,
		).toBe(true);
		const lifecycle = createMailboxLifecycle({
			store,
			now: time.now,
			execution: {
				has: async () => true,
				invalidate: async (_plan, _revision, reason) => {
					return bindings.invalidateRevision(
						scope.planAlias,
						scope.revisionAlias,
						reason,
					);
				},
			},
		});
		expect(await lifecycle.get(PLAN_ALIAS)).toBeDefined();
		expect(await bindings.get(scope)).toBeUndefined();
		expect(
			(await store.getRecord(PLAN_ALIAS, terminal.revisionAlias))
				?.terminalCleanupPending,
		).toBeUndefined();
	});

	it("clears persisted terminal cleanup after browser session storage resets", async () => {
		const time = clock();
		const indexedDB = new IDBFactory();
		const databaseName = "mailbox-session-reset-cleanup";
		const terminal = revision("completed");
		const expiry = time.now() + 7 * DAY;
		const initialStore = createMailboxPlanStore({
			indexedDB,
			databaseName,
			now: time.now,
		});
		await initialStore.putRevision(terminal, { expiresAt: expiry });
		await initialStore.markTerminalCleanupPending(
			PLAN_ALIAS,
			terminal.revisionAlias,
		);
		const priorSession = new Map<string, unknown>();
		const priorBindings = createRawBindingStore({
			session: {
				get: async (key) => priorSession.get(key),
				set: async (key, value) => void priorSession.set(key, value),
				delete: async (key) => void priorSession.delete(key),
			},
			now: time.now,
		});
		await priorBindings.put(
			{
				planAlias: PLAN_ALIAS,
				providerId: "fake-mail",
				surface: "inbox",
				accountAlias: opaqueAlias("acct", 43),
				runAlias: opaqueAlias("run", 44),
				revisionAlias: terminal.revisionAlias,
			},
			{ [opaqueAlias("msg", 45)]: "provider-message-before-restart" },
		);
		await initialStore.close();

		const restartedStore = createMailboxPlanStore({
			indexedDB,
			databaseName,
			now: time.now,
		});
		const freshSession = new Map<string, unknown>();
		const restartedBindings = createRawBindingStore({
			session: {
				get: async (key) => freshSession.get(key),
				set: async (key, value) => void freshSession.set(key, value),
				delete: async (key) => void freshSession.delete(key),
			},
			now: time.now,
		});
		const invalidate = mock(
			async (
				planAlias: string,
				revisionAlias: string,
				reason: RawBindingInvalidationReason,
			) =>
				restartedBindings.invalidateRevision(
					planAlias,
					revisionAlias,
					reason,
				),
		);
		const schedule = mock(async () => {});
		const restartedLifecycle = createMailboxLifecycle({
			store: restartedStore,
			now: time.now,
			alarms: { schedule, cancel: async () => {} },
			execution: { has: async () => true, invalidate },
		});

		expect(await restartedLifecycle.get(PLAN_ALIAS)).toMatchObject({
			revisions: [{ revisionAlias: terminal.revisionAlias }],
		});
		expect(
			(
				await restartedStore.getRecord(
					PLAN_ALIAS,
					terminal.revisionAlias,
				)
			)?.terminalCleanupPending,
		).toBeUndefined();
		expect(await restartedLifecycle.reconcile(PLAN_ALIAS)).toMatchObject({
			revisions: [{ revisionAlias: terminal.revisionAlias }],
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(schedule).toHaveBeenCalledTimes(2);
		expect(schedule).toHaveBeenLastCalledWith(PLAN_ALIAS, expiry);
	});

	it("blocks get and list when execution.has crosses expiry", async () => {
		for (const operation of ["get", "list"] as const) {
			const time = clock();
			const store = createMailboxPlanStore({
				indexedDB: new IDBFactory(),
				now: time.now,
			});
			const active = revision("approved");
			const expiry = time.now() + 7 * DAY;
			await store.putRevision(active, { expiresAt: expiry });
			const lifecycle = createMailboxLifecycle({
				store,
				now: time.now,
				execution: {
					has: async () => {
						time.set(expiry);
						return true;
					},
					invalidate: async () => {},
				},
			});
			expect(
				operation === "get"
					? await lifecycle.get(PLAN_ALIAS)
					: await lifecycle.list(),
			).toEqual(operation === "get" ? undefined : []);
		}
	});

	it("blocks resume when fingerprint or final-read seams cross expiry", async () => {
		for (const boundary of ["fingerprint", "final_read"] as const) {
			const time = clock();
			const store = createMailboxPlanStore({
				indexedDB: new IDBFactory(),
				now: time.now,
			});
			const active = revision("approved");
			const expiry = time.now() + 7 * DAY;
			await store.putRevision(active, { expiresAt: expiry });
			const lifecycle = createMailboxLifecycle({
				store:
					boundary === "final_read"
						? {
								...store,
								async getRecord(planAlias, revisionAlias) {
									const record = await store.getRecord(
										planAlias,
										revisionAlias,
									);
									time.set(expiry);
									return record;
								},
							}
						: store,
				now: time.now,
				execution: { has: async () => true, invalidate: async () => {} },
				fingerprints: {
					matches: async () => {
						if (boundary === "fingerprint") time.set(expiry);
						return true;
					},
				},
			});
			expect(
				await lifecycle.resume(PLAN_ALIAS, active.inventoryFingerprint),
			).toBeUndefined();
		}
	});

	it("preserves terminal visibility and alarms across concurrent marker clears", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const terminal = revision("completed");
		const values = new Map<string, unknown>();
		const bindings = createRawBindingStore({
			session: {
				get: async (key) => values.get(key),
				set: async (key, value) => void values.set(key, value),
				delete: async (key) => void values.delete(key),
			},
			now: time.now,
		});
		const scope = {
			planAlias: PLAN_ALIAS,
			providerId: "fake-mail",
			surface: "inbox",
			accountAlias: opaqueAlias("acct", 60),
			runAlias: opaqueAlias("run", 61),
			revisionAlias: terminal.revisionAlias,
		};
		await bindings.put(scope, {
			[opaqueAlias("msg", 62)]: "provider-message-clear-race",
		});
		const expiry = time.now() + 7 * DAY;
		await store.putRevision(terminal, { expiresAt: expiry });
		await store.markTerminalCleanupPending(
			PLAN_ALIAS,
			terminal.revisionAlias,
		);
		const schedule = mock(async () => {});
		const reconciler = () =>
			createMailboxLifecycle({
				store,
					now: time.now,
					alarms: { schedule, cancel: async () => {} },
					execution: {
						has: async () => true,
						invalidate: async () =>
							bindings.invalidateRevision(
								scope.planAlias,
								scope.revisionAlias,
								"completion",
							),
					},
				});
		const results = await Promise.all([
			reconciler().get(PLAN_ALIAS),
			reconciler().get(PLAN_ALIAS),
		]);
		expect(results).toMatchObject([
			{ revisions: [{ state: "completed" }] },
			{ revisions: [{ state: "completed" }] },
		]);
		expect(schedule).toHaveBeenLastCalledWith(PLAN_ALIAS, expiry);
	});

	it("deletes records expiring during later awaits and retains retry alarms", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const first = revision("approved");
		const second = revision("approved", 2);
		const firstExpiry = time.now() + 1;
		await store.putRevision(first, { expiresAt: firstExpiry });
		await store.putRevision(second, { expiresAt: time.now() + 7 * DAY });
		let hasCalls = 0;
		const schedule = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				async deleteRevision(planAlias, revisionAlias) {
					if (revisionAlias === first.revisionAlias) {
						throw new Error("cleanup unavailable");
					}
					await store.deleteRevision(planAlias, revisionAlias);
				},
			},
			now: time.now,
			alarms: { schedule, cancel: async () => {} },
			execution: {
				has: async () => {
					hasCalls += 1;
					if (hasCalls === 2) time.set(firstExpiry);
					return true;
				},
				invalidate: async () => {},
			},
		});
		expect(await lifecycle.get(PLAN_ALIAS)).toMatchObject({
			revisions: [{ revisionAlias: second.revisionAlias }],
		});
		expect(
			await store.getRecord(PLAN_ALIAS, first.revisionAlias),
		).toBeDefined();
		expect(schedule).toHaveBeenLastCalledWith(PLAN_ALIAS, time.now());
	});

	it("deletes when cleanup clear or restart CAS crosses expiry", async () => {
		for (const boundary of ["cleanup_clear", "restart_cas"] as const) {
			const time = clock();
			const store = createMailboxPlanStore({
				indexedDB: new IDBFactory(),
				now: time.now,
			});
			const current = revision(
				boundary === "cleanup_clear" ? "completed" : "approved",
			);
			const expiry = time.now() + 1;
			await store.putRevision(current, { expiresAt: expiry });
			const values = new Map<string, unknown>();
			const bindings = createRawBindingStore({
				session: {
					get: async (key) => values.get(key),
					set: async (key, value) => void values.set(key, value),
					delete: async (key) => void values.delete(key),
				},
				now: time.now,
			});
			const scope = {
				planAlias: PLAN_ALIAS,
				providerId: "fake-mail",
				surface: "inbox",
				accountAlias: opaqueAlias("acct", 70),
				runAlias: opaqueAlias("run", 71),
				revisionAlias: current.revisionAlias,
			};
			await bindings.put(scope, {
				[opaqueAlias("msg", 72)]: "provider-message-boundary",
			});
			if (boundary === "cleanup_clear") {
				await store.markTerminalCleanupPending(
					PLAN_ALIAS,
					current.revisionAlias,
				);
			}
			const lifecycle = createMailboxLifecycle({
				store,
				now: time.now,
				execution: {
					has: async () => boundary === "cleanup_clear",
					invalidate: async (_plan, _revision, reason) => {
						const proof = await bindings.invalidateRevision(
							scope.planAlias,
							scope.revisionAlias,
							reason,
						);
						time.set(expiry);
						return proof;
					},
				},
			});
			expect(await lifecycle.get(PLAN_ALIAS)).toBeUndefined();
			expect(
				await store.getRecord(PLAN_ALIAS, current.revisionAlias),
			).toBeUndefined();
		}
	});

	it("re-arms immediately when the final resume read gains a cleanup marker", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const terminal = revision("completed");
		await store.putRevision(terminal, { expiresAt: time.now() + 7 * DAY });
		let injected = false;
		const schedule = mock(async () => {});
		const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				async getRecord(planAlias, revisionAlias) {
					if (!injected) {
						injected = true;
						await store.markTerminalCleanupPending(
							planAlias,
							revisionAlias,
						);
					}
					return store.getRecord(planAlias, revisionAlias);
				},
			},
			now: time.now,
			alarms: { schedule, cancel: async () => {} },
			execution: { has: async () => true, invalidate: async () => {} },
		});
		expect(await lifecycle.resume(PLAN_ALIAS)).toBeDefined();
		expect(schedule).toHaveBeenLastCalledWith(PLAN_ALIAS, time.now());
	});

	it("blocks get and list when alarm scheduling crosses expiry", async () => {
		for (const operation of ["get", "list"] as const) {
			const time = clock();
			const store = createMailboxPlanStore({
				indexedDB: new IDBFactory(),
				now: time.now,
			});
			const active = revision("approved");
			const expiry = time.now() + 1;
			await store.putRevision(active, { expiresAt: expiry });
			const lifecycle = createMailboxLifecycle({
				store,
				now: time.now,
				alarms: {
					schedule: async () => {
						time.set(expiry);
					},
					cancel: async () => {},
				},
				execution: { has: async () => true, invalidate: async () => {} },
			});
			expect(
				operation === "get"
					? await lifecycle.get(PLAN_ALIAS)
					: await lifecycle.list(),
			).toEqual(operation === "get" ? undefined : []);
			expect(
				await store.getRecord(PLAN_ALIAS, active.revisionAlias),
			).toBeUndefined();
		}
	});

	it("blocks resume when marker alarm re-arm crosses expiry", async () => {
		const time = clock();
		const store = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const terminal = revision("completed");
		const expiry = time.now() + 1;
		await store.putRevision(terminal, { expiresAt: expiry });
		let injected = false;
		let schedules = 0;
		const lifecycle = createMailboxLifecycle({
			store: {
				...store,
				async getRecord(planAlias, revisionAlias) {
					if (!injected) {
						injected = true;
						await store.markTerminalCleanupPending(
							planAlias,
							revisionAlias,
						);
					}
					return store.getRecord(planAlias, revisionAlias);
				},
			},
			now: time.now,
			alarms: {
				schedule: async () => {
					schedules += 1;
					if (schedules === 2) time.set(expiry);
				},
				cancel: async () => {},
			},
			execution: { has: async () => true, invalidate: async () => {} },
		});
		expect(await lifecycle.resume(PLAN_ALIAS)).toBeUndefined();
		expect(
			await store.getRecord(PLAN_ALIAS, terminal.revisionAlias),
		).toBeUndefined();
	});
});
