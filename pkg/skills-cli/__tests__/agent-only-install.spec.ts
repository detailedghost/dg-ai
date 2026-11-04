/**
 * `install --agent-only` installs the runtime, the bundle and the three shims, so a
 * non-Claude agent that only needs phone has `dg-agent`. It never fetches the extension,
 * and never installs personas, which only the Claude-side CLI uses.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fetchedUrls, installEnv, runCli, writeReleaseServer } from "./runtime-bundle-fixtures";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const VERSION = "9.9.9";

describe("dg-skills install --agent-only", () => {
	test("installs the bundle and shims, skips the extension, and marks cli-only", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-agent-only-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(directory, "fetch.log");
		writeFileSync(fetchLog, "");
		try {
			const { preload } = writeReleaseServer(directory, fetchLog, VERSION);
			const result = await runCli(["bun", "--preload", preload, ENTRY, "install", "--agent-only"], installEnv(home));

			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("skipped");
			expect(result.stdout).toContain(
				'Agent-only install: the extension was skipped. Run "dg-skills install" to add it.',
			);

			const urls = fetchedUrls(fetchLog);
			expect(urls.some((url) => url.includes("/releases?"))).toBe(true);
			expect(urls.some((url) => url.endsWith(`/v${VERSION}/dg-lib-${VERSION}.tar.gz`))).toBe(true);
			expect(urls.filter((url) => /extension/.test(url))).toEqual([]);

			const bin = join(home, "bin");
			expect(readdirSync(bin).sort()).toEqual(["dg-agent", "dg-daemon", "dg-skills"]);
			expect(basename(readlinkSync(join(home, "data", "lib", "current")))).toBe(VERSION);
			expect(readFileSync(join(bin, "dg-agent"), "utf8")).toContain(`dg-agent "$@"`);

			expect(existsSync(join(home, "config", "cli-only"))).toBe(true);
			for (const dir of [join(home, "agents"), join(home, "skills"), join(home, "data", "agents"), join(home, "data", "skills")])
				expect([dir, existsSync(dir)]).toEqual([dir, false]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to combine with --cli-only", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-agent-only-combo-"));
		const home = join(directory, "home");
		mkdirSync(home, { recursive: true });
		try {
			const result = await runCli(
				["bun", ENTRY, "install", "--agent-only", "--cli-only"],
				installEnv(home),
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
			const result = await runCli(
				["bun", ENTRY, "install", "--skills-only", "--agent-only"],
				installEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("accepts only --repo and --dest");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
