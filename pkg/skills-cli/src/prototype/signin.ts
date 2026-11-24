import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_NAME } from "../pw/core/states";
import { assertLoopbackUrl } from "../verify/urls";
import type { CaptureAccess } from "./accepted";

const FILE = ".signin";

function loopback(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		return assertLoopbackUrl(value, "sign-in url");
	} catch {
		return undefined;
	}
}

function stateName(value: unknown): string | undefined {
	return typeof value === "string" && STATE_NAME.test(value) ? value : undefined;
}

/** The sign-in url and saved-state name stored in a sandbox; anything else in the file is dropped. */
export function readSignIn(dir: string): CaptureAccess {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const record = parsed as Record<string, unknown>;
	const signIn = loopback(record.signIn);
	const state = stateName(record.stateName);
	return { ...(signIn ? { signIn } : {}), ...(state ? { stateName: state } : {}) };
}

/** Merge a sign-in url or saved-state name into the sandbox's `.signin`, mode 0600. */
export function writeSignIn(dir: string, access: CaptureAccess): CaptureAccess {
	if (access.signIn !== undefined) assertLoopbackUrl(access.signIn, "sign-in url");
	if (access.stateName !== undefined && !stateName(access.stateName))
		throw new Error(`state name must match ${STATE_NAME.source}`);
	const merged = { ...readSignIn(dir), ...access };
	mkdirSync(dir, { recursive: true });
	const path = join(dir, FILE);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
	return merged;
}

/** Store whichever of a sign-in url and saved-state name the caller passed; nothing passed writes nothing. */
export function rememberAccess(dir: string, { signIn, stateName }: CaptureAccess): void {
	if (signIn || stateName)
		writeSignIn(dir, { ...(signIn ? { signIn } : {}), ...(stateName ? { stateName } : {}) });
}
