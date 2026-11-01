import { describe, expect, spyOn, test } from "bun:test";
import { isWSL } from "@dg/common/node";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	openProtonSession,
	protonProfilePaths,
	protonPwRuntime,
	ProtonSignedOutError,
	readSignedInMarker,
	runProtonSignIn,
	writeSignedInMarker,
	type PwRunner,
} from "../src/inbox/proton-pw";
import { inboxCliHarness } from "./inbox-cli-harness";

const SIGN_IN_COMMAND = "dg-skills inbox proton sign-in";

function protonArgs(workspace: string): string[] {
	return ["load", "folders", "--provider", "protonmail", "--dir", workspace];
}

describe("inbox commands on a signed-out Proton pw profile", () => {
	test("exit 4 and name the sign-in command when no sign-in marker exists", async () => {
		const h = inboxCliHarness();
		try {
			const result = await h.run(protonArgs(h.workspace), {
				XDG_CACHE_HOME: `${h.cwd}/cache`,
			});
			expect(result.code, result.stderr).toBe(4);
			expect(result.stderr).toContain(SIGN_IN_COMMAND);
		} finally {
			h.cleanup();
		}
	});

	test("--ext skips the pw profile check and never names the sign-in command", async () => {
		const h = inboxCliHarness();
		try {
			const result = await h.run([...protonArgs(h.workspace), "--ext"], {
				XDG_CACHE_HOME: `${h.cwd}/cache`,
			});
			expect(result.code).not.toBe(4);
			expect(result.stderr).not.toContain(SIGN_IN_COMMAND);
		} finally {
			h.cleanup();
		}
	});

	test("Gmail and Outlook commands never mention the Proton sign-in command", async () => {
		const h = inboxCliHarness();
		try {
			for (const provider of ["gmail", "outlook"]) {
				const result = await h.run(
					["load", "folders", "--provider", provider, "--dir", h.workspace],
					{ XDG_CACHE_HOME: `${h.cwd}/cache` },
				);
				expect(result.code).not.toBe(4);
				expect(result.stderr).not.toContain(SIGN_IN_COMMAND);
			}
		} finally {
			h.cleanup();
		}
	});
});

describe("inbox proton command arguments", () => {
	test("proton with no arguments prints help and exits 0", async () => {
		const h = inboxCliHarness();
		try {
			const result = await h.run(["proton"]);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("inbox proton sign-in");
		} finally {
			h.cleanup();
		}
	});

	test("proton sign-in with an extra argument fails without opening a session", async () => {
		const h = inboxCliHarness();
		try {
			const result = await h.run(["proton", "sign-in", "extra-arg"]);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(SIGN_IN_COMMAND);
		} finally {
			h.cleanup();
		}
	});
});

