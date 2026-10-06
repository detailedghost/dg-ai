import { expect, it, mock } from "bun:test";
import { createInboxHandler } from "../lib/background/inbox";

function frame(request = {}) {
	return { type: "inbox-browser-request" as const, sessionId: "session-1", requestId: "request-1", protocolVersion: 1,
		request: { operation: "list-messages" as const, page: 0, pageSize: 50, ...request } };
}

function browser(tabs: Array<{ id: number; url: string }>, data: unknown = { messages: [], hasMore: false }) {
	return {
		tabs: {
			query: mock(async () => tabs),
			get: mock(async (id: number) => {
				const tab = tabs.find((entry) => entry.id === id);
				if (!tab) throw new Error("tab closed");
				return tab;
			}),
		},
		scripting: { executeScript: mock(async (_details: unknown) => [{ frameId: 0, result: data }]) },
		runtime: {},
	};
}

it("selects the single Proton mail tab and preserves session/request identity through MAIN execution", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }, { id: 9, url: "https://other.test" }]);
	const result = await createInboxHandler({ browserApi: api as never })(frame());
	expect(result).toEqual(expect.objectContaining({ type: "inbox-browser-result", sessionId: "session-1", requestId: "request-1", protocolVersion: 1, ok: true, data: { messages: [], hasMore: false } }));
	expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
	expect(api.scripting.executeScript.mock.calls[0][0]).toEqual(expect.objectContaining({ target: { tabId: 8 }, world: "MAIN", func: expect.any(Function), args: [{ ...frame().request, accountHint: "0" }] }));
});

it("refuses ambiguous tabs until an explicit valid tab resolves selection", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }, { id: 9, url: "https://mail.proton.me/u/1/inbox" }]);
	const handle = createInboxHandler({ browserApi: api as never });
	const ambiguous = await handle(frame());
	expect(ambiguous.ok).toBe(false);
	expect(JSON.stringify(ambiguous.error)).toMatch(/multiple|ambiguous|choose|tabId/i);
	expect(api.scripting.executeScript).not.toHaveBeenCalled();
	const selected = await handle(frame({ tabId: 9 }));
	expect(selected.ok).toBe(true);
	expect(api.scripting.executeScript.mock.calls[0][0]).toEqual(expect.objectContaining({ target: { tabId: 9 } }));
});

it("uses the account hint to resolve multiple Proton accounts", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }, { id: 9, url: "https://mail.proton.me/u/1/inbox" }]);
	const result = await createInboxHandler({ browserApi: api as never })(frame({ accountHint: "1" }));
	expect(result.ok).toBe(true);
	expect(api.scripting.executeScript.mock.calls[0][0]).toEqual(expect.objectContaining({ target: { tabId: 9 } }));
});

it.each([
	[],
	[{ id: 8, url: "https://account.proton.me" }],
	[{ id: 8, url: "https://mail.proton.me.attacker.test/u/0/inbox" }],
].map((tabs) => ({ tabs })))("returns an actionable missing-mail-tab error for %j", async ({ tabs }) => {
	const api = browser(tabs);
	const result = await createInboxHandler({ browserApi: api as never })(frame());
	expect(result.ok).toBe(false);
	expect(JSON.stringify(result.error)).toMatch(/open|sign in|Proton|tab/i);
	expect(api.scripting.executeScript).not.toHaveBeenCalled();
});

it("rejects an explicitly selected non-Proton tab before page execution", async () => {
	const api = browser([{ id: 8, url: "https://other.test" }, { id: 9, url: "https://mail.proton.me/u/0/inbox" }]);
	const result = await createInboxHandler({ browserApi: api as never })(frame({ tabId: 8 }));
	expect(result.ok).toBe(false);
	expect(api.scripting.executeScript).not.toHaveBeenCalled();
});

it.each([{ operation: "eval", source: "document.cookie" }, { url: "https://attacker.test" }])(
	"rejects unapproved executable inputs before selecting or executing a tab %j", async (request) => {
		const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
		const result = await createInboxHandler({ browserApi: api as never })(frame(request) as never);
		expect(result.ok).toBe(false);
		expect(api.scripting.executeScript).not.toHaveBeenCalled();
	},
);

it("does not trust raw page results to relay body, headers, or secrets", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }], { messages: [{ id: "opaque-id", subject: "customer@example.test", body: "raw-body", token: "secret-token" }], headers: { "x-pm-uid": "secret-uid" }, hasMore: false });
	const result = await createInboxHandler({ browserApi: api as never })(frame());
	const serialized = JSON.stringify(result);
	for (const value of ["customer@example.test", "raw-body", "secret-token", "secret-uid", "x-pm-uid"]) expect(serialized).not.toContain(value);
});

it("preserves correlation when the page disappears during execution", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
	api.scripting.executeScript.mockImplementation(async () => { throw new Error("tab closed"); });
	const result = await createInboxHandler({ browserApi: api as never })(frame());
	expect(result).toEqual(expect.objectContaining({ sessionId: "session-1", requestId: "request-1", ok: false }));
	expect(JSON.stringify(result.error)).toMatch(/tab|reload|open/i);
});

