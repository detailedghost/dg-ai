import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cliOnlyCheck,
	extensionChecks,
	extOnly,
	extOnlyChecks,
} from "../src/doctor/checks";
import { createContext, formatReport } from "../src/doctor/runner";
import { type DoctorCheck, fail, ok, warn } from "../src/doctor/types";
import { checksOf, doctorWorld } from "./doctor-fixtures";

const PREFIX = "--ext only: ";

let world: ReturnType<typeof doctorWorld>;

beforeEach(() => {
	world = doctorWorld();
	world.installPlugin();
	world.writeSettings(["batch-open", "launch"]);
});

afterEach(() => world.cleanup());

function contextFor(cliOnly: boolean) {
	const dgHome = join(world.home, ".dg");
	mkdirSync(dgHome, { recursive: true });
	if (cliOnly) writeFileSync(join(dgHome, "cli-only"), "");
	return createContext({
		home: world.home,
		env: world.env({ DG_HOME: dgHome }),
	});
}

describe("extOnly", () => {
	test("turns the CLI-only warning into info with the --ext only prefix", async () => {
		const result = await extOnly(cliOnlyCheck).run(contextFor(true));
		expect(result.status).toBe("info");
		expect(result.detail.startsWith(PREFIX)).toBe(true);
	});

	test("turns a fail on a CLI-only home into info", async () => {
		const failing: DoctorCheck = { id: "f", run: () => fail("boom", "fix it") };
		const result = await extOnly(failing).run(contextFor(true));
		expect(result.status).toBe("info");
		expect(result.detail).toBe(`${PREFIX}boom`);
		expect(result.fix).toBeUndefined();
	});

	test("returns the wrapped result unchanged on a full install", async () => {
		const ctx = contextFor(false);
		for (const result of [warn("w", "fix w"), fail("f", "fix f"), ok("fine")]) {
			const check: DoctorCheck = { id: "c", run: () => result };
			expect(await extOnly(check).run(ctx)).toEqual(result);
		}
	});

	test("keeps the wrapped check id", () => {
		expect(extOnly(cliOnlyCheck).id).toBe(cliOnlyCheck.id);
	});

	test("keeps an ok result unchanged on a CLI-only home", async () => {
		const check: DoctorCheck = { id: "c", run: () => ok("fine") };
		expect(await extOnly(check).run(contextFor(true))).toEqual(ok("fine"));
	});

	test("extOnlyChecks wraps every extensionChecks entry in order", () => {
		expect(extOnlyChecks.map((c) => c.id)).toEqual(
			extensionChecks.map((c) => c.id),
		);
	});
});

describe("dg-skills doctor on a CLI-only home", () => {
	const cliOnlyEnv = () => ({ DG_HOME: join(world.home, ".dg") });
	beforeEach(() => {
		mkdirSync(join(world.home, ".dg"), { recursive: true });
		writeFileSync(join(world.home, ".dg", "cli-only"), "");
	});

	test("batch-open exits 0 and prints the info lines", async () => {
		const { run, report } = await world.report(["batch-open"], cliOnlyEnv());
		expect(run.exitCode).toBe(0);
		const infos = checksOf(report, "batch-open").filter(
			(c) => c.status === "info",
		);
		expect(infos.length).toBeGreaterThan(0);
		for (const check of infos)
			expect(check.detail.startsWith(PREFIX)).toBe(true);
	});

	test("batch-open downgrades the extension, daemon and pairing checks to info", async () => {
		const { report } = await world.report(["batch-open"], cliOnlyEnv());
		const checks = checksOf(report, "batch-open");
		for (const id of ["extension-installed", "daemon", "extension-paired"]) {
			const check = checks.find((c) => c.id === id);
			expect(check?.status).toBe("info");
			expect(check?.detail.startsWith(PREFIX)).toBe(true);
		}
		expect(checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(
			false,
		);
		const infoCount = checks.filter((c) => c.status === "info").length;
		expect(formatReport(report)).toContain(`${infoCount} info, 0 to review`);
	});

	test("launch keeps the extension checks and does not downgrade them to info", async () => {
		const { report } = await world.report(["launch"], cliOnlyEnv());
		const checks = checksOf(report, "launch");
		expect(checks.some((c) => c.status === "info")).toBe(false);
		expect(checks.some((c) => c.detail.startsWith(PREFIX))).toBe(false);
		const installed = checks.find((c) => c.id === "extension-installed");
		expect(installed?.status).toBe("warn");
		const daemon = checks.find((c) => c.id === "daemon");
		expect(daemon?.status).toBe("warn");
	});
});
