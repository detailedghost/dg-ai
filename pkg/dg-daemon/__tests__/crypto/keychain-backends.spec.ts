import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import {
	createKeychainBackendForPlatform,
	guardedBackend,
	dpapiBackend,
	keychainAccountFor,
	keychainAccountsForPaths,
	macKeychainBackend,
	RealKeychainInTestError,
	secretToolBackend,
} from "../../src/crypto/keychain-backends";
import type { KeychainBackend } from "../../src/crypto/key-resolution";
import { ChatStore } from "../../src/store";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";
import { type FakeKeychain, fakeKeychain, OTHER_SECRET, SECRET } from "../utils/fake-keychain";

const HOME = "/home/someone";

describe("keychainAccountFor", () => {
	it("keeps the legacy account name for the default home so the existing entry is still found", () => {
		expect(keychainAccountFor(`${HOME}/.dg`, HOME)).toBe("chat-store-kek");
		expect(keychainAccountFor(`${HOME}/.dg/`, HOME)).toBe("chat-store-kek");
	});

	it("scopes every other state dir to its own account", () => {
		const a = keychainAccountFor("/tmp/dg-a", HOME);
		const b = keychainAccountFor("/tmp/dg-b", HOME);

		expect(a).toMatch(/^chat-store-kek:[0-9a-f]{12}$/);
		expect(b).toMatch(/^chat-store-kek:[0-9a-f]{12}$/);
		expect(a).not.toBe(b);
		expect(a).toBe(keychainAccountFor("/tmp/dg-a/", HOME));
	});
});

describe("keychainAccountsForPaths", () => {
	it("names the new account after the state root and the old one after the old flat home", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: HOME, env: {} });

		expect(keychainAccountsForPaths(paths, HOME)).toEqual({
			current: keychainAccountFor(paths.stateDir, HOME),
			legacy: "chat-store-kek",
		});
	});

	it("scopes a DG_HOME install by its state folder now and by DG_HOME before", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: HOME, env: { DG_HOME: "/tmp/dg-a" } });

		expect(keychainAccountsForPaths(paths, HOME)).toEqual({
			current: keychainAccountFor("/tmp/dg-a/state", HOME),
			legacy: keychainAccountFor("/tmp/dg-a", HOME),
		});
	});
});

describe("createKeychainBackendForPlatform", () => {
	const paths = resolveDgPaths({ platform: "linux", homeDir: HOME, env: {} });
	const accounts = keychainAccountsForPaths(paths, HOME);

	function build(current: FakeKeychain, legacy: FakeKeychain): KeychainBackend {
		const byAccount = new Map([
			[accounts.current, current.backend],
			[accounts.legacy, legacy.backend],
		]);
		const backend = createKeychainBackendForPlatform(paths, {
			platform: "linux",
			backendFor: (account: string) => byAccount.get(account) as KeychainBackend,
		} as never);
		return backend as KeychainBackend;
	}

	it("reads the current account first and never asks the legacy account when the current one holds a key", async () => {
		const current = fakeKeychain(SECRET);
		const legacy = fakeKeychain(OTHER_SECRET);

		expect(await build(current, legacy).lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(legacy.calls).toEqual([]);
	});

	it("falls back to the legacy account read-only when the current account is absent", async () => {
		const current = fakeKeychain(undefined);
		const legacy = fakeKeychain(SECRET);

		expect(await build(current, legacy).lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(current.count("store") + current.count("remove")).toBe(0);
		expect(legacy.count("store") + legacy.count("remove")).toBe(0);
	});

	it("returns the current key when a concurrent step deletes the legacy entry between the two reads", async () => {
		const current = fakeKeychain(SECRET, { reads: [{ status: "absent" }] });
		const legacy = fakeKeychain(undefined);

		expect(await build(current, legacy).lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(current.count("lookup")).toBe(2);
	});

	it("reports absent only when both accounts are absent", async () => {
		expect(await build(fakeKeychain(undefined), fakeKeychain(undefined)).lookup()).toEqual({ status: "absent" });
	});

	it("reports unreachable, not absent, when the current account is absent and the legacy one cannot be read", async () => {
		const legacy = fakeKeychain(undefined, { lookupUnreachable: true });

		expect(await build(fakeKeychain(undefined), legacy).lookup()).toEqual({ status: "unreachable" });
	});

	it("reports unreachable when the current account cannot be read", async () => {
		const current = fakeKeychain(undefined, { lookupUnreachable: true });

		expect(await build(current, fakeKeychain(SECRET)).lookup()).toEqual({ status: "unreachable" });
	});

	it("stores and removes on the current account only", async () => {
		const current = fakeKeychain(undefined);
		const legacy = fakeKeychain(SECRET);
		const backend = build(current, legacy);

		expect(await backend.store(OTHER_SECRET)).toBe("stored");
		expect(await backend.remove?.()).toBe("removed");

		expect(current.calls).toEqual(["store", "remove"]);
		expect(legacy.calls).toEqual([]);
		expect(legacy.value).toBe(SECRET);
	});
});

describe("test-run guard for the real keychain backends", () => {
	it.each([
		["secret-tool", () => secretToolBackend("chat-store-kek")],
		["security", () => macKeychainBackend("chat-store-kek")],
		["powershell", () => dpapiBackend("/tmp/key.dpapi")],
	])("refuses to build the %s backend", (_name, build) => {
		expect(build).toThrow(RealKeychainInTestError);
	});

	it("refuses the platform default backend", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: "/tmp/dg-guard" } });

		expect(() => createKeychainBackendForPlatform(paths)).toThrow(
			RealKeychainInTestError,
		);
	});

	it("fails a store opened without a fake backend or DG_KEY_SOURCE=file", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });

			await expect(ChatStore.open(paths, { env: {} })).rejects.toThrow(
				RealKeychainInTestError,
			);
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

