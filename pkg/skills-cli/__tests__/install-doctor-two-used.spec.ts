import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { runClean } from "../src/install/clean";
import { createContext } from "../src/doctor/runner";
import { installChecks } from "../src/install/doctor";
import { scratchFixtures } from "./git-repo-fixtures";

const fixtures = scratchFixtures();

afterEach(() => fixtures.cleanup());

const RENAME_SENTENCE = "Move the folder that you do not want to a different name, then run the command again";

function twoUsedHome() {
	const home = fixtures.tmp("doctor-two-used-");
	const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
	const legacy = join(paths.legacyHome, "daemon");
	for (const folder of [legacy, paths.daemonDir]) {
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "key"), "k");
	}
	return { home, paths, legacy };
}

describe("installChecks layout check with two used daemon folders", () => {
	test("warns with the two-used text and a fix that is the rename sentence, not dg-skills install", async () => {
		const { home, paths, legacy } = twoUsedHome();
		const check = installChecks.find((entry) => entry.id === "layout");
		if (!check) throw new Error("installChecks has no layout check");

		const result = await check.run(createContext({ home, env: { HOME: home }, paths }));

		expect(result.status).toBe("warn");
		expect(result.detail).toContain(`dg: two daemon folders hold data: ${legacy} and ${paths.daemonDir}.`);
		expect(result.fix).toContain(RENAME_SENTENCE);
		expect(result.fix).not.toContain("dg-skills install");
	});
});

describe("windows doctor order", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");

	afterEach(() => {
		if (platform) Object.defineProperty(process, "platform", platform);
	});

	test("reports the two-used fix when a live-writer block is also present", async () => {
		const { home, paths } = twoUsedHome();
		mkdirSync(join(paths.legacyHome, "phone"), { recursive: true });
		writeFileSync(join(paths.legacyHome, "phone", "listener.pid"), JSON.stringify({ pid: process.pid }));
		const check = installChecks.find((entry) => entry.id === "layout");
		if (!check) throw new Error("installChecks has no layout check");
		Object.defineProperty(process, "platform", { value: "win32" });

		const result = await check.run(createContext({ home, env: { HOME: home }, paths }));

		expect(result.detail).toContain("dg: kept ");
		expect(result.fix).toContain(RENAME_SENTENCE);
		expect(result.fix).not.toContain("stop the dg-daemon service");
	});
});

describe("dg-skills clean with two used daemon folders", () => {
	test("prints the two-used text, cleans nothing and moves nothing", async () => {
		const { paths, legacy } = twoUsedHome();
		const lines: string[] = [];

		const code = await runClean({ ...paths }, { log: (line: string) => void lines.push(line) });

		expect(code).toBe(1);
		expect(lines.join("\n")).toContain(
			`dg: two daemon folders hold data: ${legacy} and ${paths.daemonDir}. dg does not choose one and does not merge them. ${RENAME_SENTENCE}`,
		);
		expect(existsSync(join(legacy, "key"))).toBe(true);
		expect(existsSync(join(paths.daemonDir, "key"))).toBe(true);
	});
});
