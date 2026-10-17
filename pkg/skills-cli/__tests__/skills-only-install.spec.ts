/**
 * Skills-only install: the real command copies plugins/dg/skills into a temp
 * directory, does not execute skill content, and fetches only the dg-skills CLI
 * (checksum-verified), never dg-daemon, dg-agent or the extension.
 */
import { createHash } from "node:crypto";
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
import { INSTALLED_SKILL_FILES } from "../../common/__tests__/installed-skill-files";

const REPO = join(import.meta.dir, "..", "..", "..");
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const BOOTSTRAP = join(import.meta.dir, "..", "bootstrap.sh");
const PERSONAS = [
	"checkpoint",
	"copilot-antagonist",
	"csharp",
	"dba",
	"devops",
	"foreman",
	"js",
	"lore",
	"python",
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
	"Skills-only install: no skill content was executed. Fetching only the dg-skills CLI (no daemon, agent or extension).";

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

const SKILLS_BINARY = "#!/bin/sh\necho fake dg-skills\n";

function skillsAssetName(): string {
	const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
	const cpu = process.arch === "arm64" ? "arm64" : "x64";
	return `dg-skills-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** A fetch that serves one skills-v release (plus daemon, agent and ext releases) and logs every URL. */
function writePreload(dir: string, log: string, opts: { sums?: string; offline?: boolean } = {}): string {
	const asset = skillsAssetName();
	const base = "https://github.com/detailedghost/dg-ai/releases/download";
	const releases = [
		{ tag_name: "skills-v9.9.9", draft: false, assets: [
			{ name: asset, browser_download_url: `${base}/skills-v9.9.9/${asset}` },
			{ name: "SHA256SUMS", browser_download_url: `${base}/skills-v9.9.9/SHA256SUMS` },
		] },
		{ tag_name: "daemon-v9.9.9", draft: false, assets: [{ name: asset.replace("dg-skills", "dg-daemon"), browser_download_url: `${base}/daemon-v9.9.9/x` }] },
		{ tag_name: "agent-v9.9.9", draft: false, assets: [{ name: asset.replace("dg-skills", "dg-agent"), browser_download_url: `${base}/agent-v9.9.9/x` }] },
		{ tag_name: "ext-v9.9.9", draft: false, assets: [{ name: "dg-ai-extension-chrome.zip", browser_download_url: `${base}/ext-v9.9.9/x` }] },
	];
	const sums = opts.sums ?? `${sha256(SKILLS_BINARY)}  ${asset}\n`;
	const path = join(dir, "preload.ts");
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";
const releases = ${JSON.stringify(releases)};
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  appendFileSync(${JSON.stringify(log)}, url + "\\n");
  if (${opts.offline ? "true" : "false"}) throw new TypeError("fetch failed: offline");
  if (url.includes("/releases?")) return new Response(JSON.stringify(releases));
  if (url.endsWith("/skills-v9.9.9/${asset}")) return new Response(${JSON.stringify(SKILLS_BINARY)});
  if (url.endsWith("/skills-v9.9.9/SHA256SUMS")) return new Response(${JSON.stringify(sums)});
  throw new Error("skills-only install must not fetch " + url);
}) as typeof fetch;
`,
	);
	return path;
}

