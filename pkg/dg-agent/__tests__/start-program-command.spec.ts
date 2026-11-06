import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProgramName } from "@dg/common/node/program";
import { cmdStart } from "../src/start";

class SpawnCaptured extends Error {}

describe("dg-agent start in bundle mode", () => {
	let dgHome: string;
	const saved: Record<string, string | undefined> = {};

	beforeAll(() => {
		dgHome = mkdtempSync(join(tmpdir(), "dg-start-bundle-"));
		for (const key of ["DG_HOME", "DG_KEY_SOURCE"]) saved[key] = process.env[key];
		process.env.DG_HOME = dgHome;
		process.env.DG_KEY_SOURCE = "file";
		setProgramName("dg-agent");
	});

	afterAll(() => {
		setProgramName(undefined);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dgHome, { recursive: true, force: true });
	});

	it("spawns [bun, dg.js, dg-daemon, serve] when the daemon is not live", async () => {
		const spawned: { command: string; args: string[] }[] = [];
		const spawn = (command: string, args: string[]) => {
			spawned.push({ command, args });
			throw new SpawnCaptured("daemon spawn captured");
		};
		await expect(cmdStart({ role: "agent" }, { spawn } as never)).rejects.toBeInstanceOf(
			SpawnCaptured,
		);
		expect(spawned).toHaveLength(1);
		const { command, args } = spawned[0];
		expect([command, ...args]).toEqual([process.execPath, Bun.main, "dg-daemon", "serve"]);
	});
});
