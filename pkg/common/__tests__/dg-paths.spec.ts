import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { resolveDgPaths } from "@dg/common/node";

const home = "/h";

describe("resolveDgPaths on linux", () => {
	it("ignores a relative XDG root and uses the home default", () => {
		const paths = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { XDG_STATE_HOME: "state", XDG_CONFIG_HOME: "./cfg", XDG_DATA_HOME: "share", XDG_CACHE_HOME: "cache" },
		});

		expect(paths.stateDir).toBe("/h/.local/state/dg");
		expect(paths.configDir).toBe("/h/.config/dg");
		expect(paths.dataDir).toBe("/h/.local/share/dg");
		expect(paths.cacheDir).toBe("/h/.cache/dg");
	});

	it("uses the XDG defaults under the home folder", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: home, env: {} });

		expect(paths.binDir).toBe("/h/.local/bin");
		expect(paths.configDir).toBe("/h/.config/dg");
		expect(paths.dataDir).toBe("/h/.local/share/dg");
		expect(paths.stateDir).toBe("/h/.local/state/dg");
		expect(paths.cacheDir).toBe("/h/.cache/dg");
		expect(paths.logDir).toBe("/h/.local/state/dg/log");
	});

	it("honors XDG_DATA_HOME, XDG_STATE_HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME", () => {
		const paths = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: {
				XDG_DATA_HOME: "/x",
				XDG_STATE_HOME: "/s",
				XDG_CONFIG_HOME: "/c",
				XDG_CACHE_HOME: "/k",
			},
		});

		expect(paths.dataDir).toBe("/x/dg");
		expect(paths.stateDir).toBe("/s/dg");
		expect(paths.configDir).toBe("/c/dg");
		expect(paths.cacheDir).toBe("/k/dg");
		expect(paths.logDir).toBe("/s/dg/log");
	});

	it("ignores an empty XDG variable", () => {
		const paths = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { XDG_DATA_HOME: "" },
		});

		expect(paths.dataDir).toBe("/h/.local/share/dg");
	});
});

describe("resolveDgPaths on darwin", () => {
	it("uses the Library folders and ~/.local/bin", () => {
		const paths = resolveDgPaths({
			platform: "darwin",
			homeDir: home,
			env: { XDG_DATA_HOME: "/x" },
		});

		expect(paths.binDir).toBe("/h/.local/bin");
		expect(paths.configDir).toBe("/h/Library/Application Support/dg");
		expect(paths.dataDir).toBe("/h/Library/Application Support/dg");
		expect(paths.stateDir).toBe("/h/Library/Application Support/dg/state");
		expect(paths.cacheDir).toBe("/h/Library/Caches/dg");
		expect(paths.logDir).toBe("/h/Library/Logs/dg");
		expect(paths.phoneRoot).toBe(
			"/h/Library/Application Support/dg/state/phone",
		);
	});
});

describe("resolveDgPaths on win32", () => {
	const winHome = "C:\\Users\\u";

	it("uses APPDATA for config and LOCALAPPDATA for the rest", () => {
		const paths = resolveDgPaths({
			platform: "win32",
			homeDir: winHome,
			env: {
				APPDATA: "C:\\Users\\u\\AppData\\Roaming",
				LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
			},
		});

		expect(paths.configDir).toBe("C:\\Users\\u\\AppData\\Roaming\\dg");
		expect(paths.binDir).toBe("C:\\Users\\u\\AppData\\Local\\dg\\bin");
		expect(paths.dataDir).toBe("C:\\Users\\u\\AppData\\Local\\dg");
		expect(paths.stateDir).toBe("C:\\Users\\u\\AppData\\Local\\dg\\state");
		expect(paths.cacheDir).toBe("C:\\Users\\u\\AppData\\Local\\dg\\cache");
		expect(paths.logDir).toBe("C:\\Users\\u\\AppData\\Local\\dg\\log");
	});

	it("falls back to the AppData folders under the home folder", () => {
		const paths = resolveDgPaths({
			platform: "win32",
			homeDir: winHome,
			env: {},
		});

		expect(paths.configDir).toBe("C:\\Users\\u\\AppData\\Roaming\\dg");
		expect(paths.dataDir).toBe("C:\\Users\\u\\AppData\\Local\\dg");
	});
});

