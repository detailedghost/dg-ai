import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dir, "../../src");
const transpiler = new Bun.Transpiler({ loader: "ts" });
const EXTENSIONS = ["", ".ts", "/index.ts"];

function resolveLocal(from: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(from), specifier);
	for (const extension of EXTENSIONS) {
		const candidate = base + extension;
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

function staticClosure(entry: string): {
	files: Set<string>;
	packages: Set<string>;
} {
	const files = new Set<string>();
	const packages = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (files.has(file)) continue;
		files.add(file);
		for (const { path: specifier, kind } of transpiler.scanImports(
			readFileSync(file, "utf8"),
		)) {
			if (kind !== "import-statement") continue;
			if (specifier.startsWith(".")) {
				const resolved = resolveLocal(file, specifier);
				if (resolved) queue.push(resolved);
			} else packages.add(specifier);
		}
	}
	return { files, packages };
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

describe("pw lazy loading", () => {
	test("the pw command registration statically reaches neither playwright-core nor the daemon", () => {
		const { files, packages } = staticClosure(
			path.join(SRC, "commands", "pw.ts"),
		);
		expect(packages.has("playwright-core")).toBe(false);
		expect(files.has(path.join(SRC, "pw", "daemon.ts"))).toBe(false);
		expect(files.has(path.join(SRC, "pw", "browsers.ts"))).toBe(false);
	});

	test("the pw-code registration statically reaches neither playwright-core nor the daemon", () => {
		const { files, packages } = staticClosure(
			path.join(SRC, "commands", "pw-code.ts"),
		);
		expect(packages.has("playwright-core")).toBe(false);
		expect(files.has(path.join(SRC, "pw", "daemon.ts"))).toBe(false);
	});

	test("the pw client entry does not statically reach the browser installer", () => {
		expect(
			staticClosure(path.join(SRC, "pw", "cli.ts")).files.has(
				path.join(SRC, "pw", "browsers.ts"),
			),
		).toBe(false);
	});

	test("the pw client entry statically reaches no playwright-core", () => {
		expect(
			staticClosure(path.join(SRC, "pw", "cli.ts")).packages.has(
				"playwright-core",
			),
		).toBe(false);
	});

	test("the doctor registry statically reaches neither playwright-core nor the daemon", () => {
		const { files, packages } = staticClosure(
			path.join(SRC, "doctor", "registry.ts"),
		);
		expect(packages.has("playwright-core")).toBe(false);
		expect(files.has(path.join(SRC, "pw", "daemon.ts"))).toBe(false);
		expect(files.has(path.join(SRC, "pw", "browsers.ts"))).toBe(false);
	});

	test("only the pw and pw-code registrations and the doctor registry import the pw tree outside it", () => {
		const importers = sourceFiles(SRC)
			.filter((file) => !file.startsWith(path.join(SRC, "pw") + path.sep))
			.filter((file) => /["'](?:\.\.?\/)+pw\//.test(readFileSync(file, "utf8")))
			.map((file) => path.relative(SRC, file))
			.sort();
		expect(importers).toEqual([
			path.join("commands", "pw-code.ts"),
			path.join("commands", "pw.ts"),
			path.join("doctor", "registry.ts"),
		]);
	});
});
