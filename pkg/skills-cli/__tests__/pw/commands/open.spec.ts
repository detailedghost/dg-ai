import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../../../src/pw/core/args";
import { refusal } from "../../../src/pw/core/launch";
import { read, type SessionRecord, socketPathFor, write } from "../../../src/pw/core/registry";
import { argsFor, clientEnv, useFakeDaemons, useTempEnv, useTempScratch } from "../../../src/pw/test-support";
import handler, { parseSessionDepth } from "../../../src/pw/commands/open/run";
import spec from "../../../src/pw/commands/open/spec";

useTempScratch();
const daemons = useFakeDaemons();
useTempEnv("AI_STATE_DIR");
const cacheRoot = useTempEnv("XDG_CACHE_HOME");

const heldByAnotherCwd = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
	name: "github",
	key: "github",
	pid: daemons.pidFor("github"),
	socketPath: socketPathFor("github"),
	cwd: "/a",
	outputDir: "/tmp/out",
	mode: "local",
	browser: "chrome",
	headless: true,
	scratch: false,
	codegen: false,
	profileDir: "/profiles/github",
	startedAt: "2026-10-07T00:00:00.000Z",
	...overrides,
});

describe("open spec", () => {
	test("declares the full flag set", () => {
		const args = argsFor(
			spec,
			"https://a.test",
			"--scratch",
			"--headless",
			"--windows",
			"--browser=msedge",
			"--profile=/p",
			"--from=site",
			"--out=/o",
			"--persistent",
		);
		expect(args.flags).toEqual({
			scratch: true,
			headless: true,
			windows: true,
			browser: "msedge",
			profile: "/p",
			from: "site",
			out: "/o",
			persistent: true,
		});
	});

	test("treats bare -s as a usage error that suggests --scratch", () => {
		expect(() => argsFor(spec, "-s")).toThrow("--scratch");
	});
});

describe("open handler", () => {
	test("--from rejects an invalid state name with exit 2 before it starts a browser", async () => {
		await expect(handler(argsFor(spec, "--from=../x"), clientEnv())).rejects.toMatchObject({ exitCode: 2 });
	});

	test("--from reports an unknown state and leaves a running session alone", async () => {
		write(heldByAnotherCwd({ cwd: "/b" }));
		await expect(handler(argsFor(spec, "-s=github", "--from=nope"), clientEnv("/b"))).rejects.toThrow(
			"No saved state 'nope'. Run: pw state list",
		);
		expect(read("github")).not.toBeNull();
	});

	test("--from runs the legacy import before it looks up the state", async () => {
		const legacy = path.join(cacheRoot.dir, "playwright-cli", "sessions");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(path.join(legacy, "old.json"), '{"cookies":[],"origins":[]}');
		const env = clientEnv();
		await expect(handler(argsFor(spec, "--from=nope"), env)).rejects.toThrow("No saved state 'nope'");
		expect(env.stdout).toEqual(["Imported 1 legacy states from ~/.cache/playwright-cli/sessions/"]);
	});

	test("--windows checks its usage rules before it reads --from", async () => {
		await expect(handler(argsFor(spec, "--windows", "--scratch", "--from=nope"), clientEnv())).rejects.toBeInstanceOf(
			UsageError,
		);
	});

	test.each(["firefox", "webkit", "chromium"])("--windows refuses --browser=%s with a usage error", async (browser) => {
		await expect(handler(argsFor(spec, "--windows", `--browser=${browser}`), clientEnv())).rejects.toMatchObject({
			message: "--windows supports chrome and msedge",
			exitCode: 2,
		});
	});

	test.each([
		['C:\\p\\gh" --disable-web-security'],
		["C:\\p\\gh\u2018; calc; \u2018"],
	])("--windows rejects the unsafe profile %p before it stops a running session", async (profile) => {
		const held = heldByAnotherCwd({ cwd: "/b" });
		write(held);
		await expect(
			handler(argsFor(spec, "--windows", "-s=github", `--profile=${profile}`), clientEnv("/b")),
		).rejects.toBeInstanceOf(UsageError);
		expect(read("github")?.pid).toBe(held.pid);
	});

	test("--windows refuses --scratch", async () => {
		await expect(handler(argsFor(spec, "--windows", "--scratch"), clientEnv())).rejects.toBeInstanceOf(UsageError);
	});

	test("--windows refuses a session that another directory holds before it starts a browser", async () => {
		write(heldByAnotherCwd());
		const env = clientEnv("/b");
		expect(await handler(argsFor(spec, "--windows", "-s=github"), env)).toBe(1);
		expect(env.stderr[0]).toStartWith("session 'github' is open from /a");
	});

	test("refuses to open a persistent session that another directory holds", async () => {
		const held = heldByAnotherCwd();
		write(held);
		const env = clientEnv("/b");
		const code = await handler(argsFor(spec, "-s=github", "--headless"), env);
		expect(code).toBe(1);
		expect(env.stderr).toEqual([
			`session 'github' is open from /a (pid ${held.pid}). Run 'pw -s=github close' there or pick another -s=github.`,
		]);
		expect(env.stdout).toEqual([]);
	});

	test("rejects an unknown browser before touching a running session", async () => {
		write(heldByAnotherCwd({ cwd: "/b" }));
		await expect(handler(argsFor(spec, "-s=github", "--browser=netscape"), clientEnv("/b"))).rejects.toBeInstanceOf(
			UsageError,
		);
	});
});

describe("refusal", () => {
	test("names the session, the holding directory, and the pid", () => {
		expect(refusal({ name: "default", cwd: "/home/me/a", pid: 42 })).toBe(
			"session 'default' is open from /home/me/a (pid 42). Run 'pw -s=default close' there or pick another -s=default.",
		);
	});
});

describe("parseSessionDepth", () => {
	test("leaves the depth unset without a flag and accepts non-negative integers", () => {
		expect(parseSessionDepth(undefined)).toBeUndefined();
		expect(parseSessionDepth("0")).toBe(0);
		expect(parseSessionDepth("8")).toBe(8);
	});

	test.each(["-1", "2.5", "deep", ""])("rejects %p with a usage error", (value) => {
		expect(() => parseSessionDepth(value)).toThrow("Invalid --depth");
	});
});
