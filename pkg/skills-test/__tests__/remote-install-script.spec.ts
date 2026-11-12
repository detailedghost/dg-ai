import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installLocal } from "../../../scripts/remote-install";
import { makeTempDir, removeTempDirs } from "./test-support";

afterEach(removeTempDirs);

const BASE = "1.0.0-local";

function sandbox() {
	const root = makeTempDir("dg-remote-install-script-");
	const source = makeTempDir("dg-remote-install-source-");
	writeFileSync(join(source, "dg.js"), "");
	mkdirSync(join(root, "lib", "0.0.1"), { recursive: true });
	symlinkSync("0.0.1", join(root, "lib", "current"));
	return { root, source };
}

describe("installLocal", () => {
	test("two simultaneous installs leave lib/current on an existing directory", async () => {
		const { root, source } = sandbox();

		await Promise.all([
			installLocal(root, source, BASE, `${BASE}.1.1`),
			installLocal(root, source, BASE, `${BASE}.2.2`),
		]);

		const target = readlinkSync(join(root, "lib", "current"));
		expect(existsSync(join(root, "lib", target, "dg.js"))).toBe(true);
		expect(readdirSync(join(root, "lib")).sort()).toEqual(["0.0.1", `${BASE}.1.1`, `${BASE}.2.2`, "current"]);
	});

	test("keeps the version it replaces and removes older local builds", async () => {
		const { root, source } = sandbox();
		mkdirSync(join(root, "lib", `${BASE}.0.0`));

		await installLocal(root, source, BASE, `${BASE}.1.1`);
		await installLocal(root, source, BASE, `${BASE}.2.2`);

		expect(readdirSync(join(root, "lib")).sort()).toEqual(["0.0.1", `${BASE}.1.1`, `${BASE}.2.2`, "current"]);
	});

	test("does not remove another run's staging directory", async () => {
		const { root, source } = sandbox();
		const foreign = join(root, "lib", `install-${BASE}.9.9-abc`);
		mkdirSync(foreign);

		await installLocal(root, source, BASE, `${BASE}.1.1`);

		expect(existsSync(foreign)).toBe(true);
	});
});
