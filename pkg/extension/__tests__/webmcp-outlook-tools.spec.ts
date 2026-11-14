import { describe, expect, it } from "bun:test";
import { isDgToolName, redactText, WEBMCP_TOOL_CLASSES } from "@dg/common";
import { createOwaService, OUTLOOK_CANCELED } from "@/lib/features/webmcp-outlook/service";
import { createOutlookTools, htmlToText } from "@/lib/features/webmcp-outlook/tools";
import createItem from "./fixtures/webmcp-outlook/create-item.json";
import findFolder from "./fixtures/webmcp-outlook/find-folder.json";
import findItem from "./fixtures/webmcp-outlook/find-item.json";
import getItem from "./fixtures/webmcp-outlook/get-item.json";
import moveItem from "./fixtures/webmcp-outlook/move-item.json";

const REPLIES: Record<string, unknown> = {
	FindItem: findItem,
	GetItem: getItem,
	FindFolder: findFolder,
	MoveItem: moveItem,
	CreateItem: createItem,
};

type Sent = { action: string; body: Record<string, unknown> };

const success = { ResponseClass: "Success", ResponseCode: "NoError" };
const notFound = { ResponseClass: "Error", ResponseCode: "ErrorItemNotFound", MessageText: "test.person@example.com" };
const messages = (Items: unknown[]) => ({ Body: { ResponseMessages: { Items } } });

function oneSuccessPerItem(body: Record<string, unknown>) {
	const count = (Array.isArray(body.ItemIds) ? body.ItemIds : Array.isArray(body.ItemChanges) ? body.ItemChanges : [0]).length;
	return messages(Array.from({ length: count }, () => success));
}

function setup(replies: Record<string, unknown> = {}) {
	const sent: Sent[] = [];
	const service = createOwaService({
		location: new URL("https://outlook.live.com/mail/0/"),
		headers: () => ({ "x-owa-canary": "fixture-canary" }),
		fetch: async (input, init) => {
			const action = new URL(String(input)).searchParams.get("action") as string;
			const body = JSON.parse(String(init?.body)).Body as Record<string, unknown>;
			sent.push({ action, body });
			return Response.json(replies[action] ?? REPLIES[action] ?? oneSuccessPerItem(body));
		},
	});
	const tools = createOutlookTools(service);
	const run = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.find((entry) => entry.name === name);
		if (!tool) throw new Error(`missing ${name}`);
		return JSON.parse(await tool.execute(args)) as Record<string, unknown>;
	};
	return { tools, sent, run };
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => `AAMkFixture${index}=`);

describe("the Outlook tools", () => {
	it("are the ten classified tools, each with a dg_ name, a description and an object schema", () => {
		const { tools } = setup();
		expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(WEBMCP_TOOL_CLASSES).sort());
		for (const tool of tools) {
			expect(isDgToolName(tool.name)).toBe(true);
			expect(tool.description.length).toBeGreaterThan(10);
			expect(tool.inputSchema).toEqual(expect.objectContaining({ type: "object", additionalProperties: false }));
		}
	});

	it.each([
		["dg_outlook_list", [], ["folder", "limit"]],
		["dg_outlook_search", ["query"], ["query", "limit"]],
		["dg_outlook_read", ["id"], ["id"]],
		["dg_outlook_mark_read", ["ids"], ["ids", "read"]],
		["dg_outlook_flag", ["ids"], ["ids", "flagged"]],
		["dg_outlook_move", ["ids", "folder"], ["ids", "folder"]],
		["dg_outlook_archive", ["ids"], ["ids"]],
		["dg_outlook_delete", ["ids"], ["ids"]],
		["dg_outlook_draft", ["to", "subject", "body"], ["to", "subject", "body"]],
		["dg_outlook_reply", ["id", "body"], ["id", "body", "replyAll"]],
	])("gives %s the required fields %p and the fields %p", (name, required, fields) => {
		const schema = setup().tools.find((tool) => tool.name === name)?.inputSchema as {
			required?: string[];
			properties: Record<string, unknown>;
		};
		expect(schema.required ?? []).toEqual(required);
		expect(Object.keys(schema.properties)).toEqual(fields);
	});

	it("caps the ids arrays and the limit at 50 in the schemas", () => {
		const { tools } = setup();
		for (const tool of tools) {
			const properties = (tool.inputSchema as { properties: Record<string, { maxItems?: number; maximum?: number }> }).properties;
			if (properties.ids) expect(properties.ids.maxItems).toBe(50);
			if (properties.limit) expect(properties.limit.maximum).toBe(50);
		}
	});
});

