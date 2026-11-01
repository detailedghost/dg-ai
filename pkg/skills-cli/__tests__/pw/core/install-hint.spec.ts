import { describe, expect, test } from "bun:test";
import { installHint } from "../../../src/pw/core/install-hint";

const missing = (file: string) =>
	`browserType.launch: Executable doesn't exist at ${file}\n╔═══╗\n║ npx playwright install ║`;

describe("installHint", () => {
	test.each([
		["/home/u/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux", "ffmpeg"],
		["/home/u/.cache/ms-playwright/firefox-1509/firefox/firefox", "firefox"],
		["/home/u/.cache/ms-playwright/webkit-2248/pw_run.sh", "webkit"],
		[
			"/home/u/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell",
			"chromium",
		],
	])("names the product for %p", (file, product) => {
		expect(installHint(missing(file))).toBe(
			`Playwright ${product} is not installed. run: bunx playwright-core install ${product}`,
		);
	});

	test("names the product under a custom browsers path", () => {
		expect(
			installHint(missing("/opt/browsers/ffmpeg-1011/ffmpeg-linux")),
		).toContain("install ffmpeg");
	});

	test("falls back to a generic hint for an unknown location", () => {
		expect(installHint(missing("/opt/other/bin"))).toContain(
			"run: bunx playwright-core install",
		);
	});

	test("ignores unrelated errors", () => {
		expect(installHint("Timeout 5000ms exceeded")).toBeUndefined();
	});
});
