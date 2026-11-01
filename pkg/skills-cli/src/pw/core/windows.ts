import { existsSync } from "node:fs";
import { connect } from "node:net";
import { UsageError } from "./args";

export const WINDOWS_BROWSERS = ["chrome", "msedge"] as const;

export type WindowsBrowser = (typeof WINDOWS_BROWSERS)[number];

export type StartArgsOptions = {
	port: number;
	profileDir: string;
	headless: boolean;
};

export type WindowsLaunch = {
	browser: WindowsBrowser;
	port: number;
	cdpUrl: string;
	winPid: number;
	profileDir: string;
};

export type WindowsExit = { forced: number; remaining: number };

export const CDP_HOST = "127.0.0.1";
export const CDP_TIMEOUT_MS = 20_000;
const EXIT_WAIT_SECONDS = 8;
export const WINDOWS_ONLY_MESSAGE = "--windows supports chrome and msedge";

const SYSTEM32_POWERSHELL =
	"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const EXE_CANDIDATES: Record<WindowsBrowser, string[]> = {
	chrome: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	],
	msedge: [
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	],
};
const LOOPBACK = new Set([CDP_HOST, "::1"]);
const DRIVE_PATH = /^(?:[A-Za-z]:\\|\\\\)/;

export const isWindowsBrowser = (value: string): value is WindowsBrowser =>
	WINDOWS_BROWSERS.some((known) => known === value);

export const isWindowsPath = (value: string): boolean => DRIVE_PATH.test(value);

const toWslPath = (windowsPath: string): string =>
	windowsPath
		.replace(
			/^([A-Za-z]):/,
			(_, drive: string) => `/mnt/${drive.toLowerCase()}`,
		)
		.replaceAll("\\", "/");

export function exePath(
	browser: WindowsBrowser,
	exists: (file: string) => boolean = existsSync,
): string | null {
	return (
		EXE_CANDIDATES[browser].find((candidate) => exists(toWslPath(candidate))) ??
		null
	);
}

export function resolveWindowsBrowser(
	requested: WindowsBrowser | undefined,
	exists: (file: string) => boolean = existsSync,
): { browser: WindowsBrowser; exe: string } {
	const order: WindowsBrowser[] =
		requested === "msedge" ? ["msedge"] : ["chrome", "msedge"];
	for (const browser of order) {
		const exe = exePath(browser, exists);
		if (exe) return { browser, exe };
	}
	throw new Error(
		requested === "msedge"
			? "Windows Edge was not found"
			: "Neither Windows Chrome nor Windows Edge was found",
	);
}

export function buildStartArgs({
	port,
	profileDir,
	headless,
}: StartArgsOptions): string[] {
	return [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		...(headless ? ["--headless=new"] : []),
	];
}

const PORT_MIN = 20_000;
const PORT_SPAN = 10_000;
const PORT_ATTEMPTS = 50;

function isListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ port, host: CDP_HOST });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

export async function pickFreePort(): Promise<number> {
	for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
		const port = PORT_MIN + Math.floor(Math.random() * PORT_SPAN);
		if (!(await isListening(port))) return port;
	}
	throw new Error("No free port for the Windows browser");
}

export async function waitForCdp(
	url: string,
	timeoutMs: number = CDP_TIMEOUT_MS,
): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	do {
		try {
			const response = await fetch(`${url}/json/version`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return await response.json();
		} catch {
			await Bun.sleep(250);
		}
	} while (Date.now() < deadline);
	const port = new URL(url).port;
	throw new Error(
		`Windows Chrome did not expose CDP on port ${port} within ${Math.round(timeoutMs / 1000)} s`,
	);
}

