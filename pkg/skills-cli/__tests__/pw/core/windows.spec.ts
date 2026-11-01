import { describe, expect, test } from "bun:test";
import {
	assertSafeProfileDir,
	buildStartArgs,
	CLOSE_SCRIPT,
	exePath,
	isWindowsPath,
	PROFILE_PATTERN,
	pickFreePort,
	powerShellPath,
	resolveWindowsBrowser,
	runPowerShell,
	START_SCRIPT,
	waitForCdp,
	wslToWindowsPath,
} from "../../../src/pw/core/windows";

const POWERSHELL_TIMEOUT_MS = 30_000;
const PROFILE = "C:\\Users\\me\\AppData\\Local\\playwright-cli\\profiles\\win";

describe("buildStartArgs", () => {
	test("builds the headed Chrome argument list", () => {
		expect(
			buildStartArgs({ port: 9333, profileDir: PROFILE, headless: false }),
		).toEqual([
			"--remote-debugging-port=9333",
			`--user-data-dir=${PROFILE}`,
			"--no-first-run",
			"--no-default-browser-check",
		]);
	});

	test("adds --headless=new only when headless", () => {
		const args = buildStartArgs({
			port: 9444,
			profileDir: PROFILE,
			headless: true,
		});
		expect(
			args.filter((arg) => arg.startsWith("--remote-debugging-port=")),
		).toEqual(["--remote-debugging-port=9444"]);
		expect(args.filter((arg) => arg.startsWith("--user-data-dir="))).toEqual([
			`--user-data-dir=${PROFILE}`,
		]);
		expect(args.filter((arg) => arg === "--headless=new")).toHaveLength(1);
		expect(args).toContain("--no-first-run");
		expect(args).toContain("--no-default-browser-check");
	});
});

describe("exePath and resolveWindowsBrowser", () => {
	const only = (file: string) => (candidate: string) => candidate === file;

	test("finds Chrome in Program Files", () => {
		expect(
			exePath(
				"chrome",
				only("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"),
			),
		).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
	});

	test("falls back to Edge when Chrome is absent", () => {
		const edge =
			"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
		expect(resolveWindowsBrowser(undefined, only(edge))).toEqual({
			browser: "msedge",
			exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		});
	});

	test("honors an explicit Edge request even when Chrome exists", () => {
		expect(resolveWindowsBrowser("msedge", () => true).browser).toBe("msedge");
	});

	test("fails when neither browser exists", () => {
		expect(() => resolveWindowsBrowser(undefined, () => false)).toThrow(
			"Neither Windows Chrome nor Windows Edge",
		);
	});
});

describe("pickFreePort", () => {
	test("stays below the WSL ephemeral range, which mirrored networking blocks for Windows listeners", async () => {
		for (let i = 0; i < 20; i++) {
			const port = await pickFreePort();
			expect(port).toBeGreaterThanOrEqual(20_000);
			expect(port).toBeLessThan(30_000);
		}
	});

	test("skips a port that something already listens on", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("busy"),
		});
		try {
			for (let i = 0; i < 20; i++)
				expect(await pickFreePort()).not.toBe(server.port);
		} finally {
			await server.stop(true);
		}
	});

	test("never binds the port in this process, so the Windows browser can", async () => {
		const port = await pickFreePort();
		await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
	});
});

describe("waitForCdp", () => {
	test("resolves once /json/version answers", async () => {
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				calls++;
				if (new URL(request.url).pathname !== "/json/version")
					return new Response("no", { status: 404 });
				return calls < 2
					? new Response("starting", { status: 503 })
					: Response.json({ Browser: "Chrome/1" });
			},
		});
		try {
			await expect(
				waitForCdp(`http://127.0.0.1:${server.port}`, 5_000),
			).resolves.toEqual({ Browser: "Chrome/1" });
			expect(calls).toBeGreaterThanOrEqual(2);
		} finally {
			await server.stop(true);
		}
	});

	test("names the port and the wait when nothing answers", async () => {
		const port = await pickFreePort();
		await expect(waitForCdp(`http://127.0.0.1:${port}`, 15)).rejects.toThrow(
			`Windows Chrome did not expose CDP on port ${port} within 0 s`,
		);
	});

	test("reports the timeout in whole seconds", async () => {
		const port = await pickFreePort();
		await expect(waitForCdp(`http://127.0.0.1:${port}`, 1_000)).rejects.toThrow(
			`Windows Chrome did not expose CDP on port ${port} within 1 s`,
		);
	});
});

describe("isWindowsPath", () => {
	test.each(["C:\\Users\\x", "d:\\a", "\\\\wsl.localhost\\Ubuntu\\home"])(
		"accepts %s",
		(value) => {
			expect(isWindowsPath(value)).toBe(true);
		},
	);

	test.each(["/mnt/c/Users/x", "profiles/x", "C:/x"])("rejects %s", (value) => {
		expect(isWindowsPath(value)).toBe(false);
	});
});

describe.skipIf(Bun.spawnSync(["which", "wslpath"]).exitCode !== 0)(
	"wslToWindowsPath",
	() => {
		test("maps a /mnt drive path to a drive letter path", () => {
			expect(wslToWindowsPath("/mnt/c/Users/x")).toBe("C:\\Users\\x");
		});

		test("maps a Linux path to the WSL UNC share", () => {
			expect(wslToWindowsPath("/home/x")).toMatch(
				/^\\\\wsl(\.localhost|\$)\\[^\\]+\\home\\x$/,
			);
		});
	},
);

