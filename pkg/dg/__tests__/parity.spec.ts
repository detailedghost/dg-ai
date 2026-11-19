import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildBundle } from "../../skills-cli/__tests__/bundle-build";

setDefaultTimeout(180_000);

const PKG = join(import.meta.dir, "..", "..");
const SOURCE_ENTRY: Record<string, string> = {
	dg: join(PKG, "dg", "src", "index.ts"),
	"dg-daemon": join(PKG, "dg-daemon", "src", "index.ts"),
	"dg-skills": join(PKG, "skills-cli", "src", "index.ts"),
	"dg-agent": join(PKG, "dg-agent", "src", "index.ts"),
};

interface Result {
	stdout: string;
	stderr: string;
	exitCode: number;
}

type Mode = "checkout" | "bundle";

const homes: string[] = [];

function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "dg-parity-"));
	homes.push(home);
	mkdirSync(join(home, "home"));
	return home;
}

afterAll(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function bundleArgv(program: string, args: string[]): string[] {
	const { bun, entry } = buildBundle();
	return [bun, entry, program, ...args];
}

function invoke(
	mode: Mode,
	program: string,
	args: string[],
	home: string,
	extraEnv: Record<string, string> = {},
): Result {
	const argv = mode === "bundle" ? bundleArgv(program, args) : [process.execPath, SOURCE_ENTRY[program] as string, ...args];
	const proc = Bun.spawnSync(argv, {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: {
			...process.env,
			DG_HOME: join(home, ".dg"),
			HOME: join(home, "home"),
			USERPROFILE: join(home, "home"),
			...extraEnv,
		},
	});
	return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? -1 };
}

function listing(dir: string): string[] {
	try {
		return readdirSync(dir, { recursive: true })
			.map((entry) => relative(dir, join(dir, String(entry))))
			.filter((entry) => !/(^|[\\/])\.bun([\\/]|$)/.test(entry))
			.sort();
	} catch {
		return [];
	}
}

const MODES: Mode[] = ["checkout", "bundle"];

const HELP_ROWS: ReadonlyArray<readonly [string, string, string[]]> = [
	["job", "dg-daemon", ["job"]],
	["autostart", "dg-daemon", ["autostart"]],
	["daemon", "dg-daemon", []],
	["skills", "dg-skills", []],
	["agent", "dg-agent", []],
	["extension", "dg-skills", ["install"]],
	["install", "dg-skills", ["install"]],
	["upgrade", "dg-skills", ["update"]],
	["doctor", "dg-skills", ["doctor"]],
];

