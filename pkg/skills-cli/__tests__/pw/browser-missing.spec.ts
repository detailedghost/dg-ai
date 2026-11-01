import { describe, expect, test } from "bun:test";
import {
	BrowserMissingError,
	pickLaunch,
	type SystemChannel,
	systemBrowserPresent,
} from "../../src/pw/core/browser";

const MESSAGE =
	"No browser found. Ask the user, then run: dg-skills pw install-browser (downloads about 150 MB)";

const LINUX_CHANNELS: [SystemChannel, string][] = [
	["chrome", "/opt/google/chrome/chrome"],
	["msedge", "/opt/microsoft/msedge/msedge"],
];

describe.skipIf(process.platform !== "linux")("systemBrowserPresent", () => {
	test.each(LINUX_CHANNELS)(
		"probes only the fixed Playwright install path for %s",
		(channel, file) => {
			const probed: string[] = [];
			const present = systemBrowserPresent(channel, (candidate) => {
				probed.push(candidate);
				return true;
			});
			expect(present).toBe(true);
			expect(probed).toEqual([file]);
		},
	);

	test("reports a channel as missing when its install path is absent", () => {
		expect(systemBrowserPresent("chrome", () => false)).toBe(false);
		expect(systemBrowserPresent("msedge", () => false)).toBe(false);
	});
});

describe("BrowserMissingError", () => {
	test("names the install-browser command and exits 3", () => {
		const error = new BrowserMissingError();
		expect(error.message).toBe(MESSAGE);
		expect(error.exitCode).toBe(3);
		expect(error).toBeInstanceOf(Error);
	});
});

describe("pickLaunch", () => {
	const downloaded = "/home/u/.dg/browsers/chromium/chrome";

	test("prefers Chrome over Edge and the downloaded Chromium", () => {
		expect(
			pickLaunch({ system: () => true, downloaded: () => downloaded }),
		).toMatchObject({
			channel: "chrome",
		});
	});

	test("falls back to Edge when Chrome is absent", () => {
		expect(
			pickLaunch({
				system: (channel) => channel === "msedge",
				downloaded: () => downloaded,
			}),
		).toMatchObject({
			channel: "msedge",
		});
	});

	test("falls back to the downloaded Chromium when no system browser exists", () => {
		const pick = pickLaunch({
			system: () => false,
			downloaded: () => downloaded,
		});
		expect(pick).toMatchObject({ executablePath: downloaded });
		expect(pick).not.toHaveProperty("channel");
	});

	test("throws BrowserMissingError when nothing is installed", () => {
		expect(() =>
			pickLaunch({ system: () => false, downloaded: () => null }),
		).toThrow(BrowserMissingError);
	});
});
