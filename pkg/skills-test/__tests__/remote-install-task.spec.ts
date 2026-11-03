import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, makeTempDir, readRepoFile, removeTempDirs } from "./test-support";

afterEach(removeTempDirs);

const tasks = (Bun.TOML.parse(readRepoFile(".mise", "config.toml")) as {
	tasks: Record<string, { run: string }>;
}).tasks;
const VERSION = (JSON.parse(readRepoFile("pkg", "skills-cli", "package.json")) as { version: string }).version;

describe("mise remote:install", () => {
	const script = tasks["remote:install"]?.run ?? "";

	function runTask(root: string) {
		return Bun.spawnSync(["sh", "-c", script], {
			cwd: REPO_ROOT,
			env: { ...process.env, DG_HOME: root },
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	test("installs each build as a new lib version, keeps the one it replaces, and never reuses a live directory", () => {
		expect(script).not.toContain("dist/dg-skills");
		const root = makeTempDir("dg-remote-install-");
		mkdirSync(join(root, "runtime", "bun-test"), { recursive: true });
		symlinkSync(process.execPath, join(root, "runtime", "bun-test", "bun"));
		symlinkSync("bun-test", join(root, "runtime", "current"));
		mkdirSync(join(root, "lib", "0.0.1"), { recursive: true });
		mkdirSync(join(root, "lib", `${VERSION}-local.1.1`), { recursive: true });
		symlinkSync("0.0.1", join(root, "lib", "current"));
		const localDir = new RegExp(`^${VERSION.replaceAll(".", "\\.")}-local\\.\\d+\\.\\d+$`);

		const first = runTask(root);
		expect(first.exitCode, first.stderr.toString()).toBe(0);
		const firstTarget = readlinkSync(join(root, "lib", "current"));
		expect(firstTarget).toMatch(localDir);

		const second = runTask(root);
		expect(second.exitCode, second.stderr.toString()).toBe(0);
		const secondTarget = readlinkSync(join(root, "lib", "current"));
		expect(secondTarget).toMatch(localDir);
		expect(secondTarget).not.toBe(firstTarget);

		expect(existsSync(join(root, "lib", firstTarget, "dg.js"))).toBe(true);
		expect(existsSync(join(root, "lib", secondTarget, "dg.js"))).toBe(true);
		expect(existsSync(join(root, "lib", `${VERSION}-local.1.1`))).toBe(false);
		expect(existsSync(join(root, "lib", "0.0.1"))).toBe(true);
		expect(readdirSync(join(root, "lib")).filter((name) => name.includes("staging") || name.includes(".tmp"))).toEqual([]);
		const version = Bun.spawnSync([join(root, "runtime", "current", "bun"), join(root, "lib", "current", "dg.js"), "dg-skills", "--version"]);
		expect(version.exitCode).toBe(0);
	}, 360_000);

	test("builds each run into its own temporary directory and removes it afterwards", () => {
		expect(script).toContain("mktemp -d");
		expect(script).toContain("trap");
		expect(script).not.toContain("pkg/launcher/dist");
	});

	test("refuses to run before bootstrap installed the pinned runtime", () => {
		const root = makeTempDir("dg-remote-install-bare-");
		const result = runTask(root);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("bootstrap.sh");
		expect(existsSync(join(root, "lib"))).toBe(false);
	});
});
