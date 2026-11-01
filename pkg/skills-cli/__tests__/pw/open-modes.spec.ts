import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
	type OpenDeps,
	runOpen,
	WSL_HEADED_WARNING,
} from "../../src/pw/commands/open/run";
import spec from "../../src/pw/commands/open/spec";
import {
	BrowserMissingError,
	type LaunchSpec,
} from "../../src/pw/core/browser";
import { statePathFor } from "../../src/pw/core/states";
import { validateSpec } from "../../src/pw/daemon";
import {
	argsFor,
	clientEnv,
	useTempEnv,
	useTempScratch,
} from "../../src/pw/test-support";

useTempScratch();
useTempEnv("XDG_CACHE_HOME");
useTempEnv("AI_STATE_DIR");

function harness(overrides: Partial<OpenDeps> = {}) {
	const launched: LaunchSpec[] = [];
	const closed: string[] = [];
	const deps: OpenDeps = {
		isWSL: () => true,
		windowsBrowserPresent: () => false,
		pickLaunch: () => ({ channel: "chrome" }),
		downloadedChromium: () => null,
		startDaemon: async (launchSpec) => {
			launched.push(launchSpec);
			return 0;
		},
		startWindowsBrowser: async ({ browser, profileDir }) => ({
			browser: browser ?? "chrome",
			profileDir,
			port: 1,
			cdpUrl: "http://127.0.0.1:1",
			winPid: 7,
		}),
		closeWindowsBrowser: async (profileDir) => {
			closed.push(profileDir);
			return { forced: 0, remaining: 0 };
		},
		windowsProfileDir: async (name) => `C:\\profiles\\${name}`,
		...overrides,
	};
	return { deps, launched, closed };
}

describe("runOpen on WSL", () => {
	test("records a CDP session when a Windows browser exists", async () => {
		const { deps, launched } = harness({ windowsBrowserPresent: () => true });
		const env = clientEnv();
		expect(await runOpen(argsFor(spec), env, deps)).toBe(0);
		expect(launched[0]).toMatchObject({ mode: "cdp", winPid: 7 });
	});

	test("records a headless local session when no Windows browser exists", async () => {
		const { deps, launched } = harness();
		expect(await runOpen(argsFor(spec), clientEnv(), deps)).toBe(0);
		expect(launched[0]).toMatchObject({
			mode: "local",
			headless: true,
			browser: "chrome",
		});
	});

	test("--wsl-headed records a headed session and prints the experimental line once", async () => {
		const { deps, launched } = harness({ windowsBrowserPresent: () => true });
		const env = clientEnv();
		await runOpen(argsFor(spec, "--wsl-headed"), env, deps);
		expect(launched[0]).toMatchObject({ mode: "local", headless: false });
		expect(
			env.stderr.filter((line) => line === WSL_HEADED_WARNING),
		).toHaveLength(1);
	});

	test("--scratch stays local even when a Windows browser exists", async () => {
		const { deps, launched } = harness({ windowsBrowserPresent: () => true });
		await runOpen(argsFor(spec, "--scratch"), clientEnv(), deps);
		expect(launched[0]).toMatchObject({
			mode: "local",
			scratch: true,
			headless: true,
		});
	});

	test("--browser=chrome on WSL stays headless with no experimental line", async () => {
		const { deps, launched } = harness({ windowsBrowserPresent: () => true });
		const env = clientEnv();
		await runOpen(argsFor(spec, "--browser=chrome"), env, deps);
		expect(launched[0]).toMatchObject({
			mode: "local",
			browser: "chrome",
			headless: true,
		});
		expect(env.stderr).not.toContain(WSL_HEADED_WARNING);
	});
});