function fetchedUrls(log: string): string[] {
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

function expectOnlySkillsCliFetched(log: string): void {
	const urls = fetchedUrls(log);
	expect(urls.some((url) => url.includes("/releases?"))).toBe(true);
	expect(urls.some((url) => url.endsWith(`/skills-v9.9.9/${skillsAssetName()}`))).toBe(true);
	expect(urls.some((url) => url.endsWith("/skills-v9.9.9/SHA256SUMS"))).toBe(true);
	expect(urls.filter((url) => /daemon-v|agent-v|ext-v/.test(url))).toEqual([]);
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

/**
 * A curl that serves one skills-v release for bootstrap.sh, verifies nothing itself, and logs
 * every call. The source archive fails (exit 99) so a fetch outside a checkout is visible.
 * The served binary writes RAN_MARKER if anything executes it.
 */
function writeCurlStub(bin: string, log: string): string {
	mkdirSync(bin, { recursive: true });
	const os = process.platform === "darwin" ? "macos" : "linux";
	const cpu = process.arch === "arm64" ? "arm64" : "x64";
	const asset = `dg-skills-${os}-${cpu}`;
	const binary = `#!/bin/sh\ntouch "$RAN_MARKER"\n`;
	const url = `https://github.com/detailedghost/dg-ai/releases/download/skills-v9.9.9/${asset}`;
	const releases = JSON.stringify([
		{ tag_name: "skills-v9.9.9", draft: false, assets: [
			{ name: asset, browser_download_url: url },
			{ name: "SHA256SUMS", browser_download_url: url.replace(asset, "SHA256SUMS") },
		] },
	]);
	const store = join(bin, "store");
	mkdirSync(store, { recursive: true });
	writeFileSync(join(store, "releases.json"), releases);
	writeFileSync(join(store, "binary"), binary);
	writeFileSync(join(store, "SHA256SUMS"), `${createHash("sha256").update(binary).digest("hex")}  ${asset}\n`);
	const curl = join(bin, "curl");
	writeFileSync(
		curl,
		`#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
out=""; prev=""; url=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  url="$a"; prev="$a"
done
store=${JSON.stringify(store)}
case "$url" in
  *"/releases?"*) cat "$store/releases.json" ;;
  *SHA256SUMS) cat "$store/SHA256SUMS" > "\${out:-/dev/stdout}" ;;
  *"/skills-v9.9.9/"*) cat "$store/binary" > "\${out:-/dev/stdout}" ;;
  *) exit 99 ;;
esac
`,
	);
	chmodSync(curl, 0o755);
	return binary;
}

describe("dg-skills install --skills-only", () => {
	test("installs the repository skill files and only the verified dg-skills CLI, and runs nothing", async () => {
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
			expectReport(result.stdout, dest, INSTALLED_SKILL_FILES, personasPath(dest), [
				`dg-skills installed v9.9.9 at ${join(home, "bin", "dg-skills")}`,
			]);
			expectExactCopy(REPO_SKILLS, dest, INSTALLED_SKILL_FILES);
			expectPersonasInstalled(dest);
			expect(readFileSync(join(dest, "google-sms-cleanup", "SKILL.md"), "utf8")).toContain(
				"google-sms-cleanup",
			);
			expect(existsSync(join(dest, "README.md"))).toBe(false);
			expectOnlySkillsCliFetched(fetchLog);
			expect(readFileSync(join(home, "bin", "dg-skills"), "utf8")).toBe(SKILLS_BINARY);
			expect(readFileSync(join(home, "bin", ".dg-skills.version"), "utf8").trim()).toBe("9.9.9");
			expect(readdirSync(join(home, "bin")).sort()).toEqual([".dg-skills.version", "dg-skills"]);
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
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const result = await run(
				["bun", "--preload", writePreload(directory, fetchLog), ENTRY, "install", "--skills-only"],
				childEnv(home),
			);
			expect(result.code).toBe(0);
			expect(filesUnder(join(home, "skills"))).toEqual(INSTALLED_SKILL_FILES);
			expectPersonasInstalled(join(home, "skills"));
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

	test("refuses a dg-skills CLI whose checksum does not match SHA256SUMS", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-sums-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog, { sums: `${"0".repeat(64)}  ${skillsAssetName()}\n` });
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--skills-only", "--dest", join(directory, "dest")],
				childEnv(home),
			);
			expect(result.code).toBe(0);
			expect(result.stderr).toContain(`checksum mismatch for ${skillsAssetName()} in v9.9.9`);
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "bin", ".dg-skills.version"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses a SHA256SUMS that omits the dg-skills asset", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-nosum-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog, { sums: `${"a".repeat(64)}  other-asset\n` });
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--skills-only", "--dest", join(directory, "dest")],
				childEnv(home),
			);
			expect(result.stderr).toContain(`SHA256SUMS in v9.9.9 has no entry for ${skillsAssetName()}`);
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
	test("copies the repository skills, then installs only the verified dg-skills CLI", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-"));
		const dest = join(directory, "skills");
		const curlLog = join(directory, "curl.log");
		const bin = join(directory, "stub");
		const binary = writeCurlStub(bin, curlLog);
		const home = join(directory, "home");
		const marker = join(directory, "ran");
		try {
			const result = await run(
				["sh", BOOTSTRAP, "--skills-only"],
				childEnv(home, {
					DG_SKILLS_DEST: dest,
					PATH: `${bin}:${process.env.PATH}`,
					RAN_MARKER: marker,
				}),
			);
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			const installedAt = join(home, "bin", "dg-skills");
			const trailer = [`dg-skills installed at ${installedAt}`, `Add to PATH:  export PATH="${join(home, "bin")}:$PATH"`];
			expectReport(result.stdout, dest, INSTALLED_SKILL_FILES, personasPath(dest), trailer);
			expectExactCopy(REPO_SKILLS, dest, INSTALLED_SKILL_FILES);
			expectPersonasInstalled(dest);
			expect(readFileSync(installedAt, "utf8")).toBe(binary);
			expect(readFileSync(join(home, "bin", ".dg-skills.version"), "utf8").trim()).toBe("9.9.9");
			expect(existsSync(marker)).toBe(false);
			const calls = readFileSync(curlLog, "utf8");
			expect(calls).toContain("/releases?");
			expect(calls).toContain("SHA256SUMS");
			expect(calls).not.toMatch(/daemon|agent|ext-v|archive/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("DG_SKILLS_ONLY copies a fixture and does not execute it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-probe-"));
		const skills = join(directory, "skills-src");
		const dest = join(directory, "out");
		const files = writeProbe(skills, directory);
		const bin = join(directory, "stub");
		const curlLog = join(directory, "curl.log");
		writeCurlStub(bin, curlLog);
		const marker = join(directory, "ran");
		try {
			const result = await run(
				["sh", BOOTSTRAP],
				childEnv(join(directory, "home"), {
					DG_SKILLS_ONLY: "1",
					DG_SKILLS_SOURCE: skills,
					DG_SKILLS_DEST: dest,
					PATH: `${bin}:${process.env.PATH}`,
					RAN_MARKER: marker,
				}),
			);
			expect(result.code).toBe(0);
			expectExactCopy(skills, dest, files);
			expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
			expect(existsSync(join(dest, "probe-exec", "executed-by-skill.txt"))).toBe(false);
			expect(existsSync(marker)).toBe(false);
			expect(existsSync(join(directory, "home", "bin", "dg-skills"))).toBe(true);
			expect(readFileSync(curlLog, "utf8")).not.toContain("archive");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("DG_SKILLS_NO_CLI=1 keeps it an offline copy with no curl call", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-nocli-"));
		const dest = join(directory, "skills");
		const curlLog = join(directory, "curl.log");
		const bin = join(directory, "stub");
		writeCurlStub(bin, curlLog);
		try {
			const result = await run(
				["sh", BOOTSTRAP, "--skills-only"],
				childEnv(join(directory, "home"), {
					DG_SKILLS_DEST: dest,
					DG_SKILLS_NO_CLI: "1",
					PATH: `${bin}:${process.env.PATH}`,
				}),
			);
			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			expectReport(result.stdout, dest, INSTALLED_SKILL_FILES, personasPath(dest), [
				"Skipped the dg-skills CLI (DG_SKILLS_NO_CLI=1): offline copy only.",
			]);
			expect(existsSync(curlLog)).toBe(false);
			expect(existsSync(join(directory, "home", "bin"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("outside a checkout the only fetch is the source archive", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-boot-remote-"));
		const script = join(directory, "bootstrap.sh");
		const curlLog = join(directory, "curl.log");
		const bin = join(directory, "stub");
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
		const scratch = join(directory, "tmp");
		mkdirSync(scratch);
		try {
			const result = await run(
				["sh", BOOTSTRAP],
				childEnv(join(directory, "home"), {
					DG_SKILLS_ONLY: "1",
					DG_SKILLS_SOURCE: skills,
					DG_SKILLS_DEST: join(directory, "out"),
					TMPDIR: scratch,
				}),
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("refusing to copy a symlink");
			expect(readdirSync(scratch)).toEqual([]);
			expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
			expect(filesUnder(join(directory, "out"))).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
