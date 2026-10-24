import { describe, expect, test } from "bun:test";
import type { InboxBrowserResponse } from "@dg/common";
import { defaultConfig } from "../../config/defaults";
import { ProtonGate, type Clock } from "../../features/filter-policy/jitter";
import { ExtensionProtonMailClient } from "../extension-client";

function client(input: {
	burstBudget?: number;
	browserRequest: (request: { operation: string; page?: number; id?: string; name?: string; parentId?: string }) => Promise<unknown>;
}) {
	const sleeps: number[] = [];
	let active = 0;
	let maxActive = 0;
	const clock: Clock = {
		now: () => 0,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	const pace = new ProtonGate(clock, () => 0.1, input.burstBudget ?? 5);
	const proton = new ExtensionProtonMailClient({
		config: defaultConfig,
		pace,
		browserRequest: async (request) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			try {
				return (await input.browserRequest(request)) as InboxBrowserResponse;
			} finally {
				active -= 1;
			}
		},
	});
	return {
		proton,
		sleeps,
		maxActive: () => maxActive,
	};
}

describe("live Proton pacing", () => {
	test("serializes parallel reads and pages with irregular gaps", async () => {
		let pages = 0;
		const harness = client({
			browserRequest: async (request) => {
				if (request.operation === "list-folders") return { folders: [] };
				if (request.operation === "list-filters") return { filters: [] };
				pages += 1;
				return {
					messages: [
						{
							id: `m-${pages}`,
							subject: "Hello",
							from: "a@example.test",
							snippet: "Preview",
							folderId: "inbox",
						},
					],
					hasMore: pages < 2,
				};
			},
		});
		await Promise.all([
			harness.proton.listFolders(),
			harness.proton.listFilters(),
		]);
		expect(harness.maxActive()).toBe(1);
		expect(harness.sleeps).toHaveLength(1);
		expect(harness.sleeps[0]).toBeGreaterThan(0);
		const before = harness.sleeps.length;
		const rows: unknown[] = [];
		for await (const page of harness.proton.listMessagesStream({
			folderId: "inbox",
			limit: 2,
		})) {
			rows.push(page);
		}
		expect(rows).toHaveLength(2);
		expect(harness.sleeps.length).toBeGreaterThan(before);
		expect(harness.maxActive()).toBe(1);
	});

	test("retries a rate-limited read and does not retry a rejected rename", async () => {
		let reads = 0;
		const limited = client({
			browserRequest: async () => {
				reads += 1;
				if (reads < 3) {
					throw new Error(
						"Proton API request failed. Check the mail tab and retry after any rate limit clears. (HTTP 429; http-failure)",
					);
				}
				return { filters: [] };
			},
		});
		await expect(limited.proton.listFilters()).resolves.toEqual([]);
		expect(reads).toBe(3);
		expect(limited.sleeps).toHaveLength(2);
		expect(limited.sleeps[0]).not.toBe(limited.sleeps[1]);

		let writes = 0;
		const rejected = client({
			browserRequest: async (request) => {
				writes += 1;
				expect(request.parentId).toBeUndefined();
				throw new Error(
					"Proton API request failed. (HTTP 429; http-failure)",
				);
			},
		});
		await expect(
			rejected.proton.renameFolder({ id: "child", displayName: "receipts", path: "fin/receipts" }),
		).rejects.toThrow(/429/);
		expect(writes).toBe(1);
		expect(rejected.sleeps).toEqual([]);
	});
});
