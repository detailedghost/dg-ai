import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import handler, {
	deleteProtectedData,
} from "../../../../src/pw/commands/delete-data/run";
import spec from "../../../../src/pw/commands/delete-data/spec";
import {
	sessionKey,
	socketPathFor,
	write,
} from "../../../../src/pw/core/registry";
import {
	argsFor,
	clientEnv,
	startFakeDaemon,
	useTempScratch,
} from "../../../../src/pw/test-support";

useTempScratch();

let cache = "";
let previous: string | undefined;

beforeEach(() => {
	previous = process.env["XDG_CACHE_HOME"];
	cache = mkdtempSync(path.join(tmpdir(), "pw-cache-"));
	process.env["XDG_CACHE_HOME"] = cache;
});

afterEach(() => {
	if (previous === undefined) delete process.env["XDG_CACHE_HOME"];
	else process.env["XDG_CACHE_HOME"] = previous;
	rmSync(cache, { recursive: true, force: true });
});

const profile = (name: string) =>
	path.join(cache, "playwright-cli", "profiles", name);

describe("delete-data", () => {
	test("deletes the default profile of a closed session", async () => {
		mkdirSync(profile("old"), { recursive: true });
		writeFileSync(path.join(profile("old"), "Cookies"), "x");
		const env = clientEnv();
		expect(await handler(argsFor(spec, "-s=old"), env)).toBe(0);
		expect(existsSync(profile("old"))).toBe(false);
		expect(env.stdout[0]).toStartWith("### Deleted data for session `old`");
	});

	test("says so when there is nothing to delete", async () => {
		const env = clientEnv();
		expect(await handler(argsFor(spec, "-s=none"), env)).toBe(0);
		expect(env.stdout).toEqual(["No saved data for session 'none'."]);
	});

	test("stops an open session before it deletes the profile", async () => {
		mkdirSync(profile("live"), { recursive: true });
		const daemon = await startFakeDaemon("live", {
			profileDir: profile("live"),
		});
		try {
			expect(await handler(argsFor(spec, "-s=live"), clientEnv())).toBe(0);
			expect(existsSync(profile("live"))).toBe(false);
			expect(daemon.child.killed || daemon.child.exitCode !== null).toBe(true);
		} finally {
			daemon.dispose();
		}
	});

	test("refuses a profile outside the profiles directory and leaves the session running", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "pw-outside-"));
		const daemon = await startFakeDaemon("custom", { profileDir: outside });
		const env = clientEnv();
		try {
			expect(await handler(argsFor(spec, "-s=custom"), env)).toBe(1);
			expect(env.stderr[0]).toStartWith(`Refusing to delete ${outside}`);
			expect(existsSync(outside)).toBe(true);
			expect(daemon.child.exitCode).toBeNull();
		} finally {
			daemon.dispose();
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("stops a scratch session, reports no saved data and keeps the persistent profile", async () => {
		mkdirSync(profile("twin"), { recursive: true });
		writeFileSync(path.join(profile("twin"), "Cookies"), "x");
		const daemon = await startFakeDaemon(
			sessionKey({ name: "twin", scratch: true }),
			{ profileDir: null },
		);
		const env = clientEnv();
		try {
			expect(await handler(argsFor(spec, "-s=twin"), env)).toBe(0);
			expect(env.stdout).toEqual(["No saved data for session 'twin'."]);
			expect(existsSync(path.join(profile("twin"), "Cookies"))).toBe(true);
			expect(daemon.child.killed || daemon.child.exitCode !== null).toBe(true);
		} finally {
			daemon.dispose();
		}
	});

	test("refuses a profile reached through a symlink that leaves the profiles directory", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "pw-outside-"));
		writeFileSync(path.join(outside, "keep"), "x");
		mkdirSync(path.dirname(profile("link")), { recursive: true });
		symlinkSync(outside, profile("link"));
		const daemon = await startFakeDaemon("linked", {
			profileDir: path.join(profile("link"), "customer"),
		});
		mkdirSync(path.join(outside, "customer"));
		const env = clientEnv();
		try {
			expect(await handler(argsFor(spec, "-s=linked"), env)).toBe(1);
			expect(env.stderr[0]).toStartWith("Refusing to delete");
			expect(existsSync(path.join(outside, "customer"))).toBe(true);
		} finally {
			daemon.dispose();
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("delete-data on the protected Proton session", () => {
	let dgHome = "";
	let previousHome: string | undefined;

	beforeEach(() => {
		previousHome = process.env["DG_HOME"];
		dgHome = mkdtempSync(path.join(tmpdir(), "pw-proton-home-"));
		process.env["DG_HOME"] = dgHome;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env["DG_HOME"];
		else process.env["DG_HOME"] = previousHome;
		rmSync(dgHome, { recursive: true, force: true });
	});

	const inboxDir = () => path.join(resolveDgPaths().stateDir, "inbox");

	test("deletes the local Proton profile and the sign-in marker", async () => {
		mkdirSync(path.join(inboxDir(), "proton-profile", "Default"), {
			recursive: true,
		});
		writeFileSync(path.join(inboxDir(), "proton-signed-in.json"), "{}");
		const env = clientEnv();
		expect(
			await deleteProtectedData("inbox-proton", null, env, {
				wsl: false,
				windowsProfileDir: async () => {
					throw new Error("not on WSL");
				},
				reapStale: async () => {},
			}),
		).toBe(0);
		expect(existsSync(path.join(inboxDir(), "proton-profile"))).toBe(false);
		expect(existsSync(path.join(inboxDir(), "proton-signed-in.json"))).toBe(
			false,
		);
		expect(env.stdout[0]).toContain("proton-profile");
	});

	test("looks up the Windows profile on WSL and clears the marker when nothing is saved", async () => {
		mkdirSync(inboxDir(), { recursive: true });
		writeFileSync(path.join(inboxDir(), "proton-signed-in.json"), "{}");
		const asked: string[] = [];
		const env = clientEnv();
		expect(
			await deleteProtectedData("INBOX-PROTON", null, env, {
				wsl: true,
				windowsProfileDir: async (name) => {
					asked.push(name);
					return "Z:\\dg-test-missing\\playwright-cli\\profiles\\inbox-proton";
				},
				reapStale: async () => {},
			}),
		).toBe(0);
		expect(asked).toEqual(["inbox-proton"]);
		expect(existsSync(path.join(inboxDir(), "proton-signed-in.json"))).toBe(
			false,
		);
		expect(env.stdout[0]).toStartWith("No saved data");
	});

	test("refuses and keeps the profile while a retained protected browser survives", async () => {
		const profileDir = path.join(inboxDir(), "proton-profile");
		mkdirSync(profileDir, { recursive: true });
		write({
			name: "inbox-proton",
			key: "inbox-proton",
			pid: 2147483646,
			socketPath: socketPathFor("inbox-proton"),
			cwd: "/tmp",
			outputDir: "/tmp",
			mode: "cdp",
			browser: "chrome",
			headless: true,
			scratch: false,
			codegen: false,
			profileDir: "C:\\p\\inbox-proton",
			cdpUrl: "http://127.0.0.1:20555",
			winPid: 4242,
			startedAt: "2026-11-02T00:00:00.000Z",
		});
		let reaped = 0;
		const env = clientEnv();
		expect(
			await deleteProtectedData("inbox-proton", null, env, {
				wsl: true,
				windowsProfileDir: async () => "Z:\\dg-test-missing",
				reapStale: async () => void (reaped += 1),
			}),
		).toBe(1);
		expect(reaped).toBe(1);
		expect(existsSync(profileDir)).toBe(true);
		expect(env.stderr[0]).toContain("Could not close the browser");
	});
});
