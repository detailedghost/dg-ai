import { describe, expect, test } from "bun:test";
import * as pkg from "../src/index";

describe("package entry point", () => {
	test.each([
		"createTeamsRelayProvider",
		"createRunners",
		"createVerdictReader",
		"createStackReader",
		"connect",
		"serve",
		"start",
		"stop",
		"status",
	])("exports %s as a function", (name) => {
		expect(typeof (pkg as Record<string, unknown>)[name]).toBe("function");
	});

	test("keeps the slice 1 exports", () => {
		expect(typeof pkg.createEngine).toBe("function");
		expect(typeof pkg.loadConfig).toBe("function");
	});
});
