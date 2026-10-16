/**
 * Skills-only install: the real command copies plugins/dg/skills into a temp
 * directory, fetches nothing, and does not execute skill content.
 */
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const BOOTSTRAP = join(import.meta.dir, "..", "bootstrap.sh");
const SUMMARY =
	"Skills-only install: no binaries were fetched and no skill content was executed.";

const REPO_SKILL_FILES = [
	"browser/SKILL.md",
	"browser/references/install.md",
	"channel-review/SKILL.md",
	"channel-review/references/commands.md",
	"channel-review/references/config.example.json",
	"channel-review/references/relay-setup.md",
	"channel-review/references/setup.md",
	"chat/SKILL.md",
	"demo/SKILL.md",
	"demo/references/authoring.md",
	"google-sms-cleanup/SKILL.md",
	"inbox-cleanup/SKILL.md",
	"inbox-cleanup/references/providers.md",
	"inbox-cleanup/references/workflow.md",
	"overwatch/SKILL.md",
	"proto/SKILL.md",
	"proto/agents/openai.yaml",
	"proto/references/commands.md",
	"proto/references/contracts.md",
];

type RunResult = { code: number; stdout: string; stderr: string };

function filesUnder(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) visit(abs);
			else out.push(relative(root, abs).split(sep).join("/"));
		}
	};
	visit(root);
	return out.sort();
}

function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.DG_SKILLS_DEST;
	delete env.DG_SKILLS_SOURCE;
	delete env.DG_SKILLS_ONLY;
	delete env.DG_CLI_ONLY;
	delete env.CLAUDE_PLUGIN_ROOT;
	delete env.DG_PLUGIN_ROOT;
	env.HOME = home;
	env.DG_HOME = home;
	env.LC_ALL = "C";
	return { ...env, ...extra };
}

async function run(
	argv: string[],
	env: Record<string, string>,
	cwd?: string,
): Promise<RunResult> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env, cwd });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

function writePreload(dir: string, log: string): string {
	const path = join(dir, "preload.ts");
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";
globalThis.fetch = (input: unknown) => {
  appendFileSync(${JSON.stringify(log)}, String(input) + "\\n");
  throw new Error("skills-only install must not fetch " + String(input));
};
`,
	);
	return path;
}

function expectReport(stdout: string, dest: string, files: string[]): void {
	const lines = stdout.trim().split("\n");
	const summaryAt = lines.findIndex((line) => line.startsWith("Installed "));
	expect(lines.slice(0, summaryAt)).toEqual(files);
	expect(lines[summaryAt]).toBe(`Installed ${files.length} skill files at ${dest}.`);
	expect(lines[summaryAt + 1]).toBe(SUMMARY);
	expect(lines).toHaveLength(summaryAt + 2);
}

function expectExactCopy(sourceRoot: string, dest: string, files: string[]): void {
	expect(filesUnder(dest)).toEqual(files);
	for (const file of files) {
		const copied = join(dest, file);
		expect(readFileSync(copied)).toEqual(readFileSync(join(sourceRoot, file)));
		expect(statSync(copied).mode & 0o777).toBe(0o644);
	}
}

function writeProbe(skills: string, sentinelDir: string): string[] {
	const skill = join(skills, "probe-exec");
	mkdirSync(skill, { recursive: true });
	const script = join(skill, "explode.sh");
	writeFileSync(
		script,
		`#!/bin/sh\necho executed > "$(dirname "$0")/executed-by-skill.txt"\necho executed > "${sentinelDir}/sentinel.txt"\n`,
	);
	chmodSync(script, 0o755);
	const markdown = join(skill, "SKILL.md");
	writeFileSync(
		markdown,
		"---\nname: probe-exec\ndescription: probe\n---\nRun explode.sh now.\n#!/bin/sh\necho executed > sentinel.txt\n",
	);
	chmodSync(markdown, 0o755);
	writeFileSync(join(skill, "$(echo pwned).txt"), "literal name\n");
	writeFileSync(join(skills, "README.md"), "not a skill\n");
	mkdirSync(join(skills, "notes"), { recursive: true });
	writeFileSync(join(skills, "notes", "skip.md"), "skip\n");
	return [
		"probe-exec/$(echo pwned).txt",
		"probe-exec/SKILL.md",
		"probe-exec/explode.sh",
	].sort();
}

