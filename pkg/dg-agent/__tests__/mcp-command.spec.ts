import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	spawnServe,
	waitForHealth,
} from "@dg/dg-daemon/test-harness";
import { main } from "../src/main";
import { runCli } from "./cli-wire";

const realError = console.error;
const realWrite = process.stdout.write;
let errors: string[];
let stdout: string[];
let dgHome: string;
let savedHome: string | undefined;
let savedSession: string | undefined;

describe("dg-agent mcp", () => {
	beforeEach(() => {
		errors = [];
		stdout = [];
		console.error = (...parts: unknown[]) => {
			errors.push(parts.join(" "));
		};
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		dgHome = mkdtempSync(join(tmpdir(), "dg-agent-mcp-"));
		savedHome = process.env.DG_HOME;
		savedSession = process.env.DG_SESSION_ID;
		process.env.DG_HOME = dgHome;
		delete process.env.DG_SESSION_ID;
	});

	afterEach(() => {
		console.error = realError;
		process.stdout.write = realWrite;
		if (savedHome === undefined) delete process.env.DG_HOME;
		else process.env.DG_HOME = savedHome;
		if (savedSession !== undefined) process.env.DG_SESSION_ID = savedSession;
		rmSync(dgHome, { recursive: true, force: true });
	});

	it("exits 1 with the session error text and keeps stdout empty when no session resolves", async () => {
		const code = await main(["mcp"]);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("no live dg-daemon pid file was found");
		expect(stdout).toEqual([]);
	});

	it("exits 1 for an unknown --session value", async () => {
		const code = await main(["mcp", "--session", "nope"]);
		expect(code).toBe(1);
		expect(stdout).toEqual([]);
	});
});

describe("dg-agent mcp session token", () => {
	let home: string;
	let cwd: string;

	afterEach(() => {
		killDaemonByPidFile(home);
		cleanupDgHome(home);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("never prints the session token when the server starts and stdin closes", async () => {
		home = freshDgHome();
		cwd = mkdtempSync(join(tmpdir(), "dg-agent-mcp-cwd-"));
		const port = allocatePort();
		spawnServe(home, port);
		await waitForHealth(port);
		const session = await registerSession(port, { cwd });
		const result = await runCli(home, port, ["mcp", "--session", session.sessionId], {}, { cwd, stdin: new Uint8Array() });
		expect(result.exitCode).toBe(0);
		expect(session.token.length).toBeGreaterThan(0);
		expect(result.stdout).not.toContain(session.token);
		expect(result.stderr).not.toContain(session.token);
	});

	it("never prints the session token when the session does not match", async () => {
		home = freshDgHome();
		cwd = mkdtempSync(join(tmpdir(), "dg-agent-mcp-cwd-"));
		const port = allocatePort();
		spawnServe(home, port);
		await waitForHealth(port);
		const session = await registerSession(port, { cwd });
		const result = await runCli(home, port, ["mcp", "--session", "missing"], {}, { cwd });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain(session.token);
	});
});
