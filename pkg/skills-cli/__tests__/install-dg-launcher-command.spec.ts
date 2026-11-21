import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEPT_SENTENCE, writeOldShims } from "./dg-launcher-fixtures";
import { installEnv, runCli, writeReleaseServer } from "./release-fixtures";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const VERSION = "9.9.9";
const FOREIGN = "#!/bin/sh\necho other tool\n";
const RETIRED_PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"] as const;
const bashFile = (home: string, program: string): string => join(home, "share", "bash-completion", "completions", program);

async function install(flag: string, seed?: (bin: string) => void) {
	const directory = mkdtempSync(join(tmpdir(), "dg-install-launcher-"));
	const home = join(directory, "home");
	mkdirSync(join(home, "bin"), { recursive: true });
	seed?.(join(home, "bin"));
	const fetchLog = join(directory, "fetch.log");
	writeFileSync(fetchLog, "");
	const { preload } = writeReleaseServer(directory, fetchLog, VERSION);
	const result = await runCli(["bun", "--preload", preload, ENTRY, "install", flag], installEnv(home));
	return { ...result, home, bin: join(home, "bin"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("dg install writes the dg link", () => {
	for (const flag of ["--cli-only", "--agent-only"]) {
		test(`${flag} links dg to the compiled program and writes only the dg completion files`, async () => {
			const run = await install(flag);
			try {
				expect(run.code, run.stderr).toBe(0);
				expect(readdirSync(run.bin)).toEqual(["dg"]);
				expect(readlinkSync(join(run.bin, "dg"))).toBe(join(run.home, "data", "bin", "current", "dg"));
				expect(existsSync(bashFile(run.home, "dg"))).toBe(true);
				for (const program of RETIRED_PROGRAMS) expect(existsSync(bashFile(run.home, program))).toBe(false);
			} finally {
				run.cleanup();
			}
		});
	}

	test("keeps a dg file of a different tool, warns with its path, exits 0 and writes no other launcher", async () => {
		const run = await install("--agent-only", (bin) => writeFileSync(join(bin, "dg"), FOREIGN, { mode: 0o755 }));
		try {
			expect(run.code, run.stderr).toBe(0);
			expect(readFileSync(join(run.bin, "dg"), "utf8")).toBe(FOREIGN);
			expect(run.stderr).toContain(KEPT_SENTENCE(join(run.bin, "dg")));
			expect(readdirSync(run.bin)).toEqual(["dg"]);
		} finally {
			run.cleanup();
		}
	});

	test("removes an old dg-skills shim from the bin dir", async () => {
		const run = await install("--agent-only", (bin) => writeOldShims(bin, bin, ["dg-skills", "dg-agent", "dg-daemon"]));
		try {
			expect(run.code, run.stderr).toBe(0);
			expect(readdirSync(run.bin)).toEqual(["dg"]);
		} finally {
			run.cleanup();
		}
	});
});
