import { printJson } from "../../cli/output";
import { resolveFolder } from "../../workspace/folders";
import { describe, expect, spyOn, test } from "bun:test";
import { defaultConfig } from "../../config/defaults";
import { StaticMicrosoftTokenProvider } from "../auth";
import { GraphRestClient } from "../graph-client";

describe("Outlook Graph client", () => {
	test("maps paginated Graph messages without exposing auth tokens", async () => {
		const urls: string[] = [];
		const client = new GraphRestClient({
			config: {
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					graphBaseUrl: "https://graph.test",
					pageSize: 2,
				},
			},
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string, init?: RequestInit) => {
				urls.push(url);
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer secret-token",
				);
				if (url.includes("next")) {
					return Response.json({
						value: [
							{
								id: "m2",
								from: {
									emailAddress: {
										name: "Second Sender",
										address: "second@contoso.com",
									},
								},
								subject: "Second",
								bodyPreview: "Preview 2",
								parentFolderId: "inbox",
							},
						],
					});
				}
				return Response.json({
					value: [
						{
							id: "m1",
							from: {
								emailAddress: {
									name: "First Sender",
									address: "first@contoso.com",
								},
							},
							subject: "First",
							bodyPreview: "Preview 1",
							parentFolderId: "inbox",
						},
					],
					"@odata.nextLink": "https://graph.test/next",
				});
			}) as typeof fetch,
		});

		const messages = await client.listMessages({ folderId: "inbox", limit: 2 });
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			id: "m1",
			folderId: "inbox",
			from: "First Sender <first@contoso.com>",
		});
		expect(urls[0]).toContain("$top=2");
	});

	test("streams one mapped page per Graph page so batch can overlap fetch and write", async () => {
		const client = new GraphRestClient({
			config: {
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					graphBaseUrl: "https://graph.test",
					pageSize: 1,
				},
			},
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				if (url.includes("next")) {
					return Response.json({
						value: [
							{
								id: "m2",
								from: { emailAddress: { address: "second@contoso.com" } },
								subject: "Second",
								parentFolderId: "inbox",
							},
						],
					});
				}
				return Response.json({
					value: [
						{
							id: "m1",
							from: { emailAddress: { address: "first@contoso.com" } },
							subject: "First",
							parentFolderId: "inbox",
						},
					],
					"@odata.nextLink": "https://graph.test/next",
				});
			}) as typeof fetch,
		});

		const pages: string[][] = [];
		for await (const page of client.listMessagesStream({
			folderId: "inbox",
			limit: 5,
		})) {
			pages.push(page.map((message) => message.id));
		}
		expect(pages).toEqual([["m1"], ["m2"]]);
	});

	test("derives folder aliases and parent paths", async () => {
		const urls: string[] = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				urls.push(url);
				return Response.json({
					value: [
						{ id: "archive", displayName: "Archive" },
						{
							id: "receipts",
							displayName: "Receipts",
							parentFolderId: "archive",
						},
					],
				});
			}) as unknown as typeof fetch,
		});

		const folders = await client.listFolders();
		expect(urls[0]).not.toContain("wellKnownName");
		expect(
			folders.find((folder) => folder.id === "archive")?.aliases,
		).toContain("archive");
		expect(folders.find((folder) => folder.id === "receipts")?.path).toBe(
			"Archive/Receipts",
		);
	});

	test("recursively loads child folders", async () => {
		const urls: string[] = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				urls.push(url);
				if (url.includes("/mailFolders/root/childFolders")) {
					return Response.json({
						value: [
							{
								id: "updates",
								displayName: "Updates",
								parentFolderId: "root",
								childFolderCount: 1,
								totalItemCount: 4,
							},
						],
					});
				}
				if (url.includes("/mailFolders/updates/childFolders")) {
					return Response.json({
						value: [
							{
								id: "kickstarter",
								displayName: "Kickstarter",
								parentFolderId: "updates",
								childFolderCount: 0,
								totalItemCount: 2,
							},
						],
					});
				}
				return Response.json({
					value: [
						{
							id: "root",
							displayName: "_",
							childFolderCount: 1,
							totalItemCount: 0,
						},
					],
				});
			}) as unknown as typeof fetch,
		});

		const folders = await client.listFolders();
		expect(
			urls.some((url) => url.includes("/mailFolders/root/childFolders")),
		).toBe(true);
		expect(
			urls.some((url) => url.includes("/mailFolders/updates/childFolders")),
		).toBe(true);
		expect(folders.find((folder) => folder.id === "updates")).toMatchObject({
			path: "_/Updates",
			total: 4,
		});
		expect(folders.find((folder) => folder.id === "kickstarter")).toMatchObject(
			{ path: "_/Updates/Kickstarter", total: 2 },
		);
	});

	test("loads Outlook master categories as labels", async () => {
		const urls: string[] = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				urls.push(url);
				return Response.json({
					value: [
						{ id: "cat-1", displayName: "Project Alpha", color: "preset1" },
						{ id: "cat-2", displayName: "Support", color: "preset2" },
					],
				});
			}) as unknown as typeof fetch,
		});

		const labels = await client.listLabels();
		expect(urls).toEqual([
			"https://graph.microsoft.com/v1.0/me/outlook/masterCategories",
		]);
		expect(labels).toEqual([
			{
				id: "cat-1",
				name: "Project Alpha",
				color: "preset1",
				type: "category",
			},
			{ id: "cat-2", name: "Support", color: "preset2", type: "category" },
		]);
	});

	test("promotes a nested folder to top level and renames it via Graph", async () => {
		const requests: Array<{ url: string; method: string; body: string }> = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string, init?: RequestInit) => {
				requests.push({
					url,
					method: init?.method ?? "GET",
					body: String(init?.body ?? ""),
				});
				return Response.json({
					id: "projects",
					displayName: "Project",
					parentFolderId: "msgfolderroot",
				});
			}) as typeof fetch,
		});

		await client.moveFolder({ id: "projects", destinationId: "msgfolderroot" });
		await client.renameFolder({ id: "projects", displayName: "Project" });

		expect(requests[0]).toMatchObject({
			url: "https://graph.microsoft.com/v1.0/me/mailFolders/projects/move",
			method: "POST",
		});
		expect(JSON.parse(requests[0].body)).toEqual({
			destinationId: "msgfolderroot",
		});
		expect(requests[1]).toMatchObject({
			url: "https://graph.microsoft.com/v1.0/me/mailFolders/projects",
			method: "PATCH",
		});
		expect(JSON.parse(requests[1].body)).toEqual({ displayName: "Project" });
	});

	test("accepts empty successful move and read-state responses", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string, init?: RequestInit) => {
				requests.push({ url, method: init?.method ?? "GET" });
				return new Response("", { status: url.endsWith("/move") ? 200 : 204 });
			}) as typeof fetch,
		});

		await client.moveMessages({
			messageIds: ["m1"],
			targetFolderId: "archive",
		});
		await client.markMessagesRead({ messageIds: ["m1"] });

		expect(requests).toEqual([
			{
				url: "https://graph.microsoft.com/v1.0/me/messages/m1/move",
				method: "POST",
			},
			{
				url: "https://graph.microsoft.com/v1.0/me/messages/m1",
				method: "PATCH",
			},
		]);
	});
});

