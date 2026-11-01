import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { DOCTOR_REGISTRY } from "../../src/doctor/registry";
import type { DoctorCheck, DoctorContext } from "../../src/doctor/types";
import type { SystemChannel } from "../../src/pw/core/browser";
import { markerPath } from "../../src/pw/core/downloaded";
import {
	browserPresent,
	createBrowserCheck,
	pwChecks,
	pwCodeChecks,
} from "../../src/pw/doctor";
import { checksOf, doctorWorld } from "../doctor-fixtures";

const INSTALL_FIX = "dg-skills pw install-browser";

let dir: string;
let world: ReturnType<typeof doctorWorld>;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "pw-doctor-"));
	world = doctorWorld();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	world.cleanup();
});

function context(): DoctorContext {
	return {
		home: dir,
		env: {},
		paths: resolveDgPaths({ homeDir: dir, env: { DG_HOME: dir } }),
		installedVersion: "0.0.0",
		memo: (_key, make) => make(),
	};
}

function systemOnly(...present: SystemChannel[]) {
	return (channel: SystemChannel) => present.includes(channel);
}

function recordDownload(version: string): void {
	const browsers = path.join(dir, "browsers");
	const executablePath = path.join(browsers, "chromium", "chrome");
	mkdirSync(path.dirname(executablePath), { recursive: true });
	writeFileSync(executablePath, "");
	writeFileSync(
		markerPath(browsers),
		JSON.stringify({ version, executablePath }),
	);
}

describe("pwChecks browser check", () => {
	test("reports system chrome in one ok line", async () => {
		const result = await createBrowserCheck(systemOnly("chrome")).run(
			context(),
		);
		expect(result.status).toBe("ok");
		expect(result.detail).toBe("browser: chrome (system)");
	});

	test("reports system msedge when chrome is absent", async () => {
		const result = await createBrowserCheck(systemOnly("msedge")).run(
			context(),
		);
		expect(result.status).toBe("ok");
		expect(result.detail).toBe("browser: msedge (system)");
	});

	test("prefers chrome when both system browsers exist", async () => {
		const result = await createBrowserCheck(systemOnly("chrome", "msedge")).run(
			context(),
		);
		expect(result.detail).toBe("browser: chrome (system)");
	});

	test("reports a downloaded chromium as ok with its version", async () => {
		recordDownload("131.0.1");
		const result = await createBrowserCheck(systemOnly()).run(context());
		expect(result.status).toBe("ok");
		expect(result.detail).toContain("chromium");
		expect(result.detail).toContain("131.0.1");
		expect(result.detail).toContain("downloaded");
		expect(result.detail).not.toContain("\n");
	});

	test("warns with the install-browser fix when no browser exists", async () => {
		const result = await createBrowserCheck(systemOnly()).run(context());
		expect(result.status).toBe("warn");
		expect(result.fix).toContain(INSTALL_FIX);
		expect(result.detail).not.toContain("\n");
	});

	test("a marker whose executable is gone counts as no browser", async () => {
		recordDownload("131.0.1");
		rmSync(path.join(dir, "browsers", "chromium"), { recursive: true });
		const result = await createBrowserCheck(systemOnly()).run(context());
		expect(result.status).toBe("warn");
	});
});

