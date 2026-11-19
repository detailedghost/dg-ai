import { describe, expect, test } from "bun:test";
import { REPO_ROOT, readRepoFile } from "./test-support";

const LIST = "the dg, dg-skills, dg-agent and dg-daemon launchers";
const unwrapped = (text: string): string => text.replace(/\n(?:#|\s*\*)\s*/g, " ");

function gitGrep(pattern: string, ...paths: string[]): string[] {
	const run = Bun.spawnSync(["git", "grep", "-nE", pattern, "--", ...paths], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	return run.stdout.toString().split("\n").filter(Boolean);
}

describe("the launcher list in dg-skills text", () => {
	const files: Array<[string, string[]]> = [
		["commands/install.ts", ["pkg", "skills-cli", "src", "commands", "install.ts"]],
		["install/skills-only.ts", ["pkg", "skills-cli", "src", "install", "skills-only.ts"]],
		["install/cli.ts", ["pkg", "skills-cli", "src", "install", "cli.ts"]],
		["bootstrap.sh", ["pkg", "skills-cli", "bootstrap.sh"]],
		["bootstrap.ps1", ["pkg", "skills-cli", "bootstrap.ps1"]],
		["completion/tree.json", ["pkg", "skills-cli", "src", "completion", "tree.json"]],
	];

	for (const [name, parts] of files) {
		test(`${name} names the dg, dg-skills, dg-agent and dg-daemon launchers`, () => {
			expect(unwrapped(readRepoFile(...parts))).toContain(LIST);
		});
	}

	test("the completion command description also names dg", () => {
		const source = readRepoFile("pkg", "skills-cli", "src", "commands", "completion.ts");
		const tree = readRepoFile("pkg", "skills-cli", "src", "completion", "tree.json");

		for (const text of [source, tree]) expect(text).toContain("completion files of dg, dg-skills, dg-agent and dg-daemon");
	});

	test("each copy of the Fetching the dg bundle sentence has the new list", () => {
		const files = gitGrep("Fetching the dg bundle", "pkg", "docs", "README.md", "plugins", "scripts").map((l) => l.split(":")[0]);

		expect(files.length).toBeGreaterThan(0);
		for (const file of new Set(files)) {
			const sentences = unwrapped(readRepoFile(file)).split(/(?<=[.!?])\s+/).filter((s) => s.includes("Fetching the dg bundle"));
			for (const sentence of sentences) expect([file, sentence.includes(LIST)]).toEqual([file, true]);
		}
	});
});

describe("the generated completion trees", () => {
	test("bun scripts/completion-trees.ts --check exits 0", () => {
		const run = Bun.spawnSync([process.execPath, "scripts/completion-trees.ts", "--check"], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});

		expect({ code: run.exitCode, stderr: run.stderr.toString() }).toEqual({ code: 0, stderr: "" });
	}, 60_000);
});

describe("no released skill calls dg in the legacy ~/.dg/bin folder", () => {
	test("plugins holds no .dg/bin/dg path", () => {
		expect(gitGrep(String.raw`\.dg/bin/dg\b`, "plugins")).toEqual([]);
	});
});
