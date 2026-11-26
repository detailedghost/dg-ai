import { describe, expect, test } from "bun:test";
import { main } from "../src/pw/cli";
import {
	autoExtArgv,
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
		expect(resolve({ flags: { local: true, ext: true }, env: { DG_PW_MODE: "ext" }, config: "ext" }).mode).toBe("local");
	});

	test("--ext wins over the env and the config", () => {
		expect(resolve({ flags: { ext: true }, env: { DG_PW_MODE: "local" }, config: "local", extConnected: false }).mode).toBe("ext");
	});

	test("DG_PW_MODE wins over the config", () => {
		expect(resolve({ env: { DG_PW_MODE: "local" }, config: "ext" }).mode).toBe("local");
		expect(resolve({ env: { DG_PW_MODE: "ext" }, config: "local", extConnected: false }).mode).toBe("ext");
	});

	test("the config applies when no flag or env is set", () => {
		expect(resolve({ config: "local" })).toEqual({ mode: "local", reason: "config" });
		expect(resolve({ config: "ext", extConnected: false })).toEqual({ mode: "ext", reason: "config" });
	});

	test("an empty DG_PW_MODE counts as unset", () => {
		expect(resolve({ env: { DG_PW_MODE: "" }, config: "local" }).mode).toBe("local");
	});

	test("auto picks ext for an ext-capable verb when the extension is connected", () => {
		expect(resolve({ config: "auto" })).toEqual({ mode: "ext", reason: "auto: extension connected" });
		expect(resolve({})).toEqual({ mode: "ext", reason: "auto: extension connected" });
	});

	test("auto picks local when the extension is not connected", () => {
		expect(resolve({ extConnected: false })).toEqual({ mode: "local", reason: "auto: extension not connected" });
	});

	test("auto picks local for a verb the extension cannot run", () => {
		expect(resolve({ verb: "cookie-get" })).toEqual({ mode: "local", reason: "auto: verb is not ext-capable" });
	});

	test("DG_PW_MODE=auto is the same as no setting", () => {
		expect(resolve({ env: { DG_PW_MODE: "auto" } }).mode).toBe("ext");
	});

	test.each([...LOCAL_ONLY_VERBS])("%s never resolves to ext", (verb) => {
		expect(isExtCapable(verb)).toBe(false);
		expect(resolve({ verb, flags: { ext: true } }).mode).toBe("local");
		expect(resolve({ verb, env: { DG_PW_MODE: "ext" } }).mode).toBe("local");
		expect(resolve({ verb, config: "ext" }).mode).toBe("local");
		expect(resolve({ verb }).mode).toBe("local");
	});

	test.each(["auto", "ext", "local", "EXT", "Local"])("a mode word %s in DG_BROWSER points at DG_PW_MODE", (word) => {
		expect(() => resolve({ env: { DG_BROWSER: word } })).toThrow(
			`dg: DG_BROWSER is the browser executable path, not a pw mode. Next: set DG_PW_MODE=${word.toLowerCase()}.`,
		);
	});

	test("a browser path in DG_BROWSER does not touch the mode", () => {
		expect(resolve({ env: { DG_BROWSER: "/opt/x/browser" } }).mode).toBe("ext");
		expect(resolve({ env: { DG_BROWSER: "/opt/x/browser", DG_PW_MODE: "local" } }).mode).toBe("local");
	});

	test("an unknown DG_PW_MODE value names the key and the next step", () => {
		expect(() => resolve({ env: { DG_PW_MODE: "chrome" } })).toThrow(
			'dg pw: DG_PW_MODE must be ext, local or auto, got "chrome". Next: fix or unset DG_PW_MODE.',
		);
	});

	test("is pure: the same input gives the same answer and leaves the input alone", () => {
		const input: BrowserModeInput = { ...base, env: { DG_PW_MODE: "auto" } };
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
	test("DG_PW_MODE=local sends dg pw click to the Playwright daemon", async () => {
		const seen: string[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request.method);
			return { text: "clicked", exitCode: 0 };
		});
		const previous = process.env.DG_PW_MODE;
		process.env.DG_PW_MODE = "local";
		try {
			const env = clientEnv();
			expect(await main(["-s=web", "click", "e1"], env)).toBe(0);
			expect(seen).toEqual(["run"]);
		} finally {
			if (previous === undefined) delete process.env.DG_PW_MODE;
			else process.env.DG_PW_MODE = previous;
			daemon.dispose();
		}
	});

	test("a mode word in DG_BROWSER stops the call and names DG_PW_MODE", async () => {
		const previous = process.env.DG_BROWSER;
		process.env.DG_BROWSER = "Local";
		try {
			const env = clientEnv();
			expect(await main(["-s=web", "click", "e1"], env)).toBe(1);
			expect(env.stderr.join("")).toContain(
				"dg: DG_BROWSER is the browser executable path, not a pw mode. Next: set DG_PW_MODE=local.",
			);
		} finally {
			if (previous === undefined) delete process.env.DG_BROWSER;
			else process.env.DG_BROWSER = previous;
		}
	});

	test("--local sends the verb to the Playwright daemon even with DG_PW_MODE=ext", async () => {
		const seen: string[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request.method);
			return { text: "clicked", exitCode: 0 };
		});
		const previous = process.env.DG_PW_MODE;
		process.env.DG_PW_MODE = "ext";
		try {
			expect(await main(["-s=web", "--local", "click", "e1"], clientEnv())).toBe(0);
			expect(seen).toEqual(["run"]);
		} finally {
			if (previous === undefined) delete process.env.DG_PW_MODE;
			else process.env.DG_PW_MODE = previous;
			daemon.dispose();
		}
	});

	test.each([
		["goto", ["goto", "https://example.com"]],
		["tab-list", ["tab-list"]],
		["tab-new", ["tab-new", "https://example.com"]],
	])("DG_PW_MODE=ext maps %s to its ext verb", async (_verb, argv) => {
		const previous = process.env.DG_PW_MODE;
		process.env.DG_PW_MODE = "ext";
		try {
			const env = clientEnv();
			expect(await main(argv, env)).toBe(1);
			const message = env.stderr.join("\n");
			expect(message).toContain("pw --ext needs a dg daemon session");
			expect(message).not.toContain("Unknown pw --ext verb");
		} finally {
			if (previous === undefined) delete process.env.DG_PW_MODE;
			else process.env.DG_PW_MODE = previous;
		}
	});

	test("DG_DEBUG prints the chosen browser and why", async () => {
		const previous = process.env.DG_DEBUG;
		process.env.DG_DEBUG = "1";
		try {
			const env = clientEnv();
			await main(["--local", "--version"], env);
			expect(env.stderr.join("\n")).toContain("dg pw: local browser (--local)");
		} finally {
			if (previous === undefined) delete process.env.DG_DEBUG;
			else process.env.DG_DEBUG = previous;
		}
	});

	test("DG_DEBUG=0 keeps the browser choice quiet", async () => {
		const previous = process.env.DG_DEBUG;
		process.env.DG_DEBUG = "0";
		try {
			const env = clientEnv();
			await main(["--local", "--version"], env);
			expect(env.stderr.join("\n")).not.toContain("dg pw:");
		} finally {
			if (previous === undefined) delete process.env.DG_DEBUG;
			else process.env.DG_DEBUG = previous;
		}
	});

	test("--ext on a local-only verb names the verb and the local fix", async () => {
		const env = clientEnv();

		expect(await main(["--ext", "route", "**/*"], env)).toBe(2);
		expect(env.stderr.join("\n")).toContain("route runs only in local mode");
	});

	test("auto sends an ext-capable verb to the extension when it is connected", async () => {
		const seen: string[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request.method);
			return { text: "clicked", exitCode: 0 };
		});
		try {
			const env = clientEnv();
			expect(await main(["click", "e1"], env, undefined, async () => true)).toBe(1);
			expect(seen).toEqual([]);
			expect(env.stderr.join("\n")).toContain("pw --ext needs a dg daemon session");
		} finally {
			daemon.dispose();
		}
	});
});