describe("dg_outlook_list", () => {
	it("returns the messages shape with addresses only and ids unchanged", async () => {
		const { run, sent } = setup();
		expect(await run("dg_outlook_list")).toEqual({
			messages: [
				{
					id: "AAMkFixtureItem1=",
					subject: "Fixture subject",
					from: "test.person@example.com",
					date: "2026-11-01T09:30:00Z",
					read: false,
					flagged: true,
					preview: "Fixture preview text",
				},
				{
					id: "AAMkFixtureItem2=",
					subject: "Second fixture subject",
					from: "other.person@example.com",
					date: "2026-10-31T17:05:00Z",
					read: true,
					flagged: false,
					preview: "Second fixture preview",
				},
			],
		});
		expect(JSON.stringify(await run("dg_outlook_list"))).not.toContain("Test Person");
		expect(sent[0]?.action).toBe("FindItem");
		expect(sent[0]?.body).toEqual(
			expect.objectContaining({
				ParentFolderIds: [{ __type: "DistinguishedFolderId:#Exchange", Id: "inbox" }],
				Traversal: "Shallow",
				Paging: expect.objectContaining({ MaxEntriesReturned: 25 }),
			}),
		);
	});

	it("lists a distinguished folder with the given limit", async () => {
		const { run, sent } = setup();
		await run("dg_outlook_list", { folder: "archive", limit: 50 });
		expect(sent[0]?.body).toEqual(
			expect.objectContaining({
				ParentFolderIds: [{ __type: "DistinguishedFolderId:#Exchange", Id: "archive" }],
				Paging: expect.objectContaining({ MaxEntriesReturned: 50 }),
			}),
		);
	});

	it.each([51, 0, 2.5, "10"])("rejects the limit %p with a message naming the limit", async (limit) => {
		const { run, sent } = setup();
		await expect(run("dg_outlook_list", { limit })).rejects.toThrow("limit must be an integer from 1 to 50.");
		expect(sent).toEqual([]);
	});

	it("keeps an OWA item id unchanged through redactText", async () => {
		const { run } = setup();
		const output = JSON.stringify(await run("dg_outlook_list"));
		expect(redactText(output)).toContain("AAMkFixtureItem1=");
	});

	it("leaves the from address to the background mask", async () => {
		const { run } = setup();
		expect(redactText(JSON.stringify(await run("dg_outlook_list")))).not.toContain("test.person@example.com");
	});
});

