import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildBundle, cleanupTraces, dirBytes, run, traceChunks } from "./bundle-fixtures";

setDefaultTimeout(120_000);

const KB = 1024;
const MB = 1024 * KB;
const STATIC_IMPORT = /(?:^|[;}\n])\s*(?:import\s*(?:[\w*${"'`])|export\s*(?:\*|\{[^}]*\})\s*from)/;

const STATIC_FROM = /(?:^|[;}\n])\s*(?:import|export)\s*(?:[^;"'`]*?\bfrom\s*)?["']([^"']+)["']/g;
const PROGRAM_MARKER = "launcher root must be absolute";
const DYNAMIC_CHUNK = /import\(["'](\.\/chunks\/[^"']+)["']\)/g;

function staticSpecifiers(source: string): string[] {
	return [...source.matchAll(STATIC_FROM)].map((m) => m[1] as string);
}

function staticClosure(lib: string, start: string): string[] {
	const seen = new Set<string>();
	const queue = [start];
	for (let spec = queue.shift(); spec !== undefined; spec = queue.shift()) {
		if (seen.has(spec)) continue;
		seen.add(spec);
		for (const next of staticSpecifiers(readFileSync(join(lib, spec), "utf8"))) {
			if (next.startsWith(".")) queue.push(`./chunks/${next.replace(/^\.\//, "")}`);
		}
	}
	return [...seen];
}

describe("size budget", () => {
	const { lib, dist, bun } = buildBundle();

	afterAll(cleanupTraces);

	test("dg.js is at most 16 KB and has no static import", () => {
		const file = join(lib, "dg.js");
		expect(statSync(file).size).toBeLessThanOrEqual(16 * KB);
		expect(readFileSync(file, "utf8")).not.toMatch(STATIC_IMPORT);
	});

	test("the static import closure of dg.js is only the program-name module and the leaf exit module", () => {
		const dgSource = readFileSync(join(lib, "dg.js"), "utf8");
		expect(staticSpecifiers(dgSource)).toEqual([]);
		const dynamic = [...dgSource.matchAll(DYNAMIC_CHUNK)].map((m) => m[1] as string);
		const programChunks = dynamic.filter((spec) => /\/program-/.test(spec));
		const exitChunks = dynamic.filter((spec) => /\/exit-/.test(spec));
		expect(programChunks).toHaveLength(1);
		expect(exitChunks).toHaveLength(1);

		const programClosure = staticClosure(lib, programChunks[0] as string);
		expect(programClosure).toHaveLength(2);
		const programModule = programClosure[1] as string;
		expect(readFileSync(join(lib, programModule), "utf8")).toContain(PROGRAM_MARKER);
		expect(statSync(join(lib, programModule)).size).toBeLessThanOrEqual(2 * KB);

		const exitClosure = staticClosure(lib, exitChunks[0] as string);
		expect(exitClosure).toHaveLength(2);
		const exitModule = exitClosure[1] as string;
		expect(readFileSync(join(lib, exitModule), "utf8")).toContain("process.exit(");
		expect(staticSpecifiers(readFileSync(join(lib, exitModule), "utf8"))).toEqual([]);
		expect(statSync(join(lib, exitModule)).size).toBeLessThanOrEqual(2 * KB);

		const everything = new Set([...staticClosure(lib, "dg.js"), ...programClosure, ...exitClosure]);
		expect(everything.size).toBe(1 + programClosure.length + exitClosure.length);
	});

	test("each program entry chunk imports no other chunk statically", () => {
		const dgSource = readFileSync(join(lib, "dg.js"), "utf8");
		const entries = [...dgSource.matchAll(DYNAMIC_CHUNK)]
			.map((m) => m[1] as string)
			.filter((spec) => /\/(skills|agent|daemon)-/.test(spec));
		expect(entries).toHaveLength(3);
		for (const entry of entries) expect({ entry, closure: staticClosure(lib, entry) }).toEqual({ entry, closure: [entry] });
	});

	test("dist/lib totals at most 12 MB", () => {
		expect(dirBytes(lib)).toBeLessThanOrEqual(12 * MB);
	});

	test("the release tarball is at most 4 MB", () => {
		const tarballs = readdirSync(dist).filter((name) => /^dg-lib-.+\.tar\.gz$/.test(name));
		expect(tarballs).toHaveLength(1);
		expect(statSync(join(dist, tarballs[0] as string)).size).toBeLessThanOrEqual(4 * MB);
	});

	test("dg-skills stash --help reads neither the inbox nor the playwright chunk", () => {
		const traced = traceChunks(/(pw|inbox|playwright)/);
		expect(traced.sentinels.size).toBeGreaterThan(0);
		const result = run(bun, traced.entry, ["dg-skills", "stash", "--help"]);
		expect(result.exitCode).toBe(0);
		for (const [name, sentinel] of traced.sentinels) expect({ name, loaded: existsSync(sentinel) }).toEqual({ name, loaded: false });
	});

	test("dg-skills --help reads neither the inbox nor the playwright chunk", () => {
		const traced = traceChunks(/(pw|inbox|playwright)/);
		const result = run(bun, traced.entry, ["dg-skills", "--help"]);
		expect(result.exitCode).toBe(0);
		for (const [name, sentinel] of traced.sentinels) expect({ name, loaded: existsSync(sentinel) }).toEqual({ name, loaded: false });
	});

	test("dg-agent phone status loads the nostr-tools chunk and not the inbox chunk", () => {
		const nostr = traceChunks(/nostr/);
		expect(nostr.sentinels.size).toBeGreaterThan(0);
		run(bun, nostr.entry, ["dg-agent", "phone", "status"], { DG_HOME: nostr.dir });
		expect([...nostr.sentinels.values()].some((sentinel) => existsSync(sentinel))).toBe(true);

		const inbox = traceChunks(/inbox/);
		expect(inbox.sentinels.size).toBeGreaterThan(0);
		run(bun, inbox.entry, ["dg-agent", "phone", "status"], { DG_HOME: inbox.dir });
		for (const sentinel of inbox.sentinels.values()) expect(existsSync(sentinel)).toBe(false);
	});
});
