import { afterEach, describe, expect, test } from "bun:test";
import click from "../../../src/pw/commands/click/spec";
import open from "../../../src/pw/commands/open/spec";
import snapshot from "../../../src/pw/commands/snapshot/spec";
import { commandName, normalize, parse, UsageError } from "../../../src/pw/core/args";
import { commandHelp } from "../../../src/pw/core/help";
import { defineCommand } from "../../../src/pw/core/spec";

afterEach(() => {
	delete process.env["PLAYWRIGHT_CLI_SESSION"];
});

describe("normalize", () => {
	test("rewrites -s=X to --session=X", () => {
		expect(normalize(["-s=github", "click", "e5"])).toEqual(["--session=github", "click", "e5"]);
	});

	test("joins a separated --session value", () => {
		expect(normalize(["--session", "github", "click"])).toEqual(["--session=github", "click"]);
	});

	test("leaves tokens after the terminator alone", () => {
		expect(normalize(["type", "--", "-s=x"])).toEqual(["type", "--", "-s=x"]);
	});

	test("rejects bare -s and suggests --scratch", () => {
		expect(() => normalize(["open", "-s"])).toThrow(/--scratch/);
	});
});

describe("commandName", () => {
	test("skips leading flags", () => {
		expect(commandName(["--session=a", "--raw", "eval", "1"])).toBe("eval");
	});

	test("returns undefined when only flags are present", () => {
		expect(commandName(["--help"])).toBeUndefined();
	});
});

describe("parse", () => {
	test("parses session, command, positionals, and flags", () => {
		const args = parse(["-s=github", "click", "e5", "--modifiers=Shift"], click);
		expect(args).toMatchObject({
			session: "github",
			command: "click",
			positionals: ["e5"],
			flags: { modifiers: "Shift" },
			raw: false,
			codegen: false,
		});
	});

	test("reads global flags anywhere in the argv", () => {
		const args = parse(["--raw", "snapshot", "--codegen", "--depth=2"], snapshot);
		expect(args).toMatchObject({ raw: true, codegen: true, flags: { depth: "2" } });
	});

	test("falls back to PLAYWRIGHT_CLI_SESSION, then default", () => {
		expect(parse(["snapshot"], snapshot).session).toBe("default");
		process.env["PLAYWRIGHT_CLI_SESSION"] = "env-session";
		expect(parse(["snapshot"], snapshot).session).toBe("env-session");
	});

	test("rejects an unknown option with exit code 2 and the command help", () => {
		const attempt = () => parse(["click", "e5", "--bogus"], click);
		expect(attempt).toThrow(UsageError);
		try {
			attempt();
		} catch (error) {
			const usage = error as UsageError;
			expect(usage.exitCode).toBe(2);
			expect(usage.message).toStartWith("Unknown option: --bogus");
			expect(usage.message).toContain("pw click <target> [button]");
		}
	});

	test("rejects a missing required positional", () => {
		expect(() => parse(["click"], click)).toThrow("Missing argument: <target>");
	});

	test("rejects an extra positional", () => {
		expect(() => parse(["click", "e1", "left", "extra"], click)).toThrow("Unexpected argument: extra");
	});

	test("accepts text that starts with a dash after the terminator", () => {
		const args = parse(["fill", "e1", "--", "-5"], {
			...click,
			name: "fill",
			positionals: [
				{ name: "target", required: true },
				{ name: "text", required: true },
			],
		});
		expect(args.positionals).toEqual(["e1", "-5"]);
	});

	test("rejects a session name that could escape the profile directory", () => {
		expect(() => parse(["-s=../evil", "snapshot"], snapshot)).toThrow("Invalid session name");
	});

	test("parses the full open flag set", () => {
		const args = parse(["open", "--scratch", "--headless", "--browser=msedge", "--out=/tmp/x", "https://a.test"], open);
		expect(args.flags).toEqual({ scratch: true, headless: true, browser: "msedge", out: "/tmp/x" });
		expect(args.positionals).toEqual(["https://a.test"]);
	});
});

describe("negative numbers", () => {
	const spec = defineCommand({
		name: "mousewheel",
		group: "mouse",
		side: "daemon",
		positionals: [
			{ name: "dx", required: true },
			{ name: "dy", required: true },
		],
		flags: [{ name: "depth", type: "string", help: "d" }],
		help: "h",
		changesPage: false,
	});

	test("treats a negative number as a positional, not an option", () => {
		expect(parse(["mousewheel", "0", "-120"], spec).positionals).toEqual(["0", "-120"]);
		expect(parse(["mousewheel", "-1.5", "2"], spec).positionals).toEqual(["-1.5", "2"]);
	});

	test("still rejects an unknown option", () => {
		expect(() => parse(["mousewheel", "0", "-x"], spec)).toThrow("Unknown option");
	});
});

describe("repeatable flags", () => {
	const spec = defineCommand({
		name: "route",
		group: "network",
		side: "daemon",
		positionals: [{ name: "pattern", required: true }],
		flags: [{ name: "header", type: "string", help: "h", multiple: true }],
		help: "h",
		changesPage: false,
	});

	test("joins repeated values with a newline", () => {
		expect(parse(["route", "**/x", "--header=A: 1", "--header=B: 2"], spec).flags).toEqual({ header: "A: 1\nB: 2" });
	});

	test("shows the flag as repeatable in the help", () => {
		expect(commandHelp(spec)).toContain("(repeatable)");
	});
});
