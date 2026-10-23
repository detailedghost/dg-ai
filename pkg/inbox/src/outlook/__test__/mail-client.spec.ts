import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/defaults";
import {
	StaticMicrosoftTokenProvider,
	type MicrosoftAccessToken,
	type MicrosoftTokenProvider,
} from "../auth";
import { createOutlookMailAccessClient, GraphMailAccessClient } from "../mail-client";

describe("GraphMailAccessClient listMessages", () => {
	test("builds a $filter that leads with receivedDateTime and keeps isRead, $top, and $skip", async () => {
		const requests: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				requests.push(url);
				return Response.json({ value: [] });
			}) as unknown as typeof fetch,
		});
		await client.listMessages({
			folderId: "inbox",
			unread: true,
			since: "2026-10-01T00:00:00Z",
			from: "example.test",
			limit: 20,
			page: 1,
		});
		expect(requests).toHaveLength(1);
		const url = new URL(requests[0]);
		const filter = url.searchParams.get("$filter") ?? "";
		expect(filter.startsWith("receivedDateTime ge 2026-10-01T00:00:00Z")).toBe(true);
		expect(filter).toContain("isRead eq false");
		expect(url.searchParams.get("$top")).toBe("20");
		expect(url.searchParams.get("$skip")).toBe("20");
	});

	test("uses the 1970 floor for receivedDateTime when --since is absent", async () => {
		const requests: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				requests.push(url);
				return Response.json({ value: [] });
			}) as unknown as typeof fetch,
		});
		await client.listMessages({ folderId: "inbox", limit: 10, page: 0 });
		const filter = new URL(requests[0]).searchParams.get("$filter") ?? "";
		expect(filter.startsWith("receivedDateTime ge 1970-01-01T00:00:00Z")).toBe(true);
	});

	test("uses from/emailAddress/address eq for a full address and doubles single quotes", async () => {
		const requests: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				requests.push(url);
				return Response.json({ value: [] });
			}) as unknown as typeof fetch,
		});
		await client.listMessages({
			folderId: "inbox",
			from: "o'neil@example.test",
			subject: "q'tr",
			limit: 10,
			page: 0,
		});
		const filter = new URL(requests[0]).searchParams.get("$filter") ?? "";
		expect(filter).toContain("from/emailAddress/address eq 'o''neil@example.test'");
		expect(filter).toContain("contains(subject,'q''tr')");
	});

	test("filters a domain-only --from client-side since Graph has no contains() on the address", async () => {
		const requests: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				requests.push(url);
				return Response.json({
					value: [
						{
							id: "m1",
							from: { emailAddress: { address: "a@example.test" } },
							subject: "S1",
							receivedDateTime: "2026-10-20T00:00:00Z",
							parentFolderId: "inbox",
						},
						{
							id: "m2",
							from: { emailAddress: { address: "b@other.test" } },
							subject: "S2",
							receivedDateTime: "2026-10-19T00:00:00Z",
							parentFolderId: "inbox",
						},
					],
				});
			}) as unknown as typeof fetch,
		});
		const page = await client.listMessages({
			folderId: "inbox",
			from: "example.test",
			limit: 20,
			page: 0,
		});
		expect(new URL(requests[0]).searchParams.get("$filter")).not.toContain(
			"from/emailAddress/address",
		);
		expect(page.messages.map((message) => message.id)).toEqual(["m1"]);
	});

	test("follows @odata.nextLink to fill a short Graph page up to the requested limit", async () => {
		const urls: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				urls.push(url);
				if (url.includes("cursor-2")) {
					return Response.json({
						value: [
							{
								id: "m2",
								subject: "Second",
								receivedDateTime: "2026-10-19T00:00:00Z",
								parentFolderId: "inbox",
							},
						],
					});
				}
				return Response.json({
					value: [
						{
							id: "m1",
							subject: "First",
							receivedDateTime: "2026-10-20T00:00:00Z",
							parentFolderId: "inbox",
						},
					],
					"@odata.nextLink":
						"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?cursor-2",
				});
			}) as unknown as typeof fetch,
		});
		const page = await client.listMessages({ folderId: "inbox", limit: 2, page: 0 });
		expect(page.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
		expect(page.hasMore).toBe(false);
		expect(urls).toHaveLength(2);
	});

	test("reports hasMore when Graph still has a nextLink after the limit is filled", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () =>
				Response.json({
					value: [
						{
							id: "m1",
							subject: "A",
							receivedDateTime: "2026-10-20T00:00:00Z",
							parentFolderId: "inbox",
						},
					],
					"@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?more",
				})) as unknown as typeof fetch,
		});
		const page = await client.listMessages({ folderId: "inbox", limit: 1, page: 0 });
		expect(page.hasMore).toBe(true);
	});

	test("refuses to follow a nextLink on an untrusted origin", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () =>
				Response.json({
					value: [
						{
							id: "m1",
							subject: "A",
							receivedDateTime: "2026-10-20T00:00:00Z",
							parentFolderId: "inbox",
						},
					],
					"@odata.nextLink": "https://evil.test/me/messages",
				})) as unknown as typeof fetch,
		});
		await expect(
			client.listMessages({ folderId: "inbox", limit: 5, page: 0 }),
		).rejects.toThrow("Untrusted Microsoft Graph nextLink origin or path");
	});
});