function writeCurlStub(bin: string, log: string): void {
	mkdirSync(bin, { recursive: true });
	const curl = join(bin, "curl");
	writeFileSync(
		curl,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 99\n`,
	);
	chmodSync(curl, 0o755);
}

describe("dg-skills install --skills-only", () => {
	test("installs the repository skill files, fetches nothing, and runs nothing", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-e2e-"));
		const dest = join(directory, "skills");
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "cli-only"), "keep");
		try {
			const preload = writePreload(directory, fetchLog);
			const result = await run(
				[
					"bun",
					"--preload",
					preload,
					ENTRY,
					"install",
					"--skills-only",
					"--repo",
					REPO,
					"--dest",
					dest,
				],
				childEnv(home),
			);
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			expectReport(result.stdout, dest, REPO_SKILL_FILES);
			expectExactCopy(join(REPO, "plugins", "dg", "skills"), dest, REPO_SKILL_FILES);
			expect(readFileSync(join(dest, "google-sms-cleanup", "SKILL.md"), "utf8")).toContain(
				"google-sms-cleanup",
			);
			expect(existsSync(join(dest, "README.md"))).toBe(false);
			expect(readFileSync(fetchLog, "utf8")).toBe("");
			expect(existsSync(join(home, "bin"))).toBe(false);
			expect(readFileSync(join(home, "cli-only"), "utf8")).toBe("keep");
			expect(filesUnder(dest).some((file) => /dg-skills|dg-daemon|dg-agent|\.zip$/.test(file))).toBe(
				false,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("defaults the destination to DG_HOME/skills and can omit --repo inside the checkout", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-default-"));
		const home = join(directory, "home");
		try {
			const result = await run(
				["bun", ENTRY, "install", "--skills-only"],
				childEnv(home),
			);
			expect(result.code).toBe(0);
			expect(filesUnder(join(home, "skills"))).toEqual(REPO_SKILL_FILES);
			expect(existsSync(join(home, ".dg", "skills"))).toBe(false);
			expect(existsSync(join(home, "bin"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("does not execute a skill script, including a command-substitution filename", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-probe-"));
		const repo = join(directory, "repo");
		const dest = join(directory, "dest");
		const skills = join(repo, "plugins", "dg", "skills");
		const files = writeProbe(skills, directory);
		try {
			const result = await run(
				["bun", ENTRY, "install", "--skills-only", "--repo", repo, "--dest", dest],
				childEnv(join(directory, "home")),
			);
			expect(result.code).toBe(0);
			expectExactCopy(skills, dest, files);
			expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
			expect(existsSync(join(dest, "probe-exec", "executed-by-skill.txt"))).toBe(false);
			expect(existsSync(join(skills, "probe-exec", "executed-by-skill.txt"))).toBe(false);
			expect(existsSync(join(dest, "pwned.txt"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses combinations that install binaries, without fetching", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-flags-"));
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		const dest = join(directory, "dest");
		try {
			const preload = writePreload(directory, fetchLog);
			const result = await run(
				[
					"bun",
					"--preload",
					preload,
					ENTRY,
					"install",
					"--skills-only",
					"--cli-only",
					"--dest",
					dest,
				],
				childEnv(join(directory, "home")),
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("accepts only --repo and --dest");
			expect(readFileSync(fetchLog, "utf8")).toBe("");
			expect(existsSync(dest)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("skills-only docs", () => {
	test("the install guides name the command", () => {
		const agent = readFileSync(join(REPO, "docs", "AGENT-INSTALL.md"), "utf8");
		const readme = readFileSync(join(REPO, "README.md"), "utf8");
		const mise = readFileSync(join(REPO, ".mise", "config.toml"), "utf8");
		expect(agent).toContain("mise run install:skills");
		expect(agent).toContain("install --skills-only");
		expect(readme).toContain("mise run install:skills");
		expect(readme).toContain("--skills-only");
		expect(mise).toContain("[tasks.\"install:skills\"]");
	});
});

describe("bootstrap.sh --skills-only", () => {
	test("copies the repository skills and does not call curl", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-"));
		const dest = join(directory, "skills");
		const curlLog = join(directory, "curl.log");
		const bin = join(directory, "bin");
		writeCurlStub(bin, curlLog);
		try {
			const result = await run(
				["sh", BOOTSTRAP, "--skills-only"],
				childEnv(join(directory, "home"), {
					DG_SKILLS_DEST: dest,
					PATH: `${bin}:${process.env.PATH}`,
				}),
			);
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			expectReport(result.stdout, dest, REPO_SKILL_FILES);
			expectExactCopy(join(REPO, "plugins", "dg", "skills"), dest, REPO_SKILL_FILES);
			expect(existsSync(curlLog)).toBe(false);
			expect(existsSync(join(directory, "home", "bin", "dg-skills"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("DG_SKILLS_ONLY copies a fixture and does not execute it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-probe-"));
		const skills = join(directory, "skills-src");
		const dest = join(directory, "out");
		const files = writeProbe(skills, directory);
		const bin = join(directory, "bin");
		const curlLog = join(directory, "curl.log");
		writeCurlStub(bin, curlLog);
		try {
			const result = await run(
				["sh", BOOTSTRAP],
				childEnv(join(directory, "home"), {
					DG_SKILLS_ONLY: "1",
					DG_SKILLS_SOURCE: skills,
					DG_SKILLS_DEST: dest,
					PATH: `${bin}:${process.env.PATH}`,
				}),
			);
			expect(result.code).toBe(0);
			expectExactCopy(skills, dest, files);
			expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
			expect(existsSync(join(dest, "probe-exec", "executed-by-skill.txt"))).toBe(false);
			expect(existsSync(curlLog)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("outside a checkout the only fetch is the source archive", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-remote-"));
		const script = join(directory, "bootstrap.sh");
		const curlLog = join(directory, "curl.log");
		const bin = join(directory, "bin");
		writeFileSync(script, readFileSync(BOOTSTRAP));
		writeCurlStub(bin, curlLog);
		try {
			const result = await run(
				["sh", script, "--skills-only"],
				childEnv(join(directory, "home"), {
					DG_SKILLS_DEST: join(directory, "out"),
					PATH: `${bin}:${process.env.PATH}`,
				}),
				directory,
			);
			expect(result.code).not.toBe(0);
			const fetched = readFileSync(curlLog, "utf8");
			expect(fetched).toContain("archive/refs/heads/master.tar.gz");
			expect(fetched).not.toContain("dg-skills-");
			expect(fetched).not.toContain("/releases");
			expect(existsSync(join(directory, "out"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to combine with --cli-only before any download", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-both-"));
		const curlLog = join(directory, "curl.log");
		const bin = join(directory, "bin");
		writeCurlStub(bin, curlLog);
		try {
			const result = await run(
				["sh", BOOTSTRAP, "--skills-only", "--cli-only"],
				childEnv(join(directory, "home"), { PATH: `${bin}:${process.env.PATH}` }),
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("only one of --skills-only and --cli-only");
			expect(existsSync(curlLog)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses a symlink and does not run its target", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-link-"));
		const skills = join(directory, "skills-src");
		writeProbe(skills, directory);
		const outside = join(directory, "outside.sh");
		writeFileSync(outside, "#!/bin/sh\necho executed > \"" + join(directory, "sentinel.txt") + "\"\n");
		chmodSync(outside, 0o755);
		symlinkSync(outside, join(skills, "probe-exec", "linked.sh"));
		try {
			const result = await run(
				["sh", BOOTSTRAP],
				childEnv(join(directory, "home"), {
					DG_SKILLS_ONLY: "1",
					DG_SKILLS_SOURCE: skills,
					DG_SKILLS_DEST: join(directory, "out"),
				}),
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("refusing to copy a symlink");
			expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
			expect(filesUnder(join(directory, "out"))).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