describe("GraphRestClient private mailbox metadata", () => {
	function metadataFixture() {
		const names = [
			"first-private@example.test",
			"second-private@example.test",
			"Shared/" + "x".repeat(160) + "A",
			"Shared/" + "x".repeat(160) + "B",
		];
		const values = names.map((displayName, index) => ({
			id: "metadata-" + index,
			displayName,
		}));
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("synthetic-token"),
			fetch: (async (_input: RequestInfo | URL) =>
				Response.json({ value: values })) as typeof fetch,
		});
		return { names, values, client };
	}
	test("preserves exact live folder names and paths that collide after redaction or truncation", async () => {
		const { names, values, client } = metadataFixture();
		const folders = await client.listFolders();
		expect(folders.map((folder) => folder.name)).toEqual(names);
		expect(folders.map((folder) => folder.path)).toEqual(names);
		for (const row of values)
			expect(
				resolveFolder(folders, row.displayName, { purpose: "target" }).id,
			).toBe(row.id);
		const output = spyOn(console, "log").mockImplementation(() => {});
		try {
			printJson({ folders });
			const publicText = output.mock.calls
				.map((args) => args.join(" "))
				.join("\n");
			for (const name of names.slice(0, 2))
				expect(publicText).not.toContain(name);
			expect(
				JSON.parse(publicText).folders.map(
					(folder: { id: string }) => folder.id,
				),
			).toEqual(values.map((row) => row.id));
			expect(folders.map((folder) => folder.name)).toEqual(names);
		} finally {
			output.mockRestore();
		}
	});
	test("preserves private category and rule names while scrubbing their public representation", async () => {
		const { names, values, client } = metadataFixture();
		const labels = await client.listLabels();
		const filters = await client.listFilters();
		expect(labels.map((label) => label.name)).toEqual(names);
		expect(filters.map((filter) => filter.name)).toEqual(names);
		const output = spyOn(console, "log").mockImplementation(() => {});
		try {
			printJson({ labels, filters });
			const publicText = output.mock.calls
				.map((args) => args.join(" "))
				.join("\n");
			for (const name of names.slice(0, 2))
				expect(publicText).not.toContain(name);
			expect(
				JSON.parse(publicText).labels.map((label: { id: string }) => label.id),
			).toEqual(values.map((row) => row.id));
			expect(labels.map((label) => label.name)).toEqual(names);
			expect(filters.map((filter) => filter.name)).toEqual(names);
		} finally {
			output.mockRestore();
		}
	});
});