export function wslToWindowsPath(file: string): string {
	const result = Bun.spawnSync(["wslpath", "-w", file]);
	if (result.exitCode !== 0)
		throw new Error(`Cannot translate ${file} to a Windows path`);
	return result.stdout.toString().trim();
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

export function assertSafeProfileDir(profileDir: string): void {
	if (!PRINTABLE_ASCII.test(profileDir) || profileDir.includes('"')) {
		throw new UsageError(
			"Unsupported --profile: use printable ASCII characters and no double quote",
		);
	}
}

export function powerShellPath(
	which: (command: string) => string | null = Bun.which,
	exists: (file: string) => boolean = existsSync,
): string {
	const onPath = which("powershell.exe");
	if (onPath) return onPath;
	if (exists(SYSTEM32_POWERSHELL)) return SYSTEM32_POWERSHELL;
	throw new Error(
		`PowerShell was not found on PATH or at ${SYSTEM32_POWERSHELL}`,
	);
}

export async function runPowerShell(
	script: string,
	variables: Record<string, string> = {},
	powershell: string = powerShellPath(),
): Promise<string> {
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const wslEnv = [process.env["WSLENV"], ...Object.keys(variables)]
		.filter(Boolean)
		.join(":");
	const child = Bun.spawn(
		[powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
		{
			env: { ...process.env, ...variables, WSLENV: wslEnv },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0)
		throw new Error(`PowerShell failed: ${stderr.trim() || stdout.trim()}`);
	return stdout.trim();
}

async function runCmd(command: string): Promise<string> {
	const child = Bun.spawn(["cmd.exe", "/c", command], {
		cwd: "/mnt/c",
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0)
		throw new Error(`cmd.exe failed: ${command}: ${stderr.trim()}`);
	return stdout.trim();
}

export async function windowsProfileDir(name: string): Promise<string> {
	const localAppData = await runCmd("echo %LOCALAPPDATA%");
	if (!isWindowsPath(localAppData))
		throw new Error("Cannot find the Windows LOCALAPPDATA directory");
	return `${localAppData}\\playwright-cli\\profiles\\${name}`;
}

async function listeners(port: number): Promise<string[]> {
	const output = await runCmd("netstat -an -p tcp");
	const suffix = `:${port}`;
	const addresses: string[] = [];
	for (const line of output.split("\n")) {
		const [, local, , state] = line.trim().split(/\s+/);
		if (state === "LISTENING" && local?.endsWith(suffix))
			addresses.push(local.slice(0, -suffix.length).replace(/^\[|\]$/g, ""));
	}
	return addresses;
}

export const PROFILE_PATTERN = `$pwProfile = [regex]::Escape($env:PW_PROFILE); $pattern = '--user-data-dir=(?:"' + $pwProfile + '"|' + $pwProfile + '(?=["\\s]|$))'`;

const FIND_PROFILE_PROCESSES = `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })`;

export const CLOSE_SCRIPT = [
	PROFILE_PATTERN,
	`$ids = ${FIND_PROFILE_PROCESSES} | ForEach-Object { $_.ProcessId }`,
	`if ($ids.Count -gt 0) { Wait-Process -Id $ids -Timeout ${EXIT_WAIT_SECONDS} -ErrorAction SilentlyContinue }`,
	`$left = ${FIND_PROFILE_PROCESSES}`,
	"$forced = $left.Count",
	"foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
	"if ($forced -gt 0) { Start-Sleep -Milliseconds 500 }",
	`$remaining = ${FIND_PROFILE_PROCESSES}`,
	'Write-Output "$forced $($remaining.Count)"',
].join("\n");

export const START_SCRIPT = [
	PROFILE_PATTERN,
	`if (${FIND_PROFILE_PROCESSES}.Count -gt 0) { Write-Output 'IN_USE'; exit 0 }`,
	`$list = @($env:PW_ARGS -split "\\n" | ForEach-Object { if ($_ -match '\\s') { '"' + $_ + '"' } else { $_ } })`,
	"(Start-Process -FilePath $env:PW_EXE -ArgumentList $list -PassThru).Id",
].join("\n");

export async function closeWindowsBrowser(
	profileDir: string,
): Promise<WindowsExit> {
	assertSafeProfileDir(profileDir);
	const output = await runPowerShell(CLOSE_SCRIPT, { PW_PROFILE: profileDir });
	const [forced = 0, remaining = 0] = output.split(/\s+/).map(Number);
	return { forced, remaining };
}

export async function startWindowsBrowser(options: {
	browser?: WindowsBrowser | undefined;
	profileDir: string;
	headless: boolean;
	timeoutMs?: number;
}): Promise<WindowsLaunch> {
	assertSafeProfileDir(options.profileDir);
	const { browser, exe } = resolveWindowsBrowser(options.browser);
	const port = await pickFreePort();
	const args = buildStartArgs({
		port,
		profileDir: options.profileDir,
		headless: options.headless,
	});
	const output = await runPowerShell(START_SCRIPT, {
		PW_PROFILE: options.profileDir,
		PW_EXE: exe,
		PW_ARGS: args.join("\n"),
	});
	if (output === "IN_USE") {
		throw new Error(
			`A Windows browser already uses ${options.profileDir}. Close it, or pick another -s=<name> or --profile.`,
		);
	}
	const winPid = Number.parseInt(output, 10);
	if (!Number.isInteger(winPid))
		throw new Error(`Start-Process returned no process id: ${output}`);

	const cdpUrl = `http://${CDP_HOST}:${port}`;
	try {
		await waitForCdp(cdpUrl, options.timeoutMs ?? CDP_TIMEOUT_MS);
		const addresses = await listeners(port);
		if (
			addresses.length === 0 ||
			addresses.some((address) => !LOOPBACK.has(address))
		) {
			throw new Error(
				`CDP port ${port} is not bound to loopback only (${addresses.join(", ") || "no listener found"})`,
			);
		}
	} catch (error) {
		await closeWindowsBrowser(options.profileDir).catch(() => undefined);
		throw error;
	}
	return { browser, port, cdpUrl, winPid, profileDir: options.profileDir };
}
