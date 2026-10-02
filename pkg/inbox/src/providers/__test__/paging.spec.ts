import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/defaults";
import { StaticGoogleTokenProvider } from "../../gmail/auth";
import { FileBackedGmailClient } from "../../gmail/file-client";
import { GmailRestClient } from "../../gmail/rest-client";
import { StaticMicrosoftTokenProvider } from "../../outlook/auth";
import { FileBackedOutlookClient } from "../../outlook/file-client";
import { GraphRestClient } from "../../outlook/graph-client";
import { ExtensionProtonMailClient } from "../../protonmail/extension-client";
import { FileBackedProtonMailClient } from "../../protonmail/file-client";
import type {
	MailDataset,
	MailMessageSummary,
	MailProviderClient,
} from "../types";

const providers = ["gmail", "outlook", "protonmail"] as const;
type Provider = (typeof providers)[number];
type Behavior =
	| "normal"
	| "empty"
	| "error"
	| "stalled"
	| "gap"
	| "overlap"
	| "mixed"
	| "repeat"
	| "repeat-terminal"
	| "empty-streak";
const secret = "synthetic-auth-token-never-output";

function message(index: number): MailMessageSummary {
	return {
		id: `message-${index}`,
		from: "sender@example.test",
		subject: `Subject ${index}`,
		snippet: "Preview",
		folderId: "inbox",
	};
}

function dataset(count: number): MailDataset {
	return {
		folders: [{ id: "inbox", name: "Inbox", type: "system" }],
		filters: [],
		messages: Array.from({ length: count }, (_, index) => message(index)),
	};
}

function liveClient(provider: Provider, behavior: Behavior = "normal") {
	const calls: Array<{ page: number; pageSize: number }> = [];
	let active = 0;
	let maximumActive = 0;
	let metadataCalls = 0;
	const pageCount = behavior === "overlap" ? 4 : behavior === "mixed" ? 3 : 2;
	const rows = (page: number) => {
		if (behavior === "empty-streak") {
			if (page >= 5)
				throw new Error("Provider page budget exceeded in test fixture");
			return [];
		}
		const indexes =
			behavior === "overlap"
				? [
						[0, 1],
						[1, 2],
						[2, 3],
						[4, 5],
					]
				: behavior === "mixed"
					? [
							[0, 0],
							[0, 1],
							[1, 2],
						]
					: behavior === "repeat" || behavior === "repeat-terminal"
						? [
								[0, 1],
								[0, 1],
							]
						: undefined;
		if (indexes) return (indexes[page] ?? []).map(message);
		if (behavior === "empty" && page > 0) return [];
		if (behavior === "gap" && page === 0) return [];
		return [message(page * 2), message(page * 2 + 1)];
	};
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		const id = url.pathname.match(/\/messages\/(message-\d+)$/)?.[1];
		if (provider === "gmail" && id) {
			metadataCalls += 1;
			maximumActive = Math.max(maximumActive, ++active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active -= 1;
			return Response.json({
				id,
				labelIds: ["inbox"],
				payload: { headers: [{ name: "From", value: "sender@example.test" }] },
				body: { data: "raw-body-never-output" },
			});
		}
		const page = Number(
			url.searchParams.get("pageToken") ?? url.searchParams.get("page") ?? 0,
		);
		calls.push({
			page,
			pageSize: Number(
				url.searchParams.get("maxResults") ?? url.searchParams.get("$top"),
			),
		});
		if (behavior === "error" && page > 0)
			return Response.json({ error: { message: secret } }, { status: 401 });
		const items = rows(page);
		const next =
			behavior === "stalled"
				? "1"
				: behavior === "repeat" ||
					  behavior === "empty-streak" ||
					  page < pageCount - 1
					? String(page + 1)
					: undefined;
		return provider === "gmail"
			? Response.json({
					messages: items.map((row) => ({ id: row.id })),
					nextPageToken: next,
				})
			: Response.json({
					value: items.map((row) => ({
						id: row.id,
						subject: row.subject,
						parentFolderId: row.folderId,
						body: { content: "raw-body-never-output" },
					})),
					"@odata.nextLink": next
						? `https://graph.test/messages?page=${next}&$top=2`
						: undefined,
				});
	}) as typeof fetch;
	const config = {
		...defaultConfig,
		provider,
		gmail: { ...defaultConfig.gmail, pageSize: 2, maxConcurrency: 2 },
		outlook: {
			...defaultConfig.outlook,
			pageSize: 2,
			graphBaseUrl: "https://graph.test",
		},
		protonmail: { ...defaultConfig.protonmail, batchSize: 2 },
	};
	let client: MailProviderClient;
	if (provider === "gmail")
		client = new GmailRestClient({
			config,
			tokenProvider: new StaticGoogleTokenProvider(secret),
			fetch: fetchImpl,
		});
	else if (provider === "outlook")
		client = new GraphRestClient({
			config,
			tokenProvider: new StaticMicrosoftTokenProvider(secret),
			fetch: fetchImpl,
		});
	else
		client = new ExtensionProtonMailClient({
			config,
			browserRequest: async (request) => {
				const page = request.page ?? 0;
				calls.push({ page, pageSize: request.pageSize ?? 0 });
				if (behavior === "error" && page > 0)
					throw new Error("Proton extension session expired; sign in again.");
				return {
					messages: rows(behavior === "stalled" ? 0 : page),
					hasMore:
						behavior === "mixed"
							? undefined
							: behavior === "stalled" ||
								behavior === "repeat" ||
								behavior === "empty-streak" ||
								page < pageCount - 1,
				};
			},
		});
	return {
		client,
		calls,
		get maximumActive() {
			return maximumActive;
		},
		get metadataCalls() {
			return metadataCalls;
		},
	};
}