describe("assertSafeProfileDir", () => {
	test("accepts a Windows path with spaces and an apostrophe", () => {
		expect(() =>
			assertSafeProfileDir("C:\\Users\\O'Neil\\My Profiles\\gh"),
		).not.toThrow();
	});

	test.each([
		["a double quote", 'C:\\p\\gh" --disable-web-security'],
		["a left single smart quote", "C:\\p\\gh\u2018; calc; \u2018"],
		["a right single smart quote", "C:\\p\\gh\u2019; calc; \u2019"],
		["a low single smart quote", "C:\\p\\gh\u201A"],
		["a reversed single smart quote", "C:\\p\\gh\u201B"],
		["a smart double quote", "C:\\p\\gh\u201C"],
		["a newline", "C:\\p\\gh\n--no-sandbox"],
		["a NUL byte", "C:\\p\\gh\u0000"],
		["a non-ASCII letter", "C:\\p\\gh\u00e9"],
		["an empty value", ""],
	])("rejects %s", (_label, value) => {
		expect(() => assertSafeProfileDir(value)).toThrow("Unsupported --profile");
	});
});

describe("PowerShell scripts", () => {
	test("read the profile, executable, and arguments from the environment, never from the script text", () => {
		for (const script of [CLOSE_SCRIPT, START_SCRIPT])
			expect(script).toContain("$env:PW_PROFILE");
		expect(START_SCRIPT).toContain("$env:PW_EXE");
		expect(START_SCRIPT).toContain("$env:PW_ARGS");
		expect(`${CLOSE_SCRIPT}${START_SCRIPT}`).not.toContain("C:\\");
	});

	test("match --user-data-dir only when the directory ends at a quote, a space, or the end", () => {
		expect(PROFILE_PATTERN).toContain("[regex]::Escape($env:PW_PROFILE)");
		expect(PROFILE_PATTERN).toContain('(?=["\\s]|$)');
	});

	test("a quoted profile must close right after the full path", () => {
		const jsPattern = (profile: string) => {
			const escaped = profile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
			return new RegExp(
				`--user-data-dir=(?:"${escaped}"|${escaped}(?=["\\s]|$))`,
				"i",
			);
		};
		expect(PROFILE_PATTERN).toContain(
			`--user-data-dir=(?:"' + $pwProfile + '"|' + $pwProfile + '(?=["\\s]|$))`,
		);
		const pattern = jsPattern("C:\\p\\gh");
		expect(pattern.test('--user-data-dir="C:\\p\\gh extra"')).toBe(false);
		expect(pattern.test('--user-data-dir="C:\\p\\gh"')).toBe(true);
		expect(pattern.test('"--user-data-dir=C:\\p\\gh" --x')).toBe(true);
		expect(pattern.test("--user-data-dir=C:\\p\\gh-work")).toBe(false);
	});
});

describe("powerShellPath", () => {
	const SYSTEM32 =
		"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

	test("prefers powershell.exe on PATH", () => {
		const asked: string[] = [];
		const found = powerShellPath(
			(command) => {
				asked.push(command);
				return "/usr/local/winbin/powershell.exe";
			},
			() => false,
		);
		expect(found).toBe("/usr/local/winbin/powershell.exe");
		expect(asked).toEqual(["powershell.exe"]);
	});

	test("falls back to the System32 copy when PATH has none", () => {
		const probed: string[] = [];
		const found = powerShellPath(
			() => null,
			(file) => {
				probed.push(file);
				return true;
			},
		);
		expect(found).toBe(SYSTEM32);
		expect(probed).toEqual([SYSTEM32]);
	});

	test("throws when neither PATH nor System32 has PowerShell", () => {
		expect(() =>
			powerShellPath(
				() => null,
				() => false,
			),
		).toThrow("PowerShell was not found");
	});
});

describe.skipIf(process.env["PW_E2E"] !== "1")("PowerShell bridge", () => {
	test(
		"hands values to PowerShell verbatim, including quotes and shell metacharacters",
		async () => {
			const value = "C:\\p\\o'n $(calc) `x` ;& 100%";
			expect(
				await runPowerShell("Write-Output $env:PW_PROFILE", {
					PW_PROFILE: value,
				}),
			).toBe(value);
		},
		POWERSHELL_TIMEOUT_MS,
	);

	test(
		"does not match a profile that only shares a prefix",
		async () => {
			const cases = [
				"C:\\p\\gh-work\\x",
				'"C:\\chrome.exe" --user-data-dir=C:\\p\\gh-work --no-first-run',
				'"C:\\chrome.exe" --user-data-dir=C:\\p\\gh',
				'"C:\\chrome.exe" --user-data-dir=C:\\p\\gh --no-first-run',
				'"C:\\chrome.exe" "--user-data-dir=C:\\p\\gh" --no-first-run',
				'"C:\\chrome.exe" --user-data-dir="C:\\p\\gh" --no-first-run',
				'"C:\\chrome.exe" --USER-DATA-DIR=c:\\P\\GH --no-first-run',
			];
			const script = [
				PROFILE_PATTERN,
				'($env:PW_CASES -split "\\n" | ForEach-Object { if ($_ -match $pattern) { "y" } else { "n" } }) -join ""',
			].join("\n");
			const output = await runPowerShell(script, {
				PW_PROFILE: "C:\\p\\gh",
				PW_CASES: cases.join("\n"),
			});
			expect(output).toBe("nnyyyyy");
		},
		POWERSHELL_TIMEOUT_MS,
	);
});
