import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { removeBootstrapDirs, removeBootstrapFixtures, runBootstrap } from "./bootstrap-fixtures";
import {
	assertExtensionInstalled,
	cliOnlyMarker,
	EXT_ONLY_COMMANDS,
	extensionRequiredMessage,
	guardExtensionCommands,
	isCliOnly,
	registerRequireExtension,
	setCliOnly,
} from "../src/utils/cli-only";
import { registerDemo } from "../src/commands/demo";
import { addExtOption } from "../src/utils/ext-flag";
import { cliBinDir, cliDest } from "../src/utils/lib";

const skillsDir = new URL("../../../plugins/dg/skills/", import.meta.url).pathname;
const bootstrap = new URL("../bootstrap.sh", import.meta.url).pathname;

let home: string;
let previousDgHome: string | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-cli-only-"));
	previousDgHome = process.env.DG_HOME;
	process.env.DG_HOME = join(home, ".dg");
});

afterEach(() => {
	if (previousDgHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = previousDgHome;
	rmSync(home, { recursive: true, force: true });
});

describe("cli-only marker", () => {
	test("is absent until a CLI-only install writes it", () => {
		expect(isCliOnly()).toBe(false);
		setCliOnly(true);
		expect(isCliOnly()).toBe(true);
		expect(cliOnlyMarker()).toBe(join(home, ".dg", "cli-only"));
	});

	test("is removed by a full install", () => {
		setCliOnly(true);
		setCliOnly(false);
		expect(isCliOnly()).toBe(false);
	});
});

describe("extension guard", () => {
	const buildProgram = () => {
		const calls: string[] = [];
		const program = new Command().exitOverride();
		program.enablePositionalOptions();
		guardExtensionCommands(program);
		registerRequireExtension(program);
		for (const name of [
			...EXT_ONLY_COMMANDS,
			"batch-open",
			"demo",
			"rerun",
			"inbox",
			"channel-review",
		]) {
			const command = addExtOption(program.command(name));
			command.command("nested").action(() => void calls.push(`${name} nested`));
			command.action(() => void calls.push(name));
		}
		return { program, calls };
	};

	test("allows every command on a full install", async () => {
		const { program, calls } = buildProgram();
		await program.parseAsync(["demo"], { from: "user" });
		await program.parseAsync(["inbox"], { from: "user" });
		expect(calls).toEqual(["demo", "inbox"]);
	});

	test("blocks extension commands and nested subcommands in a CLI-only install", async () => {
		setCliOnly(true);
		const { program, calls } = buildProgram();
		await expect(
			program.parseAsync(["launch"], { from: "user" }),
		).rejects.toThrow(extensionRequiredMessage("dg-skills launch"));
		await expect(
			program.parseAsync(["batch-open", "--ext"], { from: "user" }),
		).rejects.toThrow(extensionRequiredMessage("dg-skills batch-open"));
		await expect(
			program.parseAsync(["rerun", "--ext"], { from: "user" }),
		).rejects.toThrow("dg-skills rerun needs the dg-ai-extension");
		expect(calls).toEqual([]);
	});

	test("blocks demo --ext in a CLI-only install", async () => {
		setCliOnly(true);
		const program = new Command().exitOverride();
		program.enablePositionalOptions();
		guardExtensionCommands(program);
		registerDemo(program, { play: async () => {} });
		await expect(
			program.parseAsync(["demo", "--ext", "plan.md"], { from: "user" }),
		).rejects.toThrow(extensionRequiredMessage("dg-skills demo"));
	});

	test("blocks a nested subcommand when --ext is parsed on its parent", async () => {
		setCliOnly(true);
		const { program, calls } = buildProgram();
		await expect(
			program.parseAsync(["rerun", "--ext", "nested"], { from: "user" }),
		).rejects.toThrow(extensionRequiredMessage("dg-skills rerun"));
		expect(calls).toEqual([]);
	});

	test("rejects --ext on a command without the option as an unknown option, not through the guard", async () => {
		setCliOnly(true);
		const { program, calls } = buildProgram();
		program.command("plain").action(() => void calls.push("plain"));
		let thrown: unknown;
		try {
			await program.parseAsync(["plain", "--ext"], { from: "user" });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as { code?: string }).code).toBe(
			"commander.unknownOption",
		);
		expect(String(thrown)).not.toContain("CLI-only install");
		expect(calls).toEqual([]);
	});

	test("lets commands without --ext run in a CLI-only install", async () => {
		setCliOnly(true);
		const { program, calls } = buildProgram();
		await program.parseAsync(["batch-open"], { from: "user" });
		await program.parseAsync(["demo"], { from: "user" });
		await program.parseAsync(["rerun"], { from: "user" });
		expect(calls).toEqual(["batch-open", "demo", "rerun"]);
	});

	test("does not trip on an --ext that is a positional argument after the separator", async () => {
		setCliOnly(true);
		const { program } = buildProgram();
		const seen: { note: string[]; ext?: boolean }[] = [];
		addExtOption(program.command("jot"))
			.argument("[note...]")
			.action((note: string[], opts: { ext?: boolean }) => {
				seen.push({ note, ext: opts.ext });
			});
		await program.parseAsync(["jot", "--", "--ext"], { from: "user" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.note).toEqual(["--ext"]);
		expect(seen[0]?.ext).toBeFalsy();
	});

	test("keeps CLI commands working in a CLI-only install", async () => {
		setCliOnly(true);
		const { program, calls } = buildProgram();
		await program.parseAsync(["channel-review"], { from: "user" });
		await program.parseAsync(["inbox"], { from: "user" });
		expect(calls).toEqual(["channel-review", "inbox"]);
	});

	test("omits dg-agent from the hint once an agent-only install already placed it", async () => {
		setCliOnly(true);
		expect(extensionRequiredMessage("x")).toContain("the extension, dg-daemon and dg-agent");

		mkdirSync(cliBinDir(), { recursive: true });
		writeFileSync(cliDest("dg-agent"), "");

		expect(extensionRequiredMessage("x")).toContain("the extension and dg-daemon");
		expect(extensionRequiredMessage("x")).not.toContain("dg-agent.");
	});

	test("require-extension names the skill and how to add the extension", async () => {
		setCliOnly(true);
		const { program } = buildProgram();
		await expect(
			program.parseAsync(["require-extension", "chat"], { from: "user" }),
		).rejects.toThrow(/The chat skill needs the dg-ai-extension.*Run "dg-skills install"/);
		setCliOnly(false);
		await program.parseAsync(["require-extension", "chat"], { from: "user" });
		expect(() => assertExtensionInstalled("x")).not.toThrow();
	});
});

describe("skill metadata", () => {
	const requiresExtension = (name: string): boolean =>
		/^requires:.*extension/m.test(readFileSync(join(skillsDir, name, "SKILL.md"), "utf8"));

	test("marks the skills that need the extension", () => {
		const names = readdirSync(skillsDir).filter((entry) =>
			existsSync(join(skillsDir, entry, "SKILL.md")),
		);
		expect(names.filter(requiresExtension).sort()).toEqual([]);
	});

	test("guards a dg-skills command for every extension skill that runs one", () => {
		expect([...EXT_ONLY_COMMANDS]).toEqual(["launch"]);
	});

	test("google-sms-cleanup ships with the CLI skills and does not require the extension", () => {
		const names = readdirSync(skillsDir).filter((entry) =>
			existsSync(join(skillsDir, entry, "SKILL.md")),
		);
		expect(names).toContain("google-sms-cleanup");
		expect(requiresExtension("google-sms-cleanup")).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("bootstrap.sh flag", () => {
	afterEach(removeBootstrapDirs);
	afterAll(removeBootstrapFixtures);

	const run = async (args: string[], env: Record<string, string> = {}, version?: string) => {
		const result = await runBootstrap({ args, env, version });
		return { exitCode: result.code, calls: result.installCall ?? "" };
	};

	test("runs the full install by default", async () => {
		expect(await run([])).toEqual({ exitCode: 0, calls: "dg-skills install" });
	});

	test("passes --cli-only to install when given the flag", async () => {
		expect(await run(["--cli-only"])).toEqual({ exitCode: 0, calls: "dg-skills install --cli-only" });
	});

	test("passes --cli-only to install when DG_CLI_ONLY is 1", async () => {
		expect(await run([], { DG_CLI_ONLY: "1" })).toEqual({ exitCode: 0, calls: "dg-skills install --cli-only" });
	});

	test("passes --agent-only to install when given the flag", async () => {
		expect(await run(["--agent-only"])).toEqual({ exitCode: 0, calls: "dg-skills install --agent-only" });
	});

	test("passes --agent-only to install when DG_AGENT_ONLY is 1", async () => {
		expect(await run([], { DG_AGENT_ONLY: "1" })).toEqual({ exitCode: 0, calls: "dg-skills install --agent-only" });
	});

	test("refuses to combine --cli-only and --agent-only, before any download", async () => {
		const result = await runBootstrap({ args: ["--cli-only", "--agent-only"] });

		expect(result.code).not.toBe(0);
		expect(result.installCall).toBeUndefined();
		expect(result.requests).toEqual([]);
	});

	test("passes --version to install when given the flag", async () => {
		expect(await run(["--version", "9.9.9"], {}, "9.9.9")).toEqual({
			exitCode: 0,
			calls: "dg-skills install --version 9.9.9",
		});
	});

	test("passes --version to install when DG_VERSION is set", async () => {
		expect(await run([], { DG_VERSION: "9.9.9" }, "9.9.9")).toEqual({
			exitCode: 0,
			calls: "dg-skills install --version 9.9.9",
		});
	});

	test("combines --version with --cli-only", async () => {
		expect(await run(["--cli-only", "--version", "9.9.9"], {}, "9.9.9")).toEqual({
			exitCode: 0,
			calls: "dg-skills install --cli-only --version 9.9.9",
		});
	});

	test("replaces a busy compiled binary with the shim by rename instead of writing over it", async () => {
		let before = 0;
		const result = await runBootstrap({
			seed: (root) => {
				mkdirSync(join(root, "bin"), { recursive: true });
				writeFileSync(join(root, "bin", "dg-skills"), "old");
				before = statSync(join(root, "bin", "dg-skills")).ino;
			},
		});
		const dest = join(result.root, "bin", "dg-skills");

		expect(result.code, result.stderr).toBe(0);
		expect(readFileSync(dest, "utf8")).toContain("lib/current/dg.js");
		expect(statSync(dest).ino).not.toBe(before);
		expect(statSync(dest).mode & 0o777).toBe(0o755);
		expect(readdirSync(join(result.root, "bin")).filter((f) => f.startsWith("."))).toEqual([]);
	});

	test("fails before any asset download when the pinned version matches no release", async () => {
		const result = await runBootstrap({ args: ["--version", "1.0.1"] });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no release named v1.0.1 found");
		expect(result.requests.every((url) => url.includes("/releases?"))).toBe(true);
		expect(result.installCall).toBeUndefined();
	});
});
