import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { type PhoneDeps, registerPhoneCommands } from "../../src/phone/commands";
import { addContact } from "../../src/phone/store";
import { EXEC_DEFAULT_TIMEOUT_S, phoneVaultAdd, phoneVaultExec, phoneVaultList, phoneVaultOpen, phoneVaultRm, type Terminal } from "../../src/phone/vault-commands";
import { ensureDayKey, localDay, openVaultItem, SELF_SENDER, storeVaultItem, VAULT_DIR, VAULT_TTL_SECONDS, vaultKeyName } from "../../src/phone/vault";
import { createFakeCredentials, type FakeCredentials } from "./fake-vault";
import { createFakePool, freshNpub, makeHomeTracker, makePhoneDeps, parseNdjson } from "./fake-pool";

const SECRET = "patient Jane Roe, MRN 12345";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const BUN = process.execPath;

const homes = makeHomeTracker("dg-phone-vault-cmd-");
let home: string;
let out: string;
let creds: FakeCredentials;
let stdin: Buffer | undefined;
let tty: string;
let viewed: { path: string; mode: number; bytes: number }[];
let terminal: Terminal;

function makeDeps(now?: number): PhoneDeps {
	const deps = makePhoneDeps({ home, pool: createFakePool(), write: (text) => (out += text), now });
	homes.trackDb(deps.db);
	return { ...deps, ...creds.deps(), readStdinBytes: async () => stdin, terminal };
}

let deps: PhoneDeps;

beforeEach(() => {
	home = homes.freshHome();
	out = "";
	stdin = undefined;
	tty = "";
	viewed = [];
	creds = createFakeCredentials();
	terminal = {
		interactive: true,
		env: {},
		write: (text) => (tty += text),
		view: async (path) => {
			viewed.push({ path, mode: statSync(path).mode & 0o777, bytes: statSync(path).size });
		},
	};
	deps = makeDeps();
});

afterEach(() => homes.cleanup());

function lines(): Record<string, unknown>[] {
	return parseNdjson([out]) as Record<string, unknown>[];
}

async function content(name: string, d: PhoneDeps = deps): Promise<Buffer> {
	const row = d.db.vaultItem(name);
	if (!row) throw new Error(`no item ${name}`);
	return openVaultItem(creds.deps(), d.paths.phoneRoot, row);
}

function file(name: string, data: string | Buffer): string {
	const path = join(home, name);
	writeFileSync(path, data);
	return path;
}

async function seed(name: string, data: string | Buffer, sender = SELF_SENDER): Promise<void> {
	const day = localDay(deps.now());
	const key = await ensureDayKey(creds.deps(), day);
	storeVaultItem(deps.db, deps.paths.phoneRoot, { name, sender, plain: Buffer.from(data), key: { day, key } }, deps.now());
}

describe("phone vault add", () => {
	it("stores a file and prints only the name, size, and dates", async () => {
		await phoneVaultAdd("lab", file("in.txt", SECRET), deps);

		expect(lines()).toEqual([{ name: "lab", size: SECRET.length, created_at: deps.now(), expires_at: deps.now() + VAULT_TTL_SECONDS }]);
		expect(out.includes("Jane")).toBe(false);
		expect((await content("lab")).toString()).toBe(SECRET);
	});

	it("reads raw bytes from stdin when no file is given", async () => {
		stdin = PNG;

		await phoneVaultAdd("shot", undefined, deps);

		expect((await content("shot")).equals(PNG)).toBe(true);
		expect(deps.db.vaultItem("shot")?.type).toBe("image/png");
	});

	it("refuses a bad name or a name with dot-dot, and stores nothing", async () => {
		for (const name of ["Lab", "../x", "a..b", "-a"]) {
			await expect(phoneVaultAdd(name, file("in.txt", SECRET), deps)).rejects.toThrow(/vault name/);
		}
		expect(deps.db.listVaultItems()).toEqual([]);
	});

	it("never overwrites an existing name", async () => {
		await phoneVaultAdd("lab", file("a.txt", "one"), deps);

		await expect(phoneVaultAdd("lab", file("b.txt", "two"), deps)).rejects.toThrow(/exists/);
		expect((await content("lab")).toString()).toBe("one");
	});

	it("refuses an empty item and one over 5 MiB", async () => {
		await expect(phoneVaultAdd("e", file("e.txt", ""), deps)).rejects.toThrow(/empty/);
		await expect(phoneVaultAdd("big", file("big.bin", Buffer.alloc(5 * 1024 * 1024 + 1)), deps)).rejects.toThrow(/5 MiB/);
		stdin = undefined;
		await expect(phoneVaultAdd("big", undefined, deps)).rejects.toThrow(/5 MiB/);
	});

	it("refuses when the credential store is not reachable, and writes no file", async () => {
		creds.up = false;

		await expect(phoneVaultAdd("lab", file("in.txt", SECRET), deps)).rejects.toThrow(/not reachable/);
		expect(existsSync(join(deps.paths.phoneRoot, VAULT_DIR))).toBe(false);
	});

	it("refuses when no session can make today's key, with no fallback key", async () => {
		creds.session = false;
		creds.granted = true;

		await expect(phoneVaultAdd("lab", file("in.txt", SECRET), deps)).rejects.toThrow(/no dg session/);
		expect(deps.db.listVaultItems()).toEqual([]);
	});

	it("deletes day keys two or more days old", async () => {
		creds.store.set(vaultKeyName(localDay(deps.now(), -2)), "a".repeat(64));
		creds.granted = true;

		await phoneVaultAdd("lab", file("in.txt", SECRET), deps);

		expect(creds.store.has(vaultKeyName(localDay(deps.now(), -2)))).toBe(false);
		expect(creds.store.has(vaultKeyName(localDay(deps.now())))).toBe(true);
	});
});

