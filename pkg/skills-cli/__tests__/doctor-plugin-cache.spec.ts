import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorWorld } from "./doctor-fixtures";
import { installChecks } from "../src/install/doctor";
import { createContext } from "../src/doctor/runner";
import { sharedChecks } from "../src/doctor/shared";

let world: ReturnType<typeof doctorWorld>;

beforeEach(() => {
	world = doctorWorld();
});

afterEach(() => world.cleanup());

function writeVersion(name: string, orphanedAt?: number): void {
	const dir = join(world.home, ".claude", "plugins", "cache", "dg-ai", "dg", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "payload.txt"), "x".repeat(2048));
	if (orphanedAt !== undefined) writeFileSync(join(dir, ".orphaned_at"), String(orphanedAt));
}

function writeInstalled(activeVersion: string): void {
	const dir = join(world.home, ".claude", "plugins");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "installed_plugins.json"),
		JSON.stringify({ version: 2, plugins: { "dg@dg-ai": [{ version: activeVersion }] } }),
	);
}

const context = (env: Record<string, string> = {}) =>
	createContext({ home: world.home, env: { HOME: world.home, ...env } });

const cacheCheck = () => {
	const check = installChecks.find((entry) => entry.id === "plugin-cache");
	if (!check) throw new Error("plugin-cache check is not registered");
	return check;
};

const homeCheck = () => {
	const check = sharedChecks.find((entry) => entry.id === "dg-home");
	if (!check) throw new Error("dg-home check is not registered");
	return check;
};

describe("doctor install plugin-cache check", () => {
	test("warns with the stale count, reclaimable size and the install fix", async () => {
		const longAgo = Date.now() - 48 * 60 * 60 * 1000;
		writeVersion("1.20.0", longAgo);
		writeVersion("1.21.0", longAgo);
		writeVersion("1.24.0");
		writeInstalled("1.24.0");
		const result = await cacheCheck().run(context());
		expect(result).toEqual({
			status: "warn",
			detail: "2 stale version(s), 0 MB reclaimable",
			fix: "dg-skills install",
		});
	});

	test("passes when every cached version is active or unknown", async () => {
		writeVersion("1.24.0");
		writeVersion("1.19.0");
		writeInstalled("1.24.0");
		expect((await cacheCheck().run(context())).status).toBe("ok");
	});

	test("passes without a cache", async () => {
		expect((await cacheCheck().run(context())).status).toBe("ok");
	});

	test("passes and says why when installed_plugins.json is unreadable", async () => {
		writeVersion("1.20.0", 1);
		const result = await cacheCheck().run(context());
		expect(result.status).toBe("ok");
		expect(result.detail).toContain("installed_plugins.json unreadable");
	});
});

describe("doctor shared dg-home check", () => {
	test("warns when DG_HOME is set to another directory", async () => {
		const result = await homeCheck().run(context({ DG_HOME: join(world.home, "elsewhere") }));
		expect(result.status).toBe("warn");
		expect(result.detail).toContain(join(world.home, "elsewhere"));
		expect(result.fix).toBe("unset DG_HOME");
	});

	test("passes when DG_HOME is unset", async () => {
		expect(await homeCheck().run(context())).toEqual({ status: "ok", detail: "DG_HOME is unset" });
	});

	test("passes when DG_HOME names the default home", async () => {
		const result = await homeCheck().run(context({ DG_HOME: join(world.home, ".dg") }));
		expect(result).toEqual({ status: "ok", detail: "DG_HOME uses the default state directory" });
	});
});