describe.each(MODES)("dg against the mounted programs (%s)", (mode) => {
	test.each(HELP_ROWS)("dg %s --help matches the --help of its target", (name, program, command) => {
		const home = freshHome();
		const viaDg = invoke(mode, "dg", [name, "--help"], home);
		const direct = invoke(mode, program, [...command, "--help"], home);
		expect(viaDg.stdout).toBe(direct.stdout);
		expect(viaDg.exitCode).toBe(direct.exitCode);
		expect(direct.stdout.length).toBeGreaterThan(0);
	});

	test("dg job list matches dg-daemon job list with no daemon", () => {
		const home = freshHome();
		const viaDg = invoke(mode, "dg", ["job", "list"], home);
		const direct = invoke(mode, "dg-daemon", ["job", "list"], home);
		expect(viaDg).toEqual(direct);
	});

	test("dg job with no more arguments matches dg-daemon job", () => {
		const home = freshHome();
		const viaDg = invoke(mode, "dg", ["job"], home);
		const direct = invoke(mode, "dg-daemon", ["job"], home);
		expect(viaDg.stdout).toBe(direct.stdout);
		expect(viaDg.exitCode).toBe(direct.exitCode);
	});

	test("dg daemon service status matches dg-daemon service status on stderr and exit code", () => {
		const home = freshHome();
		const viaDg = invoke(mode, "dg", ["daemon", "service", "status"], home);
		const direct = invoke(mode, "dg-daemon", ["service", "status"], home);
		expect(viaDg.stderr).toBe(direct.stderr);
		expect(viaDg.exitCode).toBe(direct.exitCode);
	});

	test("dg daemon status and dg-daemon status skip the layout step in the same way", () => {
		const viaDgHome = freshHome();
		const directHome = freshHome();
		const viaDg = invoke(mode, "dg", ["daemon", "status"], viaDgHome);
		const direct = invoke(mode, "dg-daemon", ["status"], directHome);
		expect(viaDg.exitCode).toBe(direct.exitCode);
		expect(listing(viaDgHome)).toEqual(listing(directHome));
	});

	test.each(HELP_ROWS.filter(([name]) => ["daemon", "skills", "agent"].includes(name)))(
		"dg %s --version gives the output of the mounted program",
		(name, program) => {
			const home = freshHome();
			const viaDg = invoke(mode, "dg", [name, "--version"], home);
			const direct = invoke(mode, program, ["--version"], home);
			expect(viaDg.stdout).toBe(direct.stdout);
			expect(viaDg.exitCode).toBe(direct.exitCode);
		},
	);

	test("dg nope exits 1 with the unknown-command error", () => {
		const result = invoke(mode, "dg", ["nope"], freshHome());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe('dg: unknown command "nope"; run dg --help\n');
		expect(result.stdout).toBe("");
	});

	test("dg --help exits 0 with DG_PATH_FENCE set and DG_HOME outside it", () => {
		const outside = freshHome();
		const result = invoke(mode, "dg", ["--help"], outside, { DG_PATH_FENCE: join(outside, "fence-elsewhere") });
		expect(result.exitCode).toBe(0);
		for (const name of ["job", "autostart", "daemon", "skills", "agent", "extension", "install", "upgrade", "doctor"])
			expect(result.stdout).toContain(name);
	});

	test("dg __complete job and autostart match the dg-daemon completions", () => {
		const home = freshHome();
		const complete = (program: string, args: string[]) => invoke(mode, program, args, home).stdout;
		expect(complete("dg", ["__complete", "job", ""])).toBe(complete("dg-daemon", ["__complete", "job", ""]));
		expect(complete("dg", ["__complete", "autostart", ""])).toBe(complete("dg-daemon", ["__complete", "autostart", ""]));
	});

	test("dg __complete upgrade and skills match the dg-skills completions", () => {
		const home = freshHome();
		const complete = (program: string, args: string[]) => invoke(mode, program, args, home).stdout;
		expect(complete("dg", ["__complete", "upgrade", ""])).toBe(complete("dg-skills", ["__complete", "update", ""]));
		expect(complete("dg", ["__complete", "skills", ""])).toBe(complete("dg-skills", ["__complete", ""]));
	});

	test("dg __complete nope x prints nothing and exits 0", () => {
		const result = invoke(mode, "dg", ["__complete", "nope", "x"], freshHome());
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});
});

describe("dg relative DG_HOME", () => {
	test("reaches the mounted program as an absolute path in a checkout", () => {
		const home = freshHome();
		const preload = join(home, "probe.ts");
		writeFileSync(
			preload,
			[
				'import { writeSync } from "node:fs";',
				'process.on("exit", () => writeSync(2, `DG_HOME=${process.env.DG_HOME}\\n`));',
				"",
			].join("\n"),
		);
		const proc = Bun.spawnSync([process.execPath, "--preload", preload, SOURCE_ENTRY.dg as string, "skills", "--help"], {
			cwd: home,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { ...process.env, DG_HOME: "relative/dg-home", HOME: join(home, "home") },
		});
		const seen = /DG_HOME=(.*)/.exec(proc.stderr.toString())?.[1];
		expect(seen).toBe(join(home, "relative", "dg-home"));
	});
});
