import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { AnalyzeResult } from "./types";

export function readJsonSafe(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function detectNativeAddon(dir: string): string | null {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return null;

	const pkg = readJsonSafe(pkgPath);
	if (!pkg) return null;
	const deps = {
		...((pkg.dependencies ?? {}) as Record<string, string>),
		...((pkg.devDependencies ?? {}) as Record<string, string>),
	};

	const nmDir = join(dir, "node_modules");
	if (existsSync(nmDir)) {
		for (const depName of Object.keys(deps)) {
			const depPkg = join(nmDir, depName, "package.json");
			if (!existsSync(depPkg)) continue;
			const depMeta = readJsonSafe(depPkg);
			if (!depMeta) continue;
			if (
				depMeta.gypfile ||
				depMeta.binary ||
				(depMeta.scripts && JSON.stringify(depMeta.scripts).includes("node-gyp"))
			) {
				return depName;
			}
			const depDir = join(nmDir, depName);
			try {
				const files = readdirSync(depDir);
				if (files.some((f) => f.endsWith(".node"))) return depName;
			} catch {
				/* skip */
			}
		}
	}

	if (pkg.gypfile || pkg.binary) return basename(dir);
	return null;
}

export function analyzeSource(absPath: string): AnalyzeResult {
	const ext = extname(absPath).toLowerCase();
	const content = readFileSync(absPath, "utf-8");
	const firstLineEnd = content.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);

	const isBunTs = ext === ".ts" || firstLine.includes("bun") || (ext === "" && content.includes("bun run"));
	const isPython = ext === ".py" || firstLine.includes("python");
	const isSh = ext === ".sh" || (firstLine.startsWith("#!") && (firstLine.includes("sh") || firstLine.includes("bash")));

	if (isPython || isSh || !isBunTs) {
		return {
			publishable: false,
			issues: [
				`Source is not a Bun-TypeScript file (detected: ${isPython ? "python" : isSh ? "shell" : "unknown"}).`,
				"Port it to Bun-TS first.",
			],
			routing: "bun-ts",
		};
	}

	const nativeResult = detectNativeAddon(dirname(absPath));
	if (nativeResult) {
		return {
			publishable: true,
			issues: [`Native addon detected: ${nativeResult}. Will use minimal-dependency packaging.`],
			routing: "native-addon",
		};
	}

	return { publishable: true, issues: [], routing: "bun-ts" };
}

export function cmdAnalyze(args: string[]): number {
	const cliPath = args[0];
	if (!cliPath) {
		process.stderr.write("Usage: skill-publish analyze <cli-path>\n");
		return 1;
	}

	const resolved = resolve(cliPath);
	if (!existsSync(resolved)) {
		const result: AnalyzeResult = { publishable: false, issues: [`File not found: ${resolved}`], routing: "bun-ts" };
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.stderr.write(`ERROR: File not found: ${resolved}\n`);
		return 1;
	}

	const result = analyzeSource(resolved);
	process.stdout.write(`${JSON.stringify(result)}\n`);

	if (!result.publishable) {
		process.stderr.write(`Not publishable: ${result.issues.join("; ")}\nPort it to Bun-TS first.\n`);
		return 1;
	}
	if (result.routing === "native-addon") {
		process.stderr.write("Native addon detected — publishable with constraints. See issues for details.\n");
		return 2;
	}
	return 0;
}
