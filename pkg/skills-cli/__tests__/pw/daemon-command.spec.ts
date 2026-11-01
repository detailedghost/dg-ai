import { describe, expect, test } from "bun:test";
import { selfCommand } from "@dg/common/node";
import * as daemonCommandModule from "../../src/pw/core/daemon-command";
import { isDaemonOf } from "../../src/pw/core/registry";

const KEY = "default";
const SPEC = JSON.stringify({ key: KEY });
const record = { pid: 1, key: KEY };

describe("daemonCommand", () => {
	test("equals the self command for the hidden daemon route", () => {
		expect(daemonCommandModule.daemonCommand()).toEqual(
			selfCommand(["pw", "__daemon"]),
		);
	});

	test("ignores a PW_DAEMON override", () => {
		const previous = process.env["PW_DAEMON"];
		process.env["PW_DAEMON"] = "/x/pw-daemon";
		try {
			expect(daemonCommandModule.daemonCommand()).toEqual(
				selfCommand(["pw", "__daemon"]),
			);
		} finally {
			if (previous === undefined) delete process.env["PW_DAEMON"];
			else process.env["PW_DAEMON"] = previous;
		}
	});
});

describe("isDaemonOf", () => {
	test("accepts the bundled dg.js command line", () => {
		expect(
			isDaemonOf(record, [
				"/usr/bin/bun",
				"/opt/dg/dg.js",
				"dg-skills",
				"pw",
				"__daemon",
				SPEC,
			]),
		).toBe(true);
	});

	test("accepts the source entrypoint command line", () => {
		const cmdline = [
			"/usr/bin/bun",
			"/repo/pkg/skills-cli/src/index.ts",
			"pw",
			"__daemon",
			SPEC,
		];
		expect(isDaemonOf(record, cmdline)).toBe(true);
	});

	test("accepts the compiled binary command line", () => {
		expect(
			isDaemonOf(record, ["/home/u/.dg/bin/dg-skills", "pw", "__daemon", SPEC]),
		).toBe(true);
	});

	test("rejects a daemon spec carrying another session key", () => {
		const cmdline = [
			"/usr/bin/bun",
			"/opt/dg/dg.js",
			"dg-skills",
			"pw",
			"__daemon",
			JSON.stringify({ key: "other" }),
		];
		expect(isDaemonOf(record, cmdline)).toBe(false);
	});

	test("rejects an unrelated dg-skills command line", () => {
		expect(
			isDaemonOf(record, [
				"/usr/bin/bun",
				"/opt/dg/dg.js",
				"dg-skills",
				"stash",
				SPEC,
			]),
		).toBe(false);
	});

	test("rejects a daemon command line whose last argument is not JSON", () => {
		expect(
			isDaemonOf(record, [
				"/usr/bin/bun",
				"/opt/dg/dg.js",
				"dg-skills",
				"pw",
				"__daemon",
				"nope",
			]),
		).toBe(false);
	});
});
