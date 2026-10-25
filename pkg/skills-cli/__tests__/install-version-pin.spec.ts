/**
 * `install --version <x.y.z>` pins skills-v/daemon-v/agent-v/ext-v resolution to that
 * exact tag instead of each one's newest release — the carry-through a pinned
 * bootstrap relies on. A missing pinned daemon-v, agent-v or ext-v release hard-fails
 * before any binary or the extension is touched, so a pin never leaves a mixed set. A
 * missing pinned skills-v release still warns and skips, unchanged from today.
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

	test("hard-fails naming the exact missing tag when the pinned agent-v release does not exist, and writes no binary", async () => {
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

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named agent-v4.0.0 found");
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-agent"))).toBe(false);
			expect(existsSync(join(home, "cli-only"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

/** Serves ext-v/skills-v/daemon-v/agent-v releases for the same version, minus any tag named in `missing`. */
function writeFullPreload(dir: string, log: string, missing: string[] = []): string {
	const base = "https://github.com/detailedghost/dg-ai/releases/download";
	const candidates = [
		{ tag: "skills-v1.2.3", asset: assetName("dg-skills") },
		{ tag: "daemon-v1.2.3", asset: assetName("dg-daemon") },
		{ tag: "agent-v1.2.3", asset: assetName("dg-agent") },
		{ tag: "ext-v1.2.3", asset: "dg-ai-extension-1.2.3-chrome.zip" },
	];
	const releases = candidates
		.filter(({ tag }) => !missing.includes(tag))
		.map(({ tag, asset }) => ({
			tag_name: tag,
			draft: false,
			assets: [{ name: asset, browser_download_url: `${base}/${tag}/${asset}` }],
		}));
	const path = join(dir, "full-preload.ts");
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";
const releases = ${JSON.stringify(releases)};
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  appendFileSync(${JSON.stringify(log)}, url + "\\n");
  if (url.includes("/releases?")) return new Response(JSON.stringify(releases));
  throw new Error("a hard-failed pinned install must not fetch " + url);
}) as typeof fetch;
`,
	);
	return path;
}

describe("dg-skills install --version <x.y.z> (default install, extension included)", () => {
	test("hard-fails naming ext-v before staging the extension, even though skills/daemon/agent all exist", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-version-pin-ext-missing-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writeFullPreload(directory, fetchLog, ["ext-v1.2.3"]);
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--version", "1.2.3"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named ext-v1.2.3 found");
			expect(existsSync(join(home, ".dg", "dg-ai-extension-chrome"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-daemon"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-agent"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("hard-fails naming daemon-v and never stages the extension, even though ext-v exists", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-version-pin-daemon-missing-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const preload = writeFullPreload(directory, fetchLog, ["daemon-v1.2.3"]);
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--version", "1.2.3"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named daemon-v1.2.3 found");
			expect(existsSync(join(home, ".dg", "dg-ai-extension-chrome"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-daemon"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-agent"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