function tempDataDir() {
	const dir = mkdtempSync(join(tmpdir(), "proton-pw-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function recordingRunner(replies: Record<string, string> = {}) {
	const calls: string[][] = [];
	const run: PwRunner = async (argv) => {
		calls.push(argv);
		const key = Object.keys(replies).find((name) => argv.includes(name));
		return { code: 0, out: key ? replies[key]! : "", err: "" };
	};
	return { run, calls };
}

const spec = (headless: boolean) => ({
	name: "inbox-proton",
	profileDir: "/data/dg/inbox/proton-profile",
	headless,
});

describe("proton-pw openProtonSession", () => {
	test("opens the named pw session on the Proton mail URL and honors headless", async () => {
		for (const headless of [true, false]) {
			const { run, calls } = recordingRunner();
			await openProtonSession(spec(headless), run);
			const open = calls[0]!;
			expect(open.slice(0, 2)).toEqual(["-s=inbox-proton", "open"]);
			expect(open).toContain("https://mail.proton.me");
			expect(open.includes("--headless")).toBe(headless);
			expect(open.includes("--windows")).toBe(isWSL());
			expect(open.includes("--profile")).toBe(!isWSL());
		}
	});

	test("sign-in and headless sessions pass identical placement arguments", async () => {
		const placements = [];
		for (const headless of [true, false]) {
			const { run, calls } = recordingRunner();
			await openProtonSession(spec(headless), run);
			placements.push(
				calls[0]!.filter((arg) => arg !== "--headless"),
			);
		}
		expect(placements[0]).toEqual(placements[1]!);
	});

	test("opens the spec url when one is given", async () => {
		const { run, calls } = recordingRunner();
		await openProtonSession({ ...spec(true), url: "https://mail.proton.me/u/1" }, run);
		expect(calls[0]).toContain("https://mail.proton.me/u/1");
		expect(calls[0]).not.toContain("https://mail.proton.me");
	});

	test("a failed open reports the first stderr line", async () => {
		const run: PwRunner = async () => ({ code: 1, out: "", err: "boom\nmore" });
		await expect(openProtonSession(spec(true), run)).rejects.toThrow(/boom/);
	});

	test("observedHeaders keeps only uid, app version and locale", async () => {
		const listing = [
			"GET https://mail.proton.me/api/core/v4/users",
			"  x-pm-uid: fixture-uid",
			"  x-pm-appversion: web-mail@1.2.3",
			"  x-pm-locale: en_US",
			"  cookie: AUTH-secret=hunter2",
		].join("\n");
		const { run } = recordingRunner({ network: listing });
		const session = await openProtonSession(spec(true), run);
		const headers = await session.page.observedHeaders();
		expect(headers).toEqual({
			uid: "fixture-uid",
			appVersion: "web-mail@1.2.3",
			locale: "en_US",
		});
		expect(JSON.stringify(headers).toLowerCase()).not.toContain("hunter2");
	});

	test("observedHeaders is undefined before any Proton api request", async () => {
		const { run } = recordingRunner({ network: "" });
		const session = await openProtonSession(spec(true), run);
		expect(await session.page.observedHeaders()).toBeUndefined();
	});

	test("a non-zero pw eval code rejects with a fixed message that leaks no page output", async () => {
		const run: PwRunner = async (argv) =>
			argv.includes("eval")
				? { code: 1, out: "", err: "page crashed\nstack" }
				: { code: 0, out: "", err: "" };
		const session = await openProtonSession(spec(true), run);
		const error = await Promise.resolve(session.page.url()).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as Error).message).toBe("Proton page evaluation failed.");
		expect((error as Error).message).not.toContain("page crashed");
	});

	test("non-JSON pw eval output rejects instead of returning a value", async () => {
		const run: PwRunner = async (argv) => ({
			code: 0,
			out: argv.includes("eval") ? "not json {" : "",
			err: "",
		});
		const session = await openProtonSession(spec(true), run);
		await expect(session.page.url()).rejects.toThrow();
	});

	test("close closes the pw session", async () => {
		const { run, calls } = recordingRunner();
		const session = await openProtonSession(spec(true), run);
		await session.close();
		expect(calls.at(-1)).toEqual(["-s=inbox-proton", "close"]);
	});
});

describe("proton-pw marker handling", () => {
	test("a header wait that times out keeps the sign-in marker", async () => {
		const data = tempDataDir();
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
		) => {
			callback();
			return 0;
		}) as never);
		try {
			writeSignedInMarker(data.dir);
			const runtime = protonPwRuntime(
				data.dir,
				async () => ({
				page: {
					url: () => "https://mail.proton.me/u/0/inbox",
					observedHeaders: () => undefined,
					evaluate: async () => ({}),
				},
				close: async () => {},
			}),
			);
			await expect(
				runtime.pwBrowserRequest({ operation: "list-folders" }),
			).rejects.toThrow(/did not make an API request/);
			expect(existsSync(protonProfilePaths(data.dir).markerPath)).toBe(true);
		} finally {
			timers.mockRestore();
			data.cleanup();
		}
	});

	test("a page that left mail.proton.me clears the sign-in marker", async () => {
		const data = tempDataDir();
		try {
			writeSignedInMarker(data.dir);
			const runtime = protonPwRuntime(
				data.dir,
				async () => ({
				page: {
					url: () => "https://account.proton.me/login",
					observedHeaders: () => undefined,
					evaluate: async () => ({}),
				},
				close: async () => {},
			}),
			);
			await expect(
				runtime.pwBrowserRequest({ operation: "list-folders" }),
			).rejects.toBeInstanceOf(ProtonSignedOutError);
			expect(existsSync(protonProfilePaths(data.dir).markerPath)).toBe(false);
		} finally {
			data.cleanup();
		}
	});
});

