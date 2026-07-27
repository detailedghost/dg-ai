import { preflightMailboxValue } from "@dg/common";
import { isValidMailboxScopedAlias } from "../privacy/aliases";

const BINDING_TTL_MS = 60 * 60 * 1_000;
const KEY_PREFIX = "dg:mailbox:raw-bindings:v1:";
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE = /^[a-z][a-z0-9_-]{0,63}$/;
const BINDING_PREFIXES = new Set(["msg", "fld", "lbl", "flt"]);

export type RawBindingScope = Readonly<{
	planAlias: string;
	providerId: string;
	surface: string;
	accountAlias: string;
	runAlias: string;
	revisionAlias: string;
}>;

export type RawBindingTouchEvent =
	| "user_decision"
	| "execution_checkpoint"
	| "passive_read"
	| "page_open"
	| "list"
	| "poll"
	| "alarm"
	| "progress"
	| "worker_wake";

export type RawBindingInvalidationReason =
	| "inactivity_expiry"
	| "account_change"
	| "restart_required"
	| "completion"
	| "cancellation";

export type SessionStorageSeam = Readonly<{
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
}>;

export type BindingAlarmSeam = Readonly<{
	schedule(key: string, when: number): Promise<void> | void;
	cancel(key: string): Promise<void> | void;
}>;

export type RawBindingStoreDeps = Readonly<{
	session: SessionStorageSeam;
	now: () => number;
	alarms?: BindingAlarmSeam;
}>;

export type RawBindingStore = Readonly<{
	put(
		scope: RawBindingScope,
		bindings: Readonly<Record<string, string>>,
	): Promise<void>;
	get(
		scope: RawBindingScope,
	): Promise<Readonly<Record<string, string>> | undefined>;
	touch(scope: RawBindingScope, event: RawBindingTouchEvent): Promise<boolean>;
	invalidate(
		scope: RawBindingScope,
		reason: RawBindingInvalidationReason,
	): Promise<void>;
	invalidateRevision(
		planAlias: string,
		revisionAlias: string,
		reason: RawBindingInvalidationReason,
	): Promise<TerminalCleanupProof>;
}>;

export type TerminalCleanupProof = Readonly<{
	planAlias: string;
	revisionAlias: string;
}>;

const TERMINAL_CLEANUP_PROOFS = new WeakSet<object>();

function createTerminalCleanupProof(
	planAlias: string,
	revisionAlias: string,
): TerminalCleanupProof {
	const proof = Object.freeze({
		planAlias,
		revisionAlias,
	});
	TERMINAL_CLEANUP_PROOFS.add(proof);
	return proof;
}

export function consumeTerminalCleanupProof(
	proof: TerminalCleanupProof,
	planAlias: string,
	revisionAlias: string,
): boolean {
	if (
		!TERMINAL_CLEANUP_PROOFS.has(proof) ||
		proof.planAlias !== planAlias ||
		proof.revisionAlias !== revisionAlias
	) {
		return false;
	}
	TERMINAL_CLEANUP_PROOFS.delete(proof);
	return true;
}

type StoredRawBindings = Readonly<{
	schemaVersion: 1;
	scope: RawBindingScope;
	bindings: Readonly<Record<string, string>>;
	expiresAt: number;
}>;

type StoredBindingTombstone = Readonly<{
	schemaVersion: 1;
	invalidatedAt: number;
	reason: RawBindingInvalidationReason;
}>;

const REVISION_QUEUES = new Map<string, Promise<void>>();

class RawBindingStorageError extends Error {
	override readonly name = "RawBindingStorageError";
}

function fail(): never {
	throw new RawBindingStorageError("Raw mailbox binding storage rejected");
}

function exactRecord(
	value: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	preflightMailboxValue(value);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		fail();
	}
	const keys = Object.keys(value);
	if (
		keys.length !== expectedKeys.length ||
		!expectedKeys.every((key) => Object.hasOwn(value, key))
	) {
		fail();
	}
	return value as Record<string, unknown>;
}

function validateScope(value: unknown): RawBindingScope {
	const input = exactRecord(value, [
		"planAlias",
		"providerId",
		"surface",
		"accountAlias",
		"runAlias",
		"revisionAlias",
	]);
	if (
		typeof input.providerId !== "string" ||
		!PROVIDER_ID.test(input.providerId) ||
		typeof input.surface !== "string" ||
		!SURFACE.test(input.surface) ||
		!isValidMailboxScopedAlias(input.planAlias, "plan") ||
		!isValidMailboxScopedAlias(input.accountAlias, "acct") ||
		!isValidMailboxScopedAlias(input.runAlias, "run") ||
		!isValidMailboxScopedAlias(input.revisionAlias, "rev")
	) {
		fail();
	}
	return {
		planAlias: input.planAlias,
		providerId: input.providerId,
		surface: input.surface,
		accountAlias: input.accountAlias,
		runAlias: input.runAlias,
		revisionAlias: input.revisionAlias,
	};
}

