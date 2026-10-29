import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfCommand } from "../src/node/self-command";
import {
	launcherCommand,
	programCommand,
	programName,
	setProgramName,
} from "../src/node/program";

const scratch = mkdtempSync(join(tmpdir(), "dg-program-command-"));
const sourceEntry = join(scratch, "index.ts");
writeFileSync(sourceEntry, "");

function resetProgramName(): void {
	setProgramName(undefined);
}

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
	afterAll(() => {
		resetProgramName();
		rmSync(scratch, { recursive: true, force: true });
	});

	it("inserts the recorded program name after the entry file", () => {
		setProgramName("dg-skills");
		expect(selfCommand(["bg", "drain", "x"])).toEqual([
			process.execPath,
			Bun.main,
			"dg-skills",
			"bg",
			"drain",
			"x",
		]);
	});

	it("detects bundle mode from the recorded name even when the entry file is not dg.js", () => {
		setProgramName("dg-agent");
		expect(Bun.main.endsWith("dg.js")).toBe(false);
		expect(selfCommand(["phone", "__run"]).slice(2)).toEqual(["dg-agent", "phone", "__run"]);
	});

	it("ignores opts.entrypoint once a name is recorded", () => {
		setProgramName("dg-skills");
		expect(selfCommand(["bg"], { entrypoint: sourceEntry })).toEqual([
			process.execPath,
			Bun.main,
			"dg-skills",
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

	it("returns [runtimeBin, entry, name, ...args] for a sibling program", () => {
		setProgramName("dg-agent");
		expect(programCommand("dg-daemon", ["__serve"])).toEqual([
			process.execPath,
			Bun.main,
			"dg-daemon",
			"__serve",
		]);
	});

	it("never injects a versioned lib directory", () => {
		setProgramName("dg-agent");
		const argv = programCommand("dg-daemon", ["__serve"]);
		for (const part of argv) expect(part).not.toMatch(/[\\/]lib[\\/]\d+\.\d+\.\d+/);
	});
});

describe("launcherCommand", () => {
	const root = join(tmpdir(), "dg-root");

	it("uses the runtime/current and lib/current links for a stable unit argv", () => {
		const bunName = process.platform === "win32" ? "bun.exe" : "bun";
		expect(launcherCommand(root, "dg-agent", ["phone", "__run"])).toEqual([
			join(root, "runtime", "current", bunName),
			join(root, "lib", "current", "dg.js"),
			"dg-agent",
			"phone",
			"__run",
		]);
	});

	it("never names a version directory", () => {
		for (const part of launcherCommand(root, "dg-daemon", ["__serve"])) {
			expect(part).not.toMatch(/bun-v\d|[\\/]lib[\\/]\d+\.\d+\.\d+/);
		}
	});

	it.each([".dg", "./.dg", "dg-root", ""])(
		"rejects the relative root %p so the exec target never depends on the working directory",
		(relativeRoot) => {
			expect(() => launcherCommand(relativeRoot, "dg-agent", ["phone", "__run"])).toThrow(
				"launcher root must be absolute",
			);
		},
	);
});
