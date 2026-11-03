import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
	dgDir,
	extensionDest,
	extensionDgDirs,
	legacyExtensionDest,
	markerFiles,
	windowsUserProfile,
} from "../src/utils/lib";

function isUnder(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

describe("test home fence", () => {
	test("keeps every extension path resolver under the temp dir", () => {
		const temp = tmpdir();
		const { current, legacy } = markerFiles();
		const paths = [
			windowsUserProfile(),
			dgDir(),
			extensionDest("chrome").copyPath,
			extensionDest("firefox").copyPath,
			current,
			legacy,
			...extensionDgDirs(),
		];
		for (const path of paths) expect(isUnder(temp, path)).toBe(true);
	});
});

describe("path resolvers", () => {
	test("prefers DG_WINDOWS_HOME for the Windows home", () => {
		expect(windowsUserProfile({ DG_WINDOWS_HOME: "/w", USERPROFILE: "/u" })).toBe("/w");
	});

	test("derives the dg dir from DG_HOME, then HOME", () => {
		expect(dgDir({ DG_HOME: "/d", HOME: "/h" })).toBe("/d");
		expect(dgDir({ HOME: "/h" })).toBe(join("/h", ".dg"));
	});

	test("derives marker files from HOME", () => {
		expect(markerFiles({ HOME: "/h" })).toEqual({
			current: join("/h", ".config", "dg", "extension-installed"),
			legacy: join("/h", ".config", "dg", "browser-batch-installed"),
		});
	});

	test("places extension folders under an override without spawning a process", () => {
		const env = { DG_WINDOWS_HOME: "/w", HOME: "/h" };
		const { copyPath } = extensionDest("chrome", env);
		expect(extensionDgDirs(env)).toContain(dirname(legacyExtensionDest("chrome", env).copyPath));
		expect(copyPath).toBe(join("/w", "AppData", "Local", "dg", "dg-ai-extension-chrome"));
	});

	test("stages the extension in the data root on Linux and macOS", () => {
		expect(extensionDest("chrome", { HOME: "/h" }, false).copyPath).toBe(join("/h", ".local", "share", "dg", "dg-ai-extension-chrome"));
		expect(extensionDest("firefox", { DG_HOME: "/d", HOME: "/h" }, false).copyPath).toBe(join("/d", "data", "dg-ai-extension-firefox"));
	});
});
