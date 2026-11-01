import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerPw } from "../../src/commands/pw";
import { registerPwCode } from "../../src/commands/pw-code";

function program(): Command {
	const root = new Command("dg-skills")
		.exitOverride()
		.enablePositionalOptions();
	registerPw(root);
	registerPwCode(root);
	return root;
}

describe("registerPw and registerPwCode", () => {
	test("register pw and pw-code as separate top-level commands", () => {
		expect(
			program()
				.commands.map((command) => command.name())
				.sort(),
		).toEqual(["pw", "pw-code"]);
	});

	test("do not register code as a pw subcommand", () => {
		const pw = program().commands.find((command) => command.name() === "pw");
		expect(pw?.commands.map((command) => command.name()) ?? []).not.toContain(
			"code",
		);
	});
});
