import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
	assertExtensionInstalled,
	cliOnlyMarker,
	EXTENSION_COMMANDS,
	extensionRequiredMessage,
	guardExtensionCommands,
	isCliOnly,
	registerRequireExtension,
	setCliOnly,
} from "../src/utils/cli-only";
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
		for (const name of [...EXTENSION_COMMANDS, "inbox", "channel-review"]) {
			const command = program.command(name);
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
		await expect(program.parseAsync(["batch-open"], { from: "user" })).rejects.toThrow(
			extensionRequiredMessage("dg-skills batch-open"),
		);
		await expect(program.parseAsync(["rerun", "nested"], { from: "user" })).rejects.toThrow(
			'dg-skills rerun needs the dg-ai-extension',
		);
		expect(calls).toEqual([]);
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
		expect(names.filter(requiresExtension).sort()).toEqual([
			"browser",
			"chat",
			"demo",
			"overwatch",
		]);
	});

	test("guards a dg-skills command for every extension skill that runs one", () => {
		expect([...EXTENSION_COMMANDS].sort()).toEqual([
			"batch-open",
			"demo",
			"launch",
			"rerun",
		]);
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
	const run = async (args: string[], env: Record<string, string> = {}) => {
		const bin = join(home, "stub-bin");
		mkdirSync(bin, { recursive: true });
		const os = process.platform === "darwin" ? "macos" : "linux";
		const cpu = process.arch === "arm64" ? "arm64" : "x64";
		const asset = `dg-skills-${os}-${cpu}`;
		writeFileSync(
			join(bin, "curl"),
			`#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  prev="$arg"
done
if [ -z "$out" ]; then
  printf '[{"tag_name":"skills-v9.9.9","assets":[{"browser_download_url":"https://example.test/download/skills-v9.9.9/${asset}"}]}]'
else
  printf '#!/bin/sh\\necho "$@" >> "%s/calls"\\n' "${home}" > "$out"
fi
`,
		);
		chmodSync(join(bin, "curl"), 0o755);
		const child = Bun.spawn(["sh", bootstrap, ...args], {
			env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await child.exited;
		const calls = existsSync(join(home, "calls"))
			? readFileSync(join(home, "calls"), "utf8").trim()
			: "";
		return { exitCode, calls };
	};

	test("runs the full install by default", async () => {
		expect(await run([])).toEqual({ exitCode: 0, calls: "install" });
	});

	test("passes --cli-only to install when given the flag", async () => {
		expect(await run(["--cli-only"])).toEqual({ exitCode: 0, calls: "install --cli-only" });
	});

	test("passes --cli-only to install when DG_CLI_ONLY is 1", async () => {
		expect(await run([], { DG_CLI_ONLY: "1" })).toEqual({
			exitCode: 0,
			calls: "install --cli-only",
		});
	});

	test("passes --agent-only to install when given the flag", async () => {
		expect(await run(["--agent-only"])).toEqual({ exitCode: 0, calls: "install --agent-only" });
	});

	test("passes --agent-only to install when DG_AGENT_ONLY is 1", async () => {
		expect(await run([], { DG_AGENT_ONLY: "1" })).toEqual({
			exitCode: 0,
			calls: "install --agent-only",
		});
	});

	test("refuses to combine --cli-only and --agent-only, before any download", async () => {
		const result = await run(["--cli-only", "--agent-only"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.calls).toBe("");
	});

	test("passes --version to install when given the flag", async () => {
		expect(await run(["--version", "9.9.9"])).toEqual({
			exitCode: 0,
			calls: "install --version 9.9.9",
		});
	});

	test("passes --version to install when DG_VERSION is set", async () => {
		expect(await run([], { DG_VERSION: "9.9.9" })).toEqual({
			exitCode: 0,
			calls: "install --version 9.9.9",
		});
	});

	test("combines --version with --cli-only", async () => {
		expect(await run(["--cli-only", "--version", "9.9.9"])).toEqual({
			exitCode: 0,
			calls: "install --cli-only --version 9.9.9",
		});
	});

	test("delegates through the newest binary even when the pinned version matches no release", async () => {
		const result = await run(["--version", "1.0.0"]);

		expect(result.exitCode).toBe(0);
		expect(result.calls).toBe("install --version 1.0.0");
	});
});