describe("dg_outlook_search", () => {
	const SEARCHED = ["inbox", "archive", "deleteditems", "junkemail", "drafts", "sentitems"];

	function searchSetup(replies: Record<string, unknown[]>) {
		const sent: Sent[] = [];
		const service = createOwaService({
			location: new URL("https://outlook.live.com/mail/0/"),
			headers: () => ({ "x-owa-canary": "fixture-canary" }),
			fetch: async (input, init) => {
				const body = JSON.parse(String(init?.body)).Body as { ParentFolderIds: Array<{ Id: string }> };
				sent.push({ action: new URL(String(input)).searchParams.get("action") as string, body });
				const Items = replies[body.ParentFolderIds[0]?.Id ?? ""] ?? [];
				return Response.json({
					Body: { ResponseMessages: { Items: [{ ResponseClass: "Success", ResponseCode: "NoError", RootFolder: { Items } }] } },
				});
			},
		});
		const tool = createOutlookTools(service).find((entry) => entry.name === "dg_outlook_search");
		const run = async (args: Record<string, unknown>) => JSON.parse(await (tool?.execute(args) ?? "{}"));
		return { sent, run };
	}

	const [first, second] = findItem.Body.ResponseMessages.Items[0]?.RootFolder.Items ?? [];

	it("sends one Shallow FindItem with the QueryString to each distinguished mail folder", async () => {
		const { run, sent } = searchSetup({});
		await run({ query: "Fixture subject", limit: 5 });
		expect(sent.map((entry) => entry.action)).toEqual(SEARCHED.map(() => "FindItem"));
		expect(sent.map((entry) => entry.body)).toEqual(
			SEARCHED.map((Id) =>
				expect.objectContaining({
					QueryString: { __type: "QueryStringType:#Exchange", Value: "Fixture subject" },
					ParentFolderIds: [{ __type: "DistinguishedFolderId:#Exchange", Id }],
					Traversal: "Shallow",
					Paging: expect.objectContaining({ MaxEntriesReturned: 5 }),
				}),
			),
		);
		expect(JSON.stringify(sent)).not.toContain("Deep");
		expect(JSON.stringify(sent)).not.toContain("msgfolderroot");
	});

	it("merges the folders newest first and keeps at most limit messages", async () => {
		const { run } = searchSetup({ inbox: [second], sentitems: [first], archive: [second] });
		const output = await run({ query: "Fixture subject", limit: 2 });
		expect(output.messages.map((entry: { id: string }) => entry.id)).toEqual(["AAMkFixtureItem1=", "AAMkFixtureItem2="]);
	});

	it("rejects an empty query", async () => {
		await expect(setup().run("dg_outlook_search", { query: " " })).rejects.toThrow("query must be a non-empty string.");
	});
});

describe("the OWA property paths", () => {
	it("use one bare FieldURI convention in every request", async () => {
		const { run, sent } = setup();
		await run("dg_outlook_list", { folder: "Fixture folder" });
		await run("dg_outlook_search", { query: "Fixture subject" });
		await run("dg_outlook_read", { id: "AAMkFixtureItem1=" });
		await run("dg_outlook_mark_read", { ids: ["AAMkFixtureItem1="] });
		await run("dg_outlook_flag", { ids: ["AAMkFixtureItem1="] });
		await run("dg_outlook_move", { ids: ["AAMkFixtureItem1="], folder: "Fixture folder" });
		const uris = [...JSON.stringify(sent).matchAll(/"FieldURI":"([^"]*)"/g)].map((match) => match[1]);
		expect(uris.length).toBeGreaterThan(0);
		expect(uris.filter((uri) => uri?.includes(":"))).toEqual([]);
	});
});

describe("dg_outlook_read", () => {
	it("returns the message with addresses only and the body as plain text", async () => {
		const { run } = setup();
		expect(await run("dg_outlook_read", { id: "AAMkFixtureItem1=" })).toEqual({
			id: "AAMkFixtureItem1=",
			subject: "Fixture subject",
			from: "test.person@example.com",
			to: ["fixture.reader@example.com", "fixture.team@example.com"],
			date: "2026-11-01T09:30:00Z",
			body: "Hello & welcome,\nLine two here <ok> — A\n\nBye",
		});
	});

	it("asks only GetItem and never changes the read state", async () => {
		const { run, sent } = setup();
		await run("dg_outlook_read", { id: "AAMkFixtureItem1=" });
		expect(sent.map((entry) => entry.action)).toEqual(["GetItem"]);
		expect(JSON.stringify(sent[0]?.body)).not.toContain("IsRead");
		expect(sent[0]?.body).toEqual(
			expect.objectContaining({ ItemIds: [{ __type: "ItemId:#Exchange", Id: "AAMkFixtureItem1=" }] }),
		);
	});

	it("rejects a missing id", async () => {
		await expect(setup().run("dg_outlook_read", {})).rejects.toThrow("id must be a non-empty string.");
	});
});

