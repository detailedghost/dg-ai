import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DgCliError } from "../errors";
import type { DgPaths } from "./dg-paths";
import { type LegacySeams, parseDgToml, readLegacyConfig, stringifyDgToml, writeDgTomlDoc } from "./dg-toml";
import { withInstallLock } from "./install-lock";
import { assertNotBlocked } from "./layout";

export type SecretStore = { set(name: string, value: string): Promise<void> };

export type MigrateResult = { wrote: boolean; sources: string[]; backups: string[] };

export type MigrateOptions = LegacySeams & { store?: SecretStore };

const NOTHING: MigrateResult = { wrote: false, sources: [], backups: [] };

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function sameBytes(a: string, b: string): boolean {
	return readFileSync(a).equals(readFileSync(b));
}

function backUp(source: string, made: string[]): string {
	const backup = `${source}.pre-toml`;
	if (existsSync(backup)) {
		if (sameBytes(source, backup)) return backup;
		throw new DgCliError(
			`dg config: ${backup} already exists and differs from ${source}. Next: move ${backup} somewhere safe, then run the command again. Nothing was changed.`,
		);
	}
	writeFileSync(backup, readFileSync(source), { mode: 0o600, flag: "wx" });
	made.push(backup);
	if (!sameBytes(source, backup))
		throw new DgCliError(`dg config: the copy ${backup} does not match ${source}. Next: check the disk, then run the command again.`);
	return backup;
}

async function fold(paths: DgPaths, options: MigrateOptions): Promise<MigrateResult> {
	if (existsSync(paths.configTomlPath)) return NOTHING;
	const legacy = readLegacyConfig(paths, options);
	if (!legacy.sources.length) return NOTHING;
	const migrated: Record<string, string> = {};
	for (const source of legacy.sources) migrated[source] = sha256File(source);
	const raw = { ...legacy.raw, meta: { migrated } };
	parseDgToml(stringifyDgToml(raw), paths.configTomlPath);
	if (legacy.secrets.length && !options.store)
		throw new DgCliError(
			`dg config: ${legacy.secrets.map((secret) => secret.key).join(", ")} must move into the credential store, and dg-daemon is not reachable. Next: run dg-daemon start, then run the command again. Nothing was changed.`,
		);
	const made: string[] = [];
	try {
		const backups = legacy.sources.map((source) => backUp(source, made));
		for (const secret of legacy.secrets) {
			try {
				await options.store?.set(secret.name, secret.value);
			} catch {
				throw new DgCliError(
					`dg config: could not store ${secret.key} as credential ${secret.name}. Next: check dg-daemon with dg-skills doctor, then run the command again. Nothing was changed.`,
				);
			}
		}
		writeDgTomlDoc(raw, options.env);
		return { wrote: true, sources: legacy.sources, backups };
	} catch (error) {
		for (const backup of made) rmSync(backup, { force: true });
		throw error;
	}
}

/** Folds the pre-TOML config files into config.toml once, under the install lock; a second run changes nothing. */
export async function migrateToToml(paths: DgPaths, options: MigrateOptions = {}): Promise<MigrateResult> {
	if (existsSync(paths.configTomlPath)) return NOTHING;
	assertNotBlocked(paths, "config");
	assertNotBlocked(paths, "cli-only");
	return withInstallLock(paths.dataDir, () => fold(paths, options));
}
