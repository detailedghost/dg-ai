import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import baseline from "./fixtures/manifest-permissions.json";

const EXT = resolve(import.meta.dir, "..");
const OUT = resolve(EXT, ".output", "chrome-mv3");

type Manifest = {
	permissions: string[];
	host_permissions: string[];
	action?: { default_popup?: string; default_title?: string };
};

let manifest: Manifest;

beforeAll(async () => {
	const build = Bun.spawn([process.execPath, "run", "wxt", "build"], {
		cwd: EXT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(build.stdout).text(),
		new Response(build.stderr).text(),
	]);
	expect(await build.exited, out + err).toBe(0);
	manifest = JSON.parse(readFileSync(resolve(OUT, "manifest.json"), "utf8"));
}, 120_000);

function scriptClosure(entryHtml: string): string[] {
	const html = readFileSync(resolve(OUT, entryHtml), "utf8");
	const queue = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) =>
		resolve(OUT, (match[1] as string).replace(/^\//, "")),
	);
	const seen = new Set<string>();
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file) || !existsSync(file)) continue;
		seen.add(file);
		const code = readFileSync(file, "utf8");
		for (const match of code.matchAll(
			/(?:from|import)\s*["'](\.{1,2}\/[^"']+\.js)["']/g,
		)) {
			queue.push(resolve(dirname(file), match[1] as string));
		}
	}
	return [...seen];
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory()
			? sourceFiles(path)
			: path.endsWith(".ts")
				? [path]
				: [];
	});
}

describe("wxt build", () => {
	it("keeps the chrome-mv3 permissions unchanged", () => {
		expect([...manifest.permissions].sort()).toEqual(
			[...baseline.permissions].sort(),
		);
		expect([...manifest.host_permissions].sort()).toEqual(
			[...baseline.host_permissions].sort(),
		);
		expect(manifest.permissions).toContain("activeTab");
	});

	it("wires the popup as the toolbar action and titles it from the popup page", () => {
		expect(manifest.action?.default_popup?.endsWith("popup.html")).toBe(true);
		expect(manifest.action?.default_title).toBe("DeeGee");
	});

	it("bundles the popup without any Node Buffer or node: reference", () => {
		const files = scriptClosure("popup.html");

		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const code = readFileSync(file, "utf8");
			expect(code, file).not.toMatch(/\bBuffer\b/);
			expect(code, file).not.toMatch(/["'`]node:/);
		}
	});

	it("registers no action click listener anywhere in lib", () => {
		const offenders = sourceFiles(resolve(EXT, "lib")).filter((file) =>
			readFileSync(file, "utf8").includes("onClicked"),
		);

		expect(offenders).toEqual([]);
	});
});
