import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { PhoneDb } from "../src/phone/db";

const SRC = join(import.meta.dir, "..", "src");
const MAIN = join(SRC, "main.ts");

const RECORDER = `
import { appendFileSync, readFileSync } from "node:fs";
Bun.plugin({
	name: "record-loads",
	setup(build) {
		build.onLoad({ filter: /\\/pkg\\/[^/]+\\/src\\/.*\\.ts$/ }, ({ path }) => {
			appendFileSync(process.env.LOAD_LOG, path + "\\n");
			return { contents: readFileSync(path, "utf8"), loader: "ts" };
		});
	},
});
`;

const RUNNER = `
const { main } = await import(process.env.MAIN_PATH);
process.exitCode = await main(process.argv.slice(2));
`;

let dir: string;
let paths: DgPaths;

beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dg-agent-lazy-"));
	paths = resolveDgPaths({ platform: process.platform, homeDir: join(dir, "home"), env: {} });
	writeFileSync(join(dir, "recorder.ts"), RECORDER);
	writeFileSync(join(dir, "runner.ts"), RUNNER);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function loadedModules(argv: string[]): Promise<string[]> {
	const logFile = join(dir, "loads.log");
	writeFileSync(logFile, "");
	const child = Bun.spawn(["bun", "--preload", join(dir, "recorder.ts"), join(dir, "runner.ts"), ...argv], {
		cwd: dir,
		env: {
			HOME: join(dir, "home"),
			PATH: process.env.PATH ?? "",
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			DG_KEY_SOURCE: "file",
			LOAD_LOG: logFile,
			MAIN_PATH: MAIN,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	await child.exited;
	return readFileSync(logFile, "utf8").split("\n").filter((line) => line !== "");
}

const memorySearch = ["memory", "search", "token", "--identity", "lazy-agent"];

describe("dg-agent start-up module loading", () => {
	it("loads the main module under the recorder", async () => {
		const loaded = await loadedModules(memorySearch);

		expect(loaded).toContain(MAIN);
	});

	it("does not load layout-hooks.ts or phone/commands.ts on a clean home", async () => {
		const loaded = await loadedModules(memorySearch);

		expect(loaded.filter((path) => path.endsWith("/src/layout-hooks.ts") && path.includes("dg-agent"))).toEqual([]);
		expect(loaded.filter((path) => path.endsWith("/dg-agent/src/phone/commands.ts"))).toEqual([]);
	});

	it("loads layout-hooks.ts only after the fast path finds a legacy phone folder", async () => {
		const legacyPhone = join(paths.legacyHome, "phone");
		mkdirSync(legacyPhone, { recursive: true });
		PhoneDb.openAt(join(legacyPhone, "phone.db"), legacyPhone).close();

		const loaded = await loadedModules(memorySearch);

		expect(loaded.filter((path) => path.endsWith("/dg-agent/src/layout-hooks.ts"))).toHaveLength(1);
	});
});