describe("runOpen browser selection", () => {
	test("uses the downloaded Chromium path when no channel exists", async () => {
		const { deps, launched } = harness({
			isWSL: () => false,
			pickLaunch: () => ({ executablePath: "/dl/chrome" }),
		});
		await runOpen(argsFor(spec), clientEnv(), deps);
		expect(launched[0]).toMatchObject({
			browser: "chromium",
			executablePath: "/dl/chrome",
		});
	});

	test("starts no daemon when no browser is installed", async () => {
		const { deps, launched } = harness({
			isWSL: () => false,
			pickLaunch: () => {
				throw new BrowserMissingError();
			},
		});
		await expect(
			runOpen(argsFor(spec), clientEnv(), deps),
		).rejects.toMatchObject({ exitCode: 3 });
		expect(launched).toEqual([]);
	});

	test("an explicit --browser skips the automatic pick", async () => {
		const { deps, launched } = harness({
			isWSL: () => false,
			pickLaunch: () => {
				throw new BrowserMissingError();
			},
		});
		await runOpen(argsFor(spec, "--browser=firefox"), clientEnv(), deps);
		expect(launched[0]).toMatchObject({ browser: "firefox" });
	});
});

describe("runOpen with an explicit chromium", () => {
	test("throws BrowserMissingError when no Chromium was downloaded", async () => {
		const { deps, launched } = harness();
		await expect(
			runOpen(argsFor(spec, "--browser=chromium"), clientEnv(), deps),
		).rejects.toBeInstanceOf(BrowserMissingError);
		expect(launched).toHaveLength(0);
	});

	test("launches the downloaded Chromium when one exists", async () => {
		const { deps, launched } = harness({
			downloadedChromium: () => "/dl/chromium/chrome",
		});
		await runOpen(argsFor(spec, "--browser=chromium"), clientEnv(), deps);
		expect(launched[0]).toMatchObject({
			mode: "local",
			browser: "chromium",
			executablePath: "/dl/chromium/chrome",
			headless: true,
		});
	});
});

describe("runOpen Windows mode cleanup", () => {
	test("closes the Windows browser through the injected seam when the daemon fails", async () => {
		const { deps, closed } = harness({
			windowsBrowserPresent: () => true,
			startDaemon: async (_spec, _url, _env, onFailure) => {
				await onFailure?.();
				return 1;
			},
		});
		expect(await runOpen(argsFor(spec), clientEnv(), deps)).toBe(1);
		expect(closed).toEqual(["C:\\profiles\\default"]);
	});
});

async function wireSpec(
	overrides: Partial<OpenDeps>,
	...argv: string[]
): Promise<unknown> {
	const { deps, launched } = harness(overrides);
	expect(await runOpen(argsFor(spec, ...argv), clientEnv(), deps)).toBe(0);
	expect(launched).toHaveLength(1);
	return JSON.parse(JSON.stringify(launched[0]));
}

describe("runOpen specs pass the daemon validator", () => {
	test("for a persistent local session", async () => {
		const wire = await wireSpec({ isWSL: () => false });
		expect(validateSpec(wire)).toMatchObject({
			mode: "local",
			key: "default",
			scratch: false,
		});
	});

	test("for a scratch local session with a snapshot depth", async () => {
		const wire = await wireSpec(
			{ isWSL: () => false },
			"--scratch",
			"--depth=3",
		);
		expect(validateSpec(wire)).toMatchObject({
			mode: "local",
			scratch: true,
			profileDir: null,
			snapshotDepth: 3,
		});
	});

	test("for a scratch session seeded from a saved state", async () => {
		writeFileSync(statePathFor("site"), '{"cookies":[],"origins":[]}');
		const wire = await wireSpec(
			{ isWSL: () => false },
			"--scratch",
			"--from=site",
		);
		expect(validateSpec(wire).storageState).toBe(statePathFor("site"));
	});

	test("for a headless local session inside WSL", async () => {
		const wire = await wireSpec({});
		expect(validateSpec(wire)).toMatchObject({ mode: "local", headless: true });
	});

	test("for a Windows browser session", async () => {
		const wire = await wireSpec({ windowsBrowserPresent: () => true });
		expect(validateSpec(wire)).toMatchObject({
			mode: "cdp",
			browser: "chrome",
			profileDir: "C:\\profiles\\default",
			winPid: 7,
		});
	});
});
