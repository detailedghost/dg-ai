import { describe, expect, test } from "bun:test";
import { providerFlag, takeExtFlag, usesFixture } from "../src/commands/inbox";

describe("inbox flag parsing", () => {
	test("takeExtFlag removes --ext and reports it", () => {
		expect(takeExtFlag(["load", "--ext", "folders"])).toEqual({
			ext: true,
			args: ["load", "folders"],
		});
	});

	test("takeExtFlag keeps --ext when it is the value of another flag", () => {
		expect(takeExtFlag(["--data-path", "--ext"])).toEqual({
			ext: false,
			args: ["--data-path", "--ext"],
		});
	});

	test("takeExtFlag works together with --data-path", () => {
		const result = takeExtFlag(["--ext", "--data-path", "fixture.json"]);
		expect(result.ext).toBe(true);
		expect(usesFixture(result.args)).toBe(true);
	});

	test("providerFlag reads --provider=value", () => {
		expect(providerFlag(["--provider=protonmail"])).toBe("protonmail");
	});

	test("providerFlag returns undefined when --provider is last", () => {
		expect(providerFlag(["load", "--provider"])).toBeUndefined();
	});
});
