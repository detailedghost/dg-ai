import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { installRoot } from "../src/utils/lib";
import { writeShims } from "../src/install/shims";
import { scratch, type Scratch } from "./runtime-bundle-fixtures";

const TEMPLATE = join(import.meta.dir, "..", "..", "launcher", "shims", "dg.sh");
const NAMES = ["dg-skills", "dg-agent", "dg-daemon"] as const;
const posix = describe.skipIf(process.platform === "win32");

let sandbox: Scratch;

beforeEach(() => {
	sandbox = scratch("write-shims");
});

afterEach(() => {
	sandbox.cleanup();
});

function golden(root: string, name: string): string {
	return readFileSync(TEMPLATE, "utf8")
		.replaceAll("{{ROOT}}", () => `'${root.replaceAll("'", "'\\''")}'`)
		.replaceAll("{{NAME}}", name);
}

describe("writeShims on a Windows host", () => {
	test("doubles percent signs in the root so cmd does not expand them", () => {
		const root = join(sandbox.root, "100%PATH%");
		writeShims(join(root, "bin"), root, "win32");

		const text = readFileSync(join(root, "bin", "dg-skills.cmd"), "utf8");
		expect(text).toContain("100%%PATH%%");
		expect(text).not.toMatch(/[^%]%PATH%/);
	});
});

posix("writeShims on a POSIX host", () => {
	test("writes each launcher in the bin dir equal to the golden shim text with the data dir substituted, mode 0755", () => {
		const bin = join(sandbox.root, "local-bin");
		const data = join(sandbox.root, "data dir");

		writeShims(bin, data);

		for (const name of NAMES) {
			const path = join(bin, name);
			expect(readFileSync(path, "utf8")).toBe(golden(data, name));
			expect(statSync(path).mode & 0o777).toBe(0o755);
		}
	});

	test("replaces a compiled binary of the same name with the shim", () => {
		const bin = join(sandbox.root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-daemon"), "compiled ELF bytes", { mode: 0o755 });

		writeShims(bin, sandbox.root);

		expect(readFileSync(join(bin, "dg-daemon"), "utf8")).toBe(golden(sandbox.root, "dg-daemon"));
	});

	test("each shim runs the current runtime on lib/current/dg.js with its name and keeps argument boundaries", () => {
		const root = join(sandbox.root, "dg home");
		const runtime = join(root, "runtime", "bun-test");
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, "bun"), '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n', { mode: 0o755 });
		symlinkSync("bun-test", join(root, "runtime", "current"));
		writeShims(join(root, "bin"), root);

		for (const name of NAMES) {
			const run = Bun.spawnSync([join(root, "bin", name), "two words", "*"], { stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode, run.stderr.toString()).toBe(0);
			expect(run.stdout.toString().split("\n").slice(0, -1)).toEqual([
				join(root, "lib", "current", "dg.js"),
				name,
				"two words",
				"*",
			]);
		}
	});

	test("runs the shims when the root holds shell metacharacters and replacement tokens", () => {
		const root = join(sandbox.root, "a$&\"`b\\'c$HOME $1");
		const runtime = join(root, "runtime", "bun-test");
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, "bun"), '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n', { mode: 0o755 });
		symlinkSync("bun-test", join(root, "runtime", "current"));
		writeShims(join(root, "bin"), root);

		const run = Bun.spawnSync([join(root, "bin", "dg-skills"), "x"], { stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		expect(run.stdout.toString().split("\n").slice(0, -1)).toEqual([
			join(root, "lib", "current", "dg.js"),
			"dg-skills",
			"x",
		]);
	});

	test("a relative DG_HOME resolves to absolute roots so the shims run from another directory", () => {
		const home = join(sandbox.root, "home");
		const env = { DG_HOME: relative(process.cwd(), home) };
		const paths = resolveDgPaths({ env });
		const root = installRoot(env);
		const runtime = join(root, "runtime", "bun-test");
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, "bun"), '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n', { mode: 0o755 });
		symlinkSync("bun-test", join(root, "runtime", "current"));
		writeShims(paths.binDir, paths.dataDir);

		const elsewhere = join(sandbox.root, "elsewhere");
		mkdirSync(elsewhere);
		const run = Bun.spawnSync([join(home, "bin", "dg-skills"), "x"], { cwd: elsewhere, stdout: "pipe", stderr: "pipe" });
		expect(root).toBe(join(home, "data"));
		expect(paths.binDir).toBe(join(home, "bin"));
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		expect(run.stdout.toString().split("\n")[0]).toBe(join(home, "data", "lib", "current", "dg.js"));
	});


	test("is idempotent", () => {
		writeShims(join(sandbox.root, "bin"), sandbox.root);
		writeShims(join(sandbox.root, "bin"), sandbox.root);

		expect(readFileSync(join(sandbox.root, "bin", "dg-skills"), "utf8")).toBe(
			golden(sandbox.root, "dg-skills"),
		);
	});
});