describe("GraphMailAccessClient searchMessages", () => {
	test("sends $search, $select, and $top only, and escapes embedded quotes", async () => {
		const requests: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				requests.push(url);
				return Response.json({ value: [] });
			}) as unknown as typeof fetch,
		});
		await client.searchMessages({ text: 'quarterly "report"', limit: 10, page: 0 });
		const url = new URL(requests[0]);
		expect(url.searchParams.get("$search")).toBe('"quarterly \\"report\\""');
		expect(url.searchParams.get("$filter")).toBeNull();
		expect(url.searchParams.get("$orderby")).toBeNull();
		expect(url.searchParams.get("$skip")).toBeNull();
	});

	test("rejects a nonzero page before making any request", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () => {
				throw new Error("must not fetch");
			}) as unknown as typeof fetch,
		});
		await expect(client.searchMessages({ text: "x", limit: 10, page: 1 })).rejects.toThrow(
			"--page is not supported with search; narrow --query or raise --limit",
		);
	});

	test("searches within a folder route when folderId is set", async () => {
		const requests: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				requests.push(url);
				return Response.json({ value: [] });
			}) as unknown as typeof fetch,
		});
		await client.searchMessages({ text: "invoice", folderId: "archive", limit: 10, page: 0 });
		expect(requests[0]).toContain("/me/mailFolders/archive/messages");
	});
});