async function collect(
	client: MailProviderClient,
	limit: number,
): Promise<MailMessageSummary[][]> {
	const pages: MailMessageSummary[][] = [];
	for await (const page of client.listMessagesStream!({
		folderId: "inbox",
		limit,
	}))
		pages.push(page);
	return pages;
}

for (const provider of providers)
	describe(`${provider} listMessagesStream`, () => {
		test("fetches a page on demand and stops fetching when the consumer returns", async () => {
			const harness = liveClient(provider);
			const stream = harness.client.listMessagesStream!({
				folderId: "inbox",
				limit: 9,
			})[Symbol.asyncIterator]();
			expect(harness.calls).toHaveLength(0);
			const first = await stream.next();
			expect(first.value.map((row: MailMessageSummary) => row.id)).toEqual([
				message(0).id,
				message(1).id,
			]);
			expect(harness.calls).toHaveLength(1);
			await stream.return?.();
			expect((await stream.next()).done).toBe(true);
			expect(harness.calls).toHaveLength(1);
			if (provider === "gmail") expect(harness.metadataCalls).toBe(2);
		});

		test("keeps page size fixed while trimming the final page to the total limit", async () => {
			const harness = liveClient(provider);
			const pages = await collect(harness.client, 3);
			expect(pages.map((page) => page.map((row) => row.id))).toEqual([
				[message(0).id, message(1).id],
				[message(2).id],
			]);
			expect(harness.calls.map((call) => call.pageSize)).toEqual([2, 2]);
			expect(JSON.stringify(pages)).not.toContain(secret);
			expect(JSON.stringify(pages)).not.toContain("raw-body-never-output");
		});

		test("skips overlapping rows lazily and fills the limit with unique messages", async () => {
			const harness = liveClient(provider, "overlap");
			const iterator = harness.client.listMessagesStream!({
				folderId: "inbox",
				limit: 4,
			})[Symbol.asyncIterator]();
			expect(harness.calls).toEqual([]);
			expect(
				(await iterator.next()).value.map((row: MailMessageSummary) => row.id),
			).toEqual([message(0).id, message(1).id]);
			expect(harness.calls).toHaveLength(1);
			expect(
				(await iterator.next()).value.map((row: MailMessageSummary) => row.id),
			).toEqual([message(2).id]);
			expect(harness.calls).toHaveLength(2);
			expect(
				(await iterator.next()).value.map((row: MailMessageSummary) => row.id),
			).toEqual([message(3).id]);
			expect((await iterator.next()).done).toBe(true);
			expect(harness.calls).toEqual(
				[0, 1, 2].map((page) => ({ page, pageSize: 2 })),
			);
			if (provider === "gmail") expect(harness.metadataCalls).toBe(4);
		});

		test("skips duplicates within and across pages without treating a short unique page as terminal", async () => {
			const harness = liveClient(provider, "mixed");
			expect(
				(await collect(harness.client, 3)).flat().map((row) => row.id),
			).toEqual([0, 1, 2].map((index) => message(index).id));
			expect(harness.calls).toEqual(
				[0, 1, 2].map((page) => ({ page, pageSize: 2 })),
			);
			if (provider === "gmail") expect(harness.metadataCalls).toBe(3);
		});

		test("rejects a nonempty page with no new IDs and further pages available", async () => {
			const harness = liveClient(provider, "repeat");
			await expect(collect(harness.client, 20)).rejects.toThrow(
				/stall|repeat|duplicate|progress/i,
			);
			expect(harness.calls).toHaveLength(2);
		});

		test("ends a terminal duplicate page without emitting the same messages again", async () => {
			const harness = liveClient(provider, "repeat-terminal");
			expect(
				(await collect(harness.client, 20)).flat().map((row) => row.id),
			).toEqual([message(0).id, message(1).id]);
			expect(harness.calls).toHaveLength(2);
		});

		test("handles an empty subsequent page without emitting an empty work page", async () => {
			const harness = liveClient(provider, "empty");
			const pages = await collect(harness.client, 9);
			expect(pages).toHaveLength(1);
			expect(pages.flat().map((row) => row.id)).toEqual([
				message(0).id,
				message(1).id,
			]);
			expect(harness.calls).toHaveLength(2);
		});

		test("surfaces a later provider failure when the next page is requested", async () => {
			const harness = liveClient(provider, "error");
			const iterator = harness.client.listMessagesStream!({
				folderId: "inbox",
				limit: 9,
			})[Symbol.asyncIterator]();
			expect((await iterator.next()).value).toHaveLength(2);
			expect(harness.calls).toHaveLength(1);
			let error = "";
			try {
				await iterator.next();
			} catch (cause) {
				error = String(cause);
			}
			expect(error).toMatch(/auth|session|sign in|expired/i);
			expect(error).not.toContain(secret);
			expect(harness.calls).toHaveLength(2);
		});

		test("rejects a stalled page or cursor instead of silently duplicating messages", async () => {
			const harness = liveClient(provider, "stalled");
			await expect(collect(harness.client, 20)).rejects.toThrow(
				/stall|repeat|duplicate|cursor/i,
			);
			expect(harness.calls.length).toBeLessThanOrEqual(3);
		});

		test("bounds consecutive empty pages even when each cursor or hasMore advances", async () => {
			const harness = liveClient(provider, "empty-streak");
			await expect(collect(harness.client, 20)).rejects.toThrow(
				/stall|empty|progress/i,
			);
			expect(harness.calls.length).toBeLessThanOrEqual(4);
			if (provider === "gmail") expect(harness.metadataCalls).toBe(0);
		});

		test("does not contact the provider for a zero total limit", async () => {
			const harness = liveClient(provider);
			expect(await collect(harness.client, 0)).toEqual([]);
			expect(harness.calls).toEqual([]);
		});
	});