describe("htmlToText", () => {
	it("caps the text at 50,000 characters", () => {
		expect(htmlToText(`<p>${"a".repeat(60_000)}</p>`)).toHaveLength(50_000);
	});

	it("drops comments and decodes entities once", () => {
		expect(htmlToText("<!-- hidden -->a &amp;lt; b")).toBe("a &lt; b");
	});

	it("drops a comment that holds a > and an unclosed comment to the end", () => {
		expect(htmlToText("a<!-- x > y -->b<!-- open")).toBe("ab");
	});

	it("drops head, script, style and title blocks, and an unclosed one to the end", () => {
		expect(htmlToText("<HEAD><title>t</title></head><p>keep</p><Script>x()</SCRIPT >more<style>a{}")).toBe("keep\nmore");
	});

	it("keeps a < that no > closes as text", () => {
		expect(htmlToText("<b>a</b> < b")).toBe("a < b");
	});

	it("trims spaces at line ends and collapses blank lines", () => {
		expect(htmlToText("<p>a&nbsp;&nbsp;</p>\t\n\n\n<p>b</p>")).toBe("a\n\nb");
	});

	it.each([
		["unclosed style tags", "<style".repeat(80_000)],
		["unclosed comments", "<!--".repeat(80_000)],
		["a run of non-breaking spaces", `<p>${"&nbsp;".repeat(100_000)}`],
		["unclosed angle brackets", "<".repeat(200_000)],
		["unclosed script tags", "<script>".repeat(80_000)],
	])("converts %s in linear time", (_, html) => {
		const start = performance.now();
		htmlToText(html);
		expect(performance.now() - start).toBeLessThan(2_000);
	});
});

