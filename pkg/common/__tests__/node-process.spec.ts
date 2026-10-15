import { describe, expect, it } from "bun:test";
import { isAlive, killProcessTree } from "../src/node/process";

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
