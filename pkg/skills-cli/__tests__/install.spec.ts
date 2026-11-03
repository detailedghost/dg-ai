import { describe, expect, test } from "bun:test";
import { currentBinaryLine } from "../src/install/cli";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { fetchedUrls, installEnv, runCli, writeReleaseServer } from "./runtime-bundle-fixtures";

test("a bootstrap install says verified for dg-skills and already current for the others", () => {
	expect(currentBinaryLine("dg-skills", "1.12.0", true)).toBe(
		"dg-skills verified (v1.12.0).",
	);
	expect(currentBinaryLine("dg-daemon", "1.12.0", true)).toBe(
		"dg-daemon already current (v1.12.0).",
	);
	expect(currentBinaryLine("dg-skills", "1.12.0", false)).toBe(
		"dg-skills already current (v1.12.0).",
	);
});

interface LocalInstallWorld {
	directory: string;
	repo: string;
	home: string;
	output: string;
	destination: string;
}

function localInstallWorld(): LocalInstallWorld {
	const directory = mkdtempSync(join(tmpdir(), "dg-local-install-"));
	const repo = join(directory, "repo");
	const home = join(directory, "home");
	const output = join(repo, "pkg/extension/.output/chrome-mv3");
	for (const path of [output, join(repo, "node_modules/.bin"), join(home, ".config/dg")]) {
		mkdirSync(path, { recursive: true });
	}
	writeFileSync(join(repo, "pkg/extension/package.json"), "{}");
	writeFileSync(join(repo, "node_modules/.bin/wxt"), "");
	writeFileSync(join(output, "manifest.json"), JSON.stringify({ version: "1.11.0" }));
	writeFileSync(join(output, "background.js"), "stale build");
	return { directory, repo, home, output, destination: join(home, ".dg/dg-ai-extension-chrome") };
}

async function runLocalInstall(world: LocalInstallWorld, freshBuild: string) {
	const { home, repo, output } = world;
	const script = `
import { mock } from "bun:test";
import * as node from "@dg/common/node";
import { writeFileSync } from "node:fs";
import { Command } from "commander";
mock.module("@dg/common/node", () => ({ ...node, isWSL: () => false, run: (command, args) => {
  if (command !== "bun" || args.join(" ") !== "run build") throw new Error("unexpected command");
  writeFileSync(${JSON.stringify(join(output, "background.js"))}, ${JSON.stringify(freshBuild)});
  return "";
} }));
const { registerInstall } = await import(${JSON.stringify(new URL("../src/commands/install.ts", import.meta.url).pathname)});
const program = new Command();
registerInstall(program);
await program.parseAsync(["install", "--local", "--repo", ${JSON.stringify(repo)}], { from: "user" });
`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, HOME: home, USERPROFILE: home, DG_WINDOWS_HOME: home, DG_HOME: join(home, ".dg") },
		stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	return { stdout, stderr, exitCode };
}

test("install --local rebuilds stale output and replaces an installed extension of the same version", async () => {
	const world = localInstallWorld();
	try {
		mkdirSync(world.destination, { recursive: true });
		writeFileSync(join(world.destination, "background.js"), "installed release");
		writeFileSync(join(world.home, ".config/dg/browser-batch-installed"), JSON.stringify({ chrome: "1.11.0" }));
		const { stdout, stderr, exitCode } = await runLocalInstall(world, "fresh local build");
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout).toContain("staged at");
		expect(readFileSync(join(world.destination, "background.js"), "utf8")).toBe("fresh local build");
	} finally {
		rmSync(world.directory, { recursive: true, force: true });
	}
});

test("install updates the staged extension folder in place and writes the new marker", async () => {
	const world = localInstallWorld();
	try {
		mkdirSync(world.destination, { recursive: true });
		writeFileSync(join(world.destination, "background.js"), "installed release");
		writeFileSync(join(world.destination, "stale.js"), "removed from the new build");
		const inode = statSync(world.destination).ino;
		const { exitCode, stderr } = await runLocalInstall(world, "fresh local build");
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(statSync(world.destination).ino).toBe(inode);
		expect(existsSync(join(world.destination, "stale.js"))).toBe(false);
		expect(existsSync(join(world.home, ".config/dg/extension-installed"))).toBe(true);
		expect(readdirSync(join(world.home, ".dg")).sort()).toEqual(["dg-ai-extension-chrome"]);
	} finally {
		rmSync(world.directory, { recursive: true, force: true });
	}
});

