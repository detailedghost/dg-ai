export type PageStorage = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
};

type RuntimeListener = (message: unknown) => void;

export type PageRuntime = {
	sendMessage?(message: unknown): Promise<unknown>;
	onMessage?: {
		addListener(listener: RuntimeListener): void;
		removeListener?(listener: RuntimeListener): void;
	};
	storage: PageStorage;
};

export type PairingControl = {
	setConnected(connected: boolean): void;
	setCurrentSession(sessionId: string | undefined): void;
	destroy(): void;
};

export type PairingMountOptions = {
	initialConnected?: boolean;
	findPort?: () => Promise<number | undefined>;
	onDaemon?(reachable: boolean): void;
};

export type PairingMount = (
	host: HTMLElement,
	options: PairingMountOptions,
) => PairingControl;

export type PositionArea = {
	get(keys: null): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string[]): Promise<void>;
};

const POSITIONS_KEY = "chat_canvas_positions";

export function memoryStorage(): PageStorage {
	const entries = new Map<string, string>();
	return {
		get: (key) => entries.get(key) ?? null,
		set: (key, value) => {
			entries.set(key, value);
		},
		remove: (key) => {
			entries.delete(key);
		},
	};
}

export function browserStorage(storage: Storage): PageStorage {
	const refused = new Map<string, string>();
	return {
		get(key) {
			const kept = refused.get(key);
			if (kept !== undefined) return kept;
			try {
				return storage.getItem(key);
			} catch {
				return null;
			}
		},
		set(key, value) {
			try {
				storage.setItem(key, value);
				refused.delete(key);
			} catch {
				refused.set(key, value);
			}
		},
		remove(key) {
			refused.delete(key);
			try {
				storage.removeItem(key);
			} catch {
				refused.set(key, "");
			}
		},
	};
}

function readRecord(storage: PageStorage): Record<string, unknown> {
	const raw = storage.get(POSITIONS_KEY);
	if (raw === null) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export function positionAreaFor(storage: PageStorage): PositionArea {
	const write = (record: Record<string, unknown>) =>
		storage.set(POSITIONS_KEY, JSON.stringify(record));
	return {
		get: () => Promise.resolve(readRecord(storage)),
		set(items) {
			write({ ...readRecord(storage), ...items });
			return Promise.resolve();
		},
		remove(keys) {
			const record = readRecord(storage);
			for (const key of keys) delete record[key];
			write(record);
			return Promise.resolve();
		},
	};
}
