import type {
	MailboxExecutionAtomicRecord,
	MailboxExecutionAtomicStorage,
} from "../features/mailbox-cleanup/execution/contracts";

const STORE = "execution";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), {
			once: true,
		});
		request.addEventListener(
			"error",
			() => reject(request.error ?? new Error("Mailbox storage failed")),
			{ once: true },
		);
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new Error("Mailbox storage aborted")),
			{ once: true },
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new Error("Mailbox storage failed")),
			{ once: true },
		);
	});
}

function openDatabase(
	indexedDB: IDBFactory,
	databaseName: string,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1);
		request.addEventListener("upgradeneeded", () => {
			if (!request.result.objectStoreNames.contains(STORE)) {
				request.result.createObjectStore(STORE, { keyPath: "key" });
			}
		});
		request.addEventListener("success", () => resolve(request.result), {
			once: true,
		});
		request.addEventListener(
			"error",
			() => reject(request.error ?? new Error("Mailbox storage failed")),
			{ once: true },
		);
	});
}

type StoredRecord = Readonly<{
	key: string;
	version: number;
	value: unknown;
}>;

function stored(value: unknown, key: string): StoredRecord | undefined {
	if (value === undefined) return undefined;
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Invalid mailbox execution storage record");
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 3 ||
		input.key !== key ||
		typeof input.version !== "number" ||
		!Number.isSafeInteger(input.version) ||
		input.version < 0 ||
		!Object.hasOwn(input, "value")
	) {
		throw new Error("Invalid mailbox execution storage record");
	}
	return {
		key,
		version: input.version,
		value: structuredClone(input.value),
	};
}

/** Cross-context CAS storage backed by one IndexedDB read-write transaction. */
export function createMailboxExecutionIndexedDbStorage(
	indexedDB: IDBFactory,
	databaseName = "dg-mailbox-execution-v1",
): MailboxExecutionAtomicStorage {
	let database: Promise<IDBDatabase> | undefined;
	const db = (): Promise<IDBDatabase> =>
		(database ??= openDatabase(indexedDB, databaseName));
	return Object.freeze({
		async read(key): Promise<MailboxExecutionAtomicRecord | undefined> {
			const transaction = (await db()).transaction(STORE, "readonly");
			const result = stored(
				await requestResult(transaction.objectStore(STORE).get(key)),
				key,
			);
			await transactionDone(transaction);
			return result === undefined
				? undefined
				: Object.freeze({
						version: result.version,
						value: structuredClone(result.value),
					});
		},
		async compareAndSet(key, expectedVersion, value) {
			const transaction = (await db()).transaction(STORE, "readwrite");
			const store = transaction.objectStore(STORE);
			const current = stored(await requestResult(store.get(key)), key);
			if (current?.version !== expectedVersion) {
				transaction.abort();
				try {
					await transactionDone(transaction);
				} catch {
					return false;
				}
				return false;
			}
			store.put({
				key,
				version: (current?.version ?? -1) + 1,
				value: structuredClone(value),
			} satisfies StoredRecord);
			await transactionDone(transaction);
			return true;
		},
	});
}
