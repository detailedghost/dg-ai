import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext } from "../src/doctor/runner";
import { sessionCheck } from "../src/doctor/checks";
import { credentialsChecks } from "../src/credentials/doctor";
import { dbChecks } from "../src/db/doctor";
import { doctorWorld } from "./doctor-fixtures";

let world: ReturnType<typeof doctorWorld>;
let originalCwd: string;

beforeEach(() => {
	world = doctorWorld();
	originalCwd = process.cwd();
	process.chdir(world.home);
});

afterEach(() => {
	process.chdir(originalCwd);
	world.cleanup();
});

function writeSession(id: string, cwd = realpathSync(world.home)): void {
	mkdirSync(world.paths.sessionsDir, { recursive: true });
	writeFileSync(
		join(world.paths.sessionsDir, `${id}.json`),
		JSON.stringify({
			sessionId: id,
			token: `fake-token-${id}`,
			cwd,
			agentIdentity: "doctor-test",
		}),
	);
}

const run = (extraEnv: Record<string, string> = {}) =>
	sessionCheck.run(createContext({ home: world.home, env: { ...world.env(), ...extraEnv } }));

describe("sessionCheck", () => {
	test("is ok when exactly one session matches the cwd", async () => {
		writeSession("only");
		expect((await run()).status).toBe("ok");
	});

	test("warns with dg agent start when no session matches", async () => {
		const result = await run();
		expect(result.status).toBe("warn");
		expect(result.fix).toBe("dg agent start");
	});

	test("is ok when DG_SESSION_ID names a live session, even with two cwd matches", async () => {
		writeSession("one");
		writeSession("two");
		expect((await run({ DG_SESSION_ID: "two" })).status).toBe("ok");
	});

	test("warns with dg agent start when DG_SESSION_ID names a session that is not live", async () => {
		writeSession("only");
		const result = await run({ DG_SESSION_ID: "gone" });
		expect(result.status).toBe("warn");
		expect(result.detail).toContain("DG_SESSION_ID");
		expect(result.fix).toBe("dg agent start");
	});

	test("warns with --session when two sessions match", async () => {
		writeSession("one");
		writeSession("two");
		const result = await run();
		expect(result.status).toBe("warn");
		expect(result.fix).toContain("--session");
	});
});

describe("session check registration", () => {
	test.each([
		["credentials", credentialsChecks],
		["db", dbChecks],
	])("%s doctor runs the session check", (_item, checks) => {
		expect(checks).toContain(sessionCheck);
	});
});
