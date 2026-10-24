import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsCli } from "../build";
import * as cliFixtures from "./cli-fixtures";
import { git as runGit } from "./git-repo-fixtures";

setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "dg-test-live-compiled-"));
const binary = join(root, "moved-install", "dg-skills");
const entrypoint = join(root, "test-live-entry.ts");
const gitOnlyBin = join(root, "git-only-bin");

beforeAll(async () => {
	mkdirSync(join(binary, ".."), { recursive: true });
	mkdirSync(gitOnlyBin, { recursive: true });
	const realGit = Bun.which("git");
	if (!realGit) throw new Error("git is required to run this suite");
	symlinkSync(realGit, join(gitOnlyBin, "git"));
	writeFileSync(
		entrypoint,
		`import { Command } from ${JSON.stringify(Bun.resolveSync("commander", import.meta.dir))};
import { registerTestLive } from ${JSON.stringify(join(import.meta.dir, "../src/commands/test-live.ts"))};
const program = new Command().name("dg-skills").enablePositionalOptions();
registerTestLive(program);
await program.parseAsync(process.argv);
`,
	);
	await buildSkillsCli({ outfile: binary, entrypoint });
}, 240_000);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function isolatedEnv(): Record<string, string> {
	return cliFixtures.isolatedGitEnv({
		path: gitOnlyBin,
		home: mkdtempSync(join(tmpdir(), "dg-test-live-compiled-home-")),
		scratch: mkdtempSync(join(tmpdir(), "dg-test-live-compiled-scratch-")),
		state: mkdtempSync(join(tmpdir(), "dg-test-live-compiled-state-")),
	});
}

describe("compiled dg-skills test-live from an external cwd, with no legacy scripts on PATH", () => {
	test("rejects a GitLab origin with no network call and no git mutation", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "dg-test-live-compiled-gitlab-"));
		runGit(["init", "-q", "-b", "feature/external-cwd"], cwd);
		runGit(["remote", "add", "origin", "git@gitlab.com:acme/widgets.git"], cwd);
		runGit(["commit", "-q", "--allow-empty", "-m", "chore: init"], cwd);

		const proc = Bun.spawn([binary, "test-live", "setup", "dev"], {
			cwd,
			env: isolatedEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(1);
		expect(stderr).toContain("GitHub only");
	});

	test("cleanup with no prior setup reports a missing state file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "dg-test-live-compiled-cleanup-"));
		runGit(["init", "-q", "-b", "feature/external-cwd"], cwd);
		runGit(["commit", "-q", "--allow-empty", "-m", "chore: init"], cwd);

		const proc = Bun.spawn([binary, "test-live", "cleanup"], {
			cwd,
			env: isolatedEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(1);
		expect(stderr).toContain("no state file");
	});
});
