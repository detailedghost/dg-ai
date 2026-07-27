import {
	type MailboxPlanRevision,
	serializeMailboxPlanRevision,
	validateMailboxError,
	validateMailboxPlanRevision,
} from "@dg/common";
import {
	consumeTerminalCleanupProof,
	type TerminalCleanupProof,
} from "./raw-bindings";

const DATABASE_NAME = "dg-mailbox-plans";
const DATABASE_VERSION = 4;
const PLAN_STORE = "plans";
const REVISION_STORE = "revisions";

export type MailboxTerminalReservation = Readonly<{
	schemaVersion: 1;
	nonce: string;
	expectedState: MailboxPlanRevision["state"];
	nextState: "completed" | "canceled";
	targetExpiresAt: number;
}>;

export type MailboxRevisionRecord = Readonly<{
	schemaVersion: 1;
	key: string;
	planAlias: string;
	revisionAlias: string;
	revision: MailboxPlanRevision;
	expiresAt: number;
	terminalReservation?: MailboxTerminalReservation;
	terminalCleanupPending?: true;
}>;

export type MailboxStoredPlan = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisions: readonly MailboxRevisionRecord[];
}>;

export type MailboxMigrationRecord = Readonly<{
	store: "plans" | "revisions";
	value: unknown;
	fromVersion: number;
}>;

export type MailboxPlanStoreDeps = Readonly<{
	indexedDB: IDBFactory;
	databaseName?: string;
	now?: () => number;
	randomBytes?: () => Uint8Array;
	migrateRecord?: (record: MailboxMigrationRecord) => unknown;
}>;

export type PutRevisionOptions = Readonly<{
	expiresAt?: number;
}>;

export type MailboxPlanStore = Readonly<{
	putRevision(
		revision: unknown,
		options?: PutRevisionOptions,
	): Promise<MailboxPlanRevision>;
	getRevision(
		planAlias: string,
		revisionAlias: string,
	): Promise<MailboxPlanRevision | undefined>;
	getRecord(
		planAlias: string,
		revisionAlias: string,
	): Promise<MailboxRevisionRecord | undefined>;
	getPlan(planAlias: string): Promise<MailboxStoredPlan | undefined>;
	listPlans(): Promise<readonly MailboxStoredPlan[]>;
	compareAndSetRevision(
		planAlias: string,
		revisionAlias: string,
		expectedState: MailboxPlanRevision["state"],
		nextRevision: unknown,
		expiresAt: number,
	): Promise<MailboxPlanRevision>;
	appendDraftRevision(
		planAlias: string,
		basedOnRevisionAlias: string,
		draft: unknown,
		expiresAt: number,
	): Promise<MailboxPlanRevision>;
	reserveTerminalTransition(
		planAlias: string,
		revisionAlias: string,
		expectedState: MailboxPlanRevision["state"],
		nextState: "completed" | "canceled",
		targetExpiresAt: number,
	): Promise<MailboxTerminalReservation>;
	commitTerminalTransition(
		planAlias: string,
		revisionAlias: string,
		expectedState: MailboxPlanRevision["state"],
		reservationNonce: string,
		nextRevision: unknown,
	): Promise<MailboxPlanRevision>;
	failTerminalReservation(
		planAlias: string,
		revisionAlias: string,
		reservationNonce: string,
	): Promise<MailboxPlanRevision>;
	markTerminalCleanupPending(
		planAlias: string,
		revisionAlias: string,
	): Promise<void>;
	clearTerminalCleanupPending(
		planAlias: string,
		revisionAlias: string,
		proof: TerminalCleanupProof,
	): Promise<void>;
	deleteRevision(planAlias: string, revisionAlias: string): Promise<void>;
	deletePlan(planAlias: string): Promise<void>;
	close(): Promise<void>;
}>;

type PlanContainer = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisionAliases: readonly string[];
}>;

export class MailboxPlanStorageError extends Error {
	override readonly name = "MailboxPlanStorageError";

	constructor(
		readonly code:
			| "unavailable"
			| "migration_failed"
			| "corrupt_state"
			| "partial_state"
			| "immutable_revision"
			| "compare_failed",
	) {
		super(`Mailbox plan storage rejected: ${code}`);
	}
}

function fail(code: MailboxPlanStorageError["code"]): never {
	throw new MailboxPlanStorageError(code);
}

