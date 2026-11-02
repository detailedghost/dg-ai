import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");
const SRC = join(PKG, "src");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sourceFiles(path) : [path];
	});
}

const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function specifiers(file: string): string[] {
	return [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map(
		(m) => m[1] as string,
	);
}

describe("@dg/tour-ui purity", () => {
	const files = (() => {
		try {
			return sourceFiles(SRC).filter((f) => /\.tsx?$/.test(f));
		} catch {
			return [];
		}
	})();

	it("contains the shared modules", () => {
		const names = files.map((f) => f.slice(SRC.length + 1));
		for (const expected of [
			"index.ts",
			"host.ts",
			"engine.ts",
			"overlay.ts",
			"start-screen.ts",
			"editor.ts",
			"player.ts",
			"picker.ts",
			"ui-helpers.ts",
			"video-timing.ts",
			"narration-progress.ts",
			join("hosts", "player-entry.ts"),
		]) {
			expect(names).toContain(expected);
		}
	});

	it("imports no wxt, webextension-polyfill, chrome, node: or bun: module", () => {
		const forbidden =
			/^(wxt(\/.*)?|webextension-polyfill|chrome|node:.*|bun:.*)$/;
		const offenders = files.flatMap((file) =>
			specifiers(file)
				.filter((s) => forbidden.test(s))
				.map((s) => `${file.slice(PKG.length + 1)} -> ${s}`),
		);
		expect(files.length).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});

	it("reads no chrome.* or browser.* extension global", () => {
		const offenders = files.filter((file) =>
			/\b(chrome|browser)\.(runtime|storage|tabs|scripting)\b/.test(
				readFileSync(file, "utf8"),
			),
		);
		expect(files.length).toBeGreaterThan(0);
		expect(offenders.map((f) => f.slice(PKG.length + 1))).toEqual([]);
	});

	it("imports only relative modules and @dg/common", () => {
		const offenders = files.flatMap((file) =>
			specifiers(file)
				.filter((s) => !s.startsWith(".") && s !== "@dg/common")
				.map((s) => `${file.slice(PKG.length + 1)} -> ${s}`),
		);
		expect(files.length).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});

describe("@dg/tour-ui package manifest", () => {
	const manifest = JSON.parse(
		readFileSync(join(PKG, "package.json"), "utf8"),
	) as {
		name: string;
		private: boolean;
		exports: Record<string, string>;
		dependencies?: Record<string, string>;
	};

	it("is a private package named @dg/tour-ui exporting the index and host", () => {
		expect(manifest.name).toBe("@dg/tour-ui");
		expect(manifest.private).toBe(true);
		expect(manifest.exports["."]).toBe("./src/index.ts");
		expect(manifest.exports["./host"]).toBeDefined();
	});

	it("depends only on @dg/common", () => {
		expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@dg/common"]);
	});

	it("is covered by the root workspaces", () => {
		const root = JSON.parse(
			readFileSync(join(PKG, "..", "..", "package.json"), "utf8"),
		) as { workspaces: string[] };
		expect(root.workspaces).toContain("pkg/*");
	});
});
