/**
 * Skills-only install: the real command copies plugins/dg/skills into a temp
 * directory, does not execute skill content, and installs the verified runtime,
 * bundle and shims, never the extension.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
import { INSTALLED_SKILL_FILES } from "../../common/__tests__/installed-skill-files";
import { PROGRAMS, RUNTIME, present, removeBootstrapDirs, removeBootstrapFixtures, runBootstrap } from "./bootstrap-fixtures";
import { fetchedUrls, writeReleaseServer } from "./runtime-bundle-fixtures";

const REPO = join(import.meta.dir, "..", "..", "..");
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const BOOTSTRAP = join(import.meta.dir, "..", "bootstrap.sh");
const PERSONAS = [
	"arch",
	"checkpoint",
	"copilot-antagonist",
	"csharp",
	"dba",
	"design",
	"devops",
	"foreman",
	"js",
	"lore",
	"python",
	"qa-code",
	"qa-devops",
	"qa-perf",
	"qa-writer",
	"reviewer",
	"security",
	"shell",
	"thrash",
	"wave",
].map((name) => `${name}.md`);
const SUMMARY =
	"Skills-only install: no skill content was executed. Fetching the dg bundle with the dg-skills, dg-agent and dg-daemon launchers (no extension).";

const REPO_SKILLS = join(REPO, "plugins", "dg", "skills");

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

const BUNDLE = "dg-lib-9.9.9.tar.gz";

/** A fetch that serves one vX.Y.Z release with the bundle and runtime, and logs every URL. */
function writePreload(dir: string, log: string, opts: { sums?: (defaults: string) => string; offline?: boolean } = {}): string {
	if (!opts.offline) return writeReleaseServer(dir, log, "9.9.9", { sums: opts.sums }).preload;
	const path = join(dir, "offline-preload.ts");
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";
globalThis.fetch = (async (input: unknown) => {
  appendFileSync(${JSON.stringify(log)}, String(input) + "\\n");
  throw new TypeError("fetch failed: offline");
}) as typeof fetch;
`,
	);
	return path;
}

function expectOnlyBundleFetched(log: string): void {
	const urls = fetchedUrls(log);
	expect(urls.some((url) => url.includes("/releases?"))).toBe(true);
	expect(urls.some((url) => url.endsWith(`/v9.9.9/${BUNDLE}`))).toBe(true);
	expect(urls.some((url) => url.endsWith("/v9.9.9/SHA256SUMS"))).toBe(true);
	expect(urls.some((url) => url.endsWith("/v9.9.9/runtime.json"))).toBe(true);
	expect(urls.filter((url) => /extension/.test(url))).toEqual([]);
}

function personasPath(skillsDest: string): string {
	return join(skillsDest, "..", "agents");
}

function expectPersonasInstalled(skillsDest: string): void {
	const installed = personasPath(skillsDest);
	expect(readdirSync(installed).sort()).toEqual(PERSONAS);
	for (const name of PERSONAS) {
		expect(readFileSync(join(installed, name), "utf8")).toBe(
			readFileSync(join(REPO, "plugins", "dg", "agents", name), "utf8"),
		);
	}
}

function expectReport(
	stdout: string,
	dest: string,
	files: string[],
	persona?: string,
	trailer: string[] = [],
): void {
	const lines = stdout.trim().split("\n");
	const summaryAt = lines.findIndex((line) => line.startsWith("Installed ") && line.includes("skill files"));
	expect(lines.slice(0, summaryAt)).toEqual(files);
	expect(lines[summaryAt]).toBe(`Installed ${files.length} skill files at ${dest}.`);
	let next = summaryAt + 1;
	if (persona) {
		expect(lines[next]).toBe(`Installed ${PERSONAS.length} personas at ${persona}.`);
		next += 1;
	}
	expect(lines[next]).toBe(SUMMARY);
	expect(lines.slice(next + 1)).toEqual(trailer);
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

describe("dg-skills install --skills-only", () => {
	test("removes the retired phone-friend skill from the dest and keeps unrelated folders", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-retired-e2e-"));
		const dest = join(directory, "skills");
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(dest, "phone-friend"), { recursive: true });
		writeFileSync(join(dest, "phone-friend", "SKILL.md"), "old stub\n");
		mkdirSync(join(dest, "my-own-skill"), { recursive: true });
		writeFileSync(join(dest, "my-own-skill", "SKILL.md"), "mine\n");
		try {
			const result = await run(
				["bun", "--preload", writePreload(directory, fetchLog), ENTRY, "install", "--skills-only", "--repo", REPO, "--dest", dest],
				childEnv(home),
			);
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: `note: DG_HOME=${home}; installing there\n` });
			expect(existsSync(join(dest, "phone-friend"))).toBe(false);
			expect(readFileSync(join(dest, "my-own-skill", "SKILL.md"), "utf8")).toBe("mine\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("installs the repository skill files and only the verified dg-skills CLI, and runs nothing", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-e2e-"));
		const dest = join(directory, "skills");
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(home, "config"), { recursive: true });
		writeFileSync(join(home, "config", "cli-only"), "keep");
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
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: `note: DG_HOME=${home}; installing there\n` });
			expectReport(result.stdout, dest, INSTALLED_SKILL_FILES, personasPath(dest), [
				`Add to PATH:  export PATH="${join(home, "bin")}:$PATH"`,
				`dg bundle installed v9.9.9 at ${join(home, "data", "lib", "9.9.9")}`,
			]);
			expectExactCopy(REPO_SKILLS, dest, INSTALLED_SKILL_FILES);
			expectPersonasInstalled(dest);
			expect(readFileSync(join(dest, "google-sms-cleanup", "SKILL.md"), "utf8")).toContain(
				"google-sms-cleanup",
			);
			expect(existsSync(join(dest, "README.md"))).toBe(false);
			expectOnlyBundleFetched(fetchLog);
			expect(readFileSync(join(home, "bin", "dg-skills"), "utf8")).toContain(`dg-skills "$@"`);
			expect(readdirSync(join(home, "bin")).sort()).toEqual(["dg-agent", "dg-daemon", "dg-skills"]);
			expect(readFileSync(join(home, "config", "cli-only"), "utf8")).toBe("keep");
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
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const result = await run(
				["bun", "--preload", writePreload(directory, fetchLog), ENTRY, "install", "--skills-only"],
				childEnv(home),
			);
			expect(result.code).toBe(0);
			expect(filesUnder(join(home, "data", "skills"))).toEqual(INSTALLED_SKILL_FILES);
			expectPersonasInstalled(join(home, "data", "skills"));
			expect(existsSync(join(home, ".dg", "skills"))).toBe(false);
			expect(existsSync(join(home, ".dg", "bin"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(true);
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
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const result = await run(
				["bun", "--preload", writePreload(directory, fetchLog), ENTRY, "install", "--skills-only", "--repo", repo, "--dest", dest],
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

	test("refuses a bundle whose checksum does not match SHA256SUMS", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-sums-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog, {
				sums: (defaults) => defaults.replace(/^[0-9a-f]{64}(  dg-lib-)/m, `${"0".repeat(64)}$1`),
			});
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--skills-only", "--dest", join(directory, "dest")],
				childEnv(home),
			);
			expect(result.code).toBe(0);
			expect(result.stderr).toContain(`checksum mismatch for ${BUNDLE} in v9.9.9`);
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "data", "lib"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses a SHA256SUMS that omits the runtime.json asset", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-nosum-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog, {
				sums: (defaults) =>
					defaults
						.split("\n")
						.filter((line) => !line.endsWith("runtime.json"))
						.join("\n"),
			});
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--skills-only", "--dest", join(directory, "dest")],
				childEnv(home),
			);
			expect(result.stderr).toContain("SHA256SUMS in v9.9.9 has no entry for runtime.json");
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("an offline release listing warns and keeps the copied skills, exit 0", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-offline-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		const dest = join(directory, "dest");
		try {
			const result = await run(
				["bun", "--preload", writePreload(directory, fetchLog, { offline: true }), ENTRY, "install", "--skills-only", "--dest", dest],
				childEnv(home),
			);
			expect(result.code).toBe(0);
			expect(result.stderr).toContain("⚠ dg-skills install skipped: fetch failed: offline");
			expect(filesUnder(dest)).toEqual(INSTALLED_SKILL_FILES);
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
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
	afterEach(removeBootstrapDirs);
	afterAll(removeBootstrapFixtures);

	test("copies the repository skills, then installs only the runtime, bundle and shims", async () => {
		const dest = join(mkdtempSync(join(tmpdir(), "dg-skills-boot-")), "skills");
		try {
			const result = await runBootstrap({ args: ["--skills-only"], env: { DG_SKILLS_DEST: dest } });
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			const lines = result.stdout.trim().split("\n");
			const summaryAt = lines.indexOf(SUMMARY);
			expectReport(lines.slice(0, summaryAt + 1).join("\n"), dest, INSTALLED_SKILL_FILES, personasPath(dest));
			expect(lines.slice(summaryAt + 1)).toEqual([
				`Downloading bun ${RUNTIME.version} (linux-x64)...`,
				`Downloading dg-lib-${result.version}.tar.gz...`,
				`dg runtime ${RUNTIME.version} and bundle ${result.version} installed at ${join(result.root, "data")}`,
				`Add to PATH:  export PATH="${join(result.root, "bin")}:$PATH"`,
			]);
			expectExactCopy(REPO_SKILLS, dest, INSTALLED_SKILL_FILES);
			expectPersonasInstalled(dest);
			for (const program of PROGRAMS) expect(present(join(result.root, "bin", program))).toBe(true);
			expect(result.installCall).toBeUndefined();
			expect(result.requests.filter((url) => /daemon|agent|extension|archive/.test(url))).toEqual([]);
		} finally {
			rmSync(join(dest, ".."), { recursive: true, force: true });
		}
	});

	test("DG_SKILLS_ONLY copies a fixture and does not execute it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-probe-"));
		const skills = join(directory, "skills-src");
		const dest = join(directory, "out");
		const files = writeProbe(skills, directory);
		try {
			const result = await runBootstrap({
				env: { DG_SKILLS_ONLY: "1", DG_SKILLS_SOURCE: skills, DG_SKILLS_DEST: dest },
			});
			expect(result.code, result.stderr).toBe(0);
			expectExactCopy(skills, dest, files);
			expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
			expect(existsSync(join(dest, "probe-exec", "executed-by-skill.txt"))).toBe(false);
			expect(result.installCall).toBeUndefined();
			expect(present(join(result.root, "bin", "dg-skills"))).toBe(true);
			expect(result.requests.some((url) => url.includes("archive"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("DG_SKILLS_NO_CLI=1 keeps it an offline copy with no download", async () => {
		const dest = join(mkdtempSync(join(tmpdir(), "dg-skills-boot-nocli-")), "skills");
		try {
			const result = await runBootstrap({
				args: ["--skills-only"],
				env: { DG_SKILLS_DEST: dest, DG_SKILLS_NO_CLI: "1" },
			});
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			expectReport(result.stdout, dest, INSTALLED_SKILL_FILES, personasPath(dest), [
				"Skipped the dg-skills CLI (DG_SKILLS_NO_CLI=1): offline copy only.",
			]);
			expect(result.requests).toEqual([]);
			expect(existsSync(join(result.root, "bin"))).toBe(false);
		} finally {
			rmSync(join(dest, ".."), { recursive: true, force: true });
		}
	});

	test("outside a checkout the only fetches are the release lookup and the tag archive", async () => {
		const outside = mkdtempSync(join(tmpdir(), "dg-skills-boot-remote-"));
		const script = join(outside, "bootstrap.sh");
		writeFileSync(script, readFileSync(BOOTSTRAP));
		try {
			const result = await runBootstrap({
				args: ["--skills-only"],
				script,
				cwd: outside,
				env: { DG_SKILLS_DEST: join(outside, "out") },
			});
			expect(result.code).not.toBe(0);
			expect(result.requests.filter((url) => url.includes("/releases?"))).toHaveLength(1);
			expect(result.requests.filter((url) => !url.includes("/releases?"))).toEqual([
				`https://github.com/detailedghost/dg-ai/archive/refs/tags/v${result.version}.tar.gz`,
			]);
			expect(existsSync(join(outside, "out"))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("refuses to combine with --cli-only before any download", async () => {
		const result = await runBootstrap({ args: ["--skills-only", "--cli-only"] });
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("only one of --skills-only and --cli-only");
		expect(result.requests).toEqual([]);
	});

	test("refuses a symlink before any download and does not run its target", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-link-"));
		const skills = join(directory, "skills-src");
		writeProbe(skills, directory);
		const outside = join(directory, "outside.sh");
		writeFileSync(outside, "#!/bin/sh\necho executed > \"" + join(directory, "sentinel.txt") + "\"\n");
		chmodSync(outside, 0o755);
		symlinkSync(outside, join(skills, "probe-exec", "linked.sh"));
		const scratch = join(directory, "tmp");
		mkdirSync(scratch);
		try {
			const result = await runBootstrap({
				env: {
					DG_SKILLS_ONLY: "1",
					DG_SKILLS_SOURCE: skills,
					DG_SKILLS_DEST: join(directory, "out"),
					TMPDIR: scratch,
				},
			});
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("refusing to copy a symlink");
			expect(result.requests).toEqual([]);
			expect(readdirSync(scratch)).toEqual([]);
			expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
			expect(filesUnder(join(directory, "out"))).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