test("install removes legacy batch extension folders by manifest name and says how to clear the browser entry", async () => {
	const world = localInstallWorld();
	try {
		const dgDir = join(world.home, ".dg");
		const batch = JSON.stringify({ name: "dg-ai-browser-batch", version: "1.0.0" });
		for (const name of ["browser-batch-extension", "dg-ai-browser-batch-chrome"]) {
			mkdirSync(join(dgDir, name), { recursive: true });
			writeFileSync(join(dgDir, name, "manifest.json"), batch);
		}
		mkdirSync(join(dgDir, "dg-ai-browser-batch-firefox"), { recursive: true });
		writeFileSync(join(dgDir, "dg-ai-browser-batch-firefox/manifest.json"), JSON.stringify({ name: "mine" }));
		const { stdout, stderr, exitCode } = await runLocalInstall(world, "fresh local build");
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(existsSync(join(dgDir, "browser-batch-extension"))).toBe(false);
		expect(existsSync(join(dgDir, "dg-ai-browser-batch-chrome"))).toBe(false);
		expect(existsSync(join(dgDir, "dg-ai-browser-batch-firefox"))).toBe(true);
		const lines = stdout.split("\n").filter((line) => line.includes("dg-ai-browser-batch"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("chrome://extensions");
		expect(lines[0]).toContain("dg-ai-browser-batch");
	} finally {
		rmSync(world.directory, { recursive: true, force: true });
	}
});

test("install prints no legacy line when nothing legacy was removed", async () => {
	const world = localInstallWorld();
	try {
		const { stdout, exitCode } = await runLocalInstall(world, "fresh local build");
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain("dg-ai-browser-batch");
	} finally {
		rmSync(world.directory, { recursive: true, force: true });
	}
});

async function runInstallWithHome(env: Record<string, string | undefined>, home: string) {
	const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const child = Bun.spawn(["bun", entry, "install", "--agent-only", "--cli-only"], {
		env: { ...process.env, HOME: home, USERPROFILE: home, DG_HOME: undefined, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	return { stderr, exitCode };
}

test("install prints the DG_HOME note to stderr once when DG_HOME is not the default home", async () => {
	const directory = mkdtempSync(join(tmpdir(), "dg-home-note-"));
	try {
		const custom = join(directory, "x");
		const { stderr } = await runInstallWithHome({ DG_HOME: custom }, directory);
		const notes = stderr.split("\n").filter((line) => line.startsWith("note: DG_HOME="));
		expect(notes).toEqual([`note: DG_HOME=${custom}; installing there`]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("install prints no DG_HOME note when DG_HOME is unset or names the default home", async () => {
	const directory = mkdtempSync(join(tmpdir(), "dg-home-note-"));
	try {
		const unset = await runInstallWithHome({}, directory);
		const explicit = await runInstallWithHome({ DG_HOME: join(directory, ".dg") }, directory);
		expect(unset.stderr).not.toContain("note: DG_HOME=");
		expect(explicit.stderr).not.toContain("note: DG_HOME=");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const VERSION = "1.27.0";

describe.skipIf(process.platform === "win32")("dg-skills install against a fake release server", () => {
	test("a full install ends with shims, lib/current and runtime/current links, and no compiled dg-skills", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-install-bundle-"));
		const home = join(directory, "home");
		const bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-skills"), "compiled ELF bytes", { mode: 0o755 });
		writeFileSync(join(bin, ".dg-skills.version"), "1.26.0\n");
		try {
			const log = join(directory, "fetch.log");
			writeFileSync(log, "");
			const { preload, pin } = writeReleaseServer(directory, log, VERSION);

			const result = await runCli(["bun", "--preload", preload, ENTRY, "install"], installEnv(home));

			expect(result.code).toBe(0);
			expect(readFileSync(join(bin, "dg-skills"), "utf8")).not.toContain("compiled ELF bytes");
			expect(readFileSync(join(bin, "dg-skills"), "utf8")).toContain(`root='${home}'`);
			expect(basename(readlinkSync(join(home, "lib", "current")))).toBe(VERSION);
			expect(basename(readlinkSync(join(home, "runtime", "current")))).toBe(`bun-v${pin}`);
			expect(existsSync(join(home, "runtime", "current", "bun"))).toBe(true);
			expect(existsSync(join(bin, ".dg-skills.version"))).toBe(false);
			for (const name of ["dg-agent", "dg-daemon"]) {
				expect(readFileSync(join(bin, name), "utf8")).toContain(`${name} "$@"`);
			}
			const version = await runCli([join(bin, "dg-skills"), "--version"], installEnv(home));
			expect(version.stdout.trim()).toBe(VERSION);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a bundle that fails verification leaves runtime/current and lib/current unchanged", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-install-atomic-"));
		const home = join(directory, "home");
		mkdirSync(join(home, "runtime", "bun-old"), { recursive: true });
		mkdirSync(join(home, "lib", "1.0.0"), { recursive: true });
		symlinkSync("bun-old", join(home, "runtime", "current"));
		symlinkSync("1.0.0", join(home, "lib", "current"));
		try {
			const log = join(directory, "fetch.log");
			writeFileSync(log, "");
			const { preload } = writeReleaseServer(directory, log, VERSION, {
				sums: (sums) => sums.replace(/^[0-9a-f]{64}/, "0".repeat(64)),
			});

			const result = await runCli(["bun", "--preload", preload, ENTRY, "install"], installEnv(home));

			expect(result.stderr).toContain("skipped");
			expect(basename(readlinkSync(join(home, "runtime", "current")))).toBe("bun-old");
			expect(basename(readlinkSync(join(home, "lib", "current")))).toBe("1.0.0");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	for (const previousRuntime of [true, false]) {
		test(`a failed lib/current switch restores runtime/current (${previousRuntime ? "previous runtime" : "no previous runtime"})`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "dg-install-rollback-link-"));
			const home = join(directory, "home");
			mkdirSync(join(home, "lib", "current", "blocker"), { recursive: true });
			if (previousRuntime) {
				mkdirSync(join(home, "runtime", "bun-old"), { recursive: true });
				symlinkSync("bun-old", join(home, "runtime", "current"));
			}
			try {
				const log = join(directory, "fetch.log");
				writeFileSync(log, "");
				const { preload } = writeReleaseServer(directory, log, VERSION);

				const result = await runCli(["bun", "--preload", preload, ENTRY, "install"], installEnv(home));

				expect(result.stderr).toContain("skipped");
				const current = join(home, "runtime", "current");
				if (previousRuntime) expect(basename(readlinkSync(current))).toBe("bun-old");
				else expect(existsSync(current)).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test("install --version <previous release> relinks lib/current with no bundle or runtime download while its directory exists", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-install-rollback-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		try {
			const log = join(directory, "fetch.log");
			writeFileSync(log, "");
			const { preload } = writeReleaseServer(directory, log, VERSION, { also: ["1.28.0"] });
			const env = installEnv(home);
			const argv = (...args: string[]) => ["bun", "--preload", preload, ENTRY, "install", ...args];

			expect((await runCli(argv("--version", VERSION), env)).code).toBe(0);
			expect((await runCli(argv(), env)).code).toBe(0);
			expect(basename(readlinkSync(join(home, "lib", "current")))).toBe("1.28.0");
			const before = fetchedUrls(log).length;

			const rollback = await runCli(argv("--version", VERSION), env);

			expect(rollback.code).toBe(0);
			expect(basename(readlinkSync(join(home, "lib", "current")))).toBe(VERSION);
			expect(existsSync(join(home, "lib", "1.28.0", "dg.js"))).toBe(true);
			const fetched = fetchedUrls(log).slice(before);
			expect(fetched.filter((url) => /dg-lib-.*\.tar\.gz$|bun-.*\.zip$/.test(url))).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
