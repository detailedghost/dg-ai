import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep, win32 } from "node:path";
import { resolveDgPaths, runCapture } from "@dg/common/node";

const SRC_DIR = resolve(import.meta.dir, "../src");
const BARREL_ENTRY = join(SRC_DIR, "index.ts");
const NODE_DIR_PREFIX = `${join(SRC_DIR, "node")}${sep}`;

function extractSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const patterns = [
		/\bfrom\s+["']([^"']+)["']/g,
		/\brequire\(\s*["']([^"']+)["']\s*\)/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
		/^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		// biome-ignore lint: exec-in-loop is the standard global-regex idiom
		while ((match = pattern.exec(source))) specifiers.push(match[1]);
	}
	return specifiers;
}

function resolveLocalSpecifier(fromFile: string, specifier: string): string {
	const base = join(dirname(fromFile), specifier);
	if (existsSync(`${base}.ts`)) return `${base}.ts`;
	if (existsSync(join(base, "index.ts"))) return join(base, "index.ts");
	return base;
}

function collectBarrelReachableFiles(): {
	files: Set<string>;
	nodeBuiltins: string[];
} {
	const visited = new Set<string>();
	const nodeBuiltins: string[] = [];
	const queue = [BARREL_ENTRY];

	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || visited.has(file)) continue;
		visited.add(file);

		const source = readFileSync(file, "utf8");
		for (const specifier of extractSpecifiers(source)) {
			if (specifier.startsWith("node:")) {
				nodeBuiltins.push(`${specifier} (imported by ${file})`);
			} else if (specifier.startsWith(".")) {
				const resolved = resolveLocalSpecifier(file, specifier);
				if (!visited.has(resolved)) queue.push(resolved);
			}
		}
	}

	return { files: visited, nodeBuiltins };
}

describe("@dg/common barrel — Node-builtin isolation", () => {
	it("pulls in no node: builtin through its transitive import graph", () => {
		const { nodeBuiltins } = collectBarrelReachableFiles();
		expect(nodeBuiltins).toEqual([]);
	});

	it("never transitively reaches src/node/** from the barrel", () => {
		const { files } = collectBarrelReachableFiles();
		const leaks = [...files].filter((file) => file.startsWith(NODE_DIR_PREFIX));
		expect(leaks).toEqual([]);
	});
});

describe("resolveDgPaths", () => {
	const baseSeams = {
		homeDir: "/home/demo",
		env: {} as Record<string, string | undefined>,
	};

	it("resolves the seven named ~/.dg paths under one root on linux", () => {
		const paths = resolveDgPaths({ ...baseSeams, platform: "linux" });
		expect(paths.stateDir).toBe(posix.join("/home/demo", ".dg"));
		for (const field of [
			"lockfilePath",
			"dbPath",
			"keyPath",
			"logPath",
			"assetsDir",
			"sessionsDir",
		] as const) {
			expect(posix.dirname(paths[field])).toBe(paths.stateDir);
		}
	});

	it("resolves the same uniform .dg root on darwin", () => {
		const paths = resolveDgPaths({ ...baseSeams, platform: "darwin" });
		expect(paths.stateDir).toBe(posix.join("/home/demo", ".dg"));
	});

	it("resolves the same uniform .dg root on win32, using win32 separators", () => {
		const homeDir = "C:\\Users\\demo";
		const paths = resolveDgPaths({ homeDir, env: {}, platform: "win32" });
		expect(paths.stateDir).toBe(win32.join(homeDir, ".dg"));
		for (const field of [
			"lockfilePath",
			"dbPath",
			"keyPath",
			"logPath",
			"assetsDir",
			"sessionsDir",
		] as const) {
			expect(win32.dirname(paths[field])).toBe(paths.stateDir);
		}
	});

	it("honors DG_HOME as the sole root override, replacing <home>/.dg wholesale", () => {
		const paths = resolveDgPaths({
			...baseSeams,
			platform: "linux",
			env: { DG_HOME: "/custom/dg-root" },
		});
		expect(paths.stateDir).toBe("/custom/dg-root");
		expect(posix.dirname(paths.dbPath)).toBe("/custom/dg-root");
	});

	it("ignores AI_SCRATCH_DIR entirely for the persistent root", () => {
		const withoutOverride = resolveDgPaths({ ...baseSeams, platform: "linux" });
		const withScratchOverride = resolveDgPaths({
			...baseSeams,
			platform: "linux",
			env: { AI_SCRATCH_DIR: "/tmp/ephemeral-scratch" },
		});
		expect(withScratchOverride.stateDir).toBe(withoutOverride.stateDir);
		expect(withScratchOverride.stateDir).not.toContain("ephemeral-scratch");
	});

	it("honors DG_HOME on win32 too, joining sub-paths with win32 separators", () => {
		const paths = resolveDgPaths({
			platform: "win32",
			homeDir: "C:\\Users\\demo",
			env: { DG_HOME: "D:\\custom-root" },
		});
		expect(paths.stateDir).toBe("D:\\custom-root");
		expect(paths.dbPath).toBe(win32.join("D:\\custom-root", "chat.db"));
	});

	it("falls back to the real platform/home/env when called with no arguments", () => {
		const originalDgHome = process.env.DG_HOME;
		delete process.env.DG_HOME;
		try {
			const paths = resolveDgPaths();
			expect(paths.stateDir).toBe(join(homedir(), ".dg"));
		} finally {
			if (originalDgHome !== undefined) process.env.DG_HOME = originalDgHome;
		}
	});
});

describe("runCapture", () => {
	it("returns a non-zero status with stdout/stderr captured separately, without throwing", async () => {
		const result = await runCapture("sh", [
			"-c",
			"printf 'stdout-marker'; printf 'stderr-marker' 1>&2; exit 3",
		]);

		expect(result.status).toBe(3);
		expect(result.stdout).toContain("stdout-marker");
		expect(result.stderr).toContain("stderr-marker");
		expect(result.stdout).not.toContain("stderr-marker");
	});

	it("pipes the optional stdin option through to the child process", async () => {
		const result = await runCapture("sh", ["-c", "cat"], {
			stdin: "piped-input",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("piped-input");
	});

	it("rejects rather than resolving a fake status for a nonexistent binary", async () => {
		await expect(
			runCapture("dg-nonexistent-binary-xyz", []),
		).rejects.toBeDefined();
	});
});
