import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { completionScript } from "@dg/common/completion";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const GENERATOR = join(import.meta.dir, "..", "..", "..", "scripts", "completion-trees.ts");

describe("the dg-daemon completion tree", () => {
	test("completion-tree.json matches the registered commands; run bun scripts/completion-trees.ts after a command change", () => {
		const run = Bun.spawnSync([process.execPath, GENERATOR, "--check", "dg-daemon"], { stdout: "pipe", stderr: "pipe" });
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
	}, 30_000);

	test("dg-daemon completion prints the script that calls dg-daemon __complete", () => {
		const run = Bun.spawnSync([process.execPath, ENTRY, "completion", "zsh"], { stdout: "pipe" });
		expect(run.stdout.toString()).toBe(completionScript("zsh", "dg-daemon"));
	});
});
