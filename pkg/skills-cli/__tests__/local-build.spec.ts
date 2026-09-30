import { describe, expect, test } from "bun:test";
import { localBuildScripts } from "../src/commands/install";

describe("localBuildScripts", () => {
	test("installs dependencies first when they are missing", () => {
		expect(localBuildScripts("chrome", false)).toEqual([
			["install"],
			["run", "build"],
		]);
	});

	test("skips the install when dependencies are present", () => {
		expect(localBuildScripts("chrome", true)).toEqual([["run", "build"]]);
	});

	test("builds the firefox bundle for the firefox target", () => {
		expect(localBuildScripts("firefox", true)).toEqual([
			["run", "build:firefox"],
		]);
	});
});