function validateBindings(
	value: unknown,
): Readonly<Record<string, string>> {
	preflightMailboxValue(value);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		fail();
	}
	const entries = Object.entries(value);
	if (entries.length > 10_000) fail();
	const bindings: Record<string, string> = {};
	for (const [alias, rawValue] of entries) {
		const prefix = alias.split("_", 1)[0];
		if (
			prefix === undefined ||
			!BINDING_PREFIXES.has(prefix) ||
			!isValidMailboxScopedAlias(alias, prefix) ||
			typeof rawValue !== "string" ||
			rawValue.length === 0 ||
			rawValue.length > 4096
		) {
			fail();
		}
		bindings[alias] = rawValue;
	}
	return Object.freeze(bindings);
}

function validateStored(value: unknown): StoredRawBindings {
	const input = exactRecord(value, [
		"schemaVersion",
		"scope",
		"bindings",
		"expiresAt",
	]);
	if (
		input.schemaVersion !== 1 ||
		typeof input.expiresAt !== "number" ||
		!Number.isSafeInteger(input.expiresAt) ||
		input.expiresAt < 0
	) {
		fail();
	}
	return {
		schemaVersion: 1,
		scope: validateScope(input.scope),
		bindings: validateBindings(input.bindings),
		expiresAt: input.expiresAt,
	};
}

function scopeKey(scope: RawBindingScope): string {
	const values = [
		scope.planAlias,
		scope.providerId,
		scope.surface,
		scope.accountAlias,
		scope.runAlias,
		scope.revisionAlias,
	];
	return `${KEY_PREFIX}${values
		.map((value) => `${value.length}:${value}`)
		.join("|")}`;
}

function revisionKey(planAlias: string, revisionAlias: string): string {
	return `${KEY_PREFIX}revision:${planAlias.length}:${planAlias}|${revisionAlias.length}:${revisionAlias}`;
}

function sameScope(left: RawBindingScope, right: RawBindingScope): boolean {
	return scopeKey(left) === scopeKey(right);
}

