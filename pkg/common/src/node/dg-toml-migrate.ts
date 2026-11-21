import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DgCliError, describeError } from "../errors";
import type { DgPaths } from "./dg-paths";
import { type LegacySeams, legacySources, parseDgToml, readLegacyConfig, stringifyDgToml, writeDgTomlDoc } from "./dg-toml";
import { withInstallLock, withInstallLockSync } from "./install-lock";
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

type Plan = { raw: Record<string, unknown>; legacy: ReturnType<typeof readLegacyConfig> };

function plan(paths: DgPaths, options: MigrateOptions, store: boolean): Plan | undefined {
	if (existsSync(paths.configTomlPath)) return undefined;
	const legacy = readLegacyConfig(paths, options);
	if (!legacy.sources.length) return undefined;
	const migrated: Record<string, string> = {};
	for (const source of legacy.sources) migrated[source] = sha256File(source);
	const raw = { ...legacy.raw, meta: { migrated } };
	parseDgToml(stringifyDgToml(raw), paths.configTomlPath);
	if (legacy.secrets.length && !store)
		throw new DgCliError(
			`dg config: ${legacy.secrets.map((secret) => secret.key).join(", ")} must move into the credential store, and dg-daemon is not reachable. Next: run dg-daemon start, then run dg-skills doctor so the move runs. Nothing was changed.`,
		);
	return { raw, legacy };
}

function undo(made: string[], error: unknown): never {
	for (const backup of made) rmSync(backup, { force: true });
	throw error;
}

async function fold(paths: DgPaths, options: MigrateOptions): Promise<MigrateResult> {
	const steps = plan(paths, options, options.store !== undefined);
	if (!steps) return NOTHING;
	const made: string[] = [];
	try {
		const backups = steps.legacy.sources.map((source) => backUp(source, made));
		for (const secret of steps.legacy.secrets) {
			try {
				await options.store?.set(secret.name, secret.value);
			} catch (error) {
				const reason = describeError(error).replaceAll(secret.value, "[redacted]");
				throw new DgCliError(
					`dg config: could not store ${secret.key} as credential ${secret.name} (${reason}). Next: check dg-daemon with dg-skills doctor, then run the command again. config.toml was not written and no backup was kept; a secret stored before this one stays in the store.`,
				);
			}
		}
		writeDgTomlDoc(steps.raw, paths.configTomlPath);
		return { wrote: true, sources: steps.legacy.sources, backups };
	} catch (error) {
		return undo(made, error);
	}
}

function foldSync(paths: DgPaths, options: LegacySeams): MigrateResult {
	const steps = plan(paths, options, false);
	if (!steps) return NOTHING;
	const made: string[] = [];
	try {
		const backups = steps.legacy.sources.map((source) => backUp(source, made));
		writeDgTomlDoc(steps.raw, paths.configTomlPath);
		return { wrote: true, sources: steps.legacy.sources, backups };
	} catch (error) {
		return undo(made, error);
	}
}

function needed(paths: DgPaths, options: LegacySeams): boolean {
	if (existsSync(paths.configTomlPath)) return false;
	if (!legacySources(paths, options).some((source) => existsSync(source.path))) return false;
	assertNotBlocked(paths, "config");
	assertNotBlocked(paths, "cli-only");
	return true;
}

/** Folds the pre-TOML config files into config.toml once, under the install lock; a second run changes nothing. */
export async function migrateToToml(paths: DgPaths, options: MigrateOptions = {}): Promise<MigrateResult> {
	if (!needed(paths, options)) return NOTHING;
	return withInstallLock(paths.dataDir, () => fold(paths, options));
}

/** The blocking twin of `migrateToToml` for writers; it refuses, and writes nothing, when a secret must move. */
export function migrateToTomlSync(paths: DgPaths, options: LegacySeams = {}): MigrateResult {
	if (!needed(paths, options)) return NOTHING;
	return withInstallLockSync(paths.dataDir, () => foldSync(paths, options));
}
