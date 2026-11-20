import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "../src/errors";
import {
	selectSoleSession,
	sessionsForCwd,
	type SessionTokenRecord,
} from "../src/node/session-tokens";

const dirs: string[] = [];

function freshDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dg-session-tokens-")));
	dirs.push(dir);
	return dir;
}

const record = (sessionId: string, cwd: string): SessionTokenRecord => ({
	sessionId,
	token: `fake-token-${sessionId}`,
	cwd,
	agentIdentity: "agent",
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("selectSoleSession messages", () => {
	it("tells the user to run dg-agent start when no session matches the cwd", () => {
		const cwd = freshDir();
		let caught: unknown;
		try {
			selectSoleSession([], cwd);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DgCliError);
		expect((caught as Error).message).toContain("dg-agent start");
	});

	it("tells the user to start a session when only other directories have one", () => {
		const cwd = freshDir();
		expect(() => selectSoleSession([record("a", freshDir())], cwd)).toThrow(
			/dg-agent start/,
		);
	});

	it("lists both session ids and names --session and DG_SESSION_ID on two matches", () => {
		const cwd = freshDir();
		let message = "";
		try {
			selectSoleSession([record("alpha", cwd), record("beta", cwd)], cwd);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("--session");
		expect(message).toContain("DG_SESSION_ID");
		expect(message).toContain("alpha");
		expect(message).toContain("beta");
	});

	it("returns the only matching session", () => {
		const cwd = freshDir();
		expect(selectSoleSession([record("a", cwd), record("b", freshDir())], cwd).sessionId).toBe("a");
	});
});

describe("sessionsForCwd", () => {
	it("keeps only records whose real path is the cwd", () => {
		const cwd = freshDir();
		const nested = join(cwd, "nested");
		mkdirSync(nested);
		const matches = sessionsForCwd(
			[record("a", cwd), record("b", nested), record("c", join(cwd, "gone"))],
			cwd,
		);
		expect(matches.map((match) => match.sessionId)).toEqual(["a"]);
	});
});
