import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { InboxBrowserRequest } from "@dg/common";
import { fixturePath } from "../../../test/fixture-paths";
import {
	executeProtonPage,
	type ProtonPageContext,
} from "../page-operations";

type Dataset = {
	folders: { id: string; name: string; type: string; total: number; unread: number }[];
	filters: { id: string; name: string; enabled: boolean; conditions: string[] }[];
	messages: {
		id: string;
		from: string;
		senderName: string;
		subject: string;
		snippet: string;
		folderId: string;
		receivedAt: string;
	}[];
};

const dataset: Dataset = JSON.parse(readFileSync(fixturePath("proton-dataset.json"), "utf8"));
const headers = { uid: "fixture-session-uid", appVersion: "web-mail@5.0.0" };

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function protonApi(dataset: Dataset) {
	const customFolders = dataset.folders.filter((folder) => folder.type === "folder");
	const calls: { path: string; method: string; body?: unknown }[] = [];
	const fetch: ProtonPageContext["fetch"] = async (input, init) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/api\//, "");
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path, method, body });
		if (path === "core/v4/labels")
			return json({
				Code: 1000,
				Labels:
					url.searchParams.get("Type") === "3"
						? customFolders.map((folder) => ({
								ID: folder.id,
								Name: folder.name,
								Type: 3,
							}))
						: [],
			});
		if (path === "mail/v4/messages/count")
			return json({
				Code: 1000,
				Counts: dataset.folders.map((folder) => ({
					LabelID: folder.id,
					Total: folder.total,
					Unread: folder.unread,
				})),
			});
		if (path === "mail/v4/filters" && method === "GET")
			return json({
				Code: 1000,
				Filters: dataset.filters.map((filter) => ({
					ID: filter.id,
					Name: filter.name,
					Status: filter.enabled ? 1 : 0,
					Sieve: filter.conditions.join(" "),
				})),
			});
		if (path === "mail/v4/filters" && method === "POST")
			return json({
				Code: 1000,
				Filter: { ID: "filter-new", ...(body as object), Status: 1 },
			});
		if (path === "mail/v4/messages" && method === "GET") {
			const folder = url.searchParams.get("LabelID");
			const messages = dataset.messages.filter(
				(message) => message.folderId === folder,
			);
			return json({
				Code: 1000,
				Total: messages.length,
				Messages: messages.map((message) => ({
					ID: message.id,
					Sender: { Address: message.from, Name: message.senderName },
					Subject: message.subject,
					Context: message.snippet,
					LabelIDs: [message.folderId],
					Unread: 1,
					Time: Date.parse(message.receivedAt) / 1000,
				})),
			});
		}
		if (path === "mail/v4/messages/label" && method === "PUT")
			return json({
				Code: 1001,
				Responses: (body as { IDs: string[] }).IDs.map((ID) => ({
					ID,
					Response: { Code: 1000 },
				})),
			});
		return new Response("{}", { status: 404 });
	};
	return { fetch, calls };
}

function run(request: InboxBrowserRequest) {
	const api = protonApi(dataset);
	const context: ProtonPageContext = {
		origin: "https://mail.proton.me",
		headers,
		fetch: api.fetch,
	};
	return executeProtonPage(request, context).then((result) => ({
		result,
		calls: api.calls,
	}));
}

