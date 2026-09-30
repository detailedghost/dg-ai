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

export function createKeychainBackendForPlatform(
	paths: Pick<DgPaths, "stateDir" | "daemonDir">,
): KeychainBackend | undefined {
	if (process.platform === "linux") {
		return secretToolBackend(keychainAccountFor(paths.stateDir));
	}
	if (process.platform === "darwin") {
		return macKeychainBackend(keychainAccountFor(paths.stateDir));
	}
	if (process.platform === "win32") {
		return dpapiBackend(join(paths.daemonDir, "key.dpapi"));
	}
	return undefined;
}
