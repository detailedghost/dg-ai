import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createPwBrowserRequest,
	ProtonHeadersTimeoutError,
	type ProtonPwPage,
	type ProtonPwSession,
	type ProtonPwSessionSpec,
	ProtonSignedOutError,
} from "../pw-client";

const SOURCE = readFileSync(join(import.meta.dir, "../pw-client.ts"), "utf8");
const MAIL_URL = "https://mail.proton.me/u/0/inbox";
const SIGN_IN_COMMAND = "dg-skills inbox proton sign-in";

function seam(options: { url?: string; answer?: unknown } = {}) {
	const evaluated: { fn: unknown; arg: unknown }[] = [];
	const opened: ProtonPwSessionSpec[] = [];
	let closed = 0;
	const page: ProtonPwPage = {
		url: () => options.url ?? MAIL_URL,
		observedHeaders: () => ({ uid: "fixture-session-uid" }),
		evaluate: async (fn, arg) => {
			evaluated.push({ fn, arg });
			return options.answer ?? { hasMore: false };
		},
	};
	const session: ProtonPwSession = {
		page,
		close: async () => void (closed += 1),
	};
	const transport = createPwBrowserRequest({
		dataDir: "/data/dg",
		openSession: async (spec) => {
			opened.push(spec);
			return session;
		},
	});
	return { transport, evaluated, opened, closed: () => closed };
}

