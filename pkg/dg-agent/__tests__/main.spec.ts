import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realCommands from "../src/phone/commands";

const phoneRun = mock(async () => {});

mock.module("../src/phone/commands", () => ({
	...realCommands,
	defaultPhoneApi: {
		...realCommands.defaultPhoneApi,
		phoneRun,
		runDeps: () => ({}),
	},
}));

const { main } = await import("../src/main");

const realExit = process.exit;
const realError = console.error;
let exitCalls: unknown[];

beforeEach(() => {
	exitCalls = [];
	process.exit = ((code?: number) => {
		exitCalls.push(code);
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit;
	console.error = () => {};
	phoneRun.mockClear();
});

afterEach(() => {
	process.exit = realExit;
	console.error = realError;
});

describe("dg-agent main", () => {
	it("returns 1 for an unknown command without calling process.exit", async () => {
		const code = await main(["no-such-command"]);
		expect(code).toBe(1);
		expect(exitCalls).toEqual([]);
	});

	it("returns the failure code of a command that throws instead of exiting", async () => {
		const dgHome = mkdtempSync(join(tmpdir(), "dg-agent-main-"));
		const saved = process.env.DG_HOME;
		process.env.DG_HOME = dgHome;
		try {
			const code = await main(["attach"]);
			expect(code).toBe(1);
			expect(exitCalls).toEqual([]);
		} finally {
			if (saved === undefined) delete process.env.DG_HOME;
			else process.env.DG_HOME = saved;
			rmSync(dgHome, { recursive: true, force: true });
		}
	});

	it("returns 0 from the hidden phone __run action without calling process.exit", async () => {
		const code = await main(["phone", "__run"]);
		expect(code).toBe(0);
		expect(phoneRun).toHaveBeenCalledTimes(1);
		expect(exitCalls).toEqual([]);
	});
});
