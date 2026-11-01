import { describe, expect, test } from "bun:test";
import { isOwned, ownedCommand } from "../../src/hooks/settings/marker";

describe("isOwned", () => {
	test.each([
		"/home/u/.dg/bin/dg-skills hooks run spelling",
		"dg-skills hooks run pr-confirm",
		"C:\\Users\\u\\.dg\\bin\\dg-skills.cmd hooks run format",
		"C:\\Users\\u\\.dg\\bin\\dg-skills.exe hooks run daily-prune",
		"'/opt/My Apps/dg-skills' hooks run spelling",
		'"C:\\Users\\Jane Doe\\.dg\\bin\\dg-skills.exe" hooks run format',
	])("matches %s", (command) => {
		expect(isOwned(command)).toBe(true);
	});

	test.each([
		"/usr/local/bin/my-own-hook --flag",
		"dg-skills hooks run",
		"dg-skills hooks run Spelling",
		"dg-skills hooks run spelling --extra",
		"mydg-skills hooks run spelling",
		"dg-skills hooks list",
		"dg-skills hooks run spelling; rm -rf /",
		"rm -rf ~/x; dg-skills hooks run spelling",
		"true && /opt/dg-skills hooks run format",
	])("rejects %s", (command) => {
		expect(isOwned(command)).toBe(false);
	});
});

describe("ownedCommand", () => {
	test("produces a command that isOwned recognizes for every launcher style", () => {
		for (const launcher of [
			"/home/u/.dg/bin/dg-skills",
			"C:\\Users\\u\\.dg\\bin\\dg-skills.cmd",
		]) {
			const command = ownedCommand(launcher, "spelling");
			expect(command).toBe(`${launcher} hooks run spelling`);
			expect(isOwned(command)).toBe(true);
		}
	});

	test("quotes a launcher path with a space and still matches isOwned", () => {
		const posix = ownedCommand("/opt/My Apps/dg-skills", "spelling");
		expect(posix).toBe("'/opt/My Apps/dg-skills' hooks run spelling");
		const windows = ownedCommand(
			"C:\\Users\\Jane Doe\\.dg\\bin\\dg-skills.exe",
			"format",
		);
		expect(windows.startsWith('"')).toBe(true);
		expect([posix, windows].every(isOwned)).toBe(true);
	});

	test("refuses a launcher path with shell metacharacters", () => {
		expect(() => ownedCommand("/tmp/a;rm/dg-skills", "spelling")).toThrow();
		expect(() => ownedCommand("/tmp/$HOME/dg-skills", "spelling")).toThrow();
	});
});
