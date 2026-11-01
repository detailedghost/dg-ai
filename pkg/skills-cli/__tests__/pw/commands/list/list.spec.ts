import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/list/run";
import spec from "../../../../src/pw/commands/list/spec";
import { argsFor, clientEnv, startFakeDaemon, useTempScratch } from "../../../../src/pw/test-support";

useTempScratch();

describe("list", () => {
	test("says so when no browser is open", async () => {
		const env = clientEnv();
		expect(await handler(argsFor(spec), env)).toBe(0);
		expect(env.stdout).toEqual(["### Browsers\n(none open)"]);
	});

	test("prints name, status, cwd, browser, profile or <in-memory>, and pid", async () => {
		const persistent = await startFakeDaemon("github", {
			profileDir: "/profiles/github",
			cwd: "/a",
		});
		const scratch = await startFakeDaemon("web@abc12345", {
			cwd: "/b",
			browser: "firefox",
		});
		const env = clientEnv();
		try {
			await handler(argsFor(spec), env);
			expect(env.stdout[0]).toBe(
				[
					"### Browsers",
					"- github:",
					"  - status: open",
					"  - cwd: /a",
					"  - browser: chrome",
					"  - profile: /profiles/github",
					`  - pid: ${persistent.child.pid}`,
					"- web@abc12345:",
					"  - status: open",
					"  - cwd: /b",
					"  - browser: firefox",
					"  - profile: <in-memory>",
					`  - pid: ${scratch.child.pid}`,
				].join("\n"),
			);
		} finally {
			persistent.dispose();
			scratch.dispose();
		}
	});

	test("shows the mode and CDP endpoint of a CDP session", async () => {
		const daemon = await startFakeDaemon("win", {
			mode: "cdp",
			cdpUrl: "http://127.0.0.1:9333",
			profileDir: "C:\\profiles\\win",
		});
		const env = clientEnv();
		try {
			await handler(argsFor(spec), env);
			expect(env.stdout[0]).toEndWith("  - mode: cdp\n  - cdp: http://127.0.0.1:9333");
		} finally {
			daemon.dispose();
		}
	});

	test("drops sessions whose daemon is gone", async () => {
		const daemon = await startFakeDaemon("github");
		daemon.child.kill();
		await daemon.child.exited;
		const env = clientEnv();
		await handler(argsFor(spec), env);
		expect(env.stdout).toEqual(["### Browsers\n(none open)"]);
		daemon.dispose();
	});
});
