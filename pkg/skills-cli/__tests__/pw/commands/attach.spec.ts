import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../src/pw/core/args";
import { type SessionRecord, socketPathFor, write } from "../../../src/pw/core/registry";
import { argsFor, clientEnv, useFakeDaemons, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/attach/run";
import spec from "../../../src/pw/commands/attach/spec";

useTempScratch();
const daemons = useFakeDaemons();

const heldByAnotherCwd = (): SessionRecord => ({
	name: "remote",
	key: "remote",
	pid: daemons.pidFor("remote"),
	socketPath: socketPathFor("remote"),
	cwd: "/a",
	outputDir: "/tmp/out",
	mode: "cdp",
	browser: "chrome",
	headless: false,
	scratch: false,
	codegen: false,
	profileDir: null,
	cdpUrl: "http://127.0.0.1:9222",
	startedAt: "2026-10-07T00:00:00.000Z",
});

describe("attach", () => {
	test("parses --cdp", () => {
		expect(argsFor(spec, "--cdp=http://127.0.0.1:9222").flags).toEqual({ cdp: "http://127.0.0.1:9222" });
	});

	test("needs --cdp", async () => {
		await expect(handler(argsFor(spec), clientEnv())).rejects.toThrow("attach needs --cdp=<url>");
	});

	test.each(["not a url", "file:///etc/passwd", "ftp://127.0.0.1:9222"])("rejects %s", async (value) => {
		await expect(handler(argsFor(spec, `--cdp=${value}`), clientEnv())).rejects.toBeInstanceOf(UsageError);
	});

	test("refuses a session that another directory holds", async () => {
		write(heldByAnotherCwd());
		const env = clientEnv("/b");
		expect(await handler(argsFor(spec, "-s=remote", "--cdp=http://127.0.0.1:9222"), env)).toBe(1);
		expect(env.stderr[0]).toStartWith("session 'remote' is open from /a");
	});
});
