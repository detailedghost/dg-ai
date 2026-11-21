import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	LEGACY_PROGRAMS,
	present,
	programRun,
	removeBootstrapDirs,
	removeBootstrapFixtures,
	runBootstrap,
} from "./bootstrap-fixtures";

const posix = describe.skipIf(process.platform === "win32");

afterEach(removeBootstrapDirs);
afterAll(removeBootstrapFixtures);

function seedOldInstall(root: string): void {
	const data = join(root, "data");
	const bin = join(root, "bin");
	mkdirSync(join(data, "runtime", "bun-v1.3.0"), { recursive: true });
	mkdirSync(join(data, "lib", "6.3.0"), { recursive: true });
	writeFileSync(join(data, "runtime", "bun-v1.3.0", "bun"), "bun");
	writeFileSync(join(data, "lib", "6.3.0", "dg.js"), "export {};\n");
	symlinkSync("bun-v1.3.0", join(data, "runtime", "current"));
	symlinkSync("6.3.0", join(data, "lib", "current"));
	mkdirSync(bin, { recursive: true });
	for (const name of ["dg", ...LEGACY_PROGRAMS]) {
		const shim = join(bin, name);
		writeFileSync(
			shim,
			`#!/bin/sh\nexec "${data}/runtime/current/bun" "${data}/lib/current/dg.js" ${name} "$@"\n`,
		);
		chmodSync(shim, 0o755);
		writeFileSync(join(bin, `.${name}.version`), "6.3.0\n");
	}
}

function seedCompiledInstall(root: string, version: string): void {
	const dir = join(root, "data", "bin", version);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "dg"), "#!/bin/sh\necho old\n");
	chmodSync(join(dir, "dg"), 0o755);
	symlinkSync(version, join(root, "data", "bin", "current"));
	mkdirSync(join(root, "bin"), { recursive: true });
	symlinkSync(join(root, "data", "bin", "current", "dg"), join(root, "bin", "dg"));
}

posix("bootstrap.sh compiled install", () => {
	test("leaves no dg-skills, dg-agent or dg-daemon file or version stamp anywhere", async () => {
		const result = await runBootstrap();
		const everything = [
			...readdirSync(join(result.root, "bin")),
			...readdirSync(join(result.root, "data", "bin")),
			...readdirSync(join(result.root, "data", "bin", result.version)),
		];

		expect(result.code, result.stderr).toBe(0);
		for (const name of LEGACY_PROGRAMS)
			expect(everything.some((entry) => entry.includes(name))).toBe(false);
	});

	test("the dg link runs the installed program", async () => {
		const result = await runBootstrap();
		const run = Bun.spawnSync([join(result.root, "bin", "dg"), "--version"], {
			stdout: "pipe",
		});

		expect(run.stdout.toString().split(" ")[0]).toBe(result.version);
		expect(readlinkSync(join(result.root, "bin", "dg"))).toBe(
			join(result.root, "data", "bin", "current", "dg"),
		);
	});

	test("a staged program whose --version fails leaves the old links in place", async () => {
		const result = await runBootstrap({
			assetBroken: true,
			seed: (root) => seedCompiledInstall(root, "1.0.0"),
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("did not run");
		expect(readlinkSync(join(result.root, "data", "bin", "current"))).toBe("1.0.0");
		expect(readlinkSync(join(result.root, "bin", "dg"))).toBe(
			join(result.root, "data", "bin", "current", "dg"),
		);
		expect(readdirSync(join(result.root, "data", "bin")).sort()).toEqual(["1.0.0", "current"]);
		expect(programRun(result.stdout)).toBeUndefined();
	});

	test("a staged program that reports another version leaves the old links in place", async () => {
		const result = await runBootstrap({
			assetVersion: "9.9.9",
			seed: (root) => seedCompiledInstall(root, "1.0.0"),
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("expected 1.27.0");
		expect(readlinkSync(join(result.root, "data", "bin", "current"))).toBe("1.0.0");
		expect(present(join(result.root, "data", "bin", result.version))).toBe(false);
	});

	test("a new release moves bin/current and keeps the old version folder", async () => {
		const result = await runBootstrap({
			seed: (root) => seedCompiledInstall(root, "1.0.0"),
		});

		expect(result.code, result.stderr).toBe(0);
		expect(readlinkSync(join(result.root, "data", "bin", "current"))).toBe(result.version);
		expect(present(join(result.root, "data", "bin", "1.0.0", "dg"))).toBe(true);
		expect(result.assetRequests).toHaveLength(1);
	});

	test("a 6.3 layout upgrades to bin/current and bin/dg and keeps runtime/ and lib/", async () => {
		const result = await runBootstrap({ seed: seedOldInstall });
		const data = join(result.root, "data");

		expect(result.code, result.stderr).toBe(0);
		expect(readlinkSync(join(data, "bin", "current"))).toBe(result.version);
		expect(readlinkSync(join(result.root, "bin", "dg"))).toBe(join(data, "bin", "current", "dg"));
		expect(readdirSync(join(result.root, "bin")).sort()).toEqual([".dg.version", "dg"]);
		expect(readlinkSync(join(data, "runtime", "current"))).toBe("bun-v1.3.0");
		expect(readlinkSync(join(data, "lib", "current"))).toBe("6.3.0");
		expect(present(join(data, "runtime", "bun-v1.3.0", "bun"))).toBe(true);
		expect(present(join(data, "lib", "6.3.0", "dg.js"))).toBe(true);
		expect(result.stderr).toBe("");
		expect(programRun(result.stdout)?.args).toEqual(["install"]);
	});

	test("a foreign file named like an old launcher stays and is named in one warning", async () => {
		const result = await runBootstrap({
			seed: (root) => {
				mkdirSync(join(root, "bin"), { recursive: true });
				writeFileSync(join(root, "bin", "dg-agent"), "MZ other tool");
				writeFileSync(join(root, "bin", "dg-daemon"), "#!/bin/sh\nexec \"/x/lib/current/dg.js\"\n");
			},
		});
		const kept = join(result.root, "bin", "dg-agent");

		expect(result.code, result.stderr).toBe(0);
		expect(readFileSync(kept, "utf8")).toBe("MZ other tool");
		expect(present(join(result.root, "bin", "dg-daemon"))).toBe(false);
		expect(result.stderr.trim().split("\n")).toEqual([
			`dg: kept ${kept}; it is not a dg launcher and dg no longer uses it`,
		]);
	});

	test("messages and usage errors say dg, never dg-skills", async () => {
		const dest = await runBootstrap({ args: ["--dest"] });
		const version = await runBootstrap({ args: ["--version"] });
		const both = await runBootstrap({ args: ["--skills-only", "--cli-only"] });

		expect(dest.stderr).toBe("dg: --dest requires a directory\n");
		expect(version.stderr).toBe("dg: --version requires a value\n");
		expect(both.stderr).toBe("dg: pass only one of --skills-only and --cli-only\n");
	});

	test("an unknown release asset name never leaves a stage folder behind", async () => {
		const result = await runBootstrap({ sums: "wrong-asset" });

		expect(readdirSync(join(result.root, "data", "bin")).filter((n) => n.startsWith(".stage"))).toEqual([]);
	});
});
