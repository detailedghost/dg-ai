import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compiledAssetName } from "../skills-cli/src/utils/lib";
import { buildCompanions } from "./build/companions";
import { buildCompiled, buildLauncher } from "./build/compile";
import { COMPILE_TARGETS, type CompileKey, ROOT, sharedOptions } from "./build/options";
import { buildReport } from "./build/report";

export { buildCompiled, buildLauncher, COMPILE_TARGETS, compiledAssetName };
export type { CompileKey };

const isCompileKey = (key: string): key is CompileKey => Object.hasOwn(COMPILE_TARGETS, key);

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			outdir: { type: "string" },
			compiled: { type: "string", multiple: true },
			companions: { type: "boolean" },
			"without-companions": { type: "boolean" },
			report: { type: "string" },
		},
	});
	const outdir = values.outdir ?? join(ROOT, "dist");
	if (values.companions) {
		const { version } = JSON.parse(readFileSync(join(ROOT, "..", "skills-cli", "package.json"), "utf8")) as { version: string };
		for (const file of await buildCompanions(outdir, version)) console.log(file);
	} else if (!values.compiled) await buildLauncher(outdir);
	else {
		const keys = values.compiled.includes("all") ? Object.keys(COMPILE_TARGETS) : values.compiled;
		const targets = keys.map((key) => {
			if (!isCompileKey(key)) throw new Error(`unknown compile target ${key}; expected all or ${Object.keys(COMPILE_TARGETS).join(", ")}`);
			return key;
		});
		const shared = await sharedOptions();
		for (const target of targets) {
			console.log(await buildCompiled({ target, outfile: join(outdir, compiledAssetName(target)), shared, withoutCompanions: values["without-companions"] }));
		}
	}
	if (values.report) await buildReport(values.report);
}
