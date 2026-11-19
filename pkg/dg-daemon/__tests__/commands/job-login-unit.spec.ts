import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AutostartDeps,
	systemdUnitPath,
	systemdUnitText,
} from "@dg/common/node";
import { Command } from "commander";
import { registerJobCommands } from "../../src/commands/jobs";
import { readConfigStrict } from "../../src/server/config-store";
import {
	homeTracker,
	pathsOf,
	sleeperEntry,
} from "./job-cli-helpers";

const homes = homeTracker();
const saved: Record<string, string | undefined> = {};
let root: string;
let writes: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dg-login-unit-"));
	writes = [];
});

afterEach(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await homes.cleanup();
	rmSync(root, { recursive: true, force: true });
});

function useDgHome(dgHome: string): void {
	if (!("DG_HOME" in saved)) saved.DG_HOME = process.env.DG_HOME;
	process.env.DG_HOME = dgHome;
}

function fakeAutostart(
	dgHome: string,
	unit?: { text: string },
): AutostartDeps {
	const env = { DG_HOME: dgHome };
	const homeDir = join(root, "home");
	const unitPath = systemdUnitPath(homeDir, env, "dg-daemon");
	return {
		platform: "linux",
		homeDir,
		env,
		uid: 501,
		writeFile: (path) => {
			writes.push(path);
		},
		removeFile: () => {},
		fileExists: (path) =>
			path === unitPath ? unit !== undefined || writes.includes(path) : true,
		readFile: () => unit?.text ?? "",
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
}

async function runJob(
	args: string[],
	deps: {
		confirm: (question: string) => Promise<boolean>;
		isTerminal: () => boolean;
		autostart: AutostartDeps;
	},
): Promise<string[]> {
	const errors: string[] = [];
	const spy = spyOn(console, "error").mockImplementation((...parts) => {
		errors.push(parts.join(" "));
	});
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		const program = new Command().exitOverride();
		registerJobCommands(program, deps);
		await program.parseAsync(["node", "dg-daemon", "job", ...args]);
	} finally {
		spy.mockRestore();
		log.mockRestore();
	}
	return errors;
}

const QUESTION =
	"Start dg at login, so this job runs after a restart of the machine? [Y/n]";

describe("the login unit question of job enable", () => {
	it("asks one time at a terminal with no unit, writes no unit for n and marks the home", async () => {
		const { dgHome } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
			y: sleeperEntry(cwd),
		}));
		useDgHome(dgHome);
		const asked: string[] = [];
		const deps = {
			confirm: async (question: string) => {
				asked.push(question);
				return false;
			},
			isTerminal: () => true,
			autostart: fakeAutostart(dgHome),
		};

		await runJob(["enable", "x"], deps);
		await runJob(["enable", "y"], deps);

		expect(asked).toEqual([QUESTION]);
		expect(writes).toEqual([]);
		expect(readConfigStrict(pathsOf(dgHome)).loginUnitAsked).toBe(true);
	});

	it("runs the install action for y", async () => {
		const { dgHome } = await homes.boot((cwd) => ({ x: sleeperEntry(cwd) }));
		useDgHome(dgHome);
		const autostart = fakeAutostart(dgHome);

		await runJob(["enable", "x"], {
			confirm: async () => true,
			isTerminal: () => true,
			autostart,
		});

		expect(writes).toContain(
			systemdUnitPath(autostart.homeDir, autostart.env, "dg-daemon"),
		);
		expect(readConfigStrict(pathsOf(dgHome)).loginUnitAsked).toBe(true);
	});

	it("prints a warning, exits 0 and leaves the home unmarked when the install fails", async () => {
		const { dgHome } = await homes.boot((cwd) => ({ x: sleeperEntry(cwd) }));
		useDgHome(dgHome);
		const autostart: AutostartDeps = {
			...fakeAutostart(dgHome),
			writeFile: () => {
				throw new Error("disk full");
			},
		};

		const errors = await runJob(["enable", "x"], {
			confirm: async () => true,
			isTerminal: () => true,
			autostart,
		});

		expect(errors.some((line) => line.startsWith("warning:"))).toBe(true);
		expect(readConfigStrict(pathsOf(dgHome)).loginUnitAsked).toBeUndefined();
	});

	it("asks nothing and prints the hint when there is no terminal", async () => {
		const { dgHome } = await homes.boot((cwd) => ({ x: sleeperEntry(cwd) }));
		useDgHome(dgHome);
		let calls = 0;

		const errors = await runJob(["enable", "x"], {
			confirm: async () => {
				calls++;
				return true;
			},
			isTerminal: () => false,
			autostart: fakeAutostart(dgHome),
		});

		expect(calls).toBe(0);
		expect(errors).toContain(
			"hint: dg does not start at login — run dg autostart install",
		);
	});

	it("asks nothing and prints no hint when a unit records this DG_HOME", async () => {
		const { dgHome } = await homes.boot((cwd) => ({ x: sleeperEntry(cwd) }));
		useDgHome(dgHome);
		let calls = 0;
		const text = systemdUnitText({
			name: "dg-daemon",
			argv: ["dg", "serve"],
			dgHome,
			logPath: join(root, "unit.log"),
		});

		const errors = await runJob(["enable", "x"], {
			confirm: async () => {
				calls++;
				return true;
			},
			isTerminal: () => true,
			autostart: fakeAutostart(dgHome, { text }),
		});

		expect(calls).toBe(0);
		expect(errors.join("\n")).not.toContain("hint: dg does not start at login");
	});
});

describe("default confirm", () => {
	const SUPPORT = join(import.meta.dir, "..", "..", "src", "commands", "job-support.ts");
	const SCRIPT = `import { defaultJobVerbDeps } from ${JSON.stringify(SUPPORT)};
console.log(JSON.stringify(await defaultJobVerbDeps().confirm("Q?")));`;

	async function answer(input: string): Promise<boolean> {
		const proc = Bun.spawn([process.execPath, "-e", SCRIPT], {
			stdin: new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return JSON.parse(out.trim());
	}

	it.each([
		["an empty line", "\n", true],
		["Y", "Y\n", true],
		["n", "n\n", false],
		["end of input", "", false],
	])("answers %s", async (_label, input, expected) => {
		expect(await answer(input)).toBe(expected);
	});
});