for (const provider of providers)
	test(
		provider +
			" listMessagesStream continues after an empty page with a valid cursor",
		async () => {
			const harness = liveClient(provider, "gap");
			expect(
				(await collect(harness.client, 9)).flat().map((row) => row.id),
			).toEqual([message(2).id, message(3).id]);
			expect(harness.calls.map((call) => call.page)).toEqual([0, 1]);
		},
	);

test("GmailRestClient finishes a satisfied unique limit without following an unused repeated cursor", async () => {
	const harness = liveClient("gmail", "stalled");
	expect(
		(await collect(harness.client, 3)).flat().map((row) => row.id),
	).toEqual([0, 1, 2].map((index) => message(index).id));
	expect(harness.calls.map((call) => call.page)).toEqual([0, 1]);
	expect(harness.metadataCalls).toBe(3);
});

describe("GmailRestClient metadata concurrency", () => {
	test("caps concurrent metadata requests at configured maxConcurrency", async () => {
		let active = 0;
		let maximum = 0;
		const count = 17;
		const client = new GmailRestClient({
			config: {
				...defaultConfig,
				gmail: { ...defaultConfig.gmail, pageSize: count, maxConcurrency: 2 },
			},
			tokenProvider: new StaticGoogleTokenProvider(secret),
			fetch: (async (input) => {
				const url = new URL(String(input));
				const id = url.pathname.match(/\/messages\/(message-\d+)$/)?.[1];
				if (!id)
					return Response.json({
						messages: dataset(count).messages.map((row) => ({ id: row.id })),
					});
				maximum = Math.max(maximum, ++active);
				await new Promise((resolve) => setTimeout(resolve, 2));
				active -= 1;
				return Response.json({ id });
			}) as typeof fetch,
		});
		const rows = (await collect(client, count)).flat();
		expect(rows.map((row) => row.id)).toEqual(
			dataset(count).messages.map((row) => row.id),
		);
		expect(maximum).toBeGreaterThan(0);
		expect(maximum).toBeLessThanOrEqual(2);
	});
});

