import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBundle, run } from "./bundle-fixtures";

function headRevision(): string {
	return Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
}

const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "skills-cli", "package.json"), "utf8")) as {
	version: string;
};

describe("dg.js dispatcher", () => {
	const { bun, entry, lib } = buildBundle();

	test("--version prints one stamped version line and exits 0", () => {
		const result = run(bun, entry, ["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${version}\n`);
		expect(result.stderr).toBe("");
	});

	test("the bridge form dg-skills --version prints the version as its first token, for a 6.3 self-check", () => {
		const result = run(bun, entry, ["dg-skills", "--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim().split(/\s+/)[0]).toBe(version);
	});

	test.each([
		["dg-skills", "dg"],
		["dg-agent", "dg agent"],
		["dg-daemon", "dg daemon"],
	])("the bridge form %s prints a notice that names the %s form", (program, form) => {
		const result = run(bun, entry, [program, "--version"]);
		expect(result.stderr).toBe(`dg: the ${program} command is removed; run ${form} --version\n`);
	});

	test("the bridge form still runs the named program, so stored 6.3 argv keeps working", () => {
		const result = run(bun, entry, ["dg-skills", "stash", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stash");
		expect(result.stderr).toContain("dg stash --help");
	});

	test("the dg program form from a 6.3 dg shim runs dg with no notice", () => {
		const result = run(bun, entry, ["dg", "--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${version}\n`);
		expect(result.stderr).toBe("");
	});

	test("dg words run directly: pw --help matches the skills tree", () => {
		const direct = run(bun, entry, ["pw", "--help"]);
		const grouped = run(bun, entry, ["skills", "pw", "--help"]);
		expect(direct.exitCode).toBe(0);
		expect(direct.stdout).toBe(grouped.stdout);
		expect(direct.stderr).toBe("");
	});

	test("an unknown word exits 1 with the dg unknown-command error", () => {
		const result = run(bun, entry, ["nope"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe('dg: unknown command "nope"; run dg --help\n');
	});

	test("no arguments print the dg usage", () => {
		const result = run(bun, entry, []);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toStartWith("Usage: dg <command>");
	});

	test("build.json keeps the commit as separate metadata", () => {
		const meta = JSON.parse(readFileSync(join(lib, "build.json"), "utf8")) as { sha: string };
		expect(meta.sha).toBe(process.env.DG_BUILD_SHA ?? headRevision());
	});

	test("a name inherited from Object.prototype is not a program", () => {
		for (const name of ["toString", "constructor", "__proto__"]) {
			const result = run(bun, entry, [name]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).not.toContain("is removed");
		}
	});
});
