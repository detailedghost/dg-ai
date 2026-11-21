/**
 * `install --agent-only` installs the compiled dg and links `<bin>/dg`, so a
 * non-Claude agent that only needs phone has `dg agent`. It never fetches the extension,
 * and never installs personas, which only the Claude-side CLI uses.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { compiledAssetName, platformKey } from "../src/utils/lib";
import { fetchedUrls, installEnv, runCli, writeReleaseServer } from "./release-fixtures";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const VERSION = "9.9.9";

describe("dg install --agent-only", () => {
	test("installs the compiled dg and its link, skips the extension, and marks cli-only", async () => {
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
				'Agent-only install: the extension was skipped. Run "dg install" to add it.',
			);

			const urls = fetchedUrls(fetchLog);
			expect(urls.some((url) => url.includes("/releases?"))).toBe(true);
			expect(urls.some((url) => url.endsWith(`/v${VERSION}/${compiledAssetName(platformKey())}`))).toBe(true);
			expect(urls.filter((url) => /extension/.test(url))).toEqual([]);

			const bin = join(home, "bin");
			expect(readdirSync(bin)).toEqual(["dg"]);
			expect(readlinkSync(join(bin, "dg"))).toBe(join(home, "data", "bin", "current", "dg"));
			expect(basename(readlinkSync(join(home, "data", "bin", "current")))).toBe(VERSION);
			expect(urls.filter((url) => /runtime\.json|dg-lib-|bun-.*\.zip/.test(url))).toEqual([]);

			expect(Bun.TOML.parse(readFileSync(join(home, "config", "config.toml"), "utf8"))).toMatchObject({ install: { cli_only: true } });
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
