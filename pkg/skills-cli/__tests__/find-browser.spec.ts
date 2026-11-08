import { describe, expect, test } from "bun:test";
import {
	BrowserMissingError,
	pickLaunch,
} from "../src/pw/core/browser";
import {
	type FinderSeams,
	findInstalledChromium,
	PATH_CANDIDATES,
} from "../src/utils/find-browser";

const seams = (overrides: Partial<FinderSeams> = {}): FinderSeams => ({
	env: {},
	platform: "linux",
	which: () => null,
	exists: () => false,
	...overrides,
});

const onPath =
	(...names: string[]) =>
	(name: string) =>
		names.includes(name) ? `/usr/bin/${name}` : null;

describe("findInstalledChromium", () => {
	test("returns DG_BROWSER before anything on PATH", () => {
		expect(
			findInstalledChromium(
				seams({ env: { DG_BROWSER: "/opt/x/browser" }, which: onPath("brave-browser") }),
			),
		).toBe("/opt/x/browser");
	});

	test("accepts DG_VERIFY_BROWSER as an alias", () => {
		expect(findInstalledChromium(seams({ env: { DG_VERIFY_BROWSER: "/opt/y" } }))).toBe("/opt/y");
	});

	test("finds Brave Beta when it is the only browser on PATH", () => {
		expect(findInstalledChromium(seams({ which: onPath("brave-browser-beta") }))).toBe(
			"/usr/bin/brave-browser-beta",
		);
	});

	test("prefers Brave over Chromium over Vivaldi", () => {
		expect(
			findInstalledChromium(seams({ which: onPath("vivaldi", "chromium", "brave") })),
		).toBe("/usr/bin/brave");
		expect(findInstalledChromium(seams({ which: onPath("vivaldi", "chromium") }))).toBe(
			"/usr/bin/chromium",
		);
	});

	test("finds a macOS app bundle that is not on PATH", () => {
		const app = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
		expect(
			findInstalledChromium(seams({ platform: "darwin", exists: (file) => file === app })),
		).toBe(app);
	});

	test("finds a Windows install under a Program Files prefix", () => {
		const exe = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
		expect(
			findInstalledChromium(
				seams({
					platform: "win32",
					env: { PROGRAMFILES: "C:\\Program Files" },
					exists: (file) => file === exe,
				}),
			),
		).toBe(exe);
	});

	test("returns null when nothing is installed", () => {
		expect(findInstalledChromium(seams())).toBeNull();
	});
});

describe("pickLaunch with other Chromium-family browsers", () => {
	test("picks an installed Brave before the downloaded Chromium", () => {
		expect(
			pickLaunch({
				system: () => false,
				installed: () => "/usr/bin/brave-browser-beta",
				downloaded: () => "/dl/chrome",
			}),
		).toEqual({ executablePath: "/usr/bin/brave-browser-beta" });
	});

	test("lets DG_BROWSER win over the Chrome channel", () => {
		expect(
			pickLaunch({
				override: () => "/opt/x/browser",
				system: () => true,
				installed: () => "/usr/bin/brave",
				downloaded: () => null,
			}),
		).toEqual({ executablePath: "/opt/x/browser" });
	});

	test("still prefers the Chrome channel over Brave", () => {
		expect(
			pickLaunch({
				system: (channel) => channel === "chrome",
				installed: () => "/usr/bin/brave",
				downloaded: () => null,
			}),
		).toEqual({ channel: "chrome" });
	});
});

describe("BrowserMissingError", () => {
	test("lists what it checked and DG_BROWSER before the download hint", () => {
		const message = new BrowserMissingError().message;
		for (const name of ["Chrome", "Edge", ...PATH_CANDIDATES]) expect(message).toContain(name);
		expect(message.indexOf("DG_BROWSER")).toBeLessThan(message.indexOf("install-browser"));
	});
});
