import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LaunchSpec } from "../../src/pw/core/browser";
import { browsersDir, markerPath } from "../../src/pw/core/downloaded";
import { socketPathFor } from "../../src/pw/core/registry";
import { statePathFor, statesDir } from "../../src/pw/core/states";
import { validateSpec } from "../../src/pw/daemon";
import { useTempEnv, useTempScratch } from "../../src/pw/test-support";

useTempScratch();
useTempEnv("AI_STATE_DIR");
const dgHome = useTempEnv("DG_HOME");

const ENTRY = path.resolve(import.meta.dir, "../../src/index.ts");

const base: LaunchSpec = {
	name: "gh",
	key: "gh",
	socketPath: "/etc/hosts",
	cwd: "/tmp",
	outputDir: "/tmp",
	mode: "local",
	browser: "chrome",
	headless: true,
	scratch: false,
	codegen: false,
	profileDir: "/tmp/profiles/gh",
	executablePath: "/bin/sh",
};

const scratch: LaunchSpec = {
	...base,
	key: "gh@abc12345",
	scratch: true,
	profileDir: null,
};

const attached: LaunchSpec = {
	...base,
	mode: "cdp",
	profileDir: null,
	cdpUrl: "http://127.0.0.1:9222",
};

const windows: LaunchSpec = {
	...base,
	mode: "cdp",
	profileDir: "C:\\p\\gh",
	cdpUrl: "http://127.0.0.1:20001",
	winPid: 42,
};

const unreachable: LaunchSpec = { ...attached, cdpUrl: "http://127.0.0.1:1" };

describe("validateSpec", () => {
	test("rebuilds a client-shaped local spec from its known fields only", () => {
		expect(validateSpec({ ...base, extra: "x" })).toEqual({
			name: "gh",
			key: "gh",
			socketPath: socketPathFor("gh"),
			cwd: "/tmp",
			outputDir: "/tmp",
			mode: "local",
			browser: "chrome",
			headless: true,
			scratch: false,
			codegen: false,
			profileDir: "/tmp/profiles/gh",
		});
	});

	test.each([[null], [[]], ["spec"], [7]])(
		"rejects the non-object spec %p",
		(input) => {
			expect(() => validateSpec(input)).toThrow("must be a JSON object");
		},
	);

	test.each(["../x", "", "a b", ".hidden", "x".repeat(49), 7])(
		"rejects the session name %p",
		(name) => {
			expect(() => validateSpec({ ...base, name, key: name })).toThrow(
				"Invalid session name",
			);
		},
	);

	test.each(["../../../x", "a/b", "..", "gh@zz", "gh@abc12345", "other", 7])(
		"rejects the key %p for a persistent session",
		(key) => {
			expect(() => validateSpec({ ...base, key })).toThrow(
				"Invalid session key",
			);
		},
	);

	test("accepts a scratch key that carries an eight digit cwd hash", () => {
		expect(validateSpec(scratch).key).toBe("gh@abc12345");
	});

	test.each(["gh", "gh@abc", "other@abc12345"])(
		"rejects the scratch key %p",
		(key) => {
			expect(() => validateSpec({ ...scratch, key })).toThrow(
				"Invalid session key",
			);
		},
	);

	test("rejects an unknown browser", () => {
		expect(() => validateSpec({ ...base, browser: "netscape" })).toThrow(
			"browser must be one of",
		);
	});

	test.each([
		["outputDir", "relative/out"],
		["outputDir", "/tmp/../etc"],
		["outputDir", "/tmp/out/"],
		["cwd", "tmp"],
		["profileDir", "/tmp/a\0b"],
		["profileDir", null],
	])("rejects %s %p", (field, value) => {
		expect(() => validateSpec({ ...base, [field]: value })).toThrow(
			`${field} must be an absolute, normalized path`,
		);
	});

	test("rejects a profile directory on a scratch session", () => {
		expect(() => validateSpec({ ...scratch, profileDir: "/tmp/p" })).toThrow(
			"profileDir must be null",
		);
	});

	test.each(["headless", "scratch", "codegen"])(
		"rejects a non-boolean %s",
		(field) => {
			expect(() => validateSpec({ ...base, [field]: "yes" })).toThrow(
				`${field} must be true or false`,
			);
		},
	);

	test.each([-1, 1.5, "6"])(
		"rejects the snapshot depth %p",
		(snapshotDepth) => {
			expect(() => validateSpec({ ...base, snapshotDepth })).toThrow(
				"snapshotDepth must be a non-negative integer",
			);
		},
	);

	test("rejects an unknown mode", () => {
		expect(() => validateSpec({ ...base, mode: "x" })).toThrow(
			"mode must be local or cdp",
		);
	});
});

describe("validateSpec storage state", () => {
	test("accepts a saved state path", () => {
		const file = statePathFor("site");
		expect(validateSpec({ ...scratch, storageState: file }).storageState).toBe(
			file,
		);
	});

	test.each([
		() => "/etc/passwd",
		() => path.join(statesDir(), "..", "x.json"),
		() => path.join(statesDir(), "nested", "x.json"),
		() => path.join(statesDir(), "Upper.json"),
		() => path.join(statesDir(), "site.txt"),
	])("rejects a path outside the state dir (case %#)", (file) => {
		expect(() => validateSpec({ ...scratch, storageState: file() })).toThrow(
			"storageState must be a saved state",
		);
	});
});

