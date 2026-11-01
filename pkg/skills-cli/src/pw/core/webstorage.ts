import type { Page } from "playwright-core";

export type StorageKind = "localStorage" | "sessionStorage";

type WebStorage = {
	length: number;
	key(index: number): string | null;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	clear(): void;
};

export type StorageEntry = [key: string, value: string];

export const storageList = (page: Page, kind: StorageKind): Promise<StorageEntry[]> =>
	page.evaluate((name: StorageKind) => {
		const store = (globalThis as unknown as Record<StorageKind, WebStorage>)[name];
		const entries: [string, string][] = [];
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i) as string;
			entries.push([key, store.getItem(key) as string]);
		}
		return entries;
	}, kind);

export const storageGet = (page: Page, kind: StorageKind, key: string): Promise<string | null> =>
	page.evaluate<string | null, [StorageKind, string]>(
		([name, item]) => (globalThis as unknown as Record<StorageKind, WebStorage>)[name].getItem(item),
		[kind, key],
	);

export const storageSet = (page: Page, kind: StorageKind, key: string, value: string): Promise<void> =>
	page.evaluate<void, [StorageKind, string, string]>(
		([name, item, text]) => (globalThis as unknown as Record<StorageKind, WebStorage>)[name].setItem(item, text),
		[kind, key, value],
	);

export const storageDelete = (page: Page, kind: StorageKind, key: string): Promise<void> =>
	page.evaluate<void, [StorageKind, string]>(
		([name, item]) => (globalThis as unknown as Record<StorageKind, WebStorage>)[name].removeItem(item),
		[kind, key],
	);

export const storageClear = (page: Page, kind: StorageKind): Promise<void> =>
	page.evaluate((name: StorageKind) => (globalThis as unknown as Record<StorageKind, WebStorage>)[name].clear(), kind);

export function formatEntries(kind: StorageKind, entries: StorageEntry[]): string {
	if (entries.length === 0) return `No ${kind} items found`;
	return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}