const KEY = "dGVzdC1rZXktYnl0ZXMtZm9yLXN0b3JlLWNoZWNr/+==";

type StoreRun = { stored: string; childOut: string; argv: string; stdin: string };

async function runStore(
	backendCall: string,
	fakeName: "security" | "powershell.exe",
	fakeScript: string,
	{ env: fakeEnv = {}, key = KEY }: { env?: Record<string, string>; key?: string } = {},
): Promise<StoreRun> {
	const bin = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dg-fake-store-"));
	try {
		writeFileSync(join(bin, fakeName), fakeScript.replaceAll("$DIR", bin), { mode: 0o755 });
		const script = `import { dpapiBackend, macKeychainBackend } from ${JSON.stringify(join(import.meta.dir, "../../src/crypto/keychain-backends"))};
process.stdout.write(await ${backendCall}.store(${JSON.stringify(key)}));`;
		const { NODE_ENV: _omitted, ...inherited } = process.env;
		const child = Bun.spawn([process.execPath, "-e", script], {
			env: { ...inherited, ...fakeEnv, PATH: bin },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		await child.exited;
		const read = (name: string): string => (existsSync(join(bin, name)) ? readFileSync(join(bin, name), "utf8") : "");
		return { stored: stdout, childOut: stdout + stderr, argv: read("argv.txt"), stdin: read("stdin.txt") };
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
}

const FAKE_SECURITY = `#!/bin/sh
printf '%s\\n' "$@" >> "$DIR/argv.txt"
if [ "$1" = "-i" ]; then
	IFS= read -r line
	printf '%s\\n' "$line" > "$DIR/stdin.txt"
	[ "$FAKE_MODE" = "fail" ] && { echo "security: failed" >&2; exit 1; }
	[ "$FAKE_MODE" = "silent-fail" ] && { echo "security: SecKeychainItemCreateFromContent failed" >&2; exit 0; }
	exit 0
fi
if [ "$1" = "find-generic-password" ]; then
	[ "$FAKE_MODE" = "silent-fail" ] && { echo "The specified item could not be found in the keychain." >&2; exit 44; }
	[ "$FAKE_MODE" = "stale" ] && { echo "b2xkLWtleQ=="; exit 0; }
	IFS= read -r line < "$DIR/stdin.txt"
	printf '%s\\n' "\${line##* }"
	exit 0
fi
exit 2
`;

describe("macKeychainBackend store", () => {
	it("sends the add command with -U on stdin and keeps the key off argv", async () => {
		const run = await runStore('macKeychainBackend("acct")', "security", FAKE_SECURITY);

		expect(run.stored).toBe("stored");
		expect(run.argv).not.toContain(KEY);
		expect(run.argv.split("\n")[0]).toBe("-i");
		expect(run.stdin.trim()).toBe(`add-generic-password -U -a acct -s dg-server -w ${KEY}`);
	});

	it("rejects without leaking the key when security exits non-zero", async () => {
		const run = await runStore('macKeychainBackend("acct")', "security", FAKE_SECURITY, { env: { FAKE_MODE: "fail" } });

		expect(run.stored).toBe("unreachable");
		expect(run.childOut).not.toContain(KEY);
	});

	it("rejects when security -i exits zero but the entry was not written", async () => {
		const run = await runStore('macKeychainBackend("acct")', "security", FAKE_SECURITY, { env: { FAKE_MODE: "silent-fail" } });

		expect(run.stored).toBe("unreachable");
		expect(run.childOut).not.toContain(KEY);
	});

	it("refuses a key or account that needs quoting before it reaches security", async () => {
		const run = await runStore('macKeychainBackend("acct")', "security", FAKE_SECURITY);
		const bad = await runStore('macKeychainBackend("a b")', "security", FAKE_SECURITY);

		expect(run.stored).toBe("stored");
		expect(bad.stored).toBe("unreachable");
		expect(bad.stdin).toBe("");
	});

	it.each([
		["a space", "AAAA AAAA"],
		["a newline", "AAAA\nAAAA"],
		["a length past the cap", "A".repeat(513)],
	])("refuses a key with %s before it reaches security", async (_label, key) => {
		const run = await runStore('macKeychainBackend("acct")', "security", FAKE_SECURITY, { key });

		expect(run.stored).toBe("unreachable");
		expect(run.stdin).toBe("");
	});

	it("refuses an account that starts with a dash", async () => {
		const run = await runStore('macKeychainBackend("-T")', "security", FAKE_SECURITY);

		expect(run.stored).toBe("unreachable");
		expect(run.stdin).toBe("");
	});

	it("rejects when the read-back returns a different key", async () => {
		const run = await runStore('macKeychainBackend("acct")', "security", FAKE_SECURITY, { env: { FAKE_MODE: "stale" } });

		expect(run.stored).toBe("unreachable");
		expect(run.childOut).not.toContain(KEY);
	});
});

const FAKE_POWERSHELL = `#!/bin/sh
printf '%s\\n' "$@" > "$DIR/argv.txt"
IFS= read -r line
printf '%s' "$line" > "$DIR/stdin.txt"
[ "$FAKE_MODE" = "fail" ] && { echo "boom" >&2; exit 1; }
exit 0
`;

describe("dpapiBackend store", () => {
	it("reads the key from stdin through a fixed script and keeps the key off argv", async () => {
		const run = await runStore('dpapiBackend("C:/dg/it\'s.dpapi")', "powershell.exe", FAKE_POWERSHELL);

		expect(run.stored).toBe("stored");
		expect(run.argv).not.toContain(KEY);
		expect(run.argv).toContain("-NonInteractive");
		expect(run.argv).toContain("'C:/dg/it''s.dpapi'");
		expect(run.stdin).toBe(KEY);
	});

	it("rejects without leaking the key when powershell exits non-zero", async () => {
		const run = await runStore('dpapiBackend("C:\\dg\\key.dpapi")', "powershell.exe", FAKE_POWERSHELL, {
			env: { FAKE_MODE: "fail" },
		});

		expect(run.stored).toBe("unreachable");
		expect(run.childOut).not.toContain(KEY);
	});
});

describe("guardedBackend", () => {
	it("maps every rejection to unreachable without carrying the message", async () => {
		const guarded = guardedBackend(fakeKeychain(SECRET, { rejectWith: `boom ${SECRET}` }).backend);

		expect(await guarded.lookup()).toEqual({ status: "unreachable" });
		expect(await guarded.store(SECRET)).toBe("unreachable");
		expect(await guarded.remove?.()).toBe("unreachable");
	});

	it("passes results through when the backend works", async () => {
		const fake = fakeKeychain(undefined);
		const guarded = guardedBackend(fake.backend);

		expect(await guarded.store(SECRET)).toBe("stored");
		expect(await guarded.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(await guarded.remove?.()).toBe("removed");
	});

	it("exposes no remove when the backend has none", () => {
		const { remove: _omitted, ...rest } = fakeKeychain(undefined).backend;

		expect(guardedBackend(rest).remove).toBeUndefined();
	});
});
