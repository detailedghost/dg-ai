import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { scratchFixtures } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";
import { splitFrontmatter } from "./spec-fixtures";
import {
	FLAG,
	SHELL_LANGS,
	codeSpans,
	fences,
	flagsTable,
	hasShellComment,
	skillDir,
	skillText,
	treeText,
	usageLine,
	walk,
} from "./skill-tree-helpers";

function requiredFlagsTable(text: string) {
	const table = flagsTable(text);
	expect(table).not.toBeNull();
	return table as NonNullable<ReturnType<typeof flagsTable>>;
}

const BG_VERBS = ["run", "list", "status", "cancel", "kill", "update", "prune"];

describe.each(["bg", "cls", "stat"])("packaged %s skill tree", (name) => {
	test("is named for the skill and carries no host-only frontmatter keys", () => {
		const { data } = splitFrontmatter(skillText(name)) as {
			data: Record<string, unknown>;
		};
		expect(data.name).toBe(name);
		expect(String(data.description).length).toBeGreaterThan(0);
		expect(data).not.toHaveProperty("argument-hint");
		expect(data).not.toHaveProperty("user-invocable");
	});

	test("names itself with the namespaced slash form and never the bare one", () => {
		const text = skillText(name);
		expect(text).toContain(`/dg:${name}`);
		expect(text).not.toMatch(
			new RegExp(`(?<![\\w./~:$<>-])/${name}(?![\\w:/-])`),
		);
	});

	test("carries a Usage line and a four-column Flags table covering its flags", () => {
		const text = skillText(name);
		const usage = usageLine(text);
		expect(usage).not.toBe("");
		const { header, documented } = requiredFlagsTable(text);
		expect(header).toEqual(["Flag", "Short", "Effect", "Default"]);
		for (const flag of [...usage.matchAll(FLAG)].map((match) => match[1]))
			expect(documented.has(flag)).toBe(true);
	});

	test("calls the CLI only by its literal installed path behind the bootstrap gate", () => {
		const text = skillText(name);
		const gate = text.indexOf("bootstrap.sh");
		expect(gate).toBeGreaterThan(-1);
		expect(text).toContain("--cli-only");
		const firstCall = text
			.split("\n")
			.map((line, index) => ({ line, index }))
			.find(
				({ line }) => line.includes("dg-skills") && !line.includes("--help"),
			);
		const gateLine = text.slice(0, gate).split("\n").length - 1;
		expect(firstCall).toBeDefined();
		expect(gateLine).toBeLessThan(firstCall?.index ?? 0);
		for (const line of treeText(name)
			.split("\n")
			.filter((value) => /dg-skills\s+[a-z]/.test(value)))
			expect(line).toContain("~/.dg/bin/dg-skills");
	});

	test("leaves no legacy helper, private path, bare helper verb or shell comment behind", () => {
		for (const path of walk(skillDir(name))) {
			const text = readFileSync(path, "utf8");
			const file = relative(skillDir(name), path);
			for (const pattern of [
				/bg-helper|worktree-cli|vcs-provider-cli|viz-cli|proxy-helper|stat-cli/,
				/\/home\/[a-z]/,
				/scripts\/(?:bin|ai)/,
				/\$\(stash /,
				/cortex/,
				/cancelled/,
			])
				expect([file, pattern.test(text)]).toEqual([file, false]);
			for (const span of codeSpans(text))
				expect([
					file,
					span,
					/^(?:(?:bg|worktree|vcs-provider)\s+(?:run|list|status|cancel|kill|update|prune|drain|remove|create|list-prs)|(?:run|list|status|cancel|kill|update|prune|drain)(?=\s|$))/.test(
						span,
					),
				]).toEqual([file, span, false]);
			for (const { lang, body } of fences(text))
				if (SHELL_LANGS.includes(lang))
					for (const line of body.split("\n"))
						expect([file, line, hasShellComment(line)]).toEqual([
							file,
							line,
							false,
						]);
		}
	});
});

describe("packaged bg skill", () => {
	test("ships SKILL.md and the three lazy references", () => {
		for (const file of [
			"SKILL.md",
			"references/claude-code.md",
			"references/job-management.md",
			"references/other-agent.md",
		])
			expect(existsSync(join(skillDir("bg"), file))).toBe(true);
	});

	test("documents the workflow opt-in flag", () => {
		const text = skillText("bg");
		const { documented } = requiredFlagsTable(text);
		for (const flag of ["-w", "--workflow"]) {
			expect(documented.has(flag)).toBe(true);
			expect(usageLine(text)).toContain(flag);
		}
	});

	test("manages jobs through every public dg-skills bg verb", () => {
		const used = new Set(
			[...treeText("bg").matchAll(/dg-skills bg\s+([\w-]+)/g)].map(
				(match) => match[1],
			),
		);
		for (const verb of BG_VERBS.filter((value) => value !== "kill"))
			expect(used.has(verb)).toBe(true);
		for (const verb of used)
			expect([...BG_VERBS, "drain", "--help"]).toContain(verb);
	});

	test("launches other agents through bg run wrapping the proxy command as one quoted argument", () => {
		const reference = readFileSync(
			join(skillDir("bg"), "references", "other-agent.md"),
			"utf8",
		);
		expect(reference).toContain("~/.dg/bin/dg-skills bg run");
		expect(reference).toContain("~/.dg/bin/dg-skills proxy");
		expect(reference).toContain("one quoted argument");
		for (const backend of ["codex", "copilot", "pi", "opencode", "grok"])
			expect(reference).toContain(backend);
	});

	test("keeps the Claude Code native primitive guidance and never routes it through the helper", () => {
		const reference = readFileSync(
			join(skillDir("bg"), "references", "claude-code.md"),
			"utf8",
		);
		expect(reference).toContain("run_in_background");
		expect(reference).toContain("Workflow");
		expect(reference).toMatch(/Do \*\*not\*\* call .*dg-skills bg/);
	});

	test("documents the job states with the American spelling", () => {
		const reference = readFileSync(
			join(skillDir("bg"), "references", "job-management.md"),
			"utf8",
		);
		for (const state of ["running", "done", "unknown", "canceled"])
			expect(reference).toContain(state);
	});
});

describe("packaged cls skill", () => {
	test("ships SKILL.md with its detect and steps references", () => {
		for (const file of [
			"SKILL.md",
			"references/detect.md",
			"references/steps.md",
		])
			expect(existsSync(join(skillDir("cls"), file))).toBe(true);
	});

	test("documents the legacy flags", () => {
		const { documented } = requiredFlagsTable(skillText("cls"));
		for (const flag of ["--force", "--keep-branch", "--keep-assets"]) {
			expect(documented.has(flag)).toBe(true);
			expect(usageLine(skillText("cls"))).toContain(flag);
		}
	});

	test("tears down through dg-skills worktree and bg prune and merges fast-forward only", () => {
		const text = treeText("cls");
		expect(text).toContain("~/.dg/bin/dg-skills worktree remove");
		expect(text).toContain('~/.dg/bin/dg-skills bg prune --cwd "$TOP"');
		expect(text).toContain("ExitWorktree");
		expect(text).toMatch(/--ff-only/);
	});

	test("grants no allowed-tools in its frontmatter", () => {
		const { data } = splitFrontmatter(skillText("cls")) as {
			data: Record<string, unknown>;
		};
		expect(data).not.toHaveProperty("allowed-tools");
	});

	test("marks the browser close optional and guards it on pw being installed", () => {
		const steps = readFileSync(
			join(skillDir("cls"), "references", "steps.md"),
			"utf8",
		);
		expect(steps).toMatch(/optional/i);
		const block = fences(steps).find(({ body }) =>
			body.includes("dg-skills pw --help"),
		);
		expect(block?.body).toContain(
			"~/.dg/bin/dg-skills pw --help >/dev/null 2>&1",
		);
		expect(steps).not.toMatch(/command -v pw|pw close-all/);
	});

	test("never sweeps the main checkout's scratch or the shared state root by bucket", () => {
		const steps = readFileSync(
			join(skillDir("cls"), "references", "steps.md"),
			"utf8",
		);
		expect(steps).toMatch(/do not sweep/i);
	});

	test("skips the scratch sweep when BUCKET or the scratch root is empty", () => {
		const steps = readFileSync(
			join(skillDir("cls"), "references", "steps.md"),
			"utf8",
		);
		const block = fences(steps).find(({ body }) =>
			body.includes('rm -rf "$SCRATCH/pw/$BUCKET"'),
		);
		if (!block) throw new Error("cls has no scratch sweep block");
		const body = block.body;
		expect(body).toContain(': "${TOP:?');
		expect(body).toContain(': "${BUCKET:?');
		expect(body.indexOf(': "${BUCKET:?')).toBeLessThan(body.indexOf("rm -rf"));
	});
});

describe("packaged stat skill", () => {
	test("is prose only with no helper reference and no --viz", () => {
		expect(readdirSync(skillDir("stat"))).toEqual(["SKILL.md"]);
		const text = skillText("stat");
		expect(text).not.toMatch(/--viz|viz board|viz-cli/);
	});

	test("documents --long, --plain and --overwatch", () => {
		const text = skillText("stat");
		const { documented } = requiredFlagsTable(text);
		expect([...documented]).toEqual(["--long", "-l", "--plain", "-p", "--overwatch"]);
		expect(
			[...usageLine(text).matchAll(FLAG)].map((match) => match[1]),
		).toEqual(["-l", "--long", "-p", "--plain", "--overwatch"]);
	});

	test("gathers and cleans up through dg-skills subcommands", () => {
		const text = skillText("stat");
		for (const call of [
			"~/.dg/bin/dg-skills vcs-provider list-prs",
			"~/.dg/bin/dg-skills bg list",
			"~/.dg/bin/dg-skills bg prune --cwd",
			"~/.dg/bin/dg-skills worktree list",
			"~/.dg/bin/dg-skills stat checklist",
		])
			expect(text).toContain(call);
	});

	test("stays read-only except for finished-job cleanup and never stops a running job", () => {
		const text = skillText("stat");
		expect(text).toMatch(/never stop/i);
		expect(text).toContain("TaskStop");
	});

	test("falls back to the plain checklist when the overwatch agent or the daemon is missing", () => {
		const text = skillText("stat");
		expect(text).toMatch(/overwatch agent binary is missing/);
		expect(text).toMatch(/fall back to the plain checklist/i);
		expect(text).toContain("/dg:overwatch");
		expect(text.replace(/\/dg:overwatch/g, "")).not.toContain("dg:overwatch");
	});

	test("never calls stat add, stat done or stat status on itself", () => {
		const text = skillText("stat");
		expect(text).toMatch(/never calls `stat add`, `stat done`, or `stat status`/);
	});
});

describe("packaged proxy skill background calls", () => {
	test("reaches background jobs through dg-skills bg and keeps its flags table", () => {
		const text = skillText("proxy");
		for (const verb of ["status", "list", "update", "cancel"])
			expect(text).toMatch(
				new RegExp(`dg-skills bg ${verb}\\b`),
			);
		for (const span of codeSpans(text))
			expect([span, new RegExp(`^(?:${BG_VERBS.join("|")})(?=\\s|$)`).test(span)]).toEqual([
				span,
				false,
			]);
		expect(text).toContain("~/.dg/bin/dg-skills bg status");
		expect(text).not.toContain("proxy background");
		expect(text).toContain("one quoted argument");
		expect(requiredFlagsTable(text).header).toEqual([
			"Flag",
			"Short",
			"Effect",
			"Default",
		]);
	});
});

describe("stat and cls shell blocks degrade safely", () => {
	const fixtures = scratchFixtures();
	afterEach(() => fixtures.cleanup());

	function installStub(home: string, exitCode: number): string {
		const log = join(home, "calls.log");
		const bin = join(home, ".dg", "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "dg-skills"),
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> '${log}'`,
				`[ ${exitCode} -ne 0 ] && exit ${exitCode}`,
				'case "$1 $2" in',
				'  "bg list") echo \'{"jobs":[{"id":"j1","state":"done","exitCode":0,"logFile":"/l","command":"c","cwd":"\'"$PWD"\'"}]}\' ;;',
				'  "vcs-provider list-prs") echo \'[{"number":7,"state":"open","title":"t"}]\' ;;',
				'  "worktree list") echo "path=/w" ;;',
				'  "stat checklist") echo \'{"open":[],"done":[],"total":null}\' ;;',
				'  "stash -C") echo "/scratch/pw/bucket-x" ;;',
				"esac",
				"",
			].join("\n"),
		);
		chmodSync(join(bin, "dg-skills"), 0o755);
		return log;
	}

	function sh(
		block: string,
		cwd: string,
		home: string,
		pathDirs?: string[],
		extra: Record<string, string> = {},
	) {
		const proc = Bun.spawnSync(["sh", "-c", block], {
			cwd,
			env: mergeEnv({
				HOME: home,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				...(pathDirs ? { PATH: pathDirs.join(":") } : {}),
				...extra,
			}),
		});
		return {
			code: proc.exitCode,
			out: proc.stdout.toString(),
			err: proc.stderr.toString(),
		};
	}

	function gatherBlock(): string {
		const block = fences(skillText("stat")).find(({ body }) =>
			body.includes("BRANCH="),
		);
		if (!block) throw new Error("stat has no gather block");
		return block.body;
	}

	test("the stat gather block reports branch, PRs, jobs and worktrees through the installed CLI", () => {
		const home = fixtures.tmp("stat-home-");
		const { main } = fixtures.repo();
		const log = installStub(home, 0);
		const run = sh(gatherBlock(), main, home);
		expect(run.code).toBe(0);
		expect(run.out).toContain("BRANCH=main");
		for (const key of ["PRS=", "JOBS=", "WORKTREES=", "CHECKLIST="])
			expect(run.out).toContain(key);
		const calls = readFileSync(log, "utf8");
		expect(calls).toContain("vcs-provider list-prs --head main");
		expect(calls).toContain("bg list");
		expect(calls).toContain("worktree list");
		expect(calls).toContain("stat checklist --json");
	});

	test("the stat gather block still exits 0 outside a repository and when every CLI call fails", () => {
		const home = fixtures.tmp("stat-home-");
		const plain = fixtures.tmp("stat-plain-");
		installStub(home, 1);
		const outside = sh(gatherBlock(), plain, home);
		expect(outside.code).toBe(0);
		expect(outside.out).toContain("BRANCH=none");
		expect(outside.out).toContain("JOBS=[]");
		expect(outside.out).toContain("CHECKLIST=null");
		const { main } = fixtures.repo();
		const failing = sh(gatherBlock(), main, home);
		expect(failing.code).toBe(0);
		expect(failing.out).toContain("PRS=[]");
		expect(failing.out).toContain("JOBS=[]");
		expect(failing.out).toContain("CHECKLIST=null");
	});

	test("the cls detect block classifies the main and the linked checkout", () => {
		const home = fixtures.tmp("cls-home-");
		installStub(home, 0);
		const { main, linked } = fixtures.repo();
		const detect = fences(
			readFileSync(join(skillDir("cls"), "references", "detect.md"), "utf8"),
		).find(({ body }) => body.includes("KIND="));
		if (!detect) throw new Error("cls has no detect block");
		const inMain = sh(detect.body, main, home);
		expect(inMain.code).toBe(0);
		expect(inMain.out).toContain("KIND=mainrepo");
		expect(inMain.out).toContain(`MAIN=${main}`);
		expect(inMain.out).toContain("DEFAULT=main");
		const inLinked = sh(detect.body, linked, home);
		expect(inLinked.out).toContain("KIND=linked");
		expect(inLinked.out).toContain(`TOP=${linked}`);
		expect(inLinked.out).toContain("CAME_FROM=feat");
	});

	function closeBlock(): string {
		const block = fences(
			readFileSync(join(skillDir("cls"), "references", "steps.md"), "utf8"),
		).find(({ body }) => body.includes("dg-skills pw --help"));
		if (!block) throw new Error("cls has no browser close block");
		return block.body;
	}

	test("the cls browser close is skipped with a note and exit 0 when pw is not installed", () => {
		const home = fixtures.tmp("cls-home-");
		const bin = fixtures.tmp("cls-bin-");
		const shell = Bun.which("sh");
		if (!shell) throw new Error("sh is required");
		symlinkSync(shell, join(bin, "sh"));
		const run = sh(closeBlock(), home, home, [bin]);
		expect(run.code).toBe(0);
		expect(`${run.out}${run.err}`).toMatch(/pw/);
		expect(`${run.out}${run.err}`).toMatch(/skipped/i);
	});

	test("the cls scratch sweep refuses to run with an empty TOP and keeps other worktrees' scratch", () => {
		const block = fences(
			readFileSync(join(skillDir("cls"), "references", "steps.md"), "utf8"),
		).find(({ body }) => body.includes('rm -rf "$SCRATCH/pw/$BUCKET"'));
		if (!block) throw new Error("cls has no scratch sweep block");
		const body = block.body;
		const home = fixtures.tmp("cls-home-");
		const scratch = join(home, "scratch");
		mkdirSync(join(scratch, "pw", "other-worktree"), { recursive: true });
		const run = sh(body, home, home, undefined, {
			TOP: "",
			AI_SCRATCH_DIR: scratch,
		});
		expect(run.code).not.toBe(0);
		expect(existsSync(join(scratch, "pw", "other-worktree"))).toBe(true);
	});

	test("the cls browser close probes the dg pw and never a bare pw on PATH", () => {
		const home = fixtures.tmp("cls-home-");
		const bin = fixtures.tmp("cls-bin-");
		const shell = Bun.which("sh");
		if (!shell) throw new Error("sh is required");
		symlinkSync(shell, join(bin, "sh"));
		const legacy = join(home, "legacy.log");
		writeFileSync(
			join(bin, "pw"),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> '${legacy}'\n`,
		);
		chmodSync(join(bin, "pw"), 0o755);
		const skipped = sh(closeBlock(), home, home, [bin]);
		expect(`${skipped.out}${skipped.err}`).toMatch(/skipped/i);
		expect(existsSync(legacy)).toBe(false);
		const log = installStub(home, 0);
		const run = sh(closeBlock(), home, home, [bin]);
		expect(run.code).toBe(0);
		expect(run.out).toMatch(/pw is installed/);
		expect(readFileSync(log, "utf8").trim()).toBe("pw --help");
		expect(existsSync(legacy)).toBe(false);
	});
});
