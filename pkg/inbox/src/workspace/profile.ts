import { homedir } from "node:os";
import { join } from "node:path";
import type { MailProvider } from "../providers/types";

const knownProviders: MailProvider[] = ["protonmail", "outlook", "gmail"];

export function workspaceDirForProfile(input: {
	provider: MailProvider;
	explicitDir?: string;
	accountProfile?: string;
	base?: string;
}): string {
	if (input.explicitDir) {
		return input.explicitDir;
	}
	const base =
		input.base ??
		join(process.env.DG_HOME ?? join(homedir(), ".dg"), "inbox", "workspaces");
	const profile = accountProfileSlug(input.accountProfile);
	if (profile) {
		return `${base}/${input.provider}/${profile}`;
	}
	return `${base}/${input.provider}`;
}

/**
 * Profiles live under `<base>/<provider>/<profile>/login.json`, so an
 * `--account-profile` alone (no `--dir`/`--provider`) can't be located without
 * knowing its provider first. Search each known provider's profile path and
 * return the one whose login.json already exists.
 */
export async function detectProfileProvider(input: {
	accountProfile?: string;
	base?: string;
}): Promise<MailProvider | undefined> {
	const profile = accountProfileSlug(input.accountProfile);
	if (!profile) {
		return undefined;
	}
	const base =
		input.base ??
		join(process.env.DG_HOME ?? join(homedir(), ".dg"), "inbox", "workspaces");
	for (const provider of knownProviders) {
		if (await Bun.file(`${base}/${provider}/${profile}/login.json`).exists()) {
			return provider;
		}
	}
	return undefined;
}

export function accountProfileSlug(value?: string): string {
	return (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function profileTokenCachePath(input: {
	configHome: string;
	provider: MailProvider;
	accountProfile?: string;
	fallbackPath: string;
}): string {
	const profile = accountProfileSlug(input.accountProfile);
	if (!profile) {
		return input.fallbackPath;
	}
	return join(input.configHome, input.provider, profile, "token-cache.json");
}
