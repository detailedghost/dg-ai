import { describe, expect, test } from "bun:test";
import { main } from "../../src/pw/cli";
import { COMMANDS, type CommandEntry } from "../../src/pw/commands/index";
import { type OpenDeps, runOpen } from "../../src/pw/commands/open/run";
import { BrowserMissingError } from "../../src/pw/core/browser";
import type { ClientHandler } from "../../src/pw/core/spec";
import {
	clientEnv,
	useTempEnv,
	useTempScratch,
} from "../../src/pw/test-support";

useTempScratch();
useTempEnv("AI_STATE_DIR");
useTempEnv("XDG_CACHE_HOME");

const forbidden = (name: string) => () => {
	throw new Error(`${name} must not run in this test`);
};

function commandsWithoutBrowser(started: string[]): readonly CommandEntry[] {
	const deps: OpenDeps = {
		isWSL: () => false,
		windowsBrowserPresent: () => false,
		pickLaunch: () => {
			throw new BrowserMissingError();
		},
		downloadedChromium: () => null,
		startDaemon: async (spec) => {
			started.push(spec.key);
			return 0;
		},
		startWindowsBrowser: forbidden("startWindowsBrowser"),
		closeWindowsBrowser: forbidden("closeWindowsBrowser"),
		windowsProfileDir: forbidden("windowsProfileDir"),
	};
	const open: ClientHandler = (args, env) => runOpen(args, env, deps);
	return COMMANDS.map((entry) =>
		entry.spec.name === "open"
			? { ...entry, load: async () => ({ default: open }) }
			: entry,
	);
}

describe("pw main with no browser installed", () => {
	test("pw open exits 3, prints the install-browser message, and starts no daemon", async () => {
		const started: string[] = [];
		const env = clientEnv();
		expect(await main(["open"], env, commandsWithoutBrowser(started))).toBe(3);
		expect(env.stderr).toEqual([
			"No browser found. Ask the user, then run: dg-skills pw install-browser (downloads about 150 MB)",
		]);
		expect(env.stdout).toEqual([]);
		expect(started).toEqual([]);
	});
});
