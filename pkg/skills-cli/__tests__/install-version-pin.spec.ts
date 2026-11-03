/**
 * `install --version <x.y.z>` pins the bundle and the extension to that exact vX.Y.Z release instead of
 * the newest one. A missing release, a missing part or a release from before the bundle hard-fails
 * before the runtime, the bundle, the shims or the extension are touched, so a pin never leaves a mixed set.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	fetchedUrls,
	installEnv,
	type ReleaseKind,
	runCli,
	writeReleaseServer,
} from "./runtime-bundle-fixtures";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const PIN = "1.27.0";
const NEWER = "9.9.9";

function sandbox(name: string): { directory: string; home: string; fetchLog: string } {
	const directory = mkdtempSync(join(tmpdir(), `dg-version-pin-${name}-`));
	const home = join(directory, "home");
	mkdirSync(home, { recursive: true });
	const fetchLog = join(directory, "fetch.log");
	writeFileSync(fetchLog, "");
	return { directory, home, fetchLog };
}

function installArgv(preload: string, ...args: string[]): string[] {
	return ["bun", "--preload", preload, ENTRY, "install", ...args];
}

function expectNothingInstalled(home: string): void {
	for (const name of ["lib", "runtime", ".dg", "cli-only"]) expect(existsSync(join(home, name))).toBe(false);
	for (const name of ["dg-skills", "dg-agent", "dg-daemon"]) expect(existsSync(join(home, "bin", name))).toBe(false);
}

describe("dg-skills install --version <x.y.z>", () => {
	test("--agent-only pins the bundle to that release and never touches the newer one", async () => {
		const { directory, home, fetchLog } = sandbox("pin");
		try {
			const { preload } = writeReleaseServer(directory, fetchLog, PIN, { also: [NEWER] });

			const result = await runCli(installArgv(preload, "--agent-only", "--version", PIN), installEnv(home));

			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("skipped");
			expect(basename(readlinkSync(join(home, "lib", "current")))).toBe(PIN);
			expect(fetchedUrls(fetchLog).some((url) => url.includes(NEWER))).toBe(false);
			expect(readFileSync(join(home, "bin", "dg-agent"), "utf8")).toContain(`dg-agent "$@"`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a pin downgrades an installed newer version and removes its version stamps, exact match only", async () => {
		const { directory, home, fetchLog } = sandbox("downgrade");
		try {
			const { preload } = writeReleaseServer(directory, fetchLog, PIN, { also: [NEWER] });
			const newest = await runCli(installArgv(preload, "--agent-only"), installEnv(home));
			expect(newest.code).toBe(0);
			expect(basename(readlinkSync(join(home, "lib", "current")))).toBe(NEWER);
			writeFileSync(join(home, "bin", ".dg-skills.version"), `${NEWER}\n`);

			const pinned = await runCli(installArgv(preload, "--agent-only", "--version", PIN), installEnv(home));

			expect(pinned.code).toBe(0);
			expect(pinned.stderr).not.toContain("skipped");
			expect(basename(readlinkSync(join(home, "lib", "current")))).toBe(PIN);
			expect(existsSync(join(home, "bin", ".dg-skills.version"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a bundle that fails its checksum leaves runtime/current on the runtime it had", async () => {
		const { directory, home, fetchLog } = sandbox("runtime-restore");
		try {
			const { preload, pin } = writeReleaseServer(directory, fetchLog, PIN, {
				sums: (defaults) => defaults.replace(/^\S+(\s+dg-lib-)/m, `${"0".repeat(64)}$1`),
			});
			const old = join(home, "runtime", "bun-v0.0.1");
			mkdirSync(old, { recursive: true });
			writeFileSync(join(old, "bun"), "#!/bin/sh\n", { mode: 0o755 });
			symlinkSync("bun-v0.0.1", join(home, "runtime", "current"));

			const result = await runCli(installArgv(preload, "--cli-only", "--version", PIN), installEnv(home));

			expect(result.code).not.toBe(0);
			expect(existsSync(join(home, "runtime", `bun-v${pin}`))).toBe(true);
			expect(basename(readlinkSync(join(home, "runtime", "current")))).toBe("bun-v0.0.1");
			expect(existsSync(join(home, "lib", "current"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("--cli-only hard-fails naming v1.2.3 when the pinned release does not exist, and writes nothing", async () => {
		const { directory, home, fetchLog } = sandbox("cli-only-missing");
		try {
			const { preload } = writeReleaseServer(directory, fetchLog, PIN, { absent: true });

			const result = await runCli(installArgv(preload, "--cli-only", "--version", "1.2.3"), installEnv(home));

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named v1.2.3 found");
			expectNothingInstalled(home);
			expect(existsSync(join(home, "agents"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("--skills-only hard-fails naming v1.2.3 when the pinned release does not exist and leaves existing skill files untouched", async () => {
		const { directory, home, fetchLog } = sandbox("skills-only-missing");
		const staleSkillFile = join(home, "skills", "probe", "SKILL.md");
		mkdirSync(join(home, "skills", "probe"), { recursive: true });
		writeFileSync(staleSkillFile, "stale content\n");
		try {
			const { preload } = writeReleaseServer(directory, fetchLog, PIN, { absent: true });

			const result = await runCli(installArgv(preload, "--skills-only", "--version", "1.2.3"), installEnv(home));

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no release named v1.2.3 found");
			expect(existsSync(join(home, "lib"))).toBe(false);
			expect(readFileSync(staleSkillFile, "utf8")).toBe("stale content\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("dg-skills install --version <x.y.z> (default install, extension included)", () => {
	const cases: [string, ReleaseKind | undefined, string][] = [
		["the extension zip", "extension", `extension asset found for ${PIN}`],
		["the bundle", "bundle", `v${PIN} has no dg-lib-${PIN}.tar.gz: releases before the dg-lib bundle ship compiled binaries`],
		["runtime.json", "runtime", "runtime.json"],
		["SHA256SUMS", "sums", "SHA256SUMS"],
		["the whole release", undefined, `no release named v${PIN} found`],
	];
	for (const [part, omit, message] of cases) {
		test(`hard-fails before changing anything when ${part} is missing from the pinned release`, async () => {
			const { directory, home, fetchLog } = sandbox("full");
			try {
				const { preload } = writeReleaseServer(
					directory,
					fetchLog,
					PIN,
					omit ? { omit: [omit] } : { absent: true },
				);

				const result = await runCli(installArgv(preload, "--version", PIN), installEnv(home));

				expect(result.code).not.toBe(0);
				expect(result.stderr).toContain(message);
				expectNothingInstalled(home);
				expect(fetchedUrls(fetchLog).some((url) => /\.(zip|tar\.gz)$/.test(url))).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test("a pin naming a missing release leaves an existing cli-only marker untouched", async () => {
		const { directory, home, fetchLog } = sandbox("keeps-cli-only");
		writeFileSync(join(home, "cli-only"), "");
		try {
			const { preload } = writeReleaseServer(directory, fetchLog, PIN, { absent: true });

			const result = await runCli(installArgv(preload, "--version", PIN), installEnv(home));

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(`no release named v${PIN} found`);
			expect(existsSync(join(home, "cli-only"))).toBe(true);
			expect(existsSync(join(home, "lib"))).toBe(false);
			expect(existsSync(join(home, ".dg", "dg-ai-extension-chrome"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function assetName(binary: string): string {
	const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
	const cpu = process.arch === "arm64" ? "arm64" : "x64";
	return `${binary}-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

function writeCompiledOnlyPreload(dir: string, log: string): string {
	const base = "https://github.com/detailedghost/dg-ai/releases/download";
	const names = [
		assetName("dg-skills"),
		assetName("dg-daemon"),
		assetName("dg-agent"),
		"dg-ai-extension-1.2.3-chrome.zip",
	];
	const assets = names.map((name) => ({ name, browser_download_url: `${base}/v1.2.3/${name}` }));
	const releases = [{ tag_name: "v1.2.3", draft: false, assets }];
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

describe("dg-skills install --version <pre-E release>", () => {
	const modes: [string, string[]][] = [
		["the default install", []],
		["--cli-only", ["--cli-only"]],
		["--agent-only", ["--agent-only"]],
	];
	for (const [label, flags] of modes) {
		test(`${label} fails with the documented bootstrap message and changes nothing`, async () => {
			const { directory, home, fetchLog } = sandbox("pre-bundle");
			const bin = join(home, "bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(join(bin, "dg-skills"), "compiled dg-skills 1.2.3");
			writeFileSync(join(bin, ".dg-skills.version"), "1.2.3\n");
			try {
				const preload = writeCompiledOnlyPreload(directory, fetchLog);
				const result = await runCli(installArgv(preload, ...flags, "--version", "1.2.3"), installEnv(home));

				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(
					/releases before the dg-lib bundle ship compiled binaries; run that release's bootstrap\.sh: curl -fsSL https:\/\/github\.com\/[^ ]+\/releases\/download\/v1\.2\.3\/bootstrap\.sh \| sh/,
				);
				expect(readFileSync(join(bin, "dg-skills"), "utf8")).toBe("compiled dg-skills 1.2.3");
				expect(readFileSync(join(bin, ".dg-skills.version"), "utf8")).toBe("1.2.3\n");
				for (const name of ["lib", "runtime", ".dg", "cli-only"]) {
					expect(existsSync(join(home, name))).toBe(false);
				}
				expect(existsSync(join(bin, "dg-agent"))).toBe(false);
				expect(fetchedUrls(fetchLog).some((url) => /\.(zip|tar\.gz)$/.test(url))).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});
