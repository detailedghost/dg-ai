import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as commonNode from "@dg/common/node";
import * as commonRoot from "@dg/common";
import * as commonMsal from "@dg/common/msal";

const commonDir = resolve(import.meta.dir, "..");
const inboxDir = resolve(commonDir, "..", "inbox");

function readJson(path: string): {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	exports?: Record<string, string>;
} {
	return JSON.parse(readFileSync(path, "utf8"));
}

function specifiersOf(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(
		/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g,
	)) {
		found.push(match[1]!);
	}
	return found;
}

function closureSpecifiers(entry: string): string[] {
	const seen = new Set<string>();
	const all: string[] = [];
	const queue = [entry];
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
			all.push(specifier);
			if (!specifier.startsWith(".")) continue;
			const base = resolve(dirname(file), specifier);
			const next = [`${base}.ts`, join(base, "index.ts")].find(existsSync);
			if (next) queue.push(next);
		}
	}
	return all;
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

describe("@dg/common/node oauth loopback exports", () => {
	test("exports the whole moved oauth-loopback set", () => {
		for (const name of [
			"oauthState",
			"validateLoopbackRedirect",
			"listenForOAuthCode",
			"openOAuthBrowser",
		]) {
			expect(typeof (commonNode as Record<string, unknown>)[name]).toBe(
				"function",
			);
		}
	});

	test("keeps existing node exports such as runCapture", () => {
		expect(typeof commonNode.runCapture).toBe("function");
	});

	test("does not re-export msal from the node barrel", () => {
		expect(Object.keys(commonNode)).not.toContain(
			"EnvironmentMicrosoftTokenProvider",
		);
		expect(Object.keys(commonNode)).not.toContain("createEncryptedCachePlugin");
		expect(
			readFileSync(join(commonDir, "src/node/index.ts"), "utf8"),
		).not.toMatch(/msal/);
	});

	test("oauthState returns distinct url-safe values", () => {
		const first = commonNode.oauthState();
		const second = commonNode.oauthState();
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe("@dg/common/msal entry", () => {
	test("exports the provider, static provider, cache plugin, and scope pattern", () => {
		expect(typeof commonMsal.EnvironmentMicrosoftTokenProvider).toBe("function");
		expect(typeof commonMsal.StaticMicrosoftTokenProvider).toBe("function");
		expect(typeof commonMsal.createEncryptedCachePlugin).toBe("function");
		expect(commonMsal.MAIL_SCOPE_PATTERN).toBeInstanceOf(RegExp);
	});

	test("is not reachable from the browser-safe root barrel", () => {
		const names = Object.keys(commonRoot);
		expect(names).not.toContain("EnvironmentMicrosoftTokenProvider");
		expect(names).not.toContain("createEncryptedCachePlugin");
		expect(names).not.toContain("listenForOAuthCode");
	});

	test("root barrel closure reaches no node builtin or msal-node", () => {
		const specifiers = closureSpecifiers(join(commonDir, "src/index.ts"));
		const offenders = specifiers.filter(
			(specifier) =>
				specifier.startsWith("node:") ||
				specifier.startsWith("@azure/msal-node") ||
				specifier.includes("msal") ||
				specifier.includes("oauth-loopback"),
		);
		expect(offenders).toEqual([]);
	});
});

describe("package manifests", () => {
	test("common exposes ./msal and depends on @azure/msal-node", () => {
		const manifest = readJson(join(commonDir, "package.json"));
		expect(manifest.exports?.["./msal"]).toBe("./src/msal/index.ts");
		expect(manifest.exports?.["./node"]).toBe("./src/node/index.ts");
		expect(manifest.exports?.["."]).toBe("./src/index.ts");
		expect(manifest.dependencies?.["@azure/msal-node"]).toBeDefined();
		expect(manifest.devDependencies?.["@azure/msal-node"]).toBeUndefined();
	});

	test("inbox keeps @azure/msal-node only as a dev dependency", () => {
		const manifest = readJson(join(inboxDir, "package.json"));
		expect(manifest.dependencies?.["@azure/msal-node"]).toBeUndefined();
		expect(manifest.devDependencies?.["@azure/msal-node"]).toBeDefined();
	});

	test("inbox no longer ships its own oauth-loopback module", () => {
		expect(existsSync(join(inboxDir, "src/gmail/oauth-loopback.ts"))).toBe(
			false,
		);
	});

	test("common source never imports the inbox workspace", () => {
		const offenders = sourceFiles(join(commonDir, "src")).filter((file) =>
			readFileSync(file, "utf8").includes(["@dg", "inbox"].join("/")),
		);
		expect(offenders).toEqual([]);
	});
});