describe("validateSpec downloaded Chromium", () => {
	function writeMarker(executablePath: string): void {
		mkdirSync(browsersDir(), { recursive: true });
		writeFileSync(
			markerPath(),
			JSON.stringify({ version: "1", executablePath }),
		);
	}

	test("uses the downloaded Chromium under the browsers dir", () => {
		const executablePath = path.join(browsersDir(), "chromium", "chrome");
		mkdirSync(path.dirname(executablePath), { recursive: true });
		writeFileSync(executablePath, "");
		writeMarker(executablePath);
		expect(validateSpec({ ...base, browser: "chromium" }).executablePath).toBe(
			executablePath,
		);
	});

	test("ignores a marker that points outside the browsers dir", () => {
		const outside = path.join(dgHome.dir, "elsewhere");
		writeFileSync(outside, "");
		writeMarker(outside);
		expect(validateSpec({ ...base, browser: "chromium" })).not.toHaveProperty(
			"executablePath",
		);
	});
});

describe("validateSpec CDP sessions", () => {
	test.each([
		"http://127.0.0.1:9222",
		"http://[::1]:9222/",
		"ws://127.0.0.1:9222/devtools/browser/abc",
	])("accepts the loopback endpoint %s", (cdpUrl) => {
		expect(validateSpec({ ...attached, cdpUrl }).cdpUrl).toBe(cdpUrl);
	});

	test.each([
		"http://evil.example:9222",
		"http://127.0.0.1.evil.example:9222",
		"http://localhost:9222",
	])("rejects the non-loopback endpoint %s", (cdpUrl) => {
		expect(() => validateSpec({ ...attached, cdpUrl })).toThrow("loopback");
	});

	test.each(["http://127.0.0.1", "http://127.0.0.1:0"])(
		"rejects the port in %s",
		(cdpUrl) => {
			expect(() => validateSpec({ ...attached, cdpUrl })).toThrow(
				"port from 1 to 65535",
			);
		},
	);

	test("requires a CDP URL", () => {
		const { cdpUrl: _omitted, ...missing } = attached;
		expect(() => validateSpec(missing)).toThrow("cdpUrl is required");
	});

	test("rejects a scratch CDP session", () => {
		expect(() =>
			validateSpec({ ...attached, scratch: true, key: "gh@abc12345" }),
		).toThrow("scratch must be false");
	});

	test("rejects a browser outside chrome and msedge", () => {
		expect(() => validateSpec({ ...attached, browser: "firefox" })).toThrow(
			"browser must be one of chrome, msedge",
		);
	});

	test("rejects a profile directory on an attached session", () => {
		expect(() => validateSpec({ ...attached, profileDir: "/tmp/p" })).toThrow(
			"profileDir must be null",
		);
	});

	test("accepts a Windows browser session", () => {
		expect(validateSpec(windows)).toMatchObject({
			mode: "cdp",
			browser: "chrome",
			profileDir: "C:\\p\\gh",
			winPid: 42,
		});
	});

	test.each([0, -3, 1.5, "42"])("rejects the Windows pid %p", (winPid) => {
		expect(() => validateSpec({ ...windows, winPid })).toThrow(
			"winPid must be a positive integer",
		);
	});

	test("rejects a Linux profile directory for a Windows browser", () => {
		expect(() => validateSpec({ ...windows, profileDir: "/tmp/p" })).toThrow(
			"must be a Windows path",
		);
	});

	test("rejects an unsafe Windows profile directory", () => {
		expect(() =>
			validateSpec({
				...windows,
				profileDir: 'C:\\p\\gh" --disable-web-security',
			}),
		).toThrow("Unsupported --profile");
	});
});

async function runDaemonProcess(
	...args: string[]
): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(
		[process.execPath, "run", ENTRY, "pw", "__daemon", ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		},
	);
	const [out, code] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	return { code, out };
}

describe("runDaemon", () => {
	test.each([
		["a traversal key", { ...unreachable, key: "../../../../tmp/pwn" }],
		["a bad session name", { ...unreachable, name: "../x", key: "../x" }],
		[
			"a storage state outside the state dir",
			{ ...unreachable, storageState: "/etc/passwd" },
		],
		[
			"a non-loopback CDP URL",
			{ ...unreachable, cdpUrl: "http://evil.example:9222" },
		],
	])("exits 2 before it starts a browser for %s", async (_label, spec) => {
		const { code, out } = await runDaemonProcess(JSON.stringify(spec));
		expect(code).toBe(2);
		expect(out).toStartWith("ERROR ");
		expect(out).not.toContain("READY");
	});

	test("exits 2 when the JSON argument is missing", async () => {
		const { code, out } = await runDaemonProcess();
		expect(code).toBe(2);
		expect(out).toBe("ERROR missing launch spec\n");
	});

	test("exits 2 when the JSON argument does not parse", async () => {
		const { code, out } = await runDaemonProcess("{not json");
		expect(code).toBe(2);
		expect(out).toBe("ERROR launch spec is not valid JSON\n");
	});
});