describe("phone vault list", () => {
	it("prints names, sizes, types, senders, and dates, never content", async () => {
		const npub = freshNpub();
		deps.db.putKey({ id: "default", nsec: null, in_store: 1 });
		addContact(deps.db, { npub, handle: "mom", relays: [], keyId: "default", addedAt: 0, via: "test" });
		await seed("mine", SECRET);
		await seed("theirs", "x", npub);

		await phoneVaultList(deps);

		expect(lines()).toEqual([
			{ name: "mine", size: SECRET.length, type: "text/plain", sender: "self", created_at: deps.now(), expires_at: deps.now() + VAULT_TTL_SECONDS },
			{ name: "theirs", size: 1, type: "text/plain", sender: "+mom", created_at: deps.now(), expires_at: deps.now() + VAULT_TTL_SECONDS },
		]);
		expect(out.includes("Jane")).toBe(false);
	});

	it("drops an item 24 hours after it was stored, file included", async () => {
		await seed("lab", SECRET);
		const later = makeDeps(deps.now() + VAULT_TTL_SECONDS);

		await phoneVaultList(later);

		expect(out).toBe("");
		expect(readdirSync(join(deps.paths.phoneRoot, VAULT_DIR))).toEqual([]);
	});

	it("refuses when the credential store is not reachable", async () => {
		creds.up = false;

		await expect(phoneVaultList(deps)).rejects.toThrow(/not reachable/);
	});
});

describe("phone vault rm", () => {
	it("deletes the row and the sealed file", async () => {
		await seed("lab", SECRET);

		await phoneVaultRm("lab", deps);

		expect(lines()).toEqual([{ removed: "lab" }]);
		expect(deps.db.vaultItem("lab")).toBeUndefined();
		expect(readdirSync(join(deps.paths.phoneRoot, VAULT_DIR))).toEqual([]);
	});

	it("fails on an unknown name", async () => {
		await expect(phoneVaultRm("nope", deps)).rejects.toThrow(/no vault item nope/);
	});
});

describe("phone vault open", () => {
	it("writes a text item to the terminal, never to stdout", async () => {
		await seed("lab", SECRET);

		await phoneVaultOpen("lab", deps);

		expect(tty).toBe(`${SECRET}\n`);
		expect(out).toBe("");
	});

	it("refuses inside a Claude Code or Codex session, and shows nothing", async () => {
		await seed("lab", SECRET);
		for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }, { CODEX_HOME: "/x" }]) {
			terminal.env = env;
			await expect(phoneVaultOpen("lab", deps)).rejects.toThrow(/human/);
		}
		expect(tty).toBe("");
		expect(out).toBe("");
	});

	it("refuses inside opencode, Gemini CLI, and a Grok CLI hook", async () => {
		await seed("lab", SECRET);
		for (const env of [{ OPENCODE: "1" }, { GEMINI_CLI: "1" }, { GROK_HOOK_EVENT: "PreToolUse" }]) {
			terminal.env = env;
			await expect(phoneVaultOpen("lab", deps)).rejects.toThrow(/human/);
		}
		expect(tty).toBe("");
	});

	it("still opens for a human whose shell only sets tool config such as OPENCODE_CONFIG_DIR or GROK_API_KEY", async () => {
		await seed("lab", SECRET);
		terminal.env = { OPENCODE_CONFIG_DIR: "/x", GROK_API_KEY: "k", GEMINI_API_KEY: "k" };

		await phoneVaultOpen("lab", deps);

		expect(tty).toBe(`${SECRET}\n`);
	});

	it("refuses without an interactive terminal on stdin and stdout", async () => {
		await seed("lab", SECRET);
		terminal.interactive = false;

		await expect(phoneVaultOpen("lab", deps)).rejects.toThrow(/interactive terminal/);
		expect(tty).toBe("");
	});

	it("hands an image to the viewer as a 0600 file in the vault folder, then deletes it", async () => {
		await seed("shot", PNG);

		await phoneVaultOpen("shot", deps);

		expect(viewed.length).toBe(1);
		expect(viewed[0]).toMatchObject({ mode: 0o600, bytes: PNG.length });
		expect(viewed[0]!.path.startsWith(join(deps.paths.phoneRoot, VAULT_DIR))).toBe(true);
		expect(viewed[0]!.path.endsWith(".png")).toBe(true);
		expect(existsSync(viewed[0]!.path)).toBe(false);
	});

	it("deletes the viewer copy even when the viewer fails", async () => {
		await seed("shot", PNG);
		let seen = "";
		terminal.view = async (path) => {
			seen = path;
			throw new Error("no viewer");
		};

		await expect(phoneVaultOpen("shot", deps)).rejects.toThrow();
		expect(existsSync(seen)).toBe(false);
	});

	it("refuses an expired item", async () => {
		await seed("lab", SECRET);

		await expect(phoneVaultOpen("lab", makeDeps(deps.now() + VAULT_TTL_SECONDS))).rejects.toThrow(/no vault item lab/);
		expect(tty).toBe("");
	});
});

