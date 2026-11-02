import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerDemo } from "../src/commands/demo";
import { registerRerun } from "../src/commands/rerun";
import { setCliOnly } from "../src/utils/cli-only";
import type { TourScript } from "../src/utils/plan-format";


type Played = { script: TourScript; ext?: boolean };

let dir: string;
let plan: string;
let errors: string[];
let previousDgHome: string | undefined;

const unavailable = (name: string) =>
	`${name}: the local demo player is not available yet; pass --ext to play in the extension`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-demo-ext-"));
	previousDgHome = process.env.DG_HOME;
	process.env.DG_HOME = join(dir, ".dg");
	plan = join(dir, "tour.json");
	writeFileSync(
		plan,
		JSON.stringify({
			title: "t",
			startUrl: "https://example.test/",
			steps: [{ body: "hello" }],
		}),
	);
	errors = [];
	spyOn(console, "error").mockImplementation((line: unknown) => {
		errors.push(String(line));
	});
});

afterEach(() => {
	mock.restore();
	setCliOnly(false);
	if (previousDgHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = previousDgHome;
	rmSync(dir, { recursive: true, force: true });
});

async function drive(
	register: typeof registerDemo | typeof registerRerun,
	args: string[],
): Promise<Played[]> {
	const played: Played[] = [];
	const program = new Command().exitOverride();
	register(program, {
		play: async (script, opts) => void played.push({ script, ext: opts.ext }),
	});
	await program.parseAsync(args, { from: "user" });
	return played;
}

describe.each([
	["demo", registerDemo],
	["rerun", registerRerun],
] as const)("%s", (name, register) => {
	test.each([
		["a CLI-only install", true],
		["a full install", false],
	])("exits 1 with one line and plays nothing without --ext on %s", async (_, cliOnly) => {
		setCliOnly(cliOnly);
		spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		const played: Played[] = [];
		const program = new Command().exitOverride();
		register(program, {
			play: async (script, opts) => void played.push({ script, ext: opts.ext }),
		});
		await expect(
			program.parseAsync([name, plan], { from: "user" }),
		).rejects.toThrow("exit 1");
		expect(errors).toEqual([unavailable(name)]);
		expect(played).toHaveLength(0);
	});

	test("passes ext to the player and prints no notice with --ext", async () => {
		const played = await drive(register, [name, "--ext", plan]);
		expect(errors).toEqual([]);
		expect(played[0]?.ext).toBe(true);
	});
});

describe("demo without a play path", () => {
	test("--verify prints no refusal and does not call play", async () => {
		const logs: string[] = [];
		spyOn(console, "log").mockImplementation((line: unknown) => {
			logs.push(String(line));
		});
		const played = await drive(registerDemo, [
			"demo",
			"--verify",
			join(dir, "missing.md"),
		]);
		expect(played).toHaveLength(0);
		expect(errors).not.toContain(unavailable("demo"));
		expect(logs.join("")).toContain("plan-unreadable");
	});

	test("a missing script path exits 1 with the path error and no refusal", async () => {
		spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		await expect(drive(registerDemo, ["demo"])).rejects.toThrow("exit 1");
		expect(
			errors.some((line) => line.includes("a script path is required")),
		).toBe(true);
		expect(errors).not.toContain(unavailable("demo"));
	});
});