describe("proton-pw runProtonSignIn", () => {
	function signInSeam(url: string, uid: string | undefined) {
		let closed = 0;
		const opened: { headless: boolean }[] = [];
		const deps = {
			openSession: async (opening: { headless: boolean }) => {
				opened.push(opening);
				return {
					page: {
						url: () => url,
						observedHeaders: () => (uid ? { uid } : undefined),
						evaluate: async () => ({}),
					},
					close: async () => void (closed += 1),
				};
			},
			sleep: async () => {},
			log: () => {},
		};
		return { deps, opened, closed: () => closed };
	}

	test("opens the profile headed, writes the marker once signed in and closes", async () => {
		const data = tempDataDir();
		try {
			const { deps, opened, closed } = signInSeam(
				"https://mail.proton.me/u/0/inbox",
				"fixture-uid",
			);
			await runProtonSignIn(data.dir, deps as never);
			expect(opened).toEqual([expect.objectContaining({ headless: false })]);
			expect(existsSync(protonProfilePaths(data.dir).markerPath)).toBe(true);
			expect(closed()).toBe(1);
		} finally {
			data.cleanup();
		}
	});

	test("times out without a marker and still closes the session", async () => {
		const data = tempDataDir();
		try {
			const { deps, closed } = signInSeam("https://account.proton.me/login", undefined);
			await expect(
				runProtonSignIn(data.dir, { ...deps, timeoutMs: 0 } as never),
			).rejects.toThrow(/dg-skills inbox proton sign-in/);
			expect(existsSync(protonProfilePaths(data.dir).markerPath)).toBe(false);
			expect(closed()).toBe(1);
		} finally {
			data.cleanup();
		}
	});
});

describe("proton-pw protonPwRuntime", () => {
	test("rejects with exit 4 before opening any session when the marker is missing", async () => {
		const data = tempDataDir();
		try {
			const runtime = protonPwRuntime(data.dir);
			const error = await runtime
				.pwBrowserRequest({ operation: "list-folders" })
				.then(
					() => undefined,
					(caught: unknown) => caught,
				);
			expect(error).toBeInstanceOf(ProtonSignedOutError);
			expect((error as ProtonSignedOutError).exitCode).toBe(4);
			await runtime.close();
		} finally {
			data.cleanup();
		}
	});

	test("writeSignedInMarker records the profile location and the time", () => {
		const data = tempDataDir();
		try {
			writeSignedInMarker(data.dir, "windows");
			expect(readSignedInMarker(data.dir)).toEqual({
				signedInAt: expect.any(String),
				profile: "windows",
			});
			writeSignedInMarker(data.dir, "local");
			expect(readSignedInMarker(data.dir)?.profile).toBe("local");
		} finally {
			data.cleanup();
		}
	});

	test("readSignedInMarker tolerates a marker without a profile location", () => {
		const data = tempDataDir();
		try {
			const { markerPath } = protonProfilePaths(data.dir);
			mkdirSync(dirname(markerPath), { recursive: true });
			writeFileSync(markerPath, JSON.stringify({ signedInAt: "2026-11-01T00:00:00Z" }));
			expect(readSignedInMarker(data.dir)).toEqual({
				signedInAt: "2026-11-01T00:00:00Z",
			});
			writeFileSync(markerPath, "not json");
			expect(readSignedInMarker(data.dir)).toEqual({});
		} finally {
			data.cleanup();
		}
	});

	test("sign-in records the profile location of this host", async () => {
		const data = tempDataDir();
		try {
			await runProtonSignIn(data.dir, {
				openSession: async () => ({
					page: {
						url: () => "https://mail.proton.me/u/0/inbox",
						observedHeaders: () => ({ uid: "fixture-uid" }),
						evaluate: async () => ({}),
					},
					close: async () => {},
				}),
				sleep: async () => {},
				log: () => {},
			});
			expect(readSignedInMarker(data.dir)?.profile).toBe(
				isWSL() ? "windows" : "local",
			);
		} finally {
			data.cleanup();
		}
	});

	test("writeSignedInMarker leaves no temporary file next to the marker", () => {
		const data = tempDataDir();
		try {
			writeSignedInMarker(data.dir);
			const { markerPath } = protonProfilePaths(data.dir);
			expect(existsSync(markerPath)).toBe(true);
			expect(existsSync(`${markerPath}.${process.pid}.tmp`)).toBe(false);
		} finally {
			data.cleanup();
		}
	});
});

describe("proton-pw sign-in origins", () => {
	test("accepts a user who landed on mail.protonmail.com", async () => {
		const data = tempDataDir();
		try {
			await runProtonSignIn(data.dir, {
				openSession: async () => ({
					page: {
						url: () => "https://mail.protonmail.com/u/0/inbox",
						observedHeaders: () => ({ uid: "fixture-uid" }),
						evaluate: async () => ({}),
					},
					close: async () => {},
				}),
				sleep: async () => {},
				log: () => {},
			});
			expect(existsSync(protonProfilePaths(data.dir).markerPath)).toBe(true);
		} finally {
			data.cleanup();
		}
	});
});