describe("phone vault exec", () => {
	const upper = ["-e", "process.stdout.write((await Bun.stdin.text()).toUpperCase())"];

	it("feeds the item on stdin by default and stores stdout as <name>-out", async () => {
		await seed("lab", SECRET);

		await phoneVaultExec("lab", [BUN, ...upper], {}, deps);

		expect(lines()).toEqual([{ name: "lab", exit: 0, out: "lab-out", size: SECRET.length, stderr_lines: 0 }]);
		expect((await content("lab-out")).toString()).toBe(SECRET.toUpperCase());
		expect(out.includes("JANE")).toBe(false);
	});

	it("counts stderr lines and never prints them", async () => {
		await seed("lab", SECRET);

		await phoneVaultExec("lab", [BUN, "-e", "const t = await Bun.stdin.text(); console.error(t); console.error(t); console.error('tail')"], { out: "res" }, deps);

		expect(lines()[0]).toMatchObject({ exit: 0, out: "res", size: 0, stderr_lines: 3 });
		expect(out.includes("Jane")).toBe(false);
	});

	it("passes a text item in --env and closes stdin", async () => {
		await seed("lab", SECRET);

		await phoneVaultExec("lab", [BUN, "-e", "process.stdout.write(process.env.LAB_TEXT ?? 'missing')"], { env: "LAB_TEXT" }, deps);

		expect((await content("lab-out")).toString()).toBe(SECRET);
	});

	it("refuses --env with a bad variable name, a binary item, a NUL byte, or 64 KiB", async () => {
		await seed("lab", SECRET);
		await seed("bin", Buffer.from([0xff, 0xfe]));
		await seed("nul", "a\0b");
		await seed("big", "a".repeat(64 * 1024));
		const echo = [BUN, "-e", "0"];

		await expect(phoneVaultExec("lab", echo, { env: "lab" }, deps)).rejects.toThrow(/--env/);
		await expect(phoneVaultExec("lab", echo, { env: "1X" }, deps)).rejects.toThrow(/--env/);
		for (const name of ["bin", "nul", "big"]) await expect(phoneVaultExec(name, echo, { env: "X" }, deps)).rejects.toThrow(/--env/);
		expect(deps.db.listVaultItems().map((row) => row.name)).toEqual(["big", "bin", "lab", "nul"]);
	});

	it("drops DG and cloud credential variables from the child env and keeps PATH", async () => {
		await seed("lab", SECRET);
		const planted = {
			DG_SESSION_TOKEN: "s",
			DG_HOME: "/h",
			AWS_SECRET_ACCESS_KEY: "a",
			AWS_PROFILE: "p",
			AZURE_CLIENT_SECRET: "z",
			ARM_CLIENT_SECRET: "r",
			GOOGLE_APPLICATION_CREDENTIALS: "g",
			CLOUDSDK_AUTH_ACCESS_TOKEN: "c",
			GH_TOKEN: "t",
			GITHUB_TOKEN: "t",
		};
		const saved = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
		Object.assign(process.env, planted);
		try {
			await phoneVaultExec("lab", [BUN, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env: "LAB_TEXT" }, deps);
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}

		const names = JSON.parse((await content("lab-out")).toString()) as string[];
		for (const name of Object.keys(planted)) expect(names).not.toContain(name);
		expect(names).toContain("PATH");
		expect(names).toContain("LAB_TEXT");
	});

	it("refuses --env together with --stdin", async () => {
		await seed("lab", SECRET);

		await expect(phoneVaultExec("lab", [BUN, "-e", "0"], { env: "X", stdin: true }, deps)).rejects.toThrow(/--env and --stdin/);
	});

	it("never overwrites with --out and never runs the command then", async () => {
		await seed("lab", SECRET);
		await seed("res", "old");
		const marker = join(home, "ran");

		await expect(phoneVaultExec("lab", [BUN, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`], { out: "res" }, deps)).rejects.toThrow(/exists/);
		expect(existsSync(marker)).toBe(false);
		expect((await content("res")).toString()).toBe("old");
	});

	it("stores nothing and exits with the child's code when the command fails", async () => {
		await seed("lab", SECRET);

		const failed = phoneVaultExec("lab", [BUN, "-e", "process.stdout.write('partial'); process.exit(3)"], {}, deps);

		await expect(failed).rejects.toMatchObject({ exitCode: 3 });
		expect(lines()).toEqual([{ name: "lab", exit: 3, out: null, size: 7, stderr_lines: 0 }]);
		expect(deps.db.vaultItem("lab-out")).toBeUndefined();
	});

	it("stops a command whose output passes 5 MiB and stores nothing", async () => {
		await seed("lab", SECRET);

		await expect(phoneVaultExec("lab", [BUN, "-e", "process.stdout.write(Buffer.alloc(6 * 1024 * 1024, 97))"], {}, deps)).rejects.toThrow(/5 MiB/);
		expect(deps.db.vaultItem("lab-out")).toBeUndefined();
	});

	it("kills a command past --timeout, stores nothing, and exits 124", async () => {
		await seed("lab", SECRET);
		const started = Date.now();

		const run = phoneVaultExec("lab", [BUN, "-e", "process.stdout.write('x'); await Bun.sleep(30000)"], { timeout: "1" }, deps);

		await expect(run).rejects.toMatchObject({ exitCode: 124 });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(deps.db.vaultItem("lab-out")).toBeUndefined();
		expect(out).toBe("");
	});

	it("refuses a --timeout that is not 1 to 3600 seconds and runs nothing", async () => {
		await seed("lab", SECRET);
		const marker = join(home, "ran");
		const touch = [BUN, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`];

		for (const timeout of ["0", "-1", "abc", "3601"]) await expect(phoneVaultExec("lab", touch, { timeout }, deps)).rejects.toThrow(/--timeout/);
		expect(existsSync(marker)).toBe(false);
	});

	it("defaults the timeout to 120 seconds", () => {
		expect(EXEC_DEFAULT_TIMEOUT_S).toBe(120);
	});

	it("keeps the sender of the item it read on the item it makes", async () => {
		const npub = freshNpub();
		await seed("lab", SECRET, npub);

		await phoneVaultExec("lab", [BUN, ...upper], {}, deps);

		expect(deps.db.vaultItem("lab-out")?.sender).toBe(npub);
	});

	it("refuses an expired item and runs nothing", async () => {
		await seed("lab", SECRET);
		const marker = join(home, "ran");

		await expect(phoneVaultExec("lab", [BUN, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`], {}, makeDeps(deps.now() + VAULT_TTL_SECONDS))).rejects.toThrow(
			/no vault item lab/,
		);
		expect(existsSync(marker)).toBe(false);
	});

	it("names only the program when it cannot start", async () => {
		await seed("lab", SECRET);

		await expect(phoneVaultExec("lab", [join(home, "no-such-program")], {}, deps)).rejects.toThrow(/could not start/);
	});
});

describe("phone vault wiring", () => {
	it("routes add, list, exec after --, and rm through the CLI", async () => {
		const program = new Command();
		program.exitOverride();
		registerPhoneCommands(program, () => deps);
		const run = (args: string[]) => program.parseAsync(["phone", "vault", ...args], { from: "user" });

		await run(["add", "lab", file("in.txt", SECRET)]);
		await run(["exec", "lab", "--out", "res", "--timeout", "30", "--", BUN, "-e", "process.stdout.write((await Bun.stdin.text()).toUpperCase())"]);
		await run(["list"]);
		await run(["rm", "lab"]);

		expect(lines().map((line) => line.name ?? line.removed)).toEqual(["lab", "lab", "lab", "res", "lab"]);
		expect((await content("res")).toString()).toBe(SECRET.toUpperCase());
		expect(out.includes("Jane")).toBe(false);
	});
});
