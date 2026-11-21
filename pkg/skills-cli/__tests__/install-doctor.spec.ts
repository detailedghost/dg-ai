import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext } from "../src/doctor/runner";
import { sharedChecks } from "../src/doctor/shared";
import { fakeProgramScript, scratch, type Scratch } from "./release-fixtures";

const posix = describe.skipIf(process.platform === "win32");

let sandbox: Scratch;

beforeEach(() => {
	sandbox = scratch("install-doctor");
});

afterEach(() => {
	sandbox.cleanup();
});

function contextFor(installedVersion = "0.0.0") {
	return createContext({
		home: sandbox.directory,
		env: { HOME: sandbox.directory, DG_HOME: sandbox.root },
		installedVersion,
	});
}

function check(id: string) {
	const found = sharedChecks.find((entry) => entry.id === id);
	if (!found) throw new Error(`no shared check ${id}`);
	return found;
}

function installProgram(version: string, script = fakeProgramScript(version)): void {
	const dir = join(sandbox.root, "data", "bin", version);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "dg"), script, { mode: 0o755 });
	symlinkSync(version, join(sandbox.root, "data", "bin", "current"));
}

describe("shared doctor version-match", () => {
	test("reports the bin/current version instead of the running package version", async () => {
		installProgram("1.27.0");

		const result = await check("version-match").run(contextFor("0.0.0"));

		expect(result.detail).toContain("dg 1.27.0");
	});

	test("reports the lib/current version of a 6.3 install when no compiled dg is installed", async () => {
		mkdirSync(join(sandbox.root, "data", "lib", "6.3.1"), { recursive: true });
		symlinkSync("6.3.1", join(sandbox.root, "data", "lib", "current"));

		const result = await check("version-match").run(contextFor("0.0.0"));

		expect(result.detail).toContain("dg 6.3.1");
	});

	test("prefers bin/current over lib/current", async () => {
		mkdirSync(join(sandbox.root, "data", "lib", "6.3.1"), { recursive: true });
		symlinkSync("6.3.1", join(sandbox.root, "data", "lib", "current"));
		installProgram("7.0.0");

		const result = await check("version-match").run(contextFor("0.0.0"));

		expect(result.detail).toContain("dg 7.0.0");
	});

	test("falls back to the package version when nothing is installed", async () => {
		const result = await check("version-match").run(contextFor("0.0.0"));

		expect(result.detail).toContain("dg 0.0.0");
	});
});

posix("shared doctor program-present", () => {
	test("passes without a compiled dg, since a source checkout runs from source", async () => {
		const result = await check("program-present").run(contextFor());

		expect(result.status).toBe("ok");
		expect(result.detail).toBe("no compiled dg installed; running from source");
	});

	test("fails when bin/current is linked but the program is missing", async () => {
		mkdirSync(join(sandbox.root, "data", "bin", "1.27.0"), { recursive: true });
		symlinkSync("1.27.0", join(sandbox.root, "data", "bin", "current"));

		const result = await check("program-present").run(contextFor());

		expect(result.status).toBe("fail");
		expect(result.detail).toContain("is missing");
	});

	test("fails when the program does not run --version", async () => {
		installProgram("1.27.0", fakeProgramScript("", undefined, 1));

		expect((await check("program-present").run(contextFor())).status).toBe("fail");
	});

	test("passes when the program runs --version", async () => {
		installProgram("1.27.0");

		const result = await check("program-present").run(contextFor());

		expect(result.status).toBe("ok");
		expect(result.detail).toContain("dg 1.27.0");
	});

	test("is registered and runtime-present is gone", () => {
		const ids = sharedChecks.map((entry) => entry.id);

		expect(ids).toContain("program-present");
		expect(ids).not.toContain("runtime-present");
	});
});
