import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultSeams } from "../../src/hooks/run";
import { isolateCliTests, runGit } from "../cli-fixtures";
import { settingsWorld } from "./settings-fixtures";

const ID = "strip-ai-coauthors";
const CLI = join(import.meta.dir, "../../src/index.ts");
const USER_HOOK = '#!/bin/sh\necho ran >> "$0.log"\n';
const AI_MESSAGE =
	"feat(scope): add thing\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-Authored-By: Sam Human <sam@example.com>\n";

let world: ReturnType<typeof settingsWorld>;
isolateCliTests();
beforeEach(() => {
	world = settingsWorld();
});
afterEach(() => world.cleanup());

function makeRepo(existingHook?: string) {
	const dir = world.tmp("git-hook-repo-");
	runGit(["init", "-q", "-b", "main"], dir);
	runGit(["config", "user.name", "Test"], dir);
	runGit(["config", "user.email", "test@example.invalid"], dir);
	runGit(["config", "commit.gpgsign", "false"], dir);
	const hook = join(dir, ".git", "hooks", "commit-msg");
	mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
	if (existingHook !== undefined) {
		writeFileSync(hook, existingHook);
		chmodSync(hook, 0o755);
	}
	return { dir, hook, orig: `${hook}.dg-orig` };
}

const cli = (
	argv: string[],
	cwd: string,
	env: Record<string, string | undefined> = {},
) =>
	world.cli(argv, {
		cwd,
		env,
		seams: { run: defaultSeams().run },
	});

function installLauncher() {
	mkdirSync(join(world.dgHome, "bin"), { recursive: true });
	writeFileSync(
		world.launcher,
		`#!/bin/sh\nexec '${process.execPath}' run '${CLI}' "$@"\n`,
	);
	chmodSync(world.launcher, 0o755);
}

describe("hooks enable strip-ai-coauthors", () => {
	test("installs a commit-msg hook, chains the existing one and turns the setting on", async () => {
		const repo = makeRepo(USER_HOOK);
		const result = await cli(["enable", ID], repo.dir);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`git: enabled ${ID}`);
		expect(readFileSync(repo.orig, "utf8")).toBe(USER_HOOK);
		const script = readFileSync(repo.hook, "utf8");
		expect(script).toContain(`hooks run ${ID}`);
		expect(script).toContain(world.launcher);
		expect(statSync(repo.hook).mode & 0o111).not.toBe(0);
		expect(
			world.readJson<{ hooks: unknown }>(world.paths.config).hooks,
		).toEqual({ [ID]: { enabled: "on" } });
	});

	test("installs without a chain file when no hook exists", async () => {
		const repo = makeRepo();
		expect((await cli(["enable", ID], repo.dir)).code).toBe(0);
		expect(existsSync(repo.hook)).toBe(true);
		expect(existsSync(repo.orig)).toBe(false);
	});

	test("is idempotent and never chains its own script", async () => {
		const repo = makeRepo(USER_HOOK);
		await cli(["enable", ID], repo.dir);
		expect((await cli(["enable", ID], repo.dir)).code).toBe(0);
		expect(readFileSync(repo.orig, "utf8")).toBe(USER_HOOK);
	});

	test("refuses a repo that sets core.hooksPath and writes nothing", async () => {
		const repo = makeRepo(USER_HOOK);
		runGit(["config", "core.hooksPath", join(repo.dir, "elsewhere")], repo.dir);
		const result = await cli(["enable", ID], repo.dir);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("core.hooksPath");
		expect(readFileSync(repo.hook, "utf8")).toBe(USER_HOOK);
		expect(world.has(world.paths.config)).toBe(false);
	});

	test("refuses a repo whose core.hooksPath is set to an empty value", async () => {
		const repo = makeRepo(USER_HOOK);
		runGit(["config", "core.hooksPath", ""], repo.dir);
		const result = await cli(["enable", ID], repo.dir);
		expect(result.code).toBe(1);
		expect(readFileSync(repo.hook, "utf8")).toBe(USER_HOOK);
		expect(existsSync(repo.orig)).toBe(false);
	});

	test("fails outside a git repository", async () => {
		const result = await cli(["enable", ID], world.tmp("not-a-repo-"));
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("git repository");
	});

	test("strips an AI trailer from a real commit and still runs the chained hook", async () => {
		installLauncher();
		const repo = makeRepo(USER_HOOK);
		await cli(["enable", ID], repo.dir);
		writeFileSync(join(repo.dir, "a.txt"), "a\n");
		runGit(["add", "a.txt"], repo.dir);
		Bun.spawnSync(["git", "commit", "-q", "-m", AI_MESSAGE], {
			cwd: repo.dir,
			env: { ...process.env, DG_HOME: world.dgHome },
		});
		expect(runGit(["log", "-1", "--format=%B"], repo.dir).trimEnd()).toBe(
			"feat(scope): add thing\n\nBody.\n\nCo-Authored-By: Sam Human <sam@example.com>",
		);
		expect(existsSync(`${repo.orig}.log`)).toBe(true);
	});
});