describe("pwChecks list", () => {
	test("covers skill files, browser, scratch root, state root and the allow rule", () => {
		const ids = pwChecks.map((check) => check.id);
		expect(ids).toContain("skill-files");
		expect(ids).toContain("browser");
		expect(ids).toContain("allow-rule");
		expect(ids.some((id) => /scratch/.test(id))).toBe(true);
		expect(ids.some((id) => /state/.test(id))).toBe(true);
	});

	test("has unique check ids", () => {
		const ids = pwChecks.map((check) => check.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("pwCodeChecks list", () => {
	test("covers skill files and a no-allow-rule warning, and never the pw allow rule", () => {
		const ids = pwCodeChecks.map((check) => check.id);
		expect(ids).toContain("skill-files");
		expect(ids).not.toContain("allow-rule");
		expect(ids.length).toBe(2);
	});
});

describe("doctor registry rows", () => {
	test("registers pw and pw-code", () => {
		expect(DOCTOR_REGISTRY["pw"]).toBe(pwChecks);
		expect(DOCTOR_REGISTRY["pw-code"]).toBe(pwCodeChecks);
	});
});

function noRuleCheck(): DoctorCheck {
	const found = pwCodeChecks.find((check) => check.id !== "skill-files");
	if (!found) throw new Error("pwCodeChecks has no allow-rule guard");
	return found;
}

describe("doctor pw-code allow-rule guard", () => {
	test("is ok when settings.json has no pw-code rule", async () => {
		world.healthy([]);
		const { report } = await world.report(["pw-code"]);
		const guard = checksOf(report, "pw-code").find(
			(check) => check.id === noRuleCheck().id,
		);
		expect(guard?.status).toBe("ok");
	});

	test("warns when an allow rule covers pw-code", async () => {
		world.healthy(["pw-code"]);
		const { run, report } = await world.report(["pw-code"]);
		const guard = checksOf(report, "pw-code").find(
			(check) => check.id === noRuleCheck().id,
		);
		expect(guard?.status).toBe("warn");
		expect(guard?.fix).not.toBeNull();
		expect(guard?.detail).toContain("pw-code");
		expect(run.exitCode).toBe(0);
	});

	test("warns when the wildcard dg-skills rule covers pw-code", async () => {
		world.healthy([]);
		writeFileSync(
			path.join(world.home, ".claude", "settings.json"),
			JSON.stringify({
				permissions: { allow: ["Bash(~/.dg/bin/dg-skills:*)"] },
			}),
		);
		const { report } = await world.report(["pw-code"]);
		const guard = checksOf(report, "pw-code").find(
			(check) => check.id === noRuleCheck().id,
		);
		expect(guard?.status).toBe("warn");
	});

	test.each(["Bash", "Bash(*)"])(
		"warns when the unrestricted %s rule covers pw-code",
		async (rule) => {
			world.healthy([]);
			writeFileSync(
				path.join(world.home, ".claude", "settings.json"),
				JSON.stringify({ permissions: { allow: [rule] } }),
			);
			const { report } = await world.report(["pw-code"]);
			const guard = checksOf(report, "pw-code").find(
				(check) => check.id === noRuleCheck().id,
			);
			expect(guard?.status).toBe("warn");
			expect(guard?.fix).toContain("Bash(*)");
		},
	);

	test("a pw allow rule alone does not trigger the pw-code warning", async () => {
		world.healthy(["pw"]);
		const { report } = await world.report(["pw-code"]);
		const guard = checksOf(report, "pw-code").find(
			(check) => check.id === noRuleCheck().id,
		);
		expect(guard?.status).toBe("ok");
	});
});

describe("browserPresent", () => {
	const deps = (
		wsl: boolean,
		linux: SystemChannel[],
		windows: SystemChannel[],
	) => ({
		isWSL: () => wsl,
		system: (channel: SystemChannel) => linux.includes(channel),
		windows: (channel: SystemChannel) => windows.includes(channel),
	});

	test("finds a Windows browser on WSL when Linux has none", () => {
		expect(browserPresent("chrome", deps(true, [], ["chrome"]))).toBe(true);
		expect(browserPresent("msedge", deps(true, [], ["chrome"]))).toBe(false);
	});

	test("ignores Windows browsers outside WSL", () => {
		expect(browserPresent("chrome", deps(false, [], ["chrome"]))).toBe(false);
		expect(browserPresent("chrome", deps(false, ["chrome"], []))).toBe(true);
	});
});

describe("doctor pw end to end", () => {
	test("reports the browser line and the allow rule for pw", async () => {
		world.healthy(["pw"]);
		const { run, report } = await world.report(["pw"]);
		expect(run.exitCode).toBe(0);
		const checks = checksOf(report, "pw");
		const browser = checks.find((check) => check.id === "browser");
		expect(browser?.detail.startsWith("browser: ")).toBe(true);
		expect(browser?.detail).not.toContain("\n");
		expect(checks.find((check) => check.id === "allow-rule")?.status).toBe(
			"ok",
		);
	});
});
