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
		clearObservedHeaders: async () => {},
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
		sleep: async () => {},
	});
	return { transport, evaluated, opened, closed: () => closed };
}

/** A fake page whose URL, observed headers and page answers follow scripts. */
function scripted(options: {
	urls?: string[];
	headers?: ({ uid: string } | undefined)[];
	answers?: unknown[];
}) {
	const urls = [...(options.urls ?? [])];
	const headers = [...(options.headers ?? [])];
	const answers = [...(options.answers ?? [])];
	let url = MAIL_URL;
	let header: { uid: string } | undefined = { uid: "fixture-session-uid" };
	const calls: string[] = [];
	const sleeps: number[] = [];
	let closed = 0;
	const transport = createPwBrowserRequest({
		dataDir: "/data/dg",
		openSession: async () => ({
			page: {
				url: () => {
					if (urls.length > 0) url = urls.shift()!;
					return url;
				},
				clearObservedHeaders: async () => void calls.push("clear"),
				observedHeaders: () => {
					calls.push("observe");
					if (headers.length > 0) header = headers.shift();
					return header;
				},
				evaluate: async () => {
					calls.push("evaluate");
					return answers.length > 0 ? answers.shift() : { hasMore: false };
				},
			},
			close: async () => void (closed += 1),
		}),
		sleep: async (ms) => void sleeps.push(ms),
	});
	return { transport, calls, sleeps, closed: () => closed };
}

