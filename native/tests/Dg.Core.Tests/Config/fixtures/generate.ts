import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDgPaths } from "../../../../../pkg/common/src/node/dg-paths";
import { parseDgToml, setting } from "../../../../../pkg/common/src/node/dg-toml";
import { createEmitter } from "../../../fixture-support";

const dir = import.meta.dir;
const check = process.argv.includes("--check");
const { emit, finish } = createEmitter(
	dir,
	check,
	(name) => name.endsWith(".ok.json") || name.endsWith(".error.txt") || name.endsWith(".expected.json"),
);

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

for (const file of readdirSync(dir).filter((name) => name.endsWith(".toml")).sort()) {
	const base = file.slice(0, -".toml".length);
	const text = readFileSync(join(dir, file), "utf8");
	try {
		emit(`${base}.ok.json`, `${JSON.stringify(parseDgToml(text, "config.toml"))}\n`);
	} catch (error) {
		emit(`${base}.error.txt`, `${message(error)}\n`);
	}
}

type SettingCase = {
	name: string;
	type: "bool" | "string";
	key: string;
	toml: string;
	envVar?: string;
	flag?: boolean | string;
	env: Record<string, string>;
};

const cases: SettingCase[] = JSON.parse(readFileSync(join(dir, "settings.cases.json"), "utf8"));
const settingResults = cases.map((entry) => {
	const home = mkdtempSync(join(tmpdir(), "dg-config-fixture-"));
	try {
		const env = { ...entry.env, DG_HOME: home, DG_PATH_FENCE: home };
		const file = resolveDgPaths({ env }).configTomlPath;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, entry.toml);
		try {
			const value = setting<unknown>(entry.key, { flag: entry.flag, envVar: entry.envVar, env });
			return { name: entry.name, value: value ?? null };
		} catch (error) {
			return { name: entry.name, error: message(error) };
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
emit("settings.expected.json", `${JSON.stringify(settingResults, null, "\t")}\n`);

type PathCase = { name: string; platform: NodeJS.Platform; home: string; env: Record<string, string> };

const pathCases: PathCase[] = JSON.parse(readFileSync(join(dir, "paths.cases.json"), "utf8"));
const pathResults = pathCases.map((entry) => {
	try {
		const paths = resolveDgPaths({ platform: entry.platform, homeDir: entry.home, env: entry.env });
		return { name: entry.name, paths };
	} catch (error) {
		return { name: entry.name, error: message(error) };
	}
});
emit("paths.expected.json", `${JSON.stringify(pathResults, null, "\t")}\n`);

finish("run bun generate.ts");
