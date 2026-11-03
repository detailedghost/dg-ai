import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./test-support";

const DG_SEGMENT = /["'`]\.dg["'`]|[~/\\]\.dg[/\\"'`]/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

const ALLOWED: Record<string, string> = {
	"pkg/common/src/node/dg-paths.ts": "legacyHome names the old flat home for the migration",
	"pkg/dg-daemon/src/crypto/keychain-backends.ts": "the old keychain account is named after the old home so the migration can find and move it",
	"pkg/skills-cli/src/install/compat-launchers.ts": "the notice launchers name the old path they replace",
	"pkg/skills-cli/src/doctor/probes.ts": "doctor recognizes the old allow rule form to print its replacement",
	"pkg/skills-cli/src/ssms/cli.ts": "ssms keeps its home until its allow_send location moves",
	"pkg/ssms/src/cli/run.ts": "allow_send is read from the passwd home .dg folder by design",
};

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith("__test") ? [] : sources(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

function offenders(): string[] {
	const pkg = join(REPO_ROOT, "pkg");
	const files = readdirSync(pkg).flatMap((name) => {
		const src = join(pkg, name, "src");
		return existsSync(src) ? sources(src) : [];
	});
	return files.flatMap((file) => {
		const rel = relative(REPO_ROOT, file).split("\\").join("/");
		if (ALLOWED[rel]) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, index) => (!COMMENT.test(line) && DG_SEGMENT.test(line) ? [`${rel}:${index + 1}: ${line.trim()}`] : []));
	});
}

describe("dg home paths", () => {
	test("no source file builds a .dg path by hand; every root comes from resolveDgPaths", () => {
		expect(offenders()).toEqual([]);
	});
});
