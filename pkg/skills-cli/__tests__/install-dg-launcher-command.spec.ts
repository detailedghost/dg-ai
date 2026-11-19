import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEPT_SENTENCE } from "./dg-launcher-fixtures";
import { installEnv, runCli, writeReleaseServer } from "./runtime-bundle-fixtures";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const VERSION = "9.9.9";
const FOREIGN = "#!/bin/sh\necho other tool\n";
const COMPLETION_PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"] as const;
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

describe("dg-skills install writes the dg launcher", () => {
	for (const flag of ["--cli-only", "--agent-only"]) {
		test(`${flag} writes dg, dg-agent, dg-daemon and dg-skills and the completion files of all four`, async () => {
			const run = await install(flag);
			try {
				expect(run.code, run.stderr).toBe(0);
				expect(readdirSync(run.bin).sort()).toEqual(["dg", "dg-agent", "dg-daemon", "dg-skills"]);
				for (const program of ["dg", ...COMPLETION_PROGRAMS]) expect(existsSync(bashFile(run.home, program))).toBe(true);
			} finally {
				run.cleanup();
			}
		});
	}

	test("keeps a dg file of a different tool, warns once or more with its path, exits 0 and still writes dg-daemon", async () => {
		const run = await install("--agent-only", (bin) => writeFileSync(join(bin, "dg"), FOREIGN, { mode: 0o755 }));
		try {
			expect(run.code, run.stderr).toBe(0);
			expect(readFileSync(join(run.bin, "dg"), "utf8")).toBe(FOREIGN);
			expect(run.stderr).toContain(KEPT_SENTENCE(join(run.bin, "dg")));
			for (const name of COMPLETION_PROGRAMS) expect(existsSync(join(run.bin, name))).toBe(true);
		} finally {
			run.cleanup();
		}
	});

	test("writes the completion files of the three other programs and no dg completion file for that kept file", async () => {
		const run = await install("--agent-only", (bin) => writeFileSync(join(bin, "dg"), FOREIGN, { mode: 0o755 }));
		try {
			for (const program of COMPLETION_PROGRAMS) expect(existsSync(bashFile(run.home, program))).toBe(true);
			expect(existsSync(bashFile(run.home, "dg"))).toBe(false);
			expect(existsSync(join(run.home, "config", "fish", "completions", "dg.fish"))).toBe(false);
		} finally {
			run.cleanup();
		}
	});
});
