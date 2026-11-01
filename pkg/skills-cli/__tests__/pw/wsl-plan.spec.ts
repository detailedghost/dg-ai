import { describe, expect, test } from "bun:test";
import { wslPlan } from "../../src/pw/commands/open/run";

const EXPERIMENTAL = "experimental: headed browser inside WSL (WSLg)";

describe("wslPlan", () => {
	test("picks Windows mode when no flag is given and a Windows browser exists", () => {
		expect(wslPlan({}, true)).toEqual({ mode: "windows" });
	});

	test("falls back to a headless local launch when no Windows browser exists", () => {
		expect(wslPlan({}, false)).toEqual({ mode: "local", headless: true });
	});

	test("--wsl-headed launches a headed local browser with the experimental warning", () => {
		expect(wslPlan({ "wsl-headed": true }, true)).toEqual({
			mode: "local",
			headless: false,
			warning: EXPERIMENTAL,
		});
	});

	test("--wsl-headed stays local when no Windows browser exists", () => {
		expect(wslPlan({ "wsl-headed": true }, false)).toEqual({
			mode: "local",
			headless: false,
			warning: EXPERIMENTAL,
		});
	});

	test("an explicit --browser stays local even when a Windows browser exists", () => {
		expect(wslPlan({ browser: "chrome" }, true)).toEqual({
			mode: "local",
			headless: true,
		});
	});

	test("an explicit --windows forces Windows mode whether or not a Windows browser exists", () => {
		expect(wslPlan({ windows: true }, false)).toEqual({ mode: "windows" });
		expect(wslPlan({ windows: true }, true)).toEqual({ mode: "windows" });
	});

	test("an explicit --browser stays headless without --wsl-headed", () => {
		expect(wslPlan({ browser: "chrome" }, false)).toEqual({
			mode: "local",
			headless: true,
		});
	});

	test("an explicit --browser with --headless plans a headless local launch", () => {
		expect(wslPlan({ browser: "chrome", headless: true }, true)).toEqual({
			mode: "local",
			headless: true,
		});
	});

	test("the plain headless plan carries no experimental warning", () => {
		expect(wslPlan({}, false)).not.toHaveProperty("warning");
	});
});
