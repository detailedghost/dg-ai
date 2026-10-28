/**
 * `install --version <x.y.z>` pins every part to that exact vX.Y.Z release instead of
 * the newest one — the carry-through a pinned bootstrap relies on. Pins at or below
 * 1.21.1 resolve the old per-part prefixed tags. A missing pinned release or part
 * hard-fails before any binary or the extension is touched, so a pin never leaves a mixed set.
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

function agentScript(pin: string): string {
	return `#!/bin/sh\nexit 0\n# fake dg-agent ${pin}\n`;
}

type Layout = { pin: string; tags: { skills: string; agent: string } };
const MODERN: Layout = { pin: "1.22.0", tags: { skills: "v1.22.0", agent: "v1.22.0" } };
const LEGACY: Layout = { pin: "1.2.3", tags: { skills: "skills-v1.2.3", agent: "agent-v1.2.3" } };

/** Serves a newer v9.9.9 release plus the pinned release in the given layout, and logs every fetched URL. */
function writePreload(dir: string, log: string, layout: Layout): string {
	const base = "https://github.com/detailedghost/dg-ai/releases/download";
	const skillsAsset = assetName("dg-skills");
	const agentAsset = assetName("dg-agent");
	const entry = (tag: string, assets: string[]) => ({
		tag_name: tag,
		draft: false,
		assets: assets.map((name) => ({ name, browser_download_url: `${base}/${tag}/${name}` })),
	});
	const pinned =
		layout.tags.skills === layout.tags.agent
			? [entry(layout.tags.skills, [skillsAsset, agentAsset])]
			: [entry(layout.tags.skills, [skillsAsset]), entry(layout.tags.agent, [agentAsset])];
	const releases = [entry("v9.9.9", [skillsAsset, agentAsset]), ...pinned];
	const agentBody = agentScript(layout.pin);
	const path = join(dir, "preload.ts");
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";
const releases = ${JSON.stringify(releases)};
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  appendFileSync(${JSON.stringify(log)}, url + "\\n");
  if (url.includes("/releases?")) return new Response(JSON.stringify(releases));
  if (url.endsWith("/${layout.tags.skills}/${skillsAsset}")) return new Response("fake dg-skills ${layout.pin}");
  if (url.endsWith("/${layout.tags.agent}/${agentAsset}")) return new Response(${JSON.stringify(agentBody)});
  throw new Error("a pinned install must not fetch " + url);
}) as typeof fetch;
`,
	);
	return path;
}

function fetchedUrls(log: string): string[] {
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

const LAYOUTS: [string, Layout][] = [
	["a vX.Y.Z pin", MODERN],
	["a pin at or below 1.21.1", LEGACY],
];

function scratch(name: string): { directory: string; home: string; fetchLog: string } {
	const directory = mkdtempSync(join(tmpdir(), `dg-version-pin-${name}-`));
	const home = join(directory, "home");
	mkdirSync(home, { recursive: true });
	const fetchLog = join(directory, "fetch.log");
	writeFileSync(fetchLog, "");
	return { directory, home, fetchLog };
}

describe("dg-skills install --version <x.y.z>", () => {
	for (const [label, layout] of LAYOUTS) {
		test(`pins both dg-skills and dg-agent to the same release for ${label}, never touching the newer release`, async () => {
			const { directory, home, fetchLog } = scratch("pin");
			try {
				const preload = writePreload(directory, fetchLog, layout);
				const result = await run(
					["bun", "--preload", preload, ENTRY, "install", "--agent-only", "--version", layout.pin],
					childEnv(home),
				);

				expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });

				const urls = fetchedUrls(fetchLog);
				expect(urls.some((url) => url.endsWith(`/${layout.tags.skills}/${assetName("dg-skills")}`))).toBe(true);
				expect(urls.some((url) => url.endsWith(`/${layout.tags.agent}/${assetName("dg-agent")}`))).toBe(true);
				expect(urls.some((url) => url.includes("9.9.9"))).toBe(false);

				const bin = join(home, "bin");
				expect(readFileSync(join(bin, "dg-skills"), "utf8")).toBe(`fake dg-skills ${layout.pin}`);
				expect(readFileSync(join(bin, "dg-agent"), "utf8")).toBe(agentScript(layout.pin));
				expect(readFileSync(join(bin, ".dg-skills.version"), "utf8").trim()).toBe(layout.pin);
				expect(readFileSync(join(bin, ".dg-agent.version"), "utf8").trim()).toBe(layout.pin);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test("a pin downgrades an already-installed newer version, exact match only", async () => {
		const { directory, home, fetchLog } = scratch("downgrade");
		const bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-skills"), "fake dg-skills 9.9.9");
		writeFileSync(join(bin, ".dg-skills.version"), "9.9.9\n");
		writeFileSync(join(bin, "dg-agent"), "fake dg-agent 9.9.9");
		writeFileSync(join(bin, ".dg-agent.version"), "9.9.9\n");
		try {
			const preload = writePreload(directory, fetchLog, MODERN);
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--agent-only", "--version", MODERN.pin],
				childEnv(home),
			);

			expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			expect(readFileSync(join(bin, "dg-skills"), "utf8")).toBe(`fake dg-skills ${MODERN.pin}`);
			expect(readFileSync(join(bin, "dg-agent"), "utf8")).toBe(agentScript(MODERN.pin));
			expect(readFileSync(join(bin, ".dg-skills.version"), "utf8").trim()).toBe(MODERN.pin);
			expect(readFileSync(join(bin, ".dg-agent.version"), "utf8").trim()).toBe(MODERN.pin);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("--agent-only hard-fails naming the release when dg-agent is the only asset missing, and writes no binary", async () => {
		const { directory, home, fetchLog } = scratch("missing");
		try {
			const preload = writeFullPreload(directory, fetchLog, { omit: [assetName("dg-agent")] });
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--agent-only", "--version", "1.2.3"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("dg-agent: this platform");
			expect(result.stderr).toContain("has no published asset for v1.2.3");
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "bin", "dg-agent"))).toBe(false);
			expect(existsSync(join(home, "cli-only"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("--cli-only hard-fails naming v1.2.3 when the pinned release does not exist, and writes no binary", async () => {
		const { directory, home, fetchLog } = scratch("skills-missing");
		try {
			const preload = writeFullPreload(directory, fetchLog, { absent: true });
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--cli-only", "--version", "1.2.3"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named v1.2.3 found");
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, "cli-only"))).toBe(false);
			expect(existsSync(join(home, "agents"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("--skills-only hard-fails naming v1.2.3 when the pinned CLI release does not exist, writes no binary, and leaves existing skill files untouched", async () => {
		const { directory, home, fetchLog } = scratch("skills-only-missing");
		const staleSkillFile = join(home, "skills", "probe", "SKILL.md");
		mkdirSync(join(home, "skills", "probe"), { recursive: true });
		writeFileSync(staleSkillFile, "stale content\n");
		try {
			const preload = writeFullPreload(directory, fetchLog, { absent: true });
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--skills-only", "--version", "1.2.3"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named v1.2.3 found");
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(readFileSync(staleSkillFile, "utf8")).toBe("stale content\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

const PART_ASSETS = {
	dg_skills: assetName("dg-skills"),
	dg_daemon: assetName("dg-daemon"),
	dg_agent: assetName("dg-agent"),
	extension: "dg-ai-extension-1.2.3-chrome.zip",
};

/** Serves one v1.2.3 release holding every part, minus the assets in `omit`, or no v1.2.3 release when `absent`. */
function writeFullPreload(dir: string, log: string, opts: { omit?: string[]; absent?: boolean } = {}): string {
	const base = "https://github.com/detailedghost/dg-ai/releases/download";
	const assets = Object.values(PART_ASSETS)
		.filter((name) => !opts.omit?.includes(name))
		.map((name) => ({ name, browser_download_url: `${base}/v1.2.3/${name}` }));
	const releases = opts.absent ? [] : [{ tag_name: "v1.2.3", draft: false, assets }];
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
	const cases: [string, string[] | undefined, string][] = [
		["the extension zip", [PART_ASSETS.extension], "extension asset found for 1.2.3"],
		["dg-daemon", [PART_ASSETS.dg_daemon], "dg-daemon: this platform"],
		["dg-skills", [PART_ASSETS.dg_skills], "dg-skills: this platform"],
		["the whole release", undefined, "no release named v1.2.3 found"],
	];
	for (const [part, omit, message] of cases) {
		test(`hard-fails before staging the extension when ${part} is missing from the pinned release`, async () => {
			const { directory, home, fetchLog } = scratch("full");
			try {
				const preload = writeFullPreload(directory, fetchLog, omit ? { omit } : { absent: true });
				const result = await run(
					["bun", "--preload", preload, ENTRY, "install", "--version", "1.2.3"],
					childEnv(home),
				);

				expect(result.code).not.toBe(0);
				expect(result.stderr).toContain(message);
				expect(existsSync(join(home, ".dg", "dg-ai-extension-chrome"))).toBe(false);
				expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
				expect(existsSync(join(home, "bin", "dg-daemon"))).toBe(false);
				expect(existsSync(join(home, "bin", "dg-agent"))).toBe(false);
				expect(fetchedUrls(fetchLog).some((url) => url.includes(".zip"))).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test("a pin naming a missing release leaves an existing cli-only marker untouched", async () => {
		const { directory, home, fetchLog } = scratch("keeps-cli-only");
		writeFileSync(join(home, "cli-only"), "");
		try {
			const preload = writeFullPreload(directory, fetchLog, { absent: true });
			const result = await run(
				["bun", "--preload", preload, ENTRY, "install", "--version", "1.2.3"],
				childEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named v1.2.3 found");
			expect(existsSync(join(home, "cli-only"))).toBe(true);
			expect(existsSync(join(home, "bin", "dg-skills"))).toBe(false);
			expect(existsSync(join(home, ".dg", "dg-ai-extension-chrome"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
