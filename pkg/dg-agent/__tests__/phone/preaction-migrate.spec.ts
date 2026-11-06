import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { ensureLayout } from "@dg/common/node/layout";
import { Command } from "commander";
import { phoneLayoutHooks } from "../../src/layout-hooks";
import * as migrate from "../../src/phone/migrate";
import { type PhoneApi, registerPhoneGroup } from "../../src/phone/register";

const SRC = join(import.meta.dir, "..", "..", "src");
const MIGRATE_NOT_NEEDED = { migrated: false } as const;

let dir: string;
let paths: DgPaths;
let calls: string[];

beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dg-agent-preaction-migrate-"));
	paths = resolveDgPaths({ platform: "linux", homeDir: join(dir, "home"), env: {} });
	calls = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeApi(): PhoneApi {
	const record = (name: string) => async () => {
		calls.push(name);
	};
	return {
		deps: () => ({ paths }),
		openCloseDeps: () => ({ paths, write: () => {} }),
		phoneStatus: record("status"),
		phoneRefresh: record("refresh"),
		phoneRun: record("run"),
		phoneContacts: () => {
			calls.push("contacts");
		},
		phoneOpen: record("open"),
		ignoreHangup: () => {},
		runDeps: () => ({ paths }),
	} as unknown as PhoneApi;
}

function spyOnMigrate(impl: () => migrate.MigrationResult = () => MIGRATE_NOT_NEEDED) {
	return spyOn(migrate, "migrateIfNeeded").mockImplementation(() => {
		calls.push("migrate");
		return impl();
	});
}

async function drive(...argv: string[]): Promise<void> {
	const program = new Command().exitOverride();
	registerPhoneGroup(program, async () => fakeApi());
	program
		.command("memory")
		.command("search")
		.action(() => {
			calls.push("memory search");
		});
	await program.parseAsync(argv, { from: "user" });
}

const ensure = (): Promise<unknown> => ensureLayout(paths, { log: () => {} });

describe("the phone group preAction conversion", () => {
	it("converts once, before the verb body, for phone status", async () => {
		const spy = spyOnMigrate();
		await ensure();

		await drive("phone", "status");

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(paths);
		expect(calls).toEqual(["migrate", "status"]);
		spy.mockRestore();
	});

	it("converts for the refresh child that install starts", async () => {
		const spy = spyOnMigrate();
		await ensure();

		await drive("phone", "refresh");

		expect(spy).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["migrate", "refresh"]);
		spy.mockRestore();
	});

	it("never converts for the listen listener process", async () => {
		const spy = spyOnMigrate();
		await ensure();

		await drive("phone", "listen");

		expect(spy).not.toHaveBeenCalled();
		expect(calls).toEqual(["run"]);
		spy.mockRestore();
	});

	it("does not convert when the command skipped ensureLayout", async () => {
		const spy = spyOnMigrate();

		await drive("phone", "contacts");

		expect(spy).not.toHaveBeenCalled();
		expect(calls).toEqual(["contacts"]);
		spy.mockRestore();
	});

	it("does not convert for a command outside the phone group", async () => {
		const spy = spyOnMigrate();
		await ensure();

		await drive("memory", "search");

		expect(spy).not.toHaveBeenCalled();
		expect(calls).toEqual(["memory search"]);
		spy.mockRestore();
	});

	it("fails the phone verb with the conversion error and leaves memory search unaffected", async () => {
		const spy = spyOnMigrate(() => {
			throw new DgCliError("phone-friend line default is corrupt");
		});
		await ensure();

		await expect(drive("phone", "status")).rejects.toThrow("phone-friend line default is corrupt");
		await drive("memory", "search");

		expect(calls).toEqual(["migrate", "memory search"]);
		spy.mockRestore();
	});
});

describe("the phone group preAction with an unmoved entry", () => {
	function liveLine(): string {
		const line = join(paths.legacyHome, "phone-friend", "default");
		mkdirSync(line, { recursive: true });
		writeFileSync(join(line, "phone-friend.db"), "line");
		writeFileSync(join(line, "listener.pid"), JSON.stringify({ pid: process.pid }));
		return line;
	}

	it("refuses a phone verb while a per-line listener keeps phone-friend, before conversion and the body", async () => {
		const spy = spyOnMigrate();
		const line = liveLine();
		await ensureLayout(paths, { log: () => {} });

		await expect(drive("phone", "number")).rejects.toThrow(`dg: kept ${join(paths.legacyHome, "phone-friend")}`);

		expect(spy).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
		expect(existsSync(line)).toBe(true);
		expect(existsSync(paths.phoneRoot)).toBe(false);
		spy.mockRestore();
	});

	it("refuses a phone verb when the phone-friend move failed", async () => {
		const spy = spyOnMigrate();
		liveLine();
		const result = await ensureLayout(paths, { log: () => {} });
		Object.assign(result, { "phone-friend": { kind: "failed", from: "a", to: "b", error: "dg: kept a; moving it to b failed: boom" } });

		await expect(drive("phone", "number")).rejects.toThrow("boom");

		expect(spy).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
		spy.mockRestore();
	});

	it("lets phone close run while phone-friend is kept", async () => {
		const spy = spyOnMigrate();
		liveLine();
		await ensureLayout(paths, { log: () => {} });
		const api = { ...fakeApi(), phoneClose: async () => void calls.push("close") } as unknown as PhoneApi;
		const program = new Command().exitOverride();
		registerPhoneGroup(program, async () => api);

		await program.parseAsync(["phone", "close"], { from: "user" });

		expect(calls).toEqual(["migrate", "close"]);
		spy.mockRestore();
	});
});

describe("phone-friend conversion wiring", () => {
	it("keeps phone-friend out of phoneLayoutHooks", () => {
		const hooks = phoneLayoutHooks({ isOurListener: () => true, kill: () => {}, sleep: async () => {} });

		expect(Object.keys(hooks).filter((key) => key.includes("phone-friend"))).toEqual([]);
	});

	it("names migrateIfNeeded only in migrate.ts and register.ts", () => {
		const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC })].filter((file) => readFileSync(join(SRC, file), "utf8").includes("migrateIfNeeded"));

		expect(files.sort()).toEqual(["phone/migrate.ts", "phone/register.ts"]);
	});
});
