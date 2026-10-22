import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMANDS } from "../../../src/pw/commands/index";

const BLOCK_PLAYWRIGHT = `Bun.plugin({ name: "block", setup(build) { build.onLoad({ filter: /playwright-core/ }, (args) => { throw new Error("playwright-core loaded: " + args.path); }); } });`;
const TESTS_DIR = import.meta.dir;
const COMMANDS_DIR = path.join(TESTS_DIR, "../../../src/pw/commands");
const SRC_DIR = path.join(COMMANDS_DIR, "..");
const CLIENT_ENTRIES = ["cli.ts", "code-cli.ts"].map((name) => path.join(SRC_DIR, name));

const folders = readdirSync(COMMANDS_DIR).filter(
	(name) => name !== "index.ts" && statSync(path.join(COMMANDS_DIR, name)).isDirectory(),
);
const clientFolders = COMMANDS.filter((entry) => entry.spec.side === "client").map((entry) => entry.spec.name);

describe("command index", () => {
	test("lists every command folder exactly once", () => {
		expect(COMMANDS.map((entry) => entry.spec.name).sort()).toEqual([...folders].sort());
	});

	test("names each spec after its folder", () => {
		for (const folder of folders) {
			const matches = COMMANDS.filter((entry) => entry.spec.name === folder);
			expect(matches).toHaveLength(1);
		}
	});

	test("gives each folder exactly a run and a spec, with a matching test under __tests__/pw/commands", () => {
		for (const folder of folders) {
			expect(readdirSync(path.join(COMMANDS_DIR, folder)).sort()).toEqual(["run.ts", "spec.ts"]);
			expect(existsSync(path.join(TESTS_DIR, `${folder}.spec.ts`))).toBe(true);
		}
	});

	test("loads a default handler function for every command", async () => {
		for (const entry of COMMANDS) {
			const loaded = await entry.load();
			expect(typeof loaded.default).toBe("function");
		}
	});
});

function runtimeImports(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line) && !/^\s*(import|export)\s+type\b/.test(line));
}

describe("client import boundary", () => {
	test("no spec imports playwright-core or anything but core/spec", () => {
		for (const folder of folders) {
			const imports = runtimeImports(path.join(COMMANDS_DIR, folder, "spec.ts"));
			expect(imports).toEqual(['import { defineCommand } from "../../core/spec";']);
		}
	});

	test("the client entry and its core modules do not import playwright-core at runtime", () => {
		const files = [
			...CLIENT_ENTRIES,
			...["args", "client", "help", "registry", "socket", "spec", "states", "state-restore", "launch", "windows"].map(
				(name) => path.join(SRC_DIR, "core", `${name}.ts`),
			),
			...clientFolders.map((name) => path.join(COMMANDS_DIR, name, "run.ts")),
		];
		for (const file of files) {
			expect(runtimeImports(file).filter((line) => line.includes("playwright-core"))).toEqual([]);
		}
	});

	test("loading the client entry and every client handler never loads playwright-core", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pw-boundary-"));
		try {
			const preload = path.join(dir, "block.ts");
			writeFileSync(preload, BLOCK_PLAYWRIGHT);
			const script = path.join(dir, "probe.ts");
			const loads = clientFolders.map(
				(name) => `await import(${JSON.stringify(path.join(COMMANDS_DIR, name, "run.ts"))});`,
			);
			writeFileSync(
				script,
				`${CLIENT_ENTRIES.map((entry) => `await import(${JSON.stringify(entry)});`).join("\n")}\n${loads.join("\n")}\nconsole.log("clean");`,
			);
			const result = Bun.spawnSync([process.execPath, "--preload", preload, script], { stderr: "pipe" });
			expect(result.stderr.toString()).toBe("");
			expect(result.stdout.toString().trim()).toBe("clean");
			expect(result.exitCode).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the probe really fails when playwright-core is imported", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pw-boundary-"));
		try {
			const preload = path.join(dir, "block.ts");
			writeFileSync(preload, BLOCK_PLAYWRIGHT);
			const script = path.join(dir, "probe.ts");
			writeFileSync(script, `await import("playwright-core");`);
			const result = Bun.spawnSync([process.execPath, "--preload", preload, script], { stderr: "pipe" });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.toString()).toContain("playwright-core loaded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