describe("page-operations executeProtonPage against the recorded Proton dataset", () => {
	test("list-folders returns every dataset folder with its counts", async () => {
		const { result } = await run({ operation: "list-folders" });
		for (const expected of dataset.folders) {
			expect(result.folders).toContainEqual(
				expect.objectContaining({
					name: expected.name,
					...(expected.type === "folder"
						? { id: expected.id, total: expected.total, unread: expected.unread }
						: {}),
				}),
			);
		}
	});

	test("list-messages returns the dataset inbox messages with the redacted subject and snippet", async () => {
		const { result } = await run({
			operation: "list-messages",
			folderId: "inbox",
			page: 0,
			pageSize: 50,
		});
		const expected = dataset.messages.filter((m) => m.folderId === "inbox");
		expect(result.messages?.map((message) => message.id)).toEqual(
			expected.map((message) => message.id),
		);
		const redacted: Record<string, { subject: string; snippet: string }> = {
			"msg-1": {
				subject: "Receipt for payment 123456",
				snippet: "Payment received for invoice 987654 from [email:example.com].",
			},
			"msg-2": {
				subject: "Monthly statement",
				snippet: "Your account statement is ready.",
			},
			"msg-3": {
				subject: "Project follow up",
				snippet: "Following up on the project notes.",
			},
		};
		for (const [index, message] of expected.entries()) {
			expect(result.messages?.[index]).toMatchObject({
				id: message.id,
				subject: redacted[message.id]!.subject,
				snippet: redacted[message.id]!.snippet,
				senderName: message.senderName,
				folderId: message.folderId,
			});
		}
		expect(JSON.stringify(result)).not.toContain("jane@example.com");
		expect(result.hasMore).toBe(false);
	});

	test("list-filters returns the dataset filters", async () => {
		const { result } = await run({ operation: "list-filters" });
		expect(result.filters).toEqual(
			dataset.filters.map((filter) =>
				expect.objectContaining({
					id: filter.id,
					name: filter.name,
					enabled: filter.enabled,
				}),
			),
		);
	});

	test("move-messages sends one label call with every requested message and returns an empty result", async () => {
		const ids = dataset.messages.slice(0, 2).map((message) => message.id);
		const { result, calls } = await run({
			operation: "move-messages",
			messageIds: ids,
			targetFolderId: "receipts",
		});
		expect(result).toEqual({});
		expect(calls).toEqual([
			{
				path: "mail/v4/messages/label",
				method: "PUT",
				body: { IDs: ids, LabelID: "receipts" },
			},
		]);
	});

	test("create-filter posts the sieve and returns the created filter", async () => {
		const sieve = 'require ["fileinto"]; if address :is "from" "a@b.test" { fileinto "Receipts"; }';
		const { result, calls } = await run({
			operation: "create-filter",
			name: "Receipts",
			sieve,
		});
		expect(calls[0]).toMatchObject({
			path: "mail/v4/filters",
			method: "POST",
			body: { Name: "Receipts", Sieve: sieve },
		});
		expect(result.filter).toMatchObject({ id: "filter-new", name: "Receipts" });
	});

	test("refuses to run without observed session headers", async () => {
		const api = protonApi(dataset);
		await expect(
			executeProtonPage(
				{ operation: "list-folders" },
				{ origin: "https://mail.proton.me", fetch: api.fetch },
			),
		).rejects.toThrow();
		expect(api.calls).toHaveLength(0);
	});
});

describe("page-entry", () => {
	test("paces the requests inside list-folders like the extension", async () => {
		const api = protonApi(dataset);
		const globals = globalThis as Record<string, unknown>;
		const saved = { fetch: globals.fetch, location: globals.location };
		const delays: number[] = [];
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms?: number,
		) => {
			delays.push(ms ?? 0);
			callback();
			return 0;
		}) as never);
		try {
			globals.fetch = api.fetch;
			globals.location = {
				origin: "https://mail.proton.me",
				pathname: "/u/0/inbox",
			};
			await import("../page-entry");
			const runPage = globals.__dgProtonRun as (call: unknown) => Promise<unknown>;
			const result = await runPage({
				request: { operation: "list-folders" },
				headers,
				account: "0",
			});
			expect(result).toHaveProperty("folders");
			expect(api.calls.length).toBeGreaterThan(1);
			expect(delays.filter((ms) => ms >= 320).length).toBeGreaterThanOrEqual(
				api.calls.length - 1,
			);
		} finally {
			timers.mockRestore();
			globals.fetch = saved.fetch;
			globals.location = saved.location;
		}
	});

	test("refuses to run when the page path is not the resolved account", async () => {
		const api = protonApi(dataset);
		const globals = globalThis as Record<string, unknown>;
		const saved = { fetch: globals.fetch, location: globals.location };
		try {
			globals.fetch = api.fetch;
			globals.location = {
				origin: "https://mail.proton.me",
				pathname: "/u/1/inbox",
			};
			await import("../page-entry");
			const runPage = globals.__dgProtonRun as (call: unknown) => Promise<unknown>;
			const result = await runPage({
				request: { operation: "list-folders" },
				headers,
				account: "0",
			});
			expect(result).toEqual({ error: { code: "account-mismatch" } });
			expect(api.calls).toHaveLength(0);
		} finally {
			globals.fetch = saved.fetch;
			globals.location = saved.location;
		}
	});
});
