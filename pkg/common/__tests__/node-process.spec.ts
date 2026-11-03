import { describe, expect, it } from "bun:test";
import {
	isAlive,
	killProcessTree,
	type OpenSeams,
	openFailedHint,
	tryOpen,
	wslChromiumArgs,
} from "../src/node/process";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("isAlive", () => {
	it("is true when signal 0 succeeds", () => {
		expect(isAlive(1, () => {})).toBe(true);
	});

	it("is true on EPERM and false on ESRCH", () => {
		expect(
			isAlive(1, () => {
				throw errno("EPERM");
			}),
		).toBe(true);
		expect(
			isAlive(1, () => {
				throw errno("ESRCH");
			}),
		).toBe(false);
	});

	it("sees the current process by default", () => {
		expect(isAlive(process.pid)).toBe(true);
	});
});

describe("killProcessTree", () => {
	it("kills the group first on POSIX", () => {
		const calls: [number, string][] = [];
		killProcessTree(42, { platform: "linux", kill: (pid, sig) => calls.push([pid, sig]) });
		expect(calls).toEqual([[-42, "SIGKILL"]]);
	});

	it("falls back to the pid when the group kill fails", () => {
		const calls: number[] = [];
		killProcessTree(42, {
			platform: "linux",
			kill: (pid) => {
				calls.push(pid);
				if (pid < 0) throw errno("ESRCH");
			},
		});
		expect(calls).toEqual([-42, 42]);
	});

	it("swallows a failure of both kills", () => {
		expect(() =>
			killProcessTree(42, {
				platform: "linux",
				kill: () => {
					throw errno("ESRCH");
				},
			}),
		).not.toThrow();
	});

	it("runs taskkill on win32", () => {
		const calls: [string, string[]][] = [];
		killProcessTree(42, { platform: "win32", exec: (c, a) => calls.push([c, a]) });
		expect(calls).toEqual([["taskkill", ["/T", "/F", "/PID", "42"]]]);
	});
});

describe("wslChromiumArgs", () => {
	it("disables the GPU on WSL", () => {
		expect(wslChromiumArgs({}, true)).toEqual(["--disable-gpu"]);
	});

	it("keeps the GPU on WSL when PW_WSL_GPU is 1", () => {
		expect(wslChromiumArgs({ PW_WSL_GPU: "1" }, true)).toEqual([]);
	});

	it("disables the GPU on WSL for any other PW_WSL_GPU value", () => {
		expect(wslChromiumArgs({ PW_WSL_GPU: "true" }, true)).toEqual([
			"--disable-gpu",
		]);
	});

	it("adds nothing off WSL", () => {
		expect(wslChromiumArgs({}, false)).toEqual([]);
	});
});

function fakeSpawn(failing: string[] = []) {
	const calls: { command: string; args: string[] }[] = [];
	const spawn: NonNullable<OpenSeams["spawn"]> = (command, args) => {
		calls.push({ command, args });
		const listeners = new Map<string, () => void>();
		queueMicrotask(() =>
			listeners.get(failing.includes(command) ? "error" : "spawn")?.(),
		);
		return {
			on(event: "error" | "spawn", listener: () => void) {
				listeners.set(event, listener);
			},
			unref() {},
		};
	};
	return { calls, spawn };
}

const URL_TO_OPEN = "http://127.0.0.1:47823/chat#_chat=abc";

describe("tryOpen", () => {
	it("launches nothing on WSL without DG_OPEN_WINDOWS", async () => {
		const { calls, spawn } = fakeSpawn();

		const opened = await tryOpen(URL_TO_OPEN, {
			platform: "linux",
			wsl: true,
			requireWindowsOptIn: true,
			env: {},
			spawn,
		});

		expect(opened).toBe(false);
		expect(calls).toEqual([]);
	});

	it("launches nothing on WSL when DG_OPEN_WINDOWS is not exactly 1", async () => {
		const { calls, spawn } = fakeSpawn();

		const opened = await tryOpen(URL_TO_OPEN, {
			platform: "linux",
			wsl: true,
			requireWindowsOptIn: true,
			env: { DG_OPEN_WINDOWS: "true" },
			spawn,
		});

		expect(opened).toBe(false);
		expect(calls).toEqual([]);
	});

	it("opens the Windows browser on WSL with DG_OPEN_WINDOWS=1, trying wslview first", async () => {
		const { calls, spawn } = fakeSpawn(["wslview"]);

		const opened = await tryOpen(URL_TO_OPEN, {
			platform: "linux",
			wsl: true,
			requireWindowsOptIn: true,
			env: { DG_OPEN_WINDOWS: "1" },
			spawn,
		});

		expect(opened).toBe(true);
		expect(calls.map((call) => call.command)).toEqual([
			"wslview",
			"powershell.exe",
		]);
	});

	it("keeps opening the Windows browser on WSL for callers that do not require the opt-in", async () => {
		const { calls, spawn } = fakeSpawn();

		const opened = await tryOpen(URL_TO_OPEN, {
			platform: "linux",
			wsl: true,
			env: {},
			spawn,
		});

		expect(opened).toBe(true);
		expect(calls).toEqual([{ command: "wslview", args: [URL_TO_OPEN] }]);
	});

	it("uses xdg-open on Linux outside WSL", async () => {
		const { calls, spawn } = fakeSpawn();

		const opened = await tryOpen(URL_TO_OPEN, {
			platform: "linux",
			wsl: false,
			env: {},
			spawn,
		});

		expect(opened).toBe(true);
		expect(calls).toEqual([{ command: "xdg-open", args: [URL_TO_OPEN] }]);
	});

	it("uses open on macOS", async () => {
		const { calls, spawn } = fakeSpawn();

		const opened = await tryOpen(URL_TO_OPEN, {
			platform: "darwin",
			wsl: false,
			env: {},
			spawn,
		});

		expect(opened).toBe(true);
		expect(calls).toEqual([{ command: "open", args: [URL_TO_OPEN] }]);
	});

	it("returns false when every launcher fails", async () => {
		const { spawn } = fakeSpawn(["xdg-open"]);

		const opened = await tryOpen(URL_TO_OPEN, {
			platform: "linux",
			wsl: false,
			env: {},
			spawn,
		});

		expect(opened).toBe(false);
	});
});

describe("openFailedHint", () => {
	it("tells a WSL user how to opt in to the Windows browser", () => {
		expect(openFailedHint(true)).toBe(
			"could not open a browser; open the URL above (set DG_OPEN_WINDOWS=1 to open the Windows browser)",
		);
	});

	it("keeps the short hint off WSL", () => {
		expect(openFailedHint(false)).toBe(
			"could not open a browser; open the URL above",
		);
	});
});