describe("resolveDgPaths with DG_HOME", () => {
	for (const platform of ["linux", "darwin"] as const) {
		it(`puts every root in a role folder under DG_HOME on ${platform}`, () => {
			const paths = resolveDgPaths({
				platform,
				homeDir: home,
				env: { DG_HOME: "/t", XDG_STATE_HOME: "/s" },
			});

			expect(paths.binDir).toBe("/t/bin");
			expect(paths.configDir).toBe("/t/config");
			expect(paths.dataDir).toBe("/t/data");
			expect(paths.stateDir).toBe("/t/state");
			expect(paths.cacheDir).toBe("/t/cache");
			expect(paths.logDir).toBe("/t/log");
		});
	}

	it("puts every root in a role folder under DG_HOME on win32", () => {
		const paths = resolveDgPaths({
			platform: "win32",
			homeDir: "C:\\Users\\u",
			env: { DG_HOME: "D:\\t", LOCALAPPDATA: "C:\\L" },
		});

		expect(paths.binDir).toBe("D:\\t\\bin");
		expect(paths.stateDir).toBe("D:\\t\\state");
		expect(paths.configDir).toBe("D:\\t\\config");
	});

	it("treats an empty DG_HOME as unset instead of a relative root", () => {
		const paths = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { DG_HOME: "" },
		});

		expect(paths.stateDir).toBe("/h/.local/state/dg");
		expect(posix.isAbsolute(paths.binDir)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("resolves a relative DG_HOME against the working folder", () => {
		const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: { DG_HOME: "rel-dg" } });

		expect(paths.dataDir).toBe(posix.join(process.cwd(), "rel-dg", "data"));
		expect(paths.binDir).toBe(posix.join(process.cwd(), "rel-dg", "bin"));
		expect(paths.legacyHome).toBe(posix.join(process.cwd(), "rel-dg"));
	});
});

describe("resolveDgPaths files", () => {
	it("places each file under its role root", () => {
		const paths = resolveDgPaths({
			platform: "linux",
			homeDir: home,
			env: { DG_HOME: "/t" },
		});

		expect(paths.configPath).toBe("/t/config/config.json");
		expect(paths.cliOnlyMarker).toBe("/t/config/cli-only");
		expect(paths.runtimeDir).toBe("/t/data/runtime");
		expect(paths.libDir).toBe("/t/data/lib");
		expect(paths.browsersDir).toBe("/t/data/browsers");
		expect(paths.skillsDir).toBe("/t/data/skills");
		expect(paths.personasDir).toBe("/t/data/agents");
		expect(paths.daemonDir).toBe("/t/state/daemon");
		expect(paths.pidPath).toBe("/t/state/daemon/daemon.pid");
		expect(paths.dbPath).toBe("/t/state/daemon/daemon.db");
		expect(paths.credentialsDbPath).toBe("/t/state/daemon/credentials.db");
		expect(paths.keyPath).toBe("/t/state/daemon/key");
		expect(paths.daemonConfigPath).toBe("/t/state/daemon/config.json");
		expect(paths.pairingPath).toBe("/t/state/pairing.json");
		expect(paths.agentsDir).toBe("/t/state/agents");
		expect(paths.sessionsDir).toBe("/t/state/agents/sessions");
		expect(paths.assetsDir).toBe("/t/state/agents/assets");
		expect(paths.memoryDbPath).toBe("/t/state/agents/memory.db");
		expect(paths.grantsDir).toBe("/t/state/grants");
		expect(paths.phoneRoot).toBe("/t/state/phone");
		expect(paths.phoneFriendRoot).toBe("/t/state/phone-friend");
	});

	it("uses win32 separators for every file on win32", () => {
		const paths = resolveDgPaths({
			platform: "win32",
			homeDir: "C:\\Users\\u",
			env: { LOCALAPPDATA: "C:\\L" },
		});

		expect(paths.dbPath).toBe(
			win32.join("C:\\L", "dg", "state", "daemon", "daemon.db"),
		);
		expect(paths.skillsDir).toBe("C:\\L\\dg\\skills");
	});
});

describe("resolveDgPaths legacyHome", () => {
	it("is <home>/.dg on posix when DG_HOME is unset", () => {
		expect(
			resolveDgPaths({ platform: "linux", homeDir: home, env: {} }).legacyHome,
		).toBe("/h/.dg");
		expect(
			resolveDgPaths({ platform: "darwin", homeDir: home, env: {} }).legacyHome,
		).toBe("/h/.dg");
	});

	it("is %USERPROFILE%\\.dg on win32", () => {
		const paths = resolveDgPaths({
			platform: "win32",
			homeDir: "C:\\Users\\h",
			env: { USERPROFILE: "C:\\Users\\u" },
		});

		expect(paths.legacyHome).toBe("C:\\Users\\u\\.dg");
	});
});

