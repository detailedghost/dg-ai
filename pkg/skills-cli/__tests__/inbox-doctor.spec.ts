import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext } from "../src/doctor/runner";
import { inboxChecks, protonTransportCheck } from "../src/inbox/doctor";
import { protonProfilePaths } from "../src/inbox/proton-pw";
import { doctorWorld } from "./doctor-fixtures";

const SIGN_IN_COMMAND = "dg-skills inbox proton sign-in";

let world: ReturnType<typeof doctorWorld>;
let dgHome: string;

beforeEach(() => {
	world = doctorWorld();
	dgHome = join(world.home, ".dg");
	mkdirSync(dgHome, { recursive: true });
});

afterEach(() => world.cleanup());

function context() {
	return createContext({
		home: world.home,
		env: world.env({ DG_HOME: dgHome }),
	});
}

function markSignedIn(): void {
	const { markerPath } = protonProfilePaths(dgHome);
	mkdirSync(join(markerPath, ".."), { recursive: true });
	writeFileSync(markerPath, JSON.stringify({ signedInAt: "2026-11-01T00:00:00Z" }));
}

describe("inbox doctor protonTransportCheck", () => {
	test("is part of the inbox checks", () => {
		expect(inboxChecks).toContain(protonTransportCheck);
	});

	test("reports the pw profile as signed out when the marker is missing", async () => {
		const result = await protonTransportCheck.run(context());
		expect(result.detail).toContain("pw profile");
		expect(result.detail).toContain("--ext");
		expect(result.detail).toMatch(/signed out|not signed in/i);
		expect(`${result.detail} ${result.fix ?? ""}`).toContain(SIGN_IN_COMMAND);
		expect(result.status).not.toBe("ok");
	});

	test("reports the pw profile as signed in when the marker exists", async () => {
		markSignedIn();
		const result = await protonTransportCheck.run(context());
		expect(result.detail).toContain("pw profile");
		expect(result.detail).toMatch(/signed in/i);
		expect(result.detail).not.toMatch(/not signed in/i);
		expect(result.status).toBe("ok");
	});

	test("names the Windows profile and the last verified date from the marker", async () => {
		const { markerPath } = protonProfilePaths(dgHome);
		mkdirSync(join(markerPath, ".."), { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify({ signedInAt: "2026-10-30T12:00:00Z", profile: "windows" }),
		);
		const result = await protonTransportCheck.run(context());
		expect(result.status).toBe("ok");
		expect(result.detail).toContain(
			"signed in (Windows profile, last verified 2026-10-30)",
		);
	});

	test("names the local profile from the marker", async () => {
		const { markerPath } = protonProfilePaths(dgHome);
		mkdirSync(join(markerPath, ".."), { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify({ signedInAt: "2026-10-30T12:00:00Z", profile: "local" }),
		);
		const result = await protonTransportCheck.run(context());
		expect(result.detail).toContain(
			"signed in (local profile, last verified 2026-10-30)",
		);
	});

	test("never spawns a process while the check runs", async () => {
		markSignedIn();
		const spawn = spyOn(Bun, "spawn");
		const spawnSync = spyOn(Bun, "spawnSync");
		try {
			await protonTransportCheck.run(context());
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
			spawnSync.mockRestore();
		}
	});

	test("its module never imports playwright-core or the pw launcher", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/inbox/doctor.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/node:child_process/);
		expect(source).not.toMatch(/playwright-core/);
		expect(source).not.toMatch(/pw\/core\/launch/);
	});

	test("its module has no static or dynamic import of node:child_process", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/inbox/doctor.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/from\s+["'](?:node:)?child_process["']/);
		expect(source).not.toMatch(/import\s*\(\s*["'](?:node:)?child_process["']/);
		expect(source).not.toMatch(/require\s*\(\s*["'](?:node:)?child_process["']/);
	});
});
