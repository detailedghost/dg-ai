import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type DgPaths, runCapture } from "@dg/common/node";
import type { KeychainBackend, KeychainLookupResult } from "./key-resolution";

const SERVICE = "dg-server";
const ACCOUNT = "chat-store-kek";
const SCOPE_HASH_CHARS = 12;

export class RealKeychainInTestError extends Error {
	constructor(backend: string) {
		super(
			`refusing to use the real ${backend} keychain backend under test; inject a fake backend or set DG_KEY_SOURCE=file`,
		);
		this.name = "RealKeychainInTestError";
	}
}

function assertNotUnderTest(backend: string): void {
	if (process.env.NODE_ENV === "test") {
		throw new RealKeychainInTestError(backend);
	}
}

export function keychainAccountFor(
	stateDir: string,
	homeDir: string = homedir(),
): string {
	const resolved = resolve(stateDir);
	if (resolved === resolve(homeDir, ".dg")) return ACCOUNT;
	const scope = createHash("sha256")
		.update(resolved)
		.digest("hex")
		.slice(0, SCOPE_HASH_CHARS);
	return `${ACCOUNT}:${scope}`;
}

/** The keychain account scoped by the state root, and the one the old flat home used. */
export function keychainAccountsForPaths(
	paths: Pick<DgPaths, "legacyHome" | "stateDir">,
	homeDir: string = homedir(),
): { current: string; legacy: string } {
	return {
		current: keychainAccountFor(paths.stateDir, homeDir),
		legacy: keychainAccountFor(paths.legacyHome, homeDir),
	};
}

/**
 * Reads the key from the current account and moves an old-account entry into it: write, read back, compare,
 * and only then delete the old entry. A failed step keeps the old entry, reads from it, and warns once with the
 * key name, never its value.
 */
export function migratingKeychainBackend(
	current: KeychainBackend,
	legacy: KeychainBackend,
	warn: (line: string) => void,
): KeychainBackend {
	let warned = false;
	const warnOnce = (reason: string, outcome = "dg keeps the old entry and reads it from the old account") => {
		if (warned) return;
		warned = true;
		warn(`dg: keychain secret ${ACCOUNT} ${reason}; ${outcome}`);
	};
	const dropLegacy = async () => {
		const removed = await legacy.remove?.().catch(() => "unreachable" as const);
		if (removed !== "removed")
			warnOnce(
				"moved to the new account, but the old entry could not be deleted",
				"dg reads the new account, and a copy stays in the old one",
			);
	};
	return {
		sourceLabel: current.sourceLabel,
		async lookup(): Promise<KeychainLookupResult> {
			const found = await current.lookup();
			const old = await legacy.lookup().catch((): KeychainLookupResult => ({ status: "unreachable" }));
			if (old.status === "unreachable" && found.status === "absent") return old;
			if (old.status !== "found") return found;
			if (found.status === "found") {
				if (found.keyBase64 === old.keyBase64) {
					await dropLegacy();
					return found;
				}
				warnOnce("differs between the old and the new account");
				return old;
			}
			if (found.status === "unreachable" || (await current.store(old.keyBase64)) !== "stored") {
				warnOnce("could not be written to the new account");
				return old;
			}
			const check = await current.lookup();
			if (check.status !== "found" || check.keyBase64 !== old.keyBase64) {
				warnOnce("did not read back the same from the new account");
				return old;
			}
			await dropLegacy();
			return check;
		},
		store: (keyBase64) => current.store(keyBase64),
		remove: current.remove ? () => current.remove?.() ?? Promise.resolve("unreachable" as const) : undefined,
	};
}

