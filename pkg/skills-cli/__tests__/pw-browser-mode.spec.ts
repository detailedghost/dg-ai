import { describe, expect, test } from "bun:test";
import { main } from "../src/pw/cli";
import {
	type BrowserModeInput,
	isExtCapable,
	LOCAL_ONLY_VERBS,
	resolveBrowserMode,
	withoutLocalFlag,
} from "../src/pw/browser-mode";
import { clientEnv, startFakeDaemon, useTempScratch } from "../src/pw/test-support";

useTempScratch();

const base: BrowserModeInput = { flags: {}, env: {}, config: undefined, extConnected: true, verb: "click" };
const resolve = (input: Partial<BrowserModeInput>) => resolveBrowserMode({ ...base, ...input });

describe("resolveBrowserMode", () => {
	test("--local wins over --ext, the env and the config", () => {
		expect(resolve({ flags: { local: true, ext: true }, env: { DG_BROWSER: "ext" }, config: "ext" }).mode).toBe("local");
	});

	test("--ext wins over the env and the config", () => {
		expect(resolve({ flags: { ext: true }, env: { DG_BROWSER: "local" }, config: "local", extConnected: false }).mode).toBe("ext");
	});

	test("DG_BROWSER wins over the config", () => {
		expect(resolve({ env: { DG_BROWSER: "local" }, config: "ext" }).mode).toBe("local");
		expect(resolve({ env: { DG_BROWSER: "ext" }, config: "local", extConnected: false }).mode).toBe("ext");
	});

	test("the config applies when no flag or env is set", () => {
		expect(resolve({ config: "local" })).toEqual({ mode: "local", reason: "config" });
		expect(resolve({ config: "ext", extConnected: false })).toEqual({ mode: "ext", reason: "config" });
	});

	test("an empty DG_BROWSER counts as unset", () => {
		expect(resolve({ env: { DG_BROWSER: "" }, config: "local" }).mode).toBe("local");
	});

	test("auto picks ext for an ext-capable verb when the extension is connected", () => {
		expect(resolve({ config: "auto" })).toEqual({ mode: "ext", reason: "auto: extension connected" });
		expect(resolve({})).toEqual({ mode: "ext", reason: "auto: extension connected" });
	});

	test("auto picks local when the extension is not connected", () => {
		expect(resolve({ extConnected: false })).toEqual({ mode: "local", reason: "auto: extension not connected" });
	});

	test("auto picks local for a verb the extension cannot run", () => {
		expect(resolve({ verb: "eval" })).toEqual({ mode: "local", reason: "auto: verb is not ext-capable" });
	});

	test("DG_BROWSER=auto is the same as no setting", () => {
		expect(resolve({ env: { DG_BROWSER: "auto" } }).mode).toBe("ext");
	});

	test.each([...LOCAL_ONLY_VERBS])("%s never resolves to ext", (verb) => {
		expect(isExtCapable(verb)).toBe(false);
		expect(resolve({ verb, flags: { ext: true } }).mode).toBe("local");
		expect(resolve({ verb, env: { DG_BROWSER: "ext" } }).mode).toBe("local");
		expect(resolve({ verb, config: "ext" }).mode).toBe("local");
		expect(resolve({ verb }).mode).toBe("local");
	});

	test("an unknown DG_BROWSER value names the key and the next step", () => {
		expect(() => resolve({ env: { DG_BROWSER: "chrome" } })).toThrow(
			'dg pw: DG_BROWSER must be ext, local or auto, got "chrome". Next: fix or unset DG_BROWSER.',
		);
	});

	test("is pure: the same input gives the same answer and leaves the input alone", () => {
		const input: BrowserModeInput = { ...base, env: { DG_BROWSER: "auto" } };
		const frozen = structuredClone(input);

		expect(resolveBrowserMode(input)).toEqual(resolveBrowserMode(input));
		expect(input).toEqual(frozen);
	});
});

describe("withoutLocalFlag", () => {
	test("drops --local before the -- terminator only", () => {
		expect(withoutLocalFlag(["click", "--local", "e1", "--", "--local"])).toEqual({
			argv: ["click", "e1", "--", "--local"],
			local: true,
		});
		expect(withoutLocalFlag(["click", "e1"])).toEqual({ argv: ["click", "e1"], local: false });
	});
});

describe("pw main browser mode", () => {
	test("DG_BROWSER=local sends dg pw click to the Playwright daemon", async () => {
		const seen: string[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request.method);
			return { text: "clicked", exitCode: 0 };
		});
		const previous = process.env.DG_BROWSER;
		process.env.DG_BROWSER = "local";
		try {
			const env = clientEnv();
			expect(await main(["-s=web", "click", "e1"], env)).toBe(0);
			expect(seen).toEqual(["run"]);
		} finally {
			if (previous === undefined) delete process.env.DG_BROWSER;
			else process.env.DG_BROWSER = previous;
			daemon.dispose();
		}
	});

	test("--local sends the verb to the Playwright daemon even with DG_BROWSER=ext", async () => {
		const seen: string[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request.method);
			return { text: "clicked", exitCode: 0 };
		});
		const previous = process.env.DG_BROWSER;
		process.env.DG_BROWSER = "ext";
		try {
			expect(await main(["-s=web", "--local", "click", "e1"], clientEnv())).toBe(0);
			expect(seen).toEqual(["run"]);
		} finally {
			if (previous === undefined) delete process.env.DG_BROWSER;
			else process.env.DG_BROWSER = previous;
			daemon.dispose();
		}
	});

	test("--ext on a local-only verb names the verb and the local fix", async () => {
		const env = clientEnv();

		expect(await main(["--ext", "route", "**/*"], env)).toBe(2);
		expect(env.stderr.join("\n")).toContain("route runs only in local mode");
	});
});
