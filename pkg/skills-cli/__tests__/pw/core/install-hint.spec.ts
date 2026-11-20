import { describe, expect, test } from "bun:test";
import { installHint } from "../../../src/pw/core/install-hint";

const missing = (file: string) =>
	`browserType.launch: Executable doesn't exist at ${file}\n╔═══╗\n║ npx playwright install ║`;

describe("installHint", () => {
	test.each([
		["/home/u/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux", "ffmpeg"],
		[
			"/home/u/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell",
			"chromium",
		],
	])("names the product and the path it tried for %p", (file, product) => {
		expect(installHint(missing(file))).toBe(
			`Playwright ${product} is not installed at ${file}. run: bunx playwright-core install ${product}`,
		);
	});

	test.each([
		["/home/u/.cache/ms-playwright/firefox-1509/firefox/firefox", "firefox", "Firefox"],
		["/home/u/.cache/ms-playwright/webkit-2248/pw_run.sh", "webkit", "WebKit"],
	])("says a system browser cannot stand in for %p", (file, product, label) => {
		const hint = installHint(missing(file));
		expect(hint).toContain(`is not installed at ${file}.`);
		expect(hint).toContain(`playwright-core drives only its own ${label} build`);
		expect(hint).toEndWith(`run: bunx playwright-core install ${product}`);
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
