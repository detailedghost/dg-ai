import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, makeTempDir, readRepoFile, removeTempDirs } from "./test-support";

afterEach(removeTempDirs);

const tasks = (Bun.TOML.parse(readRepoFile(".mise", "config.toml")) as {
	tasks: Record<string, { run: string }>;
}).tasks;
const VERSION = (JSON.parse(readRepoFile("pkg", "skills-cli", "package.json")) as { version: string }).version;

describe("mise remote:install", () => {
	const script = tasks["remote:install"]?.run ?? "";

	test("installs the built bundle as a new lib version and relinks lib/current, with no compiled binary", () => {
		expect(script).not.toContain("dist/dg-skills");
		const root = makeTempDir("dg-remote-install-");
		mkdirSync(join(root, "runtime", "bun-test"), { recursive: true });
		symlinkSync(process.execPath, join(root, "runtime", "bun-test", "bun"));
		symlinkSync("bun-test", join(root, "runtime", "current"));
		mkdirSync(join(root, "lib", "0.0.1"), { recursive: true });
		symlinkSync("0.0.1", join(root, "lib", "current"));

		const result = Bun.spawnSync(["sh", "-c", script], {
			cwd: REPO_ROOT,
			env: { ...process.env, DG_HOME: root },
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const current = readlinkSync(join(root, "lib", "current"));
		expect(current).toBe(`${VERSION}-local`);
		expect(existsSync(join(root, "lib", current, "dg.js"))).toBe(true);
		expect(existsSync(join(root, "lib", "0.0.1"))).toBe(true);
		const version = Bun.spawnSync([join(root, "runtime", "current", "bun"), join(root, "lib", "current", "dg.js"), "dg-skills", "--version"]);
		expect(version.exitCode).toBe(0);
	}, 180_000);

	test("refuses to run before bootstrap installed the pinned runtime", () => {
		const root = makeTempDir("dg-remote-install-bare-");
		const result = Bun.spawnSync(["sh", "-c", script], {
			cwd: REPO_ROOT,
			env: { ...process.env, DG_HOME: root },
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("bootstrap.sh");
		expect(existsSync(join(root, "lib"))).toBe(false);
	});
});
