import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserStatus, installBrowser, removeBrowser } from "../../src/pw/browsers";
import { downloadedChromium, markerPath } from "../../src/pw/core/downloaded";

function withDir(
	run: (dir: string) => Promise<void> | void,
): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pw-browsers-"));
		try {
			await run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

function fakeChromium(dir: string): string {
	const executablePath = path.join(dir, "chromium", "chrome");
	mkdirSync(path.dirname(executablePath), { recursive: true });
	writeFileSync(executablePath, "");
	return executablePath;
}

describe("installBrowser", () => {
	test(
		"installs through the injected registry and records the executable",
		withDir(async (dir) => {
			const calls: string[] = [];
			const installed = await installBrowser(async (browsersPath) => {
				calls.push(browsersPath);
				return { version: "140.0", executablePath: fakeChromium(dir) };
			}, dir);
			expect(calls).toEqual([dir]);
			expect(installed.version).toBe("140.0");
			expect(JSON.parse(readFileSync(markerPath(dir), "utf8"))).toEqual(
				installed,
			);
			expect(downloadedChromium(dir)).toEqual(installed);
		}),
	);

	test(
		"does not record a marker when the install fails",
		withDir(async (dir) => {
			await expect(
				installBrowser(async () => {
					throw new Error("offline");
				}, dir),
			).rejects.toThrow("offline");
			expect(downloadedChromium(dir)).toBeNull();
		}),
	);

	test(
		"replaces the marker with a private file and leaves no temp file behind",
		withDir(async (dir) => {
			await installBrowser(
				async () => ({ version: "139.0", executablePath: fakeChromium(dir) }),
				dir,
			);
			await installBrowser(
				async () => ({ version: "140.0", executablePath: fakeChromium(dir) }),
				dir,
			);
			expect(downloadedChromium(dir)?.version).toBe("140.0");
			expect(statSync(markerPath(dir)).mode & 0o777).toBe(0o600);
			expect(readdirSync(dir).sort()).toEqual(["chromium", "chromium.json"]);
		}),
	);
});

describe("browserStatus", () => {
	test(
		"reports no browser when nothing is installed",
		withDir((dir) => {
			expect(browserStatus(dir, () => false)).toEqual({
				system: "none",
				downloaded: "none",
			});
		}),
	);

	test(
		"reports the first system channel and the downloaded version",
		withDir(async (dir) => {
			await installBrowser(
				async () => ({ version: "140.0", executablePath: fakeChromium(dir) }),
				dir,
			);
			expect(browserStatus(dir, (channel) => channel === "msedge")).toEqual({
				system: "msedge",
				downloaded: "140.0",
			});
		}),
	);

	test(
		"ignores a marker whose executable is gone",
		withDir((dir) => {
			writeFileSync(
				markerPath(dir),
				JSON.stringify({
					version: "1",
					executablePath: path.join(dir, "missing"),
				}),
			);
			expect(downloadedChromium(dir)).toBeNull();
		}),
	);
});

describe("removeBrowser", () => {
	test(
		"deletes the browsers directory and reports it",
		withDir((dir) => {
			const browsers = path.join(dir, "browsers");
			fakeChromium(browsers);
			expect(removeBrowser(browsers)).toBe(true);
			expect(downloadedChromium(browsers)).toBeNull();
			expect(readdirSync(dir)).toEqual([]);
		}),
	);

	test(
		"reports false when nothing was downloaded",
		withDir((dir) => {
			expect(removeBrowser(path.join(dir, "browsers"))).toBe(false);
		}),
	);
});
