import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { compiledAssetName, platformKey } from "../src/utils/lib";
import { writeOldShims } from "./dg-launcher-fixtures";
import { fakeProgramScript, fetchedUrls, installEnv, runCli, writeReleaseServer } from "./release-fixtures";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const NAMES = ["dg", "dg-skills", "dg-agent", "dg-daemon"] as const;

type World = { directory: string; home: string; bin: string; data: string; log: string; cleanup: () => void };

function world(): World {
	const directory = mkdtempSync(join(tmpdir(), "dg-launchers-step-"));
	const home = join(directory, "home");
	const log = join(directory, "fetch.log");
	writeFileSync(log, "");
	mkdirSync(join(home, "bin"), { recursive: true });
	return {
		directory,
		home,
		bin: join(home, "bin"),
		data: join(home, "data"),
		log,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

function seedBridgeInstall(w: World, bundleVersion: string): void {
	writeOldShims(w.bin, w.bin, NAMES);
	for (const name of NAMES.slice(1)) writeFileSync(join(w.bin, `.${name}.version`), `${bundleVersion}\n`);
	mkdirSync(join(w.data, "lib", bundleVersion), { recursive: true });
	writeFileSync(join(w.data, "lib", bundleVersion, "dg.js"), "bundle");
	symlinkSync(bundleVersion, join(w.data, "lib", "current"));
}

function launchersEnv(home: string, build?: string): Record<string, string> {
	const env = installEnv(home);
	delete env.DG_BUILD_VERSION;
	if (build) env.DG_BUILD_VERSION = build;
	return env;
}

const argv = (preload: string) => ["bun", "--preload", preload, ENTRY, "install", "launchers"];

describe.skipIf(process.platform === "win32")("install launchers (the 6.3 bridge step)", () => {
	test("installs the compiled dg named by DG_BUILD_VERSION, links dg and removes the old shims", async () => {
		const w = world();
		try {
			seedBridgeInstall(w, "6.3.1");
			const { preload } = writeReleaseServer(w.directory, w.log, "7.0.0");

			const result = await runCli(argv(preload), launchersEnv(w.home, "7.0.0"));

			expect(result.code, result.stderr).toBe(0);
			expect(basename(readlinkSync(join(w.data, "bin", "current")))).toBe("7.0.0");
			expect(readlinkSync(join(w.bin, "dg"))).toBe(join(w.data, "bin", "current", "dg"));
			expect(readdirSync(w.bin)).toEqual(["dg"]);
			expect(fetchedUrls(w.log).some((url) => url.endsWith(`/v7.0.0/${compiledAssetName(platformKey())}`))).toBe(true);
			expect(existsSync(join(w.data, "lib", "6.3.1", "dg.js"))).toBe(true);
		} finally {
			w.cleanup();
		}
	});

	test("downloads nothing when the compiled version is installed and only finishes the layout", async () => {
		const w = world();
		try {
			seedBridgeInstall(w, "6.3.1");
			mkdirSync(join(w.data, "bin", "7.0.0"), { recursive: true });
			writeFileSync(join(w.data, "bin", "7.0.0", "dg"), fakeProgramScript("7.0.0"), { mode: 0o755 });
			symlinkSync("7.0.0", join(w.data, "bin", "current"));
			const { preload } = writeReleaseServer(w.directory, w.log, "7.0.0");

			const result = await runCli(argv(preload), launchersEnv(w.home, "7.0.0"));

			expect(result.code, result.stderr).toBe(0);
			expect(fetchedUrls(w.log).filter((url) => !url.includes("/releases?"))).toEqual([]);
			expect(readlinkSync(join(w.bin, "dg"))).toBe(join(w.data, "bin", "current", "dg"));
			expect(readdirSync(w.bin)).toEqual(["dg"]);
		} finally {
			w.cleanup();
		}
	});

	test("without DG_BUILD_VERSION it installs the version that lib/current names", async () => {
		const w = world();
		try {
			seedBridgeInstall(w, "6.3.1");
			const { preload } = writeReleaseServer(w.directory, w.log, "6.3.1");

			const result = await runCli(argv(preload), launchersEnv(w.home));

			expect(result.code, result.stderr).toBe(0);
			expect(basename(readlinkSync(join(w.data, "bin", "current")))).toBe("6.3.1");
			expect(readlinkSync(join(w.bin, "dg"))).toBe(join(w.data, "bin", "current", "dg"));
		} finally {
			w.cleanup();
		}
	});

	test("fails and changes nothing when no release is installed and DG_BUILD_VERSION is unset", async () => {
		const w = world();
		try {
			const { preload } = writeReleaseServer(w.directory, w.log, "7.0.0");

			const result = await runCli(argv(preload), launchersEnv(w.home));

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("no dg release is installed; run dg install");
			expect(readdirSync(w.bin)).toEqual([]);
			expect(existsSync(join(w.data, "bin"))).toBe(false);
		} finally {
			w.cleanup();
		}
	});

	test("rewrites hook commands that run dg-skills to the dg link", async () => {
		const w = world();
		try {
			seedBridgeInstall(w, "6.3.1");
			const settings = join(w.home, ".claude", "settings.json");
			mkdirSync(join(w.home, ".claude"), { recursive: true });
			writeFileSync(
				settings,
				JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: `${w.bin}/dg-skills hooks run spelling` }] }] } }),
			);
			const { preload } = writeReleaseServer(w.directory, w.log, "7.0.0");

			const result = await runCli(argv(preload), launchersEnv(w.home, "7.0.0"));

			expect(result.code, result.stderr).toBe(0);
			expect(await Bun.file(settings).text()).toContain(`${w.bin}/dg hooks run spelling`);
		} finally {
			w.cleanup();
		}
	});
});