describe("autoExtArgv", () => {
	test.each([
		[["goto", "https://x.test/"], ["open", "https://x.test/"]],
		[["open", "https://x.test/"], ["open", "https://x.test/"]],
		[["tab-list"], ["tabs"]],
		[["tab-new"], ["new"]],
		[["tab-new", "https://x.test/"], ["new", "https://x.test/"]],
		[["tab-close"], ["close"]],
		[["go-back"], ["go-back"]],
		[["go-forward"], ["go-forward"]],
		[["reload"], ["reload"]],
		[["click", "e1"], ["click", "e1"]],
		[["fill", "e1", "hello"], ["fill", "e1", "hello"]],
		[["hover", "e1"], ["hover", "e1"]],
		[["drag", "e1", "e2"], ["drag", "e1", "e2"]],
		[["mousewheel", "0", "-100"], ["mousewheel", "0", "-100"]],
		[["type", "hello", "--submit"], ["type", "hello", "--submit"]],
		[["eval", "document.title"], ["eval", "document.title"]],
		[["resize", "800", "600"], ["resize", "800", "600"]],
		[["localstorage-set", "a", "b"], ["localstorage-set", "a", "b"]],
		[["sessionstorage-clear"], ["sessionstorage-clear"]],
	])("maps %j to %j", (argv, expected) => {
		expect(autoExtArgv(argv)).toEqual(expected);
	});

	test.each([
		[["-s=web", "click", "e1"]],
		[["--session=web", "click", "e1"]],
		[["--session", "web", "click", "e1"]],
		[["--raw", "click", "e1"]],
		[["open"]],
		[["open", "--headless", "https://x.test/"]],
		[["tab-close", "2"]],
		[["tab-select", "1"]],
		[["select", "e1", "red"]],
		[["close"]],
		[["eval", "() => 1", "e1"]],
		[["eval", "() => 1", "--filename", "out.json"]],
		[["click", "e1", "--button", "right"]],
		[["snapshot", "--depth", "3"]],
		[["route", "**/*"]],
		[[]],
	])("leaves %j to local mode", (argv) => {
		expect(autoExtArgv(argv)).toBeUndefined();
	});
});