describe("GraphMailAccessClient getMessage", () => {
	test("sends the text Prefer header alongside the immutable-id preference and maps uniqueBody", async () => {
		const headers: Headers[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (_url: string, init?: RequestInit) => {
				headers.push(new Headers(init?.headers));
				return Response.json({
					id: "m1",
					from: { emailAddress: { name: "Priya Shah", address: "priya@example.test" } },
					toRecipients: [{ emailAddress: { address: "me@example.test" } }],
					ccRecipients: [],
					subject: "Status",
					receivedDateTime: "2026-10-20T09:00:00Z",
					isRead: false,
					parentFolderId: "inbox",
					hasAttachments: false,
					body: { contentType: "text", content: "Hi\n\nOn Fri wrote:\n> quoted" },
					uniqueBody: { contentType: "text", content: "Hi" },
				});
			}) as unknown as typeof fetch,
		});
		const message = await client.getMessage("m1");
		expect(headers[0].get("prefer")).toContain('outlook.body-content-type="text"');
		expect(headers[0].get("prefer")).toContain('IdType="ImmutableId"');
		expect(message.uniqueText).toBe("Hi");
		expect(message.to).toEqual(["me@example.test"]);
		expect(message.from).toBe("Priya Shah <priya@example.test>");
	});

	test("falls back to stripQuotedHistory on the body when uniqueBody is absent", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () =>
				Response.json({
					id: "m1",
					from: { emailAddress: { address: "a@example.test" } },
					subject: "S",
					receivedDateTime: "2026-10-20T09:00:00Z",
					parentFolderId: "inbox",
					hasAttachments: false,
					body: {
						contentType: "text",
						content:
							"Reply text\n\nOn Fri, Oct 9, 2026 at 3:00 PM a@example.test wrote:\n> Original",
					},
				})) as unknown as typeof fetch,
		});
		const message = await client.getMessage("m1");
		expect(message.uniqueText).toBe("Reply text");
	});

	test("falls back to htmlToText when Graph ignores the text Prefer header", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () =>
				Response.json({
					id: "m1",
					from: { emailAddress: { address: "a@example.test" } },
					subject: "S",
					receivedDateTime: "2026-10-20T09:00:00Z",
					parentFolderId: "inbox",
					hasAttachments: false,
					body: { contentType: "html", content: "<p>Hello <b>there</b></p>" },
				})) as unknown as typeof fetch,
		});
		const message = await client.getMessage("m1");
		expect(message.text).toBe("Hello there");
	});

	test("hasAttachments true with zero returned attachments still yields an empty list", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				if (url.includes("/attachments")) return Response.json({ value: [] });
				return Response.json({
					id: "m1",
					from: { emailAddress: { address: "a@example.test" } },
					subject: "S",
					receivedDateTime: "2026-10-20T09:00:00Z",
					parentFolderId: "inbox",
					hasAttachments: true,
					body: { contentType: "text", content: "Body" },
				});
			}) as unknown as typeof fetch,
		});
		const message = await client.getMessage("m1");
		expect(message.attachments).toEqual([]);
	});
});

describe("GraphMailAccessClient listAttachments", () => {
	test("selects only safe fields and excludes contentBytes", async () => {
		const requests: string[] = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string) => {
				requests.push(url);
				return Response.json({
					value: [
						{
							id: "att-1",
							name: "invoice.pdf",
							contentType: "application/pdf",
							size: 100,
							isInline: false,
						},
					],
				});
			}) as unknown as typeof fetch,
		});
		const attachments = await client.listAttachments("m1");
		expect(new URL(requests[0]).searchParams.get("$select")).toBe(
			"id,name,contentType,size,isInline",
		);
		expect(attachments).toEqual([
			{ id: "att-1", name: "invoice.pdf", contentType: "application/pdf", size: 100, isInline: false },
		]);
		expect(attachments[0]).not.toHaveProperty("contentBytes");
	});
});

