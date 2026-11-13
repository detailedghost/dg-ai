import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveDgPaths, withInstallLockSync } from "@dg/common/node";
import * as store from "../../src/server/config-store";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

function setup(contents?: string) {
	const dgHome = freshDgHome();
	homes.push(dgHome);
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	if (contents !== undefined) {
		mkdirSync(dirname(paths.daemonConfigPath), { recursive: true });
		writeFileSync(paths.daemonConfigPath, contents);
	}
	return paths;
}

const entry = { argv: ["/bin/x"], cwd: "/srv" };

describe("config-store strict reader", () => {
	it("returns {} when the file is absent", () => {
		expect(store.readConfigStrict(setup())).toEqual({});
	});

	it("returns the parsed object", () => {
		expect(store.readConfigStrict(setup('{"a":1}'))).toEqual({ a: 1 });
	});

	it.each(['{"a":', "[]"])("throws an Error naming the path for %s", (body) => {
		const paths = setup(body);
		expect(() => store.readConfigStrict(paths)).toThrow(paths.daemonConfigPath);
	});
});

describe("config-store services writer", () => {
	it("sets an entry and keeps pinnedOrigin and other entries", () => {
		const paths = setup(
			JSON.stringify({ pinnedOrigin: "https://x", services: { one: entry } }),
		);
		store.writeServiceEntry(paths, "two", { ...entry, autostart: true });
		expect(JSON.parse(readFileSync(paths.daemonConfigPath, "utf8"))).toEqual({
			pinnedOrigin: "https://x",
			services: { one: entry, two: { ...entry, autostart: true } },
		});
	});

	it("creates the file with mode 0600 when absent", () => {
		if (process.platform === "win32") return;
		const paths = setup();
		store.writeServiceEntry(paths, "one", entry);
		expect(statSync(paths.daemonConfigPath).mode & 0o777).toBe(0o600);
	});

	it("keeps the mode of an existing file", () => {
		if (process.platform === "win32") return;
		const paths = setup("{}");
		chmodSync(paths.daemonConfigPath, 0o640);
		store.writeServiceEntry(paths, "one", entry);
		expect(statSync(paths.daemonConfigPath).mode & 0o777).toBe(0o640);
	});

	it("writes through a symlink and keeps the link", () => {
		const paths = setup();
		const target = join(dirname(paths.daemonConfigPath), "real.json");
		mkdirSync(dirname(paths.daemonConfigPath), { recursive: true });
		writeFileSync(target, "{}");
		symlinkSync(target, paths.daemonConfigPath);
		store.writeServiceEntry(paths, "one", entry);
		expect(lstatSync(paths.daemonConfigPath).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8")).services.one).toEqual(
			entry,
		);
	});

	it("leaves services as {} after the last entry is deleted", () => {
		const paths = setup(
			JSON.stringify({ pinnedOrigin: "p", services: { one: entry } }),
		);
		store.writeServiceEntry(paths, "one", undefined);
		expect(JSON.parse(readFileSync(paths.daemonConfigPath, "utf8"))).toEqual({
			pinnedOrigin: "p",
			services: {},
		});
	});

	it("throws and leaves the bytes alone when services is not an object", () => {
		const body = '{"services":[1]}';
		const paths = setup(body);
		expect(() => store.writeServiceEntry(paths, "one", entry)).toThrow(
			`${paths.daemonConfigPath}: "services" must be an object`,
		);
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(body);
	});

	it("stores a __proto__ label as an own key without touching prototypes", () => {
		const paths = setup();
		store.writeServiceEntry(paths, "__proto__", entry);
		const written = JSON.parse(readFileSync(paths.daemonConfigPath, "utf8"));
		expect(Object.hasOwn(written.services, "__proto__")).toBe(true);
		expect(({} as Record<string, unknown>).argv).toBeUndefined();
	});

	it("throws on invalid JSON and leaves the bytes alone", () => {
		const paths = setup('{"a":');
		expect(() => store.writeServiceEntry(paths, "one", entry)).toThrow(
			paths.daemonConfigPath,
		);
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe('{"a":');
	});
});

const HOLD_MS = 400;
const holderScript = (storePath: string, dgHome: string) => `
import { dirname } from "node:path";
import { resolveDgPaths, withInstallLock } from "@dg/common/node";
import { writeServiceEntry } from ${JSON.stringify(storePath)};
const paths = resolveDgPaths({ env: { DG_HOME: ${JSON.stringify(dgHome)} } });
await withInstallLock(dirname(paths.daemonConfigPath), async () => {
	console.log("held");
	await Bun.sleep(${HOLD_MS});
	writeServiceEntry(paths, "svc", { argv: ["/bin/x"], cwd: "/srv" });
});
`;

describe("config-store writeConfig locking", () => {
	it("waits for the config lock a service command holds and keeps both writes", async () => {
		const dgHome = freshDgHome();
		homes.push(dgHome);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const lockFile = join(dirname(paths.daemonConfigPath), ".install.lock");
		mkdirSync(dirname(paths.daemonConfigPath), { recursive: true });
		const holder = Bun.spawn(
			[
				"bun",
				"-e",
				holderScript(
					resolve(import.meta.dir, "../../src/server/config-store"),
					dgHome,
				),
			],
			{
				cwd: resolve(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "inherit",
			},
		);
		const reader = holder.stdout.getReader();
		await reader.read();
		expect(existsSync(lockFile)).toBe(true);

		const started = performance.now();
		store.writeConfig(paths, { pinnedOrigin: "chrome-extension://x" });
		const waited = performance.now() - started;
		await holder.exited;

		expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2);
		const config = JSON.parse(readFileSync(paths.daemonConfigPath, "utf8"));
		expect(config.pinnedOrigin).toBe("chrome-extension://x");
		expect(config.services.svc).toEqual(entry);
	});

	it("throws instead of skipping the write when the config lock stays held", () => {
		const paths = setup("{}");
		withInstallLockSync(dirname(paths.daemonConfigPath), () => {
			expect(() => store.writeConfig(paths, { a: 1 })).toThrow("is held");
		});
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe("{}");
	});
});
