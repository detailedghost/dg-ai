import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import * as realBootstrap from "../src/server/bootstrap";

let serveOutcome: "serving" | "deferred" = "deferred";

mock.module("../src/server/bootstrap", () => ({
	...realBootstrap,
	cmdServe: async () => serveOutcome,
}));

const { main } = await import("../src/main");

const realExit = process.exit;
const realError = console.error;
let exitCalls: unknown[];
let savedKeySource: string | undefined;
let savedDgHome: string | undefined;
let tempHome: string;

beforeEach(() => {
	exitCalls = [];
	savedKeySource = process.env.DG_KEY_SOURCE;
	process.env.DG_KEY_SOURCE = "file";
	savedDgHome = process.env.DG_HOME;
	tempHome = mkdtempSync(join(tmpdir(), "dg-main-"));
	process.env.DG_HOME = join(tempHome, ".dg");
	process.exit = ((code?: number) => {
		exitCalls.push(code);
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit;
	console.error = () => {};
});

afterEach(() => {
	if (savedKeySource === undefined) delete process.env.DG_KEY_SOURCE;
	else process.env.DG_KEY_SOURCE = savedKeySource;
	if (savedDgHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = savedDgHome;
	rmSync(tempHome, { recursive: true, force: true });
	process.exit = realExit;
	console.error = realError;
});

describe("dg-daemon main", () => {
	it("runs under a temp home", () => {
		expect(resolveDgPaths().legacyHome.startsWith(tempHome)).toBe(true);
	});

	it("returns 1 for an unknown command without calling process.exit", async () => {
		const code = await main(["no-such-command"]);
		expect(code).toBe(1);
		expect(exitCalls).toEqual([]);
	});

	it("returns 0 from serve when the daemon defers to a live rival, without calling process.exit", async () => {
		serveOutcome = "deferred";
		const code = await main(["serve"]);
		expect(code).toBe(0);
		expect(exitCalls).toEqual([]);
	});
});