const settle = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);

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
						clearObservedHeaders: async () => {},
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
						clearObservedHeaders: async () => {},
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
					clearObservedHeaders: async () => {},
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

	test("a url that moves to another account after headers were cached rejects before evaluating", async () => {
		let url = "https://mail.proton.me/u/0/inbox";
		const evaluated: unknown[] = [];
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => ({
				page: {
					url: () => url,
					clearObservedHeaders: async () => {},
					observedHeaders: () => ({ uid: "uid-a" }),
					evaluate: async (fn: unknown, arg: unknown) => {
						evaluated.push({ fn, arg });
						return { hasMore: false };
					},
				},
				close: async () => {},
			}),
		});
		await transport.browserRequest({ operation: "list-folders" });
		url = "https://mail.proton.me/u/1/inbox";
		await expect(
			transport.browserRequest({
				operation: "move-messages",
				messageIds: ["m1"],
				targetFolderId: "archive",
				accountHint: "1",
			}),
		).rejects.toThrow(/account-mismatch/);
		expect(evaluated).toHaveLength(1);
	});

	test("a redirect to another account while polling for headers rejects before evaluating", async () => {
		const urls = [
			"https://mail.proton.me/u/1/inbox",
			"https://mail.proton.me/u/0/inbox",
		];
		let last = urls[0]!;
		const evaluated: unknown[] = [];
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => ({
				page: {
					url: () => (last = urls.shift() ?? last),
					clearObservedHeaders: async () => {},
					observedHeaders: () => ({ uid: "uid-b" }),
					evaluate: async (fn: unknown, arg: unknown) => {
						evaluated.push({ fn, arg });
						return { hasMore: false };
					},
				},
				close: async () => {},
			}),
		});
		await expect(
			transport.browserRequest({
				operation: "list-folders",
				accountHint: "1",
			}),
		).rejects.toThrow(/account-mismatch/);
		expect(evaluated).toHaveLength(0);
	});

	test("without a hint the first resolved account is pinned for the session", async () => {
		let url = "https://mail.proton.me/u/0/inbox";
		const evaluated: unknown[] = [];
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => ({
				page: {
					url: () => url,
					clearObservedHeaders: async () => {},
					observedHeaders: () => ({ uid: "uid-a" }),
					evaluate: async (fn: unknown, arg: unknown) => {
						evaluated.push({ fn, arg });
						return { hasMore: false };
					},
				},
				close: async () => {},
			}),
		});
		await transport.browserRequest({ operation: "list-folders" });
		url = "https://mail.proton.me/u/1/inbox";
		await expect(
			transport.browserRequest({ operation: "list-filters" }),
		).rejects.toThrow(/account-mismatch/);
		expect(evaluated).toHaveLength(1);
	});

	test("a hinted retry on a moved page stays rejected while the session is pinned to another account", async () => {
		let url = "https://mail.proton.me/u/0/inbox";
		const evaluated: unknown[] = [];
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => ({
				page: {
					url: () => url,
					clearObservedHeaders: async () => {},
					observedHeaders: () => ({ uid: "uid-a" }),
					evaluate: async (fn: unknown, arg: unknown) => {
						evaluated.push({ fn, arg });
						return { hasMore: false };
					},
				},
				close: async () => {},
			}),
		});
		await transport.browserRequest({ operation: "list-folders" });
		url = "https://mail.proton.me/u/1/inbox";
		const hinted = { operation: "list-folders", accountHint: "1" } as const;
		await expect(transport.browserRequest(hinted)).rejects.toThrow(
			/account-mismatch/,
		);
		await expect(transport.browserRequest(hinted)).rejects.toThrow(
			/account-mismatch/,
		);
		expect(evaluated).toHaveLength(1);
	});

	test("passes the resolved account to the page call", async () => {
		const { transport, evaluated } = seam({
			url: "https://mail.proton.me/u/2/inbox",
		});
		await transport.browserRequest({ operation: "list-folders" });
		expect(evaluated[0]!.arg).toMatchObject({ account: "2" });
	});

	test("a no-hint session waits for a /u/N path before it reads headers", async () => {
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as never);
		try {
			const urls = [
				"https://mail.proton.me/",
				"https://mail.proton.me/",
				"https://mail.proton.me/u/1/inbox",
			];
			let url = urls[0]!;
			const seen: string[] = [];
			const evaluated: unknown[] = [];
			const transport = createPwBrowserRequest({
				dataDir: "/data/dg",
				openSession: async () => ({
					page: {
						url: () => (url = urls.shift() ?? url),
						clearObservedHeaders: async () => {},
						observedHeaders: () => {
							seen.push(url);
							return { uid: "uid-b" };
						},
						evaluate: async (fn: unknown, arg: unknown) => {
							evaluated.push({ fn, arg });
							return { hasMore: false };
						},
					},
					close: async () => {},
				}),
			});
			await transport.browserRequest({ operation: "list-folders" });
			expect(seen.length).toBeGreaterThan(0);
			for (const entry of seen) expect(entry).toContain("/u/1");
			expect(evaluated[0]).toMatchObject({ arg: { account: "1" } });
		} finally {
			timers.mockRestore();
		}
	});

	test("a no-hint session rejects a switch to another account while polling for headers", async () => {
		let url = "https://mail.proton.me/u/0/inbox";
		const evaluated: unknown[] = [];
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => ({
				page: {
					url: () => url,
					clearObservedHeaders: async () => {},
					observedHeaders: () => {
						const captured = { uid: "uid-a" };
						url = "https://mail.proton.me/u/1/inbox";
						return captured;
					},
					evaluate: async (fn: unknown, arg: unknown) => {
						evaluated.push({ fn, arg });
						return { hasMore: false };
					},
				},
				close: async () => {},
			}),
		});
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).rejects.toThrow(/account-mismatch/);
		expect(evaluated).toHaveLength(0);
	});

	test("clears the observed request log before each header acquisition and never for a cached one", async () => {
		let url = "https://mail.proton.me/u/0/inbox";
		const order: string[] = [];
		const transport = createPwBrowserRequest({
			dataDir: "/data/dg",
			openSession: async () => ({
				page: {
					url: () => url,
					clearObservedHeaders: async () => void order.push("clear"),
					observedHeaders: () => {
						order.push("observe");
						return { uid: "uid-a" };
					},
					evaluate: async () => ({ hasMore: false }),
				},
				close: async () => {},
			}),
		});
		await transport.browserRequest({ operation: "list-folders" });
		await transport.browserRequest({ operation: "list-filters" });
		expect(order).toEqual(["clear", "observe"]);
		url = "https://mail.proton.me/u/1/inbox";
		await expect(
			transport.browserRequest({ operation: "list-filters" }),
		).rejects.toThrow(/account-mismatch/);
		url = "https://mail.proton.me/u/0/inbox";
		await transport.browserRequest({ operation: "list-filters" });
		expect(order).toEqual(["clear", "observe", "clear", "observe"]);
	});

	test("a fresh launch whose first api calls get 401 waits for the refreshed session instead of reporting signed out", async () => {
		const { transport, calls } = scripted({
			headers: [undefined, undefined, { uid: "fixture-session-uid" }],
		});
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).resolves.toEqual({ hasMore: false });
		expect(calls).toEqual([
			"clear",
			"observe",
			"observe",
			"observe",
			"evaluate",
		]);
	});

	test("a resume that passes through account.proton.me and back is not signed out", async () => {
		const account = "https://account.proton.me/authorize";
		const { transport, calls, closed } = scripted({
			urls: [account, account, MAIL_URL, account, MAIL_URL],
		});
		await expect(
			transport.browserRequest({ operation: "session-status" }),
		).resolves.toEqual({ hasMore: false });
		expect(calls).toEqual(["clear", "observe", "evaluate"]);
		expect(closed()).toBe(0);
	});

	test("a page that stays on account.proton.me for the whole wait is signed out after every attempt", async () => {
		const { transport, sleeps, closed, calls } = scripted({
			urls: ["https://account.proton.me/login"],
		});
		const error = await settle(
			transport.browserRequest({ operation: "list-folders" }),
		);
		expect(error).toBeInstanceOf(ProtonSignedOutError);
		expect(sleeps).toEqual(Array(40).fill(500));
		expect(calls).toEqual([]);
		expect(closed()).toBe(1);
	});

	test("a page that leaves the mail origin after headers for the whole wait is signed out", async () => {
		const login = "https://account.proton.me/login";
		const { transport, sleeps, closed } = scripted({
			urls: [MAIL_URL, MAIL_URL, login],
		});
		const error = await settle(
			transport.browserRequest({ operation: "list-folders" }),
		);
		expect(error).toBeInstanceOf(ProtonSignedOutError);
		expect(sleeps).toHaveLength(40);
		expect(closed()).toBe(1);
	});

	test("a page that leaves the mail origin while waiting for headers is signed out only when it stays away", async () => {
		const login = "https://account.proton.me/login";
		const { transport, sleeps, closed, calls } = scripted({
			urls: [MAIL_URL, login],
			headers: [undefined],
		});
		const error = await settle(
			transport.browserRequest({ operation: "list-folders" }),
		);
		expect(error).toBeInstanceOf(ProtonSignedOutError);
		expect(calls).toEqual(["clear"]);
		expect(sleeps).toHaveLength(40);
		expect(closed()).toBe(1);
	});

	test("a page that stays on mail without an authenticated response times out without a signed-out error", async () => {
		const { transport, sleeps, closed, calls } = scripted({
			headers: [undefined],
		});
		const error = await settle(
			transport.browserRequest({ operation: "list-folders" }),
		);
		expect(error).toBeInstanceOf(ProtonHeadersTimeoutError);
		expect(error).not.toBeInstanceOf(ProtonSignedOutError);
		expect(sleeps).toEqual(Array(40).fill(500));
		expect(calls.filter((call) => call === "observe")).toHaveLength(40);
		expect(closed()).toBe(0);
	});

	test("an auth-expired answer reloads, waits for the refreshed session and retries once", async () => {
		const { transport, calls, closed } = scripted({
			answers: [{ error: { code: "auth-expired", status: 401 } }],
		});
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).resolves.toEqual({ hasMore: false });
		expect(calls).toEqual([
			"clear",
			"observe",
			"evaluate",
			"clear",
			"observe",
			"evaluate",
		]);
		expect(closed()).toBe(0);
	});

	test("a mail-tab-navigated answer reloads and retries once", async () => {
		const { transport, calls } = scripted({
			answers: [{ error: { code: "mail-tab-navigated" } }],
		});
		await transport.browserRequest({ operation: "list-folders" });
		expect(calls.filter((call) => call === "evaluate")).toHaveLength(2);
		expect(calls.filter((call) => call === "clear")).toHaveLength(2);
	});

	test("a second auth-expired answer is signed out and closes the session", async () => {
		const expired = { error: { code: "auth-expired", status: 401 } };
		const { transport, calls, closed } = scripted({
			answers: [expired, expired, { hasMore: false }],
		});
		const error = await settle(
			transport.browserRequest({ operation: "list-folders" }),
		);
		expect(error).toBeInstanceOf(ProtonSignedOutError);
		expect(calls.filter((call) => call === "evaluate")).toHaveLength(2);
		expect(closed()).toBe(1);
	});

	test("a second mail-tab-navigated answer is signed out", async () => {
		const navigated = { error: { code: "mail-tab-navigated" } };
		const { transport } = scripted({ answers: [navigated, navigated] });
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).rejects.toBeInstanceOf(ProtonSignedOutError);
	});

	test("reads a multi-digit /u/N account with or without a trailing path", async () => {
		const { transport, calls } = scripted({
			urls: ["https://mail.proton.me/u/12"],
		});
		await transport.browserRequest({ operation: "list-folders" });
		expect(calls).toContain("evaluate");
		const nested = scripted({
			urls: ["https://mail.proton.me/inbox/u/1/"],
			headers: [undefined],
		});
		const error = await settle(
			nested.transport.browserRequest({ operation: "list-folders" }),
		);
		expect(error).toBeInstanceOf(ProtonHeadersTimeoutError);
		expect((error as Error).message).toBe(
			"Proton Mail did not make an API request in time. The profile may still be signed in. Retry in a moment.",
		);
		expect(nested.calls).toEqual([]);
	});

	test("a session-unobserved answer is signed out without a retry", async () => {
		const { transport, calls, closed } = scripted({
			answers: [{ error: { code: "session-unobserved" } }],
		});
		const error = await settle(
			transport.browserRequest({ operation: "list-folders" }),
		);
		expect(error).toBeInstanceOf(ProtonSignedOutError);
		expect(calls.filter((call) => call === "evaluate")).toHaveLength(1);
		expect(closed()).toBe(1);
	});

	test("another page error is not retried and keeps the session open", async () => {
		const { transport, calls, closed } = scripted({
			answers: [{ error: { code: "http-failure", status: 500 } }],
		});
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).rejects.toThrow(/http-failure/);
		expect(calls.filter((call) => call === "evaluate")).toHaveLength(1);
		expect(closed()).toBe(0);
	});

	test("a page error without a code uses the generic diagnostic", async () => {
		const { transport } = scripted({ answers: [{ error: {} }] });
		await expect(
			transport.browserRequest({ operation: "list-folders" }),
		).rejects.toThrow("Proton page operation failed.");
	});

	test("the default wait sleeps on real timers", async () => {
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as never);
		try {
			const transport = createPwBrowserRequest({
				dataDir: "/data/dg",
				openSession: async () => ({
					page: {
						url: () => "https://account.proton.me/login",
						clearObservedHeaders: async () => {},
						observedHeaders: () => undefined,
						evaluate: async () => ({ hasMore: false }),
					},
					close: async () => {},
				}),
			});
			await expect(
				transport.browserRequest({ operation: "list-folders" }),
			).rejects.toBeInstanceOf(ProtonSignedOutError);
			expect(timers).toHaveBeenCalledTimes(40);
			expect(timers.mock.calls[0]?.[1]).toBe(500);
		} finally {
			timers.mockRestore();
		}
	});

	test("never imports playwright-core statically", () => {
		const staticImport =
			/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']playwright-core["']|^\s*import\s+["']playwright-core["']/m;
		expect(SOURCE).not.toMatch(staticImport);
	});
});
