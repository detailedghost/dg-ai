import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyHomeFixture, perOsPaths, runProgram, fixtureHome, stopFixtureSleepers } from "./layout-fixtures";

setDefaultTimeout(180_000);

const posix = describe.skipIf(process.platform === "win32");

afterEach(() => stopFixtureSleepers());

type Report = { items: { item: string; checks: { id: string; status: string; detail: string; fix: string | null }[] }[] };

posix("dg-skills doctor install on a legacy home", () => {
	test("moves what it can in the preAction and the layout check names phone and ssms as not moved", async () => {
		const home = fixtureHome();
		await legacyHomeFixture(home);
		const paths = perOsPaths(home);
		const legacy = paths.legacyHome;
		mkdirSync(join(legacy, "ssms"), { recursive: true });
		writeFileSync(join(legacy, "ssms", "config.yaml"), "fixture: true\n");

		const run = await runProgram(home, "dg-skills", ["doctor", "install", "--json"]);
		const report = JSON.parse(run.stdout) as Report;
		const layout = report.items.flatMap((item) => item.checks).find((check) => check.id === "layout");

		expect(existsSync(join(paths.daemonDir, "daemon.db"))).toBe(true);
		expect(existsSync(paths.memoryDbPath)).toBe(true);
		expect(existsSync(join(paths.grantsDir, "fixture.json"))).toBe(true);
		expect(existsSync(paths.configPath)).toBe(true);
		for (const name of ["daemon", "grants", "config.json", join("agents", "memory.db")]) {
			expect(existsSync(join(legacy, name))).toBe(false);
		}
		expect(layout?.status).toBe("warn");
		expect(layout?.detail).toContain(`${join(legacy, "phone")} has not moved to ${paths.phoneRoot}; run dg-skills install`);
		expect(layout?.detail).toContain(join(legacy, "ssms"));
		expect(layout?.detail).not.toContain(join(legacy, "daemon"));
	});
});
