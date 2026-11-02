import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { addExtOption, EXT_FLAG } from "../src/utils/ext-flag";

test("EXT_FLAG is the literal --ext", () => {
	expect(EXT_FLAG).toBe("--ext");
});

describe("addExtOption", () => {
	const build = () => {
		const seen: Array<{ ext?: boolean }> = [];
		const command = addExtOption(new Command("sample").exitOverride());
		command.action(() => void seen.push(command.opts()));
		return { command, seen };
	};

	test("returns the same command so calls chain", () => {
		const command = new Command("sample");
		expect(addExtOption(command)).toBe(command);
	});

	test("parses --ext into opts.ext", async () => {
		const { command, seen } = build();
		await command.parseAsync(["--ext"], { from: "user" });
		expect(seen[0]?.ext).toBe(true);
	});

	test("leaves opts.ext unset without the flag", async () => {
		const { command, seen } = build();
		await command.parseAsync([], { from: "user" });
		expect(seen[0]?.ext).toBeFalsy();
	});

	test("describes the option for --help", () => {
		const { command } = build();
		const option = command.options.find((o) => o.long === EXT_FLAG);
		expect(option?.description).toBe(
			"use the dg-ai-extension instead of the local default",
		);
	});
});