describe("GraphRestClient nextLink", () => {
	test("rejects same-host cursors outside the configured API path, credentials, and insecure URLs", async () => {
		for (const cursor of [
			"https://graph.microsoft.com/collect",
			"https://graph.microsoft.com/v1.0-other/messages",
			"https://user:password@graph.microsoft.com/v1.0/me/messages",
			"http://graph.microsoft.com/v1.0/me/messages",
		]) {
			const requests: string[] = [];
			const client = new GraphRestClient({
				config: defaultConfig,
				tokenProvider: new StaticMicrosoftTokenProvider(secret),
				fetch: (async (input) => {
					requests.push(String(input));
					return Response.json({
						value: [{ id: "first" }],
						"@odata.nextLink": cursor,
					});
				}) as typeof fetch,
			});
			await expect(collect(client, 2)).rejects.toThrow(/untrusted.*nextLink/i);
			expect(requests).toHaveLength(1);
		}
	});

	test("disables redirect following before sending Graph bearer credentials", async () => {
		let redirect: RequestRedirect | undefined;
		const requests: string[] = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider(secret),
			fetch: (async (input, init) => {
				requests.push(String(input));
				redirect = init?.redirect;
				return new Response(null, {
					status: 302,
					headers: { location: "https://attacker.test/collect" },
				});
			}) as typeof fetch,
		});
		await expect(collect(client, 2)).rejects.toThrow(/HTTP 302/);
		expect(redirect).toBe("error");
		expect(requests).toHaveLength(1);
	});

	test("rejects a cursor on another origin before forwarding the bearer token", async () => {
		const urls: string[] = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider(secret),
			fetch: (async (input) => {
				urls.push(String(input));
				return Response.json({
					value: [{ id: "first" }],
					"@odata.nextLink": "https://attacker.test/collect",
				});
			}) as typeof fetch,
		});
		await expect(collect(client, 2)).rejects.toThrow(
			/origin|host|trusted|cursor|nextLink/i,
		);
		expect(urls).toHaveLength(1);
	});
});

const fileClients = {
	protonmail: (
		input: ConstructorParameters<typeof FileBackedProtonMailClient>[0],
	) => new FileBackedProtonMailClient(input),
	gmail: (input: ConstructorParameters<typeof FileBackedGmailClient>[0]) =>
		new FileBackedGmailClient(input),
	outlook: (input: ConstructorParameters<typeof FileBackedOutlookClient>[0]) =>
		new FileBackedOutlookClient(input),
};
for (const provider of providers)
	describe(`${provider} file-backed listMessagesStream`, () => {
		test("yields bounded pages for 3,007 messages without skipped or duplicated ids", async () => {
			const fixture = dataset(3007);
			const pages = await collect(
				fileClients[provider]({ dataset: fixture }),
				fixture.messages.length,
			);
			expect(pages.length).toBeGreaterThan(1);
			expect(
				pages.every(
					(page) => page.length > 0 && page.length < fixture.messages.length,
				),
			).toBe(true);
			expect(pages.flat().map((row) => row.id)).toEqual(
				fixture.messages.map((row) => row.id),
			);
		});

		test("honors boundary limits and an empty dataset", async () => {
			for (const limit of [0, 1, 199, 200, 201, 301]) {
				const fixture = dataset(301);
				expect(
					(await collect(fileClients[provider]({ dataset: fixture }), limit))
						.flat()
						.map((row) => row.id),
				).toEqual(fixture.messages.slice(0, limit).map((row) => row.id));
			}
			expect(
				await collect(fileClients[provider]({ dataset: dataset(0) }), 10),
			).toEqual([]);
		});

		test("defers a missing dataset error until iteration and can be returned early", async () => {
			const missing = fileClients[provider]({
				dataPath: `/tmp/missing-inbox-${crypto.randomUUID()}.json`,
			});
			const stream = missing
				.listMessagesStream({ limit: 1 })
				[Symbol.asyncIterator]();
			await expect(stream.next()).rejects.toThrow(/not found|ENOENT/i);
			const client = fileClients[provider]({ dataset: dataset(301) });
			const iterator = client.listMessagesStream!({ limit: 301 })[
				Symbol.asyncIterator
			]();
			expect((await iterator.next()).value.length).toBeGreaterThan(0);
			await iterator.return?.(undefined);
			expect((await iterator.next()).done).toBe(true);
		});
	});
