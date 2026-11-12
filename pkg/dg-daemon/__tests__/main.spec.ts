import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
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

beforeEach(() => {
	exitCalls = [];
	process.exit = ((code?: number) => {
		exitCalls.push(code);
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit;
	console.error = () => {};
});

afterEach(() => {
	process.exit = realExit;
	console.error = realError;
});

describe("dg-daemon main", () => {
	it("returns 1 for an unknown command without calling process.exit", async () => {
		const code = await main(["no-such-command"]);
		expect(code).toBe(1);
		expect(exitCalls).toEqual([]);
	});

	it("returns 0 from __serve when the daemon defers to a live rival, without calling process.exit", async () => {
		serveOutcome = "deferred";
		const code = await main(["__serve"]);
		expect(code).toBe(0);
		expect(exitCalls).toEqual([]);
	});
});