describe("resolveDgPaths memoization", () => {
	const linux = (env: Record<string, string | undefined> = {}) => ({
		platform: "linux" as const,
		homeDir: home,
		env,
	});

	it("returns the same object for two default calls", () => {
		expect(resolveDgPaths()).toBe(resolveDgPaths());
	});

	it("returns the default object for explicit seams that carry the same inputs", () => {
		expect(resolveDgPaths({ env: { ...process.env } })).toBe(resolveDgPaths());
	});

	it("returns the same object for two calls with equal explicit seams built separately", () => {
		expect(resolveDgPaths(linux({ XDG_DATA_HOME: "/x" }))).toBe(resolveDgPaths(linux({ XDG_DATA_HOME: "/x" })));
	});

	it("returns a different object when DG_HOME differs", () => {
		const other = resolveDgPaths({ env: { ...process.env, DG_HOME: "/other-dg-home" } });

		expect(other).not.toBe(resolveDgPaths());
		expect(other.dataDir).toBe("/other-dg-home/data");
	});

	it("resolves a relative DG_HOME against the working directory of each call", () => {
		const start = process.cwd();
		const first = realpathSync(mkdtempSync(join(tmpdir(), "dg-paths-a-")));
		const second = realpathSync(mkdtempSync(join(tmpdir(), "dg-paths-b-")));
		try {
			process.chdir(first);
			const before = resolveDgPaths(linux({ DG_HOME: "rel-home" }));
			process.chdir(second);
			const after = resolveDgPaths(linux({ DG_HOME: "rel-home" }));

			expect(before.dataDir).toBe(join(first, "rel-home", "data"));
			expect(after.dataDir).toBe(join(second, "rel-home", "data"));
		} finally {
			process.chdir(start);
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("returns a different object when any XDG value, the home or the platform differs", () => {
		const base = resolveDgPaths(linux());

		expect(resolveDgPaths(linux({ XDG_STATE_HOME: "/s" }))).not.toBe(base);
		expect(resolveDgPaths(linux({ XDG_CONFIG_HOME: "/c" }))).not.toBe(base);
		expect(resolveDgPaths({ ...linux(), homeDir: "/other-home" })).not.toBe(base);
		expect(resolveDgPaths({ ...linux(), platform: "darwin" })).not.toBe(base);
	});

	it("follows a mutated env object because the key is its values, not its identity", () => {
		const env: Record<string, string | undefined> = {};
		const before = resolveDgPaths(linux(env));
		env.XDG_DATA_HOME = "/moved";
		const after = resolveDgPaths(linux(env));

		expect(after).not.toBe(before);
		expect(after.dataDir).toBe("/moved/dg");
		expect(before.dataDir).toBe("/h/.local/share/dg");
	});

	it("ignores env names that the resolver never reads", () => {
		const base = resolveDgPaths(linux());

		expect(resolveDgPaths(linux({ PATH: "/bin", EDITOR: "vi" }))).toBe(base);
	});

	it("treats an env name set to undefined the same as an absent one", () => {
		expect(resolveDgPaths(linux({ DG_HOME: undefined }))).toBe(resolveDgPaths(linux()));
	});

	it("returns a different object per win32 root variable", () => {
		const win = (env: Record<string, string | undefined>) => ({ platform: "win32" as const, homeDir: "C:\\Users\\h", env });
		const base = resolveDgPaths(win({}));

		expect(resolveDgPaths(win({ LOCALAPPDATA: "D:\\local" }))).not.toBe(base);
		expect(resolveDgPaths(win({ APPDATA: "D:\\roaming" }))).not.toBe(base);
		expect(resolveDgPaths(win({ USERPROFILE: "D:\\profile" }))).not.toBe(base);
		expect(resolveDgPaths(win({ LOCALAPPDATA: "D:\\local" }))).toBe(resolveDgPaths(win({ LOCALAPPDATA: "D:\\local" })));
	});

	it("keeps one object per home when two homes interleave", () => {
		const first = resolveDgPaths({ ...linux(), homeDir: "/home-a" });
		const second = resolveDgPaths({ ...linux(), homeDir: "/home-b" });

		expect(first).not.toBe(second);
		expect(resolveDgPaths({ ...linux(), homeDir: "/home-a" })).toBe(first);
		expect(resolveDgPaths({ ...linux(), homeDir: "/home-b" })).toBe(second);
	});
});
