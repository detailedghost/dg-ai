import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { completionScript } from "@dg/common/completion";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const GENERATOR = join(import.meta.dir, "..", "..", "..", "scripts", "completion-trees.ts");

describe("the dg-agent completion tree", () => {
	test("completion-tree.json matches the registered commands; run bun scripts/completion-trees.ts after a command change", () => {
		const run = Bun.spawnSync([process.execPath, GENERATOR, "--check", "dg-agent"], { stdout: "pipe", stderr: "pipe" });
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
	}, 30_000);

	test("dg-agent completion prints the script that calls dg-agent __complete", () => {
		const run = Bun.spawnSync([process.execPath, ENTRY, "completion", "zsh"], { stdout: "pipe" });
		expect(run.stdout.toString()).toBe(completionScript("zsh", "dg-agent"));
	});
});

describe("dg-agent __complete", () => {
	test("completes nested phone commands", () => {
		const run = Bun.spawnSync([process.execPath, ENTRY, "__complete", "phone", "contacts", "rem"], { stdout: "pipe" });
		expect(run.stdout.toString()).toBe("remove\tremove a contact; its stored messages stay\n");
	});
});