it("returns an actionable capability error when MAIN execution is unsupported", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
	const result = await createInboxHandler({ browserApi: { ...api, scripting: undefined } as never })(frame());
	expect(result.ok).toBe(false);
	expect(JSON.stringify(result.error)).toMatch(/unsupported|browser|upgrade|permission/i);
});

it("refuses mutation batches above the provider bound before page execution", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
	const result = await createInboxHandler({ browserApi: api as never })(frame({ operation: "mark-read", messageIds: Array.from({ length: 201 }, (_, i) => `opaque-${i}`) }) as never);
	expect(result.ok).toBe(false);
	expect(api.scripting.executeScript).not.toHaveBeenCalled();
});

async function runSerializedMain(input: { func: Function; args: unknown[] }, options: { install: boolean; pageUrl?: string; response?: { body: unknown; status: number } }) {
	const child = Bun.spawn([process.execPath, new URL("./utils/proton-main-execution.ts", import.meta.url).pathname], {
		cwd: new URL("..", import.meta.url).pathname,
		stdin: new Blob([JSON.stringify({ func: input.func.toString(), request: input.args[0], ...options })]),
		stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	return JSON.parse(stdout) as { result: unknown; calls: string[] };
}

it.each([true, false])("serialized MAIN function uses only the installed bundled page API (installed=%s)", async (install) => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
	let execution: Awaited<ReturnType<typeof runSerializedMain>> | undefined;
	api.scripting.executeScript.mockImplementation(async (details) => {
		const input = details as { func: Function; args: unknown[] };
		const executed = await runSerializedMain(input, { install });
		execution = executed;
		return [{ frameId: 0, result: executed.result }];
	});
	const result = await createInboxHandler({ browserApi: api as never })(frame());
	expect(execution).toBeDefined();
	expect(result.ok).toBe(install);
	if (install) {
		expect(execution!.calls).toHaveLength(1);
		expect(new URL(execution!.calls[0]).pathname).toBe("/api/mail/v4/messages");
		expect(result.data?.messages?.[0]?.id).toBe("serialized-main-message");
		for (const secret of ["page-memory-secret", "person@example.test", "secret-body"]) expect(JSON.stringify(result)).not.toContain(secret);
	} else {
		expect(execution!.calls).toEqual([]);
		expect(result.error).toMatch(/reload|sign in/i);
	}
});

it("relays safe provider diagnostics from the installed MAIN API without provider error text", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
	api.scripting.executeScript.mockImplementation(async (details) => {
		const executed = await runSerializedMain(details as { func: Function; args: unknown[] }, {
			install: true,
			response: { status: 403, body: { Error: "person@example.test token=private-secret" } },
		});
		return [{ frameId: 0, result: executed.result }];
	});
	const result = await createInboxHandler({ browserApi: api as never })(frame());
	expect(result.ok).toBe(false);
	expect(result.error).toContain("auth-expired");
	expect(result.error).toContain("HTTP 403");
	for (const secret of ["person@example.test", "private-secret", "page-memory-secret"]) {
		expect(JSON.stringify(result)).not.toContain(secret);
	}
});

it.each([
	{ code: "private-secret", message: "person@example.test", status: "secret-status" },
	{ code: "constructor", message: "person@example.test", status: 200 },
	{ code: "http-failure", message: "person@example.test", status: "secret-status" },
])("rejects arbitrary page diagnostics and relays only fixed messages %j", async (failure) => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }], { __dgInboxFailure: true, ...failure });
	const result = await createInboxHandler({ browserApi: api as never })(frame());
	expect(result.ok).toBe(false);
	for (const secret of ["private-secret", "person@example.test", "secret-status", "constructor"]) {
		expect(JSON.stringify(result)).not.toContain(secret);
	}
});

it("refuses an explicit Proton tab belonging to a different account hint", async () => {
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
	const result = await createInboxHandler({ browserApi: api as never })(frame({ tabId: 8, accountHint: "1" }));
	expect(result.ok).toBe(false);
	expect(api.scripting.executeScript).not.toHaveBeenCalled();
});

it.each([
	{ pageUrl: "https://mail.proton.me/u/1/inbox", request: { accountHint: "0" } },
	{ pageUrl: "https://mail.proton.me/u/1/inbox", request: {} },
	{ pageUrl: "https://account.proton.me/u/0/inbox", request: { accountHint: "0" } },
	{ pageUrl: "https://mail.proton.me.attacker.test/u/0/inbox", request: { accountHint: "0" } },
])("serialized MAIN execution refuses tab navigation after account selection %j", async ({ pageUrl, request }) => {
	// Tab selection is a snapshot; the callback must enforce the account again at execution time.
	const api = browser([{ id: 8, url: "https://mail.proton.me/u/0/inbox" }]);
	let execution: Awaited<ReturnType<typeof runSerializedMain>> | undefined;
	api.scripting.executeScript.mockImplementation(async (details) => {
		const executed = await runSerializedMain(details as { func: Function; args: unknown[] }, { install: true, pageUrl });
		execution = executed;
		return [{ frameId: 0, result: executed.result }];
	});
	const result = await createInboxHandler({ browserApi: api as never })(frame(request));
	expect(execution).toBeDefined();
	expect(execution!.calls).toEqual([]);
	expect(result.ok).toBe(false);
	expect(result.error).toMatch(/reload|account|tab|sign in/i);
});
