import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildBundle, chunkFiles, walkFiles } from "./bundle-fixtures";

setDefaultTimeout(120_000);

const SKILLS_CLI = join(import.meta.dir, "..", "..", "skills-cli");

function playwrightFile(name: "package.json" | "browsers.json") {
	const root = dirname(Bun.resolveSync("playwright-core/package.json", SKILLS_CLI));
	const path = join(root, name);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("launcher build", () => {
	const { lib, dist } = buildBundle();
	const source = walkFiles(lib)
		.filter((file) => file.endsWith(".js"))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");

	test("produces dg.js, chunks and the tarball", () => {
		const files = walkFiles(dist).map((file) => file.slice(dirname(dist).length));
		expect(files.some((file) => file.endsWith(`${join("lib", "dg.js")}`))).toBe(true);
		expect(files.some((file) => file.includes(join("lib", "chunks")) && file.endsWith(".js"))).toBe(true);
		expect(files.some((file) => /dg-lib-.+\.tar\.gz$/.test(file))).toBe(true);
	});

	test("embeds the playwright-core package.json replacement", () => {
		const { name, version } = playwrightFile("package.json") as { name: string; version: string };
		expect(source).toContain(`exports={name:${JSON.stringify(name)},version:${JSON.stringify(version)},description:`);
	});

	test("embeds the playwright-core browsers.json replacement", () => {
		const { browsers } = playwrightFile("browsers.json") as {
			browsers: Array<{ name: string; revision: string }>;
		};
		const chromium = browsers.find((browser) => browser.name === "chromium");
		expect(chromium).toBeDefined();
		const { revision } = chromium as { revision: string };
		expect(source).toContain(`name:"chromium",revision:${JSON.stringify(revision)},installByDefault:`);
	});

	test("pw, inbox and nostr entry points produce chunks carrying those names", () => {
		const names = chunkFiles(lib).map((file) => basename(file).replace(/-[0-9a-z]{8}\.js$/, ""));
		for (const name of ["pw", "inbox", "nostr"]) expect(names).toContain(name);
	});

	test("the tarball name carries the skills-cli package version", () => {
		const { version } = JSON.parse(readFileSync(join(SKILLS_CLI, "package.json"), "utf8")) as { version: string };
		expect(walkFiles(dist).some((file) => file.endsWith(`dg-lib-${version}.tar.gz`))).toBe(true);
	});

	test("runtime.json pins every platform asset with a sha256", () => {
		const runtime = JSON.parse(readFileSync(join(import.meta.dir, "..", "runtime.json"), "utf8")) as {
			version: string;
			assets: Record<string, { file: string; sha256: string }>;
		};
		expect(runtime.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Object.keys(runtime.assets).sort()).toEqual(
			["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "linux-x64-baseline", "windows-arm64", "windows-x64", "windows-x64-baseline"].sort(),
		);
		for (const asset of Object.values(runtime.assets)) {
			expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(asset.file).toEndWith(".zip");
		}
	});
});