describe("hooks disable strip-ai-coauthors", () => {
	test("restores the original hook, removes the chain file and turns the setting off", async () => {
		const repo = makeRepo(USER_HOOK);
		await cli(["enable", ID], repo.dir);
		const result = await cli(["disable", ID], repo.dir);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`git: disabled ${ID}`);
		expect(readFileSync(repo.hook, "utf8")).toBe(USER_HOOK);
		expect(statSync(repo.hook).mode & 0o111).not.toBe(0);
		expect(existsSync(repo.orig)).toBe(false);
		expect(
			world.readJson<{ hooks: Record<string, unknown> }>(world.paths.config)
				.hooks[ID],
		).toEqual({ enabled: "off" });
	});

	test("removes the hook file when none existed before", async () => {
		const repo = makeRepo();
		await cli(["enable", ID], repo.dir);
		await cli(["disable", ID], repo.dir);
		expect(existsSync(repo.hook)).toBe(false);
	});

	test("leaves a hook that dg did not write alone", async () => {
		const repo = makeRepo(USER_HOOK);
		const result = await cli(["disable", ID], repo.dir);
		expect(result.code).toBe(0);
		expect(readFileSync(repo.hook, "utf8")).toBe(USER_HOOK);
	});

	test("--all outside a git repository skips the git hook without failing", async () => {
		expect((await cli(["disable", "--all"], world.tmp("not-a-repo-"))).code).toBe(
			0,
		);
	});
});

describe("hooks status and run", () => {
	test("status reports the git hook state", async () => {
		const repo = makeRepo();
		expect((await cli(["status"], repo.dir)).stdout).toContain("git: none");
		await cli(["enable", ID], repo.dir);
		const status = await cli(["status"], repo.dir);
		expect(status.stdout).toContain(`git: ${ID}`);
		expect(status.stdout).toContain(`${ID}.enabled = on`);
	});

	test("set accepts on and off and rejects other values", async () => {
		expect((await world.cli(["set", ID, "enabled", "on"])).code).toBe(0);
		expect((await world.cli(["set", ID, "enabled", "maybe"])).code).toBe(2);
	});

	function messageFile(): string {
		const file = join(world.tmp("msg-"), "COMMIT_EDITMSG");
		writeFileSync(file, AI_MESSAGE);
		return file;
	}

	test("run leaves the message alone while the setting is off", async () => {
		const file = messageFile();
		expect((await world.cli(["run", ID, file])).code).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(AI_MESSAGE);
	});

	test("run strips the message once the setting is on", async () => {
		const file = messageFile();
		await world.cli(["set", ID, "enabled", "on"]);
		expect((await world.cli(["run", ID, file])).code).toBe(0);
		expect(readFileSync(file, "utf8")).not.toContain("Claude");
		expect(readFileSync(file, "utf8")).toContain("Sam Human");
	});

	test.each([
		[";", "; Please enter the commit message.\n"],
		["auto", "@ Please enter the commit message.\n"],
	])("run honors core.commentChar=%s from the repo config", async (char, comment) => {
		const repo = makeRepo();
		runGit(["config", "core.commentChar", char], repo.dir);
		const file = join(world.tmp("msg-"), "COMMIT_EDITMSG");
		writeFileSync(file, `${AI_MESSAGE}\n${comment}`);
		await world.cli(["set", ID, "enabled", "on"]);
		expect((await cli(["run", ID, file], repo.dir)).code).toBe(0);
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain("Claude");
		expect(text).toContain(comment);
	});

	test("DG_STRIP_AI_COAUTHORS=1 turns it on and 0 turns it off", async () => {
		const forced = messageFile();
		await world.cli(["run", ID, forced], {
			env: { DG_STRIP_AI_COAUTHORS: "1" },
		});
		expect(readFileSync(forced, "utf8")).not.toContain("Claude");
		await world.cli(["set", ID, "enabled", "on"]);
		const blocked = messageFile();
		await world.cli(["run", ID, blocked], {
			env: { DG_STRIP_AI_COAUTHORS: "0" },
		});
		expect(readFileSync(blocked, "utf8")).toBe(AI_MESSAGE);
	});
});
