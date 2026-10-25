/**
 * `install --version <x.y.z>` pins skills-v/daemon-v/agent-v/ext-v resolution to that
 * exact tag instead of each one's newest release — the carry-through a pinned
 * bootstrap relies on.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Serves both an old and a new skills-v/agent-v release, and logs every fetched URL. */
function writePreload(dir: string, log: string): string {
	const base = "https://github.com/detailedghost/dg-ai/releases/download";
	const skillsAsset = assetName("dg-skills");
	const agentAsset = assetName("dg-agent");
	const releases = [
		{
			tag_name: "skills-v9.9.9",
			draft: false,
			assets: [{ name: skillsAsset, browser_download_url: `${base}/skills-v9.9.9/${skillsAsset}` }],
		},
		{
			tag_name: "skills-v1.2.3",
			draft: false,
			assets: [{ name: skillsAsset, browser_download_url: `${base}/skills-v1.2.3/${skillsAsset}` }],
		},
		{
			tag_name: "agent-v9.9.9",
			draft: false,
			assets: [{ name: agentAsset, browser_download_url: `${base}/agent-v9.9.9/${agentAsset}` }],
		},
		{
			tag_name: "agent-v1.2.3",
			draft: false,
			assets: [{ name: agentAsset, browser_download_url: `${base}/agent-v1.2.3/${agentAsset}` }],
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
  if (url.endsWith("/skills-v1.2.3/${skillsAsset}")) return new Response("fake dg-skills 1.2.3");
  if (url.endsWith("/agent-v1.2.3/${agentAsset}")) return new Response("fake dg-agent 1.2.3");
  throw new Error("a pinned install must not fetch " + url);
}) as typeof fetch;
`,
	);
	return path;
}

function fetchedUrls(log: string): string[] {
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

describe("dg-skills install --version <x.y.z>", () => {
	test("pins both dg-skills and dg-agent to the same version, never touching the newer release", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-version-pin-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog);
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--agent-only", "--version", "1.2.3"],
				childEnv(home),
			);

			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });

			const urls = fetchedUrls(fetchLog);
			expect(urls.some((url) => url.endsWith(`/skills-v1.2.3/${assetName("dg-skills")}`))).toBe(true);
			expect(urls.some((url) => url.endsWith(`/agent-v1.2.3/${assetName("dg-agent")}`))).toBe(true);
			expect(urls.some((url) => url.includes("9.9.9"))).toBe(false);

			const bin = join(home, "bin");
			expect(readFileSync(join(bin, "dg-skills"), "utf8")).toBe("fake dg-skills 1.2.3");
			expect(readFileSync(join(bin, "dg-agent"), "utf8")).toBe("fake dg-agent 1.2.3");
			expect(readFileSync(join(bin, ".dg-skills.version"), "utf8").trim()).toBe("1.2.3");
			expect(readFileSync(join(bin, ".dg-agent.version"), "utf8").trim()).toBe("1.2.3");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a pin downgrades an already-installed newer version, exact match only", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-version-pin-downgrade-"));
		const home = join(directory, "home");
		const bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-skills"), "fake dg-skills 9.9.9");
		writeFileSync(join(bin, ".dg-skills.version"), "9.9.9\n");
		writeFileSync(join(bin, "dg-agent"), "fake dg-agent 9.9.9");
		writeFileSync(join(bin, ".dg-agent.version"), "9.9.9\n");
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog);
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--agent-only", "--version", "1.2.3"],
				childEnv(home),
			);

			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });

			const urls = fetchedUrls(fetchLog);
			expect(urls.some((url) => url.endsWith(`/skills-v1.2.3/${assetName("dg-skills")}`))).toBe(true);
			expect(urls.some((url) => url.endsWith(`/agent-v1.2.3/${assetName("dg-agent")}`))).toBe(true);

			expect(readFileSync(join(bin, "dg-skills"), "utf8")).toBe("fake dg-skills 1.2.3");
			expect(readFileSync(join(bin, "dg-agent"), "utf8")).toBe("fake dg-agent 1.2.3");
			expect(readFileSync(join(bin, ".dg-skills.version"), "utf8").trim()).toBe("1.2.3");
			expect(readFileSync(join(bin, ".dg-agent.version"), "utf8").trim()).toBe("1.2.3");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("warns and skips a binary whose pinned version has no release, rather than failing the install", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-version-pin-missing-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writePreload(directory, fetchLog);
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--agent-only", "--version", "4.0.0"],
				childEnv(home),
			);

			expect(result.code).toBe(0);
			expect(result.stderr).toContain("no release agent-v4.0.0 was found");
			expect(result.stderr).toContain("no release skills-v4.0.0 was found");
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-agent"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
