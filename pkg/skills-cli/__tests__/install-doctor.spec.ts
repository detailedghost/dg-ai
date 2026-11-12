import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext } from "../src/doctor/runner";
import { sharedChecks } from "../src/doctor/shared";
import { fakeBunScript, scratch, type Scratch } from "./runtime-bundle-fixtures";

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

function installBundle(version: string): void {
	mkdirSync(join(sandbox.root, "data", "lib", version), { recursive: true });
	symlinkSync(version, join(sandbox.root, "data", "lib", "current"));
}

function installRuntime(script: string): void {
	const dir = join(sandbox.root, "data", "runtime", "bun-v1.4.1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "bun"), script, { mode: 0o755 });
	symlinkSync("bun-v1.4.1", join(sandbox.root, "data", "runtime", "current"));
}

describe("shared doctor version-match", () => {
	test("reports the lib/current version instead of the running package version", async () => {
		installBundle("1.27.0");

		const result = await check("version-match").run(contextFor("0.0.0"));

		expect(result.detail).toContain("dg-skills 1.27.0");
	});

	test("falls back to the package version when no bundle is installed", async () => {
		const result = await check("version-match").run(contextFor("0.0.0"));

		expect(result.detail).toContain("dg-skills 0.0.0");
	});
});

posix("shared doctor runtime-present", () => {
	test("passes without a bundle, since a source checkout needs no bundled runtime", async () => {
		expect((await check("runtime-present").run(contextFor())).status).toBe("ok");
	});

	test("fails when a bundle is installed but runtime/current/bun is missing", async () => {
		installBundle("1.27.0");

		const result = await check("runtime-present").run(contextFor());

		expect(result.status).toBe("fail");
		expect(result.detail).toContain("is missing");
	});

	test("fails when the runtime does not run --version", async () => {
		installBundle("1.27.0");
		installRuntime(fakeBunScript("", 1));

		expect((await check("runtime-present").run(contextFor())).status).toBe("fail");
	});

	test("passes when the runtime runs --version", async () => {
		installBundle("1.27.0");
		installRuntime(fakeBunScript("1.4.1"));

		const result = await check("runtime-present").run(contextFor());

		expect(result.status).toBe("ok");
		expect(result.detail).toContain("bun 1.4.1");
	});
});
