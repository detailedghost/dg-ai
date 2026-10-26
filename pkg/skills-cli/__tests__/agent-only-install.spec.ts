/**
 * `install --agent-only` fetches dg-skills (the installer vehicle) and dg-agent, so a
 * non-Claude agent that only needs phone has `dg-agent`. It never fetches dg-daemon
 * or the extension, and never installs personas, which only the Claude-side CLI uses.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

type RunResult = { code: number; stdout: string; stderr: string };

function childEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.DG_CLI_ONLY;
	delete env.DG_SKILLS_ONLY;
	env.HOME = home;
	env.DG_HOME = home;
	env.LC_ALL = "C";
	return env;
}

async function run(argv: string[], env: Record<string, string>): Promise<RunResult> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

function assetName(binary: string): string {
	const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
	const cpu = process.arch === "arm64" ? "arm64" : "x64";
	return `${binary}-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

/** Serves skills-v, agent-v, daemon-v and ext-v releases and logs every fetched URL. */
function writePreload(dir: string, log: string): string {
	const base = "https://github.com/detailedghost/dg-ai/releases/download";
	const skillsAsset = assetName("dg-skills");
	const agentAsset = assetName("dg-agent");
	const daemonAsset = assetName("dg-daemon");
	const releases = [
		{
			tag_name: "skills-v9.9.9",
			draft: false,
			assets: [{ name: skillsAsset, browser_download_url: `${base}/skills-v9.9.9/${skillsAsset}` }],
		},
		{
			tag_name: "agent-v9.9.9",
			draft: false,
			assets: [{ name: agentAsset, browser_download_url: `${base}/agent-v9.9.9/${agentAsset}` }],
		},
		{
			tag_name: "daemon-v9.9.9",
			draft: false,
			assets: [{ name: daemonAsset, browser_download_url: `${base}/daemon-v9.9.9/${daemonAsset}` }],
		},
		{
			tag_name: "ext-v9.9.9",
			draft: false,
			assets: [{ name: "dg-ai-extension-chrome.zip", browser_download_url: `${base}/ext-v9.9.9/x` }],
		},
	];
	const path = join(dir, "preload.ts");
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";
const releases = ${JSON.stringify(releases)};
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  appendFileSync(${JSON.stringify(log)}, url + "\\n");
  if (url.includes("/releases?")) return new Response(JSON.stringify(releases));
  if (url.endsWith("/skills-v9.9.9/${skillsAsset}")) return new Response("fake dg-skills");
  if (url.endsWith("/agent-v9.9.9/${agentAsset}")) return new Response(${JSON.stringify("#!/bin/sh\nexit 0\n# fake dg-agent\n")});
  throw new Error("agent-only install must not fetch " + url);
}) as typeof fetch;
`,
	);
	return path;
}

function fetchedUrls(log: string): string[] {
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

describe("dg-skills install --agent-only", () => {
	test("fetches only dg-skills and dg-agent, skips the daemon and extension, and marks cli-only", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-agent-only-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog);
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--agent-only"],
				childEnv(home),
			);

			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			expect(result.stdout).toContain(
				'Agent-only install: the extension and dg-daemon were skipped. Run "dg-skills install" to add them.',
			);

			const urls = fetchedUrls(fetchLog);
			expect(urls.some((url) => url.includes("/releases?"))).toBe(true);
			expect(urls.some((url) => url.endsWith(`/skills-v9.9.9/${assetName("dg-skills")}`))).toBe(true);
			expect(urls.some((url) => url.endsWith(`/agent-v9.9.9/${assetName("dg-agent")}`))).toBe(true);
			expect(urls.filter((url) => /daemon-v|ext-v/.test(url))).toEqual([]);

			const bin = join(home, "bin");
			expect(readFileSync(join(bin, "dg-skills"), "utf8")).toBe("fake dg-skills");
			expect(readFileSync(join(bin, "dg-agent"), "utf8")).toBe("#!/bin/sh\nexit 0\n# fake dg-agent\n");
			expect(existsSync(join(bin, "dg-daemon"))).toBe(false);
			expect(readFileSync(join(bin, ".dg-skills.version"), "utf8").trim()).toBe("9.9.9");
			expect(readFileSync(join(bin, ".dg-agent.version"), "utf8").trim()).toBe("9.9.9");
			expect(readdirSync(bin).sort()).toEqual([".dg-agent.version", ".dg-skills.version", "dg-agent", "dg-skills"]);

			expect(existsSync(join(home, "cli-only"))).toBe(true);
			expect(existsSync(join(home, "agents"))).toBe(false);
			expect(existsSync(join(home, "skills"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to combine with --cli-only", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-agent-only-combo-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		try {
			const result = await run(
				["bun", ENTRY, "install", "--agent-only", "--cli-only"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("only one of --cli-only and --agent-only");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to combine with --skills-only", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-agent-only-skills-combo-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		try {
			const result = await run(
				["bun", ENTRY, "install", "--skills-only", "--agent-only"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("accepts only --repo and --dest");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