describe("pw-client createPwBrowserRequest", () => {
	test("sends each request through the injected page seam", async () => {
		const { transport, evaluated } = seam({ answer: { hasMore: false } });
		const requests = [
			{ operation: "session-status" },
			{ operation: "list-folders" },
			{ operation: "list-filters" },
		] as const;
		for (const request of requests)
			await expect(transport.browserRequest(request)).resolves.toEqual({
				hasMore: false,
			});
		expect(evaluated).toHaveLength(requests.length);
		for (const [index, request] of requests.entries())
			expect(JSON.stringify(evaluated[index]!.arg)).toContain(
				request.operation,
			);
	});

	test("opens the inbox-proton session once with the persistent profile, headless", async () => {
		const { transport, opened } = seam();
		await transport.browserRequest({ operation: "list-folders" });
		await transport.browserRequest({ operation: "list-filters" });
		expect(opened).toEqual([
			{
				name: "inbox-proton",
				profileDir: join("/data/dg", "inbox", "proton-profile"),
				headless: true,
			},
		]);
	});

	test("passes the observed session headers to the page and keeps cookies out of the call", async () => {
		const { transport, evaluated } = seam();
		await transport.browserRequest({ operation: "list-folders" });
		const serialized = JSON.stringify(evaluated[0]!.arg);
		expect(serialized).toContain("fixture-session-uid");
		expect(serialized.toLowerCase()).not.toContain("cookie");
	});

	test("close closes the session", async () => {
		const { transport, closed } = seam();
		await transport.browserRequest({ operation: "list-folders" });
		await transport.close();
		expect(closed()).toBe(1);
	});

	test("a signed-out page rejects with exit 4, names the sign-in command and closes the session", async () => {
		const { transport, evaluated, closed } = seam({
			url: "https://account.proton.me/login",
		});
		const error = await transport
			.browserRequest({ operation: "list-folders" })
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(ProtonSignedOutError);
		expect((error as ProtonSignedOutError).exitCode).toBe(4);
		expect((error as Error).message).toContain(SIGN_IN_COMMAND);
		expect(evaluated).toHaveLength(0);
		expect(closed()).toBe(1);
	});

	test("rejects an invalid request before touching the page", async () => {
		const { transport, evaluated, opened } = seam();
		await expect(
			transport.browserRequest({
				operation: "eval",
				source: "document.cookie",
			} as never),
		).rejects.toThrow();
		expect(evaluated).toHaveLength(0);
		expect(opened).toHaveLength(0);
	});

	test("rejects an invalid page response", async () => {
		const { transport } = seam({ answer: { folders: "not-a-list" } });
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).rejects.toThrow();
	});

	test("a page that never shows a session uid rejects with the headers timeout error, not a signed-out error", async () => {
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as never);
		try {
			const evaluated: unknown[] = [];
			const transport = createPwBrowserRequest({
				dataDir: "/data/dg",
				openSession: async () => ({
					page: {
						url: () => MAIL_URL,
						observedHeaders: () => undefined,
						evaluate: async (fn: unknown, arg: unknown) =>
							void evaluated.push({ fn, arg }),
					} as never,
					close: async () => {},
				}),
			});
			const error = await transport
				.browserRequest({ operation: "list-folders" })
				.then(
					() => undefined,
					(caught: unknown) => caught,
				);
			expect(error).toBeInstanceOf(ProtonHeadersTimeoutError);
			expect(error).not.toBeInstanceOf(ProtonSignedOutError);
			expect(evaluated).toHaveLength(0);
		} finally {
			timers.mockRestore();
		}
	});

	test("a page that leaves the mail origin while waiting for a session uid rejects as signed out and closes", async () => {
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as never);
		try {
			const urls = [MAIL_URL, MAIL_URL, "https://account.proton.me/login"];
			let closed = 0;
			const transport = createPwBrowserRequest({
				dataDir: "/data/dg",
				openSession: async () => ({
					page: {
						url: () => urls.shift() ?? "https://account.proton.me/login",
						observedHeaders: () => undefined,
						evaluate: async () => ({ hasMore: false }),
					},
					close: async () => void (closed += 1),
				}),
			});
			const error = await transport
				.browserRequest({ operation: "list-folders" })
				.then(
					() => undefined,
					(caught: unknown) => caught,
				);
			expect(error).toBeInstanceOf(ProtonSignedOutError);
			expect(closed).toBe(1);
		} finally {
			timers.mockRestore();
		}
	});

	test("a page auth-expired error rejects with exit 4 naming the sign-in command", async () => {
		const { transport } = seam({ answer: { error: { code: "auth-expired" } } });
		const error = await transport
			.browserRequest({ operation: "list-folders" })
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(ProtonSignedOutError);
		expect((error as ProtonSignedOutError).exitCode).toBe(4);
		expect((error as Error).message).toContain(SIGN_IN_COMMAND);
	});

	test("another page error code rejects with its fixed diagnostic and no exit 4", async () => {
		const { transport } = seam({
			answer: {
				error: { code: "http-failure", status: 429, detail: "secret-token" },
			},
		});
		const error = await transport
			.browserRequest({ operation: "list-folders" })
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ProtonSignedOutError);
		expect((error as Error).message).toContain("http-failure");
		expect((error as Error).message).toContain("429");
		expect((error as Error).message).not.toContain("secret-token");
	});

	test("redacts message text on the Node side before returning it", async () => {
		const { transport } = seam({
			answer: {
				hasMore: false,
				messages: [
					{
						id: "m1",
						from: "jane@example.com",
						subject: "Hello",
						snippet: "Write to jane@example.com",
						folderId: "inbox",
						folderName: "Inbox",
						read: false,
					},
				],
			},
		});
		const result = await transport.browserRequest({
			operation: "list-messages",
			folderId: "inbox",
			page: 0,
			pageSize: 50,
		});
		expect(JSON.stringify(result)).not.toContain("jane@example.com");
		expect(JSON.stringify(result)).toContain("[email:example.com]");
	});

	test("an accountHint that does not match the open /u/ path rejects before evaluating", async () => {
		const { transport, evaluated } = seam({
			url: "https://mail.proton.me/u/1/inbox",
		});
		await expect(
			transport.browserRequest({
				operation: "list-folders",
				accountHint: "0",
			} as never),
		).rejects.toThrow(/account-mismatch/);
		expect(evaluated).toHaveLength(0);
	});

	test("an accountHint opens the matching /u/N mail URL", async () => {
		const { transport, opened } = seam({
			url: "https://mail.proton.me/u/1/inbox",
		});
		await transport.browserRequest({
			operation: "list-folders",
			accountHint: "1",
		} as never);
		expect(opened).toEqual([
			{
				name: "inbox-proton",
				profileDir: join("/data/dg", "inbox", "proton-profile"),
				headless: true,
				url: "https://mail.proton.me/u/1",
			},
		]);
	});

	test("an accountHint matching the open /u/ path runs the operation", async () => {
		const { transport, evaluated } = seam({
			url: "https://mail.proton.me/u/0/inbox",
		});
		await transport.browserRequest({
			operation: "list-folders",
			accountHint: "0",
		} as never);
		expect(evaluated).toHaveLength(1);
	});

	test("close resolves after a failed session open", async () => {
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => {
				throw new Error("boom");
			},
		});
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).rejects.toThrow(/boom/);
		await expect(transport.close()).resolves.toBeUndefined();
	});

	test("reads the observed headers once for two requests", async () => {
		let reads = 0;
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => ({
				page: {
					url: () => MAIL_URL,
					observedHeaders: () => {
						reads += 1;
						return { uid: "fixture-session-uid" };
					},
					evaluate: async () => ({ hasMore: false }),
				},
				close: async () => {},
			}),
		});
		await transport.browserRequest({ operation: "list-folders" });
		await transport.browserRequest({ operation: "list-filters" });
		expect(reads).toBe(1);
	});

	test("never imports playwright-core statically", () => {
		const staticImport =
			/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']playwright-core["']|^\s*import\s+["']playwright-core["']/m;
		expect(SOURCE).not.toMatch(staticImport);
	});
});
