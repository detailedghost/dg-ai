import { printJson } from "../../cli/output";
import { resolveFolder } from "../../workspace/folders";
import { describe, expect, spyOn, test } from "bun:test";
import { defaultConfig } from "../../config/defaults";
import { StaticGoogleTokenProvider } from "../auth";
import { FileBackedGmailClient } from "../file-client";
import { GmailRestClient } from "../rest-client";

describe("Gmail clients", () => {
	test("maps paginated Gmail metadata without persisting bodies", async () => {
		const urls: string[] = [];
		const client = new GmailRestClient({
			config: {
				...defaultConfig,
				provider: "gmail",
				gmail: { ...defaultConfig.gmail, pageSize: 1 },
			},
			tokenProvider: new StaticGoogleTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				urls.push(url);
				if (url.includes("/messages/m1?")) {
					return Response.json({
						id: "m1",
						threadId: "t1",
						labelIds: ["INBOX", "UNREAD"],
						snippet: "Project update",
						internalDate: "1710000000000",
						payload: {
							headers: [
								{ name: "From", value: "Creator <creator@example.com>" },
								{ name: "Subject", value: "Update" },
							],
						},
						body: { data: "must-not-map" },
					});
				}
				if (url.includes("/messages/m2?")) {
					return Response.json({
						id: "m2",
						labelIds: ["Label_1"],
						snippet: "Second",
						payload: { headers: [{ name: "From", value: "news@example.com" }] },
					});
				}
				if (url.includes("pageToken=next")) {
					return Response.json({ messages: [{ id: "m2" }] });
				}
				return Response.json({
					messages: [{ id: "m1" }],
					nextPageToken: "next",
				});
			}) as typeof fetch,
		});

		const messages = await client.listMessages({
			folderId: "INBOX",
			folderName: "Inbox",
			limit: 2,
		});
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			id: "m1",
			threadId: "t1",
			from: "Creator <creator@example.com>",
			subject: "Update",
			folderId: "INBOX",
			read: false,
		});
		expect(JSON.stringify(messages)).not.toContain("must-not-map");
		expect(urls.some((url) => url.includes("maxResults=1"))).toBe(true);
	});

	test("file-backed Gmail client applies label and read-state mutations", async () => {
		const client = new FileBackedGmailClient({
			dataset: {
				folders: [
					{ id: "INBOX", name: "Inbox", type: "system", aliases: ["inbox"] },
					{ id: "Label_updates", name: "Updates", type: "label" },
				],
				filters: [],
				messages: [
					{
						id: "gm1",
						from: "creator@example.com",
						subject: "Update",
						snippet: "Project update",
						folderId: "INBOX",
						folderName: "Inbox",
						read: false,
						labels: ["INBOX", "UNREAD"],
					},
				],
			},
		});

		await client.moveMessages({
			messageIds: ["gm1"],
			targetFolderId: "Label_updates",
		});
		await client.unlabelMessages({ messageIds: ["gm1"], labelId: "INBOX" });
		await client.markMessagesRead({ messageIds: ["gm1"] });

		const messages = await client.listMessages({
			folderId: "Label_updates",
			limit: 10,
		});
		expect(messages[0].labels).toEqual(["Label_updates"]);
		expect(messages[0].read).toBe(true);
	});
});

describe("GmailRestClient private folder identity", () => {
	test("preserves original names and full paths that collide after redaction or truncation", async () => {
		const names = [
			"first-private@example.test",
			"second-private@example.test",
			"Shared/" + "x".repeat(160) + "A",
			"Shared/" + "x".repeat(160) + "B",
		];
		const labels = names.map((name, index) => ({
			id: "Label_" + index,
			name,
			type: "user",
		}));
		const client = new GmailRestClient({
			config: defaultConfig,
			tokenProvider: new StaticGoogleTokenProvider("synthetic-token"),
			fetch: (async (_input: RequestInfo | URL) =>
				Response.json({ labels })) as typeof fetch,
		});
		const folders = await client.listFolders();
		expect(folders.map((folder) => folder.name)).toEqual(names);
		expect(folders.map((folder) => folder.path)).toEqual(names);
		for (const label of labels)
			expect(resolveFolder(folders, label.name, { purpose: "target" }).id).toBe(
				label.id,
			);
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
			).toEqual(labels.map((label) => label.id));
			expect(folders.map((folder) => folder.name)).toEqual(names);
		} finally {
			output.mockRestore();
		}
	});
});
