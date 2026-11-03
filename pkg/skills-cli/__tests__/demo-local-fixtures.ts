import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { LaunchPick } from "../src/pw/core/browser";

export type Spawned = { argv: string[]; logPath: string };

export type FakeLocalDeps = {
	isWSL(): boolean;
	windowsBrowserPresent(): boolean;
	pickLaunch(): LaunchPick;
	spawn(argv: string[], logPath: string): { pid: number };
};

export type DemoWorld = {
	home: string;
	stateDir: string;
	demosDir: string;
	planPath: string;
	spawned: Spawned[];
	localDeps(over?: Partial<FakeLocalDeps>): FakeLocalDeps;
	drive(
		register: (program: Command, deps?: never) => void,
		args: string[],
		deps?: unknown,
	): Promise<{ code: number; out: string; err: string }>;
	cleanup(): void;
};

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

export const TWO_STEP_PLAN = {
	title: "Local Player Tour",
	startUrl: "https://example.test/",
	steps: [
		{ title: "First stop", body: "hello", selector: "#one" },
		{ title: "Second stop", body: "world", selector: "#two" },
	],
};

export function demoWorld(): DemoWorld {
	const home = mkdtempSync(join(tmpdir(), "dg-demo-local-"));
	const stateDir = join(home, "state");
	mkdirSync(stateDir, { recursive: true });
	const previous = {
		HOME: process.env.HOME,
		DG_HOME: process.env.DG_HOME,
	};
	process.env.HOME = home;
	process.env.DG_HOME = stateDir;
	const planPath = join(home, "tour.json");
	writeFileSync(planPath, JSON.stringify(TWO_STEP_PLAN));
	const spawned: Spawned[] = [];

	return {
		home,
		stateDir,
		demosDir: join(stateDir, "demos"),
		planPath,
		spawned,
		localDeps(over = {}) {
			return {
				isWSL: () => false,
				windowsBrowserPresent: () => false,
				pickLaunch: () => ({ channel: "chrome" }),
				spawn: (argv, logPath) => {
					spawned.push({ argv, logPath });
					return { pid: 4242 };
				},
				...over,
			};
		},
		async drive(register, args, deps) {
			const out: string[] = [];
			const err: string[] = [];
			const realLog = console.log;
			const realError = console.error;
			const realExit = process.exit;
			const realExitCode = process.exitCode;
			console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
			console.error = (...parts: unknown[]) => void err.push(parts.join(" "));
			process.exit = ((code?: number) => {
				throw new ExitSignal(code ?? 0);
			}) as typeof process.exit;
			process.exitCode = 0;
			let code = 0;
			try {
				const program = new Command().exitOverride();
				(register as (p: Command, d?: unknown) => void)(program, deps);
				await program.parseAsync(args, { from: "user" });
				code = Number(process.exitCode ?? 0);
			} catch (error) {
				if (error instanceof ExitSignal) code = error.code;
				else throw error;
			} finally {
				console.log = realLog;
				console.error = realError;
				process.exit = realExit;
				process.exitCode = realExitCode ?? 0;
			}
			return { code, out: out.join("\n"), err: err.join("\n") };
		},
		cleanup() {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(home, { recursive: true, force: true });
		},
	};
}
