import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfCommand } from "../src/node/self-command";
import {
	compiledProgramPath,
	isCompiled,
	launcherCommand,
	mountProgram,
	PROGRAM_NAMES,
	programCommand,
	programName,
	type ProgramName,
	rewriteLauncherArgv,
	setProgramName,
} from "../src/node/program";

const scratch = mkdtempSync(join(tmpdir(), "dg-program-command-"));
const sourceEntry = join(scratch, "index.ts");
writeFileSync(sourceEntry, "");

function resetProgramName(): void {
	setProgramName(undefined);
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("selfCommand in source mode", () => {
	it("returns [bun, index.ts, ...args] when no program name is recorded", () => {
		resetProgramName();
		expect(programName()).toBeUndefined();
		expect(selfCommand(["bg", "drain", "x"], { entrypoint: sourceEntry })).toEqual([
			process.execPath,
			sourceEntry,
			"bg",
			"drain",
			"x",
		]);
	});
});

describe("selfCommand in bundle mode", () => {
	afterAll(resetProgramName);

	it("inserts the dg group word of the recorded program after the entry file", () => {
		setProgramName("dg-skills");
		expect(selfCommand(["bg", "drain", "x"])).toEqual([
			process.execPath,
			Bun.main,
			"skills",
			"bg",
			"drain",
			"x",
		]);
	});

	it("detects bundle mode from the recorded name even when the entry file is not dg.js", () => {
		setProgramName("dg-agent");
		expect(Bun.main.endsWith("dg.js")).toBe(false);
		expect(selfCommand(["phone", "listen"]).slice(2)).toEqual(["agent", "phone", "listen"]);
	});

	it("ignores opts.entrypoint once a name is recorded", () => {
		setProgramName("dg-skills");
		expect(selfCommand(["bg"], { entrypoint: sourceEntry })).toEqual([
			process.execPath,
			Bun.main,
			"skills",
			"bg",
		]);
	});

	it("reports the recorded name through programName", () => {
		setProgramName("dg-daemon");
		expect(programName()).toBe("dg-daemon");
	});
});

describe("programCommand", () => {
	afterAll(resetProgramName);

	it("returns [runtimeBin, entry, group, ...args] for a sibling program in the bundle", () => {
		setProgramName("dg-agent");
		expect(programCommand("dg-daemon", ["serve"])).toEqual([process.execPath, Bun.main, "daemon", "serve"]);
	});

	it("runs the sibling package's source entry when no bundle program is recorded", () => {
		resetProgramName();
		const pkgRoot = join(import.meta.dir, "..", "..");
		expect(programCommand("dg-daemon", ["serve"])).toEqual([
			process.execPath,
			join(pkgRoot, "dg-daemon", "src", "index.ts"),
			"serve",
		]);
		expect(programCommand("dg-skills", ["bg"])[1]).toBe(join(pkgRoot, "skills-cli", "src", "index.ts"));
		expect(programCommand("dg-agent", [])[1]).toBe(join(pkgRoot, "dg-agent", "src", "index.ts"));
	});

	it("never injects a versioned lib directory", () => {
		setProgramName("dg-agent");
		const argv = programCommand("dg-daemon", ["serve"]);
		for (const part of argv) expect(part).not.toMatch(/[\\/]lib[\\/]\d+\.\d+\.\d+/);
	});
});

describe("launcherCommand", () => {
	const root = join(tmpdir(), "dg-root");
	const exe = process.platform === "win32" ? "dg.exe" : "dg";

	it("uses the bin/current link of the compiled program for a stable unit argv", () => {
		expect(launcherCommand(root, "dg-agent", ["phone", "listen"])).toEqual([join(root, "bin", "current", exe), "agent", "phone", "listen"]);
		expect(launcherCommand(root, "dg-daemon", ["serve"])).toEqual([join(root, "bin", "current", exe), "daemon", "serve"]);
	});

	it("never names a version directory, the runtime or the bundle", () => {
		for (const part of launcherCommand(root, "dg-daemon", ["serve"])) {
			expect(part).not.toMatch(/bun-v\d|[\\/]bin[\\/]\d+\.\d+\.\d+|runtime|dg\.js/);
		}
	});

	it("compiledProgramPath names dg.exe on Windows", () => {
		expect(compiledProgramPath(root, "win32")).toBe(join(root, "bin", "current", "dg.exe"));
		expect(compiledProgramPath(root, "linux")).toBe(join(root, "bin", "current", "dg"));
	});

	it.each([".dg", "./.dg", "dg-root", ""])(
		"rejects the relative root %p so the exec target never depends on the working directory",
		(relativeRoot) => {
			expect(() => launcherCommand(relativeRoot, "dg-agent", ["phone", "listen"])).toThrow(
				"launcher root must be absolute",
			);
		},
	);
});

describe("the dg program name", () => {
	afterAll(resetProgramName);

	it("keeps PROGRAM_NAMES at the three command trees", () => {
		expect([...PROGRAM_NAMES]).toEqual(["dg-skills", "dg-agent", "dg-daemon"]);
	});

	it("accepts dg as a ProgramName and runs pkg/dg source entry in a checkout", () => {
		resetProgramName();
		const dg: ProgramName = "dg";
		const pkgRoot = join(import.meta.dir, "..", "..");
		expect(programCommand(dg, ["x"])).toEqual([process.execPath, join(pkgRoot, "dg", "src", "index.ts"), "x"]);
	});

	it("builds the bundle argv for dg when a program is recorded", () => {
		setProgramName("dg");
		expect(programCommand("dg", ["x"])).toEqual([process.execPath, Bun.main, "x"]);
	});
});

describe("mountProgram", () => {
	const pkgRoot = join(import.meta.dir, "..", "..");

	afterEach(resetProgramName);

	it("in a checkout makes selfCommand build the mounted program source argv and leaves programName undefined", () => {
		resetProgramName();
		mountProgram("dg-skills");
		expect(programName()).toBeUndefined();
		expect(selfCommand(["x"], { entrypoint: sourceEntry })).toEqual([
			process.execPath,
			join(pkgRoot, "skills-cli", "src", "index.ts"),
			"x",
		]);
	});

	it("in a checkout does not turn on the bundle branch of programCommand", () => {
		resetProgramName();
		mountProgram("dg-skills");
		expect(programCommand("dg-daemon", ["serve"])).toEqual([
			process.execPath,
			join(pkgRoot, "dg-daemon", "src", "index.ts"),
			"serve",
		]);
	});

	it("in a bundle records the mounted name and selfCommand builds the bundle argv for it", () => {
		setProgramName("dg");
		mountProgram("dg-skills");
		expect(programName()).toBe("dg-skills");
		expect(selfCommand(["x"])).toEqual([process.execPath, Bun.main, "skills", "x"]);
	});

	it.each(["dg-skills", "dg-agent", "dg-daemon"] as const)("a checkout mount of %s builds its source argv", (name) => {
		resetProgramName();
		mountProgram(name);
		const entry = programCommand(name, [])[1];
		expect(selfCommand(["x"], { entrypoint: sourceEntry })[1]).toBe(entry);
	});

	it("setProgramName(undefined) clears the mounted program so selfCommand returns to the pre-mount argv", () => {
		resetProgramName();
		const before = selfCommand(["x"], { entrypoint: sourceEntry });
		mountProgram("dg-skills");
		expect(selfCommand(["x"], { entrypoint: sourceEntry })).not.toEqual(before);
		setProgramName(undefined);
		expect(selfCommand(["x"], { entrypoint: sourceEntry })).toEqual(before);
	});
});

describe("isCompiled", () => {
	it.each([
		["/$bunfs/root/dg", true],
		["B:/~BUN/root/dg.exe", true],
		["B:\\~BUN\\root\\dg.exe", true],
		["/home/u/.local/share/dg/lib/current/dg.js", false],
		["/repo/pkg/dg/src/index.ts", false],
	])("%p is %p", (main, expected) => {
		expect(isCompiled(main)).toBe(expected);
	});
});

describe("rewriteLauncherArgv", () => {
	it("maps the 6.3 bundle argv of a unit to the compiled program and its group", () => {
		expect(
			rewriteLauncherArgv(["/d/runtime/current/bun", "/d/lib/current/dg.js", "dg-daemon", "serve"]),
		).toEqual(["/d/bin/current/dg", "daemon", "serve"]);
		expect(
			rewriteLauncherArgv(["/d/runtime/current/bun", "/d/lib/current/dg.js", "dg-agent", "phone", "listen", "--x"]),
		).toEqual(["/d/bin/current/dg", "agent", "phone", "listen", "--x"]);
		expect(rewriteLauncherArgv(["/d/runtime/current/bun", "/d/lib/current/dg.js", "dg", "job", "list"])).toEqual([
			"/d/bin/current/dg",
			"job",
			"list",
		]);
	});

	it("maps the Windows bundle argv to dg.exe", () => {
		expect(
			rewriteLauncherArgv(["C:\\d\\runtime\\current\\bun.exe", "C:\\d\\lib\\current\\dg.js", "dg-daemon", "serve"]),
		).toEqual(["C:\\d\\bin\\current\\dg.exe", "daemon", "serve"]);
	});

	it("maps an old program name on PATH to dg and its group word", () => {
		expect(rewriteLauncherArgv(["dg-skills", "inbox", "--x"])).toEqual(["dg", "skills", "inbox", "--x"]);
		expect(rewriteLauncherArgv(["dg-daemon", "job", "list"])).toEqual(["dg", "daemon", "job", "list"]);
	});

	it("maps an old launcher path, and a .cmd launcher to dg.exe beside it", () => {
		expect(rewriteLauncherArgv(["/h/.local/bin/dg-agent", "phone"])).toEqual(["/h/.local/bin/dg", "agent", "phone"]);
		expect(rewriteLauncherArgv(["C:\\dg\\bin\\dg-skills.cmd", "stat"])).toEqual(["C:\\dg\\bin\\dg.exe", "skills", "stat"]);
	});

	it("with a root maps an old program name or a stale legacy path to the absolute compiled program", () => {
		expect(rewriteLauncherArgv(["dg-skills", "inbox"], "/d")).toEqual(["/d/bin/current/dg", "skills", "inbox"]);
		expect(rewriteLauncherArgv(["/home/u/.dg/bin/dg-skills", "stat"], "/d")).toEqual(["/d/bin/current/dg", "skills", "stat"]);
		expect(rewriteLauncherArgv(["/h/.local/bin/dg-agent", "phone"], "/d")).toEqual(["/d/bin/current/dg", "agent", "phone"]);
		expect(rewriteLauncherArgv(["python3", "bot.py"], "/d")).toBeUndefined();
	});

	it.each([
		[["dg", "skills", "inbox"]],
		[["/d/bin/current/dg", "daemon", "serve"]],
		[["python3", "bot.py"]],
		[["mydg-skills", "x"]],
		[["/d/runtime/current/bun", "/elsewhere/dg.js", "dg-daemon", "serve"]],
		[["/d/runtime/current/bun", "/d/lib/current/dg.js", "nope"]],
		[[]],
	])("leaves %j alone", (argv) => {
		expect(rewriteLauncherArgv(argv)).toBeUndefined();
	});

	it("is idempotent: a rewritten argv is not rewritten again", () => {
		const once = rewriteLauncherArgv(["/d/runtime/current/bun", "/d/lib/current/dg.js", "dg-skills", "stat"]) as string[];
		expect(rewriteLauncherArgv(once)).toBeUndefined();
		expect(rewriteLauncherArgv(rewriteLauncherArgv(["dg-agent", "x"]) as string[])).toBeUndefined();
	});
});
