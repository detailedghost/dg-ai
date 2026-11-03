import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksOf, doctorWorld } from "./doctor-fixtures";

const PREFIX = "--ext only: ";

let world: ReturnType<typeof doctorWorld>;

beforeEach(() => {
	world = doctorWorld();
	world.installPlugin();
	world.writeSettings(["demo"]);
	const dgHome = join(world.home, ".dg");
	mkdirSync(join(dgHome, "data", "browsers"), { recursive: true });
	mkdirSync(join(dgHome, "config"), { recursive: true });
	writeFileSync(join(dgHome, "config", "cli-only"), "");
	writeFileSync(
		join(dgHome, "data", "browsers", "chromium.json"),
		JSON.stringify({ version: "1.0.0", executablePath: process.execPath }),
	);
});
afterEach(() => world.cleanup());

describe("dg-skills doctor demo on a CLI-only home", () => {
	const env = () => ({ DG_HOME: join(world.home, ".dg") });

	test("exits 0 and shows the browser status line", async () => {
		const { run, report } = await world.report(["demo"], env());
		expect(run.exitCode).toBe(0);
		const browser = checksOf(report, "demo").find((c) => c.id === "browser");
		expect(browser?.status).toBe("ok");
		expect(browser?.detail.startsWith("browser:")).toBe(true);
	});

	test("shows the extension checks as --ext only info lines", async () => {
		const { report } = await world.report(["demo"], env());
		const checks = checksOf(report, "demo");
		for (const id of ["extension-installed", "daemon", "extension-paired"]) {
			const check = checks.find((c) => c.id === id);
			expect(check?.status).toBe("info");
			expect(check?.detail.startsWith(PREFIX)).toBe(true);
		}
		expect(checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(false);
	});
});
