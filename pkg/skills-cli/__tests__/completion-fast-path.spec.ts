import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { completeFast } from "../src/completion/fast";
import { fenceEnv } from "./fence-env";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

const FIXTURES: string[][] = [
	[""],
	["st"],
	["stat", "ch"],
	["credentials", "re"],
	["pw", "--ext", "sn"],
	["pw", "--ext", "--tab", "42", "sn"],
	["completion", "--in"],
	["completion", "f"],
	["adr", ""],
	["adr", "re"],
	["adr", "relevant", ""],
	["--"],
	["--he"],
	["no-such-command", ""],
	["stat", "--", "ch"],
];

function fullCompletion(words: readonly string[]): string[] {
	const run = Bun.spawnSync([process.execPath, ENTRY, "__complete", ...words], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...fenceEnv() },
	});
	expect(run.exitCode).toBe(0);
	return run.stdout.toString().split("\n").filter(Boolean);
}

describe("completeFast", () => {
	test.each(FIXTURES)("returns the full completion candidates for %j", (...words) => {
		const candidates = fullCompletion(words);
		expect(completeFast(words)).toEqual(candidates);
	});

	test("lists top-level commands for an empty word", () => {
		expect(completeFast([""]).length).toBeGreaterThan(10);
	});

	test("returns nothing for an unknown command", () => {
		expect(completeFast(["no-such-command", ""])).toEqual([]);
	});
});