describe("GraphMailAccessClient drafts and send", () => {
	test("createDraft posts the text body and recipients", async () => {
		const requests: Array<{ url: string; method: string; body: string }> = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string, init?: RequestInit) => {
				requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
				return Response.json({
					id: "d1",
					subject: "S",
					toRecipients: [{ emailAddress: { address: "a@example.test" } }],
					ccRecipients: [],
				});
			}) as unknown as typeof fetch,
		});
		const draft = await client.createDraft({
			to: ["a@example.test"],
			cc: [],
			subject: "S",
			text: "Body text",
		});
		expect(requests[0].method).toBe("POST");
		expect(requests[0].url).toContain("/me/messages");
		const body = JSON.parse(requests[0].body);
		expect(body.body).toEqual({ contentType: "Text", content: "Body text" });
		expect(body.toRecipients).toEqual([{ emailAddress: { address: "a@example.test" } }]);
		expect(draft.to).toEqual(["a@example.test"]);
	});

	test("createReplyDraft posts to createReplyAll then PATCHes the body and adds cc", async () => {
		const requests: Array<{ url: string; method: string; body: string }> = [];
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async (url: string, init?: RequestInit) => {
				requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
				if (url.includes("createReplyAll")) {
					return Response.json({
						id: "d1",
						ccRecipients: [{ emailAddress: { address: "existing@example.test" } }],
					});
				}
				return Response.json({
					id: "d1",
					subject: "Re: S",
					toRecipients: [{ emailAddress: { address: "sender@example.test" } }],
				});
			}) as unknown as typeof fetch,
		});
		const draft = await client.createReplyDraft({
			messageId: "m1",
			replyAll: true,
			cc: ["extra@example.test"],
			text: "Reply body",
		});
		expect(requests[0]).toMatchObject({ method: "POST" });
		expect(requests[0].url).toContain("/me/messages/m1/createReplyAll");
		expect(requests[1].method).toBe("PATCH");
		const patchBody = JSON.parse(requests[1].body);
		expect(patchBody.body).toEqual({ contentType: "Text", content: "Reply body" });
		expect(patchBody.ccRecipients).toEqual([
			{ emailAddress: { address: "existing@example.test" } },
			{ emailAddress: { address: "extra@example.test" } },
		]);
		expect(draft.to).toEqual(["sender@example.test"]);
	});

	test("getDraft refuses a message that is not a draft", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () => Response.json({ id: "m1", isDraft: false })) as unknown as typeof fetch,
		});
		await expect(client.getDraft("m1")).rejects.toThrow(
			"draft was already sent or is not a draft",
		);
	});

	test("sendDraft requests only the send scope; list, get, and create never request it", async () => {
		const scopeCalls: string[][] = [];
		class RecordingTokenProvider implements MicrosoftTokenProvider {
			async getToken(scopes: string[]): Promise<MicrosoftAccessToken> {
				scopeCalls.push(scopes);
				return { accessToken: "token" };
			}
		}
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new RecordingTokenProvider(),
			fetch: (async (url: string, init?: RequestInit) => {
				const pathname = new URL(url).pathname;
				if (pathname.endsWith("/send")) return new Response(null, { status: 202 });
				if (pathname === "/v1.0/me/messages" && (init?.method ?? "GET") === "POST")
					return Response.json({ id: "d1" });
				if (pathname === "/v1.0/me/messages/m1")
					return Response.json({
						id: "m1",
						from: { emailAddress: { address: "a@example.test" } },
						subject: "S",
						receivedDateTime: "2026-10-20T09:00:00Z",
						parentFolderId: "inbox",
						hasAttachments: false,
						body: { contentType: "text", content: "B" },
					});
				return Response.json({ value: [] });
			}) as unknown as typeof fetch,
		});
		await client.listMessages({ folderId: "inbox", limit: 5, page: 0 });
		await client.getMessage("m1");
		await client.createDraft({ to: ["a@example.test"], cc: [], subject: "S", text: "T" });
		await client.sendDraft("d1");
		const sendCalls = scopeCalls.filter((scopes) => scopes.includes("Mail.Send"));
		const otherCalls = scopeCalls.filter((scopes) => !scopes.includes("Mail.Send"));
		expect(sendCalls.length).toBe(1);
		expect(otherCalls.length).toBeGreaterThan(0);
	});
});

describe("GraphMailAccessClient error shapes", () => {
	test("maps a 401 to the redacted authentication-failed sentence without leaking the body", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () => new Response("leaked secret body", { status: 401 })) as unknown as typeof fetch,
		});
		try {
			await client.listMessages({ folderId: "inbox", limit: 5, page: 0 });
			throw new Error("expected listMessages to throw");
		} catch (error) {
			expect(String(error)).toContain("Microsoft Graph authentication failed");
			expect(String(error)).not.toContain("leaked secret body");
		}
	});

	test("maps a 403 on send to the scope sentence naming Mail.Send", async () => {
		const client = new GraphMailAccessClient({
			config: defaultConfig,
			tokenProvider: new StaticMicrosoftTokenProvider("secret-token"),
			fetch: (async () => new Response("leaked secret body", { status: 403 })) as unknown as typeof fetch,
		});
		try {
			await client.sendDraft("d1");
			throw new Error("expected sendDraft to throw");
		} catch (error) {
			expect(String(error)).toContain("Mail.Send");
			expect(String(error)).not.toContain("leaked secret body");
		}
	});
});

describe("createOutlookMailAccessClient", () => {
	test("builds a client without requiring a daemon-bound runtime", () => {
		expect(() => createOutlookMailAccessClient(defaultConfig, {})).not.toThrow();
	});
});
