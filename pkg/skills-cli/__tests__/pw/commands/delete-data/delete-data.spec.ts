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
import handler from "../../../../src/pw/commands/delete-data/run";
import { sessionKey } from "../../../../src/pw/core/registry";
import spec from "../../../../src/pw/commands/delete-data/spec";
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

	test("treats a scratch session as having no saved data and keeps the persistent profile", async () => {
		mkdirSync(profile("twin"), { recursive: true });
		writeFileSync(path.join(profile("twin"), "Cookies"), "x");
		const daemon = await startFakeDaemon(sessionKey({ name: "twin", scratch: true }), { profileDir: null });
		const env = clientEnv();
		try {
			expect(await handler(argsFor(spec, "-s=twin"), env)).toBe(0);
			expect(env.stdout).toEqual(["No saved data for session 'twin'."]);
			expect(existsSync(path.join(profile("twin"), "Cookies"))).toBe(true);
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
