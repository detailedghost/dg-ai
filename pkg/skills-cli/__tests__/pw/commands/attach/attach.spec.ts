import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/attach/run";
import spec from "../../../../src/pw/commands/attach/spec";
import { UsageError } from "../../../../src/pw/core/args";
import {
	type SessionRecord,
	socketPathFor,
	write,
} from "../../../../src/pw/core/registry";
import {
	argsFor,
	clientEnv,
	useFakeDaemons,
	useTempScratch,
} from "../../../../src/pw/test-support";

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
		expect(argsFor(spec, "--cdp=http://127.0.0.1:9222").flags).toEqual({
			cdp: "http://127.0.0.1:9222",
		});
	});

	test("needs --cdp", async () => {
		await expect(handler(argsFor(spec), clientEnv())).rejects.toThrow(
			"attach needs --cdp=<url>",
		);
	});

	test.each([
		"not a url",
		"file:///etc/passwd",
		"ftp://127.0.0.1:9222",
		"http://10.0.0.5:9222",
		"http://127.0.0.1",
	])("rejects %s", async (value) => {
		await expect(
			handler(argsFor(spec, `--cdp=${value}`), clientEnv()),
		).rejects.toBeInstanceOf(UsageError);
	});

	test("refuses a session that another directory holds", async () => {
		write(heldByAnotherCwd());
		const env = clientEnv("/b");
		expect(
			await handler(
				argsFor(spec, "-s=remote", "--cdp=http://127.0.0.1:9222"),
				env,
			),
		).toBe(1);
		expect(env.stderr[0]).toStartWith("session 'remote' is open from /a");
	});

	test("refuses to attach to the CDP endpoint of a protected session", async () => {
		write({
			...heldByAnotherCwd(),
			name: "inbox-proton",
			key: "inbox-proton",
			pid: daemons.pidFor("inbox-proton"),
			socketPath: socketPathFor("inbox-proton"),
		});
		const env = clientEnv("/b");
		expect(
			await handler(
				argsFor(spec, "-s=mail-copy", "--cdp=ws://127.0.0.1:9222/devtools/browser/x"),
				env,
			),
		).toBe(1);
		expect(env.stderr[0]).toContain("refuses to attach to the inbox-proton browser");
	});
});