function validAlias(value: unknown, prefix: string): value is string {
	if (
		typeof value !== "string" ||
		!value.startsWith(`${prefix}_`)
	) {
		return false;
	}
	try {
		validateMailboxError({
			schemaVersion: 1,
			code: "internal_failure",
			retryable: false,
			relatedAlias: value,
		});
		return true;
	} catch {
		return false;
	}
}

function finiteExpiry(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0
	) {
		fail("corrupt_state");
	}
	return value;
}

const TERMINAL_NONCE = /^term_[a-f0-9]{32}$/;

function terminalNonce(randomBytes?: () => Uint8Array): string {
	let bytes: Uint8Array;
	try {
		bytes = randomBytes?.() ?? crypto.getRandomValues(new Uint8Array(16));
	} catch {
		fail("unavailable");
	}
	if (
		!(bytes instanceof Uint8Array) ||
		bytes.byteLength < 16
	) {
		fail("unavailable");
	}
	return `term_${[...bytes.subarray(0, 16)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

function recordKey(planAlias: string, revisionAlias: string): string {
	return `${planAlias.length}:${planAlias}|${revisionAlias.length}:${revisionAlias}`;
}

function validateContainer(value: unknown): PlanContainer {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		fail("corrupt_state");
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	const expected = ["schemaVersion", "planAlias", "revisionAliases"];
	if (
		keys.length !== expected.length ||
		!expected.every((key) => Object.hasOwn(input, key)) ||
		input.schemaVersion !== 1 ||
		!validAlias(input.planAlias, "plan") ||
		!Array.isArray(input.revisionAliases)
	) {
		fail("corrupt_state");
	}
	const revisionAliases = input.revisionAliases.map((alias) => {
		if (!validAlias(alias, "rev")) fail("corrupt_state");
		return alias;
	});
	if (new Set(revisionAliases).size !== revisionAliases.length) {
		fail("corrupt_state");
	}
	return {
		schemaVersion: 1,
		planAlias: input.planAlias,
		revisionAliases,
	};
}

function validateRecord(value: unknown): MailboxRevisionRecord {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		fail("corrupt_state");
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	const expected = [
		"schemaVersion",
		"key",
		"planAlias",
		"revisionAlias",
		"revision",
		"expiresAt",
	];
	if (
		keys.some(
			(key) =>
				!expected.includes(key) &&
				key !== "terminalReservation" &&
				key !== "terminalCleanupPending",
		) ||
		!expected.every((key) => Object.hasOwn(input, key)) ||
		input.schemaVersion !== 1 ||
		!validAlias(input.planAlias, "plan") ||
		!validAlias(input.revisionAlias, "rev") ||
		typeof input.key !== "string" ||
		input.key !== recordKey(input.planAlias, input.revisionAlias)
	) {
		fail("corrupt_state");
	}
	const revision = validateMailboxPlanRevision(input.revision);
	if (
		revision.planAlias !== input.planAlias ||
		revision.revisionAlias !== input.revisionAlias
	) {
		fail("corrupt_state");
	}
	let terminalReservation:
		| MailboxRevisionRecord["terminalReservation"]
		| undefined;
	if (input.terminalReservation !== undefined) {
		const reservation = input.terminalReservation;
			if (
				reservation === null ||
				typeof reservation !== "object" ||
				Array.isArray(reservation) ||
				Object.keys(reservation).length !== 5 ||
				!Object.hasOwn(reservation, "schemaVersion") ||
				!Object.hasOwn(reservation, "nonce") ||
				!Object.hasOwn(reservation, "expectedState") ||
				!Object.hasOwn(reservation, "nextState") ||
				!Object.hasOwn(reservation, "targetExpiresAt")
			) {
				fail("corrupt_state");
			}
			const values = reservation as Record<string, unknown>;
			if (
				values.schemaVersion !== 1 ||
				typeof values.nonce !== "string" ||
				!TERMINAL_NONCE.test(values.nonce) ||
				values.expectedState !== revision.state ||
				(values.nextState !== "completed" &&
					values.nextState !== "canceled") ||
				!LEGAL_STORED_TRANSITIONS[revision.state].includes(
					values.nextState,
				)
			) {
			fail("corrupt_state");
		}
			terminalReservation = {
				schemaVersion: 1,
				nonce: values.nonce,
				expectedState: revision.state,
				nextState: values.nextState,
				targetExpiresAt: finiteExpiry(values.targetExpiresAt),
			};
	}
	return {
		schemaVersion: 1,
		key: input.key,
		planAlias: input.planAlias,
		revisionAlias: input.revisionAlias,
		revision,
		expiresAt: finiteExpiry(input.expiresAt),
		...(terminalReservation === undefined
			? {}
			: { terminalReservation }),
		...(input.terminalCleanupPending === undefined
			? {}
			: input.terminalCleanupPending === true &&
					terminalReservation === undefined &&
					(revision.state === "completed" || revision.state === "canceled")
				? { terminalCleanupPending: true as const }
				: fail("corrupt_state")),
	};
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

const LEGAL_STORED_TRANSITIONS: Readonly<
	Record<MailboxPlanRevision["state"], readonly MailboxPlanRevision["state"][]>
> = {
	draft: ["approved", "canceled"],
	approved: ["in_flight", "canceled"],
	in_flight: ["completed", "canceled"],
	completed: [],
	canceled: [],
};

function preservesImmutableRevision(
	current: MailboxPlanRevision,
	next: MailboxPlanRevision,
): boolean {
	return (
		serializeMailboxPlanRevision(current) ===
		serializeMailboxPlanRevision({
			...next,
			state: current.state,
			restartRequired: current.restartRequired,
		})
	);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(new MailboxPlanStorageError("unavailable"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(new MailboxPlanStorageError("unavailable"));
		transaction.onerror = () =>
			reject(new MailboxPlanStorageError("unavailable"));
	});
}

export function createMailboxPlanStore(
	deps: MailboxPlanStoreDeps,
): MailboxPlanStore {
	let databasePromise: Promise<IDBDatabase> | undefined;
	const now = deps.now ?? Date.now;

	const database = (): Promise<IDBDatabase> => {
		databasePromise ??= new Promise((resolve, reject) => {
			const request = deps.indexedDB.open(
				deps.databaseName ?? DATABASE_NAME,
				DATABASE_VERSION,
			);
			request.onupgradeneeded = (event) => {
				const transaction = request.transaction;
				if (!transaction) {
					reject(new MailboxPlanStorageError("migration_failed"));
					return;
				}
				try {
					if (
						event.oldVersion > 0 &&
						([...request.result.objectStoreNames].some(
							(name) =>
								name !== PLAN_STORE && name !== REVISION_STORE,
						) ||
							!request.result.objectStoreNames.contains(PLAN_STORE) ||
							!request.result.objectStoreNames.contains(REVISION_STORE))
					) {
						transaction.abort();
						return;
					}
					if (!request.result.objectStoreNames.contains(PLAN_STORE)) {
						request.result.createObjectStore(PLAN_STORE, {
							keyPath: "planAlias",
						});
					}
					if (!request.result.objectStoreNames.contains(REVISION_STORE)) {
						request.result.createObjectStore(REVISION_STORE, {
							keyPath: "key",
						});
					}
					if (event.oldVersion > 0) {
						for (const storeName of [
							PLAN_STORE,
							REVISION_STORE,
						] as const) {
							const cursorRequest = transaction
								.objectStore(storeName)
								.openCursor();
							cursorRequest.onerror = () => transaction.abort();
							cursorRequest.onsuccess = () => {
								const cursor = cursorRequest.result;
								if (cursor === null) return;
								try {
										const transformed =
											deps.migrateRecord?.({
											store: storeName,
											value: deepFreeze(cursor.value),
											fromVersion: event.oldVersion,
										}) ?? cursor.value;
										if (storeName === PLAN_STORE) {
											cursor.update(validateContainer(transformed));
										} else {
											const record = validateRecord(transformed);
											cursor.update(
												event.oldVersion < 4 &&
													(record.revision.state === "completed" ||
														record.revision.state === "canceled")
													? validateRecord({
															...record,
															terminalCleanupPending: true,
														})
													: record,
											);
										}
									cursor.continue();
								} catch {
									transaction.abort();
								}
							};
						}
					}
				} catch {
					transaction.abort();
				}
			};
			request.onsuccess = () => {
				if (
					request.result.objectStoreNames.length !== 2 ||
					!request.result.objectStoreNames.contains(PLAN_STORE) ||
					!request.result.objectStoreNames.contains(REVISION_STORE)
				) {
					request.result.close();
					reject(new MailboxPlanStorageError("migration_failed"));
					return;
				}
				resolve(request.result);
			};
			request.onerror = () =>
				reject(new MailboxPlanStorageError("migration_failed"));
			request.onblocked = () =>
				reject(new MailboxPlanStorageError("unavailable"));
		});
		return databasePromise;
	};

	const getContainer = async (
		store: IDBObjectStore,
		planAlias: string,
	): Promise<PlanContainer | undefined> => {
		const value = await requestResult(store.get(planAlias));
		return value === undefined ? undefined : validateContainer(value);
	};

	const getRevisionRecord = async (
		store: IDBObjectStore,
		planAlias: string,
		revisionAlias: string,
	): Promise<MailboxRevisionRecord | undefined> => {
		const value = await requestResult(
			store.get(recordKey(planAlias, revisionAlias)),
		);
		return value === undefined ? undefined : validateRecord(value);
	};

	const readPlan = async (
		planAlias: string,
	): Promise<MailboxStoredPlan | undefined> => {
		if (!validAlias(planAlias, "plan")) fail("corrupt_state");
		const db = await database();
		const transaction = db.transaction(
			[PLAN_STORE, REVISION_STORE],
			"readonly",
		);
		const container = await getContainer(
			transaction.objectStore(PLAN_STORE),
			planAlias,
		);
		if (container === undefined) return undefined;
		const revisionStore = transaction.objectStore(REVISION_STORE);
		const revisions: MailboxRevisionRecord[] = [];
		for (const revisionAlias of container.revisionAliases) {
			const record = await getRevisionRecord(
				revisionStore,
				planAlias,
				revisionAlias,
			);
			if (record === undefined) fail("partial_state");
			revisions.push(record);
		}
		revisions.sort(
			(left, right) =>
				left.revision.revisionNumber - right.revision.revisionNumber,
		);
		return deepFreeze({
			schemaVersion: 1,
			planAlias,
			revisions,
		});
	};

	return Object.freeze({
		async putRevision(value, options = {}) {
			const revision = validateMailboxPlanRevision(value);
			const expiresAt =
				options.expiresAt === undefined
					? Number.MAX_SAFE_INTEGER
					: finiteExpiry(options.expiresAt);
			const db = await database();
			const transaction = db.transaction(
				[PLAN_STORE, REVISION_STORE],
				"readwrite",
			);
			const planStore = transaction.objectStore(PLAN_STORE);
			const revisionStore = transaction.objectStore(REVISION_STORE);
			const existing = await getRevisionRecord(
				revisionStore,
				revision.planAlias,
				revision.revisionAlias,
			);
			if (existing !== undefined) {
				if (
					serializeMailboxPlanRevision(existing.revision) ===
						serializeMailboxPlanRevision(revision) &&
					existing.expiresAt === expiresAt
				) {
					return deepFreeze(revision);
				}
				transaction.abort();
				fail("immutable_revision");
			}
			const container =
				(await getContainer(planStore, revision.planAlias)) ?? {
					schemaVersion: 1 as const,
					planAlias: revision.planAlias,
					revisionAliases: [],
				};
			if (container.revisionAliases.includes(revision.revisionAlias)) {
				transaction.abort();
				fail("corrupt_state");
			}
			revisionStore.add({
				schemaVersion: 1,
				key: recordKey(revision.planAlias, revision.revisionAlias),
				planAlias: revision.planAlias,
				revisionAlias: revision.revisionAlias,
				revision,
				expiresAt,
			} satisfies MailboxRevisionRecord);
			planStore.put({
				...container,
				revisionAliases: [
					...container.revisionAliases,
					revision.revisionAlias,
				],
			} satisfies PlanContainer);
			await transactionDone(transaction);
			return deepFreeze(revision);
		},
		async getRevision(planAlias, revisionAlias) {
			const record = await this.getRecord(planAlias, revisionAlias);
			return record?.revision;
		},
		async getRecord(planAlias, revisionAlias) {
			if (
				!validAlias(planAlias, "plan") ||
				!validAlias(revisionAlias, "rev")
			) {
				fail("corrupt_state");
			}
			const db = await database();
			const transaction = db.transaction(REVISION_STORE, "readonly");
			const record = await getRevisionRecord(
				transaction.objectStore(REVISION_STORE),
				planAlias,
				revisionAlias,
			);
			return record === undefined ? undefined : deepFreeze(record);
		},
		async getPlan(planAlias) {
			return readPlan(planAlias);
		},
		async listPlans() {
			const db = await database();
			const transaction = db.transaction(PLAN_STORE, "readonly");
			const values = await requestResult(
				transaction.objectStore(PLAN_STORE).getAll(),
			);
			const containers = values.map(validateContainer);
			const plans: MailboxStoredPlan[] = [];
			for (const container of containers) {
				const plan = await readPlan(container.planAlias);
				if (plan !== undefined) plans.push(plan);
			}
			return Object.freeze(
				plans.sort((left, right) =>
					left.planAlias.localeCompare(right.planAlias),
				),
			);
		},
		async compareAndSetRevision(
			planAlias,
			revisionAlias,
			expectedState,
			nextValue,
			expiresAt,
		) {
			const nextRevision = validateMailboxPlanRevision(nextValue);
			const nextExpiry = finiteExpiry(expiresAt);
			if (
				nextRevision.planAlias !== planAlias ||
				nextRevision.revisionAlias !== revisionAlias ||
				nextRevision.state === "completed" ||
				nextRevision.state === "canceled"
			) {
				fail("compare_failed");
			}
			const db = await database();
			const transaction = db.transaction(REVISION_STORE, "readwrite");
			const store = transaction.objectStore(REVISION_STORE);
			const current = await getRevisionRecord(
				store,
				planAlias,
				revisionAlias,
			);
			const mutationNow = now();
			if (
				current === undefined ||
				current.terminalReservation !== undefined ||
				current.revision.state !== expectedState ||
				mutationNow >= current.expiresAt ||
				mutationNow >= nextExpiry ||
				!preservesImmutableRevision(
					current.revision,
					nextRevision,
				)
			) {
				transaction.abort();
				fail("compare_failed");
			}
			const stateChanged =
				current.revision.state !== nextRevision.state;
			if (
				(stateChanged &&
					(!LEGAL_STORED_TRANSITIONS[
						current.revision.state
					].includes(nextRevision.state) ||
						nextRevision.restartRequired !==
							current.revision.restartRequired)) ||
				(!stateChanged &&
					(nextExpiry !== current.expiresAt ||
						(current.revision.restartRequired &&
							!nextRevision.restartRequired)))
			) {
				transaction.abort();
				fail("compare_failed");
			}
			store.put({
				...current,
				revision: nextRevision,
				expiresAt: nextExpiry,
			} satisfies MailboxRevisionRecord);
			await transactionDone(transaction);
			return deepFreeze(nextRevision);
		},
		async appendDraftRevision(
			planAlias,
			basedOnRevisionAlias,
			value,
			expiresAt,
		) {
			const draft = validateMailboxPlanRevision(value);
			const draftExpiry = finiteExpiry(expiresAt);
			if (
				draft.planAlias !== planAlias ||
				draft.state !== "draft" ||
				draft.revisionAlias === basedOnRevisionAlias
			) {
				fail("compare_failed");
			}
			const db = await database();
			const transaction = db.transaction(
				[PLAN_STORE, REVISION_STORE],
				"readwrite",
			);
			const planStore = transaction.objectStore(PLAN_STORE);
			const revisionStore = transaction.objectStore(REVISION_STORE);
			const container = await getContainer(planStore, planAlias);
			const base = await getRevisionRecord(
				revisionStore,
				planAlias,
				basedOnRevisionAlias,
			);
			if (
				container === undefined ||
				base === undefined ||
				container.revisionAliases.includes(draft.revisionAlias)
			) {
				transaction.abort();
				fail("compare_failed");
			}
			const records: MailboxRevisionRecord[] = [];
			for (const revisionAlias of container.revisionAliases) {
				const record = await getRevisionRecord(
					revisionStore,
					planAlias,
					revisionAlias,
				);
				if (record === undefined) {
					transaction.abort();
					fail("partial_state");
				}
				records.push(record);
			}
			const mutationNow = now();
			if (
				mutationNow >= base.expiresAt ||
				mutationNow >= draftExpiry
			) {
				transaction.abort();
				fail("compare_failed");
			}
			const revision = validateMailboxPlanRevision({
				...draft,
				revisionNumber:
					Math.max(
						...records.map(
							(record) => record.revision.revisionNumber,
						),
					) + 1,
			});
			revisionStore.add({
				schemaVersion: 1,
				key: recordKey(planAlias, revision.revisionAlias),
				planAlias,
				revisionAlias: revision.revisionAlias,
				revision,
				expiresAt: draftExpiry,
			} satisfies MailboxRevisionRecord);
			planStore.put({
				...container,
				revisionAliases: [
					...container.revisionAliases,
					revision.revisionAlias,
				],
			} satisfies PlanContainer);
			await transactionDone(transaction);
			return deepFreeze(revision);
		},
			async reserveTerminalTransition(
				planAlias,
				revisionAlias,
				expectedState,
				nextState,
				expiresAt,
			) {
				const targetExpiresAt = finiteExpiry(expiresAt);
				if (
					!LEGAL_STORED_TRANSITIONS[expectedState].includes(nextState)
				) {
				fail("compare_failed");
			}
			const db = await database();
			const transaction = db.transaction(REVISION_STORE, "readwrite");
			const store = transaction.objectStore(REVISION_STORE);
			const current = await getRevisionRecord(
				store,
				planAlias,
				revisionAlias,
			);
			const mutationNow = now();
			if (
					current === undefined ||
					current.revision.state !== expectedState ||
					mutationNow >= current.expiresAt ||
					mutationNow >= targetExpiresAt
				) {
				transaction.abort();
				fail("compare_failed");
			}
			if (current.terminalReservation !== undefined) {
					if (
						current.terminalReservation.expectedState ===
							expectedState &&
						current.terminalReservation.nextState === nextState
					) {
						return deepFreeze(current.terminalReservation);
					}
				transaction.abort();
				fail("compare_failed");
			}
				const reservation: MailboxTerminalReservation = {
					schemaVersion: 1,
					nonce: terminalNonce(deps.randomBytes),
					expectedState,
					nextState,
					targetExpiresAt,
				};
				store.put({
					...current,
					terminalReservation: reservation,
				} satisfies MailboxRevisionRecord);
				await transactionDone(transaction);
				return deepFreeze(reservation);
			},
			async commitTerminalTransition(
				planAlias,
				revisionAlias,
				expectedState,
				reservationNonce,
				nextValue,
			) {
				const nextRevision = validateMailboxPlanRevision(nextValue);
				if (
					typeof reservationNonce !== "string" ||
					!TERMINAL_NONCE.test(reservationNonce)
				) {
					fail("compare_failed");
				}
				const db = await database();
			const transaction = db.transaction(REVISION_STORE, "readwrite");
			const store = transaction.objectStore(REVISION_STORE);
			const current = await getRevisionRecord(
				store,
				planAlias,
				revisionAlias,
			);
			const mutationNow = now();
			if (
				current === undefined ||
					current.revision.state !== expectedState ||
					current.terminalReservation?.expectedState !==
						expectedState ||
					current.terminalReservation?.nonce !== reservationNonce ||
					current.terminalReservation?.nextState !== nextRevision.state ||
					(nextRevision.state !== "completed" &&
						nextRevision.state !== "canceled") ||
					!LEGAL_STORED_TRANSITIONS[expectedState].includes(
						nextRevision.state,
					) ||
					mutationNow >= current.expiresAt ||
					mutationNow >=
						current.terminalReservation.targetExpiresAt ||
				!preservesImmutableRevision(
					current.revision,
					nextRevision,
				) ||
				nextRevision.restartRequired !==
					current.revision.restartRequired
			) {
				transaction.abort();
				fail("compare_failed");
			}
			const {
				terminalReservation: _terminalReservation,
				...committed
			} = current;
			store.put({
					...committed,
					revision: nextRevision,
					expiresAt: current.terminalReservation.targetExpiresAt,
				} satisfies MailboxRevisionRecord);
			await transactionDone(transaction);
				return deepFreeze(nextRevision);
			},
			async failTerminalReservation(
				planAlias,
				revisionAlias,
				reservationNonce,
			) {
				if (
					typeof reservationNonce !== "string" ||
					!TERMINAL_NONCE.test(reservationNonce)
				) {
					fail("compare_failed");
				}
				const db = await database();
				const transaction = db.transaction(REVISION_STORE, "readwrite");
				const store = transaction.objectStore(REVISION_STORE);
				const current = await getRevisionRecord(
					store,
					planAlias,
					revisionAlias,
				);
				const mutationNow = now();
					if (
						current === undefined ||
						current.terminalReservation?.nonce !== reservationNonce ||
						mutationNow >=
							Math.min(
								current.expiresAt,
								current.terminalReservation.targetExpiresAt,
							)
					) {
					transaction.abort();
					fail("compare_failed");
				}
				const revision = validateMailboxPlanRevision({
					...current.revision,
					restartRequired: true,
				});
				const {
					terminalReservation: _terminalReservation,
					...failed
				} = current;
				store.put({
					...failed,
					revision,
				} satisfies MailboxRevisionRecord);
					await transactionDone(transaction);
					return deepFreeze(revision);
				},
				async markTerminalCleanupPending(planAlias, revisionAlias) {
					const db = await database();
					const transaction = db.transaction(
						REVISION_STORE,
						"readwrite",
					);
					const store = transaction.objectStore(REVISION_STORE);
					const current = await getRevisionRecord(
						store,
						planAlias,
						revisionAlias,
					);
					if (
						current === undefined ||
						current.terminalReservation !== undefined ||
						(current.revision.state !== "completed" &&
							current.revision.state !== "canceled") ||
						now() >= current.expiresAt
					) {
						transaction.abort();
						fail("compare_failed");
					}
					if (current.terminalCleanupPending === true) return;
					store.put({
						...current,
						terminalCleanupPending: true,
					} satisfies MailboxRevisionRecord);
					await transactionDone(transaction);
				},
				async clearTerminalCleanupPending(
					planAlias,
					revisionAlias,
					proof,
				) {
					if (
						!consumeTerminalCleanupProof(
							proof,
							planAlias,
							revisionAlias,
						)
					) {
						fail("compare_failed");
					}
					const db = await database();
					const transaction = db.transaction(
						REVISION_STORE,
						"readwrite",
					);
					const store = transaction.objectStore(REVISION_STORE);
					const current = await getRevisionRecord(
						store,
						planAlias,
						revisionAlias,
					);
					if (
						current === undefined ||
						current.terminalReservation !== undefined ||
						(current.revision.state !== "completed" &&
							current.revision.state !== "canceled")
					) {
						transaction.abort();
						fail("compare_failed");
					}
					if (current.terminalCleanupPending === undefined) return;
					const {
						terminalCleanupPending: _terminalCleanupPending,
						...cleared
					} = current;
					store.put(cleared satisfies MailboxRevisionRecord);
					await transactionDone(transaction);
				},
			async deleteRevision(planAlias, revisionAlias) {
			const db = await database();
			const transaction = db.transaction(
				[PLAN_STORE, REVISION_STORE],
				"readwrite",
			);
			const planStore = transaction.objectStore(PLAN_STORE);
			const container = await getContainer(planStore, planAlias);
			transaction
				.objectStore(REVISION_STORE)
				.delete(recordKey(planAlias, revisionAlias));
			if (container !== undefined) {
				const revisionAliases = container.revisionAliases.filter(
					(alias) => alias !== revisionAlias,
				);
				if (revisionAliases.length === 0) {
					planStore.delete(planAlias);
				} else {
					planStore.put({ ...container, revisionAliases });
				}
			}
			await transactionDone(transaction);
		},
		async deletePlan(planAlias) {
			const db = await database();
			const transaction = db.transaction(
				[PLAN_STORE, REVISION_STORE],
				"readwrite",
			);
			const planStore = transaction.objectStore(PLAN_STORE);
			const container = await getContainer(planStore, planAlias);
			if (container !== undefined) {
				const revisionStore = transaction.objectStore(REVISION_STORE);
				for (const revisionAlias of container.revisionAliases) {
					revisionStore.delete(recordKey(planAlias, revisionAlias));
				}
			}
			planStore.delete(planAlias);
			await transactionDone(transaction);
		},
		async close() {
			(await database()).close();
			databasePromise = undefined;
		},
	});
}
