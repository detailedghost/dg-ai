import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { type DgPaths, resolveDgPaths, type SystemSeams } from "@dg/common/node";

const FENCE_MESSAGE = /^dg path fence: \w+ \S+ is outside /;

function linuxCall(env: Record<string, string>, homeDir = "/h"): SystemSeams {
	return { platform: "linux", homeDir, env };
}

function winCall(env: Record<string, string>): SystemSeams {
	return { platform: "win32", homeDir: "C:\\f\\h", env };
}

function thrownBy(call: () => unknown): Error {
	try {
		call();
	} catch (error) {
		return error as Error;
	}
	throw new Error("the call did not throw");
}

function rootsOf(paths: DgPaths): string[] {
	const { binDir, configDir, dataDir, stateDir, cacheDir, logDir, legacyHome } = paths;
	return [binDir, configDir, dataDir, stateDir, cacheDir, logDir, legacyHome];
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("resolveDgPaths fence", () => {
	it("returns the paths below DG_HOME when DG_HOME is inside the fence", () => {
		const paths = resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f", DG_HOME: "/f/x" }));

		expect(paths.stateDir).toBe(posix.join("/f/x", "state"));
		for (const root of rootsOf(paths)) expect(root.startsWith("/f/x")).toBe(true);
	});

	it("throws a fence error that names the role, the path and the fence when DG_HOME is outside", () => {
		const error = thrownBy(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f", DG_HOME: "/g" })),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(FENCE_MESSAGE);
		expect(error.message).toContain("/g");
		expect(error.message).toContain("is outside /f");
		expect(error.message.endsWith("(unset DG_PATH_FENCE to turn the fence off)")).toBe(true);
	});

	it("treats an empty DG_PATH_FENCE as no fence", () => {
		const env = { DG_HOME: "/empty-fence/g" };

		expect(resolveDgPaths(linuxCall({ ...env, DG_PATH_FENCE: "" }))).toEqual(
			resolveDgPaths(linuxCall(env)),
		);
	});

	it("accepts /f/x and refuses /f2/x for the fence /f/", () => {
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f/", DG_HOME: "/f/x" })),
		).not.toThrow();
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f/", DG_HOME: "/f2/x" })),
		).toThrow(/dg path fence:/);
	});

	it("throws is not absolute for a relative fence", () => {
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "f", DG_HOME: "/f/x" })),
		).toThrow("dg path fence: f is not absolute");
	});

	it("compares by segment so the fence /f does not accept /f2", () => {
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f", DG_HOME: "/f2/x" })),
		).toThrow(/dg path fence:/);
	});

	it("accepts a root that equals the fence", () => {
		const paths = resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f", DG_HOME: "/f" }));

		expect(paths.legacyHome).toBe("/f");
	});

	it("resolves both sides before the compare", () => {
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f/y/..", DG_HOME: "/f/a/../x" })),
		).not.toThrow();
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f", DG_HOME: "/f/../g" })),
		).toThrow(/dg path fence:/);
	});

	it("checks the roots a missing DG_HOME derives from the home folder", () => {
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f" }, "/f/home")),
		).not.toThrow();
		expect(() => resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f" }, "/g/home"))).toThrow(
			/dg path fence:/,
		);
	});

	it("checks legacyHome as well as the six roots", () => {
		const error = thrownBy(() =>
			resolveDgPaths(
				winCall({
					DG_PATH_FENCE: "C:\\f",
					LOCALAPPDATA: "C:\\f\\l",
					APPDATA: "C:\\f\\a",
					USERPROFILE: "C:\\g",
				}),
			),
		);

		expect(error.message).toMatch(FENCE_MESSAGE);
		expect(error.message).toContain("legacyHome");
	});

	it("returns normally for a root outside the fence only when no fence is set", () => {
		const env: Record<string, string> = { DG_HOME: "/g" };

		expect(() => resolveDgPaths(linuxCall(env))).not.toThrow();
		expect(() => resolveDgPaths(linuxCall({ ...env, DG_PATH_FENCE: "/f" }))).toThrow(
			/dg path fence:/,
		);
	});

	it("does not let a cached no-fence result pass a later call with a fence", () => {
		const env = { DG_HOME: "/cache-probe/g" };
		const unfenced = resolveDgPaths(linuxCall(env));

		expect(() => resolveDgPaths(linuxCall({ ...env, DG_PATH_FENCE: "/f" }))).toThrow(
			/dg path fence:/,
		);
		expect(resolveDgPaths(linuxCall(env))).toBe(unfenced);
	});

	it("adds nothing to the path cache when the call throws", () => {
		const reads = { count: 0 };
		const counted = (home: string): SystemSeams => ({
			platform: "linux",
			homeDir: "/h",
			env: new Proxy({ DG_HOME: home } as Record<string, string>, {
				get(target, name) {
					reads.count += 1;
					return target[name as string];
				},
			}),
		});
		const readsOf = (call: SystemSeams): number => {
			reads.count = 0;
			resolveDgPaths(call);
			return reads.count;
		};
		const fenced = counted("/no-cache-on-throw/a");
		(fenced.env as Record<string, string>).DG_PATH_FENCE = "/f";

		expect(() => resolveDgPaths(fenced)).toThrow(/dg path fence:/);
		const afterThrow = readsOf(counted("/no-cache-on-throw/a"));
		const freshMiss = readsOf(counted("/no-cache-on-throw/b"));
		const hit = readsOf(counted("/no-cache-on-throw/b"));

		expect(afterThrow).toBe(freshMiss);
		expect(hit).toBeLessThan(freshMiss);
	});

	it("rejects with win32 segment rules when the platform is win32", () => {
		expect(() =>
			resolveDgPaths(winCall({ DG_PATH_FENCE: "C:\\f", DG_HOME: "C:\\f2\\x" })),
		).toThrow(/dg path fence:/);
	});

	it("ignores letter case on win32", () => {
		const paths = resolveDgPaths(
			winCall({ DG_PATH_FENCE: "C:\\f", DG_HOME: "c:\\F\\x" }),
		);

		expect(paths.legacyHome.toLowerCase()).toBe("c:\\f\\x");
	});

	it("is case sensitive on linux", () => {
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: "/f", DG_HOME: "/F/x" })),
		).toThrow(/dg path fence:/);
	});

	it("returns an equal object to the unfenced call for each platform when the fence holds every root", () => {
		const cases: Array<[SystemSeams, string]> = [
			[{ platform: "linux", homeDir: "/h", env: {} }, "/"],
			[{ platform: "darwin", homeDir: "/h", env: {} }, "/"],
			[{ platform: "win32", homeDir: "C:\\h", env: {} }, "C:\\"],
			[{ platform: "linux", homeDir: "/h", env: { DG_HOME: "/d" } }, "/"],
		];
		for (const [seams, fence] of cases) {
			const plain = resolveDgPaths(seams);
			const fenced = resolveDgPaths({
				...seams,
				env: { ...seams.env, DG_PATH_FENCE: fence },
			});

			expect(fenced).toEqual(plain);
		}
	});

	it("reads the fence from seams.env, not from process.env, when seams.env is given", () => {
		const saved = process.env.DG_PATH_FENCE;
		cleanups.push(() => {
			if (saved === undefined) delete process.env.DG_PATH_FENCE;
			else process.env.DG_PATH_FENCE = saved;
		});
		process.env.DG_PATH_FENCE = "/f";

		expect(() => resolveDgPaths(linuxCall({ DG_HOME: "/seam-env/g" }))).not.toThrow();
	});

	it("reads the fence from process.env when no seams.env is given", () => {
		const saved = { fence: process.env.DG_PATH_FENCE, home: process.env.DG_HOME };
		cleanups.push(() => {
			for (const [key, value] of [
				["DG_PATH_FENCE", saved.fence],
				["DG_HOME", saved.home],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		});
		process.env.DG_PATH_FENCE = "/f";
		process.env.DG_HOME = "/process-env/g";

		expect(() => resolveDgPaths({ platform: "linux", homeDir: "/h" })).toThrow(
			/dg path fence:/,
		);
	});

	it("accepts a root below the real path of the fence when the fence is a link", () => {
		const base = mkdtempSync(join(tmpdir(), "dg-fence-link-"));
		cleanups.push(() => rmSync(base, { recursive: true, force: true }));
		const real = join(base, "real");
		const link = join(base, "link");
		mkdirSync(real);
		symlinkSync(real, link);

		expect(() =>
			resolveDgPaths(
				linuxCall({
					DG_PATH_FENCE: link,
					DG_HOME: join(realpathSync(link), "x"),
				}),
			),
		).not.toThrow();
	});

	it("uses the fence as given when the fence folder does not exist", () => {
		const fence = join(tmpdir(), "dg-fence-missing-folder");

		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: fence, DG_HOME: join(fence, "x") })),
		).not.toThrow();
		expect(() =>
			resolveDgPaths(linuxCall({ DG_PATH_FENCE: fence, DG_HOME: "/g-missing" })),
		).toThrow(/dg path fence:/);
	});

	it("follows a link created at a fence path that was missing on the first call", () => {
		const base = mkdtempSync(join(tmpdir(), "dg-fence-late-"));
		cleanups.push(() => rmSync(base, { recursive: true, force: true }));
		const real = join(base, "real");
		const fence = join(base, "late");
		mkdirSync(real);
		const env = { DG_PATH_FENCE: fence, DG_HOME: join(real, "x") };

		expect(() => resolveDgPaths(linuxCall(env))).toThrow(/dg path fence:/);
		symlinkSync(real, fence);
		expect(() => resolveDgPaths(linuxCall(env))).not.toThrow();
	});
});

describe("resolveDgPaths under the test fence", () => {
	it("throws the fence error when DG_HOME is absent and the home folder is outside the fence", () => {
		const outside = process.platform === "win32" ? "C:\\outside-fence-home" : "/outside-fence-home";
		const env = { DG_PATH_FENCE: resolve(tmpdir()) };

		expect(() => resolveDgPaths({ homeDir: outside, env })).toThrow(/dg path fence:/);
	});

	it("throws the fence error when DG_HOME is deleted and the process home is outside the fence", () => {
		const saved = { home: process.env.DG_HOME, fence: process.env.DG_PATH_FENCE };
		cleanups.push(() => {
			for (const [key, value] of [
				["DG_HOME", saved.home],
				["DG_PATH_FENCE", saved.fence],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		});
		delete process.env.DG_HOME;
		process.env.DG_PATH_FENCE = process.platform === "win32" ? "C:\\outside-fence-root" : "/outside-fence-root";

		expect(() => resolveDgPaths()).toThrow(/dg path fence:/);
	});
});
