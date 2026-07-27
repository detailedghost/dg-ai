import { describe, expect, it, mock } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
	createMailboxPlanStore,
	createRawBindingStore,
} from "../index";

class MemorySessionStorage {
	readonly values = new Map<string, unknown>();

	async get(key: string) {
		return this.values.get(key);
	}

	async set(key: string, value: unknown) {
		this.values.set(key, value);
	}

	async delete(key: string) {
		this.values.delete(key);
	}
}

function clock(at = Date.UTC(2026, 6, 27, 12)) {
	let current = at;
	return {
		now: () => current,
		advance(milliseconds: number) {
			current += milliseconds;
		},
	};
}

function opaqueAlias(prefix: string, seed: number): string {
	const bytes = Uint8Array.from(
		{ length: 16 },
		(_, index) => (seed * 17 + index * 13) % 256,
	);
	return `${prefix}_${[...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

const scope = {
	planAlias: opaqueAlias("plan", 1),
	providerId: "fake-mail",
	surface: "inbox",
	accountAlias: opaqueAlias("acct", 2),
	runAlias: opaqueAlias("run", 3),
	revisionAlias: opaqueAlias("rev", 4),
};

function revision() {
	return {
		schemaVersion: 1 as const,
		planAlias: scope.planAlias,
		revisionAlias: scope.revisionAlias,
		revisionNumber: 1,
		state: "draft" as const,
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

async function openDatabase(factory: IDBFactory, name: string) {
	return await new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function damageFirstRevision(
	factory: IDBFactory,
	name: string,
	mode: "corrupt" | "partial",
) {
	const database = await openDatabase(factory, name);
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction("revisions", "readwrite");
		const store = transaction.objectStore("revisions");
		const request = store.getAll();
		request.onsuccess = () => {
			const record = request.result[0] as Record<string, unknown>;
			if (typeof record.key !== "string") {
				throw new TypeError("revision record is missing its key");
			}
			if (mode === "partial") store.delete(record.key);
			else store.put({ ...record, unexpected: true });
		};
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
	});
	database.close();
}

async function addIllegalTerminalReservation(
	factory: IDBFactory,
	name: string,
) {
	const database = await openDatabase(factory, name);
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction("revisions", "readwrite");
		const store = transaction.objectStore("revisions");
		const request = store.getAll();
		request.onsuccess = () => {
			const record = request.result[0] as Record<string, unknown>;
			if (typeof record.key !== "string") {
				throw new TypeError("revision record is missing its key");
			}
			store.put({
				...record,
				terminalReservation: {
					schemaVersion: 1,
					nonce: `term_${"0".repeat(32)}`,
					expectedState: "draft",
					nextState: "completed",
					targetExpiresAt: Date.UTC(2026, 7, 3, 12),
				},
			});
		};
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
	});
	database.close();
}

async function seedLegacyDatabase(
	factory: IDBFactory,
	name: string,
	extraStore = false,
) {
	await new Promise<void>((resolve, reject) => {
		const request = factory.open(name, 1);
		request.onupgradeneeded = () => {
			const plans = request.result.createObjectStore("plans", {
				keyPath: "planAlias",
			});
			const revisions = request.result.createObjectStore("revisions", {
				keyPath: "key",
			});
			if (extraStore) request.result.createObjectStore("raw-bindings");
			plans.add({
				schemaVersion: 1,
				planAlias: scope.planAlias,
				revisionAliases: [scope.revisionAlias],
			});
			revisions.add({
				schemaVersion: 1,
				key: `${scope.planAlias.length}:${scope.planAlias}|${scope.revisionAlias.length}:${scope.revisionAlias}`,
				planAlias: scope.planAlias,
				revisionAlias: scope.revisionAlias,
				revision: revision(),
				expiresAt: Number.MAX_SAFE_INTEGER,
			});
		};
		request.onsuccess = () => {
			request.result.close();
			resolve();
		};
		request.onerror = () => reject(request.error);
	});
}

describe("mailbox storage", () => {
	it("keeps raw bindings in session storage and persists only validated immutable revisions", async () => {
		const session = new MemorySessionStorage();
		const plans = createMailboxPlanStore({ indexedDB: new IDBFactory() });
		const bindings = createRawBindingStore({
			session,
			now: () => Date.UTC(2026, 6, 27, 12),
		});
		const rawSentinel = "provider-message-SENSITIVE";

		await plans.putRevision(revision());
		await bindings.put(scope, { [opaqueAlias("msg", 5)]: rawSentinel });

		const storedRevision = await plans.getRevision(
			scope.planAlias,
			scope.revisionAlias,
		);
		expect(storedRevision).toEqual(revision());
		expect(Object.isFrozen(storedRevision)).toBe(true);
		expect(JSON.stringify(storedRevision)).not.toContain(rawSentinel);
		expect(JSON.stringify([...session.values.values()])).toContain(rawSentinel);
		await expect(
			plans.putRevision({
				...revision(),
				rawBindings: { [opaqueAlias("msg", 5)]: rawSentinel },
			}),
		).rejects.toThrow();
	});

	it("rejects CAS attempts that alter immutable revision fields", async () => {
		const time = clock();
		const plans = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const expiresAt = Date.UTC(2026, 7, 27, 12);
		await plans.putRevision(revision(), { expiresAt });

		await expect(
			plans.compareAndSetRevision(
				scope.planAlias,
				scope.revisionAlias,
				"draft",
				{
					...revision(),
					restartRequired: true,
					createdAt: "2026-07-28T12:00:00.000Z",
				},
				expiresAt,
			),
		).rejects.toThrow(/compare/i);
	});

	it("rejects corrupt and committed illegal terminal reservations", async () => {
		const time = clock();
		const indexedDB = new IDBFactory();
		const databaseName = "mailbox-illegal-terminal-reservation";
		const plans = createMailboxPlanStore({
			indexedDB,
			databaseName,
			now: time.now,
		});
		const expiresAt = time.now() + 30 * 24 * 60 * 60 * 1_000;
		await plans.putRevision(revision(), { expiresAt });
		await addIllegalTerminalReservation(indexedDB, databaseName);

		await expect(
			plans.getRecord(scope.planAlias, scope.revisionAlias),
		).rejects.toThrow(/corrupt/i);

		const commitStore = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		await commitStore.putRevision(revision(), { expiresAt });
		const reservation = await commitStore.reserveTerminalTransition(
			scope.planAlias,
			scope.revisionAlias,
			"draft",
			"canceled",
			time.now() + 7 * 24 * 60 * 60 * 1_000,
		);
		await expect(
			commitStore.commitTerminalTransition(
				scope.planAlias,
				scope.revisionAlias,
				"draft",
				reservation.nonce,
				{ ...revision(), state: "completed" },
			),
		).rejects.toThrow(/compare/i);
	});

	it("does not fail a terminal reservation after its logical expiry", async () => {
		const time = clock();
		const plans = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const day = 24 * 60 * 60 * 1_000;
		await plans.putRevision(revision(), {
			expiresAt: time.now() + 30 * day,
		});
		const reservation = await plans.reserveTerminalTransition(
			scope.planAlias,
			scope.revisionAlias,
			"draft",
			"canceled",
			time.now() + 7 * day,
		);
		time.advance(7 * day);

		await expect(
			plans.failTerminalReservation(
				scope.planAlias,
				scope.revisionAlias,
				reservation.nonce,
			),
		).rejects.toThrow(/compare/i);
		expect(
			(await plans.getRecord(scope.planAlias, scope.revisionAlias))
				?.terminalReservation?.nonce,
		).toBe(reservation.nonce);
	});

	it("rejects forged and replayed terminal cleanup receipts", async () => {
		const time = clock();
		const session = new MemorySessionStorage();
		const bindings = createRawBindingStore({
			session,
			now: time.now,
		});
		const plans = createMailboxPlanStore({
			indexedDB: new IDBFactory(),
			now: time.now,
		});
		const terminal = { ...revision(), state: "canceled" as const };
		await plans.putRevision(terminal, {
			expiresAt: time.now() + 7 * 24 * 60 * 60 * 1_000,
		});
		await plans.markTerminalCleanupPending(
			scope.planAlias,
			scope.revisionAlias,
		);
		await expect(
			plans.clearTerminalCleanupPending(
				scope.planAlias,
				scope.revisionAlias,
				{
					planAlias: scope.planAlias,
					revisionAlias: scope.revisionAlias,
				},
			),
		).rejects.toThrow(/compare/i);
		const otherScope = {
			...scope,
			revisionAlias: opaqueAlias("rev", 50),
		};
		await bindings.put(otherScope, {
			[opaqueAlias("msg", 51)]: "provider-message-other",
		});
		const crossScopedProof = await bindings.invalidateRevision(
			otherScope.planAlias,
			otherScope.revisionAlias,
			"completion",
		);
		await expect(
			plans.clearTerminalCleanupPending(
				scope.planAlias,
				scope.revisionAlias,
				crossScopedProof,
			),
		).rejects.toThrow(/compare/i);
		await bindings.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-42",
		});
		const disposableScope = {
			...scope,
			providerId: "other-mail",
			surface: "archive",
			accountAlias: opaqueAlias("acct", 52),
			runAlias: opaqueAlias("run", 53),
		};
		await bindings.put(disposableScope, {
			[opaqueAlias("msg", 54)]: "provider-message-disposable",
		});
		await bindings.invalidate(disposableScope, "completion");
		expect(await bindings.get(scope)).toBeDefined();
		const receipt = await bindings.invalidateRevision(
			scope.planAlias,
			scope.revisionAlias,
			"completion",
		);
		expect(await bindings.get(scope)).toBeUndefined();
		expect(await bindings.get(disposableScope)).toBeUndefined();
		await plans.clearTerminalCleanupPending(
			scope.planAlias,
			scope.revisionAlias,
			receipt,
		);
		await plans.markTerminalCleanupPending(
			scope.planAlias,
			scope.revisionAlias,
		);
		await expect(
			plans.clearTerminalCleanupPending(
				scope.planAlias,
				scope.revisionAlias,
				receipt,
			),
		).rejects.toThrow(/compare/i);
	});

	it("expires bindings exactly at one hour and renews only active decisions or execution checkpoints", async () => {
		const time = clock();
		const session = new MemorySessionStorage();
		const bindings = createRawBindingStore({ session, now: time.now });

		await bindings.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-42",
		});
		for (const event of [
			"passive_read",
			"page_open",
			"list",
			"poll",
			"alarm",
			"progress",
			"worker_wake",
		] as const) {
			time.advance(1);
			await bindings.touch(scope, event);
		}
		time.advance(60 * 60 * 1_000 - 7);
		expect(await bindings.get(scope)).toBeUndefined();

		for (const event of ["user_decision", "execution_checkpoint"] as const) {
			const renewedClock = clock();
			const renewed = createRawBindingStore({
				session: new MemorySessionStorage(),
				now: renewedClock.now,
			});
			await renewed.put(scope, {
				[opaqueAlias("msg", 5)]: "provider-message-42",
			});
			renewedClock.advance(30 * 60 * 1_000);
			await renewed.touch(scope, event);
			renewedClock.advance(60 * 60 * 1_000 - 1);
			expect(await renewed.get(scope)).toBeDefined();
			renewedClock.advance(1);
			expect(await renewed.get(scope)).toBeUndefined();
			}
		});

	it("reports exact passive binding status without renewing and exposes allowed renewal expiry", async () => {
		const hour = 60 * 60 * 1_000;
		const rawSentinel = "provider-message-status-sensitive";
		const passiveTime = clock();
		const passive = createRawBindingStore({
			session: new MemorySessionStorage(),
			now: passiveTime.now,
		});
		await passive.put(scope, {
			[opaqueAlias("msg", 5)]: rawSentinel,
		});
		const originalExpiry = passiveTime.now() + hour;

		expect(await passive.status(scope)).toEqual({
			available: true,
			expiresAt: originalExpiry,
		});
		passiveTime.advance(hour / 2);
		const passiveStatus = await passive.status(scope);
		expect(passiveStatus).toEqual({
			available: true,
			expiresAt: originalExpiry,
		});
		expect(Object.isFrozen(passiveStatus)).toBe(true);
		expect(Object.keys(passiveStatus).sort()).toEqual([
			"available",
			"expiresAt",
		]);
		expect(JSON.stringify(passiveStatus)).not.toContain(rawSentinel);
		passiveTime.advance(hour / 2);
		const expiredStatus = await passive.status(scope);
		expect(expiredStatus).toEqual({
			available: false,
			reason: "expired",
		});
		expect(Object.isFrozen(expiredStatus)).toBe(true);
		expect(Object.keys(expiredStatus).sort()).toEqual(["available", "reason"]);
		await expect(
			passive.status({ ...scope, unexpected: true } as never),
		).rejects.toThrow();

		const renewedTime = clock();
		const renewed = createRawBindingStore({
			session: new MemorySessionStorage(),
			now: renewedTime.now,
		});
		await renewed.put(scope, {
			[opaqueAlias("msg", 5)]: rawSentinel,
		});
		renewedTime.advance(hour / 2);
		expect(await renewed.touch(scope, "user_decision")).toBe(true);
		const renewedExpiry = renewedTime.now() + hour;
		expect(await renewed.status(scope)).toEqual({
			available: true,
			expiresAt: renewedExpiry,
		});
		renewedTime.advance(hour);
		expect(await renewed.status(scope)).toEqual({
			available: false,
			reason: "expired",
		});
	});

	it("fails binding status closed for reset, tombstone, corruption, and storage failure", async () => {
		const time = clock();
		const resetSession = new MemorySessionStorage();
		const resetStore = createRawBindingStore({
			session: resetSession,
			now: time.now,
		});
		await resetStore.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-reset",
		});
		resetSession.values.clear();
		expect(await resetStore.status(scope)).toEqual({
			available: false,
			reason: "missing",
		});

		const invalidatedSession = new MemorySessionStorage();
		const invalidated = createRawBindingStore({
			session: invalidatedSession,
			now: time.now,
		});
		await invalidated.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-invalidated",
		});
		await invalidated.invalidateRevision(
			scope.planAlias,
			scope.revisionAlias,
			"restart_required",
		);
		expect(await invalidated.status(scope)).toEqual({
			available: false,
			reason: "invalidated",
		});

		const corruptSession = new MemorySessionStorage();
		const corrupt = createRawBindingStore({
			session: corruptSession,
			now: time.now,
		});
		await corrupt.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-corrupt",
		});
		const activeEntry = [...corruptSession.values.entries()].find(
			([key, value]) =>
				!key.endsWith(":index") &&
				!key.endsWith(":tombstone") &&
				value !== null &&
				typeof value === "object" &&
				Object.hasOwn(value, "bindings"),
		);
		if (activeEntry === undefined) {
			throw new TypeError("active raw-binding record was not persisted");
		}
		await corruptSession.set(activeEntry[0], {
			...(activeEntry[1] as Record<string, unknown>),
			unexpected: true,
		});
		expect(await corrupt.status(scope)).toEqual({
			available: false,
			reason: "corrupt",
		});
		expect(await corrupt.status(scope)).toEqual({
			available: false,
			reason: "invalidated",
		});

		const failed = createRawBindingStore({
			session: {
				async get() {
					throw new Error("session unavailable");
				},
				async set() {
					throw new Error("session unavailable");
				},
				async delete() {
					throw new Error("session unavailable");
				},
			},
			now: time.now,
		});
		expect(await failed.status(scope)).toEqual({
			available: false,
			reason: "storage_failure",
		});
	});

	it("keeps passive status ordered behind concurrent writes across distinct session wrappers", async () => {
		for (const operation of ["put", "touch", "invalidate"] as const) {
			const time = clock();
			const backing = new MemorySessionStorage();
			let blockWrite = false;
			let releaseWrite = () => {};
			let reportBlocked = () => {};
			const blocked = new Promise<void>((resolve) => {
				reportBlocked = resolve;
			});
			const released = new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			const sessionWrapper = () => ({
				get: (key: string) => backing.get(key),
				delete: (key: string) => backing.delete(key),
				async set(key: string, value: unknown) {
					if (blockWrite) {
						blockWrite = false;
						reportBlocked();
						await released;
					}
					await backing.set(key, value);
				},
			});
			const writer = createRawBindingStore({
				session: sessionWrapper(),
				now: time.now,
			});
			const observer = createRawBindingStore({
				session: sessionWrapper(),
				now: time.now,
			});
			if (operation !== "put") {
				await writer.put(scope, {
					[opaqueAlias("msg", 5)]: "provider-message-existing",
				});
			}
			if (operation === "touch") time.advance(15 * 60 * 1_000);
			blockWrite = true;
			const writing =
				operation === "put"
					? writer.put(scope, {
							[opaqueAlias("msg", 5)]: "provider-message-new",
						})
					: operation === "touch"
						? writer.touch(scope, "user_decision")
						: writer.invalidate(scope, "restart_required");
			await blocked;
			const inspecting = observer.status(scope);
			for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
			releaseWrite();
			await writing;

			expect(await inspecting).toEqual(
				operation === "invalidate"
					? { available: false, reason: "invalidated" }
					: {
							available: true,
							expiresAt: time.now() + 60 * 60 * 1_000,
						},
			);
		}
	});

	it("does not renew an existing binding TTL when bindings are replaced", async () => {
		const time = clock();
		const bindings = createRawBindingStore({
			session: new MemorySessionStorage(),
			now: time.now,
		});
		await bindings.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-1",
		});
		time.advance(30 * 60 * 1_000);
		await bindings.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-2",
		});
		time.advance(30 * 60 * 1_000);

		expect(await bindings.get(scope)).toBeUndefined();
	});

	it("keeps session state authoritative when binding alarms reject", async () => {
		const time = clock();
		const schedule = mock(async () => {
			throw new Error("alarm unavailable");
		});
		const cancel = mock(async () => {
			throw new Error("alarm unavailable");
		});
		const bindings = createRawBindingStore({
			session: new MemorySessionStorage(),
			now: time.now,
			alarms: { schedule, cancel },
		});
		const values = {
			[opaqueAlias("msg", 5)]: "provider-message-42",
		};

		await expect(bindings.put(scope, values)).resolves.toBeUndefined();
		expect(await bindings.get(scope)).toEqual(values);
		expect(await bindings.status(scope)).toEqual({
			available: true,
			expiresAt: time.now() + 60 * 60 * 1_000,
		});
		await expect(
			bindings.touch(scope, "user_decision"),
		).resolves.toBe(true);
		time.advance(60 * 60 * 1_000);
		expect(await bindings.status(scope)).toEqual({
			available: false,
			reason: "expired",
		});
		expect(schedule).toHaveBeenCalledTimes(2);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("serializes touch and invalidation across store instances", async () => {
		const backing = new MemorySessionStorage();
		let blockActiveWrite = false;
		let releaseWrite = () => {};
		let reportBlocked = () => {};
		const blocked = new Promise<void>((resolve) => {
			reportBlocked = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const session = {
			get: (key: string) => backing.get(key),
			delete: (key: string) => backing.delete(key),
			async set(key: string, value: unknown) {
				if (blockActiveWrite && !key.endsWith(":tombstone")) {
					reportBlocked();
					await released;
				}
				await backing.set(key, value);
			},
		};
		const firstWorker = createRawBindingStore({
			session,
			now: () => Date.UTC(2026, 6, 27, 12),
		});
		const secondWorker = createRawBindingStore({
			session,
			now: () => Date.UTC(2026, 6, 27, 12),
		});
		await firstWorker.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-1",
		});
		blockActiveWrite = true;
		const touching = firstWorker.touch(scope, "execution_checkpoint");
		await blocked;
		const invalidating = secondWorker.invalidate(scope, "cancellation");
		releaseWrite();

		await Promise.all([touching, invalidating]);
		expect(await firstWorker.get(scope)).toBeUndefined();
	});

	it("serializes concurrent multi-scope puts across distinct session wrappers", async () => {
		const backing = new MemorySessionStorage();
		let firstIndexWrite = true;
		let releaseWrite = () => {};
		let reportBlocked = () => {};
		const blocked = new Promise<void>((resolve) => {
			reportBlocked = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const sessionWrapper = () => ({
			get: (key: string) => backing.get(key),
			delete: (key: string) => backing.delete(key),
			async set(key: string, value: unknown) {
				if (key.endsWith(":index") && firstIndexWrite) {
					firstIndexWrite = false;
					reportBlocked();
					await released;
				}
				await backing.set(key, value);
			},
		});
		const firstWorker = createRawBindingStore({
			session: sessionWrapper(),
			now: () => Date.UTC(2026, 6, 27, 12),
		});
		const secondWorker = createRawBindingStore({
			session: sessionWrapper(),
			now: () => Date.UTC(2026, 6, 27, 12),
		});
		const firstScope = { ...scope, surface: "primary" };
		const secondScope = { ...scope, surface: "archive" };

		const firstPut = firstWorker.put(firstScope, {
			[opaqueAlias("msg", 5)]: "provider-message-1",
		});
		await blocked;
		const secondPut = secondWorker.put(secondScope, {
			[opaqueAlias("msg", 6)]: "provider-message-2",
		});
		for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
		releaseWrite();
		await Promise.all([firstPut, secondPut]);
		expect(await firstWorker.get(firstScope)).toBeDefined();
		expect(await secondWorker.get(secondScope)).toBeDefined();

		await firstWorker.invalidateRevision(
			scope.planAlias,
			scope.revisionAlias,
			"completion",
		);
		expect(await firstWorker.get(firstScope)).toBeUndefined();
		expect(await secondWorker.get(secondScope)).toBeUndefined();
	});

	it("does not let a concurrent put survive cross-instance revision invalidation", async () => {
		const backing = new MemorySessionStorage();
		let releaseWrite = () => {};
		let reportBlocked = () => {};
		const blocked = new Promise<void>((resolve) => {
			reportBlocked = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const sessionWrapper = () => ({
			get: (key: string) => backing.get(key),
			delete: (key: string) => backing.delete(key),
			async set(key: string, value: unknown) {
				if (!key.endsWith(":tombstone")) {
					reportBlocked();
					await released;
				}
				await backing.set(key, value);
			},
		});
		const firstWorker = createRawBindingStore({
			session: sessionWrapper(),
			now: () => Date.UTC(2026, 6, 27, 12),
		});
		const secondWorker = createRawBindingStore({
			session: sessionWrapper(),
			now: () => Date.UTC(2026, 6, 27, 12),
		});

		const putting = firstWorker.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-1",
		});
		await blocked;
		const invalidating = secondWorker.invalidateRevision(
			scope.planAlias,
			scope.revisionAlias,
			"cancellation",
		);
		releaseWrite();
		await Promise.all([putting, invalidating]);

		expect(await firstWorker.get(scope)).toBeUndefined();
		await expect(
			secondWorker.put(
				{
					...scope,
					providerId: "other-mail",
					surface: "archive",
				},
				{
					[opaqueAlias("msg", 5)]: "provider-message-2",
				},
			),
		).rejects.toThrow();
	});

	it("rolls back put and touch writes when a revision tombstone arrives late", async () => {
		for (const operation of ["put", "touch"] as const) {
			const backing = new MemorySessionStorage();
			let injectTombstone = false;
			let revisionTombstoneKey: string | undefined;
			const bindings = createRawBindingStore({
				session: {
					get: (key) => backing.get(key),
					delete: (key) => backing.delete(key),
					async set(key, value) {
						await backing.set(key, value);
						if (key.endsWith(":index")) {
							revisionTombstoneKey = `${key.slice(0, -":index".length)}:tombstone`;
						} else if (
							injectTombstone &&
							!key.endsWith(":tombstone") &&
							revisionTombstoneKey !== undefined
						) {
							await backing.set(revisionTombstoneKey, {});
						}
					},
				},
				now: () => Date.UTC(2026, 6, 27, 12),
			});
			const values = {
				[opaqueAlias("msg", 5)]: "provider-message-late",
			};
			if (operation === "touch") await bindings.put(scope, values);
			injectTombstone = true;

			if (operation === "put") {
				await expect(bindings.put(scope, values)).rejects.toThrow();
			} else {
				expect(
					await bindings.touch(scope, "execution_checkpoint"),
				).toBe(false);
			}
			expect(await bindings.get(scope)).toBeUndefined();
		}
	});

	it("rejects a 10,001st revision scope without poisoning aggregate cleanup", async () => {
		const session = new MemorySessionStorage();
		const bindings = createRawBindingStore({
			session,
			now: () => Date.UTC(2026, 6, 27, 12),
		});
		await bindings.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-boundary",
		});
		const indexEntry = [...session.values.entries()].find(([key]) =>
			key.endsWith(":index"),
		);
		if (indexEntry === undefined) {
			throw new TypeError("revision index was not persisted");
		}
		const indexedScopes = Array.from(
			{ length: 10_000 },
			(_, index) =>
				index === 0
					? scope
					: { ...scope, surface: `surface_${index}` },
		);
		await session.set(indexEntry[0], indexedScopes);
		const overflowScope = { ...scope, surface: "overflow" };

		await expect(
			bindings.put(overflowScope, {
				[opaqueAlias("msg", 6)]: "provider-message-overflow",
			}),
		).rejects.toThrow();
		expect(await bindings.get(scope)).toBeDefined();
		expect(await bindings.get(overflowScope)).toBeUndefined();

		await bindings.invalidateRevision(
			scope.planAlias,
			scope.revisionAlias,
			"completion",
		);
		expect(await bindings.get(scope)).toBeUndefined();
	});

	it("survives worker restart, schedules cleanup, and honors every invalidation reason", async () => {
		const time = clock();
		const session = new MemorySessionStorage();
		const scheduled: number[] = [];
		const canceled: string[] = [];
		const alarms = {
			schedule: async (_key: string, when: number) => {
				scheduled.push(when);
			},
			cancel: async (key: string) => {
				canceled.push(key);
			},
		};
		const firstWorker = createRawBindingStore({
			session,
			now: time.now,
			alarms,
		});
		await firstWorker.put(scope, {
			[opaqueAlias("msg", 5)]: "provider-message-42",
		});
		const restartedWorker = createRawBindingStore({
			session,
			now: time.now,
			alarms,
		});

		expect(await restartedWorker.get(scope)).toBeDefined();
		expect(scheduled).toEqual([time.now() + 60 * 60 * 1_000]);

		for (const reason of [
			"inactivity_expiry",
			"account_change",
			"restart_required",
			"completion",
			"cancellation",
		] as const) {
			const reasonSession = new MemorySessionStorage();
			const reasonStore = createRawBindingStore({
				session: reasonSession,
				now: time.now,
				alarms,
			});
			await reasonStore.put(scope, {
				[opaqueAlias("msg", 5)]: "provider-message-42",
			});
			await reasonStore.invalidate(scope, reason);
			expect(await reasonStore.get(scope)).toBeUndefined();
		}
		expect(canceled).toHaveLength(5);
		expect(
			await createRawBindingStore({
				session: new MemorySessionStorage(),
				now: time.now,
			}).get(scope),
		).toBeUndefined();
	});

	it("fails closed on failed migrations and corrupt or partial IndexedDB records", async () => {
		const migrationFactory = new IDBFactory();
		await seedLegacyDatabase(
			migrationFactory,
			"mailbox-migration-failure",
			true,
		);
		const failedMigration = createMailboxPlanStore({
			indexedDB: migrationFactory,
			databaseName: "mailbox-migration-failure",
		});
		await expect(failedMigration.putRevision(revision())).rejects.toThrow(
			/migration/i,
		);

		const unsafeFactory = new IDBFactory();
		await seedLegacyDatabase(unsafeFactory, "mailbox-unsafe-migration");
		const unsafeMigration = createMailboxPlanStore({
			indexedDB: unsafeFactory,
			databaseName: "mailbox-unsafe-migration",
			migrateRecord: ({ store, value }) =>
				store === "revisions" &&
				value !== null &&
				typeof value === "object"
					? {
							...value,
							rawBindings: {
								[opaqueAlias("msg", 5)]: "provider-sensitive",
							},
						}
					: value,
		});
		await expect(unsafeMigration.getPlan(scope.planAlias)).rejects.toThrow(
			/migration/i,
		);

		for (const mode of ["corrupt", "partial"] as const) {
			const indexedDB = new IDBFactory();
			const databaseName = `mailbox-${mode}`;
			const plans = createMailboxPlanStore({ indexedDB, databaseName });
			await plans.putRevision(revision());
			await damageFirstRevision(indexedDB, databaseName, mode);

			await expect(plans.getPlan(scope.planAlias)).rejects.toThrow(
				mode === "partial" ? /partial/i : /corrupt/i,
			);
		}
	});
});
