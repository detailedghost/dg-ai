import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEmitter } from "../../fixture-support";

const dir = import.meta.dir;
const root = join(dir, "..", "..", "..", "..");
const check = process.argv.includes("--check");

type Case = { name: string; toml?: string; files?: Record<string, string>; argv: string[]; native?: boolean };

const cases: Case[] = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));

function run(entry: Case) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "dg-config-cmd-")));
	try {
		const files = { ...(entry.toml === undefined ? {} : { "config/config.toml": entry.toml }), ...entry.files };
		for (const [relative, text] of Object.entries(files)) {
			const path = join(home, relative);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
		const result = Bun.spawnSync(["bun", join(root, "pkg", "dg", "src", "index.ts"), ...entry.argv], {
			cwd: home,
			env: { PATH: process.env.PATH ?? "", HOME: home, DG_HOME: home, DG_PATH_FENCE: home },
		});
		const strip = (text: string) => text.replaceAll(home, "<home>");
		let file: string | null = null;
		try {
			file = strip(readFileSync(join(home, "config", "config.toml"), "utf8"));
		} catch {}
		return {
			name: entry.name,
			stdout: strip(result.stdout.toString()),
			stderr: strip(result.stderr.toString()),
			exit: result.exitCode,
			file,
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const { emit, finish } = createEmitter(dir, check, (name) => name === "cases.expected.json");
emit("cases.expected.json", `${JSON.stringify(cases.map(run), null, "\t")}\n`);
finish("run bun generate.ts");
