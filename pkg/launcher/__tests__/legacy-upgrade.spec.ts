import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oldShimText } from "../../skills-cli/__tests__/dg-launcher-fixtures";
import { fetchedUrls, installEnv, runCli, writeReleaseServer } from "../../skills-cli/__tests__/release-fixtures";
import { buildBundle } from "./bundle-fixtures";

setDefaultTimeout(120_000);

const NAMES = ["dg", "dg-skills", "dg-agent", "dg-daemon"] as const;
const OLD_BUNDLE_VERSION = "6.1.0";
const RUNTIME_VERSION = "1.4.4";
const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "skills-cli", "package.json"), "utf8")) as {
	version: string;
};

type Layout = { home: string; bin: string; data: string; log: string; cleanup: () => void };

function sixLayout(): Layout {
	const { bun, lib } = buildBundle();
	const directory = mkdtempSync(join(tmpdir(), "dg-legacy-upgrade-"));
	const home = join(directory, "home");
	const bin = join(home, "bin");
	const data = join(home, "data");
	const log = join(directory, "fetch.log");
	writeFileSync(log, "");
	const { preload } = writeReleaseServer(directory, log, version);
	mkdirSync(join(data, "lib", OLD_BUNDLE_VERSION), { recursive: true });
	writeFileSync(join(data, "lib", OLD_BUNDLE_VERSION, "dg.js"), "old bundle");
	cpSync(lib, join(data, "lib", version), { recursive: true });
	symlinkSync(version, join(data, "lib", "current"));
	const runtime = join(data, "runtime", RUNTIME_VERSION);
	mkdirSync(runtime, { recursive: true });
	const wrapper = `#!/bin/sh\nexec '${bun}' --preload '${preload}' "$@"\n`;
	writeFileSync(join(runtime, "bun"), wrapper, { mode: 0o755 });
	symlinkSync(RUNTIME_VERSION, join(data, "runtime", "current"));
	mkdirSync(bin, { recursive: true });
	for (const name of NAMES) writeFileSync(join(bin, name), oldShimText(data, name), { mode: 0o755 });
	mkdirSync(join(home, ".claude"), { recursive: true });
	const hook = { type: "command", command: `${bin}/dg-skills hooks run daily-prune` };
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }] } }));
	return { home, bin, data, log, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function expectCompiledLayout(w: Layout): void {
	expect(readlinkSync(join(w.data, "bin", "current"))).toBe(version);
	expect(readlinkSync(join(w.bin, "dg"))).toBe(join(w.data, "bin", "current", "dg"));
	expect(readdirSync(w.bin)).toEqual(["dg"]);
	const settings = readFileSync(join(w.home, ".claude", "settings.json"), "utf8");
	expect(settings).toContain(`${w.bin}/dg hooks run daily-prune`);
}

describe.skipIf(process.platform === "win32")("one self-update from a 6.x launcher layout", () => {
	let w: Layout;
	beforeEach(() => {
		w = sixLayout();
	});
	afterEach(() => w.cleanup());

	test("the install launchers step that a 6.2 to 6.4 update runs through the old dg-skills launcher lands the compiled dg", async () => {
		const result = await runCli([join(w.bin, "dg-skills"), "install", "launchers"], installEnv(w.home));

		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).not.toContain("finishing the upgrade");
		expectCompiledLayout(w);
	});

	test("after a 6.0 or 6.1 update, the next command through an old launcher finishes the layout and keeps stdout clean", async () => {
		const result = await runCli([join(w.bin, "dg"), "stash", "--help"], installEnv(w.home));

		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toContain("dg: finishing the upgrade: installing the compiled dg and removing the old launchers");
		expect(result.stdout).toContain("stash");
		expect(result.stdout).not.toContain(version);
		expectCompiledLayout(w);
	});

	test.each<[string, string[]]>([
		["dg-agent", ["--help"]],
		["dg-skills", ["hooks", "run", "daily-prune"]],
	])("%s %p through an old launcher downloads nothing and prints the next step", async (name, args) => {
		const result = await runCli([join(w.bin, name), ...args], installEnv(w.home));

		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toContain("dg: the upgrade is not finished; run dg upgrade once more to install the compiled dg");
		expect(fetchedUrls(w.log)).toEqual([]);
		expect(existsSync(join(w.data, "bin"))).toBe(false);
		expect(readdirSync(w.bin).sort()).toEqual([...NAMES].sort());
	});
});