export function createRawBindingStore(
	deps: RawBindingStoreDeps,
): RawBindingStore {
	const serialized = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
		const previous = REVISION_QUEUES.get(key) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		REVISION_QUEUES.set(key, settled);
		return result.finally(() => {
			if (REVISION_QUEUES.get(key) === settled) REVISION_QUEUES.delete(key);
		});
	};

	const tombstoneKey = (key: string): string => `${key}:tombstone`;
	const indexKey = (planAlias: string, revisionAlias: string): string =>
		`${revisionKey(planAlias, revisionAlias)}:index`;
	const revisionTombstoneKey = (
		planAlias: string,
		revisionAlias: string,
	): string => `${revisionKey(planAlias, revisionAlias)}:tombstone`;
	const isTombstoned = async (scope: RawBindingScope): Promise<boolean> =>
		(await deps.session.get(
			revisionTombstoneKey(scope.planAlias, scope.revisionAlias),
		)) !== undefined ||
		(await deps.session.get(tombstoneKey(scopeKey(scope)))) !== undefined;

	const readIndex = async (
		planAlias: string,
		revisionAlias: string,
	): Promise<RawBindingScope[]> => {
		const value = await deps.session.get(indexKey(planAlias, revisionAlias));
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.length > 10_000) fail();
		return value.map((scope) => {
			const safeScope = validateScope(scope);
			if (
				safeScope.planAlias !== planAlias ||
				safeScope.revisionAlias !== revisionAlias
			) {
				fail();
			}
			return safeScope;
		});
	};

	const tombstone = async (
		scope: RawBindingScope,
		reason: RawBindingInvalidationReason,
	): Promise<void> => {
		const key = scopeKey(scope);
		await deps.session.set(tombstoneKey(key), {
			schemaVersion: 1,
			invalidatedAt: deps.now(),
			reason,
			} satisfies StoredBindingTombstone);
			await deps.session.delete(key);
			try {
				await deps.alarms?.cancel(key);
			} catch {
				// The tombstone and deleted session value remain authoritative.
			}
	};

	const readUnserialized = async (
		scope: RawBindingScope,
	): Promise<StoredRawBindings | undefined> => {
		const safeScope = validateScope(scope);
		const key = scopeKey(safeScope);
		if (await isTombstoned(safeScope)) {
			await deps.session.delete(key);
			return undefined;
		}
		const value = await deps.session.get(key);
		if (value === undefined) return undefined;
		let stored: StoredRawBindings;
		try {
			stored = validateStored(value);
		} catch {
			await tombstone(safeScope, "restart_required");
			return undefined;
		}
		if (!sameScope(stored.scope, safeScope) || deps.now() >= stored.expiresAt) {
			await tombstone(safeScope, "inactivity_expiry");
			return undefined;
		}
		return stored;
	};

	return Object.freeze({
			async put(scope, bindings) {
			const safeScope = validateScope(scope);
			const safeBindings = validateBindings(bindings);
			const key = scopeKey(safeScope);
				await serialized(
					revisionKey(safeScope.planAlias, safeScope.revisionAlias),
					async () => {
					if (
						(await deps.session.get(
							revisionTombstoneKey(
								safeScope.planAlias,
								safeScope.revisionAlias,
							),
						)) !== undefined
					) {
						fail();
					}
					if ((await deps.session.get(tombstoneKey(key))) !== undefined) {
						fail();
					}
				const existingValue = await deps.session.get(key);
				let expiresAt = deps.now() + BINDING_TTL_MS;
				if (existingValue !== undefined) {
					let existing: StoredRawBindings;
					try {
						existing = validateStored(existingValue);
					} catch {
						await tombstone(safeScope, "restart_required");
						fail();
					}
					if (
						!sameScope(existing.scope, safeScope) ||
						deps.now() >= existing.expiresAt
					) {
						await tombstone(safeScope, "inactivity_expiry");
						fail();
					}
					expiresAt = existing.expiresAt;
				}
					const scopes = await readIndex(
						safeScope.planAlias,
						safeScope.revisionAlias,
					);
					if (!scopes.some((scope) => sameScope(scope, safeScope))) {
						if (scopes.length >= 10_000) fail();
						await deps.session.set(
							indexKey(safeScope.planAlias, safeScope.revisionAlias),
							[...scopes, safeScope],
						);
					}
					await deps.session.set(key, {
						schemaVersion: 1,
						scope: safeScope,
						bindings: safeBindings,
						expiresAt,
					} satisfies StoredRawBindings);
				if (await isTombstoned(safeScope)) {
					await deps.session.delete(key);
					fail();
				}
					try {
						await deps.alarms?.schedule(key, expiresAt);
					} catch {
						// Read-time expiry remains authoritative without an alarm.
					}
					},
				);
			},
		async get(scope) {
			const safeScope = validateScope(scope);
			const key = scopeKey(safeScope);
				return serialized(
					revisionKey(safeScope.planAlias, safeScope.revisionAlias),
				async () => (await readUnserialized(safeScope))?.bindings,
			);
		},
		async touch(scope, event) {
			const safeScope = validateScope(scope);
			const key = scopeKey(safeScope);
				return serialized(
					revisionKey(safeScope.planAlias, safeScope.revisionAlias),
					async () => {
				const stored = await readUnserialized(safeScope);
				if (stored === undefined) return false;
				if (event !== "user_decision" && event !== "execution_checkpoint") {
					return false;
					}
				const expiresAt = deps.now() + BINDING_TTL_MS;
				if (await isTombstoned(safeScope)) {
					await deps.session.delete(key);
					return false;
				}
				await deps.session.set(key, { ...stored, expiresAt });
				if (await isTombstoned(safeScope)) {
					await deps.session.delete(key);
					return false;
				}
					try {
						await deps.alarms?.schedule(key, expiresAt);
					} catch {
						// The renewed session expiry remains authoritative.
					}
					return true;
					},
				);
			},
			async invalidate(scope, reason) {
				const safeScope = validateScope(scope);
				await serialized(
					revisionKey(safeScope.planAlias, safeScope.revisionAlias),
					async () => tombstone(safeScope, reason),
				);
			},
			async invalidateRevision(planAlias, revisionAlias, reason) {
				if (
					!isValidMailboxScopedAlias(planAlias, "plan") ||
					!isValidMailboxScopedAlias(revisionAlias, "rev")
				) {
					fail();
				}
				await serialized(revisionKey(planAlias, revisionAlias), async () => {
					const scopes = await readIndex(planAlias, revisionAlias);
					await deps.session.set(
						revisionTombstoneKey(planAlias, revisionAlias),
						{ schemaVersion: 1, invalidatedAt: deps.now(), reason },
					);
					for (const scope of scopes) await tombstone(scope, reason);
					await deps.session.delete(indexKey(planAlias, revisionAlias));
					if ((await readIndex(planAlias, revisionAlias)).length !== 0) {
						fail();
					}
					for (const scope of scopes) {
						if (
							(await deps.session.get(scopeKey(scope))) !== undefined
						) {
							fail();
						}
					}
				});
				return createTerminalCleanupProof(planAlias, revisionAlias);
			},
	});
}
