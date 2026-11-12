import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG_ROOT = new URL("..", import.meta.url).pathname;
const SRC = (file: string) =>
	new URL(`../src/${file}`, import.meta.url).pathname;
const RESULT_TAG = "@@EXT_RESULT@@";

export interface ExtCommandRun {
	stdout: string;
	stderr: string;
	opened: string[];
	detectCalls: number;
	exitCode: number;
	error: string | null;
}

export interface ExtCommandWorld {
	home: string;
	run(args: string[]): Promise<ExtCommandRun>;
	cleanup(): void;
}

export function extCommandWorld(options: {
	cliOnly: boolean;
}): ExtCommandWorld {
	const home = mkdtempSync(join(tmpdir(), "dg-ext-command-"));
	const dgHome = join(home, ".dg");
	mkdirSync(join(dgHome, "config"), { recursive: true });
	if (options.cliOnly) writeFileSync(join(dgHome, "config", "cli-only"), "");

	const script = (args: string[]) => `
import { mock } from "bun:test";
import * as node from "@dg/common/node";
import * as detect from ${JSON.stringify(SRC("utils/detect.ts"))};
import { Command } from "commander";
const opened = [];
let detectCalls = 0;
mock.module("@dg/common/node", () => ({
  ...node,
  isWSL: () => false,
  run: () => { throw new Error("run is not allowed in tests"); },
  tryOpen: async (url) => { opened.push(url); return true; },
}));
mock.module(${JSON.stringify(SRC("utils/detect.ts"))}, () => ({
  ...detect,
  detectBrowsers: () => {
    detectCalls++;
    return [{ name: "Brave", version: "1.0", exe: "C:\\\\brave.exe", key: "brave", kind: "chromium", launchable: true }];
  },
}));
class ExitSignal extends Error { constructor(code) { super("exit " + code); this.code = code; } }
process.exit = (code) => { throw new ExitSignal(code ?? 0); };
const { guardExtensionCommands } = await import(${JSON.stringify(SRC("utils/cli-only.ts"))});
const { registerBatchOpen } = await import(${JSON.stringify(SRC("commands/batch-open.ts"))});
const { registerLaunch } = await import(${JSON.stringify(SRC("commands/launch.ts"))});
const program = new Command().exitOverride();
program.enablePositionalOptions();
guardExtensionCommands(program);
registerBatchOpen(program);
registerLaunch(program);
let exitCode = 0;
let error = null;
try {
  await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  exitCode = Number(process.exitCode ?? 0);
} catch (e) {
  if (e instanceof ExitSignal) exitCode = e.code;
  else { error = e instanceof Error ? e.message : String(e); exitCode = 1; }
}
console.log(${JSON.stringify(RESULT_TAG)} + JSON.stringify({ opened, detectCalls, exitCode, error }));
`;

	return {
		home,
		async run(args) {
			const child = Bun.spawn([process.execPath, "-e", script(args)], {
				cwd: PKG_ROOT,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					DG_HOME: dgHome,
					LC_ALL: "C",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			const lines = out.split("\n");
			const tagged = lines.find((line) => line.startsWith(RESULT_TAG));
			if (!tagged)
				throw new Error(
					`driver produced no result\nstdout: ${out}\nstderr: ${stderr}`,
				);
			const result = JSON.parse(tagged.slice(RESULT_TAG.length)) as Omit<
				ExtCommandRun,
				"stdout" | "stderr"
			>;
			return {
				...result,
				stdout: lines.filter((line) => !line.startsWith(RESULT_TAG)).join("\n"),
				stderr,
			};
		},
		cleanup() {
			rmSync(home, { recursive: true, force: true });
		},
	};
}