export function secretToolBackend(account: string): KeychainBackend {
	assertNotUnderTest("secret-tool");
	return {
		async lookup(): Promise<KeychainLookupResult> {
			let result: Awaited<ReturnType<typeof runCapture>>;
			try {
				result = await runCapture("secret-tool", [
					"lookup",
					"service",
					SERVICE,
					"account",
					account,
				]);
			} catch {
				return { status: "unreachable" };
			}
			if (result.status === 0 && result.stdout.trim().length > 0) {
				return { status: "found", keyBase64: result.stdout.trim() };
			}
			if (result.stderr.trim().length === 0) return { status: "absent" };
			return { status: "unreachable" };
		},
		async store(keyBase64: string): Promise<"stored" | "unreachable"> {
			try {
				const result = await runCapture(
					"secret-tool",
					[
						"store",
						"--label",
						"dg-server chat store key",
						"service",
						SERVICE,
						"account",
						account,
					],
					{ stdin: keyBase64 },
				);
				return result.status === 0 ? "stored" : "unreachable";
			} catch {
				return "unreachable";
			}
		},
		async remove(): Promise<"removed" | "unreachable"> {
			try {
				const result = await runCapture("secret-tool", ["clear", "service", SERVICE, "account", account]);
				return result.status === 0 ? "removed" : "unreachable";
			} catch {
				return "unreachable";
			}
		},
	};
}

export function macKeychainBackend(account: string): KeychainBackend {
	assertNotUnderTest("security");
	return {
		async lookup(): Promise<KeychainLookupResult> {
			try {
				const result = await runCapture("security", [
					"find-generic-password",
					"-a",
					account,
					"-s",
					SERVICE,
					"-w",
				]);
				if (result.status === 0) {
					return { status: "found", keyBase64: result.stdout.trim() };
				}
				return /could not be found/i.test(result.stderr)
					? { status: "absent" }
					: { status: "unreachable" };
			} catch {
				return { status: "unreachable" };
			}
		},
		async store(keyBase64: string): Promise<"stored" | "unreachable"> {
			try {
				const result = await runCapture("security", [
					"add-generic-password",
					"-a",
					account,
					"-s",
					SERVICE,
					"-w",
					keyBase64,
				]);
				return result.status === 0 ? "stored" : "unreachable";
			} catch {
				return "unreachable";
			}
		},
		async remove(): Promise<"removed" | "unreachable"> {
			try {
				const result = await runCapture("security", ["delete-generic-password", "-a", account, "-s", SERVICE]);
				return result.status === 0 ? "removed" : "unreachable";
			} catch {
				return "unreachable";
			}
		},
	};
}

function powershellQuote(value: string): string {
	return value.replace(/'/g, "''");
}

export function dpapiBackend(dpapiPath: string): KeychainBackend {
	assertNotUnderTest("powershell");
	return {
		sourceLabel: "dpapi-protected-file",
		async lookup(): Promise<KeychainLookupResult> {
			if (!existsSync(dpapiPath)) return { status: "absent" };
			try {
				const result = await runCapture("powershell.exe", [
					"-NoProfile",
					"-Command",
					`[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${powershellQuote(dpapiPath)}'), $null, 'CurrentUser'))`,
				]);
				if (result.status === 0 && result.stdout.trim().length > 0) {
					return { status: "found", keyBase64: result.stdout.trim() };
				}
				return { status: "unreachable" };
			} catch {
				return { status: "unreachable" };
			}
		},
		async store(keyBase64: string): Promise<"stored" | "unreachable"> {
			try {
				const result = await runCapture("powershell.exe", [
					"-NoProfile",
					"-Command",
					`[IO.File]::WriteAllBytes('${powershellQuote(dpapiPath)}', [Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${keyBase64}'), $null, 'CurrentUser'))`,
				]);
				return result.status === 0 ? "stored" : "unreachable";
			} catch {
				return "unreachable";
			}
		},
	};
}

const warnOnStderr = (line: string) => {
	process.stderr.write(`${line}\n`);
};

export function createKeychainBackendForPlatform(
	paths: Pick<DgPaths, "legacyHome" | "stateDir" | "daemonDir">,
	warn: (line: string) => void = warnOnStderr,
): KeychainBackend | undefined {
	const accounts = () => keychainAccountsForPaths(paths);
	if (process.platform === "linux") {
		const { current, legacy } = accounts();
		return migratingKeychainBackend(secretToolBackend(current), secretToolBackend(legacy), warn);
	}
	if (process.platform === "darwin") {
		const { current, legacy } = accounts();
		return migratingKeychainBackend(macKeychainBackend(current), macKeychainBackend(legacy), warn);
	}
	if (process.platform === "win32") {
		return dpapiBackend(join(paths.daemonDir, "key.dpapi"));
	}
	return undefined;
}