describe("GraphRestClient immutable message identity", () => {
	test("keeps the listed message addressable for its read-state update after moving folders", async () => {
		const mailbox = {
			id: "original-message",
			parentFolderId: "inbox",
			isRead: false,
		};
		const requests: Array<{
			method: string;
			path: string;
			prefer: string | null;
		}> = [];
		const client = new GraphRestClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("synthetic-token"),
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				const method = init?.method ?? "GET";
				const prefer = new Headers(init?.headers).get("prefer");
				requests.push({ method, path, prefer });
				if (method === "GET" && path.endsWith("/mailFolders/inbox/messages"))
					return Response.json({ value: [{ ...mailbox }] });
				if (
					method === "POST" &&
					path === "/v1.0/me/messages/" + mailbox.id + "/move"
				) {
					mailbox.parentFolderId = JSON.parse(String(init?.body)).destinationId;
					if (prefer !== 'IdType="ImmutableId"')
						mailbox.id = "changed-after-move";
					return Response.json({ ...mailbox });
				}
				if (method === "PATCH" && path === "/v1.0/me/messages/" + mailbox.id) {
					mailbox.isRead = JSON.parse(String(init?.body)).isRead;
					return new Response(null, { status: 204 });
				}
				return Response.json(
					{ error: { code: "ErrorItemNotFound" } },
					{ status: 404 },
				);
			}) as typeof fetch,
		});
		const listed = await client.listMessages({ folderId: "inbox", limit: 1 });
		expect(listed).toHaveLength(1);
		const messageIds = listed.map((message) => message.id);
		await client.moveMessages({ messageIds, targetFolderId: "receipts" });
		await client.markMessagesRead({ messageIds });
		expect(mailbox).toMatchObject({
			id: messageIds[0],
			parentFolderId: "receipts",
			isRead: true,
		});
		expect(requests.map((request) => request.method)).toEqual([
			"GET",
			"POST",
			"PATCH",
		]);
		expect(requests.map((request) => request.prefer)).toEqual(
			Array(3).fill('IdType="ImmutableId"'),
		);
	});
});