describe("the write tools", () => {
	it("marks items read with one UpdateItem and echoes only the count and the ids", async () => {
		const { run, sent } = setup();
		expect(await run("dg_outlook_mark_read", { ids: ["AAMkFixtureItem1="] })).toEqual({
			updated: 1,
			ids: ["AAMkFixtureItem1="],
		});
		expect(sent[0]?.action).toBe("UpdateItem");
		expect(JSON.stringify(sent[0]?.body)).toContain('"IsRead":true');
	});

	it("marks items unread when read is false", async () => {
		const { run, sent } = setup();
		await run("dg_outlook_mark_read", { ids: ["AAMkFixtureItem1="], read: false });
		expect(JSON.stringify(sent[0]?.body)).toContain('"IsRead":false');
	});

	it.each([
		["dg_outlook_mark_read", 51],
		["dg_outlook_flag", 51],
		["dg_outlook_archive", 51],
		["dg_outlook_delete", 51],
		["dg_outlook_move", 51],
		["dg_outlook_delete", 0],
	])("rejects %s with %d ids and a message naming the limit", async (name, count) => {
		const { run, sent } = setup();
		await expect(run(name, { ids: ids(count), folder: "archive" })).rejects.toThrow("ids must hold 1 to 50 item ids.");
		expect(sent).toEqual([]);
	});

	it("flags and unflags items", async () => {
		const { run, sent } = setup();
		expect(await run("dg_outlook_flag", { ids: ["AAMkFixtureItem1="] })).toEqual({ updated: 1, ids: ["AAMkFixtureItem1="] });
		await run("dg_outlook_flag", { ids: ["AAMkFixtureItem1="], flagged: false });
		expect(JSON.stringify(sent[0]?.body)).toContain('"FlagStatus":"Flagged"');
		expect(JSON.stringify(sent[1]?.body)).toContain('"FlagStatus":"NotFlagged"');
	});

	it("archives items to the distinguished archive folder and returns the new ids", async () => {
		const { run, sent } = setup();
		expect(await run("dg_outlook_archive", { ids: ["AAMkFixtureItem1="] })).toEqual({
			archived: 1,
			ids: ["AAMkFixtureMoved1="],
		});
		expect(sent[0]?.body).toEqual(
			expect.objectContaining({
				ToFolderId: {
					__type: "TargetFolderId:#Exchange",
					BaseFolderId: { __type: "DistinguishedFolderId:#Exchange", Id: "archive" },
				},
				ItemIds: [{ __type: "ItemId:#Exchange", Id: "AAMkFixtureItem1=" }],
			}),
		);
	});

	it("moves items to a custom folder found by its exact name and echoes the folder as given", async () => {
		const { run, sent } = setup();
		expect(await run("dg_outlook_move", { ids: ["AAMkFixtureItem1="], folder: "Fixture folder" })).toEqual({
			moved: 1,
			ids: ["AAMkFixtureMoved1="],
			folder: "Fixture folder",
		});
		expect(sent.map((entry) => entry.action)).toEqual(["FindFolder", "MoveItem"]);
		expect(JSON.stringify(sent[1]?.body)).toContain('"Id":"AAMkFixtureFolder1="');
	});

	it.each([
		["Missing folder", "No mail folder has that name."],
		["Twin folder", "Several mail folders have that name; move to a distinguished folder or rename one."],
	])("does not move to %s", async (folder, error) => {
		const { run, sent } = setup();
		await expect(run("dg_outlook_move", { ids: ["AAMkFixtureItem1="], folder })).rejects.toThrow(error);
		expect(sent.map((entry) => entry.action)).toEqual(["FindFolder"]);
	});

	it("moves the ids that still exist and reports a code-only error for each stale id", async () => {
		const moved = (Id: string) => ({ ...success, Items: [{ ItemId: { Id } }] });
		const { run } = setup({ MoveItem: messages([moved("AAMkFixtureMoved1="), notFound, moved("AAMkFixtureMoved3=")]) });
		const output = await run("dg_outlook_move", {
			ids: ["AAMkFixtureItem1=", "AAMkFixtureStale=", "AAMkFixtureItem3="],
			folder: "archive",
		});
		expect(output).toEqual({
			moved: 2,
			ids: ["AAMkFixtureMoved1=", "AAMkFixtureMoved3="],
			folder: "archive",
			errors: [{ id: "AAMkFixtureStale=", error: "ErrorItemNotFound" }],
		});
		expect(JSON.stringify(output)).not.toContain("test.person@example.com");
	});

	it("archives the ids that still exist and reports the stale ones", async () => {
		const { run } = setup({ MoveItem: messages([notFound, { ...success, Items: [{ ItemId: { Id: "AAMkFixtureMoved2=" } }] }]) });
		expect(await run("dg_outlook_archive", { ids: ["AAMkFixtureStale=", "AAMkFixtureItem2="] })).toEqual({
			archived: 1,
			ids: ["AAMkFixtureMoved2="],
			errors: [{ id: "AAMkFixtureStale=", error: "ErrorItemNotFound" }],
		});
	});

	it("deletes the ids that still exist and reports the stale ones", async () => {
		const { run } = setup({ DeleteItem: messages([success, notFound]) });
		expect(await run("dg_outlook_delete", { ids: ["AAMkFixtureItem1=", "AAMkFixtureStale="] })).toEqual({
			deleted: 1,
			ids: ["AAMkFixtureItem1="],
			errors: [{ id: "AAMkFixtureStale=", error: "ErrorItemNotFound" }],
		});
	});

	it("updates the ids that still exist and reports the stale ones", async () => {
		const { run } = setup({ UpdateItem: messages([notFound, success]) });
		expect(await run("dg_outlook_mark_read", { ids: ["AAMkFixtureStale=", "AAMkFixtureItem2="] })).toEqual({
			updated: 1,
			ids: ["AAMkFixtureItem2="],
			errors: [{ id: "AAMkFixtureStale=", error: "ErrorItemNotFound" }],
		});
	});

	it("reports an id with no response message as an unknown error", async () => {
		const { run } = setup({ DeleteItem: messages([success]) });
		expect(await run("dg_outlook_delete", { ids: ["AAMkFixtureItem1=", "AAMkFixtureItem2="] })).toEqual({
			deleted: 1,
			ids: ["AAMkFixtureItem1="],
			errors: [{ id: "AAMkFixtureItem2=", error: "unknown error" }],
		});
	});

	it("fails the call when no id could be moved", async () => {
		const { run } = setup({ MoveItem: messages([notFound, notFound]) });
		await expect(run("dg_outlook_move", { ids: ["AAMkFixtureStale=", "AAMkFixtureGone="], folder: "archive" })).rejects.toThrow(
			"Outlook could not run MoveItem (ErrorItemNotFound).",
		);
	});

	it("sends the Deleted Items move for the given ids", async () => {
		const { run, sent } = setup();
		expect(await run("dg_outlook_delete", { ids: ["AAMkFixtureItem1=", "AAMkFixtureItem2="] })).toEqual({
			deleted: 2,
			ids: ["AAMkFixtureItem1=", "AAMkFixtureItem2="],
		});
		expect(sent).toEqual([
			{
				action: "DeleteItem",
				body: expect.objectContaining({
					DeleteType: "MoveToDeletedItems",
					ItemIds: [
						{ __type: "ItemId:#Exchange", Id: "AAMkFixtureItem1=" },
						{ __type: "ItemId:#Exchange", Id: "AAMkFixtureItem2=" },
					],
				}),
			},
		]);
	});

	it("saves a draft with the body as escaped text and echoes only the new id", async () => {
		const { run, sent } = setup();
		const output = await run("dg_outlook_draft", {
			to: ["test.person@example.com"],
			subject: "Fixture subject",
			body: "<b>x</b> & more\nnext",
		});
		expect(output).toEqual({ id: "AAMkFixtureDraft1=" });
		const body = sent[0]?.body as { MessageDisposition: string; Items: Array<Record<string, unknown>> };
		expect(body.MessageDisposition).toBe("SaveOnly");
		expect(body.Items[0]?.Body).toEqual({
			__type: "BodyContentType:#Exchange",
			BodyType: "HTML",
			Value: "&lt;b&gt;x&lt;/b&gt; &amp; more<br>next",
		});
		expect(body.Items[0]?.ToRecipients).toEqual([{ __type: "EmailAddress:#Exchange", EmailAddress: "test.person@example.com" }]);
	});

	it.each([
		[{ to: [], subject: "s", body: "b" }, "to must hold 1 to 50 addresses."],
		[{ to: ["not-an-address"], subject: "s", body: "b" }, "to must hold 1 to 50 addresses."],
		[{ to: ["test.person@example.com"], body: "b" }, "subject must be a string."],
		[{ to: ["test.person@example.com"], subject: "s" }, "body must be a string."],
	])("rejects the draft %p", async (args, error) => {
		await expect(setup().run("dg_outlook_draft", args)).rejects.toThrow(error);
	});

	it("sends a reply with escaped text and echoes no body or recipients", async () => {
		const { run, sent } = setup();
		expect(await run("dg_outlook_reply", { id: "AAMkFixtureItem1=", body: "<i>ok</i>" })).toEqual({
			sent: true,
			id: "AAMkFixtureItem1=",
		});
		const body = sent[0]?.body as { MessageDisposition: string; Items: Array<Record<string, unknown>> };
		expect(body.MessageDisposition).toBe("SendAndSaveCopy");
		expect(body.Items[0]).toEqual({
			__type: "ReplyToItem:#Exchange",
			ReferenceItemId: { __type: "ItemId:#Exchange", Id: "AAMkFixtureItem1=" },
			NewBodyContent: { __type: "BodyContentType:#Exchange", BodyType: "HTML", Value: "&lt;i&gt;ok&lt;/i&gt;" },
		});
	});

	it.each([
		["dg_outlook_reply", { id: "AAMkFixtureItem1=", body: "ok" }],
		["dg_outlook_draft", { to: ["test.person@example.com"], subject: "Fixture subject", body: "ok" }],
		["dg_outlook_move", { ids: ["AAMkFixtureItem1="], folder: "Fixture folder" }],
		["dg_outlook_search", { query: "Fixture subject" }],
	])("sends nothing for %s once its signal has aborted", async (name, args) => {
		const { tools, sent } = setup();
		const controller = new AbortController();
		controller.abort();
		await expect(tools.find((tool) => tool.name === name)?.execute(args, { signal: controller.signal })).rejects.toThrow(
			OUTLOOK_CANCELED,
		);
		expect(sent).toEqual([]);
	});

	it("sends a reply to all when replyAll is true", async () => {
		const { run, sent } = setup();
		await run("dg_outlook_reply", { id: "AAMkFixtureItem1=", body: "ok", replyAll: true });
		expect((sent[0]?.body as { Items: Array<{ __type: string }> }).Items[0]?.__type).toBe("ReplyAllToItem:#Exchange");
	});

	it("rejects a non-boolean flag argument", async () => {
		await expect(setup().run("dg_outlook_reply", { id: "a", body: "b", replyAll: "yes" })).rejects.toThrow(
			"replyAll must be true or false.",
		);
	});
});
