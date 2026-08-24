import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCapture } from "@dg/common/node";
import type { KeychainBackend, KeychainLookupResult } from "./key-resolution";

const SERVICE = "dg-server";
const ACCOUNT = "chat-store-kek";

export function secretToolBackend(): KeychainBackend {
	return {
		async lookup(): Promise<KeychainLookupResult> {
			let result: Awaited<ReturnType<typeof runCapture>>;
			try {
				result = await runCapture("secret-tool", [
					"lookup",
					"service",
					SERVICE,
					"account",
					ACCOUNT,
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
						ACCOUNT,
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

export function macKeychainBackend(): KeychainBackend {
	return {
		async lookup(): Promise<KeychainLookupResult> {
			try {
				const result = await runCapture("security", [
					"find-generic-password",
					"-a",
					ACCOUNT,
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
					ACCOUNT,
					"-s",
					SERVICE,
					"-w",
					keyBase64,
					"-U",
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
	stateDir: string,
): KeychainBackend | undefined {
	if (process.platform === "linux") return secretToolBackend();
	if (process.platform === "darwin") return macKeychainBackend();
	if (process.platform === "win32") {
		return dpapiBackend(join(stateDir, "key.dpapi"));
	}
	return undefined;
}
